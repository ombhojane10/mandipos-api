// Publishes a release APK that installed apps then update themselves to.
//   DATABASE_URL_DIRECT=… npm run publish-apk -- <app/build/outputs/apk/pos/release> [notes]
// Reads the flavor and version from the output-metadata.json Gradle writes beside the APK,
// and refuses anything that is not a release build or not newer than what is published.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const [dir, notes = ''] = process.argv.slice(2);
const url = process.env.DATABASE_URL_DIRECT;
if (!dir || !url) {
  console.error('Usage: DATABASE_URL_DIRECT=… npm run publish-apk -- <apk output dir> [notes]');
  process.exit(1);
}

const meta = JSON.parse(await readFile(path.join(dir, 'output-metadata.json'), 'utf8'));
const out = meta.elements?.[0];
const flavor = meta.variantName?.replace(/Release$/, '');
const ids = { pos: 'com.mandiplus.pos.uat', daybook: 'com.mandiplus.daybook' };
if (!out || !meta.variantName?.endsWith('Release') || ids[flavor] !== meta.applicationId) {
  console.error(`Not a pos/daybook release build: ${meta.variantName} ${meta.applicationId}`);
  process.exit(1);
}
const apk = await readFile(path.join(dir, out.outputFile));
const sha256 = createHash('sha256').update(apk).digest('hex');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query('SELECT max(version_code) AS v FROM app_releases WHERE flavor = $1', [flavor]);
  const newest = rows[0].v ?? 0;
  if (out.versionCode <= newest) {
    console.error(`${flavor} ${out.versionCode} is not newer than the published ${newest}. Bump versionCode.`);
    process.exitCode = 1;
  } else {
    await client.query(
      `INSERT INTO app_releases (flavor, version_code, version_name, sha256, size_bytes, apk, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [flavor, out.versionCode, out.versionName, sha256, apk.length, apk, notes],
    );
    // Older builds are never served again (Android won't downgrade); keep the last few for the record.
    await client.query(
      `DELETE FROM app_releases WHERE flavor = $1 AND version_code NOT IN
         (SELECT version_code FROM app_releases WHERE flavor = $1 ORDER BY version_code DESC LIMIT 3)`,
      [flavor],
    );
    console.log(`published ${flavor} ${out.versionName} (${out.versionCode}), ${(apk.length / 1e6).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…`);
  }
} finally {
  await client.end();
}
