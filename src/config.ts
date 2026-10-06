import { z } from 'zod';

const schema = z
  .object({
    APP_ENV: z.enum(['local', 'test', 'staging', 'production']),
    PORT: z.coerce.number().int().default(3000),
    // Pooled Neon URL for the app; migrations use DATABASE_URL_DIRECT.
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(32),
    OTP_HASH_SECRET: z.string().min(16),
    // 2Factor.in (same account as MandiPlus). Required outside local/test.
    TWOFACTOR_API_KEY: z.string().optional(),
    TWOFACTOR_OTP_TEMPLATE_NAME: z.string().optional(),
    /**
     * QA logins that skip the SMS, e.g. "9000000000:123456". Anyone who knows a pair here can
     * sign in as that number, so production carries only the demo account and it is removed
     * before real shops are onboarded.
     */
    OTP_TEST_LOGINS: z.string().default(''),
    /**
     * The morning udhaar WhatsApp. Nothing is sent unless this is "on", the MandiPlus bot's
     * Cloud API credentials are set, and the shop's admin has turned it on.
     */
    UDHAAR_ALERTS: z.enum(['off', 'on']).default('off'),
    WHATSAPP_TOKEN: z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    UDHAAR_ALERT_TEMPLATE: z.string().default('udhaar_baaki_reminder_v1'),
    UDHAAR_ALERT_LANG: z.string().default('hi'),
    /**
     * Grahak eKYC through ULIP's DigiLocker APIs (same account as the MandiPlus backend).
     * Unset = the eKYC screen says it is not switched on. A staging URL means test KYCs:
     * no SMS goes out and KYC_TEST_OTP is the OTP.
     */
    ULIP_BASE_URL: z.string().optional(),
    ULIP_USERNAME: z.string().optional(),
    ULIP_PASSWORD: z.string().optional(),
    // http://user:pass@host:3128 — the Mumbai proxy whose IP ULIP whitelists.
    ULIP_PROXY_URL: z.string().optional(),
    KYC_TEST_OTP: z.string().regex(/^\d{6}$/).default('123456'),
    // Encrypts the e-Aadhaar XML, photo and PAN record at rest. Required once ULIP or Surepass is set.
    KYC_DATA_KEY: z.string().min(32).optional(),
    /**
     * eKYC on DigiLocker's own sign-in page through Surepass (the grahak types their mobile or
     * Aadhaar and the OTP). Unset token = not offered. A sandbox URL means test data.
     */
    SUREPASS_BASE_URL: z.string().default('https://sandbox.surepass.app'),
    SUREPASS_TOKEN: z.string().optional(),
    // Where DigiLocker sends the grahak back; the terminal closes its page on this address.
    PUBLIC_URL: z.string().default('https://mandipos-api.onrender.com'),
  })
  .refine((c) => !c.SUREPASS_TOKEN || !!c.KYC_DATA_KEY, {
    message: 'KYC_DATA_KEY is required when SUREPASS_TOKEN is set',
    path: ['KYC_DATA_KEY'],
  })
  .refine((c) => !c.ULIP_BASE_URL || !!c.KYC_DATA_KEY, {
    message: 'KYC_DATA_KEY is required when ULIP_BASE_URL is set',
    path: ['KYC_DATA_KEY'],
  })
  .refine((c) => c.APP_ENV === 'local' || c.APP_ENV === 'test' || !!c.TWOFACTOR_API_KEY, {
    message: 'TWOFACTOR_API_KEY is required in staging and production',
    path: ['TWOFACTOR_API_KEY'],
  })
  .refine((c) => c.APP_ENV !== 'production' || !c.OTP_TEST_LOGINS.includes('9022353647'), {
    // The owner's own number must always go through a real SMS.
    message: 'OTP_TEST_LOGINS must not contain the owner number',
    path: ['OTP_TEST_LOGINS'],
  });

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function config(): Config {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Invalid environment: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Local and test environments print OTPs instead of sending SMS. */
export const sendsRealSms = () => config().APP_ENV === 'staging' || config().APP_ENV === 'production';

/** Fixed QA codes per phone, from OTP_TEST_LOGINS. Production carries only the demo number. */
export function testLoginCode(phone: string): string | null {
  for (const pair of config().OTP_TEST_LOGINS.split(',')) {
    const [p, code] = pair.split(':').map((x) => x.trim());
    if (p === phone && /^\d{4,8}$/.test(code ?? '')) return code;
  }
  return null;
}
