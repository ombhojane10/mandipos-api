import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/** Parses a request body or throws a 400 naming the first bad field. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new BadRequestException(`${i.path.join('.') || 'body'}: ${i.message}`);
  }
  return r.data;
}

export const phone = z
  .string()
  .transform((s) => s.replace(/\D/g, '').slice(-10))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'must be a 10-digit Indian mobile number'));
