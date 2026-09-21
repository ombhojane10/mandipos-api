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
  })
  .refine((c) => c.APP_ENV === 'local' || c.APP_ENV === 'test' || !!c.TWOFACTOR_API_KEY, {
    message: 'TWOFACTOR_API_KEY is required in staging and production',
    path: ['TWOFACTOR_API_KEY'],
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
