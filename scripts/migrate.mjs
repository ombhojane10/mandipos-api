// Applies migrations/NNN_*.sql in order, each once, each in its own transaction.
// Uses the DIRECT (unpooled) connection: migrations need a real session.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL_DIRECT (or DATABASE_URL).');
  process.exit(1);
}

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'migrations');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  // One migrator at a time, even if two deploys overlap.
  await client.query('SELECT pg_advisory_lock(7240001)');
  const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`failed ${file}: ${err.message}`);
      process.exitCode = 1;
      break;
    }
  }
  if (!process.exitCode) console.log('migrations up to date');
} finally {
  await client.end();
}
