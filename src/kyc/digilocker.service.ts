import { BadRequestException, ConflictException, GoneException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { Principal } from '../auth/tokens.service';
import { config } from '../config';
import { Db } from '../db/db.service';
import { KycRow, member, shopOf, view } from './kyc.service';
import { seal } from './seal';
import { SurepassAadhaar, SurepassClient, SurepassError } from './surepass.client';

export const DIGILOCKER_CONSENT =
  'The customer signed in to DigiLocker and allowed the shop to fetch their Aadhaar (and PAN, if in DigiLocker) for KYC.';

const PENDING_TTL_MS = 15 * 60_000;
const Finger = z.object({
  finger: z.string().regex(/^[A-Z_]{3,20}$/),
  qScore: z.number().int().min(0).max(100),
  nmPoints: z.number().int().min(0).max(500).optional(),
  device: z.string().max(80).default(''),
});
export const DigilockerStartBody = z.object({
  mobile: z.string().transform((s) => s.replace(/\D/g, '').slice(-10)).pipe(z.string().regex(/^([6-9]\d{9})?$/, 'Invalid mobile number')).optional(),
  consent: z.literal(true),
});
export const DigilockerCompleteBody = z.object({
  clientId: z.string().min(4).max(80),
  fingers: z.array(Finger).max(10).default([]),
});

type Pending = { shopId: string; buyerId: string; userId: string; deviceId: string; consentAt: Date; expires: number };

/**
 * eKYC on DigiLocker's own sign-in page, through Surepass:
 *
 *   start     Surepass initialize → a hosted DigiLocker page (mobile prefilled). The terminal
 *             opens it; the grahak signs in with their mobile or Aadhaar and the OTP that
 *             DigiLocker sends them, and allows sharing. DigiLocker then sends them to
 *             PUBLIC_URL/v1/kyc/digilocker/done, which the terminal watches for.
 *   complete  status (completed, Aadhaar linked) → download-aadhaar (Surepass serves it
 *             once per session) → PAN from their documents if DigiLocker has it → saved in
 *             buyer_kyc, sealed like the ULIP path.
 *
 * Nothing is typed by the shop but the mobile; the OTP never passes through us.
 */
@Injectable()
export class DigilockerKycService {
  private readonly log = new Logger('DigilockerKyc');
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly db: Db, private readonly surepass: SurepassClient) {}

  async start(p: Principal, buyerId: string, input: z.infer<typeof DigilockerStartBody>) {
    const shopId = shopOf(p);
    if (!this.surepass.configured) throw new ServiceUnavailableException('DigiLocker eKYC is not enabled');
    const buyer = await this.db.withShop(shopId, async (tx) => {
      await member(tx, p, shopId);
      return (await tx.query<{ name: string; phone: string }>(`SELECT name, phone FROM buyers WHERE id = $1`, [buyerId])).rows[0];
    });
    if (!buyer) throw new NotFoundException('Customer not synced yet. Connect to the internet and try again.');
    this.sweep();
    const mobile = input.mobile || buyer.phone.replace(/\D/g, '').slice(-10);
    const s = await this.call(() => this.surepass.initialize({
      mobile: /^[6-9]\d{9}$/.test(mobile) ? mobile : undefined,
      redirectUrl: `${config().PUBLIC_URL.replace(/\/+$/, '')}/v1/kyc/digilocker/done`,
      state: buyerId,
    }));
    this.pending.set(s.clientId, { shopId, buyerId, userId: p.userId, deviceId: p.deviceId, consentAt: new Date(), expires: Date.now() + PENDING_TTL_MS });
    return { clientId: s.clientId, url: s.url, doneUrl: '/v1/kyc/digilocker/done', expiresIn: s.expirySeconds };
  }

  async complete(p: Principal, buyerId: string, input: z.infer<typeof DigilockerCompleteBody>) {
    const shopId = shopOf(p);
    this.sweep();
    const s = this.pending.get(input.clientId);
    if (!s || s.shopId !== shopId || s.buyerId !== buyerId) throw new GoneException('Session expired. Start eKYC again.');

    const st = await this.call(() => this.surepass.status(input.clientId));
    if (st.failed) { this.pending.delete(input.clientId); throw new BadRequestException(st.error || 'DigiLocker sign-in failed. Try again.'); }
    if (!st.completed) throw new ConflictException('DigiLocker sign-in not finished yet');
    if (!st.aadhaarLinked) { this.pending.delete(input.clientId); throw new BadRequestException('Aadhaar is not linked in this customer\'s DigiLocker.'); }

    const a = await this.call(() => this.surepass.downloadAadhaar(input.clientId));
    const x = a.aadhaar_xml_data ?? {};
    const last4 = (x.masked_aadhaar ?? '').replace(/\D/g, '').slice(-4);
    if (!/^\d{4}$/.test(last4)) throw new HttpException('DigiLocker returned no Aadhaar. Try again.', HttpStatus.BAD_GATEWAY);

    // The signed XML as DigiLocker issued it; the parsed answer if it can't be fetched.
    const proof = a.xml_url ? await this.surepass.fetchBytes(a.xml_url).catch(() => null) : null;
    const photo = x.profile_image ? Buffer.from(x.profile_image, 'base64') : null;
    const pan = await this.pan(input.clientId);

    const row = await this.db.withShop(shopId, async (tx) => {
      await member(tx, p, shopId);
      const { rows } = await tx.query<KycRow>(
        `INSERT INTO buyer_kyc (buyer_id, shop_id, source, aadhaar_last4, name, dob, gender, care_of, address, pincode,
           photo_sealed, eaadhaar_sealed, eaadhaar_issued_at, otp_mobile, pan_last4, pan_status, pan_note, pan_sealed,
           fingers, consent_text, consent_at, verified_by, device_id, verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'',$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now())
         ON CONFLICT (buyer_id) DO UPDATE SET source = EXCLUDED.source, aadhaar_last4 = EXCLUDED.aadhaar_last4,
           name = EXCLUDED.name, dob = EXCLUDED.dob, gender = EXCLUDED.gender, care_of = EXCLUDED.care_of,
           address = EXCLUDED.address, pincode = EXCLUDED.pincode, photo_sealed = EXCLUDED.photo_sealed,
           eaadhaar_sealed = EXCLUDED.eaadhaar_sealed, eaadhaar_issued_at = '', otp_mobile = EXCLUDED.otp_mobile,
           pan_last4 = EXCLUDED.pan_last4, pan_status = EXCLUDED.pan_status, pan_note = EXCLUDED.pan_note,
           pan_sealed = EXCLUDED.pan_sealed, fingers = EXCLUDED.fingers, consent_text = EXCLUDED.consent_text,
           consent_at = EXCLUDED.consent_at, verified_by = EXCLUDED.verified_by, device_id = EXCLUDED.device_id,
           verified_at = now()
         RETURNING *`,
        [buyerId, shopId, this.surepass.sandbox ? 'surepass-sandbox' : 'surepass', last4,
          x.full_name || a.digilocker_metadata?.name || '', dmy(x.dob || a.digilocker_metadata?.dob || ''),
          x.gender || a.digilocker_metadata?.gender || '', x.care_of || '', x.full_address || '', x.zip || '',
          photo && photo.length > 3 ? seal(photo) : null,
          seal(proof ?? Buffer.from(JSON.stringify(a), 'utf8')),
          (a.digilocker_metadata?.mobile_number ?? '').replace(/\D/g, '').slice(-10),
          pan.number ? pan.number.slice(-4) : null, pan.status, pan.note, pan.file ? seal(pan.file) : null,
          JSON.stringify(input.fingers), DIGILOCKER_CONSENT, s.consentAt, s.userId, s.deviceId],
      );
      if (!rows[0]) throw new NotFoundException('Customer not found');
      return rows[0];
    });
    this.pending.delete(input.clientId);
    this.log.log(`DigiLocker KYC saved for buyer ${buyerId} (${this.surepass.sandbox ? 'sandbox' : 'production'}, pan ${pan.status})`);
    return view(row);
  }

  /** PAN, if DigiLocker holds it: its XML gives the number. Missing PAN is not an error. */
  private async pan(clientId: string): Promise<{ status: 'none' | 'verified' | 'failed'; number: string; note: string; file: Buffer | null }> {
    try {
      const docs = await this.surepass.listDocuments(clientId);
      const xml = docs.find((d) => d.doc_type === 'PANCR' && (d.file_type === 'xml' || d.file_id === 'pan'));
      if (!xml) return { status: 'none', number: '', note: '', file: null };
      const file = await this.surepass.downloadDocument(clientId, xml.file_id);
      const number = /\b([A-Z]{5}\d{4}[A-Z])\b/.exec(file.toString('utf8'))?.[1] ?? '';
      return number ? { status: 'verified', number, note: '', file } : { status: 'failed', number: '', note: 'PAN record unreadable', file };
    } catch (err) {
      this.log.warn(`PAN fetch failed: ${(err as Error).message}`);
      return { status: 'none', number: '', note: '', file: null };
    }
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof SurepassError)) throw err;
      if (err.code === 'client_not_found' || err.code === 'digilocker_client_not_found') throw new GoneException('Session expired. Start eKYC again.');
      if (err.status === 422) throw new GoneException('This DigiLocker session was already used. Start eKYC again.');
      if (err.status === 401 || err.status === 403) throw new ServiceUnavailableException('DigiLocker eKYC is not set up (Surepass access).');
      throw new HttpException('DigiLocker is not responding. Try again shortly.', HttpStatus.BAD_GATEWAY);
    }
  }

  private sweep() {
    const now = Date.now();
    for (const [id, s] of this.pending) if (s.expires < now) this.pending.delete(id);
  }
}

/** Surepass sends YYYY-MM-DD; the KYC shows DD-MM-YYYY like UIDAI's XML. */
function dmy(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : d;
}

export type { SurepassAadhaar };
