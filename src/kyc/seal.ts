import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config';

/**
 * AES-256-GCM for what the KYC keeps at rest: the signed e-Aadhaar, its photo and the PAN
 * record. The key is KYC_DATA_KEY hashed to 32 bytes; a sealed value is iv(12) | tag(16) | data.
 */
function key(): Buffer {
  const k = config().KYC_DATA_KEY;
  if (!k) throw new Error('KYC_DATA_KEY is not set');
  return createHash('sha256').update(k).digest();
}

export function seal(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}

export function unseal(sealed: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key(), sealed.subarray(0, 12));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
}
