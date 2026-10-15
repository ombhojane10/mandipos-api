/**
 * Voice eval: plays every case in cases.json to POST /v1/voice and checks the reply against what
 * was expected. Run synth.sh first. Usage:
 *   bun scripts/voice-eval/run.ts [baseUrl=http://localhost:3000] [phone=9000000000] [otp=123456] [only-id]
 * The phone must be an OTP_TEST_LOGINS number with an approved shop on that server.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const dir = import.meta.dir;
const [base = 'http://localhost:3000', phone = '9000000000', otp = '123456', only] = process.argv.slice(2);
const context = readFileSync(join(dir, 'context.txt'), 'utf8');
type Case = { id: string; draft?: string; expect: Record<string, unknown> };
const cases: Case[] = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8')).filter((c: Case) => !only || c.id === only);

async function post(path: string, body: object, token?: string) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

await post('/v1/auth/otp', { phone });
const auth = await post('/v1/auth/verify', { phone, code: otp, device: { label: 'voice eval', platform: 'android', appVersion: 'eval' } });
const token = auth.accessToken as string;

/** Every expected field must match; arrays match item by item (expected items are partial); null = must be absent. */
function diff(want: unknown, got: unknown, path = ''): string[] {
  if (want === null) return got === undefined ? [] : [`${path}: should be absent, got ${JSON.stringify(got)}`];
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) return [`${path}: want ${want.length} items, got ${JSON.stringify(got)}`];
    return want.flatMap((w, i) => diff(w, got[i], `${path}[${i}]`));
  }
  if (want && typeof want === 'object') return Object.entries(want).flatMap(([k, w]) => diff(w, (got as any)?.[k], path ? `${path}.${k}` : k));
  const norm = (v: unknown) => (typeof v === 'string' ? v.toLowerCase().trim() : v ?? '');
  if (path.endsWith('grade') && (got ?? '') === '' && want === 'I') return [];
  return norm(want) === norm(got) ? [] : [`${path}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
}

const times: number[] = [];
let pass = 0;
const run = async (c: Case) => {
  const audio = readFileSync(join(dir, 'audio', `${c.id}.m4a`)).toString('base64');
  const t = Date.now();
  try {
    const r = await post('/v1/voice', { audio, mime: 'audio/mp4', context, screen: c.draft ? 'parchi' : 'home', draft: c.draft }, token);
    const ms = Date.now() - t; times.push(ms);
    const errs = diff(c.expect, r.reply);
    if (!errs.length) pass++;
    console.log(`${errs.length ? 'FAIL' : 'ok  '} ${c.id.padEnd(18)} ${String(ms).padStart(5)}ms ${r.model}  "${r.reply.transcript}"${errs.length ? `\n      ${errs.join('\n      ')}\n      ${JSON.stringify(r.reply)}` : ''}`);
  } catch (e) {
    console.log(`ERR  ${c.id.padEnd(18)} ${(e as Error).message}`);
  }
};
// Three at a time: what a busy shop with a few terminals might send.
for (let i = 0; i < cases.length; i += 3) await Promise.all(cases.slice(i, i + 3).map(run));
times.sort((a, b) => a - b);
const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
console.log(`\n${pass}/${cases.length} passed · p50 ${pct(0.5)}ms · p90 ${pct(0.9)}ms · max ${times[times.length - 1]}ms`);
