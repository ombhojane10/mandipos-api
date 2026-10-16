// Publishes a Tally connector build; mandiplus.com/tally-connector then serves it.
//   DATABASE_URL_DIRECT=… npm run publish-tally -- <MandiTally-x.y.z-windows.zip> <x.y.z> [notes]
// The version becomes version_code x*10000 + y*100 + z and must be newer than what is published.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const [file, version, notes = ''] = process.argv.slice(2);
const url = process.env.DATABASE_URL_DIRECT;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
if (!file || !m || !url) {
  console.error('Usage: DATABASE_URL_DIRECT=… npm run publish-tally -- <zip> <x.y.z> [notes]');
  process.exit(1);
}
const code = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
const zip = await readFile(file);
if (zip.subarray(0, 2).toString() !== 'PK') {
  console.error(`${file} is not a zip`);
  process.exit(1);
}
const sha256 = createHash('sha256').update(zip).digest('hex');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query(`SELECT max(version_code) AS v FROM app_releases WHERE flavor = 'tally'`);
  if (code <= (rows[0].v ?? 0)) {
    console.error(`tally ${version} (${code}) is not newer than the published ${rows[0].v}.`);
    process.exitCode = 1;
  } else {
    await client.query(
      `INSERT INTO app_releases (flavor, version_code, version_name, sha256, size_bytes, apk, notes) VALUES ('tally', $1, $2, $3, $4, $5, $6)`,
      [code, version, sha256, zip.length, zip, notes],
    );
    // Keep the last two: each is ~40 MB.
    await client.query(`DELETE FROM app_releases WHERE flavor = 'tally' AND version_code NOT IN
      (SELECT version_code FROM app_releases WHERE flavor = 'tally' ORDER BY version_code DESC LIMIT 2)`);
    console.log(`published tally ${version} (${code}), ${(zip.length / 1e6).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…`);
  }
} finally {
  await client.end();
}
