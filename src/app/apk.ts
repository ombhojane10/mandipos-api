import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

/**
 * What an uploaded APK says about itself, read from the file and never from the uploader: the
 * SHA-256 of each certificate it is signed with (APK Signature Scheme v2/v3), and the package,
 * versionCode and versionName in its AndroidManifest.xml. Throws on anything that is not a
 * well-formed APK.
 */
export type ApkInfo = { certSha256: string[]; packageName: string; versionCode: number; versionName: string };

export function readApk(apk: Buffer): ApkInfo {
  const eocd = findEocd(apk);
  const cdSize = apk.readUInt32LE(eocd + 12), cdOffset = apk.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > apk.length) throw new Error('not a zip');
  return { certSha256: signerCerts(apk, cdOffset), ...manifest(entry(apk, cdOffset, cdSize, 'AndroidManifest.xml')) };
}

// ---------------------------------------------------------------- zip

function findEocd(b: Buffer): number {
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) if (b.readUInt32LE(i) === 0x06054b50) return i;
  throw new Error('not a zip');
}

function entry(b: Buffer, cdOffset: number, cdSize: number, name: string): Buffer {
  for (let p = cdOffset; p < cdOffset + cdSize;) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20);
    const nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), local = b.readUInt32LE(p + 42);
    if (b.toString('utf8', p + 46, p + 46 + nlen) === name) {
      if (b.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry');
      const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      const raw = b.subarray(start, start + csize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return inflateRawSync(raw);
      throw new Error('unsupported zip compression');
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error(`${name} missing`);
}

// ---------------------------------------------------------------- signing block

const V2 = 0x7109871a, V3 = 0xf05368c0;

/** The certificates in the v2 (else v3) signing block. Empty when the APK has neither. */
function signerCerts(b: Buffer, cdOffset: number): string[] {
  if (cdOffset < 32 || b.toString('latin1', cdOffset - 16, cdOffset) !== 'APK Sig Block 42') return [];
  const size = Number(b.readBigUInt64LE(cdOffset - 24));
  const start = cdOffset - size - 8;
  if (start < 0 || Number(b.readBigUInt64LE(start)) !== size) throw new Error('bad signing block');
  const pairs = new Map<number, Buffer>();
  for (let p = start + 8; p < cdOffset - 24;) {
    const len = Number(b.readBigUInt64LE(p));
    pairs.set(b.readUInt32LE(p + 8), b.subarray(p + 12, p + 8 + len));
    p += 8 + len;
  }
  const block = pairs.get(V2) ?? pairs.get(V3);
  if (!block) return [];
  const out: string[] = [];
  for (const signer of seq(lp(block, 0).value)) {
    const signed = lp(signer, 0).value;              // signed data: digests, certificates, …
    const digests = lp(signed, 0);
    const certs = lp(signed, digests.next).value;
    for (const cert of seq(certs)) out.push(createHash('sha256').update(cert).digest('hex'));
  }
  return out;
}

/** A uint32-length-prefixed value at [at]. */
function lp(b: Buffer, at: number) {
  const len = b.readUInt32LE(at);
  if (at + 4 + len > b.length) throw new Error('bad signing block');
  return { value: b.subarray(at + 4, at + 4 + len), next: at + 4 + len };
}

function seq(b: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let p = 0; p < b.length;) { const x = lp(b, p); out.push(x.value); p = x.next; }
  return out;
}

// ---------------------------------------------------------------- binary AndroidManifest.xml

/** The <manifest> element's package, versionCode and versionName. */
function manifest(x: Buffer): { packageName: string; versionCode: number; versionName: string } {
  if (x.readUInt16LE(0) !== 0x0003) throw new Error('bad manifest');
  let strings: string[] = [];
  for (let p = x.readUInt16LE(2); p < x.length;) {
    const type = x.readUInt16LE(p), headerSize = x.readUInt16LE(p + 2), size = x.readUInt32LE(p + 4);
    if (type === 0x0001) strings = stringPool(x, p);
    if (type === 0x0102 && strings[x.readInt32LE(p + 20)] === 'manifest') {
      const attrStart = p + 16 + x.readUInt16LE(p + 24), count = x.readUInt16LE(p + 28);
      const got: Record<string, string | number> = {};
      for (let i = 0; i < count; i++) {
        const a = attrStart + i * 20;
        const name = strings[x.readInt32LE(a + 4)], raw = x.readInt32LE(a + 8), dataType = x.readUInt8(a + 15), data = x.readUInt32LE(a + 16);
        got[name] = raw >= 0 ? strings[raw] : dataType === 0x03 ? strings[data] : data;
      }
      return { packageName: String(got.package ?? ''), versionCode: Number(got.versionCode ?? 0), versionName: String(got.versionName ?? '') };
    }
    p += size || headerSize || 8;
  }
  throw new Error('manifest element missing');
}

function stringPool(x: Buffer, p: number): string[] {
  const count = x.readUInt32LE(p + 8), flags = x.readUInt32LE(p + 16), stringsStart = p + x.readUInt32LE(p + 20);
  const utf8 = (flags & 0x100) !== 0;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = stringsStart + x.readUInt32LE(p + x.readUInt16LE(p + 2) + i * 4);
    if (utf8) {
      s += x[s] & 0x80 ? 2 : 1;                      // length in characters
      let n = x[s]; s++;
      if (n & 0x80) { n = ((n & 0x7f) << 8) | x[s]; s++; }
      out.push(x.toString('utf8', s, s + n));
    } else {
      let n = x.readUInt16LE(s); s += 2;
      if (n & 0x8000) { n = ((n & 0x7fff) << 16) | x.readUInt16LE(s); s += 2; }
      out.push(x.toString('utf16le', s, s + n * 2));
    }
  }
  return out;
}
