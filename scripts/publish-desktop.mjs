// Publishes a MandiPlus Dashboard (Windows) build. Installed copies update themselves to it, and
// /v1/public/app/download?flavor=desktop serves it.
//   DATABASE_URL_DIRECT=… npm run publish-desktop -- "<MandiPlus Dashboard.exe>" <x.y.z> [notes]
// The version becomes version_code x*10000 + y*100 + z and must be newer than what is published.
// It must also be the version built into the exe, or installed copies would update forever.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const [file, version, notes = ''] = process.argv.slice(2);
const url = process.env.DATABASE_URL_DIRECT;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
if (!file || !m || !url) {
  console.error('Usage: DATABASE_URL_DIRECT=… npm run publish-desktop -- <exe> <x.y.z> [notes]');
  process.exit(1);
}
const code = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
const exe = await readFile(file);
if (exe.subarray(0, 2).toString() !== 'MZ') {
  console.error(`${file} is not a Windows exe`);
  process.exit(1);
}
if (!exe.includes(Buffer.from(version))) {
  console.error(`${file} does not contain version ${version}`);
  process.exit(1);
}
const sha256 = createHash('sha256').update(exe).digest('hex');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query(`SELECT max(version_code) AS v FROM app_releases WHERE flavor = 'desktop'`);
  if (code <= (rows[0].v ?? 0)) {
    console.error(`desktop ${version} (${code}) is not newer than the published ${rows[0].v}.`);
    process.exitCode = 1;
  } else {
    await client.query(
      `INSERT INTO app_releases (flavor, version_code, version_name, sha256, size_bytes, apk, notes) VALUES ('desktop', $1, $2, $3, $4, $5, $6)`,
      [code, version, sha256, exe.length, exe, notes],
    );
    await client.query(`DELETE FROM app_releases WHERE flavor = 'desktop' AND version_code NOT IN
      (SELECT version_code FROM app_releases WHERE flavor = 'desktop' ORDER BY version_code DESC LIMIT 2)`);
    console.log(`published desktop ${version} (${code}), ${(exe.length / 1e6).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…`);
  }
} finally {
  await client.end();
}
