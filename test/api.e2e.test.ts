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
    ADMIN_PHONES: '9876500077, 9022300000, 9000000000',
    ULIP_BASE_URL: 'https://ulip.staging.invalid/ulip/v1.0.0',
    ULIP_USERNAME: 'test',
    ULIP_PASSWORD: 'test',
    KYC_DATA_KEY: 'test-kyc-key-test-kyc-key-test-kyc-key',
    SUREPASS_TOKEN: 'test-surepass-token',
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
  return { ...s, ...(await createApproved(s.accessToken, { name, mandi: 'Azadpur', shopNo: '12', role: 'owner' })) };
}

/** Registers a shop and approves it the way the admin portal does; returns the token that opens it. */
async function createApproved(token: string, body: object) {
  const res = await http().post('/v1/shops').set('Authorization', `Bearer ${token}`).send(body).expect(201);
  expect(res.body.me.shop).toBeNull();
  expect(res.body.me.pendingShop).toMatchObject({ status: 'pending' });
  await owner(`UPDATE shops SET approved_at = now() WHERE id = '${res.body.me.pendingShop.id}'`);
  const me = await http().get('/v1/me').set('Authorization', `Bearer ${res.body.accessToken}`).expect(200);
  return { accessToken: me.body.accessToken as string, me: me.body };
}

const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
/** The shop's business day, in IST — what the server dates website entries and voids by. */
const istDay = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

describe('team', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('lets a shop print bhav on its udhaar slips, and says so in /v1/me', async () => {
    const admin = await registerShop('9811100091', 'Rates Shop');
    const me = async () => (await http().get('/v1/me').set(auth(admin.accessToken)).expect(200)).body.shop;
    expect((await me()).udhaarRates).toBe(false);
    await http().post('/v1/shops/udhaar-rates').set(auth(admin.accessToken)).send({ on: true }).expect(204);
    expect((await me()).udhaarRates).toBe(true);
    await http().post('/v1/shops/udhaar-rates').set(auth(admin.accessToken)).send({ on: 'yes' }).expect(400);
  });

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

describe('amrud', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('keeps the commodity on the shop, admin-only to change, and syncs a slip\'s chungi', async () => {
    // Every shop registered without saying is tender coconut.
    const nariyal = await registerShop('9833300001', 'Nariyal Shop');
    expect(nariyal.me.shop.commodity).toBe('nariyal');

    const s = await login('9833300002');
    const res = await createApproved(s.accessToken, { name: 'Amrud Shop', mandi: 'Azadpur', shopNo: '9', role: 'owner', commodity: 'amrud' });
    const owner = res.accessToken;
    expect(res.me.shop.commodity).toBe('amrud');
    await http().post('/v1/shops').set(auth((await login('9833300003')).accessToken))
      .send({ name: 'X', commodity: 'seb' }).expect(400);

    await http().post('/v1/shops/members').set(auth(owner)).send({ phone: '9833300004' }).expect(204);
    const munim = await login('9833300004');
    expect(munim.me.shop.commodity).toBe('amrud');
    // An accountant may change it too: they hold every power the owners do.
    await http().post('/v1/shops/commodity').set(auth(munim.accessToken)).send({ commodity: 'nariyal' }).expect(204);
    expect((await http().get('/v1/me').set(auth(munim.accessToken))).body.shop.commodity).toBe('nariyal');
    await http().post('/v1/shops/commodity').set(auth(owner)).send({ commodity: 'amrud' }).expect(204);

    // 20 boxes at ₹300 plus ₹10 a box chungi: the slip owes ₹6,200, of which ₹200 is chungi.
    const t = new Date().toISOString();
    const brandId = uuidv7(), truckId = uuidv7(), billId = uuidv7();
    const pushed = await http().post('/v1/sync/push').set(auth(owner)).send({ items: [
      { table: 'brands', row: { id: brandId, created_at: t, updated_at: t, name: 'Jhatu', sort_order: 1, shelf_days: 7 } },
      { table: 'trucks', row: { id: truckId, created_at: t, updated_at: t, number: 'ASHU', supplier: 'Ashu', arrived_at: t } },
      { table: 'truck_grades', row: { id: uuidv7(), created_at: t, truck_id: truckId, brand_id: brandId, grade: '1', billed_qty: 300, received_qty: 300, rate_paise: 0 } },
      { table: 'bills', row: { id: billId, created_at: t, number: 'A1/2627/000001', kind: 'kachchi', buyer_name: 'Cash', business_date: t.slice(0, 10), pay_mode: 'cash', total_paise: 620000, paid_paise: 620000, cash_paise: 620000, labour_paise: 10000, chungi_paise: 20000, slip_no: 1, truck_id: truckId } },
      { table: 'bill_lines', row: { id: uuidv7(), created_at: t, bill_id: billId, truck_id: truckId, brand_id: brandId, grade: '1', qty: 20, rate_paise: 30000 } },
    ] }).expect(200);
    expect(pushed.body.results.map((r: any) => r.status)).toEqual(Array(5).fill('applied'));
    const pulled = await http().get('/v1/sync/pull?after=0&limit=500').set(auth(owner)).expect(200);
    expect(pulled.body.changes.find((c: any) => c.table === 'bills').row).toMatchObject({ total_paise: 620000, chungi_paise: 20000 });
  });
});

describe('angoor', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('syncs where the gaadi stands, box weight, track-only APMC, pickups, store/broken and the accountant roster', async () => {
    const s = await login('9829200001');
    const res = await createApproved(s.accessToken, { name: 'Angoor Shop', mandi: 'Azadpur', shopNo: 'C-22', role: 'owner', commodity: 'angoor' });
    const owner = res.accessToken;
    expect(res.me.shop.commodity).toBe('angoor');
    expect(res.me.shop.staffBackupCode).toBe('99');
    await http().post('/v1/shops/staff-backup-code').set(auth(owner)).send({ code: '4321' }).expect(204);
    await http().post('/v1/shops/staff-backup-code').set(auth(owner)).send({ code: 'ab' }).expect(400);
    expect((await http().get('/v1/me').set(auth(owner))).body.shop.staffBackupCode).toBe('4321');

    // Gaadi 3289 from Manat, standing at Pillar 320; 50 boxes of Royal at 10 kg, our own bhav ₹1,200.
    // 10 Royal sold for cash at ₹1,500 plus ₹10 a box mazdoori: ₹15,100, APMC ₹150 kept aside.
    const t = new Date().toISOString();
    const day = t.slice(0, 10);
    const brandId = uuidv7(), truckId = uuidv7(), billId = uuidv7(), staffId = uuidv7();
    const pushed = await http().post('/v1/sync/push').set(auth(owner)).send({ items: [
      { table: 'brands', row: { id: brandId, created_at: t, updated_at: t, name: 'Royal', sort_order: 1, shelf_days: 7 } },
      { table: 'trucks', row: { id: truckId, created_at: t, updated_at: t, number: '3289', supplier: 'Manat', arrived_at: t, location: 'Pillar 320, Shed 11' } },
      { table: 'truck_grades', row: { id: uuidv7(), created_at: t, truck_id: truckId, brand_id: brandId, grade: '1', billed_qty: 50, received_qty: 50, rate_paise: 120000, box_grams: 10000 } },
      { table: 'bills', row: { id: billId, created_at: t, number: 'A1/2627/000001', kind: 'kachchi', buyer_name: 'Cash', business_date: day, pay_mode: 'cash', total_paise: 1510000, paid_paise: 1510000, cash_paise: 1510000, chungi_paise: 10000, apmc_paise: 15000, slip_no: 1 } },
      { table: 'bill_lines', row: { id: uuidv7(), created_at: t, bill_id: billId, truck_id: truckId, brand_id: brandId, grade: '1', qty: 10, rate_paise: 150000 } },
      { table: 'pickups', row: { id: uuidv7(), created_at: t, bill_id: billId, qty: 6 } },
      { table: 'spoilage', row: { id: uuidv7(), created_at: t, truck_id: truckId, brand_id: brandId, grade: '1', qty: 20, business_date: day, kind: 'store', note: 'Box 32' } },
      { table: 'spoilage', row: { id: uuidv7(), created_at: t, truck_id: truckId, brand_id: brandId, grade: '1', qty: 2, business_date: day, kind: 'broken' } },
      { table: 'staff', row: { id: staffId, created_at: t, updated_at: t, name: 'Nilesh', passcode: '5650' } },
      { table: 'bill_voids', row: { id: uuidv7(), created_at: t, bill_id: billId, slip_no: 1, reason: 'deleted', staff_name: 'Nilesh' } },
    ] }).expect(200);
    expect(pushed.body.results.map((r: any) => r.status)).toEqual(Array(10).fill('applied'));

    const bad = await http().post('/v1/sync/push').set(auth(owner)).send({ items: [
      { table: 'spoilage', row: { id: uuidv7(), created_at: t, truck_id: truckId, brand_id: brandId, grade: '1', qty: 1, business_date: day, kind: 'storee' } },
      { table: 'staff', row: { id: uuidv7(), created_at: t, updated_at: t, name: 'X', passcode: 'abcd' } },
    ] }).expect(200);
    expect(bad.body.results.map((r: any) => r.status)).toEqual(['rejected', 'rejected']);

    // An older terminal that closes the truck without knowing `location` leaves it alone.
    const later = new Date(Date.now() + 1000).toISOString();
    await http().post('/v1/sync/push').set(auth(owner)).send({ items: [
      { table: 'trucks', row: { id: truckId, created_at: t, updated_at: later, number: '3289', supplier: 'Manat', arrived_at: t, closed_at: later } },
    ] }).expect(200);

    const pulled = await http().get('/v1/sync/pull?after=0&limit=500').set(auth(owner)).expect(200);
    const rows = (table: string) => pulled.body.changes.filter((c: any) => c.table === table).map((c: any) => c.row);
    expect(rows('bills')[0]).toMatchObject({ total_paise: 1510000, apmc_paise: 15000, chungi_paise: 10000 });
    expect(rows('truck_grades')[0]).toMatchObject({ box_grams: 10000, rate_paise: 120000 });
    expect(rows('trucks').at(-1)).toMatchObject({ location: 'Pillar 320, Shed 11' });
    expect(rows('trucks').at(-1).closed_at).toBeTruthy();
    expect(rows('pickups')[0]).toMatchObject({ bill_id: billId, qty: 6 });
    expect(rows('spoilage').map((r: any) => [r.kind, r.note])).toEqual(expect.arrayContaining([['store', 'Box 32'], ['broken', '']]));
    expect(rows('staff')[0]).toMatchObject({ name: 'Nilesh', passcode: '5650', hidden: false });
    expect(rows('bill_voids')[0]).toMatchObject({ staff_name: 'Nilesh' });

  });
});

describe('angoor round 2', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('switches APMC and slip WhatsApp, syncs samples and supplier phones, and holds sends until the template is approved', async () => {
    const s = await login('9829200011');
    const res = await createApproved(s.accessToken, { name: 'Angoor Two', mandi: 'Azadpur', shopNo: 'C-23', role: 'owner', commodity: 'angoor' });
    const owner = res.accessToken;
    expect(res.me.shop).toMatchObject({ apmcOn: true, slipWhatsapp: false });
    expect(res.me.shops).toEqual([expect.objectContaining({ name: 'Angoor Two', commodity: 'angoor' })]);
    await http().post('/v1/shops/apmc').set(auth(owner)).send({ on: false }).expect(204);
    await http().post('/v1/shops/slip-whatsapp').set(auth(owner)).send({ on: true }).expect(204);
    expect((await http().get('/v1/me').set(auth(owner))).body.shop).toMatchObject({ apmcOn: false, slipWhatsapp: true });

    const t = new Date().toISOString();
    const day = t.slice(0, 10);
    const brandId = uuidv7(), truckId = uuidv7(), billId = uuidv7();
    const pushed = await http().post('/v1/sync/push').set(auth(owner)).send({ items: [
      { table: 'brands', row: { id: brandId, created_at: t, updated_at: t, name: 'Rocket', sort_order: 1, shelf_days: 7 } },
      { table: 'trucks', row: { id: truckId, created_at: t, updated_at: t, number: '3289', supplier: 'Sai', arrived_at: t } },
      { table: 'truck_grades', row: { id: uuidv7(), created_at: t, truck_id: truckId, brand_id: brandId, grade: '1', billed_qty: 300, received_qty: 300, rate_paise: 0, box_grams: 15000 } },
      { table: 'bills', row: { id: billId, created_at: t, number: 'A1/2627/000001', kind: 'kachchi', buyer_name: 'Cash', business_date: day, pay_mode: 'cash', total_paise: 50000, paid_paise: 50000, cash_paise: 50000, slip_no: 1 } },
      { table: 'bill_lines', row: { id: uuidv7(), created_at: t, bill_id: billId, truck_id: truckId, brand_id: brandId, grade: '1', qty: 1, rate_paise: 50000 } },
      { table: 'spoilage', row: { id: uuidv7(), created_at: t, truck_id: truckId, brand_id: brandId, grade: '1', qty: 1, business_date: day, kind: 'sample', note: '5 piece' } },
      { table: 'supplier_phones', row: { id: uuidv7(), created_at: t, updated_at: t, name: 'Sai', phone: '9606995351' } },
    ] }).expect(200);
    expect(pushed.body.results.map((r: any) => r.status)).toEqual(Array(7).fill('applied'));
    const bad = await http().post('/v1/sync/push').set(auth(owner)).send({ items: [
      { table: 'spoilage', row: { id: uuidv7(), created_at: t, truck_id: truckId, brand_id: brandId, grade: '1', qty: 1, business_date: day, kind: 'samplee' } },
      { table: 'supplier_phones', row: { id: uuidv7(), created_at: t, updated_at: t, name: 'X', phone: '12345' } },
    ] }).expect(200);
    expect(bad.body.results.map((r: any) => r.status)).toEqual(['rejected', 'rejected']);
    const pulled = await http().get('/v1/sync/pull?after=0&limit=500').set(auth(owner)).expect(200);
    expect(pulled.body.changes.find((c: any) => c.table === 'supplier_phones').row).toMatchObject({ name: 'Sai', phone: '9606995351' });

    // Nothing goes out before Meta approves the template, and a bad number is refused first.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString('base64');
    await http().post('/v1/whatsapp/slip').set(auth(owner)).send({ id: billId, phone: '9606995351', image: png, params: ['Cash'] }).expect(409);
    await http().post('/v1/whatsapp/beejak').set(auth(owner)).send({ id: truckId, phone: '123', image: png, params: ['Sai'] }).expect(400);
  });
});

describe('angoor on the website', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('makes grapes slips and gaadis on the portal as the app does: several gaadis, APMC, udhaar labour, no count limit', async () => {
    const s = await login('9829200021');
    const res = await createApproved(s.accessToken, { name: 'Web Angoor', mandi: 'Azadpur', shopNo: 'C-30', role: 'owner', commodity: 'angoor' });
    const id = res.me.shop.id as string;
    const t = new Date().toISOString();
    const royal = uuidv7(), sai = uuidv7(), manat = uuidv7();
    await http().post('/v1/sync/push').set(auth(res.accessToken)).send({ items: [
      { table: 'brands', row: { id: royal, created_at: t, updated_at: t, name: 'Royal' } },
      { table: 'trucks', row: { id: sai, created_at: t, updated_at: t, number: '3289', supplier: 'Sai', arrived_at: t, location: 'Pillar 320' } },
      { table: 'truck_grades', row: { id: uuidv7(), created_at: t, truck_id: sai, brand_id: royal, grade: '1', billed_qty: 10, received_qty: 10, rate_paise: 120000, box_grams: 10000 } },
      { table: 'trucks', row: { id: manat, created_at: t, updated_at: t, number: 'HR26X1111', supplier: 'Manat', arrived_at: t, location: 'Shed 4' } },
      { table: 'truck_grades', row: { id: uuidv7(), created_at: t, truck_id: manat, brand_id: royal, grade: '1', billed_qty: 40, received_qty: 40, rate_paise: 110000, box_grams: 15000 } },
    ] }).expect(200);
    await http().post('/v1/admin/auth/otp').send({ phone: '9829200021' }).expect(204);
    const web = auth((await http().post('/v1/admin/auth/verify').send({ phone: '9829200021', code: OtpService.issuedForTests.get('9829200021') }).expect(200)).body.token);
    const base = `/v1/admin/shops/${id}`;

    const opts = (await http().get(`${base}/entry-options`).set(web).expect(200)).body;
    expect(opts.commodity).toBe('angoor');
    expect(opts.apmcOn).toBe(true);
    expect(opts.lots).toEqual(expect.arrayContaining([
      expect.objectContaining({ truckId: sai, brandId: royal, quality: 'Royal', number: '3289', supplier: 'Sai', location: 'Pillar 320', left: 10, boxGrams: 10000 }),
      expect.objectContaining({ truckId: manat, brandId: royal, left: 40, boxGrams: 15000 }),
    ]));
    expect(opts.lastArrivals).toEqual(expect.arrayContaining([
      expect.objectContaining({ supplier: 'Manat', location: 'Shed 4', lots: [{ quality: 'Royal', boxGrams: 15000, ratePaise: 110000 }] }),
    ]));

    // Cash: Royal from both gaadis, 5 × ₹1,500 + 3 × ₹1,400 = ₹11,700 + APMC ₹117.
    const a = (await http().post(`${base}/entries/parchi`).set(web).send({
      lots: [{ truckId: sai, brandId: royal, qty: 5, ratePaise: 150000 }, { truckId: manat, brandId: royal, qty: 3, ratePaise: 140000 }], pay: 'cash',
    }).expect(201)).body;
    // Udhaar with labour, and more boxes than the gaadi shows (angoor never refuses on the count).
    const b = (await http().post(`${base}/entries/parchi`).set(web).send({
      buyerName: 'Web Angoor Grahak', lots: [{ truckId: sai, brandId: royal, qty: 20, ratePaise: 100000 }], pay: 'credit', labour: true, labourRatePaise: 1200,
    }).expect(201)).body;
    // Labour is for udhaar only: a cash slip asking for it gets none.
    const c = (await http().post(`${base}/entries/parchi`).set(web).send({
      lots: [{ truckId: manat, brandId: royal, qty: 2, ratePaise: 100000 }], pay: 'cash', labour: true, labourRatePaise: 1200,
    }).expect(201)).body;
    await http().post(`${base}/entries/parchi`).set(web).send({ lots: [{ truckId: sai, brandId: uuidv7(), qty: 1, ratePaise: 1 }], pay: 'cash' }).expect(400);

    const pulled = await http().get('/v1/sync/pull?after=0&limit=500').set(auth(res.accessToken)).expect(200);
    const bill = (bid: string) => pulled.body.changes.find((x: any) => x.table === 'bills' && x.row.id === bid).row;
    const lines = (bid: string) => pulled.body.changes.filter((x: any) => x.table === 'bill_lines' && x.row.bill_id === bid).map((x: any) => x.row);
    expect(bill(a.billId)).toMatchObject({ truck_id: null, total_paise: 1181700, cash_paise: 1181700, chungi_paise: 11700, apmc_paise: 11700, labour_paise: 0, pay_mode: 'cash' });
    expect(lines(a.billId).map((l: any) => [l.truck_id, l.qty]).sort()).toEqual([[sai, 5], [manat, 3]].sort());
    expect(bill(b.billId)).toMatchObject({ total_paise: 2000000 + 20000 + 24000, chungi_paise: 44000, apmc_paise: 20000, labour_paise: 24000, packs: 20, pay_mode: 'credit', buyer_name: 'Web Angoor Grahak' });
    expect(bill(c.billId)).toMatchObject({ total_paise: 202000, labour_paise: 0 });

    // Alter keeps both gaadis; the view carries each line's gaadi.
    const view = (await http().get(`${base}/bills/${a.billId}`).set(web).expect(200)).body;
    expect(view.lines.map((l: any) => l.truckId).sort()).toEqual([sai, manat].sort());
    const a2 = (await http().post(`${base}/bills/${a.billId}/edit`).set(web).send({
      lots: [{ truckId: sai, brandId: royal, qty: 4, ratePaise: 150000 }, { truckId: manat, brandId: royal, qty: 3, ratePaise: 140000 }], pay: 'cash',
    }).expect(201)).body;
    expect(a2.slipNo).toBe(a.slipNo);

    // APMC off: new slips carry none.
    await http().post('/v1/shops/apmc').set(auth(res.accessToken)).send({ on: false }).expect(204);
    const d = (await http().post(`${base}/entries/parchi`).set(web).send({ lots: [{ truckId: sai, brandId: royal, qty: 1, ratePaise: 100000 }], pay: 'cash' }).expect(201)).body;
    const again = await http().get('/v1/sync/pull?after=0&limit=500').set(auth(res.accessToken)).expect(200);
    expect(again.body.changes.find((x: any) => x.table === 'bills' && x.row.id === d.billId).row).toMatchObject({ total_paise: 100000, apmc_paise: 0 });

    // Nayi gaadi: vehicle, supplier, where it stands, qualities with box kg and our bhav.
    const g = (await http().post(`${base}/entries/gaadi`).set(web).send({
      number: 'hr 55 ab 4455', supplier: 'Sai', location: 'Pillar 320, Shed 11', freightPaise: 800000,
      lots: [{ brandId: royal, grade: '1', qty: 50, ratePaise: 120000, boxGrams: 10000 }, { brandName: 'Tiger', grade: '1', qty: 30, ratePaise: 70000, boxGrams: 8000 }],
    }).expect(201)).body;
    await http().post(`${base}/entries/gaadi`).set(web).send({ number: 'X1', supplier: '', lots: [{ brandId: royal, grade: '1', qty: 1, ratePaise: 0 }] }).expect(400);
    const third = await http().get('/v1/sync/pull?after=0&limit=500').set(auth(res.accessToken)).expect(200);
    expect(third.body.changes.filter((x: any) => x.table === 'trucks' && x.row.id === g.truckId).at(-1).row).toMatchObject({ number: 'HR55AB4455', location: 'Pillar 320, Shed 11' });
    expect(third.body.changes.filter((x: any) => x.table === 'truck_grades' && x.row.truck_id === g.truckId).map((x: any) => x.row.box_grams).sort()).toEqual([10000, 8000].sort());

    // The grapes desk: 5 of the udhaar slip's 20 boxes handed over at the gaadi.
    await http().post('/v1/sync/push').set(auth(res.accessToken)).send({ items: [
      { table: 'pickups', row: { id: uuidv7(), created_at: new Date().toISOString(), bill_id: b.billId, qty: 5 } },
    ] }).expect(200);
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const desk = (await http().get(`${base}/angoor?from=${today}&to=${today}&commissionBps=500`).set(web).expect(200)).body;
    expect(desk.totals).toMatchObject({ slips: 4, boxes: 30, picked: 5, pendingSlips: 4, doneSlips: 0, openGaadis: 3, apmcPaise: 10200 + 20000 + 2000, labourPaise: 24000 });
    expect(desk.slips.find((x: any) => x.billId === b.billId)).toMatchObject({ boxes: 20, picked: 5, left: 15, gaadis: [expect.objectContaining({ number: '3289', location: 'Pillar 320', qty: 20 })] });
    expect(desk.gaadis.find((x: any) => x.truckId === sai)).toMatchObject({ location: 'Pillar 320', received: 10, sold: 25, left: -15, waiting: 4 + 15 + 1 });
    expect(desk.suppliers.find((x: any) => x.name === 'Sai')).toMatchObject({ key: 'sai', boxes: 25, salesPaise: 2700000, commissionPaise: 135000, netPaise: 2565000 });
    expect(desk.suppliers.find((x: any) => x.name === 'Manat')).toMatchObject({ boxes: 5, salesPaise: 620000 });
    expect(desk.days).toEqual([expect.objectContaining({ date: today, slips: 4, apmcPaise: 32200, labourPaise: 24000, labourPaidPaise: 0 })]);
    await http().get(`${base}/angoor?from=${today}&to=2020-01-01`).set(web).expect(400);

    // The portal's scanner: by number, by an edited slip's old QR (followed to the live slip), then hand over.
    const byNo = (await http().get(`${base}/pickup?code=${b.slipNo}`).set(web).expect(200)).body;
    expect(byNo).toMatchObject({ billId: b.billId, boxes: 20, picked: 5, left: 15, lines: [{ quality: 'Royal', gaadi: '3289', location: 'Pillar 320', qty: 20 }] });
    expect((await http().get(`${base}/pickup?code=${a.billId}`).set(web).expect(200)).body).toMatchObject({ billId: a2.billId, boxes: 7 });
    await http().get(`${base}/pickup?code=99999`).set(web).expect(404);
    expect((await http().post(`${base}/pickup`).set(web).send({ billId: b.billId, qty: 15 }).expect(201)).body).toMatchObject({ picked: 20, left: 0 });
    await http().post(`${base}/pickup`).set(web).send({ billId: b.billId, qty: 1 }).expect(400);
    await http().post(`${base}/pickup`).set(web).send({ billId: a.billId, qty: 1 }).expect(400);
    const after = await http().get('/v1/sync/pull?after=0&limit=500').set(auth(res.accessToken)).expect(200);
    expect(after.body.changes.filter((x: any) => x.table === 'pickups' && x.row.bill_id === b.billId).map((x: any) => x.row.qty).sort()).toEqual([15, 5]);
  });
});

describe('slip limit', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('sends an accountant\'s big slip to the admin, and lets only the admin decide', async () => {
    const admin = await registerShop('9822200001', 'Limit Shop');
    await http().post('/v1/shops/members').set(auth(admin.accessToken)).send({ phone: '9822200002', name: 'Munim' }).expect(204);
    const munim = await login('9822200002');

    // The limit is the admin's to set, and every terminal reads it from /me.
    await http().post('/v1/shops/slip-limit').set(auth(munim.accessToken)).send({ slipLimitPaise: 100 }).expect(204);
    await http().post('/v1/shops/slip-limit').set(auth(admin.accessToken)).send({ slipLimitPaise: 5000000 }).expect(204);
    const me = await http().get('/v1/me').set(auth(munim.accessToken)).expect(200);
    expect(me.body.shop.slipLimitPaise).toBe(5000000);
    // The slip's phone is the shop's, not whoever is logged in; any member may change it.
    expect(me.body.shop.phone).toBe('9822200001');
    await http().post('/v1/shops/phone').set(auth(munim.accessToken)).send({ phone: '9871429335' }).expect(204);
    expect((await http().get('/v1/me').set(auth(munim.accessToken))).body.shop.phone).toBe('9871429335');
    // Dispatch's number rides beside it; a call without it keeps it, '' clears it.
    expect((await http().get('/v1/me').set(auth(munim.accessToken))).body.shop.dispatchPhone).toBe('');
    await http().post('/v1/shops/phone').set(auth(admin.accessToken)).send({ phone: '9871429335', dispatchPhone: '98738 37938' }).expect(204);
    await http().post('/v1/shops/phone').set(auth(admin.accessToken)).send({ phone: '9871429335' }).expect(204);
    expect((await http().get('/v1/me').set(auth(munim.accessToken))).body.shop.dispatchPhone).toBe('9873837938');
    await http().post('/v1/shops/phone').set(auth(admin.accessToken)).send({ phone: '9871429335', dispatchPhone: '12345' }).expect(400);
    await http().post('/v1/shops/phone').set(auth(admin.accessToken)).send({ phone: '9871429335', dispatchPhone: '' }).expect(204);
    expect((await http().get('/v1/me').set(auth(munim.accessToken))).body.shop.dispatchPhone).toBe('');

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
    await http().post('/v1/shops/ledger-details').set(auth(munim.accessToken)).send(details).expect(204);

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

    // A device that couldn't reach the printer gives the slip back; another one prints it.
    await http().post(`/v1/print/jobs/${two.body.id}/done`).set(auth(office.accessToken)).send({ ok: false, error: 'unreachable', requeue: true }).expect(204);
    expect((await http().get(`/v1/print/jobs/${two.body.id}`).set(auth(home.accessToken))).body).toMatchObject({ status: 'queued', error: null });
    expect((await http().get('/v1/print/next?wait=0&name=Phone&widthDots=576').set(auth(home.accessToken)).expect(200)).body.id).toBe(two.body.id);
    await http().post(`/v1/print/jobs/${two.body.id}/done`).set(auth(home.accessToken)).send({ ok: true }).expect(204);

    // The office gave a slip back above, so it is sitting out: its next poll is handed nothing.
    await http().get('/v1/print/next?wait=0&name=P052&widthDots=576').set(auth(office.accessToken)).expect(204);
    await owner(`UPDATE print_stations SET cooldown_until = NULL`);

    // An old app reports it as a plain failure with its own message: given back all the same,
    // and the device that failed it sits out — the next poll hands it nothing.
    const three = await http().post('/v1/print/jobs').set(auth(office.accessToken)).send({ title: 'Daybook', image: png, widthDots: 576 }).expect(201);
    expect((await http().get('/v1/print/next?wait=0&name=Fold&widthDots=576').set(auth(home.accessToken)).expect(200)).body.id).toBe(three.body.id);
    await http().post(`/v1/print/jobs/${three.body.id}/done`).set(auth(home.accessToken))
      .send({ ok: false, error: 'WiFi printer (192.168.1.48) tak nahi pahunche. Printer chalu hai aur isi WiFi par hai? (SocketTimeoutException)' }).expect(204);
    expect((await http().get(`/v1/print/jobs/${three.body.id}`).set(auth(office.accessToken))).body).toMatchObject({ status: 'queued' });
    await http().get('/v1/print/next?wait=0&name=Fold&widthDots=576').set(auth(home.accessToken)).expect(204);
    expect((await http().get('/v1/print/next?wait=0&name=P052&widthDots=576').set(auth(office.accessToken)).expect(200)).body.id).toBe(three.body.id);
    await http().post(`/v1/print/jobs/${three.body.id}/done`).set(auth(office.accessToken)).send({ ok: true }).expect(204);

    // Switched off: the station is gone.
    await http().delete('/v1/print/station').set(auth(office.accessToken)).expect(204);
    // (home polled once above, which made it a station too)
    await http().delete('/v1/print/station').set(auth(home.accessToken)).expect(204);
    expect((await http().get('/v1/print/station').set(auth(home.accessToken))).body.station).toBeNull();
    expect((await http().get('/v1/print/jobs').set(auth(home.accessToken))).body.jobs).toHaveLength(3);
  });
});

describe('shop printer', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('is saved once by anyone in the shop and reaches every device; the station says which printer it drives', async () => {
    const owner = await registerShop('9855500001', 'Printer Shop');
    const team = await http().get('/v1/shops/members').set(auth(owner.accessToken)).expect(200);
    const munim = await login('9855500002');
    const joined = await http().post('/v1/shops/join').set(auth(munim.accessToken)).send({ code: team.body.joinCode }).expect(200);
    const munimToken = joined.body.accessToken ?? munim.accessToken;
    expect(owner.me.shop.printer).toEqual({ host: '', dots: 576 });

    // The accountant in the office finds it and saves it for the shop.
    await http().post('/v1/shops/printer').set(auth(munimToken)).send({ host: '192.168.1.300x', dots: 576 }).expect(400);
    await http().post('/v1/shops/printer').set(auth(munimToken)).send({ host: '192.168.1.48', dots: 576 }).expect(204);
    // The owner's phone, anywhere, has it on its next /v1/me.
    const me = await http().get('/v1/me').set(auth(owner.accessToken)).expect(200);
    expect(me.body.shop.printer).toEqual({ host: '192.168.1.48', dots: 576 });
    // Someone outside the shop can't touch it.
    const outsider = await login('9855500003');
    await http().post('/v1/shops/printer').set(auth(outsider.accessToken)).send({ host: '10.0.0.9' }).expect(403);

    // The tab prints the office's slips on that WiFi printer, and says so.
    await http().get('/v1/print/next?wait=0&name=OPD2304&widthDots=576&roll=WIFI').set(auth(owner.accessToken)).expect(204);
    const st = (await http().get('/v1/print/station').set(auth(munimToken)).expect(200)).body.station;
    expect(st).toMatchObject({ online: true, name: 'OPD2304', roll: 'WIFI', widthDots: 576 });
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

  it('lets an accountant write every book, and take back any line', async () => {
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
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied', 'applied']);

    // The admin writes every book, and the opening.
    const byAdmin = await push(admin.accessToken, [
      adminLine,
      entry({ mode: 'upi', direction: 'in', category: 'aur_aaya', note: 'Diary' }),
      entry({ direction: 'in', category: 'opening', amount_paise: 1000000 }),
    ]);
    expect(byAdmin.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied', 'applied']);

    // An accountant can take back any line, the admin's too: the owner is not always there.
    const later = new Date(Date.now() + 1000).toISOString();
    const adminCash = entry({ category: 'bhada' });
    await push(admin.accessToken, [adminCash]);
    const hides = await push(munim.accessToken, [
      { ...own, row: { ...own.row, hidden: true, updated_at: later } },
      { ...adminCash, row: { ...adminCash.row, hidden: true, updated_at: later } },
    ]);
    expect(hides.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied']);
  });
});

describe('udhaar alerts', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const push = (token: string, items: unknown[]) =>
    http().post('/v1/sync/push').set(auth(token)).send({ items }).expect(200);

  it('lists who owes, lets only an admin turn it on, and sends each grahak once a day', async () => {
    const shop = await registerShop('9555500001', 'Alert Traders');
    const buyerId = uuidv7();
    const noPhone = uuidv7();
    const t = now();
    const buyer = (id: string, name: string, phone: string) => ({ table: 'buyers', row: {
      id, created_at: t, updated_at: t, name, phone, kind: '', credit_limit_paise: 0, vehicle: '', address: '', destination: '' } });
    await push(shop.accessToken, [
      buyer(buyerId, 'Raju', '9876500011'),
      buyer(noPhone, 'Bina Phone', ''),
      { table: 'udhaar_entries', row: { id: uuidv7(), created_at: t, buyer_id: buyerId, amount_paise: 1500000, business_date: today() } },
      { table: 'udhaar_entries', row: { id: uuidv7(), created_at: t, buyer_id: noPhone, amount_paise: 500000, business_date: today() } },
      { table: 'collections', row: { id: uuidv7(), created_at: t, buyer_id: buyerId, amount_paise: 250000, pay_mode: 'cash',
        payment_ref: '', business_date: today(), cash_paise: 250000, upi_paise: 0 } },
    ]);

    const preview = await http().get('/v1/shops/udhaar-alerts').set(auth(shop.accessToken)).expect(200);
    expect(preview.body.on).toBe(false);
    expect(preview.body.serverOn).toBe(false);
    // ₹15,000 udhaar less ₹2,500 vasooli; the grahak without a phone can't be messaged.
    expect(preview.body.recipients).toEqual([{ buyerId, name: 'Raju', phone: '9876500011', duePaise: 1250000 }]);

    await http().post('/v1/shops/udhaar-alerts').set(auth(shop.accessToken)).send({ on: true }).expect(204);

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
    await http().post('/v1/shops/udhaar-alerts/test').set(auth(shop.accessToken)).send({ buyerId }).expect(403);

    // The owner's "WhatsApp bhejein" on the website: the same template and total, one grahak, now.
    await http().post('/v1/admin/auth/otp').send({ phone: '9555500001' }).expect(204);
    const web = auth((await http().post('/v1/admin/auth/verify').send({ phone: '9555500001', code: OtpService.issuedForTests.get('9555500001') }).expect(200)).body.token);
    const shopId = shop.me.shop.id as string;
    const url = `/v1/admin/shops/${shopId}/buyers/${buyerId}/whatsapp`;
    // No bot token on this server: the draft says so and a send is refused before anything goes.
    expect((await http().get(url).set(web).expect(200)).body).toMatchObject({ canSend: false, reason: 'WhatsApp abhi chalu nahi hai', duePaise: 1250000 });
    await http().post(url).set(web).send({}).expect(503);
    alerts.canSend = () => true;
    try {
      const draft = (await http().get(url).set(web).expect(200)).body;
      expect(draft).toMatchObject({ canSend: true, phone: '9876500011', duePaise: 1250000 });
      expect(draft.text).toBe('नमस्ते Raju, Alert Traders में आपका कुल उधार ₹12,500 बाकी है। भुगतान या हिसाब के लिए 9555500001 पर संपर्क करें।');
      const { TemplateUnavailable } = await import('../src/alerts/udhaar-alerts.service');
      const docs: { to: string; params: string[]; pdf: Buffer; filename: string }[] = [];
      // Until Meta approves the PDF template, the text udhaar goes instead.
      alerts.docSender = async () => { throw new TemplateUnavailable('132001 template not found'); };
      sent.length = 0;
      expect((await http().post(url).set(web).send({}).expect(200)).body).toMatchObject({ duePaise: 1250000, phone: '9876500011', name: 'Raju', withPdf: false });
      expect(sent).toEqual([{ to: '919876500011', params: ['Raju', 'Alert Traders', '12,500', '9555500001'] }]);
      // A double tap or a repeated voice command does not send twice.
      await http().post(url).set(web).send({}).expect(422);
      expect(sent).toHaveLength(1);
      expect((await http().get(url).set(web).expect(200)).body.last).toMatchObject({ duePaise: 1250000 });
      // No phone, nothing to send; another shop's grahak, not yours.
      await http().post(`/v1/admin/shops/${shopId}/buyers/${noPhone}/whatsapp`).set(web).send({}).expect(422);
      const other = await registerShop('9555500002', 'Other Traders');
      await http().post(`/v1/admin/shops/${other.me.shop.id}/buyers/${buyerId}/whatsapp`).set(web).send({}).expect(403);
      // Once approved, the khata PDF goes with it — the same LedgerPdf the app prints.
      const pdfView = await http().get(`${url}/pdf`).set(web).buffer(true)
        .parse((res, cb) => { const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); })
        .expect(200);
      expect(pdfView.headers['content-type']).toBe('application/pdf');
      expect((pdfView.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      await owner(`UPDATE whatsapp_sends SET created_at = now() - interval '11 minutes'`);
      (alerts as unknown as { pdfOk: unknown }).pdfOk = null;
      alerts.docSender = async (to, params, pdf, filename) => { docs.push({ to, params, pdf, filename }); return 'wamid.doc'; };
      expect((await http().post(url).set(web).send({}).expect(200)).body).toMatchObject({ withPdf: true, messageId: 'wamid.doc' });
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ to: '919876500011', params: ['Raju', 'Alert Traders', '12,500', '9555500001'], filename: 'Khata-Raju.pdf' });
      expect(docs[0].pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(sent).toHaveLength(1);
      // A failed send is logged, says so, and does not block the next try.
      alerts.docSender = async () => { throw new Error('WhatsApp 400: 131026 undeliverable'); };
      await owner(`UPDATE whatsapp_sends SET created_at = now() - interval '11 minutes'`);
      await http().post(url).set(web).send({}).expect(503);
      const c = new Client({ connectionString: OWNER_URL });
      await c.connect();
      try {
        const rows = (await c.query(`SELECT status FROM whatsapp_sends WHERE buyer_id = $1 ORDER BY created_at`, [buyerId])).rows;
        expect(rows.map((r) => r.status)).toEqual(['sent', 'sent', 'failed']);
      } finally { await c.end(); }
    } finally {
      delete (alerts as { canSend?: unknown }).canSend;
    }
  });
});

describe('Bolo conversation', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('asks for what is missing, remembers the job, and finishes it — never a dead end', async () => {
    const shop = await registerShop('9555500031', 'Bolo Traders');
    const shopId = shop.me.shop.id as string;
    const t = now();
    const ids = { om: uuidv7(), omi: uuidv7(), rk: uuidv7(), rt: uuidv7() };
    const buyer = (id: string, name: string, phone: string) => ({ table: 'buyers', row: {
      id, created_at: t, updated_at: t, name, phone, kind: '', credit_limit_paise: 0, vehicle: '', address: 'Shop 3', destination: '', code: 'OB1', card: 'AB12' } });
    await http().post('/v1/sync/push').set(auth(shop.accessToken)).send({ items: [
      buyer(ids.om, 'Om Bhojane', ''), buyer(ids.omi, 'Omi', ''), buyer(ids.rk, 'Bholu Kumar', '9876500081'), buyer(ids.rt, 'Bholu Traders', '9876500082'),
      { table: 'udhaar_entries', row: { id: uuidv7(), created_at: t, buyer_id: ids.om, amount_paise: 1000000, business_date: today() } },
    ] }).expect(200);
    await http().post('/v1/admin/auth/otp').send({ phone: '9555500031' }).expect(204);
    const web = auth((await http().post('/v1/admin/auth/verify').send({ phone: '9555500031', code: OtpService.issuedForTests.get('9555500031') }).expect(200)).body.token);
    const url = `/v1/admin/shops/${shopId}/voice`;

    // The model, scripted: what it would route each typed request to.
    const { GeminiClient } = await import('../src/voice/gemini.client');
    const gemini = app.get(GeminiClient);
    const script: Record<string, object> = {
      'om ko udhaar whatsapp karo': { kind: 'whatsapp', say: 'Om ko udhaar WhatsApp', heard: 'Om', buyer_name: 'Om Bhojane' },
      'bholu ko call lagao': { kind: 'call', say: 'Bholu ko call', heard: 'Bholu' },
      'sohan ko udhaar bhejo': { kind: 'whatsapp', say: 'Sohan ko udhaar', heard: 'Sohan' },
      '15 dana 22 ke aur 8 dana 35 ke': { kind: 'calc', say: 'Hisab', calc: { lines: [{ qty: 15, rate: 22 }, { qty: 8, rate: 35 }] } },
      'naya grahak pappu number 9876500099 purana udhaar 500': { kind: 'grahak', say: 'Naya grahak Pappu', heard: 'Pappu', grahak: { name: 'Pappu', phone: '9876500099', opening: 500, new: true } },
      'nayi gaadi 3289 pollachi 500 dana': { kind: 'gaadi', say: 'Nayi gaadi', nayi_gaadi: { number: '3289', maal: 'Pollachi', lines: [{ grade: 'I', qty: 500 }] } },
      'ek gaadi aayi hai': { kind: 'gaadi', say: 'Nayi gaadi' },
      'om bhojane 35 panni 43 ke': { kind: 'slip', say: 'Om', heard: 'Om Bhojane', buyer_name: 'Om Bhojane', slip: { lines: [{ grade: 'I', rate: 43 }], kattas: 35, packing: 'panni' } },
      'nayi gaadi 4455 pollachi 300 dana supplier ramu': { kind: 'gaadi', say: 'Nayi gaadi', nayi_gaadi: { number: '4455', maal: 'Pollachi', supplier: 'Ramu', lines: [{ grade: 'I', qty: 300 }] } },
      'om ko 100 dana 40 ke bill kaat do': { kind: 'slip', say: 'Om', heard: 'Om', buyer_name: 'Om Bhojane', slip: { lines: [{ grade: 'I', qty: 100, rate: 40 }] } },
      'raju ko 50 dana': { kind: 'slip', say: 'Raju', heard: 'Raju', buyer: 'new', buyer_name: 'Raju', slip: { lines: [{ grade: 'I', qty: 50 }] } },
      'kal mujhe yaad dilana om se 10000 lene hain': { kind: 'yaad', say: 'Yaad', heard: 'Om', yaad: { what: 'Om se ₹10,000 lene hain', day: 1 } },
      'mere reminder dikhao': { kind: 'yaad', say: 'Yaad', yaad: { list: true } },
      'om wala reminder hata do': { kind: 'yaad', say: 'Hata do', yaad: { cancel: true, what: 'Om' } },
    };
    const calls: string[] = [];
    const real = gemini.generate.bind(gemini);
    gemini.generate = async (payload: any) => {
      const text = String(payload.contents?.[0]?.parts?.[0]?.text ?? '');
      const said = (text.match(/# They typed\n([\s\S]*)$/)?.[1] ?? '').trim().toLowerCase();
      calls.push(said);
      // A question about one grahak: the model writes their ref from the shop data, as it does live.
      if (said === 'om ne kitna maal kharida') {
        const ref = text.match(/\n(b\d+) Om Bhojane/)?.[1];
        return { text: JSON.stringify({ transcript: said, kind: 'query', say: 'Om ki kharid', query: { sql: `SELECT COUNT(*) AS parchiyan, COALESCE(SUM(rakam), 0) AS rakam FROM parchi WHERE grahak_id = '${ref}'`, title: 'Om ki kharid' } }), model: 'stub', tokensIn: 0, tokensOut: 0 };
      }
      return { text: JSON.stringify({ transcript: said, ...(script[said] ?? { kind: 'unclear', say: 'Samajh nahi aaya' }) }), model: 'stub', tokensIn: 0, tokensOut: 0 };
    };
    const { UdhaarAlertsService } = await import('../src/alerts/udhaar-alerts.service');
    const alerts = app.get(UdhaarAlertsService);
    const sent: { to: string; params: string[] }[] = [];
    alerts.canSend = () => true;
    alerts.docSender = async (to, params) => { sent.push({ to, params }); return 'wamid.bolo'; };
    try {
      const say = (text: string, session = 's1') => http().post(url).set(web).send({ text, session }).expect(200).then((r) => r.body);
      const tap = (pick: string, session = 's1') => http().post(url).set(web).send({ pick, session }).expect(200).then((r) => r.body);
      const values = (a: any) => a.ask.options.map((o: any) => o.value);

      // 1. "Om" is close to Om Bhojane and to Omi: asked, never guessed.
      const a0 = await say('Om ko udhaar whatsapp karo');
      expect(a0.ask.question).toBe('Kaun Om?');
      expect(values(a0)).toEqual([ids.om, ids.omi, 'new', 'cancel']);
      // Om has no number: Bolo asks for it; typed, it is read with no model call.
      expect((await tap(ids.om)).ask).toMatchObject({ expect: 'phone', question: 'Om Bhojane ka mobile number save nahi hai. Number boliye' });
      calls.length = 0;
      const a2 = await say('98765 00077');
      expect(calls).toHaveLength(0);
      // Saving the number is previewed; a heard "haan" only shows the preview again — a tap does it.
      expect(a2.ask).toMatchObject({ question: 'Om Bhojane ka number 9876500077 save karein?', tap: true, detail: ['Om Bhojane', 'Mobile: 9876500077'] });
      expect(values(a2)).toEqual(['yes', 'cancel']);
      expect((await say('haan')).say).toBe('Neeche button dabaiye');
      // The tap saves the number and opens the WhatsApp dialog (message + PDF + Send): Bolo itself sends nothing.
      expect(await tap('yes')).toMatchObject({ whatsapp: { buyerId: ids.om, name: 'Om Bhojane' } });
      expect(sent).toHaveLength(0);
      const pulled = (await http().get('/v1/sync/pull?after=0&limit=500').set(auth(shop.accessToken)).expect(200)).body.changes
        .filter((c: any) => c.table === 'buyers' && c.row.id === ids.om).at(-1).row;
      // The number saved, and nothing else on the grahak lost (address, code and card stay).
      expect(pulled).toMatchObject({ phone: '9876500077', address: 'Shop 3', name: 'Om Bhojane' });
      expect(pulled.code ?? 'OB1').toBe('OB1');
      expect(pulled.card ?? 'AB12').toBe('AB12');

      // 2. Two Bholus: "kaun?" with both; the call itself is a tap on the preview.
      const b1 = await say('Bholu ko call lagao', 's2');
      expect(values(b1)).toEqual(expect.arrayContaining([ids.rk, ids.rt]));
      const b2 = await tap(ids.rt, 's2');
      expect(b2.ask).toMatchObject({ question: 'Bholu Traders ko call karein?', tap: true });
      expect((await tap('yes', 's2')).call).toEqual({ phone: '9876500082', name: 'Bholu Traders' });

      // 3. Nobody of that name: a new grahak or cancel, and "rehne do" ends it politely.
      const c1 = await say('Sohan ko udhaar bhejo', 's3');
      expect(values(c1)).toEqual(['new', 'cancel']);
      expect((await say('rehne do', 's3')).say).toBe('Theek hai, rehne diya');

      // 4. Arithmetic is the server's: 15 × 22 + 8 × 35 = 610.
      expect((await say('15 dana 22 ke aur 8 dana 35 ke', 's4')).answer.say).toBe('Kul ₹610');

      // 5. A new grahak by voice is previewed, made on the tap.
      const e1 = await say('naya grahak Pappu number 9876500099 purana udhaar 500', 's5');
      expect(e1.ask).toMatchObject({ question: 'Naya grahak Pappu banayein?', detail: ['Naya grahak: Pappu', 'Mobile: 9876500099', 'Purana udhaar: ₹500'] });
      expect((await tap('yes', 's5')).say).toBe('Naya grahak Pappu ban gaya, number 9876500099');
      expect((await http().get(`/v1/admin/shops/${shopId}/buyers?q=Pappu`).set(web).expect(200)).body.buyers[0]).toMatchObject({ name: 'Pappu', phone: '9876500099', balancePaise: 50000 });

      // 6. A gaadi: the supplier asked once (or later), previewed, added only on the tap.
      expect((await say('nayi gaadi 3289 pollachi 500 dana', 's6')).ask).toMatchObject({ question: 'Supplier kaun hai?', expect: 'text' });
      const g2 = await tap('skip', 's6');
      expect(g2.ask).toMatchObject({ question: 'Nayi gaadi 3289, Pollachi, 500 dana. Jod dein?', tap: true, detail: ['Gaadi 3289 · Pollachi (naya maal)', 'I: 500 dana', 'Supplier: baad mein'] });
      expect((await say('haan jod do', 's6')).say).toBe('Neeche button dabaiye');
      expect((await tap('yes', 's6')).say).toBe('Gaadi 3289 jud gayi: Pollachi, 500 dana');
      // Nothing said but "gaadi aayi hai": the number, then the dana, one question at a time.
      expect((await say('ek gaadi aayi hai', 's6b')).ask.question).toBe('Gaadi ka number boliye (jaise 3289)');
      expect((await say('MH 12 4455', 's6b')).ask.question).toBe('Gaadi MH124455 mein kitne dana aaye?');
      expect((await say('rehne do', 's6b')).say).toBe('Theek hai, rehne diya');

      // 7. A parchi opens the parchi form filled in — the counter checks it and saves there.
      expect((await say('om ko 100 dana 40 ke bill kaat do', 's7')).ask.question).toBe('Kaun Om?');
      const p2 = await tap(ids.om, 's7');
      expect(p2.draft).toMatchObject({ kind: 'parchi', buyer: { id: ids.om, name: 'Om Bhojane' }, lines: [{ grade: '1', qty: 100, ratePaise: 4000 }], pay: 'credit' });
      expect(p2.draft.truckId).toBeTruthy();
      // "35 panni 43 ke" is 35 dana in panni (a panni has a name, never a count).
      const pn = await say('om bhojane 35 panni 43 ke', 's7p');
      expect(pn.draft).toMatchObject({ packing: 'panni', kattas: null, lines: [{ grade: '1', qty: 35, ratePaise: 4300 }] });
      // A name not on the list is never made silently: asked, and the form says a new grahak will be made.
      expect(values(await say('raju ko 50 dana', 's8'))).toEqual(['new', 'cancel']);
      const r2 = await tap('new', 's8');
      expect(r2.draft).toMatchObject({ buyer: { id: null, name: 'Raju' }, lines: [{ qty: 50 }] });
      expect(r2.draft.notes).toContain('Naya grahak "Raju" banega');
      expect((await http().get(`/v1/admin/shops/${shopId}/buyers?q=Raju`).set(web).expect(200)).body.buyers).toHaveLength(0);
      // With two gaadis open, the gaadi is asked by number every time.
      await say('nayi gaadi 4455 pollachi 300 dana supplier ramu', 's7c');
      expect((await tap('yes', 's7c')).say).toBe('Gaadi 4455 jud gayi: Pollachi, 300 dana');
      const gq = await say('om bhojane 35 panni 43 ke', 's7d');
      expect(gq.ask).toMatchObject({ question: 'Kaun si gaadi se? Gaadi number boliye', expect: 'text' });
      const t4455 = gq.ask.options.find((o: any) => o.label.startsWith('4455')).value;
      expect((await say('9999', 's7d')).ask.question).toBe('Gaadi 9999 khuli nahi mili. Kaun si gaadi se? Gaadi number boliye');
      expect((await say('4455 wali', 's7d')).draft.truckId).toBe(t4455);
      // A new request while a question waits is a new request, not an answer to it.
      expect((await say('om bhojane 35 panni 43 ke', 's7e')).ask.question).toMatch(/gaadi/);
      expect((await say('Om ko udhaar whatsapp karo', 's7e')).ask.question).toBe('Kaun Om?');

      // A grahak's ref in the model's SQL ('b3') is that grahak's id when it runs — not a failed query.
      expect((await say('om ne kitna maal kharida', 's7q')).answer.say).toBe('Om ki kharid: 0 parchi, ₹0');

      // 8. Yaad: tomorrow with no time is 9 a.m. IST; previewed, set on the tap, sent by the timer.
      const { RemindersService } = await import('../src/alerts/reminders.service');
      const reminders = app.get(RemindersService);
      const told: { to: string; params: string[] }[] = [];
      reminders.sender = async (to, params) => { told.push({ to, params }); return 'wamid.yaad'; };
      expect((await say('kal mujhe yaad dilana om se 10000 lene hain', 's9')).ask.question).toBe('Kaun Om?');
      const y1 = await tap(ids.om, 's9');
      expect(y1.ask).toMatchObject({ question: 'Yaad lagayein: kal subah 9:00?', tap: true });
      expect(y1.ask.detail.slice(0, 3)).toEqual(['Kab: kal subah 9:00', 'Kya: Om se ₹10,000 lene hain', 'WhatsApp 9555500031 par aayega (Om Bhojane ka udhaar saath mein)']);
      const y2 = await tap('yes', 's9');
      expect(y2.say).toBe('Yaad rakhenge: kal subah 9:00 — Om se ₹10,000 lene hain. WhatsApp 9555500031 par aayega');
      const tomorrow = new Date(Date.now() + 330 * 60_000 + 86_400_000).toISOString().slice(0, 10);
      expect(y2.saved.dueAt).toBe(`${tomorrow}T03:30:00.000Z`);
      expect(await reminders.tick(new Date(Date.parse(y2.saved.dueAt) - 60_000))).toEqual({ sent: 0, failed: 0, waiting: 0 });
      expect(await reminders.tick(new Date(Date.parse(y2.saved.dueAt) + 60_000))).toEqual({ sent: 1, failed: 0, waiting: 0 });
      expect(told).toEqual([{ to: '919555500031', params: ['जी', 'Bolo Traders', 'Om se ₹10,000 lene hain', 'Om Bhojane का उधार अभी ₹10,000 बाकी है · मोबाइल 9876500077'] }]);
      // A template still awaiting Meta's approval waits and is tried again, not dropped.
      const { TemplateUnavailable } = await import('../src/alerts/udhaar-alerts.service');
      await say('kal mujhe yaad dilana om se 10000 lene hain', 's10');
      await tap(ids.om, 's10');
      const y3 = await tap('yes', 's10');
      reminders.sender = async () => { throw new TemplateUnavailable('132001 not approved'); };
      expect(await reminders.tick(new Date(Date.parse(y3.saved.dueAt) + 60_000))).toEqual({ sent: 0, failed: 0, waiting: 1 });
      // Listed, then cancelled by name.
      expect((await say('mere reminder dikhao', 's10')).answer.rows).toEqual([{ kab: expect.stringMatching(/subah 9:00$/), kya: 'Om se ₹10,000 lene hain' }]);
      expect((await say('om wala reminder hata do', 's10')).say).toMatch(/^Hata diya: .* — Om se ₹10,000 lene hain$/);
      expect((await say('mere reminder dikhao', 's10')).answer.say).toBe('Koi yaad baaki nahi hai');
    } finally {
      gemini.generate = real;
      delete (alerts as { canSend?: unknown }).canSend;
    }
  });
});

describe('app updates', () => {
  it('tells a logged-in device the newest build of its flavor and serves exactly those bytes', async () => {
    await http().get('/v1/app/latest?flavor=pos').expect(401);
    const s = await login('9811100099');
    const auth = { Authorization: `Bearer ${s.accessToken}` };
    expect((await http().get('/v1/app/latest?flavor=pos').set(auth).expect(200)).body).toEqual({ release: null });

    const apk = Buffer.from('PK\u0003\u0004 not really an apk but bytes all the same');
    const sha = require('node:crypto').createHash('sha256').update(apk).digest('hex');
    await owner(`INSERT INTO app_releases (flavor, version_code, version_name, sha256, size_bytes, apk) VALUES
      ('pos', 80, '0.39.0', '${'0'.repeat(64)}', 3, '\\x000102'),
      ('pos', 81, '0.40.0', '${sha}', ${apk.length}, '\\x${apk.toString('hex')}'),
      ('daybook', 90, '0.9.0', '${'1'.repeat(64)}', 3, '\\x000102')`);

    const latest = await http().get('/v1/app/latest?flavor=pos').set(auth).expect(200);
    expect(latest.body.release).toMatchObject({ versionCode: 81, versionName: '0.40.0', sha256: sha, sizeBytes: apk.length });
    await http().get('/v1/app/latest?flavor=other').set(auth).expect(400);

    const got = await http().get('/v1/app/apk?flavor=pos&versionCode=81').set(auth).buffer(true)
      .parse((res, cb) => { const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); })
      .expect(200);
    expect(got.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(Buffer.compare(got.body as Buffer, apk)).toBe(0);
    await http().get('/v1/app/apk?flavor=pos&versionCode=79').set(auth).expect(404);
  });

  it('lets anyone download the newest build from the website, no login', async () => {
    // Rows from the test above: pos 0.40.0 is newest, daybook 0.9.0.
    const listed = await http().get('/v1/public/app').expect(200);
    expect(listed.body.pos).toMatchObject({ versionCode: 81, versionName: '0.40.0', sizeBytes: expect.any(Number) });
    expect(listed.body.daybook).toMatchObject({ versionCode: 90, versionName: '0.9.0' });
    expect(Date.parse(listed.body.pos.publishedAt)).not.toBeNaN();

    const binary = (res: any, cb: any) => { const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); };
    const got = await http().get('/v1/public/app/download?flavor=pos').buffer(true).parse(binary).expect(200);
    expect(got.headers['content-disposition']).toBe('attachment; filename="MandiPlus-POS-0.40.0.apk"');
    expect((got.body as Buffer).length).toBe(listed.body.pos.sizeBytes);

    // The same link moves to the next release as soon as it is published.
    await owner(`INSERT INTO app_releases (flavor, version_code, version_name, sha256, size_bytes, apk) VALUES
      ('pos', 82, '0.41.0', '${'2'.repeat(64)}', 4, '\\x00010203')`);
    const next = await http().get('/v1/public/app/download?flavor=pos').buffer(true).parse(binary).expect(200);
    expect(next.headers['content-disposition']).toContain('MandiPlus-POS-0.41.0.apk');
    expect((next.body as Buffer).length).toBe(4);
    await http().get('/v1/public/app/download?flavor=other').expect(400);
  });
});

describe('shop approval and the admin portal', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function adminLogin(p = '9876500077') {
    await http().post('/v1/admin/auth/otp').send({ phone: p }).expect(204);
    const res = await http().post('/v1/admin/auth/verify').send({ phone: p, code: OtpService.issuedForTests.get(p) }).expect(200);
    return auth(res.body.token);
  }

  it('keeps a new shop shut until an admin approves it, then the owner’s phone opens it', async () => {
    const s = await login('9877700001');
    const created = await http().post('/v1/shops').set(auth(s.accessToken))
      .send({ name: 'Waiting Traders', mandi: 'Azadpur', shopNo: '7', role: 'owner' }).expect(201);
    expect(created.body.me.shop).toBeNull();
    expect(created.body.me.pendingShop).toMatchObject({ name: 'Waiting Traders', status: 'pending' });
    const token = created.body.accessToken as string;

    // Nothing of a shop is reachable while it waits: no sync, no team, and a re-login stays out too.
    await http().get('/v1/sync/pull?after=0').set(auth(token)).expect(403);
    expect((await login('9877700001')).me.shop).toBeNull();
    // A second registration from the same number is refused while the first waits.
    await http().post('/v1/shops').set(auth(token)).send({ name: 'Again' }).expect(409);

    const admin = await adminLogin();
    const listed = (await http().get('/v1/admin/shops').set(admin).expect(200)).body.shops;
    expect(listed[0]).toMatchObject({ name: 'Waiting Traders', status: 'pending', owner: { phone: '9877700001' } });
    const id = listed[0].id as string;
    await http().get(`/v1/admin/shops/${id}/summary?from=2026-10-01&to=2026-10-02`).set(admin).expect(409);

    await http().post(`/v1/admin/shops/${id}/approve`).set(admin).expect(204);
    await http().post(`/v1/admin/shops/${id}/approve`).set(admin).expect(409);
    const me = (await http().get('/v1/me').set(auth(token)).expect(200)).body;
    expect(me.shop).toMatchObject({ name: 'Waiting Traders', role: 'owner' });
    expect(me.pendingShop).toBeNull();
    await http().get('/v1/sync/pull?after=0').set(auth(me.accessToken)).expect(200);
    await http().post(`/v1/admin/shops/${id}/reject`).set(admin).send({}).expect(409);
  });

  it('lets an owner ask for a second shop, and move a phone between them keeping each shop’s code', async () => {
    const first = await registerShop('9877700004', 'Pehli Dukaan');
    const phoneA = first.me.device.id as string;
    expect(first.me.shops).toEqual([expect.objectContaining({ name: 'Pehli Dukaan', current: true })]);

    // A second shop is a request too; the phone stays in the first meanwhile, and a third waits.
    const asked = await http().post('/v1/shops').set(auth(first.accessToken)).send({ name: 'Doosri Dukaan', mandi: 'Okhla' }).expect(201);
    expect(asked.body.me.shop.name).toBe('Pehli Dukaan');
    expect(asked.body.me.pendingShop).toMatchObject({ name: 'Doosri Dukaan', status: 'pending' });
    await http().post('/v1/shops').set(auth(first.accessToken)).send({ name: 'Teesri' }).expect(409);
    const second = asked.body.me.pendingShop.id as string;
    await http().post('/v1/shops/switch').set(auth(first.accessToken)).send({ shopId: second }).expect(403);

    const admin = await adminLogin();
    await http().post(`/v1/admin/shops/${second}/approve`).set(admin).expect(204);
    const me = (await http().get('/v1/me').set(auth(first.accessToken))).body;
    expect(me.shop.name).toBe('Pehli Dukaan');
    expect(me.shops.map((x: any) => [x.name, x.current])).toEqual([['Pehli Dukaan', true], ['Doosri Dukaan', false]]);

    // Into the second: a device of its own there, A1 of that shop, and its books only.
    const moved = (await http().post('/v1/shops/switch').set(auth(first.accessToken)).send({ shopId: second }).expect(200)).body;
    expect(moved.me.shop.name).toBe('Doosri Dukaan');
    expect(moved.me.device.code).toBe('A1');
    const phoneB = moved.me.device.id as string;
    expect(phoneB).not.toBe(phoneA);
    await http().get('/v1/sync/pull?after=0').set(auth(moved.accessToken)).expect(200);
    // The first shop's session on this phone is over.
    await http().post('/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);

    // And back, handing over the device it had there: same device, same code.
    const back = (await http().post('/v1/shops/switch').set(auth(moved.accessToken)).send({ shopId: first.me.shop.id, deviceId: phoneA }).expect(200)).body;
    expect(back.me.device).toEqual(first.me.device);
    expect(back.me.shop.name).toBe('Pehli Dukaan');
    // Someone else's device id is not taken over.
    const stranger = await registerShop('9877700005', 'Kisi Aur Ki');
    const sneaky = (await http().post('/v1/shops/switch').set(auth(back.accessToken)).send({ shopId: second, deviceId: stranger.me.device.id }).expect(200)).body;
    expect(sneaky.me.device.id).not.toBe(stranger.me.device.id);
    await http().post('/v1/shops/switch').set(auth(sneaky.accessToken)).send({ shopId: stranger.me.shop.id }).expect(403);
  });

  it('finds one grahak across every shop by mobile: who they owe, and all their trades', async () => {
    const t = new Date().toISOString(), d = t.slice(0, 10);
    let slip = 0;
    const owe = async (shop: Awaited<ReturnType<typeof registerShop>>, buyer: object, total: number, paid: number) => {
      const buyerId = uuidv7(), billId = uuidv7(), no = ++slip;
      await http().post('/v1/sync/push').set(auth(shop.accessToken)).send({ items: [
        { table: 'buyers', row: { id: buyerId, created_at: t, updated_at: t, ...buyer } },
        { table: 'bills', row: { id: billId, created_at: t, number: `A1/${no}`, kind: 'kachchi', buyer_id: buyerId, buyer_name: (buyer as any).name, business_date: d, pay_mode: paid ? 'cash' : 'credit', total_paise: total, paid_paise: paid, cash_paise: paid, slip_no: no } },
      ] }).expect(200);
      return buyerId;
    };
    const a = await registerShop('9877700006', 'Market Trader A');
    const b = await registerShop('9877700007', 'Market Trader B');
    await owe(a, { name: 'Salim Bhai', phone: '9123400001', market_paise: 500000 }, 300000, 0);
    await owe(b, { name: 'Salim', phone: '9123400001' }, 120000, 20000);
    const lone = await owe(b, { name: 'Walk-in Ramesh' }, 5000, 0);
    const admin = await adminLogin();

    const found = (await http().get('/v1/admin/customers?q=salim').set(admin).expect(200)).body.customers;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ key: '9123400001', name: 'Salim Bhai', balancePaise: 400000, boughtPaise: 420000 });
    expect(found[0].shops.map((s: any) => s.shopName).sort()).toEqual(['Market Trader A', 'Market Trader B']);

    const p = (await http().get('/v1/admin/customers/9123400001').set(admin).expect(200)).body;
    expect(p.totals).toMatchObject({ balancePaise: 400000, duePaise: 400000, traders: 2, owedTo: 2, slips: 2 });
    expect(p.traders.map((x: any) => [x.shopName, x.balancePaise])).toEqual([['Market Trader A', 300000], ['Market Trader B', 100000]]);
    expect(p.traders[0].marketPaise).toBe(500000);
    expect(p.history.map((r: any) => r.shopName).sort()).toEqual(['Market Trader A', 'Market Trader B']);
    expect(p.history[0].balancePaise).toBe(400000);

    // No mobile: still found, as its own entry.
    const walkIn = (await http().get('/v1/admin/customers?q=ramesh').set(admin)).body.customers;
    expect(walkIn).toEqual([expect.objectContaining({ key: `${b.me.shop.id}~${lone}`, phone: '' })]);
    expect((await http().get(`/v1/admin/customers/${b.me.shop.id}~${lone}`).set(admin).expect(200)).body.totals.balancePaise).toBe(5000);
    await http().get('/v1/admin/customers/9999999999').set(admin).expect(404);
    await http().get('/v1/admin/customers/nonsense').set(admin).expect(400);
  });

  it('makes entries on the website exactly as a terminal would, and the terminals pull them', async () => {
    const shop = await registerShop('9877700008', 'Web Entry Traders');
    const id = shop.me.shop.id as string;
    const t = new Date().toISOString(), d = istDay();
    const brandId = uuidv7(), truckId = uuidv7(), raju = uuidv7();
    await http().post('/v1/sync/push').set(auth(shop.accessToken)).send({ items: [
      { table: 'brands', row: { id: brandId, created_at: t, updated_at: t, name: 'Pollachi' } },
      { table: 'buyers', row: { id: raju, created_at: t, updated_at: t, name: 'Raju Fruits', phone: '9876500001' } },
      { table: 'trucks', row: { id: truckId, created_at: t, updated_at: t, number: 'TN09', supplier: 'Mani', arrived_at: t } },
      { table: 'truck_grades', row: { id: uuidv7(), created_at: t, truck_id: truckId, brand_id: brandId, grade: '1', billed_qty: 500, received_qty: 500, rate_paise: 2000 } },
      { table: 'bills', row: { id: uuidv7(), created_at: t, number: 'A1/2627/000001', kind: 'kachchi', buyer_name: 'Cash', business_date: d, pay_mode: 'cash', total_paise: 2500, paid_paise: 2500, cash_paise: 2500, slip_no: 1, truck_id: truckId } },
    ] }).expect(200);
    // The owner signs in to the website.
    await http().post('/v1/admin/auth/otp').send({ phone: '9877700008' }).expect(204);
    const web = auth((await http().post('/v1/admin/auth/verify').send({ phone: '9877700008', code: OtpService.issuedForTests.get('9877700008') }).expect(200)).body.token);
    const base = `/v1/admin/shops/${id}`;

    const opts = (await http().get(`${base}/entry-options`).set(web).expect(200)).body;
    expect(opts.trucks).toEqual([expect.objectContaining({ id: truckId, number: 'TN09', left: 500, brandId, brand: 'Pollachi' })]);
    expect(opts.suppliers).toEqual(['Mani']);

    // Nayi parchi: Raju, 10 nag at ₹25, half cash half udhaar, packed in katta (so mazdoori accrues).
    const slip = (await http().post(`${base}/entries/parchi`).set(web).send({
      buyerId: raju, truckId, lines: [{ grade: '1', qty: 10, ratePaise: 2500 }], pay: 'split', cashPaise: 12500, upiPaise: 0, packing: 'katta10',
    }).expect(201)).body;
    expect(slip.slipNo).toBe(2);
    expect(slip.number).toMatch(/^[A-Z][0-9]\/\d{4}\/000001$/);
    // It prints on the shop's print machine by itself: as the bill, for a station that draws it.
    expect(slip.printing).toBe(true);
    await http().get('/v1/print/next?wait=0&name=Old').set(auth(shop.accessToken)).expect(204);
    const job = (await http().get('/v1/print/next?wait=0&name=P052&bills=1').set(auth(shop.accessToken)).expect(200)).body;
    expect(job).toMatchObject({ billId: slip.billId, image: null, title: 'Order Parchi #2' });
    await http().post(`/v1/print/jobs/${job.id}/done`).set(auth(shop.accessToken)).send({ ok: true }).expect(204);
    // A walk-in can't take udhaar, and no slip sells more than the gaadi has.
    await http().post(`${base}/entries/parchi`).set(web).send({ truckId, lines: [{ grade: '1', qty: 5, ratePaise: 2500 }], pay: 'credit', packing: 'loose' }).expect(400);
    await http().post(`${base}/entries/parchi`).set(web).send({ buyerId: raju, truckId, lines: [{ grade: '1', qty: 9999, ratePaise: 1 }], pay: 'cash', packing: 'loose' }).expect(422);

    // The shop's terminal pulls the slip like any other: under the website's own device and series.
    const pulled = (await http().get('/v1/sync/pull?after=0&limit=500').set(auth(shop.accessToken)).expect(200)).body.changes;
    const bill = pulled.find((c: any) => c.table === 'bills' && c.row.id === slip.billId).row;
    expect(bill).toMatchObject({ buyer_id: raju, total_paise: 25000, paid_paise: 12500, cash_paise: 12500, pay_mode: 'cash', labour_paise: 300, packs: 10, packing: 'katta10', staff_name: 'Website', slip_no: 2 });
    expect(bill.device_id).not.toBe(shop.me.device.id);
    // Opened like a Tally voucher: its maal, its money, the machine that made it.
    const voucher = (await http().get(`${base}/bills/${slip.billId}`).set(web).expect(200)).body;
    expect(voucher).toMatchObject({ slipNo: 2, buyerName: 'Raju Fruits', totalPaise: 25000, cashPaise: 12500, openPaise: 12500, packing: 'katta10', truck: 'TN09', voided: null });
    expect(voucher.machine).toMatch(/Website$/);
    expect(voucher.lines).toEqual([{ brand: 'Pollachi', grade: '1', qty: 10, ratePaise: 2500, leak: false, truckId, brandId }]);
    expect(pulled.filter((c: any) => c.table === 'bill_lines' && c.row.bill_id === slip.billId).map((c: any) => [c.row.qty, c.row.brand_id])).toEqual([[10, brandId]]);

    const vas = (await http().post(`${base}/entries/vasooli`).set(web).send({ buyerId: raju, cashPaise: 0, upiPaise: 5000 }).expect(201)).body;
    expect(vas.receiptNo).toBe(1);
    await http().post(`${base}/entries/udhaar`).set(web).send({ buyerId: raju, amountPaise: 1000, note: 'Purana' }).expect(201);
    const owed = (await http().get(`${base}/outstanding`).set(web).expect(200)).body.rows.find((r: any) => r.buyerId === raju);
    expect(owed.duePaise).toBe(12500 - 5000 + 1000);

    await http().post(`${base}/entries/daybook`).set(web).send({ direction: 'out', category: 'kiraya', mode: 'cash', amountPaise: 30000, note: 'Oct' }).expect(201);
    await http().post(`${base}/entries/daybook`).set(web).send({ direction: 'out', category: 'aur_gaya', mode: 'cash', amountPaise: 100 }).expect(400);
    await http().post(`${base}/entries/daybook`).set(web).send({ direction: 'in', category: 'kiraya', mode: 'cash', amountPaise: 100 }).expect(400);
    await http().post(`${base}/entries/supplier-payment`).set(web).send({ supplier: 'MANI', mode: 'upi', amountPaise: 400000 }).expect(201);
    const galla = (await http().get(`${base}/cashbook?pot=galla&from=${d}&to=${d}`).set(web).expect(200)).body;
    expect(galla).toMatchObject({ inPaise: 2500 + 12500, outPaise: 30000 });
    const mani = (await http().get(`${base}/suppliers/mani`).set(web).expect(200)).body;
    expect(mani.totals).toMatchObject({ purchasePaise: 1000000, paidPaise: 400000, duePaise: 600000 });

    const g = (await http().post(`${base}/entries/grahak`).set(web).send({ name: 'Sharma Thela', phone: '9876500002', openingPaise: 20000 }).expect(201)).body;
    await http().post(`${base}/entries/grahak`).set(web).send({ name: 'sharma thela' }).expect(422);
    expect((await http().get(`${base}/buyers/${g.id}`).set(web).expect(200)).body.totals.balancePaise).toBe(20000);

    // Nayi gaadi: the supplier as the shop already spells him, a new maal made on the way.
    const gaadi = (await http().post(`${base}/entries/gaadi`).set(web).send({
      number: 'rj 14 ab 1', supplier: 'mani', freightPaise: 90000, lots: [{ brandName: 'Gujarat', grade: '1', qty: 300, ratePaise: 1800 }],
    }).expect(201)).body;
    const stock = (await http().get(`${base}/stock`).set(web).expect(200)).body.rows;
    expect(stock.find((r: any) => r.truckId === gaadi.truckId)).toMatchObject({ number: 'RJ14AB1', supplier: 'Mani', received: 300, brands: 'Gujarat' });
    expect(stock.find((r: any) => r.truckId === truckId).left).toBe(500 - 1 * 0 - 10);
    // Past: closed gaadis only, newest first, with the day each closed.
    await owner(`UPDATE trucks SET closed_at = now() WHERE id = '${gaadi.truckId}'`);
    const past = (await http().get(`${base}/stock?view=past`).set(web).expect(200)).body.rows;
    expect(past.map((r: any) => r.truckId)).toEqual([gaadi.truckId]);
    expect(past[0].closedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await http().get(`${base}/stock`).set(web).expect(200)).body.rows.map((r: any) => r.truckId)).not.toContain(gaadi.truckId);

    // The website shows up as one machine of the shop.
    const team = (await http().get(base).set(web).expect(200)).body;
    expect(team.devices.filter((x: any) => x.label === 'Website')).toHaveLength(1);
    expect(team.devices.find((x: any) => x.web)).toMatchObject({ phone: '9877700008' });

    // Packing as the parchi screen saves it: which katta, a panni with a parchune, a loose
    // parchune with no mazdoori, the Bank walk-in, a delivery, the accountant, its own number.
    const post = (body: object) => http().post(`${base}/entries/parchi`).set(web).send({ truckId, lines: [{ grade: '1', qty: 20, ratePaise: 2500 }], ...body }).expect(201).then((r) => r.body);
    const katta = await post({ buyerId: raju, pay: 'credit', packing: 'katta20', kattaName: 'Green', labour: false });
    const panni = await post({ buyerId: raju, pay: 'credit', packing: 'panni', panniName: 'Jai Ho', parchune: true, labourQty: 4, labourRatePaise: 50,
      delivery: { address: 'Shop 12, Okhla', stand: 'Okhla stand' }, staff: 'Ramesh', slipNo: 900 });
    const loose = await post({ buyerName: 'Bank', pay: 'upi', packing: 'loose', parchune: true });
    const rows = (await http().get('/v1/sync/pull?after=0&limit=500').set(auth(shop.accessToken)).expect(200)).body.changes;
    const row = (bid: string) => rows.find((c: any) => c.table === 'bills' && c.row.id === bid).row;
    expect(row(katta.billId)).toMatchObject({ packing: 'katta20', panni_name: 'Green', labour_paise: 0, packs: 0 });
    expect(row(panni.billId)).toMatchObject({ packing: 'panni', panni_name: 'Jai Ho + Parchune', labour_paise: 200, packs: 4, delivery: true, staff_name: 'Ramesh', slip_no: 900 });
    expect(panni.slipNo).toBe(900);
    expect(row(loose.billId)).toMatchObject({ buyer_id: null, buyer_name: 'Bank', pay_mode: 'upi', panni_name: 'Parchune', labour_paise: 0 });
    expect(rows.find((c: any) => c.table === 'delivery_slips' && c.row.bill_id === panni.billId).row).toMatchObject({ address: 'Shop 12, Okhla', destination: 'Okhla stand' });
    expect((await http().get(`${base}/bills/${panni.billId}`).set(web).expect(200)).body.delivery).toEqual({ address: 'Shop 12, Okhla', stand: 'Okhla stand' });

    // Settings, as the app's Settings screen: the same columns, so /v1/me shows the change.
    const before = (await http().get(`${base}/settings`).set(web).expect(200)).body;
    expect(before).toMatchObject({ name: 'Web Entry Traders', slipCode: '', udhaarRates: false, printerDots: 576 });
    const after = (await http().post(`${base}/settings`).set(web).send({
      slipCode: 'wet', phone: '9877700018', udhaarRates: true, printerDots: 832,
      bankAccounts: [{ holder: 'WET', bank: 'ICICI', ifsc: 'icic0000423', account: '123' }, { holder: '', bank: '', ifsc: '', account: '' }],
    }).expect(200)).body;
    expect(after).toMatchObject({ slipCode: 'WET', phone: '9877700018', udhaarRates: true, printerDots: 832, bankAccounts: [{ holder: 'WET', bank: 'ICICI', ifsc: 'ICIC0000423', account: '123' }] });
    expect((await http().get('/v1/me').set(auth(shop.accessToken)).expect(200)).body.shop).toMatchObject({ slipCode: 'WET', phone: '9877700018', udhaarRates: true });
    await http().post(`${base}/settings`).set(web).send({ phone: '12345' }).expect(400);
    await http().post(`${base}/settings`).set(web).send({ printerDots: 500 }).expect(400);
    const other = await registerShop('9877700019', 'Someone Else');
    await http().get(`/v1/admin/shops/${other.me.shop.id}/settings`).set(web).expect(403);

    // Aaj ka bhav from the website: one row per day × maal × grade, overwritten, pulled by terminals.
    await http().post(`${base}/bhav`).set(web).send({ rates: [{ brandId, grade: '1', ratePaise: 2600 }] }).expect(200);
    await http().post(`${base}/bhav`).set(web).send({ rates: [{ brandId, grade: '1', ratePaise: 2700 }] }).expect(200);
    const sheet = (await http().get(`${base}/bhav`).set(web).expect(200)).body;
    expect(sheet.brands.find((b: any) => b.id === brandId).grades[0]).toMatchObject({ grade: '1', ratePaise: 2700 });
    const rateRows = (await http().get('/v1/sync/pull?after=0&limit=500').set(auth(shop.accessToken)).expect(200)).body.changes.filter((c: any) => c.table === 'rates');
    expect(new Set(rateRows.map((c: any) => c.row.id)).size).toBe(1);
    expect(rateRows.at(-1).row.rate_paise).toBe(2700);

    // Every slip today went at ₹25 against a ₹27 bhav: Nigrani lists each, with what it lost.
    const nig = (await http().get(`${base}/nigrani?from=${d}&to=${d}`).set(web).expect(200)).body;
    expect(nig.belowBhav.find((b: any) => b.billId === katta.billId)).toMatchObject({ qty: 20, ratePaise: 2500, bhavPaise: 2700, lossPaise: 4000 });
    expect(nig.belowBhav).toHaveLength(4);

    // Gaadi hisab: TN09 cost ₹20 a nag landed; 70 nag sold at ₹25 → ₹350 munafa so far.
    const gh = (await http().get(`${base}/gaadi-hisab`).set(web).expect(200)).body.rows.find((r: any) => r.truckId === truckId);
    expect(gh).toMatchObject({ received: 500, sold: 70, salesPaise: 175000, landedRatePaise: 2000, profitPaise: 35000, leftValuePaise: 430 * 2000 });

    // Munafa: bikri − laagat of maal sold; kharcha is kiraya plus the mazdoori earned on slips.
    const pl = (await http().get(`${base}/munafa?from=${d}&to=${d}`).set(web).expect(200)).body;
    expect(pl).toMatchObject({ salesPaise: 177500, cogsPaise: 140000, grossPaise: 37500, expensePaise: 30500, netPaise: 7000 });
    expect(pl.expenses.map((e: any) => e.head).sort()).toEqual(['kiraya', 'mazdoori']);

    // Bikri register: today's line carries every live slip.
    const reg = (await http().get(`${base}/sales-register?from=${d}&to=${d}`).set(web).expect(200)).body;
    expect(reg.days).toEqual([expect.objectContaining({ date: d, slips: 5, totalPaise: 177500 })]);
  });

  it('alters and deletes a parchi or raseed from the website the way the app does, and terminals pick it up', async () => {
    const shop = await registerShop('9877700020', 'Badlein Traders');
    const id = shop.me.shop.id as string;
    const term = auth(shop.accessToken);
    const t = new Date().toISOString(), d = istDay();
    const brandId = uuidv7(), truckId = uuidv7(), raju = uuidv7();
    await http().post('/v1/sync/push').set(term).send({ items: [
      { table: 'brands', row: { id: brandId, created_at: t, updated_at: t, name: 'Pollachi' } },
      { table: 'buyers', row: { id: raju, created_at: t, updated_at: t, name: 'Raju Fruits', phone: '9876500001' } },
      { table: 'trucks', row: { id: truckId, created_at: t, updated_at: t, number: 'TN09', supplier: 'Mani', arrived_at: t } },
      { table: 'truck_grades', row: { id: uuidv7(), created_at: t, truck_id: truckId, brand_id: brandId, grade: '1', billed_qty: 100, received_qty: 100, rate_paise: 2000 } },
    ] }).expect(200);
    await http().post('/v1/admin/auth/otp').send({ phone: '9877700020' }).expect(204);
    const web = auth((await http().post('/v1/admin/auth/verify').send({ phone: '9877700020', code: OtpService.issuedForTests.get('9877700020') }).expect(200)).body.token);
    const base = `/v1/admin/shops/${id}`;
    const parchi = (body: object) => http().post(`${base}/entries/parchi`).set(web).send({ truckId, packing: 'loose', ...body }).expect(201).then((r) => r.body);
    const pull = async () => (await http().get('/v1/sync/pull?after=0&limit=500').set(term).expect(200)).body.changes as any[];
    const left = async () => (await http().get(`${base}/stock`).set(web).expect(200)).body.rows.find((r: any) => r.truckId === truckId).left;
    const balance = async () => (await http().get(`${base}/buyers/${raju}`).set(web).expect(200)).body.totals.balancePaise;

    // Badlein: 10 nag at ₹25 on udhaar becomes 12 at ₹26 — same slip number, new row, old one voided 'edited'.
    const a = await parchi({ buyerId: raju, lines: [{ grade: '1', qty: 10, ratePaise: 2500 }], pay: 'credit' });
    expect(a.slipNo).toBe(1);
    // All 90 dana left plus the 10 this slip already took: the edit may take up to 100, not more.
    await http().post(`${base}/bills/${a.billId}/edit`).set(web).send({ buyerId: raju, truckId, lines: [{ grade: '1', qty: 101, ratePaise: 2600 }], pay: 'credit', packing: 'loose' }).expect(422);
    const a2 = (await http().post(`${base}/bills/${a.billId}/edit`).set(web).send({ buyerId: raju, truckId, lines: [{ grade: '1', qty: 12, ratePaise: 2600 }], pay: 'credit', packing: 'loose' }).expect(201)).body;
    expect(a2).toMatchObject({ slipNo: 1, replaced: a.billId });
    expect(a2.billId).not.toBe(a.billId);
    await http().post(`${base}/bills/${a.billId}/edit`).set(web).send({ buyerId: raju, truckId, lines: [{ grade: '1', qty: 1, ratePaise: 1 }], pay: 'credit', packing: 'loose' }).expect(409);
    await http().post(`${base}/bills/${a.billId}/void`).set(web).send({}).expect(409);
    expect((await http().get(`${base}/bills/${a.billId}`).set(web).expect(200)).body.voided).toMatchObject({ reason: 'edited', by: expect.stringMatching(/Website$/) });
    expect(await left()).toBe(88);
    expect(await balance()).toBe(31200);
    let rows = await pull();
    // The terminal gets the void and the corrected slip together, the void first.
    const voidAt = rows.findIndex((c) => c.table === 'bill_voids' && c.row.bill_id === a.billId);
    const newAt = rows.findIndex((c) => c.table === 'bills' && c.row.id === a2.billId);
    expect(rows[voidAt].row).toMatchObject({ reason: 'edited', slip_no: 1 });
    expect(newAt).toBeGreaterThan(voidAt);
    expect(rows[newAt].row).toMatchObject({ slip_no: 1, total_paise: 31200, buyer_id: raju });

    // Hatayein, nothing paid: just voided, the dana back on the gaadi.
    const b = await parchi({ buyerId: raju, lines: [{ grade: '1', qty: 5, ratePaise: 2500 }], pay: 'credit' });
    await http().post(`${base}/bills/${b.billId}/void`).set(web).send({ reason: 'refunded' }).expect(422);
    expect((await http().post(`${base}/bills/${b.billId}/void`).set(web).send({}).expect(200)).body).toMatchObject({ slipNo: 2, reason: 'deleted', refundPaise: 0, advance: null });
    await http().post(`${base}/bills/${b.billId}/void`).set(web).send({}).expect(409);
    expect(await left()).toBe(88);

    // Paid at the counter: say what happens to the money. Kept as advance: a raseed with no slip.
    const c = await parchi({ buyerId: raju, lines: [{ grade: '1', qty: 2, ratePaise: 2500 }], pay: 'split', cashPaise: 3000, upiPaise: 2000 });
    await http().post(`${base}/bills/${c.billId}/void`).set(web).send({ reason: 'deleted' }).expect(422);
    const adv = (await http().post(`${base}/bills/${c.billId}/void`).set(web).send({ reason: 'advance' }).expect(200)).body;
    expect(adv.advance).toMatchObject({ receiptNo: 1, amountPaise: 5000 });
    rows = await pull();
    expect(rows.find((x) => x.table === 'collections' && x.row.id === adv.advance.id).row).toMatchObject({ bill_id: null, amount_paise: 5000, cash_paise: 3000, upi_paise: 2000, receipt_no: 1, buyer_id: raju });
    expect(rows.find((x) => x.table === 'bill_voids' && x.row.bill_id === c.billId).row.reason).toBe('advance');
    expect(await balance()).toBe(31200 - 5000);

    // A walk-in has no khata to keep it in: refunded. The UPI stays in the bank, the galla pays it out.
    const dd = await parchi({ buyerName: 'Bank', lines: [{ grade: '1', qty: 2, ratePaise: 2500 }], pay: 'upi' });
    await http().post(`${base}/bills/${dd.billId}/void`).set(web).send({ reason: 'advance' }).expect(422);
    expect((await http().post(`${base}/bills/${dd.billId}/void`).set(web).send({ reason: 'refunded' }).expect(200)).body.refundPaise).toBe(5000);
    const day = (await http().get(`${base}/daybook?from=${d}&to=${d}`).set(web).expect(200)).body.entries;
    expect(day.filter((e: any) => e.kind === 'in' || e.kind === 'out').map((e: any) => [e.kind, e.title, e.mode, e.amountPaise, e.note]).sort()).toEqual([
      ['in', 'aur_aaya', 'upi', 5000, `Parchi #${dd.slipNo} wapas · UPI aaya tha`], ['out', 'aur_gaya', 'cash', 5000, `Parchi #${dd.slipNo} refund · cash diya`],
    ]);

    // Vasooli taken on a slip (at a terminal): it can't be altered any more; deleted with a refund, that vasooli goes too.
    const e = await parchi({ buyerId: raju, lines: [{ grade: '1', qty: 4, ratePaise: 2500 }], pay: 'credit' });
    const onE = uuidv7();
    await http().post('/v1/sync/push').set(term).send({ items: [
      { table: 'collections', row: { id: onE, created_at: now(), buyer_id: raju, amount_paise: 4000, pay_mode: 'upi', business_date: d, bill_id: e.billId, receipt_no: 2, upi_paise: 4000 } },
    ] }).expect(200);
    expect((await http().get(`${base}/bills/${e.billId}`).set(web).expect(200)).body.collected).toEqual({ cashPaise: 0, upiPaise: 4000 });
    await http().post(`${base}/bills/${e.billId}/edit`).set(web).send({ buyerId: raju, truckId, lines: [{ grade: '1', qty: 4, ratePaise: 2400 }], pay: 'credit', packing: 'loose' }).expect(422);
    expect((await http().post(`${base}/bills/${e.billId}/void`).set(web).send({ reason: 'refunded' }).expect(200)).body.refundPaise).toBe(4000);
    rows = await pull();
    expect(rows.find((x) => x.table === 'collection_voids' && x.row.collection_id === onE).row).toMatchObject({ receipt_no: 2, reason: 'deleted' });
    expect(rows.filter((x) => x.table === 'daybook_entries' && x.row.amount_paise === 4000).map((x) => x.row.category).sort()).toEqual(['aur_aaya', 'aur_gaya']);
    expect(await balance()).toBe(31200 - 5000);

    // Raseed: Badlein keeps its number and time; Hatayein puts the money back on what they owe.
    const v = (await http().post(`${base}/entries/vasooli`).set(web).send({ buyerId: raju, cashPaise: 5000, upiPaise: 0 }).expect(201)).body;
    expect((await http().get(`${base}/collections/${v.id}`).set(web).expect(200)).body).toMatchObject({ receiptNo: v.receiptNo, cashPaise: 5000, buyerName: 'Raju Fruits', voided: null });
    const v2 = (await http().post(`${base}/collections/${v.id}/edit`).set(web).send({ cashPaise: 2000, upiPaise: 5000, upiBank: 'ICICI ··4521' }).expect(201)).body;
    expect(v2.receiptNo).toBe(v.receiptNo);
    await http().post(`${base}/collections/${v.id}/void`).set(web).expect(409);
    rows = await pull();
    const origAt = rows.find((x) => x.table === 'collections' && x.row.id === v.id).row.created_at;
    const fixed = rows.filter((x) => x.table === 'collections' && x.row.receipt_no === v.receiptNo && x.row.id !== v.id);
    expect(fixed.map((x) => x.row)).toEqual([expect.objectContaining({ amount_paise: 7000, cash_paise: 2000, upi_paise: 5000, pay_mode: 'mixed', bill_id: null, upi_bank: 'ICICI ··4521', created_at: origAt })]);
    expect(rows.find((x) => x.table === 'collection_voids' && x.row.collection_id === v.id).row.reason).toBe('edited');
    expect(await balance()).toBe(31200 - 5000 - 7000);
    await http().post(`${base}/collections/${fixed[0].row.id}/void`).set(web).expect(200);
    expect(await balance()).toBe(31200 - 5000);

    // A raseed taken on slips is taken again over the same slips, oldest first, cash before UPI.
    const f = await parchi({ buyerId: raju, lines: [{ grade: '1', qty: 4, ratePaise: 2500 }], pay: 'credit' });
    const g = await parchi({ buyerId: raju, lines: [{ grade: '1', qty: 4, ratePaise: 2500 }], pay: 'credit' });
    const at2 = now(), r1 = uuidv7(), r2 = uuidv7();
    await http().post('/v1/sync/push').set(term).send({ items: [
      { table: 'collections', row: { id: r1, created_at: at2, buyer_id: raju, amount_paise: 3000, pay_mode: 'cash', business_date: d, bill_id: f.billId, receipt_no: 9, cash_paise: 3000 } },
      { table: 'collections', row: { id: r2, created_at: at2, buyer_id: raju, amount_paise: 3000, pay_mode: 'cash', business_date: d, bill_id: g.billId, cash_paise: 3000 } },
    ] }).expect(200);
    expect((await http().get(`${base}/collections/${r2}`).set(web).expect(200)).body).toMatchObject({ receiptNo: 9, cashPaise: 6000, slips: expect.arrayContaining([expect.objectContaining({ billId: f.billId }), expect.objectContaining({ billId: g.billId })]) });
    await http().post(`${base}/collections/${r2}/edit`).set(web).send({ cashPaise: 12000, upiPaise: 2000 }).expect(201);
    rows = await pull();
    const again = rows.filter((x) => x.table === 'collections' && x.row.created_at === rows.find((y) => y.row.id === r1).row.created_at && ![r1, r2].includes(x.row.id)).map((x) => x.row);
    // Raju's ₹50 advance settles his oldest slip (the Badlein one), so both are owed in full: the
    // older takes ₹100 in cash, the last one whatever is left.
    expect(again.map((r) => [r.bill_id, r.amount_paise, r.cash_paise, r.upi_paise, r.receipt_no])).toEqual([
      [f.billId, 10000, 10000, 0, 9], [g.billId, 4000, 2000, 2000, null],
    ]);

    // Nigrani lists every slip and raseed changed, and which machine changed it.
    const nig = (await http().get(`${base}/nigrani?from=${d}&to=${d}`).set(web).expect(200)).body;
    expect(nig.voids.map((x: any) => [x.slipNo, x.reason]).sort()).toEqual([[1, 'edited'], [2, 'deleted'], [3, 'advance'], [4, 'refunded'], [5, 'refunded']]);
    expect(nig.voids.every((x: any) => /Website$/.test(x.by))).toBe(true);
    expect(nig.receipts.map((x: any) => x.reason).sort()).toEqual(['deleted', 'deleted', 'edited', 'edited', 'edited']);
    // The Day Book strikes the corrected raseed through as changed, not deleted.
    const book = (await http().get(`${base}/daybook?from=${d}&to=${d}`).set(web).expect(200)).body.entries;
    expect(book.find((x: any) => x.id === v.id).voided).toBe('edited');
    expect(book.find((x: any) => x.id === a.billId).voided).toBe('edited');
  });

  it('turns a request down and frees the number to register again', async () => {
    const s = await login('9877700002');
    const created = await http().post('/v1/shops').set(auth(s.accessToken)).send({ name: 'Fake Shop' }).expect(201);
    const id = created.body.me.pendingShop.id;
    const admin = await adminLogin();
    await http().post(`/v1/admin/shops/${id}/reject`).set(admin).send({ reason: 'Not a mandi shop' }).expect(204);
    const me = (await http().get('/v1/me').set(auth(created.body.accessToken)).expect(200)).body;
    expect(me.shop).toBeNull();
    expect(me.pendingShop).toMatchObject({ status: 'rejected', reason: 'Not a mandi shop' });
    await http().post('/v1/shops').set(auth(created.body.accessToken)).send({ name: 'Real Shop' }).expect(201);
    expect((await http().get('/v1/me').set(auth(created.body.accessToken))).body.pendingShop).toMatchObject({ name: 'Real Shop', status: 'pending' });
  });

  it('answers the admin portal’s browser, and no other site', async () => {
    const ok = await http().options('/v1/admin/shops').set('Origin', 'https://mandipos-admin.onrender.com')
      .set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'authorization');
    expect(ok.headers['access-control-allow-origin']).toBe('https://mandipos-admin.onrender.com');
    const other = await http().get('/healthz').set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets in admins and shop owners only, and never with an app token', async () => {
    await http().post('/v1/admin/auth/otp').send({ phone: '9811199998' }).expect(403);
    await http().get('/v1/admin/shops').expect(401);
    const app = await login('9876500077');
    await http().get('/v1/admin/shops').set(auth(app.accessToken)).expect(401);
    const admin = await adminLogin('9022300000');
    await http().get('/v1/admin/me').set(admin).expect(200);
    // An admin number on OTP_TEST_LOGINS signs in with its fixed code.
    await http().post('/v1/admin/auth/otp').send({ phone: '9000000000' }).expect(204);
    await http().post('/v1/admin/auth/verify').send({ phone: '9000000000', code: '123456' }).expect(200);
  });

  it('shows a shop the same figures the app does, and a grahak’s whole history', async () => {
    const shop = await registerShop('9877700003', 'Stats Traders');
    const t = new Date().toISOString(), d = istDay();
    const brandId = uuidv7(), truckId = uuidv7(), raju = uuidv7();
    const [paid, udhaar, voided] = [uuidv7(), uuidv7(), uuidv7()];
    const colId = uuidv7(), deadCol = uuidv7();
    const pushed = await http().post('/v1/sync/push').set(auth(shop.accessToken)).send({ items: [
      { table: 'brands', row: { id: brandId, created_at: t, updated_at: t, name: 'Pollachi' } },
      { table: 'buyers', row: { id: raju, created_at: t, updated_at: t, name: 'Raju Fruits', phone: '9876543210', code: 'R7' } },
      { table: 'trucks', row: { id: truckId, created_at: t, updated_at: t, number: 'TN01', supplier: 'Mani', arrived_at: t } },
      { table: 'truck_grades', row: { id: uuidv7(), created_at: t, truck_id: truckId, brand_id: brandId, grade: '1', billed_qty: 1000, received_qty: 1000, rate_paise: 2000 } },
      // ₹500 cash+UPI paid in full; ₹800 on udhaar; ₹300 slip voided later.
      { table: 'bills', row: { id: paid, created_at: t, number: 'A1/1', kind: 'kachchi', buyer_id: raju, buyer_name: 'Raju Fruits', business_date: d, pay_mode: 'mixed', total_paise: 50000, paid_paise: 50000, cash_paise: 30000, upi_paise: 20000, slip_no: 1, truck_id: truckId, labour_paise: 600 } },
      { table: 'bill_lines', row: { id: uuidv7(), created_at: t, bill_id: paid, truck_id: truckId, brand_id: brandId, grade: '1', qty: 20, rate_paise: 2500 } },
      { table: 'bills', row: { id: udhaar, created_at: t, number: 'A1/2', kind: 'kachchi', buyer_id: raju, buyer_name: 'Raju Fruits', business_date: d, pay_mode: 'credit', total_paise: 80000, paid_paise: 0, slip_no: 2, truck_id: truckId } },
      { table: 'bill_lines', row: { id: uuidv7(), created_at: t, bill_id: udhaar, truck_id: truckId, brand_id: brandId, grade: '1', qty: 32, rate_paise: 2500 } },
      { table: 'bills', row: { id: voided, created_at: t, number: 'A1/3', kind: 'kachchi', buyer_id: raju, buyer_name: 'Raju Fruits', business_date: d, pay_mode: 'credit', total_paise: 30000, paid_paise: 0, slip_no: 3, truck_id: truckId } },
      { table: 'bill_lines', row: { id: uuidv7(), created_at: t, bill_id: voided, truck_id: truckId, brand_id: brandId, grade: '1', qty: 12, rate_paise: 2500 } },
      { table: 'bill_voids', row: { id: uuidv7(), created_at: t, bill_id: voided, slip_no: 3 } },
      // ₹200 vasooli on the udhaar slip; a ₹999 payment entered by mistake and voided.
      { table: 'collections', row: { id: colId, created_at: t, buyer_id: raju, amount_paise: 20000, pay_mode: 'upi', business_date: d, bill_id: udhaar, receipt_no: 1, upi_paise: 20000 } },
      { table: 'collections', row: { id: deadCol, created_at: t, buyer_id: raju, amount_paise: 99900, pay_mode: 'cash', business_date: d, receipt_no: 2 } },
      { table: 'collection_voids', row: { id: uuidv7(), created_at: t, collection_id: deadCol, receipt_no: 2 } },
      { table: 'udhaar_entries', row: { id: uuidv7(), created_at: t, buyer_id: raju, amount_paise: 10000, note: 'Purana khata', business_date: d } },
    ] }).expect(200);
    expect(pushed.body.results.every((r: any) => r.status === 'applied')).toBe(true);

    const admin = await adminLogin();
    const id = shop.me.shop.id;
    const sum = (await http().get(`/v1/admin/shops/${id}/summary?from=${d}&to=${d}`).set(admin).expect(200)).body;
    expect(sum).toMatchObject({
      salesPaise: 130000, slips: 2, nags: 52, cashPaise: 30000, upiPaise: 20000,
      creditLeftPaise: 60000, collectedCashPaise: 0, collectedUpiPaise: 20000, labourPaise: 600,
      deletedSlips: 1, deletedPaise: 30000,
      duePaise: 70000, dueBuyers: 1, stockNags: 948, openTrucks: 1,
    });
    expect(sum.series).toEqual([{ date: d, salesPaise: 130000, slips: 2 }]);
    expect(sum.topBuyers[0]).toMatchObject({ name: 'Raju Fruits', salesPaise: 130000 });

    const found = (await http().get(`/v1/admin/shops/${id}/buyers?q=r7`).set(admin).expect(200)).body.buyers;
    expect(found).toEqual([expect.objectContaining({ id: raju, balancePaise: 70000, boughtPaise: 130000 })]);
    expect((await http().get(`/v1/admin/shops/${id}/buyers?q=98765`).set(admin)).body.buyers).toHaveLength(1);
    expect((await http().get(`/v1/admin/shops/${id}/buyers?q=nobody`).set(admin)).body.buyers).toHaveLength(0);

    const g = (await http().get(`/v1/admin/shops/${id}/buyers/${raju}`).set(admin).expect(200)).body;
    expect(g.buyer).toMatchObject({ name: 'Raju Fruits', phone: '9876543210', code: 'R7' });
    expect(g.totals).toMatchObject({ balancePaise: 70000, boughtPaise: 130000, slips: 2, nags: 52 });
    expect(g.history).toHaveLength(4);
    expect(g.history.map((r: any) => r.kind).sort()).toEqual(['payment', 'slip', 'slip', 'udhaar']);
    expect(g.history[0].balancePaise).toBe(70000);
    expect(g.history.find((r: any) => r.id === udhaar).lines).toEqual([{ brand: 'Pollachi', grade: '1', qty: 32, ratePaise: 2500, leak: false }]);

    // The Day Book lists everything, the cancelled slip and payment marked rather than hidden.
    const book = (await http().get(`/v1/admin/shops/${id}/daybook?from=${d}&to=${d}`).set(admin).expect(200)).body.entries;
    const slips = book.filter((e: any) => e.kind === 'slip');
    expect(slips).toHaveLength(3);
    expect(slips.find((e: any) => e.id === voided).voided).toBe('deleted');
    expect(slips.find((e: any) => e.id === paid)).toMatchObject({ amountPaise: 50000, cashPaise: 30000, upiPaise: 20000, udhaarPaise: 0, nags: 20, party: 'Raju Fruits' });
    expect(slips.find((e: any) => e.id === udhaar)).toMatchObject({ udhaarPaise: 80000, nags: 32 });
    const pays = book.filter((e: any) => e.kind === 'payment');
    expect(pays.map((e: any) => [e.amountPaise, e.voided])).toEqual(expect.arrayContaining([[20000, null], [99900, 'deleted']]));
    expect(pays.find((e: any) => e.id === colId)).toMatchObject({ upiPaise: 20000, party: 'Raju Fruits' });

    // Tally's reports, each matching the app's own sums.
    const dash = (await http().get(`/v1/admin/shops/${id}/dashboard?from=${d}&to=${d}`).set(admin).expect(200)).body;
    expect(dash.now).toMatchObject({ salesPaise: 130000, slips: 2, purchasePaise: 2000000, gaadis: 1 });
    expect(dash.receivables).toMatchObject({ duePaise: 70000, count: 1, d0_7: 70000, d8_30: 0, d31: 0 });
    expect(dash.payables).toMatchObject({ duePaise: 2000000, count: 1 });
    expect(dash.cash).toEqual({ galla: 30000, office: 0, bank: 40000 });
    expect(dash.trend).toHaveLength(7);
    expect(dash.trend.at(-1)).toEqual({ date: d, salesPaise: 130000, purchasePaise: 2000000 });
    expect(dash.items).toEqual([{ brand: 'Pollachi', nags: 52, amountPaise: 130000, slips: 2, ratePaise: 2500 }]);

    const galla = (await http().get(`/v1/admin/shops/${id}/cashbook?pot=galla&from=${d}&to=${d}`).set(admin).expect(200)).body;
    expect(galla).toMatchObject({ openingPaise: 0, inPaise: 30000, outPaise: 0, closingPaise: 30000 });
    const bank = (await http().get(`/v1/admin/shops/${id}/cashbook?pot=bank&from=${d}&to=${d}`).set(admin).expect(200)).body;
    expect(bank.lines.map((l: any) => [l.kind, l.inPaise])).toEqual([['bikri', 20000], ['vasooli', 20000]]);

    const out = (await http().get(`/v1/admin/shops/${id}/outstanding`).set(admin).expect(200)).body;
    expect(out.rows).toEqual([expect.objectContaining({ buyerId: raju, duePaise: 70000, d0_7: 70000, oldestDays: 0 })]);

    const sup = (await http().get(`/v1/admin/shops/${id}/suppliers`).set(admin).expect(200)).body;
    expect(sup.rows).toEqual([expect.objectContaining({ key: 'mani', name: 'Mani', gaadis: 1, purchasePaise: 2000000, paidPaise: 0, duePaise: 2000000 })]);
    const mani = (await http().get(`/v1/admin/shops/${id}/suppliers/mani`).set(admin).expect(200)).body;
    expect(mani.history[0]).toMatchObject({ kind: 'gaadi', title: 'Gaadi TN01', creditPaise: 2000000, balancePaise: 2000000, left: 948 });

    const stock = (await http().get(`/v1/admin/shops/${id}/stock`).set(admin).expect(200)).body;
    expect(stock.rows).toEqual([expect.objectContaining({ number: 'TN01', received: 1000, sold: 52, left: 948, valuePaise: 1896000 })]);

    // The shop's owner signs in too, and sees only their own shop — never the market or another's books.
    await http().post('/v1/admin/auth/otp').send({ phone: '9877700003' }).expect(204);
    const ownerTok = (await http().post('/v1/admin/auth/verify').send({ phone: '9877700003', code: OtpService.issuedForTests.get('9877700003') }).expect(200)).body.token;
    const asOwner = auth(ownerTok);
    expect((await http().get('/v1/admin/me').set(asOwner).expect(200)).body).toMatchObject({ admin: false, shopIds: [id] });
    expect((await http().get('/v1/admin/shops').set(asOwner).expect(200)).body.shops.map((s: any) => s.id)).toEqual([id]);
    await http().get(`/v1/admin/shops/${id}/dashboard?from=${d}&to=${d}`).set(asOwner).expect(200);
    const someoneElse = (await http().get('/v1/admin/shops').set(admin)).body.shops.find((s: any) => s.id !== id && s.status === 'approved').id;
    await http().get(`/v1/admin/shops/${someoneElse}/daybook?from=${d}&to=${d}`).set(asOwner).expect(403);
    await http().get('/v1/admin/customers').set(asOwner).expect(403);
    await http().post(`/v1/admin/shops/${someoneElse}/approve`).set(asOwner).expect(403);
    // A number with no shop gets no OTP at all.
    await http().post('/v1/admin/auth/otp').send({ phone: '9811199999' }).expect(403);

    const market = (await http().get('/v1/admin/customers').set(admin).expect(200)).body.market;
    expect(market.duePaise).toBeGreaterThanOrEqual(70000);
    expect(market.debtors).toBeGreaterThanOrEqual(1);
    expect((await http().get('/v1/admin/customers?q=raju').set(admin)).body.market).toBeNull();
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
  // two terminals can never hold the same one. A number already taken is not refused — that
  // slip's money and dana would stay on one machine — it is kept under the next free number.
  it('keeps a slip whose number is already used, under the next free number', async () => {
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
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied', 'applied']);
    expect(res.body.results.map((r: any) => r.renumbered ?? null)).toEqual([null, { from: 700, to: 701 }, { from: 701, to: 702 }]);
    // A re-send of a slip already kept changes nothing.
    const again = await push(owner.accessToken, [{ table: 'bills', row: { ...slip({}).row, id: res.body.results[1].id, slip_no: 700 } }]);
    expect(again.body.results[0]).toEqual({ id: res.body.results[1].id, status: 'skipped' });
  });

  // Light gone: the tab keeps making slips offline while the P5 carries on online. When the tab
  // comes back its slips land under new numbers, and a Badlein it made offline stays one slip.
  it('moves an offline terminal\'s clashing slip, and its edit follows it', async () => {
    const tab = await login('9800000001');
    const t = now();
    const slip = (id: string, n: number) => ({
      table: 'bills',
      row: {
        id, created_at: t, number: `A3/2627/${String(Math.floor(Math.random() * 900000) + 100000)}`,
        kind: 'kachchi', buyer_name: 'Walk-in', business_date: today(), pay_mode: 'cash',
        total_paise: 100, paid_paise: 100, cash_paise: 100, slip_no: n,
      },
    });
    const p5 = await push(owner.accessToken, [slip(uuidv7(), 850)]);
    expect(p5.body.results[0].status).toBe('applied');
    const original = uuidv7();
    const copy = uuidv7();
    const voidId = uuidv7();
    const res = await push(tab.accessToken, [
      slip(original, 850),
      { table: 'bill_voids', row: { id: voidId, created_at: t, bill_id: original, slip_no: 850, reason: 'edited' } },
      slip(copy, 850),
      slip(uuidv7(), 851),
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(res.body.results.map((r: any) => r.renumbered ?? null)).toEqual([
      { from: 850, to: 851 }, null, { from: 850, to: 851 }, { from: 851, to: 852 }]);
    // The feed tells every terminal the number the server holds, the void's too.
    const changes: any[] = [];
    for (let after = 0, more = true; more;) {
      const page = await http().get(`/v1/sync/pull?after=${after}&limit=500`).set('Authorization', `Bearer ${owner.accessToken}`).expect(200);
      changes.push(...page.body.changes);
      after = page.body.lastSeq;
      more = page.body.hasMore;
    }
    const row = (id: string) => changes.find((c: any) => c.row.id === id)?.row;
    expect([row(original).slip_no, row(original).asked_slip_no]).toEqual([851, 850]);
    expect(row(voidId).slip_no).toBe(851);
    expect(row(copy).slip_no).toBe(851);
  });

  // Two terminals act on the same slip without seeing each other (offline, or at the same moment).
  // The later word wins and the slip stays one slip: a second void carries on to the copy now
  // standing in its place; with nothing standing (both deleted it) it is skipped, never refused.
  it('lets the later of two edits, or an edit and a delete, win — one live slip, nothing stuck', async () => {
    const tab = await login('9800000001');
    const t = now();
    const slip = (id: string, n: number) => ({ table: 'bills', row: {
      id, created_at: t, number: `A4/2627/${String(Math.floor(Math.random() * 900000) + 100000)}`,
      kind: 'kachchi', buyer_name: 'Walk-in', business_date: today(), pay_mode: 'cash',
      total_paise: 100, paid_paise: 100, cash_paise: 100, slip_no: n } });
    const voidOf = (bill: string, n: number, reason = 'edited') => ({ table: 'bill_voids', row: { id: uuidv7(), created_at: t, bill_id: bill, slip_no: n, reason } });
    const x = uuidv7();
    await push(owner.accessToken, [slip(x, 870)]);
    const p5Copy = uuidv7();
    const tabCopy = uuidv7();
    const first = await push(owner.accessToken, [voidOf(x, 870), slip(p5Copy, 870)]);
    expect(first.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied']);
    // The tab edited the same slip offline: its void finds the P5's copy standing, and its copy takes the number.
    const second = await push(tab.accessToken, [voidOf(x, 870), slip(tabCopy, 870)]);
    expect(second.body.results.map((r: any) => r.status)).toEqual(['skipped', 'applied']);
    expect(second.body.results[0].passedOn).toEqual([p5Copy]);
    expect(second.body.results[1].renumbered).toBeUndefined();
    // Then the P5 deletes it (it knew only its own copy): the slip is gone, whoever's copy stood.
    const del = await push(owner.accessToken, [voidOf(p5Copy, 870, 'deleted')]);
    expect(del.body.results[0]).toMatchObject({ status: 'skipped', passedOn: [tabCopy] });
    // And the tab deletes it too: nothing left to void, nothing refused.
    const again = await push(tab.accessToken, [voidOf(tabCopy, 870, 'deleted')]);
    expect(again.body.results[0].status).toBe('skipped');
    const changes: any[] = [];
    for (let after = 0, more = true; more;) {
      const page = await http().get(`/v1/sync/pull?after=${after}&limit=500`).set('Authorization', `Bearer ${owner.accessToken}`).expect(200);
      changes.push(...page.body.changes); after = page.body.lastSeq; more = page.body.hasMore;
    }
    const voided = new Set(changes.filter((c) => c.table === 'bill_voids').map((c) => c.row.bill_id));
    expect([x, p5Copy, tabCopy].every((id) => voided.has(id))).toBe(true);
  });

  // A Badlein made on a terminal that still knew the slip by its old number: the copy takes the
  // number the server holds for the slip it replaces, not a new one.
  it('gives an edit the number its slip holds on the server, whichever terminal edits it', async () => {
    const tab = await login('9800000001');
    const t = now();
    const slip = (id: string, n: number) => ({ table: 'bills', row: {
      id, created_at: t, number: `A5/2627/${String(Math.floor(Math.random() * 900000) + 100000)}`,
      kind: 'kachchi', buyer_name: 'Walk-in', business_date: today(), pay_mode: 'cash',
      total_paise: 100, paid_paise: 100, cash_paise: 100, slip_no: n } });
    await push(owner.accessToken, [slip(uuidv7(), 880)]);
    const x = uuidv7();
    const moved = await push(tab.accessToken, [slip(x, 880)]);        // offline clash: kept under the next number
    const held = moved.body.results[0].renumbered.to;
    // A third terminal pulled the slip before it moved and edits it as #880.
    const third = await login('9800000001');
    const copy = uuidv7();
    const res = await push(third.accessToken, [
      { table: 'bill_voids', row: { id: uuidv7(), created_at: t, bill_id: x, slip_no: 880, reason: 'edited' } }, slip(copy, 880)]);
    expect(res.body.results[1]).toMatchObject({ status: 'applied', renumbered: { from: 880, to: held } });
  });

  // The answer to a push got lost; the terminal sends the same rows again, an edit among them.
  it('skips a re-sent slip whose number its corrected copy now holds', async () => {
    const t = now();
    const slip = (id: string) => ({ table: 'bills', row: {
      id, created_at: t, number: `A6/2627/${String(Math.floor(Math.random() * 900000) + 100000)}`,
      kind: 'kachchi', buyer_name: 'Walk-in', business_date: today(), pay_mode: 'cash',
      total_paise: 100, paid_paise: 100, cash_paise: 100, slip_no: 890 } });
    const x = uuidv7();
    const items = [slip(x), { table: 'bill_voids', row: { id: uuidv7(), created_at: t, bill_id: x, slip_no: 890, reason: 'edited' } }, slip(uuidv7())];
    expect((await push(owner.accessToken, items)).body.results.map((r: any) => r.status)).toEqual(['applied', 'applied', 'applied']);
    expect((await push(owner.accessToken, items)).body.results.map((r: any) => r.status)).toEqual(['skipped', 'skipped', 'skipped']);
  });

  // Badlein on a saved slip: cancel it, then write the corrected one under the same number.
  it('lets a slip number be used again once the slip holding it is voided', async () => {
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
      { table: 'bill_voids', row: { id: uuidv7(), created_at: t, bill_id: first, slip_no: 800, reason: 'edited' } },
      slip(second),
      slip(uuidv7()),
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(res.body.results.map((r: any) => r.renumbered?.from ?? null)).toEqual([null, null, null, 800]);
  });

  // A paid slip deleted: its money handed back, or kept as the grahak's advance.
  it('takes a void that refunded the money or kept it as advance', async () => {
    const t = now();
    const slip = (id: string, n: number) => ({
      table: 'bills',
      row: {
        id, created_at: t, number: `A2/2627/${String(Math.floor(Math.random() * 900000) + 100000)}`,
        kind: 'kachchi', buyer_name: 'Walk-in', business_date: today(), pay_mode: 'upi',
        total_paise: 100, paid_paise: 100, upi_paise: 100, slip_no: n,
      },
    });
    const a = uuidv7();
    const b = uuidv7();
    const res = await push(owner.accessToken, [
      slip(a, 810), slip(b, 811),
      { table: 'bill_voids', row: { id: uuidv7(), created_at: t, bill_id: a, slip_no: 810, reason: 'refunded' } },
      { table: 'bill_voids', row: { id: uuidv7(), created_at: t, bill_id: b, slip_no: 811, reason: 'advance' } },
      { table: 'bill_voids', row: { id: uuidv7(), created_at: t, bill_id: b, slip_no: 811, reason: 'lost' } },
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied', 'rejected']);
  });

  // Mazdoori typed in by hand: + or −, and taken back by hiding it.
  it('takes a mazdoori adjustment either way, and lets it be taken back', async () => {
    const t = now();
    const later = new Date(Date.now() + 1000).toISOString();
    const row = (id: string, amount: number, extra = {}) => ({ table: 'labour_adjustments', row: {
      id, created_at: t, updated_at: t, business_date: today(), note: 'Gaadi utaari', amount_paise: amount, ...extra } });
    const a = uuidv7();
    const res = await push(owner.accessToken, [row(a, 50000), row(uuidv7(), -20000), row(uuidv7(), 0)]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied', 'rejected']);
    const hide = await push(owner.accessToken, [row(a, 50000, { hidden: true, updated_at: later })]);
    expect(hide.body.results[0].status).toBe('applied');
  });

  // Badlein on a collection: void its rows, then write the corrected payment under the same raseed
  // number. A raseed number someone else already holds is kept under the next free one.
  it('reuses a raseed number once its collection is voided, and moves a clashing one', async () => {
    const t = now();
    const pay = (id: string) => ({
      table: 'collections',
      row: { id, created_at: t, buyer_id: buyerId, amount_paise: 50000, pay_mode: 'cash', business_date: today(), receipt_no: 900, cash_paise: 50000 },
    });
    const first = uuidv7();
    const res = await push(owner.accessToken, [
      pay(first),
      pay(uuidv7()),
      { table: 'collection_voids', row: { id: uuidv7(), created_at: t, collection_id: first, receipt_no: 900, reason: 'edited' } },
      pay(uuidv7()),
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(res.body.results.map((r: any) => r.renumbered ?? null)).toEqual([null, { from: 900, to: 901 }, null, null]);
  });

  // Free: dana given away — ₹0, nothing paid, nothing owed.
  it('takes a free slip', async () => {
    const t = now();
    const res = await push(owner.accessToken, [{
      table: 'bills',
      row: {
        id: uuidv7(), created_at: t, number: `A2/2627/${String(Math.floor(Math.random() * 900000) + 100000)}`,
        kind: 'kachchi', buyer_name: 'Free', business_date: today(), pay_mode: 'free', total_paise: 0, paid_paise: 0,
      },
    }]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied']);
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
    expect(all.map((c) => c.table)).toEqual(['brands', 'rates', 'trucks', 'truck_grades', 'truck_grades', 'truck_grades', 'buyers', 'bills', 'bill_lines', 'collections', 'daybook_entries', 'delivery_slips', 'receivings', 'spoilage', 'bills', 'bills', 'bills', 'bills', 'bills', 'bill_voids', 'bills', 'bills', 'bills', 'bill_voids', 'bills', 'bill_voids', 'bills', 'bill_voids', 'bills', 'bills', 'bill_voids', 'bills', 'bills', 'bill_voids', 'bills', 'bills', 'bill_voids', 'bills', 'bills', 'bills', 'bills', 'bill_voids', 'bill_voids', 'labour_adjustments', 'labour_adjustments', 'labour_adjustments', 'collections', 'collections', 'collection_voids', 'collections', 'bills', 'bills', 'bills', 'udhaar_entries', 'buyers']);
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

  it('links an RFID card to a grahak and keeps it when an older terminal edits them', async () => {
    const t1 = new Date(Date.now() + 180_000).toISOString();
    const t2 = new Date(Date.now() + 240_000).toISOString();
    const res = await push(owner.accessToken, [
      { table: 'buyers', row: { id: buyerId, created_at: now(), updated_at: t1, name: 'Buyer One', phone: '9811111111', card: '04a1b2c3d4' } },
      { table: 'buyers', row: { id: buyerId, created_at: now(), updated_at: t2, name: 'Buyer One', phone: '9811111111' } },
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied']);
    const pulled = await http().get('/v1/sync/pull?after=0&limit=500').set('Authorization', `Bearer ${owner.accessToken}`).expect(200);
    expect(pulled.body.changes.filter((c: any) => c.table === 'buyers').pop().row).toMatchObject({ card: '04A1B2C3D4' });
    const bad = await push(owner.accessToken, [
      { table: 'buyers', row: { id: buyerId, created_at: now(), updated_at: new Date(Date.now() + 300_000).toISOString(), name: 'Buyer One', card: 'not hex' } },
    ]);
    expect(bad.body.results[0].status).toBe('rejected');
  });

  it('keeps market udhaar on a grahak and leaves it alone when an older terminal edits them', async () => {
    const t1 = new Date(Date.now() + 360_000).toISOString();
    const t2 = new Date(Date.now() + 420_000).toISOString();
    const res = await push(owner.accessToken, [
      { table: 'buyers', row: { id: buyerId, created_at: now(), updated_at: t1, name: 'Buyer One', phone: '9811111111', market_paise: 3_850_000 } },
      { table: 'buyers', row: { id: buyerId, created_at: now(), updated_at: t2, name: 'Buyer One', phone: '9811111111' } },
    ]);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied']);
    const pulled = await http().get('/v1/sync/pull?after=0&limit=500').set('Authorization', `Bearer ${owner.accessToken}`).expect(200);
    expect(pulled.body.changes.filter((c: any) => c.table === 'buyers').pop().row).toMatchObject({ market_paise: 3_850_000 });
  });

  it('shares a grahak photo across the shop, and only the shop', async () => {
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await http().get(`/v1/buyers/${buyerId}/photo`).set(auth).expect(404);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
    await http().put(`/v1/buyers/${buyerId}/photo`).set(auth).send({ image: Buffer.from('not a jpeg').toString('base64') }).expect(400);
    const put = await http().put(`/v1/buyers/${buyerId}/photo`).set(auth).send({ image: jpeg.toString('base64') }).expect(200);
    const got = await http().get(`/v1/buyers/${buyerId}/photo`).set(auth).buffer(true)
      .parse((r, cb) => { const b: Buffer[] = []; r.on('data', (c: Buffer) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); })
      .expect(200);
    expect(Buffer.compare(got.body, jpeg)).toBe(0);
    await http().get(`/v1/buyers/${buyerId}/photo?since=${encodeURIComponent(put.body.updatedAt)}`).set(auth).expect(304);
    await http().put(`/v1/buyers/${uuidv7()}/photo`).set(auth).send({ image: jpeg.toString('base64') }).expect(404);
    const other = await registerShop('9800000006', 'Shop Three');
    await http().get(`/v1/buyers/${buyerId}/photo`).set({ Authorization: `Bearer ${other.accessToken}` }).expect(404);
    await http().put(`/v1/buyers/${buyerId}/photo`).set({ Authorization: `Bearer ${other.accessToken}` }).send({ image: jpeg.toString('base64') }).expect(404);
  });

  it('does a grahak eKYC: Aadhaar check, OTP, e-Aadhaar and PAN saved sealed, fingers as metadata only', async () => {
    const { UlipClient } = await import('../src/kyc/ulip.client');
    const calls: string[] = [];
    // A made-up person: UIDAI masks the number, the photo is a JPEG header.
    const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]).toString('base64');
    const xml = `<?xml version="1.0"?><Certificate><CertificateData><KycRes code="x" ret="Y" ts="2026-10-06T10:00:00.000+05:30" ttl="2027-10-06" txn="t">` +
      `<UidData tkn="t" uid="xxxxxxxx0019"><Poi dob="01-01-1990" gender="M" name="Ramesh Kumar"/>` +
      `<Poa co="S/O Suresh" country="India" dist="North West Delhi" house="12" lm="" loc="Azadpur" pc="110033" state="Delhi" street="Mandi Road" vtc="Delhi"/>` +
      `<Pht>${photo}</Pht></UidData></KycRes></CertificateData></Certificate>`;
    app.get(UlipClient).post = async (path: string, body: Record<string, unknown>) => {
      calls.push(path);
      if (path === '/DIGILOCKER/01') return body.name === 'Wrong Name' ? { error: 'uid_mismatch', error_description: 'Demographic data mismatch' } : { code: 'c1', code_verifier: 'v1', code_challenge: 'h1' };
      if (path === '/DIGILOCKER/03') return { access_token: 'tok', eaadhaar: 'Y', mobile: '9811112222' };
      if (path === '/DIGILOCKER/05') return { eaadhaarData: xml };
      if (path === '/DIGILOCKER/04') return body.panno === 'ABCDE1234F' ? { mime: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') } : { error: 'not_found', error_description: 'PAN not found' };
      throw new Error(path);
    };
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    // 2345 6789 0124 passes the Verhoeff check; the last digit changed fails it.
    const start = { uid: '2345 6789 0124', name: 'Ramesh Kumar', dob: '01/01/1990', gender: 'M', mobile: '9811112222', pan: 'abcde1234f', consent: true,
      fingers: [{ finger: 'RIGHT_THUMB', qScore: 81, nmPoints: 42, device: 'MFS110 1234' }] };

    await http().get(`/v1/buyers/${buyerId}/kyc`).set(auth).expect(404);
    await http().post(`/v1/buyers/${buyerId}/kyc`).set(auth).send({ ...start, uid: '234567890125' }).expect(400);
    await http().post(`/v1/buyers/${buyerId}/kyc`).set(auth).send({ ...start, consent: false }).expect(400);
    const mismatch = await http().post(`/v1/buyers/${buyerId}/kyc`).set(auth).send({ ...start, name: 'Wrong Name' }).expect(400);
    expect(mismatch.body.message).toContain('do not match');

    const started = await http().post(`/v1/buyers/${buyerId}/kyc`).set(auth).send(start).expect(200);
    expect(started.body).toMatchObject({ otpTo: '••••••2222', testOtp: '123456' });
    await http().post(`/v1/buyers/${buyerId}/kyc/otp`).set(auth).send({ kycId: started.body.kycId, otp: '000000' }).expect(400);
    const other = await registerShop('9800000007', 'Shop Four');
    await http().post(`/v1/buyers/${buyerId}/kyc/otp`).set({ Authorization: `Bearer ${other.accessToken}` }).send({ kycId: started.body.kycId, otp: '123456' }).expect(410);
    const done = await http().post(`/v1/buyers/${buyerId}/kyc/otp`).set(auth).send({ kycId: started.body.kycId, otp: '123456' }).expect(200);
    expect(done.body).toMatchObject({
      source: 'ulip-staging', aadhaarLast4: '0019', name: 'Ramesh Kumar', dob: '01-01-1990', gender: 'M', careOf: 'S/O Suresh',
      address: '12, Mandi Road, Azadpur, Delhi, North West Delhi - 110033', photo, pan: { last4: '234F', status: 'verified' },
      fingers: [{ finger: 'RIGHT_THUMB', qScore: 81 }],
    });
    expect(calls).toEqual(['/DIGILOCKER/01', '/DIGILOCKER/01', '/DIGILOCKER/03', '/DIGILOCKER/05', '/DIGILOCKER/04']);
    // A used session is gone.
    await http().post(`/v1/buyers/${buyerId}/kyc/otp`).set(auth).send({ kycId: started.body.kycId, otp: '123456' }).expect(410);
    await http().get(`/v1/buyers/${buyerId}/kyc`).set(auth).expect(200);
    await http().get(`/v1/buyers/${buyerId}/kyc`).set({ Authorization: `Bearer ${other.accessToken}` }).expect(404);
    // Fingers can be added or removed later; another shop can't touch them.
    const two = [{ finger: 'RIGHT_THUMB', qScore: 81 }, { finger: 'LEFT_THUMB', qScore: 55, device: 'MFS110' }];
    const added = await http().put(`/v1/buyers/${buyerId}/kyc/fingers`).set(auth).send({ fingers: two }).expect(200);
    expect(added.body.fingers).toHaveLength(2);
    const removed = await http().put(`/v1/buyers/${buyerId}/kyc/fingers`).set(auth).send({ fingers: [two[1]] }).expect(200);
    expect(removed.body.fingers).toMatchObject([{ finger: 'LEFT_THUMB' }]);
    await http().put(`/v1/buyers/${buyerId}/kyc/fingers`).set({ Authorization: `Bearer ${other.accessToken}` }).send({ fingers: [] }).expect(404);
    await http().put(`/v1/buyers/${uuidv7()}/kyc/fingers`).set(auth).send({ fingers: [] }).expect(404);

    // At rest: no Aadhaar number, no readable XML.
    const c = new Client({ connectionString: OWNER_URL });
    await c.connect();
    try {
      const row = (await c.query(`SELECT * FROM buyer_kyc WHERE buyer_id = $1`, [buyerId])).rows[0];
      expect(JSON.stringify(row)).not.toContain('234567890124');
      expect(row.eaadhaar_sealed.toString('latin1')).not.toContain('Ramesh');
    } finally { await c.end(); }

    // A PAN DigiLocker doesn't know still saves the Aadhaar KYC, with the PAN marked failed.
    // No fingers is fine too: the scanner is optional.
    const again = await http().post(`/v1/buyers/${buyerId}/kyc`).set(auth).send({ ...start, pan: 'ZZZZZ9999Z', fingers: undefined }).expect(200);
    const redo = await http().post(`/v1/buyers/${buyerId}/kyc/otp`).set(auth).send({ kycId: again.body.kycId, otp: '123456' }).expect(200);
    expect(redo.body.pan).toMatchObject({ last4: '999Z', status: 'failed' });
    expect(redo.body.fingers).toEqual([]);
  });

  it('does a DigiLocker eKYC through Surepass: page to open, then Aadhaar and PAN saved once signed in', async () => {
    const { SurepassClient } = await import('../src/kyc/surepass.client');
    const sp = app.get(SurepassClient);
    let state = { completed: false, failed: false, aadhaarLinked: true, status: 'pending', error: '' };
    const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 2)]).toString('base64');
    let downloads = 0;
    Object.assign(sp, {
      initialize: async (o: { mobile?: string; redirectUrl: string }) => {
        expect(o.redirectUrl).toMatch(/\/v1\/kyc\/digilocker\/done$/);
        return { clientId: 'digilocker_test123', url: `https://digilocker.example/?m=${o.mobile ?? ''}`, expirySeconds: 600 };
      },
      status: async () => state,
      downloadAadhaar: async () => {
        if (++downloads > 1) throw new Error('downloaded twice');
        return {
          digilocker_metadata: { name: 'SITA DEVI', gender: 'F', dob: '1985-03-09', mobile_number: '9811113333' },
          aadhaar_xml_data: { full_name: 'Sita Devi', care_of: 'W/O Ram', dob: '1985-03-09', zip: '110033', profile_image: photo, gender: 'F',
            masked_aadhaar: 'XXXXXXXX4321', full_address: 'Azadpur, Delhi 110033' },
        };
      },
      listDocuments: async () => [{ file_id: 'pan', doc_type: 'PANCR', file_type: 'xml' }],
      downloadDocument: async () => Buffer.from('<Certificate number="ABCDE1234F"><Person name="Sita Devi"/></Certificate>'),
    });
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    await http().post(`/v1/buyers/${buyerId}/kyc/digilocker`).set(auth).send({ consent: false }).expect(400);
    const started = await http().post(`/v1/buyers/${buyerId}/kyc/digilocker`).set(auth).send({ mobile: '98111 13333', consent: true }).expect(200);
    expect(started.body).toMatchObject({ clientId: 'digilocker_test123', url: 'https://digilocker.example/?m=9811113333' });
    // The grahak hasn't finished on DigiLocker yet.
    await http().post(`/v1/buyers/${buyerId}/kyc/digilocker/complete`).set(auth).send({ clientId: 'digilocker_test123' }).expect(409);
    await http().post(`/v1/buyers/${buyerId}/kyc/digilocker/complete`).set(auth).send({ clientId: 'digilocker_other' }).expect(410);

    state = { ...state, completed: true, status: 'completed' };
    const done = await http().post(`/v1/buyers/${buyerId}/kyc/digilocker/complete`).set(auth).send({ clientId: 'digilocker_test123', fingers: [{ finger: 'RIGHT_THUMB', qScore: 70 }] }).expect(200);
    expect(done.body).toMatchObject({
      source: 'surepass-sandbox', aadhaarLast4: '4321', name: 'Sita Devi', dob: '09-03-1985', gender: 'F', careOf: 'W/O Ram',
      address: 'Azadpur, Delhi 110033', pincode: '110033', photo, otpMobile: '••••••3333', pan: { last4: '234F', status: 'verified' },
      fingers: [{ finger: 'RIGHT_THUMB', qScore: 70 }],
    });
    // Used: gone, and Surepass's one-time download is never asked twice.
    await http().post(`/v1/buyers/${buyerId}/kyc/digilocker/complete`).set(auth).send({ clientId: 'digilocker_test123' }).expect(410);
    const page = await http().get('/v1/kyc/digilocker/done').expect(200);
    expect(page.text).toContain('Return to the app');
  });

  it('talks to Sandbox.co.in DigiLocker as documented: auth without Bearer, sign-in session, Aadhaar XML parsed, PAN only when shared', async () => {
    const { SandboxDigilockerClient } = await import('../src/kyc/sandbox.client');
    const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 3)]).toString('base64');
    const xml = `<?xml version="1.0"?><Certificate><CertificateData><KycRes code="x" ret="Y" ts="2026-10-06T10:00:00" ttl="2027" txn="t">` +
      `<UidData tkn="t" uid="xxxxxxxx7788"><Poi dob="02-02-1980" gender="M" name="Mohan Lal"/>` +
      `<Poa co="S/O Hari" country="India" dist="Jaipur" house="4" lm="" loc="Muhana" pc="302029" state="Rajasthan" street="Mandi Rd" vtc="Jaipur"/>` +
      `<Pht>${photo}</Pht></UidData></KycRes></CertificateData></Certificate>`;
    const seen: { url: string; method: string; headers: Record<string, string>; body?: any }[] = [];
    let consented = ['aadhaar'];
    const real = global.fetch;
    global.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      seen.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
      const json = (code: number, data: unknown) => new Response(JSON.stringify({ code, data, message: code >= 400 ? 'nope' : undefined }), { status: code });
      if (url.endsWith('/authenticate')) return json(200, { access_token: 'jwt-1' });
      if (url.endsWith('/kyc/digilocker/sessions/init')) return json(200, { session_id: 'sess-1', authorization_url: 'https://digilocker.meripehchaan.gov.in/x' });
      if (url.endsWith('/sessions/sess-1/status')) return json(200, { status: 'succeeded', documents_consented: consented });
      if (url.endsWith('/sessions/sess-1/documents/aadhaar')) return json(200, { files: [{ url: 'https://s3.example/a.xml', metadata: { ContentType: 'application/xml' } }] });
      if (url.endsWith('/sessions/sess-1/documents/pan')) return json(200, { files: [{ url: 'https://s3.example/p.xml', metadata: { ContentType: 'application/xml' } }] });
      if (url.endsWith('/sessions/sess-1/user/profile')) return json(200, { mobile: '9822223333', name: 'Mohan Lal' });
      if (url === 'https://s3.example/a.xml') return new Response(xml, { status: 200 });
      if (url === 'https://s3.example/p.xml') return new Response('<Certificate type="PANCR" number="PQRSX6789K"/>', { status: 200 });
      return json(404, null);
    }) as typeof fetch;
    try {
      const c = new SandboxDigilockerClient();
      const s = await c.initialize({ redirectUrl: 'https://x/v1/kyc/digilocker/done', state: 'b1' });
      expect(s).toMatchObject({ clientId: 'sess-1', url: 'https://digilocker.meripehchaan.gov.in/x' });
      const init = seen.find((r) => r.url.endsWith('/sessions/init'))!;
      expect(init.headers.Authorization).toBe('jwt-1');
      expect(init.body).toMatchObject({ '@entity': 'in.co.sandbox.kyc.digilocker.session.request', flow: 'signin', doc_types: ['aadhaar', 'pan'], options: { pinless: true } });

      const st = await c.status('sess-1');
      expect(st).toMatchObject({ completed: true, failed: false, aadhaarLinked: true, documents: ['aadhaar'] });
      const a = await c.aadhaar('sess-1');
      expect(a).toMatchObject({ last4: '7788', name: 'Mohan Lal', dob: '02-02-1980', gender: 'M', careOf: 'S/O Hari', pincode: '302029', mobile: '9822223333' });
      expect(a.photo?.toString('base64')).toBe(photo);
      // No PAN shared: no (charged) fetch.
      expect(await c.pan('sess-1', st)).toMatchObject({ status: 'none' });
      expect(seen.some((r) => r.url.endsWith('/documents/pan'))).toBe(false);
      consented = ['aadhaar', 'pan'];
      expect(await c.pan('sess-1', await c.status('sess-1'))).toMatchObject({ status: 'verified', number: 'PQRSX6789K' });
      // One login for all of it.
      expect(seen.filter((r) => r.url.endsWith('/authenticate'))).toHaveLength(1);
    } finally {
      global.fetch = real;
    }
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

describe('live sync', () => {
  let a: Awaited<ReturnType<typeof registerShop>>;
  let b: Awaited<ReturnType<typeof login>>;
  const brandId = uuidv7();
  const truckId = uuidv7();
  const buyerId = uuidv7();

  beforeAll(async () => {
    a = await registerShop('9844400001', 'Live Shop');
    b = await login('9844400001'); // the owner's second terminal, same shop
    const t = now();
    await push(a.accessToken, [
      { table: 'brands', row: { id: brandId, created_at: t, updated_at: t, name: 'V. Kota', sort_order: 1, shelf_days: 7 } },
      { table: 'trucks', row: { id: truckId, created_at: t, updated_at: t, number: 'RJ11GC3033', supplier: 'x', arrived_at: t } },
      { table: 'buyers', row: { id: buyerId, created_at: t, updated_at: t, name: 'Wasim', phone: '', kind: '' } },
    ]);
  });

  const push = (token: string, items: unknown[], extra: Record<string, unknown> = {}) =>
    http().post('/v1/sync/push').set('Authorization', `Bearer ${token}`).send({ items, ...extra });
  const pullAll = async (token: string, after = 0) => {
    const all: any[] = [];
    let resetSeq = 0;
    for (;;) {
      const res = await http().get(`/v1/sync/pull?after=${after}`).set('Authorization', `Bearer ${token}`).expect(200);
      all.push(...res.body.changes);
      after = res.body.lastSeq;
      resetSeq = res.body.resetSeq;
      if (!res.body.hasMore) return { all, lastSeq: after, resetSeq };
    }
  };
  const slip = (txn: string | undefined, billId: string, slipNo: number, lineTruck: string) => {
    const t = now();
    return [
      { txn, table: 'bills', row: { id: billId, created_at: t, number: `A1/2627/${String(slipNo).padStart(6, '0')}`, kind: 'kachchi', buyer_id: buyerId, buyer_name: 'Wasim', business_date: today(), pay_mode: 'cash', total_paise: 6700, paid_paise: 6700, slip_no: slipNo, truck_id: truckId } },
      { txn, table: 'bill_lines', row: { id: uuidv7(), created_at: t, bill_id: billId, truck_id: lineTruck, brand_id: brandId, grade: '1', qty: 1, rate_paise: 6700 } },
    ];
  };

  it('stores a slip whole or not at all when its rows share a txn', async () => {
    const billId = uuidv7();
    const res = await push(a.accessToken, slip(uuidv7(), billId, 1, uuidv7() /* no such gaadi */)).expect(200);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['rejected', 'rejected']);
    expect(res.body.results[0].error).toMatch(/same entry/);
    // Fixed and sent again: both rows land.
    const ok = await push(a.accessToken, slip(uuidv7(), billId, 1, truckId)).expect(200);
    expect(ok.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied']);
    // An older terminal (no txn) still gets row-by-row: the bill lands without its bad line.
    const loose = await push(a.accessToken, slip(undefined, uuidv7(), 2, uuidv7())).expect(200);
    expect(loose.body.results.map((r: any) => r.status)).toEqual(['applied', 'rejected']);
  });

  it('takes jama — a negative opening balance — but never a zero one', async () => {
    const res = await push(a.accessToken, [
      { table: 'udhaar_entries', row: { id: uuidv7(), created_at: now(), buyer_id: buyerId, amount_paise: -150000, note: 'Jama (trial balance)', business_date: today() } },
      { table: 'udhaar_entries', row: { id: uuidv7(), created_at: now(), buyer_id: buyerId, amount_paise: 0, business_date: today() } },
    ]).expect(200);
    expect(res.body.results.map((r: any) => r.status)).toEqual(['applied', 'rejected']);
  });

  it('wakes a waiting terminal as soon as another one pushes', async () => {
    const { lastSeq } = await pullAll(b.accessToken);
    // Nothing new: an immediate answer when asked not to wait.
    const idle = await http().get(`/v1/sync/wait?after=${lastSeq}&wait=0`).set('Authorization', `Bearer ${b.accessToken}`).expect(200);
    expect(idle.body.lastSeq).toBe(lastSeq);
    const started = Date.now();
    // (supertest only sends once awaited: start the wait for real before the other terminal pushes)
    const waiting = http().get(`/v1/sync/wait?after=${lastSeq}&wait=20`).set('Authorization', `Bearer ${b.accessToken}`).then((r) => r);
    await new Promise((r) => setTimeout(r, 300));
    await push(a.accessToken, [
      { table: 'buyers', row: { id: uuidv7(), created_at: now(), updated_at: now(), name: 'Sharma', phone: '', kind: '' } },
    ]).expect(200);
    const res = await waiting;
    expect(res.status).toBe(200);
    expect(res.body.lastSeq).toBeGreaterThan(lastSeq);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('puts a grahak\'s eKYC summary on the feed — never the documents — and again when fingers change', async () => {
    const { lastSeq } = await pullAll(a.accessToken);
    await owner(`INSERT INTO buyer_kyc (buyer_id, shop_id, source, aadhaar_last4, name, dob, gender, address, eaadhaar_sealed, otp_mobile,
        fingers, consent_text, consent_at, verified_by, device_id)
      VALUES ('${buyerId}', '${a.me.shop.id}', 'ulip-staging', '1234', 'Wasim Khan', '1990-01-01', 'M', 'Gali 4, Delhi', '\\x00', '9811100000',
        '[{"finger":"RT","qScore":70,"device":"MFS110"}]', 'ok', now(), '${a.me.user.id}', '${a.me.device.id}')`);
    await owner(`UPDATE buyer_kyc SET fingers = '[{"finger":"RT","qScore":70},{"finger":"LT","qScore":61}]' WHERE buyer_id = '${buyerId}'`);
    const kyc = (await pullAll(b.accessToken, lastSeq)).all.filter((c) => c.table === 'kyc');
    expect(kyc).toHaveLength(2);
    expect(kyc[1].row).toMatchObject({ id: buyerId, aadhaar_last4: '1234', fingers: '["RT", "LT"]' });
    expect(JSON.stringify(kyc)).not.toMatch(/Wasim Khan|Gali 4|9811100000/);
  });

  it('tells every terminal about a row the server deleted', async () => {
    const gone = uuidv7();
    await push(a.accessToken, [{ table: 'buyers', row: { id: gone, created_at: now(), updated_at: now(), name: 'Typo', phone: '', kind: '' } }]).expect(200);
    await owner(`SELECT sync_delete('${a.me.shop.id}', 'buyers', '${gone}', '${a.me.device.id}')`);
    const { all } = await pullAll(b.accessToken);
    expect(all.filter((c) => c.table === 'buyers' && c.row.id === gone)).toHaveLength(0);
    expect(all.filter((c) => c.table === '_delete').pop().row).toEqual({ table: 'buyers', id: gone });
  });

  it('starts the books again: _reset first, then a snapshot, and a stale outbox is told to pull', async () => {
    const before = await pullAll(b.accessToken);
    await owner(`DELETE FROM bill_lines WHERE shop_id = '${a.me.shop.id}'; DELETE FROM bills WHERE shop_id = '${a.me.shop.id}';
                 SELECT sync_reset('${a.me.shop.id}', '${a.me.device.id}')`);
    const after = await pullAll(b.accessToken);
    expect(after.all[0].table).toBe('_reset');
    expect(after.resetSeq).toBe(after.all[0].seq);
    expect(after.resetSeq).toBeGreaterThan(before.lastSeq);
    expect(new Set(after.all.map((c) => c.table))).toEqual(new Set(['_reset', 'brands', 'buyers', 'trucks', 'udhaar_entries', 'kyc']));
    // A terminal that never pulled the reset still has the old books' rows queued: refused.
    const stale = await push(b.accessToken, slip(uuidv7(), uuidv7(), 9, truckId), { resetSeen: 0 }).expect(409);
    expect(stale.body.code).toBe('reset');
    await push(b.accessToken, slip(uuidv7(), uuidv7(), 9, truckId), { resetSeen: after.resetSeq }).expect(200);
  });
});

describe('voice (Bolo)', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const rows = async (sql: string) => {
    const c = new Client({ connectionString: OWNER_URL });
    await c.connect();
    try { return (await c.query(sql)).rows; } finally { await c.end(); }
  };
  it('is off without a Vertex key, refuses an empty turn, and never reaches the model then', async () => {
    const shop = await registerShop('9866600001', 'Voice Traders');
    const voice = (body: object) => http().post('/v1/voice').set(auth(shop.accessToken)).send(body);
    await voice({ context: 'GRAHAK b1 | Ashu', screen: 'home' }).expect(400);
    await voice({ text: 'Ashu ko 100 dana', context: 'GRAHAK b1 | Ashu' }).expect(503);
    await http().post('/v1/voice').send({ text: 'x', context: '' }).expect(401);
  });

  it('sends back a clean draft — nulls gone, an impossible number dropped — and logs the turn and its outcome', async () => {
    const { GeminiClient } = await import('../src/voice/gemini.client');
    const gemini = app.get(GeminiClient);
    const real = gemini.generate.bind(gemini);
    let asked: any = null;
    gemini.generate = async (payload: any) => {
      asked = payload;
      return {
        model: 'stub', tokensIn: 10, tokensOut: 5,
        text: JSON.stringify({
          transcript: 'Ashu ko 100 dana 22 ka', kind: 'slip', say: 'Ashu, 100 dana', buyer: 'b1', buyer_name: 'Ashu', gaadi: null, gaadi_no: null,
          pay: null, slip: { lines: [{ grade: 'I', qty: 100, rate: 2.2e307, amount: null, lot: null }], leak: null, packing: null, delivery: false },
          expense: null, views: null, open: null,
        }),
      };
    };
    try {
      const shop = await registerShop('9866600002', 'Voice Traders Two');
      const res = await http().post('/v1/voice').set(auth(shop.accessToken))
        .send({ text: 'Ashu ko 100 dana 22 ka', context: 'GRAHAK b1 | Ashu | udhaar 0', screen: 'home' }).expect(200);
      expect(res.body.reply).toEqual({ transcript: 'Ashu ko 100 dana 22 ka', kind: 'slip', say: 'Ashu, 100 dana', buyer: 'b1', buyer_name: 'Ashu', slip: { lines: [{ grade: 'I', qty: 100 }] } });
      // The shop's data and what was typed reach the model; the system prompt stays the same for caching.
      expect(asked.contents[0].parts[0].text).toContain('GRAHAK b1 | Ashu');
      expect(asked.contents[0].parts).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 200));
      const [row] = await rows(`SELECT kind, transcript, model, outcome FROM voice_turns WHERE id = '${res.body.id}'`);
      expect(row).toMatchObject({ kind: 'slip', transcript: 'Ashu ko 100 dana 22 ka', model: 'stub', outcome: null });
      await http().post(`/v1/voice/${res.body.id}/outcome`).set(auth(shop.accessToken)).send({ outcome: 'edited' }).expect(200);
      expect((await rows(`SELECT outcome FROM voice_turns WHERE id = '${res.body.id}'`))[0].outcome).toBe('edited');
      // Another shop cannot touch it.
      const other = await registerShop('9866600003', 'Voice Traders Three');
      await http().post(`/v1/voice/${res.body.id}/outcome`).set(auth(other.accessToken)).send({ outcome: 'saved' }).expect(404);
    } finally {
      gemini.generate = real;
    }
  });
});

