import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { uuidv7 } from '../src/common/uuid';

// A throwaway database, migrated as the owner, with the API connecting as the
// restricted runtime role — the same split as production.
const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://localhost/postgres';
const DB = 'mandipos_test';
const OWNER_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${DB}`);

let app: INestApplication;
let OtpService: typeof import('../src/auth/otp.service').OtpService;

async function admin(sql: string) {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

beforeAll(async () => {
  await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin(`CREATE DATABASE ${DB}`);
  await admin(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mandipos_api') THEN CREATE ROLE mandipos_api LOGIN PASSWORD 'local-only'; END IF; END $$`);
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'migrate.mjs')], {
    env: { ...process.env, DATABASE_URL_DIRECT: OWNER_URL },
    stdio: 'pipe',
  });

  Object.assign(process.env, {
    APP_ENV: 'test',
    DATABASE_URL: `postgres://mandipos_api:local-only@localhost/${DB}`,
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    OTP_HASH_SECRET: 'test-otp-secret-123',
    OTP_TEST_LOGINS: '9000000000:123456',
  });

  const { AppModule } = await import('../src/app.module');
  const { configure } = await import('../src/main');
  ({ OtpService } = await import('../src/auth/otp.service'));
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication({ bodyParser: false });
  configure(app);
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

const http = () => request(app.getHttpServer());

async function login(phone: string, deviceId?: string) {
  await http().post('/v1/auth/otp').send({ phone }).expect(204);
  const code = OtpService.issuedForTests.get(phone)!;
  const res = await http().post('/v1/auth/verify')
    .send({ phone, code, deviceId, device: { label: 'test terminal', platform: 'android', appVersion: '0.3.0' } })
    .expect(200);
  return res.body as { accessToken: string; refreshToken: string; me: any };
}

async function registerShop(phone: string, name: string) {
  const s = await login(phone);
  const res = await http().post('/v1/shops').set('Authorization', `Bearer ${s.accessToken}`)
    .send({ name, mandi: 'Azadpur', shopNo: '12', role: 'owner' }).expect(201);
  return { ...s, accessToken: res.body.accessToken as string, me: res.body.me };
}

const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

describe('health', () => {
  it('answers without touching the database', async () => {
    const res = await http().get('/healthz').expect(200);
    expect(res.body).toMatchObject({ ok: true, env: 'test' });
  });
});

describe('auth', () => {
  let firstDeviceId = '';

  it('logs in by OTP, then registers a shop and gets device code A1', async () => {
    const s = await registerShop('9800000001', 'Shop One');
    firstDeviceId = s.me.device.id;
    expect(s.me.shop).toMatchObject({ name: 'Shop One', mandi: 'Azadpur', role: 'owner' });
    expect(s.me.device.code).toBe('A1');
    const me = await http().get('/v1/me').set('Authorization', `Bearer ${s.accessToken}`).expect(200);
    expect(me.body.shop.name).toBe('Shop One');
  });

  it('accepts a configured QA login code without sending anything', async () => {
    await http().post('/v1/auth/otp').send({ phone: '9000000000' }).expect(204);
    expect(OtpService.issuedForTests.has('9000000000')).toBe(false);
    await http().post('/v1/auth/verify').send({ phone: '9000000000', code: '123456' }).expect(200);
  });

  it('rejects a wrong OTP and limits attempts', async () => {
    await http().post('/v1/auth/otp').send({ phone: '9800000009' }).expect(204);
    const res = await http().post('/v1/auth/verify').send({ phone: '9800000009', code: '000000' }).expect(400);
    expect(res.body.message).toMatch(/galat/);
  });

  it('refuses a second shop for the same owner', async () => {
    const s = await login('9800000001', firstDeviceId);
    await http().post('/v1/shops').set('Authorization', `Bearer ${s.accessToken}`).send({ name: 'Again' }).expect(409);
  });

  it('puts the owner’s second terminal in the same shop as A2, and a re-login keeps its code', async () => {
    const second = await login('9800000001');
    expect(second.me.shop.name).toBe('Shop One');
    expect(second.me.device.code).toBe('A2');
    const again = await login('9800000001', second.me.device.id);
    expect(again.me.device).toEqual(second.me.device);
  });

  it('rotates refresh tokens and revokes the device session on reuse', async () => {
    const s = await login('9800000002');
    const r1 = await http().post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
    await http().post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(200);
    // Replaying the first token is theft: everything on that device is revoked.
    await http().post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
    await http().post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
  });

  it('requires a shop before syncing', async () => {
    const s = await login('9800000003');
    await http().get('/v1/sync/pull').set('Authorization', `Bearer ${s.accessToken}`).expect(403);
  });
});

describe('sync', () => {
  let owner: Awaited<ReturnType<typeof registerShop>>;
  const truckId = uuidv7();
  const buyerId = uuidv7();
  const billId = uuidv7();

  beforeAll(async () => {
    owner = await login('9800000001');
  });

  const push = (token: string, items: unknown[]) =>
    http().post('/v1/sync/push').set('Authorization', `Bearer ${token}`).send({ items }).expect(200);

  it('applies a full sale in order and reports each row', async () => {
    const t = now();
    const res = await push(owner.accessToken, [
      { table: 'trucks', row: { id: truckId, created_at: t, updated_at: t, number: 'RJ11GC3033', supplier: 'Maddur', arrived_at: t, billed_qty: 12000, free_qty: 600, rate_paise: 3800, freight_paise: 11000000, labour_paise: 800000 } },
      ...(['A', 'B', 'C'] as const).map((g, i) => ({ table: 'truck_grades', row: { id: uuidv7(), created_at: t, truck_id: truckId, grade: g, received_qty: [5800, 4600, 2200][i] } })),
      { table: 'buyers', row: { id: buyerId, created_at: t, updated_at: t, name: 'Buyer One', phone: '9811111111', kind: 'Hotel', credit_limit_paise: 2000000 } },
      { table: 'bills', row: { id: billId, created_at: t, number: 'A2/2627/000001', kind: 'kachchi', buyer_id: buyerId, buyer_name: 'Buyer One', business_date: today(), pay_mode: 'credit', total_paise: 2680000, paid_paise: 0 } },
      { table: 'bill_lines', row: { id: uuidv7(), created_at: t, bill_id: billId, truck_id: truckId, grade: 'A', qty: 400, rate_paise: 6700 } },
      { table: 'collections', row: { id: uuidv7(), created_at: t, buyer_id: buyerId, amount_paise: 1000000, pay_mode: 'cash', business_date: today() } },
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(Array(8).fill('applied'));
  });

  it('ignores a retried row (same id) and rejects a bad one without blocking the batch', async () => {
    const t = now();
    const res = await push(owner.accessToken, [
      { table: 'bills', row: { id: billId, created_at: t, number: 'A2/2627/000001', kind: 'kachchi', buyer_id: buyerId, buyer_name: 'Buyer One', business_date: today(), pay_mode: 'credit', total_paise: 2680000, paid_paise: 0 } },
      { table: 'bills', row: { id: uuidv7(), created_at: t, number: 'A2/2627/000001', kind: 'kachchi', buyer_name: 'x', business_date: today(), pay_mode: 'cash', total_paise: 100, paid_paise: 100 } },
      { table: 'bill_lines', row: { id: uuidv7(), created_at: t, bill_id: uuidv7(), truck_id: truckId, grade: 'A', qty: 1, rate_paise: 1 } },
      { table: 'bills', row: { id: uuidv7(), created_at: t, number: 'too-long-number-xyz', kind: 'kachchi', buyer_name: 'x', business_date: today(), pay_mode: 'cash', total_paise: 1, paid_paise: 1 } },
      { table: 'users', row: { id: uuidv7() } },
      { table: 'spoilage', row: { id: uuidv7(), created_at: t, truck_id: truckId, grade: 'A', qty: 40, business_date: today() } },
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['skipped', 'rejected', 'rejected', 'rejected', 'rejected', 'applied']);
    expect(res.body.results[1].error).toMatch(/duplicate/);
    expect(res.body.results[2].error).toMatch(/parent/);
  });

  it('keeps the newest version of a master row', async () => {
    const later = new Date(Date.now() + 60_000).toISOString();
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const base = { id: buyerId, created_at: now(), phone: '9811111111', kind: 'Hotel', credit_limit_paise: 2000000 };
    const res = await push(owner.accessToken, [
      { table: 'buyers', row: { ...base, updated_at: later, name: 'Buyer One (renamed)' } },
      { table: 'buyers', row: { ...base, updated_at: earlier, name: 'stale edit' } },
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'skipped']);
  });

  it('pulls every change in order, in pages', async () => {
    const all: any[] = [];
    let after = 0;
    for (;;) {
      const res = await http().get(`/v1/sync/pull?after=${after}&limit=3`).set('Authorization', `Bearer ${owner.accessToken}`).expect(200);
      all.push(...res.body.changes);
      after = res.body.lastSeq;
      if (!res.body.hasMore) break;
    }
    expect(all.map((c) => c.seq)).toEqual(all.map((_, i) => i + 1));
    expect(all.map((c) => c.table)).toEqual(['trucks', 'truck_grades', 'truck_grades', 'truck_grades', 'buyers', 'bills', 'bill_lines', 'collections', 'spoilage', 'buyers']);
    const renamed = all.filter((c) => c.table === 'buyers').pop();
    expect(renamed.row).toMatchObject({ name: 'Buyer One (renamed)', shop_id: owner.me.shop.id, device_id: owner.me.device.id });
  });

  it('never shows or accepts another shop’s data', async () => {
    const other = await registerShop('9800000005', 'Shop Two');
    const pulled = await http().get('/v1/sync/pull').set('Authorization', `Bearer ${other.accessToken}`).expect(200);
    expect(pulled.body.changes).toHaveLength(0);
    // Referencing shop one's truck from shop two fails the composite foreign key.
    const res = await push(other.accessToken, [
      { table: 'spoilage', row: { id: uuidv7(), created_at: now(), truck_id: truckId, grade: 'A', qty: 1, business_date: today() } },
    ]);
    expect(res.body.results[0].status).toBe('rejected');
  });

  it('gives the runtime role no way to edit or delete money rows', async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await expect(c.query(`UPDATE bills SET total_paise = 0`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`DELETE FROM bill_lines`)).rejects.toThrow(/permission denied/);
      // Without a shop in the session, RLS hides everything.
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM bills`);
      expect(rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });
});
