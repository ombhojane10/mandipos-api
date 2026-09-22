import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { uuidv7 } from '../common/uuid';
import { config, sendsRealSms, testLoginCode } from '../config';
import { Db } from '../db/db.service';

const TTL_MINUTES = 10;
const MAX_SENDS_PER_WINDOW = 3;
const SEND_WINDOW_MINUTES = 10;
const MAX_ATTEMPTS = 5;

type TwoFactorResponse = { Status: string; Details: string };

/**
 * Phone OTP. Staging/production send through 2Factor.in (the DLT-registered account
 * MandiPlus already uses); local and test print the code to the log instead.
 */
@Injectable()
export class OtpService {
  private readonly log = new Logger('Otp');
  /** Test hook: last code issued per phone (only populated when no SMS is sent). */
  static readonly issuedForTests = new Map<string, string>();

  constructor(private readonly db: Db) {}

  async send(phone: string): Promise<void> {
    const recent = await this.db.one<{ n: string }>(
      `SELECT count(*) AS n FROM otp_codes WHERE phone = $1 AND created_at > now() - make_interval(mins => $2)`,
      [phone, SEND_WINDOW_MINUTES],
    );
    // The cap protects SMS spend and phones from spam; local/test and QA logins send nothing.
    if (sendsRealSms() && !testLoginCode(phone) && Number(recent?.n ?? 0) >= MAX_SENDS_PER_WINDOW) {
      throw new HttpException('Bahut baar OTP maanga. 10 minute baad try karein.', HttpStatus.TOO_MANY_REQUESTS);
    }

    let providerSession: string | null = null;
    let codeHash: string | null = null;
    const qaCode = testLoginCode(phone);
    if (qaCode) {
      codeHash = this.hash(phone, qaCode);
    } else if (sendsRealSms()) {
      providerSession = await this.sendVia2Factor(phone);
    } else {
      const code = randomInt(100000, 1000000).toString();
      codeHash = this.hash(phone, code);
      OtpService.issuedForTests.set(phone, code);
      this.log.log(`OTP for ${phone}: ${code} (${config().APP_ENV}, not sent)`);
    }

    await this.db.query(
      `INSERT INTO otp_codes (id, phone, provider_session, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
      [uuidv7(), phone, providerSession, codeHash, TTL_MINUTES],
    );
  }

  /** Throws unless [code] is the latest unexpired OTP for [phone]. Consumes it on success. */
  async verify(phone: string, code: string): Promise<void> {
    const row = await this.db.one<{ id: string; provider_session: string | null; code_hash: string | null; attempts: number }>(
      `SELECT id, provider_session, code_hash, attempts FROM otp_codes
       WHERE phone = $1 AND verified_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [phone],
    );
    if (!row) throw new BadRequestException('OTP expire ho gaya. Naya OTP mangaiye.');
    if (row.attempts >= MAX_ATTEMPTS) throw new BadRequestException('Bahut galat koshish. Naya OTP mangaiye.');

    await this.db.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    const ok = row.provider_session ? await this.verifyVia2Factor(row.provider_session, code) : this.matches(row.code_hash, phone, code);
    if (!ok) throw new BadRequestException('OTP galat hai');

    await this.db.query(`UPDATE otp_codes SET verified_at = now() WHERE id = $1`, [row.id]);
  }

  private hash(phone: string, code: string): string {
    return createHmac('sha256', config().OTP_HASH_SECRET).update(`${phone}:${code}`).digest('hex');
  }

  private matches(stored: string | null, phone: string, code: string): boolean {
    if (!stored) return false;
    const a = Buffer.from(stored, 'hex');
    const b = Buffer.from(this.hash(phone, code), 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async sendVia2Factor(phone: string): Promise<string> {
    const { TWOFACTOR_API_KEY: key, TWOFACTOR_OTP_TEMPLATE_NAME: template } = config();
    const path = template ? `AUTOGEN/${encodeURIComponent(template)}` : 'AUTOGEN';
    const res = await this.call2Factor(`https://2factor.in/API/V1/${key}/SMS/${phone}/${path}`);
    if (res?.Status !== 'Success') {
      this.log.error(`2Factor send failed: ${res?.Details ?? 'no response'}`);
      throw new BadRequestException('OTP abhi nahi bhej paaye. Thodi der baad try karein.');
    }
    return res.Details;
  }

  private async verifyVia2Factor(session: string, code: string): Promise<boolean> {
    const key = config().TWOFACTOR_API_KEY;
    const res = await this.call2Factor(`https://2factor.in/API/V1/${key}/SMS/VERIFY/${session}/${encodeURIComponent(code)}`);
    return res?.Status === 'Success';
  }

  private async call2Factor(url: string): Promise<TwoFactorResponse | null> {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      return (await r.json()) as TwoFactorResponse;
    } catch (err) {
      this.log.error(`2Factor unreachable: ${(err as Error).message}`);
      return null;
    }
  }
}
