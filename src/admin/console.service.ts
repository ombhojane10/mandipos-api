import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '../common/uuid';
import { Db, Tx } from '../db/db.service';
import { SettingsService } from './settings.service';

/**
 * The MandiPlus admin console: setting a customer up without their phone in hand. A shop made
 * here is approved at once and its people are already on the team, so each of them just logs in
 * with their number and lands in the shop — the same rows the app's "Nayi dukaan" and Team
 * screens write (AccountsService.createShop / addMember / setRole / removeMember).
 */
export type ConsoleRole = 'admin' | 'accountant' | 'labour';
const toDb = (r: ConsoleRole) => (r === 'admin' ? 'owner' : r === 'labour' ? 'labour' : 'munim');
const fromDb = (r: string): ConsoleRole => (r === 'owner' ? 'admin' : r === 'labour' ? 'labour' : 'accountant');

export type NewShop = {
  name: string; nickname: string; mandi: string; shopNo: string; phad: string; gstin: string; address: string; slipCode: string
  commodity: 'nariyal' | 'amrud' | 'angoor'
  people: { phone: string; name: string; role: ConsoleRole }[]
};

@Injectable()
export class ConsoleService {
  constructor(private readonly db: Db, private readonly settings: SettingsService) {}

  /** A shop, approved, with its owner(s), accountants and labour already in it. */
  async create(by: string, s: NewShop): Promise<{ id: string }> {
    if (!s.people.some((p) => p.role === 'admin')) throw new BadRequestException('Malik ka number daalein');
    const phones = s.people.map((p) => p.phone);
    if (new Set(phones).size !== phones.length) throw new BadRequestException('Ek number do baar likha hai');
    return this.db.tx(async (tx) => {
      const ids: string[] = [];
      for (const p of s.people) ids.push(await this.user(tx, p.phone, p.name, p.role));
      const owner = ids[s.people.findIndex((p) => p.role === 'admin')];
      const shopId = uuidv7();
      await tx.query(
        `INSERT INTO shops (id, name, nickname, mandi, shop_no, phad, gstin, address, slip_code, created_by, join_code, phone, commodity, approved_at, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, (SELECT phone FROM users WHERE id = $10), $12, now(), $13)`,
        [shopId, s.name, s.nickname, s.mandi, s.shopNo, s.phad, s.gstin, s.address, s.slipCode, owner, await this.freshCode(tx), s.commodity, by],
      );
      for (const [i, p] of s.people.entries()) {
        await tx.query(`INSERT INTO shop_members (shop_id, user_id, role) VALUES ($1, $2, $3)`, [shopId, ids[i], toDb(p.role)]);
      }
      // shop_counters is tenant-scoped: row-level security needs this transaction to be the new shop.
      await tx.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
      await tx.query(`INSERT INTO shop_counters (shop_id) VALUES ($1)`, [shopId]);
      return { id: shopId };
    });
  }

  /** Everything the console shows for one shop: its settings and labels, team, logins. */
  async shop(shopId: string) {
    const head = await this.db.one<{ nickname: string; join_code: string; approved_at: Date | null; rejected_at: Date | null; created_at: Date }>(
      `SELECT nickname, join_code, approved_at, rejected_at, created_at FROM shops WHERE id = $1`, [shopId]);
    if (!head) throw new NotFoundException('Yeh dukaan nahi mili');
    const members = await this.db.query<{ user_id: string; phone: string; name: string; role: string; created_at: Date; devices: string; last_seen_at: Date | null }>(
      `SELECT m.user_id, u.phone, u.name, m.role, m.created_at,
              (SELECT count(*) FROM devices d WHERE d.user_id = m.user_id AND d.shop_id = m.shop_id AND d.revoked_at IS NULL) AS devices,
              (SELECT max(d.last_seen_at) FROM devices d WHERE d.user_id = m.user_id AND d.shop_id = m.shop_id) AS last_seen_at
       FROM shop_members m JOIN users u ON u.id = m.user_id WHERE m.shop_id = $1 ORDER BY (m.role = 'owner') DESC, m.created_at`, [shopId]);
    const devices = await this.db.query<{ id: string; code: string | null; label: string; platform: string; app_version: string | null; last_seen_at: Date | null; phone: string; name: string }>(
      `SELECT d.id, d.code, d.label, d.platform, d.app_version, d.last_seen_at, u.phone, u.name FROM devices d JOIN users u ON u.id = d.user_id
       WHERE d.shop_id = $1 AND d.revoked_at IS NULL ORDER BY d.last_seen_at DESC NULLS LAST`, [shopId]);
    return {
      id: shopId, ...(await this.settings.get(shopId)), nickname: head.nickname, joinCode: head.join_code,
      status: head.approved_at ? 'approved' : head.rejected_at ? 'rejected' : 'pending', createdAt: head.created_at.toISOString(),
      members: members.map((m) => ({
        userId: m.user_id, phone: m.phone, name: m.name, role: fromDb(m.role), since: m.created_at.toISOString(),
        devices: Number(m.devices), lastSeenAt: m.last_seen_at?.toISOString() ?? null,
      })),
      devices: devices.map((d) => ({
        id: d.id, code: d.code ?? '', label: d.label, platform: d.platform, appVersion: d.app_version ?? '', lastSeenAt: d.last_seen_at?.toISOString() ?? null,
        phone: d.phone, name: d.name,
      })),
    };
  }

  /** Puts a number on the team; their first login opens this shop. */
  async addMember(shopId: string, phone: string, name: string, role: ConsoleRole) {
    await this.db.tx(async (tx) => {
      await this.requireShop(tx, shopId);
      const userId = await this.user(tx, phone, name, role, shopId);
      await tx.query(`INSERT INTO shop_members (shop_id, user_id, role) VALUES ($1, $2, $3)`, [shopId, userId, toDb(role)]);
    });
  }

  /** A team member's role or name; the last admin cannot step down. */
  async editMember(shopId: string, userId: string, patch: { role?: ConsoleRole; name?: string }) {
    await this.db.tx(async (tx) => {
      const m = (await tx.query<{ role: string }>(`SELECT role FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [shopId, userId])).rows[0];
      if (!m) throw new NotFoundException('Yeh team mein nahi hai');
      if (patch.role) {
        if (patch.role !== 'admin' && m.role === 'owner') await this.keepOneAdmin(tx, shopId);
        // A number on two shops is only for an owner (Meri dukaanein); staff belong to one.
        if (patch.role !== 'admin') await this.onlyHere(tx, userId, shopId);
        await tx.query(`UPDATE shop_members SET role = $3 WHERE shop_id = $1 AND user_id = $2`, [shopId, userId, toDb(patch.role)]);
      }
      if (patch.name !== undefined) await tx.query(`UPDATE users SET name = $2 WHERE id = $1`, [userId, patch.name]);
    });
  }

  /** Off the team, and every phone of theirs in this shop shut out at once. */
  async removeMember(shopId: string, userId: string) {
    await this.db.tx(async (tx) => {
      const m = (await tx.query<{ role: string }>(`SELECT role FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [shopId, userId])).rows[0];
      if (!m) throw new NotFoundException('Yeh team mein nahi hai');
      if (m.role === 'owner') await this.keepOneAdmin(tx, shopId);
      await tx.query(`DELETE FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [shopId, userId]);
      await tx.query(
        `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL AND device_id IN (SELECT id FROM devices WHERE user_id = $1 AND shop_id = $2)`,
        [userId, shopId],
      );
      await tx.query(`UPDATE devices SET revoked_at = now() WHERE user_id = $1 AND shop_id = $2 AND revoked_at IS NULL`, [userId, shopId]);
    });
  }

  /** The console's own name for the shop; everything else is in SettingsService. */
  async label(shopId: string, nickname: string) {
    await this.db.query(`UPDATE shops SET nickname = $2 WHERE id = $1`, [shopId, nickname]);
  }

  /** The user row for a number, made if new; refused if staff would end up on two shops. */
  private async user(tx: Tx, phone: string, name: string, role: ConsoleRole, shopId?: string): Promise<string> {
    await tx.query(`INSERT INTO users (id, phone, name) VALUES ($1, $2, $3) ON CONFLICT (phone) DO NOTHING`, [uuidv7(), phone, name]);
    const u = (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM users WHERE phone = $1`, [phone])).rows[0];
    if (name && !u.name) await tx.query(`UPDATE users SET name = $2 WHERE id = $1`, [u.id, name]);
    const others = (await tx.query<{ shop_id: string; role: string; name: string }>(
      `SELECT m.shop_id, m.role, s.name FROM shop_members m JOIN shops s ON s.id = m.shop_id WHERE m.user_id = $1`, [u.id])).rows;
    if (shopId && others.some((o) => o.shop_id === shopId)) throw new ConflictException(`${phone} pehle se team mein hai`);
    // An owner may run several shops (Meri dukaanein); staff, and anyone already staff elsewhere, only one.
    const clash = others.find((o) => o.shop_id !== shopId && (role !== 'admin' || o.role !== 'owner'));
    if (clash) throw new ConflictException(`${phone} pehle se ${clash.name} mein hai`);
    return u.id;
  }

  private async onlyHere(tx: Tx, userId: string, shopId: string) {
    const other = (await tx.query<{ name: string }>(
      `SELECT s.name FROM shop_members m JOIN shops s ON s.id = m.shop_id WHERE m.user_id = $1 AND m.shop_id <> $2 LIMIT 1`, [userId, shopId])).rows[0];
    if (other) throw new ConflictException(`Yeh number ${other.name} ka bhi malik hai — wahan se hatakar hi staff banega`);
  }

  private async requireShop(tx: Tx, shopId: string) {
    if (!(await tx.query(`SELECT 1 FROM shops WHERE id = $1`, [shopId])).rowCount) throw new NotFoundException('Yeh dukaan nahi mili');
  }

  private async keepOneAdmin(tx: Tx, shopId: string) {
    const admins = (await tx.query(`SELECT 1 FROM shop_members WHERE shop_id = $1 AND role = 'owner'`, [shopId])).rowCount ?? 0;
    if (admins <= 1) throw new BadRequestException('Dukaan mein kam se kam ek malik rehna chahiye');
  }

  private async freshCode(tx: Tx): Promise<string> {
    for (;;) {
      const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
      if (!(await tx.query(`SELECT 1 FROM shops WHERE join_code = $1`, [code])).rowCount) return code;
    }
  }
}
