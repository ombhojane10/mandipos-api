import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { OtpService } from '../auth/otp.service';
import { Principal } from '../auth/tokens.service';
import { config } from '../config';
import { Db, Tx } from '../db/db.service';
import { parseEAadhaar } from './eaadhaar';
import { seal, unseal } from './seal';
import { UlipClient, UlipError } from './ulip.client';

/** Shown on the screen and stored with the KYC, word for word. */
export const CONSENT_TEXT =
  'Main apni marzi se dukaan ko DigiLocker se mera Aadhaar (aur PAN, agar diya) lekar meri KYC karne ki anumati deta/deti hoon. ' +
  'I consent to the shop fetching my Aadhaar (and PAN, if given) from DigiLocker for my KYC.';

const PENDING_TTL_MS = 10 * 60_000;
const MAX_OTP_TRIES = 5;

export const StartBody = z.object({
  uid: z.string().transform((s) => s.replace(/\D/g, '')).pipe(z.string().regex(/^[2-9]\d{11}$/, 'Aadhaar 12 ankon ka hota hai')).refine(verhoeff, 'Aadhaar number galat hai'),
  name: z.string().trim().min(2).max(99),
  dob: z.string().transform((s) => s.replace(/\D/g, '')).pipe(z.string().regex(/^\d{8}$/, 'Janam tithi DD/MM/YYYY')).refine(validDob, 'Janam tithi galat hai'),
  gender: z.enum(['M', 'F', 'T']),
  mobile: z.string().transform((s) => s.replace(/\D/g, '').slice(-10)).pipe(z.string().regex(/^[6-9]\d{9}$/, 'Mobile 10 ankon ka')),
  pan: z.string().transform((s) => s.replace(/\s/g, '').toUpperCase()).pipe(z.string().regex(/^([A-Z]{5}\d{4}[A-Z])?$/, 'PAN galat hai')).optional(),
  consent: z.literal(true),
  fingers: z.array(z.object({
    finger: z.string().regex(/^[A-Z_]{3,20}$/),
    qScore: z.number().int().min(0).max(100),
    nmPoints: z.number().int().min(0).max(500).optional(),
    device: z.string().max(80).default(''),
  })).max(10).default([]),
});
export const OtpBody = z.object({ kycId: z.uuid(), otp: z.string().regex(/^\d{6}$/, 'OTP 6 ankon ka') });

type Pending = {
  shopId: string; buyerId: string; userId: string; deviceId: string;
  token: string; otpMobile: string; pan: string; staging: boolean;
  fingers: z.infer<typeof StartBody>['fingers'];
  consentAt: Date; expires: number; tries: number;
};

type KycRow = {
  source: string; aadhaar_last4: string; name: string; dob: string; gender: string; care_of: string;
  address: string; pincode: string; photo_sealed: Buffer | null; otp_mobile: string; pan_last4: string | null;
  pan_status: string; pan_note: string; fingers: unknown; verified_at: Date;
};

/**
 * Grahak eKYC through ULIP's DigiLocker APIs:
 *
 *   start  DIGILOCKER_01 (Aadhaar no. + name + DOB + gender: UIDAI checks they belong
 *          together) → 03 (that DigiLocker account's token, its registered mobile, and
 *          whether e-Aadhaar is linked) → an OTP to that registered mobile.
 *   otp    our OTP checked → 05 (UIDAI-signed e-Aadhaar) and 04 (PAN record, if a PAN was
 *          given) → saved.
 *
 * DIGILOCKER_02 (DigiLocker's own mobile OTP) is not used: it logs into a mobile-only
 * account, after which 05 answers aadhaar_not_linked. The OTP is ours, sent to the mobile
 * DigiLocker has for the Aadhaar holder, so a stranger with someone's Aadhaar details
 * cannot finish a KYC. On ULIP staging no SMS goes out and KYC_TEST_OTP is the code.
 *
 * Between the two calls the DigiLocker token lives only in this process's memory (it is
 * valid an hour; we give it ten minutes). A restart in between means "start again".
 */
@Injectable()
export class KycService {
  private readonly log = new Logger('Kyc');
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly db: Db, private readonly ulip: UlipClient, private readonly otp: OtpService) {}

  async start(p: Principal, buyerId: string, input: z.infer<typeof StartBody>) {
    const shopId = shopOf(p);
    if (!this.ulip.configured) throw new ServiceUnavailableException('eKYC abhi chalu nahi hai');
    await this.db.withShop(shopId, async (tx) => {
      await member(tx, p, shopId);
      if (!(await tx.query(`SELECT 1 FROM buyers WHERE id = $1`, [buyerId])).rows[0]) {
        throw new NotFoundException('Yeh grahak server par nahi mila. Internet se sync hone dein, phir try karein.');
      }
    });
    this.sweep();

    const auth = await this.call('/DIGILOCKER/01', {
      uid: input.uid, name: input.name, dob: input.dob, gender: input.gender, mobile: input.mobile, consent: 'Y',
    });
    const code = str(auth.code);
    const verifier = str(auth.code_verifier);
    if (!code || !verifier) throw new BadRequestException(refusal(auth, 'Aadhaar ki details match nahi hui. Naam, janam tithi aur ling Aadhaar jaise hi likhein.'));

    const account = await this.call('/DIGILOCKER/03', { code, code_verifier: verifier });
    const token = str(account.access_token);
    if (!token) throw new BadRequestException(refusal(account, 'DigiLocker se jud nahi paaye. Dobara try karein.'));
    if (str(account.eaadhaar) !== 'Y') {
      throw new BadRequestException('Is grahak ke DigiLocker mein Aadhaar juda nahi hai. Grahak DigiLocker app mein Aadhaar jod kar aayein.');
    }

    const registered = str(account.mobile).replace(/\D/g, '').slice(-10);
    const otpMobile = /^[6-9]\d{9}$/.test(registered) ? registered : input.mobile;
    const staging = this.ulip.staging;
    if (!staging) await this.otp.send(otpMobile);

    const kycId = randomUUID();
    this.pending.set(kycId, {
      shopId, buyerId, userId: p.userId, deviceId: p.deviceId, token, otpMobile, pan: input.pan ?? '', staging,
      fingers: input.fingers, consentAt: new Date(), expires: Date.now() + PENDING_TTL_MS, tries: 0,
    });
    return { kycId, otpTo: maskMobile(otpMobile), ...(staging ? { testOtp: config().KYC_TEST_OTP } : {}) };
  }

  async confirm(p: Principal, buyerId: string, input: z.infer<typeof OtpBody>) {
    const shopId = shopOf(p);
    this.sweep();
    const s = this.pending.get(input.kycId);
    if (!s || s.shopId !== shopId || s.buyerId !== buyerId) throw new BadRequestException('Samay khatam ho gaya. eKYC dobara shuru karein.');
    if (++s.tries > MAX_OTP_TRIES) {
      this.pending.delete(input.kycId);
      throw new BadRequestException('Bahut galat OTP. eKYC dobara shuru karein.');
    }
    if (s.staging) {
      if (input.otp !== config().KYC_TEST_OTP) throw new BadRequestException('OTP galat hai');
    } else {
      await this.otp.verify(s.otpMobile, input.otp);
    }

    const doc = await this.call('/DIGILOCKER/05', { token: s.token });
    const xml = str(doc.eaadhaarData);
    const e = xml ? parseEAadhaar(xml) : null;
    if (!e || !/^\d{4}$/.test(e.last4)) throw new BadRequestException(refusal(doc, 'DigiLocker se Aadhaar nahi mila. Dobara try karein.'));

    let pan: { status: 'none' | 'verified' | 'failed'; note: string; pdf: Buffer | null } = { status: 'none', note: '', pdf: null };
    if (s.pan) {
      try {
        const rec = await this.call('/DIGILOCKER/04', { panno: s.pan, panName: e.name, consent: 'Y', token: s.token });
        const data = str(rec.data);
        pan = data && /pdf/i.test(str(rec.mime))
          ? { status: 'verified', note: '', pdf: Buffer.from(data, 'base64') }
          : { status: 'failed', note: refusal(rec, 'PAN DigiLocker mein nahi mila'), pdf: null };
      } catch (err) {
        if (!(err instanceof HttpException)) throw err;
        pan = { status: 'failed', note: String(err.message), pdf: null };
      }
    }
    const row = await this.db.withShop(shopId, async (tx) => {
      await member(tx, p, shopId);
      const { rows } = await tx.query<KycRow>(
        `INSERT INTO buyer_kyc (buyer_id, shop_id, source, aadhaar_last4, name, dob, gender, care_of, address, pincode,
           photo_sealed, eaadhaar_sealed, eaadhaar_issued_at, otp_mobile, pan_last4, pan_status, pan_note, pan_sealed,
           fingers, consent_text, consent_at, verified_by, device_id, verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, now())
         ON CONFLICT (buyer_id) DO UPDATE SET source = EXCLUDED.source, aadhaar_last4 = EXCLUDED.aadhaar_last4,
           name = EXCLUDED.name, dob = EXCLUDED.dob, gender = EXCLUDED.gender, care_of = EXCLUDED.care_of,
           address = EXCLUDED.address, pincode = EXCLUDED.pincode, photo_sealed = EXCLUDED.photo_sealed,
           eaadhaar_sealed = EXCLUDED.eaadhaar_sealed, eaadhaar_issued_at = EXCLUDED.eaadhaar_issued_at,
           otp_mobile = EXCLUDED.otp_mobile, pan_last4 = EXCLUDED.pan_last4, pan_status = EXCLUDED.pan_status,
           pan_note = EXCLUDED.pan_note, pan_sealed = EXCLUDED.pan_sealed, fingers = EXCLUDED.fingers,
           consent_text = EXCLUDED.consent_text, consent_at = EXCLUDED.consent_at, verified_by = EXCLUDED.verified_by,
           device_id = EXCLUDED.device_id, verified_at = now()
         RETURNING *`,
        [buyerId, shopId, s.staging ? 'ulip-staging' : 'ulip', e.last4, e.name, e.dob, e.gender, e.careOf, e.address, e.pincode,
          e.photo ? seal(e.photo) : null, seal(Buffer.from(xml, 'utf8')), e.issuedAt, s.otpMobile,
          s.pan ? s.pan.slice(-4) : null, pan.status, pan.note, pan.pdf ? seal(pan.pdf) : null,
          JSON.stringify(s.fingers), CONSENT_TEXT, s.consentAt, s.userId, s.deviceId],
      );
      if (!rows[0]) throw new NotFoundException('Yeh grahak nahi mila');
      return rows[0];
    });
    // Only now: a failed save can be retried with the same OTP while the token lasts.
    this.pending.delete(input.kycId);
    this.log.log(`KYC saved for buyer ${buyerId} (${s.staging ? 'staging' : 'production'}, pan ${pan.status})`);
    return view(row);
  }

  async get(p: Principal, buyerId: string) {
    const shopId = shopOf(p);
    const row = await this.db.withShop(shopId, async (tx) => {
      await member(tx, p, shopId);
      return (await tx.query<KycRow>(`SELECT * FROM buyer_kyc WHERE buyer_id = $1`, [buyerId])).rows[0];
    });
    if (!row) throw new NotFoundException('eKYC nahi hui');
    return view(row);
  }

  /** One ULIP call; a gateway or network failure becomes a message the counter can act on. */
  private async call(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return await this.ulip.post(path, body);
    } catch (err) {
      if (!(err instanceof UlipError)) throw err;
      this.log.warn(`ULIP ${err.message}`);
      if (err.status === 400) throw new BadRequestException(err.message.replace(/^\S+: HTTP 400\s*/, '') || 'Details sahi nahi');
      throw new HttpException('DigiLocker abhi jawab nahi de raha. Thodi der baad try karein.', HttpStatus.BAD_GATEWAY);
    }
  }

  private sweep() {
    const now = Date.now();
    for (const [id, s] of this.pending) if (s.expires < now) this.pending.delete(id);
  }
}

function view(r: KycRow) {
  const photo = r.photo_sealed ? safeUnseal(r.photo_sealed) : null;
  return {
    source: r.source,
    aadhaarLast4: r.aadhaar_last4,
    name: r.name,
    dob: r.dob,
    gender: r.gender,
    careOf: r.care_of,
    address: r.address,
    pincode: r.pincode,
    photo: photo ? photo.toString('base64') : null,
    otpMobile: maskMobile(r.otp_mobile),
    pan: r.pan_last4 ? { last4: r.pan_last4, status: r.pan_status, note: r.pan_note } : null,
    fingers: r.fingers,
    verifiedAt: r.verified_at.toISOString(),
  };
}

function safeUnseal(b: Buffer): Buffer | null {
  try { return unseal(b); } catch { return null; }
}

/** What DigiLocker said when it refused, if it said anything readable. */
function refusal(inner: Record<string, unknown>, fallback: string): string {
  const said = str(inner.error_description) || str(inner.error) || str(inner.message);
  return said ? `${fallback} (${said})` : fallback;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const maskMobile = (m: string) => (m.length >= 4 ? '•'.repeat(Math.max(0, m.length - 4)) + m.slice(-4) : m);

function shopOf(p: Principal): string {
  if (!p.shopId) throw new ForbiddenException('Pehle dukaan se judein');
  return p.shopId;
}

async function member(tx: Tx, p: Principal, shopId: string) {
  const r = (await tx.query(`SELECT 1 FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [shopId, p.userId])).rows[0];
  if (!r) throw new ForbiddenException('Aap is dukaan ki team mein nahi hain');
}

function validDob(s: string): boolean {
  const d = Number(s.slice(0, 2)), m = Number(s.slice(2, 4)), y = Number(s.slice(4));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && dt.getTime() < Date.now();
}

// Aadhaar's last digit is a Verhoeff check digit: one mistyped or two swapped digits fail it.
const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],
  [5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],
  [4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
export function verhoeff(num: string): boolean {
  let c = 0;
  const digits = num.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = VD[c][VP[i % 8][digits[i]]];
  return c === 0;
}
