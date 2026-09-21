import { ConflictException, Injectable } from '@nestjs/common';
import { uuidv7 } from '../common/uuid';
import { Db, Tx } from '../db/db.service';
import { Principal, Tokens, TokensService } from './tokens.service';

export type DeviceInfo = { label: string; platform: string; appVersion: string };

export type MeView = {
  user: { id: string; phone: string; name: string };
  device: { id: string; code: string | null };
  shop: { id: string; name: string; mandi: string; shopNo: string; gstin: string; role: string } | null;
};

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
  async createShop(p: Principal, shop: { name: string; mandi: string; shopNo: string; gstin: string; role: string; ownerName: string }):
    Promise<{ accessToken: string; me: MeView }> {
    return this.db.tx(async (tx) => {
      const existing = (await tx.query(`SELECT 1 FROM shop_members WHERE user_id = $1`, [p.userId])).rowCount;
      if (existing) throw new ConflictException('Is number se dukaan pehle se registered hai');

      const shopId = uuidv7();
      await tx.query(
        `INSERT INTO shops (id, name, mandi, shop_no, gstin, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [shopId, shop.name, shop.mandi, shop.shopNo, shop.gstin, p.userId],
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

  async meFor(p: Principal): Promise<MeView> {
    return this.db.tx((tx) => this.me(tx, p));
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
      shop_id: string | null; shop_name: string | null; mandi: string | null; shop_no: string | null; gstin: string | null; role: string | null;
    }>(
      `SELECT u.id AS user_id, u.phone, u.name AS user_name, d.id AS device_id, d.code,
              s.id AS shop_id, s.name AS shop_name, s.mandi, s.shop_no, s.gstin, m.role
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
        ? { id: r.shop_id, name: r.shop_name!, mandi: r.mandi!, shopNo: r.shop_no!, gstin: r.gstin!, role: r.role! }
        : null,
    };
  }
}
