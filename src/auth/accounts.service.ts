import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '../common/uuid';
import { Db, Tx } from '../db/db.service';
import { Principal, Tokens, TokensService } from './tokens.service';

export type DeviceInfo = { label: string; platform: string; appVersion: string };

export type MeView = {
  user: { id: string; phone: string; name: string };
  device: { id: string; code: string | null };
  shop: { id: string; name: string; mandi: string; shopNo: string; phad: string; gstin: string; role: string; slipLimitPaise: number; phone: string; dispatchPhone: string; address: string; bankAccounts: BankAccount[]; commodity: string; printer: { host: string; dots: number } } | null;
};

/** How the app names a role; the table keeps the older words. */
export type TeamRole = 'admin' | 'accountant';
const toDb = (r: TeamRole) => (r === 'admin' ? 'owner' : 'munim');
const fromDb = (r: string): TeamRole => (r === 'owner' ? 'admin' : 'accountant');

/** One account a customer can pay into, printed at the head of their ledger. */
export type BankAccount = { holder: string; bank: string; ifsc: string; account: string };

export type Member = { userId: string; phone: string; name: string; role: TeamRole; you: boolean; joinedAt: string };

/** Series codes a shop's devices get, in order: A1…A9, B1…Z9 (234 devices per shop). */
const DEVICE_CODES = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))
  .flatMap((l) => Array.from({ length: 9 }, (_, d) => `${l}${d + 1}`));

@Injectable()
export class AccountsService {
  constructor(private readonly db: Db, private readonly tokens: TokensService) {}

  /** After a verified OTP: find-or-create the user, register (or re-use) the device, open a session. */
  async login(phone: string, deviceId: string | undefined, info: DeviceInfo): Promise<Tokens & { me: MeView }> {
    return this.db.tx(async (tx) => {
      await tx.query(`INSERT INTO users (id, phone) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING`, [uuidv7(), phone]);
      const userId = (await tx.query<{ id: string }>(`SELECT id FROM users WHERE phone = $1`, [phone])).rows[0].id;

      // Re-using the device keeps its series code, so its bill numbers stay consecutive.
      let device = deviceId
        ? (await tx.query<{ id: string }>(`SELECT id FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [deviceId, userId])).rows[0]
        : undefined;
      if (device) {
        await tx.query(`UPDATE devices SET label = $2, platform = $3, app_version = $4 WHERE id = $1`, [device.id, info.label, info.platform, info.appVersion]);
      } else {
        device = { id: uuidv7() };
        await tx.query(
          `INSERT INTO devices (id, user_id, label, platform, app_version) VALUES ($1, $2, $3, $4, $5)`,
          [device.id, userId, info.label, info.platform, info.appVersion],
        );
      }

      // A returning owner on a new terminal joins their existing shop straight away.
      const unattached = (await tx.query<{ shop_id: string | null }>(`SELECT shop_id FROM devices WHERE id = $1`, [device.id])).rows[0].shop_id === null;
      if (unattached) {
        const membership = (await tx.query<{ shop_id: string }>(
          `SELECT shop_id FROM shop_members WHERE user_id = $1 ORDER BY created_at LIMIT 1`, [userId],
        )).rows[0];
        if (membership) await this.attachDevice(tx, membership.shop_id, device.id);
      }

      const principal = await this.tokens.principalFor(tx, userId, device.id);
      const tokens = await this.tokens.issue(tx, principal);
      return { ...tokens, me: await this.me(tx, principal) };
    });
  }

  /** Registers the caller's shop (the sketch's "customer registration") and attaches this device. */
  async createShop(p: Principal, shop: { name: string; mandi: string; shopNo: string; phad?: string; gstin: string; role: string; ownerName: string; commodity?: string }):
    Promise<{ accessToken: string; me: MeView }> {
    return this.db.tx(async (tx) => {
      const existing = (await tx.query(`SELECT 1 FROM shop_members WHERE user_id = $1`, [p.userId])).rowCount;
      if (existing) throw new ConflictException('Is number se dukaan pehle se registered hai');

      const shopId = uuidv7();
      await tx.query(
        `INSERT INTO shops (id, name, mandi, shop_no, phad, gstin, created_by, join_code, phone, commodity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT phone FROM users WHERE id = $7), $9)`,
        [shopId, shop.name, shop.mandi, shop.shopNo, shop.phad ?? '', shop.gstin, p.userId, await this.freshCode(tx), shop.commodity ?? 'nariyal'],
      );
      await tx.query(`INSERT INTO shop_members (shop_id, user_id, role) VALUES ($1, $2, $3)`, [shopId, p.userId, shop.role]);
      // shop_counters is tenant-scoped: row-level security needs this transaction to be the new shop.
      await tx.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
      await tx.query(`INSERT INTO shop_counters (shop_id) VALUES ($1)`, [shopId]);
      if (shop.ownerName) await tx.query(`UPDATE users SET name = $2 WHERE id = $1 AND name = ''`, [p.userId, shop.ownerName]);
      await this.attachDevice(tx, shopId, p.deviceId);

      const principal = await this.tokens.principalFor(tx, p.userId, p.deviceId);
      return { accessToken: this.tokens.signAccess(principal), me: await this.me(tx, principal) };
    });
  }

  /**
   * Also the moment a device picks up a shop it was added to after logging in: an admin may
   * have added this number while the app sat on the "no shop yet" screen.
   */
  async meFor(p: Principal): Promise<MeView & { accessToken?: string }> {
    return this.db.tx(async (tx) => {
      const attached = await this.attachIfMember(tx, p.userId, p.deviceId);
      if (!attached) return this.me(tx, p);
      const principal = await this.tokens.principalFor(tx, p.userId, p.deviceId);
      return { ...(await this.me(tx, principal)), accessToken: this.tokens.signAccess(principal) };
    });
  }

  /** Joins the shop whose code this is, as an accountant, and attaches this device. */
  async joinShop(p: Principal, code: string): Promise<{ accessToken: string; me: MeView }> {
    return this.db.tx(async (tx) => {
      const existing = (await tx.query(`SELECT 1 FROM shop_members WHERE user_id = $1`, [p.userId])).rowCount;
      if (existing) throw new ConflictException('Yeh number pehle se ek dukaan mein hai');
      const shop = (await tx.query<{ id: string }>(`SELECT id FROM shops WHERE join_code = $1`, [code])).rows[0];
      if (!shop) throw new NotFoundException('Yeh code kisi dukaan ka nahi hai');
      await tx.query(`INSERT INTO shop_members (shop_id, user_id, role) VALUES ($1, $2, 'munim')`, [shop.id, p.userId]);
      await this.attachDevice(tx, shop.id, p.deviceId);
      const principal = await this.tokens.principalFor(tx, p.userId, p.deviceId);
      return { accessToken: this.tokens.signAccess(principal), me: await this.me(tx, principal) };
    });
  }

  /** The team, newest last; the join code only for admins. */
  async team(p: Principal): Promise<{ members: Member[]; joinCode: string | null; youAreAdmin: boolean }> {
    return this.db.tx(async (tx) => {
      const role = await this.roleOf(tx, p);
      const { rows } = await tx.query<{ user_id: string; phone: string; name: string; role: string; created_at: Date }>(
        `SELECT m.user_id, u.phone, u.name, m.role, m.created_at FROM shop_members m JOIN users u ON u.id = m.user_id
         WHERE m.shop_id = $1 ORDER BY m.created_at`, [p.shopId],
      );
      const code = role === 'admin'
        ? (await tx.query<{ join_code: string }>(`SELECT join_code FROM shops WHERE id = $1`, [p.shopId])).rows[0].join_code
        : null;
      return {
        members: rows.map((r) => ({ userId: r.user_id, phone: r.phone, name: r.name, role: fromDb(r.role), you: r.user_id === p.userId, joinedAt: r.created_at.toISOString() })),
        joinCode: code,
        youAreAdmin: role === 'admin',
      };
    });
  }

  /** Adds a mobile number to the team; the person's first login lands in this shop. */
  async addMember(p: Principal, phone: string, name: string, role: TeamRole) {
    return this.db.tx(async (tx) => {
      await this.requireAdmin(tx, p);
      await tx.query(`INSERT INTO users (id, phone, name) VALUES ($1, $2, $3) ON CONFLICT (phone) DO NOTHING`, [uuidv7(), phone, name]);
      const user = (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM users WHERE phone = $1`, [phone])).rows[0];
      if (name && !user.name) await tx.query(`UPDATE users SET name = $2 WHERE id = $1`, [user.id, name]);
      const other = (await tx.query<{ shop_id: string }>(`SELECT shop_id FROM shop_members WHERE user_id = $1`, [user.id])).rows[0];
      if (other && other.shop_id === p.shopId) throw new ConflictException('Yeh number pehle se team mein hai');
      if (other) throw new ConflictException('Yeh number doosri dukaan mein hai');
      await tx.query(`INSERT INTO shop_members (shop_id, user_id, role) VALUES ($1, $2, $3)`, [p.shopId, user.id, toDb(role)]);
    });
  }

  /** Promotes to admin or back to accountant; the last admin cannot step down. */
  async setRole(p: Principal, userId: string, role: TeamRole) {
    return this.db.tx(async (tx) => {
      await this.requireAdmin(tx, p);
      const member = (await tx.query<{ role: string }>(`SELECT role FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [p.shopId, userId])).rows[0];
      if (!member) throw new NotFoundException('Yeh team mein nahi hai');
      if (role === 'accountant' && member.role === 'owner') await this.keepOneAdmin(tx, p.shopId!);
      await tx.query(`UPDATE shop_members SET role = $3 WHERE shop_id = $1 AND user_id = $2`, [p.shopId, userId, toDb(role)]);
    });
  }

  /**
   * Takes someone off the team. Their devices in this shop are revoked, so the next request
   * from any of them is refused — not whenever their token happens to expire.
   */
  async removeMember(p: Principal, userId: string) {
    return this.db.tx(async (tx) => {
      await this.requireAdmin(tx, p);
      const member = (await tx.query<{ role: string }>(`SELECT role FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [p.shopId, userId])).rows[0];
      if (!member) throw new NotFoundException('Yeh team mein nahi hai');
      if (member.role === 'owner') await this.keepOneAdmin(tx, p.shopId!);
      await tx.query(`DELETE FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [p.shopId, userId]);
      await tx.query(
        `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL AND device_id IN (SELECT id FROM devices WHERE user_id = $1 AND shop_id = $2)`,
        [userId, p.shopId],
      );
      await tx.query(`UPDATE devices SET revoked_at = now() WHERE user_id = $1 AND shop_id = $2 AND revoked_at IS NULL`, [userId, p.shopId]);
    });
  }

  /** Any member: the most an accountant's slip may come to before it needs approval; 0 = no limit. */
  async setSlipLimit(p: Principal, paise: number) {
    return this.db.tx(async (tx) => {
      await this.requireMember(tx, p);
      await tx.query(`UPDATE shops SET slip_limit_paise = $2 WHERE id = $1`, [p.shopId, paise]);
    });
  }

  /** Any member: what the shop sells — tender coconut or amrud. */
  async setCommodity(p: Principal, commodity: string) {
    return this.db.tx(async (tx) => {
      await this.requireMember(tx, p);
      await tx.query(`UPDATE shops SET commodity = $2 WHERE id = $1`, [p.shopId, commodity]);
    });
  }

  /** Any member: the shop's full address and bank accounts, printed at the head of every ledger. */
  async setLedgerDetails(p: Principal, address: string, bankAccounts: BankAccount[]) {
    return this.db.tx(async (tx) => {
      await this.requireMember(tx, p);
      await tx.query(`UPDATE shops SET address = $2, bank_accounts = $3 WHERE id = $1`, [p.shopId, address, JSON.stringify(bankAccounts)]);
    });
  }

  /**
   * Any member: the shop's WiFi printer. Whoever is in the office and finds it saves it for
   * everyone — the accountant setting up the printer shouldn't need the owner's phone.
   */
  async setPrinter(p: Principal, host: string, dots: number) {
    return this.db.tx(async (tx) => {
      const { rows } = await tx.query(`SELECT 1 FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [p.shopId, p.userId]);
      if (!rows[0]) throw new ForbiddenException('Not a member of this shop');
      await tx.query(`UPDATE shops SET printer_host = $2, printer_dots = $3 WHERE id = $1`, [p.shopId, host, dots]);
    });
  }

  /** Any member: the mobile number printed on the shop's slips. */
  /** [dispatchPhone] left undefined keeps the shop's; '' clears it. */
  async setShopPhone(p: Principal, phone: string, dispatchPhone?: string) {
    return this.db.tx(async (tx) => {
      await this.requireMember(tx, p);
      await tx.query(`UPDATE shops SET phone = $2 WHERE id = $1`, [p.shopId, phone]);
      if (dispatchPhone !== undefined) await tx.query(`UPDATE shops SET dispatch_phone = $2 WHERE id = $1`, [p.shopId, dispatchPhone]);
    });
  }

  /** A new join code; the old one stops working. */
  async newJoinCode(p: Principal): Promise<{ joinCode: string }> {
    return this.db.tx(async (tx) => {
      await this.requireAdmin(tx, p);
      const code = await this.freshCode(tx);
      await tx.query(`UPDATE shops SET join_code = $2 WHERE id = $1`, [p.shopId, code]);
      return { joinCode: code };
    });
  }

  /** Role read from the table, never from the token: a promotion or removal counts at once. */
  private async roleOf(tx: Tx, p: Principal): Promise<TeamRole> {
    if (!p.shopId) throw new ForbiddenException('Pehle dukaan se judein');
    const r = (await tx.query<{ role: string }>(`SELECT role FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [p.shopId, p.userId])).rows[0];
    if (!r) throw new ForbiddenException('Aap is dukaan ki team mein nahi hain');
    return fromDb(r.role);
  }

  /**
   * Any member of the shop. The owners asked for accountants to have every power they have
   * ("owner is not available all the times"); only who is on the team stays with an admin.
   */
  private async requireMember(tx: Tx, p: Principal) {
    await this.roleOf(tx, p);
  }

  private async requireAdmin(tx: Tx, p: Principal) {
    if ((await this.roleOf(tx, p)) !== 'admin') throw new ForbiddenException('Yeh sirf admin kar sakte hain');
  }

  private async keepOneAdmin(tx: Tx, shopId: string) {
    const admins = (await tx.query(`SELECT 1 FROM shop_members WHERE shop_id = $1 AND role = 'owner'`, [shopId])).rowCount ?? 0;
    if (admins <= 1) throw new BadRequestException('Dukaan mein kam se kam ek admin rehna chahiye');
  }

  private async freshCode(tx: Tx): Promise<string> {
    for (;;) {
      const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
      if (!(await tx.query(`SELECT 1 FROM shops WHERE join_code = $1`, [code])).rowCount) return code;
    }
  }

  /** Attaches an unattached device to the shop its user belongs to; true when it did. */
  private async attachIfMember(tx: Tx, userId: string, deviceId: string): Promise<boolean> {
    const unattached = (await tx.query<{ shop_id: string | null }>(`SELECT shop_id FROM devices WHERE id = $1`, [deviceId])).rows[0]?.shop_id === null;
    if (!unattached) return false;
    const membership = (await tx.query<{ shop_id: string }>(
      `SELECT shop_id FROM shop_members WHERE user_id = $1 ORDER BY created_at LIMIT 1`, [userId],
    )).rows[0];
    if (!membership) return false;
    await this.attachDevice(tx, membership.shop_id, deviceId);
    return true;
  }

  private async attachDevice(tx: Tx, shopId: string, deviceId: string) {
    // Lock the shop row so two devices registering at once cannot take the same code.
    await tx.query(`SELECT 1 FROM shops WHERE id = $1 FOR UPDATE`, [shopId]);
    const used = new Set((await tx.query<{ code: string }>(`SELECT code FROM devices WHERE shop_id = $1 AND code IS NOT NULL`, [shopId])).rows.map((r) => r.code));
    const code = DEVICE_CODES.find((c) => !used.has(c));
    if (!code) throw new ConflictException('Is dukaan mein machines ki limit poori ho gayi');
    await tx.query(`UPDATE devices SET shop_id = $2, code = $3 WHERE id = $1`, [deviceId, shopId, code]);
  }

  private async me(tx: Tx, p: Principal): Promise<MeView> {
    const { rows } = await tx.query<{
      user_id: string; phone: string; user_name: string; device_id: string; code: string | null;
      shop_id: string | null; shop_name: string | null; mandi: string | null; shop_no: string | null; phad: string | null; gstin: string | null; role: string | null; slip_limit_paise: string | null; shop_phone: string | null; dispatch_phone: string | null; address: string | null; bank_accounts: BankAccount[] | null; commodity: string | null; printer_host: string | null; printer_dots: number | null;
    }>(
      `SELECT u.id AS user_id, u.phone, u.name AS user_name, d.id AS device_id, d.code,
              s.id AS shop_id, s.name AS shop_name, s.mandi, s.shop_no, s.phad, s.gstin, m.role, s.slip_limit_paise, s.phone AS shop_phone, s.dispatch_phone, s.address, s.bank_accounts, s.commodity, s.printer_host, s.printer_dots
       FROM devices d JOIN users u ON u.id = d.user_id
       LEFT JOIN shops s ON s.id = d.shop_id
       LEFT JOIN shop_members m ON m.shop_id = d.shop_id AND m.user_id = d.user_id
       WHERE d.id = $1 AND d.user_id = $2`,
      [p.deviceId, p.userId],
    );
    const r = rows[0];
    return {
      user: { id: r.user_id, phone: r.phone, name: r.user_name },
      device: { id: r.device_id, code: r.code },
      shop: r.shop_id
        ? { id: r.shop_id, name: r.shop_name!, mandi: r.mandi!, shopNo: r.shop_no!, phad: r.phad ?? '', gstin: r.gstin!, role: r.role!, slipLimitPaise: Number(r.slip_limit_paise ?? 0), phone: r.shop_phone ?? '', dispatchPhone: r.dispatch_phone ?? '', address: r.address ?? '', bankAccounts: r.bank_accounts ?? [], commodity: r.commodity ?? 'nariyal', printer: { host: r.printer_host ?? '', dots: r.printer_dots ?? 576 } }
        : null,
    };
  }
}
