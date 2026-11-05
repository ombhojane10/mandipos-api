import { readFileSync } from 'node:fs';
import { readApk } from '../src/app/apk';

// The release upload reads the signer, package and version from the APK itself. Run with
// APK_FIXTURE=<a release APK> (APKs are never committed: this repo is public).
const fixture = process.env.APK_FIXTURE;
(fixture ? describe : describe.skip)('readApk', () => {
  it('reads the signing certificate, package and version of a release build', () => {
    const info = readApk(readFileSync(fixture!));
    expect(info).toMatchObject({
      packageName: process.env.APK_PACKAGE ?? 'com.mandiplus.pos.uat',
      versionCode: Number(process.env.APK_CODE ?? 206),
      versionName: process.env.APK_NAME ?? '0.80.1',
    });
    expect(info.certSha256).toContain('163e9678060ab2f2a12e20f02db0072fd30c7686906735eacf11df2efff4da36');
  });
});

describe('readApk on junk', () => {
  it('refuses something that is not an APK', () => {
    expect(() => readApk(Buffer.from('not an apk at all, just text'.repeat(4)))).toThrow();
  });
});
