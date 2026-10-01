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

/** Runs SQL on the test database as the owner (the API role can't see sessions). */
async function owner(sql: string) {
  const c = new Client({ connectionString: OWNER_URL });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

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

describe('team', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('joins by code as accountant, admin-adds a number that lands in the shop, and keeps team changes admin-only', async () => {
    const admin = await registerShop('9811100001', 'Team Shop');
    const team = await http().get('/v1/shops/members').set(auth(admin.accessToken)).expect(200);
    expect(team.body.youAreAdmin).toBe(true);
    expect(team.body.joinCode).toMatch(/^\d{6}$/);

    // Join by code: an accountant in the same shop.
    const joiner = await login('9811100002');
    expect(joiner.me.shop).toBeNull();
    await http().post('/v1/shops/join').set(auth(joiner.accessToken)).send({ code: '000000' === team.body.joinCode ? '111111' : '000000' }).expect(404);
    const joined = await http().post('/v1/shops/join').set(auth(joiner.accessToken)).send({ code: team.body.joinCode }).expect(200);
    expect(joined.body.me.shop).toMatchObject({ id: admin.me.shop.id, role: 'munim' });

    // An accountant sees the team but not the code, and cannot change it.
    const seen = await http().get('/v1/shops/members').set(auth(joined.body.accessToken)).expect(200);
    expect(seen.body.joinCode).toBeNull();
    await http().post('/v1/shops/members').set(auth(joined.body.accessToken)).send({ phone: '9811100009' }).expect(403);

    // Admin adds a number; its very first login opens this shop.
    await http().post('/v1/shops/members').set(auth(admin.accessToken)).send({ phone: '9811100003', name: 'Munim Ji' }).expect(204);
    await http().post('/v1/shops/members').set(auth(admin.accessToken)).send({ phone: '9811100003' }).expect(409);
    const added = await login('9811100003');
    expect(added.me.shop).toMatchObject({ id: admin.me.shop.id, role: 'munim' });

    // Promote to admin; the last admin cannot step down.
    await http().patch(`/v1/shops/members/${added.me.user.id}`).set(auth(admin.accessToken)).send({ role: 'admin' }).expect(204);
    const now3 = await http().get('/v1/shops/members').set(auth(added.accessToken)).expect(200);
    expect(now3.body.youAreAdmin).toBe(true);
    await http().post(`/v1/shops/members/${added.me.user.id}/role`).set(auth(admin.accessToken)).send({ role: 'accountant' }).expect(204);
    await http().patch(`/v1/shops/members/${admin.me.user.id}`).set(auth(admin.accessToken)).send({ role: 'accountant' }).expect(400);

    // Removing someone shuts their device out at once, and their refresh stops working.
    await http().delete(`/v1/shops/members/${joiner.me.user.id}`).set(auth(admin.accessToken)).expect(204);
    await http().get('/v1/me').set(auth(joined.body.accessToken)).expect(401);
    await http().post('/v1/auth/refresh').send({ refreshToken: joiner.refreshToken }).expect(401);

    // A new code replaces the old one.
    const fresh = await http().post('/v1/shops/join-code').set(auth(admin.accessToken)).expect(200);
    expect(fresh.body.joinCode).not.toEqual(team.body.joinCode);
  });

  it('picks up a shop the number was added to after it logged in', async () => {
    const admin = await registerShop('9811100011', 'Late Shop');
    const waiting = await login('9811100012');
    expect(waiting.me.shop).toBeNull();
    await http().post('/v1/shops/members').set(auth(admin.accessToken)).send({ phone: '9811100012' }).expect(204);
    const me = await http().get('/v1/me').set(auth(waiting.accessToken)).expect(200);
    expect(me.body.shop).toMatchObject({ id: admin.me.shop.id });
    expect(me.body.accessToken).toBeTruthy();
  });
});

describe('slip limit', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('sends an accountant\'s big slip to the admin, and lets only the admin decide', async () => {
    const admin = await registerShop('9822200001', 'Limit Shop');
    await http().post('/v1/shops/members').set(auth(admin.accessToken)).send({ phone: '9822200002', name: 'Munim' }).expect(204);
    const munim = await login('9822200002');

    // The limit is the admin's to set, and every terminal reads it from /me.
    await http().post('/v1/shops/slip-limit').set(auth(munim.accessToken)).send({ slipLimitPaise: 5000000 }).expect(403);
    await http().post('/v1/shops/slip-limit').set(auth(admin.accessToken)).send({ slipLimitPaise: 5000000 }).expect(204);
    const me = await http().get('/v1/me').set(auth(munim.accessToken)).expect(200);
    expect(me.body.shop.slipLimitPaise).toBe(5000000);
    // The slip's phone is the shop's, not whoever is logged in; only an admin changes it.
    expect(me.body.shop.phone).toBe('9822200001');
    await http().post('/v1/shops/phone').set(auth(munim.accessToken)).send({ phone: '9871429335' }).expect(403);
    await http().post('/v1/shops/phone').set(auth(admin.accessToken)).send({ phone: '9871429335' }).expect(204);
    expect((await http().get('/v1/me').set(auth(munim.accessToken))).body.shop.phone).toBe('9871429335');

    // The accountant asks; they cannot approve it themselves.
    const req = await http().post('/v1/requests').set(auth(munim.accessToken))
      .send({ buyerName: 'Gaurav', totalPaise: 6000000, detail: { lines: [{ maal: 'Gujarat', grade: 'I', dana: 1000, bhav: 6000 }] } }).expect(201);
    expect(req.body.status).toBe('pending');
    await http().post(`/v1/requests/${req.body.id}/approve`).set(auth(munim.accessToken)).expect(403);

    // The admin sees it and approves; the accountant's terminal then uses it once.
    const list = await http().get('/v1/requests').set(auth(admin.accessToken)).expect(200);
    expect(list.body.youAreAdmin).toBe(true);
    expect(list.body.requests[0]).toMatchObject({ id: req.body.id, status: 'pending', buyerName: 'Gaurav' });
    await http().post(`/v1/requests/${req.body.id}/approve`).set(auth(admin.accessToken)).expect(200);
    await http().post(`/v1/requests/${req.body.id}/reject`).set(auth(admin.accessToken)).expect(400);
    const seen = await http().get(`/v1/requests/${req.body.id}`).set(auth(munim.accessToken)).expect(200);
    expect(seen.body.status).toBe('approved');
    await http().post(`/v1/requests/${req.body.id}/used`).set(auth(munim.accessToken)).send({ billId: uuidv7() }).expect(204);
    await http().post(`/v1/requests/${req.body.id}/used`).set(auth(munim.accessToken)).send({ billId: uuidv7() }).expect(400);

    // A rejected one stays rejected.
    const two = await http().post('/v1/requests').set(auth(munim.accessToken)).send({ buyerName: 'X', totalPaise: 9000000 }).expect(201);
    const rejected = await http().post(`/v1/requests/${two.body.id}/reject`).set(auth(admin.accessToken)).expect(200);
    expect(rejected.body.status).toBe('rejected');
  });
});

describe('ledger details', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('lets only an admin set the address and bank accounts that head the ledger', async () => {
    const admin = await registerShop('9833300021', 'Ledger Shop');
    await http().post('/v1/shops/members').set(auth(admin.accessToken)).send({ phone: '9833300022', name: 'Munim' }).expect(204);
    const munim = await login('9833300022');

    // Nothing is required: a new shop has none.
    expect((await http().get('/v1/me').set(auth(admin.accessToken))).body.shop).toMatchObject({ address: '', bankAccounts: [] });

    const details = {
      address: 'B-142, New Subzi Mandi, Azadpur, Delhi-33',
      bankAccounts: [
        { holder: 'SHARMA TRADERS', bank: 'HDFC BANK', ifsc: 'hdfc0000123', account: '50100012345678' },
        { holder: '', bank: '', ifsc: '', account: '' },
        { holder: 'GUPTA FRUIT CO.', bank: 'SBI', ifsc: 'SBIN0001234', account: '30012345678' },
      ],
    };
    await http().post('/v1/shops/ledger-details').set(auth(munim.accessToken)).send(details).expect(403);
    await http().post('/v1/shops/ledger-details').set(auth(admin.accessToken)).send(details).expect(204);

    // Every terminal reads them from /me; the empty row is dropped and IFSC is upper-cased.
    const shop = (await http().get('/v1/me').set(auth(munim.accessToken))).body.shop;
    expect(shop.address).toBe('B-142, New Subzi Mandi, Azadpur, Delhi-33');
    expect(shop.bankAccounts).toEqual([
      { holder: 'SHARMA TRADERS', bank: 'HDFC BANK', ifsc: 'HDFC0000123', account: '50100012345678' },
      { holder: 'GUPTA FRUIT CO.', bank: 'SBI', ifsc: 'SBIN0001234', account: '30012345678' },
    ]);
  });
});

describe('print queue', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  // A real 1x1 PNG: the queue refuses anything that isn't one.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==', 'base64').toString('base64');

  it('prints a slip sent from home on the shop\'s station, once', async () => {
    const home = await registerShop('9833300011', 'Print Shop');
    const office = await login('9833300011');           // same owner, the Pine terminal
    const other = await registerShop('9833300012', 'Other Shop');

    // No station yet.
    expect((await http().get('/v1/print/station').set(auth(home.accessToken)).expect(200)).body.station).toBeNull();
    await http().post('/v1/print/jobs').set(auth(home.accessToken)).send({ title: 'x', image: Buffer.from('not a png').toString('base64'), widthDots: 384 }).expect(400);

    // The office machine comes on: an empty poll returns 204 and marks it online.
    await http().get('/v1/print/next?wait=0&name=P052&widthDots=576').set(auth(office.accessToken)).expect(204);
    const st = (await http().get('/v1/print/station').set(auth(home.accessToken)).expect(200)).body.station;
    expect(st).toMatchObject({ online: true, name: 'P052', widthDots: 576, thisDevice: false });

    // Home sends; the waiting station wakes and claims it.
    const waiting = http().get('/v1/print/next?wait=10&name=P052&widthDots=576').set(auth(office.accessToken));
    await new Promise((r) => setTimeout(r, 200));
    const sent = await http().post('/v1/print/jobs').set(auth(home.accessToken)).send({ title: 'Order parchi #20', image: png, widthDots: 576 }).expect(201);
    expect(sent.body.status).toBe('queued');
    const got = await waiting.expect(200);
    expect(got.body).toMatchObject({ id: sent.body.id, title: 'Order parchi #20', widthDots: 576, image: png });

    // Nobody else gets it, and another shop can't see it.
    await http().get('/v1/print/next?wait=0').set(auth(home.accessToken)).expect(204);
    await http().get(`/v1/print/jobs/${sent.body.id}`).set(auth(other.accessToken)).expect(404);
    await http().post(`/v1/print/jobs/${sent.body.id}/done`).set(auth(home.accessToken)).send({ ok: true }).expect(400);

    // Printed: the sender sees it, and it can't be reported twice.
    await http().post(`/v1/print/jobs/${sent.body.id}/done`).set(auth(office.accessToken)).send({ ok: true }).expect(204);
    await http().post(`/v1/print/jobs/${sent.body.id}/done`).set(auth(office.accessToken)).send({ ok: true }).expect(400);
    const seen = await http().get(`/v1/print/jobs/${sent.body.id}`).set(auth(home.accessToken)).expect(200);
    expect(seen.body).toMatchObject({ status: 'printed', station: 'P052', mine: true });

    // A failed one says why and can be sent again.
    const two = await http().post('/v1/print/jobs').set(auth(home.accessToken)).send({ title: 'Payment parchi #20', image: png, widthDots: 576 }).expect(201);
    await http().get('/v1/print/next?wait=0').set(auth(office.accessToken)).expect(200);
    await http().post(`/v1/print/jobs/${two.body.id}/done`).set(auth(office.accessToken)).send({ ok: false, error: 'Paper khatam' }).expect(204);
    expect((await http().get(`/v1/print/jobs/${two.body.id}`).set(auth(home.accessToken))).body).toMatchObject({ status: 'failed', error: 'Paper khatam' });
    await http().post(`/v1/print/jobs/${two.body.id}/retry`).set(auth(home.accessToken)).expect(200);
    expect((await http().get('/v1/print/next?wait=0').set(auth(office.accessToken)).expect(200)).body.id).toBe(two.body.id);

    // Switched off: the station is gone.
    await http().delete('/v1/print/station').set(auth(office.accessToken)).expect(204);
    // (home polled once above, which made it a station too)
    await http().delete('/v1/print/station').set(auth(home.accessToken)).expect(204);
    expect((await http().get('/v1/print/station').set(auth(home.accessToken))).body.station).toBeNull();
    expect((await http().get('/v1/print/jobs').set(auth(home.accessToken))).body.jobs).toHaveLength(2);
  });
});

describe('daybook books', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const push = (token: string, items: unknown[]) =>
    http().post('/v1/sync/push').set(auth(token)).send({ items }).expect(200);
  const entry = (over: Record<string, unknown>) => {
    const t = now();
    return { table: 'daybook_entries', row: { id: uuidv7(), created_at: t, updated_at: t, direction: 'out', mode: 'cash', category: 'kharcha', amount_paise: 5000, business_date: today(), ...over } };
  };

  it('lets an accountant write the galla only, and only their own lines', async () => {
    const admin = await registerShop('9822200011', 'Books Shop');
    await http().post('/v1/shops/members').set(auth(admin.accessToken)).send({ phone: '9822200012', name: 'Rajnish' }).expect(204);
    const munim = await login('9822200012');

    const adminLine = entry({ mode: 'office', category: 'kiraya', amount_paise: 2500000 });
    const own = entry({});
    const res = await push(munim.accessToken, [
      own,
      entry({ category: 'handover', amount_paise: 4500000 }),
      entry({ mode: 'upi', direction: 'in', category: 'aur_aaya' }),
      entry({ mode: 'office', direction: 'in', category: 'committee_mili' }),
      entry({ mode: 'bank', category: 'bank_nikala' }),
      entry({ direction: 'in', category: 'opening', amount_paise: 1000000 }),
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied', 'rejected', 'rejected', 'rejected', 'rejected']);

    // The admin writes every book, and the opening.
    const byAdmin = await push(admin.accessToken, [
      adminLine,
      entry({ mode: 'upi', direction: 'in', category: 'aur_aaya', note: 'Diary' }),
      entry({ direction: 'in', category: 'opening', amount_paise: 1000000 }),
    ]);
    expect(byAdmin.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied', 'applied']);

    // An accountant can take back their own line, not the admin's — even one in the galla.
    const later = new Date(Date.now() + 1000).toISOString();
    const adminCash = entry({ category: 'bhada' });
    await push(admin.accessToken, [adminCash]);
    const hides = await push(munim.accessToken, [
      { ...own, row: { ...own.row, hidden: true, updated_at: later } },
      { ...adminCash, row: { ...adminCash.row, hidden: true, updated_at: later } },
    ]);
    expect(hides.body.results.map((r: any) => r.status)).toEqual(['applied', 'rejected']);
  });
});

describe('udhaar alerts', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const push = (token: string, items: unknown[]) =>
    http().post('/v1/sync/push').set(auth(token)).send({ items }).expect(200);

  it('lists who owes, lets only an admin turn it on, and sends each grahak once a day', async () => {
    const owner = await registerShop('9555500001', 'Alert Traders');
    const buyerId = uuidv7();
    const noPhone = uuidv7();
    const t = now();
    const buyer = (id: string, name: string, phone: string) => ({ table: 'buyers', row: {
      id, created_at: t, updated_at: t, name, phone, kind: '', credit_limit_paise: 0, vehicle: '', address: '', destination: '' } });
    await push(owner.accessToken, [
      buyer(buyerId, 'Raju', '9876500011'),
      buyer(noPhone, 'Bina Phone', ''),
      { table: 'udhaar_entries', row: { id: uuidv7(), created_at: t, buyer_id: buyerId, amount_paise: 1500000, business_date: today() } },
      { table: 'udhaar_entries', row: { id: uuidv7(), created_at: t, buyer_id: noPhone, amount_paise: 500000, business_date: today() } },
      { table: 'collections', row: { id: uuidv7(), created_at: t, buyer_id: buyerId, amount_paise: 250000, pay_mode: 'cash',
        payment_ref: '', business_date: today(), cash_paise: 250000, upi_paise: 0 } },
    ]);

    const preview = await http().get('/v1/shops/udhaar-alerts').set(auth(owner.accessToken)).expect(200);
    expect(preview.body.on).toBe(false);
    expect(preview.body.serverOn).toBe(false);
    // ₹15,000 udhaar less ₹2,500 vasooli; the grahak without a phone can't be messaged.
    expect(preview.body.recipients).toEqual([{ buyerId, name: 'Raju', phone: '9876500011', duePaise: 1250000 }]);

    await http().post('/v1/shops/udhaar-alerts').set(auth(owner.accessToken)).send({ on: true }).expect(204);

    const { UdhaarAlertsService } = await import('../src/alerts/udhaar-alerts.service');
    const alerts = app.get(UdhaarAlertsService);
    const sent: { to: string; params: string[] }[] = [];
    alerts.sender = async (to, params) => { sent.push({ to, params }); return `wamid.${sent.length}`; };
    const first = await alerts.runDaily('2026-10-01');
    const again = await alerts.runDaily('2026-10-01');
    expect(first.sent).toBe(1);
    expect(again).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(sent).toEqual([{ to: '919876500011', params: ['Raju', 'Alert Traders', '12,500', '9555500001'] }]);
    // The test send needs the server switched on; in tests it is off, so it refuses.
    await http().post('/v1/shops/udhaar-alerts/test').set(auth(owner.accessToken)).send({ buyerId }).expect(403);
  });
});

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

  it('forgives a token the terminal just rotated (foreground sync racing the worker)', async () => {
    const s = await login('9800000002');
    const r1 = await http().post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
    // The loser of the race still holds the original token; it must not log the counter out.
    const raced = await http().post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
    expect(raced.body.refreshToken).not.toEqual(r1.body.refreshToken);
    // And the pair it got back works.
    await http().post('/v1/auth/refresh').send({ refreshToken: raced.body.refreshToken }).expect(200);
  });

  it('revokes the device once an old token comes back after the grace window', async () => {
    const s = await login('9800000004');
    const r1 = await http().post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
    await owner(`UPDATE sessions SET revoked_at = now() - interval '5 minutes' WHERE revoked_at IS NOT NULL`);
    // Replaying a long-dead token is theft: everything on that device goes.
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
  const brandId = uuidv7();
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
      { table: 'brands', row: { id: brandId, created_at: t, updated_at: t, name: 'Maddur', sort_order: 1, shelf_days: 7 } },
      { table: 'rates', row: { id: uuidv7(), created_at: t, updated_at: t, business_date: today(), brand_id: brandId, grade: '1', rate_paise: 6700 } },
      { table: 'trucks', row: { id: truckId, created_at: t, updated_at: t, number: 'RJ11GC3033', supplier: 'Maddur', arrived_at: t, freight_paise: 11000000, labour_paise: 800000, commission_paise: 2736000 } },
      ...(['1', '2', '3'] as const).map((g, i) => ({ table: 'truck_grades', row: { id: uuidv7(), created_at: t, truck_id: truckId, brand_id: brandId, grade: g, billed_qty: [5500, 4400, 2100][i], free_qty: [300, 200, 100][i], received_qty: [5800, 4600, 2200][i], rate_paise: [4200, 3800, 3100][i] } })),
      { table: 'buyers', row: { id: buyerId, created_at: t, updated_at: t, name: 'Buyer One', phone: '9811111111', kind: 'Hotel', credit_limit_paise: 2000000 } },
      { table: 'bills', row: { id: billId, created_at: t, number: 'A2/2627/000001', kind: 'kachchi', buyer_id: buyerId, buyer_name: 'Buyer One', business_date: today(), pay_mode: 'mixed', total_paise: 2830000, paid_paise: 2830000, slip_no: 643, truck_id: truckId, cash_paise: 1830000, upi_paise: 1000000, labour_paise: 150000, packing: 'katta10', packs: 50, delivery: 1, staff_name: 'Rajat' } },
      { table: 'bill_lines', row: { id: uuidv7(), created_at: t, bill_id: billId, truck_id: truckId, brand_id: brandId, grade: '1', qty: 400, rate_paise: 6700 } },
      { table: 'collections', row: { id: uuidv7(), created_at: t, buyer_id: buyerId, amount_paise: 1000000, pay_mode: 'mixed', business_date: today(), receipt_no: 1, cash_paise: 600000, upi_paise: 400000 } },
      { table: 'daybook_entries', row: { id: uuidv7(), created_at: t, updated_at: t, direction: 'out', mode: 'cash', category: 'mazdoori', amount_paise: 600000, business_date: today() } },
      { table: 'delivery_slips', row: { id: uuidv7(), created_at: t, bill_id: billId, address: 'Shop 7, Ghaziabad Mandi', destination: 'Taj stand' } },
      { table: 'receivings', row: { id: uuidv7(), created_at: t, bill_id: billId, received_by: 'Shop boy' } },
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(Array(13).fill('applied'));
  });

  it('ignores a retried row (same id) and rejects a bad one without blocking the batch', async () => {
    const t = now();
    const res = await push(owner.accessToken, [
      { table: 'bills', row: { id: billId, created_at: t, number: 'A2/2627/000001', kind: 'kachchi', buyer_id: buyerId, buyer_name: 'Buyer One', business_date: today(), pay_mode: 'mixed', total_paise: 2830000, paid_paise: 2830000, slip_no: 643, truck_id: truckId, cash_paise: 1830000, upi_paise: 1000000, labour_paise: 150000, packing: 'katta10', packs: 50, delivery: 1, staff_name: 'Rajat' } },
      { table: 'bills', row: { id: uuidv7(), created_at: t, number: 'A2/2627/000001', kind: 'kachchi', buyer_name: 'x', business_date: today(), pay_mode: 'cash', total_paise: 100, paid_paise: 100 } },
      { table: 'bill_lines', row: { id: uuidv7(), created_at: t, bill_id: uuidv7(), truck_id: truckId, brand_id: brandId, grade: '1', qty: 1, rate_paise: 1 } },
      { table: 'bills', row: { id: uuidv7(), created_at: t, number: 'too-long-number-xyz', kind: 'kachchi', buyer_name: 'x', business_date: today(), pay_mode: 'cash', total_paise: 1, paid_paise: 1 } },
      { table: 'users', row: { id: uuidv7() } },
      { table: 'spoilage', row: { id: uuidv7(), created_at: t, truck_id: truckId, brand_id: brandId, grade: '1', qty: 40, business_date: today(), kind: 'correction' } },
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['skipped', 'rejected', 'rejected', 'rejected', 'rejected', 'applied']);
    expect(res.body.results[1].error).toMatch(/duplicate/);
    expect(res.body.results[2].error).toMatch(/parent/);
  });

  // The shop's night check is "is any slip number missing?", which only means something if
  // two terminals can never hand out the same one.
  it('refuses a second slip with a number the shop already used', async () => {
    const t = now();
    const slip = (extra: Record<string, unknown>) => ({
      table: 'bills',
      row: {
        id: uuidv7(), created_at: t, number: `A2/2627/${String(Math.floor(Math.random() * 900000) + 100000)}`,
        kind: 'kachchi', buyer_name: 'Walk-in', business_date: today(), pay_mode: 'cash',
        total_paise: 100, paid_paise: 100, cash_paise: 100, ...extra,
      },
    });
    const res = await push(owner.accessToken, [slip({ slip_no: 700 }), slip({ slip_no: 700 }), slip({ slip_no: 701 })]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'rejected', 'applied']);
    expect(res.body.results[1].error).toMatch(/duplicate/);
  });

  // Badlein on a saved slip: cancel it, then write the corrected one under the same number.
  it('lets a slip number be used again only after the slip holding it is voided', async () => {
    const t = now();
    const slip = (id: string) => ({
      table: 'bills',
      row: {
        id, created_at: t, number: `A2/2627/${String(Math.floor(Math.random() * 900000) + 100000)}`,
        kind: 'kachchi', buyer_name: 'Walk-in', business_date: today(), pay_mode: 'cash',
        total_paise: 100, paid_paise: 100, cash_paise: 100, slip_no: 800,
      },
    });
    const first = uuidv7();
    const second = uuidv7();
    const res = await push(owner.accessToken, [
      slip(first),
      slip(uuidv7()),
      { table: 'bill_voids', row: { id: uuidv7(), created_at: t, bill_id: first, slip_no: 800, reason: 'edited' } },
      slip(second),
      slip(uuidv7()),
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'rejected', 'applied', 'applied', 'rejected']);
    expect(res.body.results[4].error).toMatch(/duplicate/);
  });

  it('takes a 15-katta slip and a named panni', async () => {
    const t = now();
    const slip = (extra: Record<string, unknown>) => ({
      table: 'bills',
      row: {
        id: uuidv7(), created_at: t, number: `A2/2627/${String(Math.floor(Math.random() * 900000) + 100000)}`,
        kind: 'kachchi', buyer_name: 'Walk-in', business_date: today(), pay_mode: 'cash',
        total_paise: 100, paid_paise: 100, cash_paise: 100, ...extra,
      },
    });
    const res = await push(owner.accessToken, [slip({ packing: 'katta15', packs: 30 }), slip({ packing: 'panni', panni_name: 'Jai Ho', packs: 200 })]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied']);
  });

  it('carries a grahak\'s purana udhaar', async () => {
    const res = await push(owner.accessToken, [
      { table: 'udhaar_entries', row: { id: uuidv7(), created_at: now(), buyer_id: buyerId, amount_paise: 1250000, note: 'Purana udhaar', business_date: today() } },
      { table: 'udhaar_entries', row: { id: uuidv7(), created_at: now(), buyer_id: buyerId, amount_paise: 0, business_date: today() } },
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'rejected']);
  });

  it('keeps the newest version of a master row', async () => {
    const later = new Date(Date.now() + 60_000).toISOString();
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const base = { id: buyerId, created_at: now(), phone: '9811111111', kind: 'Hotel', credit_limit_paise: 2000000 };
    const res = await push(owner.accessToken, [
      { table: 'buyers', row: { ...base, updated_at: later, name: 'Buyer One (renamed)', code: 'CBO1' } },
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
    expect(all.map((c) => c.table)).toEqual(['brands', 'rates', 'trucks', 'truck_grades', 'truck_grades', 'truck_grades', 'buyers', 'bills', 'bill_lines', 'collections', 'daybook_entries', 'delivery_slips', 'receivings', 'spoilage', 'bills', 'bills', 'bills', 'bill_voids', 'bills', 'bills', 'bills', 'udhaar_entries', 'buyers']);
    // A miscount taken off a gaadi comes back as a correction, not as rotten nuts.
    expect(all.find((c) => c.table === 'spoilage').row).toMatchObject({ qty: 40, kind: 'correction' });
    const renamed = all.filter((c) => c.table === 'buyers').pop();
    expect(renamed.row).toMatchObject({ name: 'Buyer One (renamed)', code: 'CBO1', shop_id: owner.me.shop.id, device_id: owner.me.device.id });
  });

  it('takes a white-katta slip, and an after-payment slip that is owed until paid', async () => {
    const t = now();
    const slip = (extra: Record<string, unknown>) => ({
      table: 'bills',
      row: {
        id: uuidv7(), created_at: t, number: `A2/2627/${String(Math.floor(Math.random() * 900000) + 100000)}`,
        kind: 'kachchi', buyer_name: 'Walk-in', business_date: today(), ...extra,
      },
    });
    const res = await push(owner.accessToken, [
      slip({ pay_mode: 'cash', total_paise: 100, paid_paise: 100, cash_paise: 100, packing: 'katta25', packs: 50 }),
      slip({ pay_mode: 'after', total_paise: 5000, paid_paise: 0, buyer_id: buyerId, buyer_name: 'Buyer One' }),
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied']);
  });

  it('takes more dana on a gaadi as a second lot line of the same maal and grade', async () => {
    const t = now();
    const truck = uuidv7();
    const lot = (qty: number) => ({ table: 'truck_grades', row: { id: uuidv7(), created_at: t, truck_id: truck, brand_id: brandId, grade: '1', billed_qty: qty, received_qty: qty, rate_paise: 0 } });
    const res = await push(owner.accessToken, [
      { table: 'trucks', row: { id: truck, created_at: t, updated_at: t, number: 'RICKY', arrived_at: t } },
      lot(600), lot(165),
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied', 'applied']);
  });

  it('keeps a grahak\'s A/C code when a terminal that predates codes edits them', async () => {
    const t = new Date(Date.now() + 120_000).toISOString();
    const res = await push(owner.accessToken, [
      { table: 'buyers', row: { id: buyerId, created_at: now(), updated_at: t, name: 'Buyer One', phone: '9811111111' } },
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied']);
    const pulled = await http().get('/v1/sync/pull?after=0&limit=500').set('Authorization', `Bearer ${owner.accessToken}`).expect(200);
    expect(pulled.body.changes.filter((c: any) => c.table === 'buyers').pop().row).toMatchObject({ name: 'Buyer One', code: 'CBO1' });
  });

  it('never shows or accepts another shop’s data', async () => {
    const other = await registerShop('9800000005', 'Shop Two');
    const pulled = await http().get('/v1/sync/pull').set('Authorization', `Bearer ${other.accessToken}`).expect(200);
    expect(pulled.body.changes).toHaveLength(0);
    // Referencing shop one's truck from shop two fails the composite foreign key.
    const res = await push(other.accessToken, [
      { table: 'spoilage', row: { id: uuidv7(), created_at: now(), truck_id: truckId, brand_id: brandId, grade: '1', qty: 1, business_date: today() } },
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
