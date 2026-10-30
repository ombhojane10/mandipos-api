import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Db, Tx } from '../db/db.service';
import { uuidv7 } from '../common/uuid';

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export type MachineInput = { serial: string; model?: string; tid?: string; note?: string };
export type GiveInput = { shopId: string | null; name: string; phone: string; onDay?: string; deviceId?: string | null; note?: string };
export type BackInput = { status: 'stock' | 'repair' | 'lost'; onDay?: string; note?: string };

type Row = {
  id: string; serial: string; model: string; tid: string; status: string; shop_id: string | null; shop_name: string | null;
  holder_name: string; holder_phone: string; given_on: string | null; note: string; created_at: Date; updated_at: Date;
  device_id: string | null; d_code: string | null; d_label: string | null; d_version: string | null; d_seen: Date | null; d_phone: string | null;
};

/**
 * MandiPlus's register of the POS machines it hands out (admin only): which serial is with which
 * shop and person, since when, and which app login runs on it. Every change also writes a
 * machine_events row, so the history of a machine is never overwritten.
 */
@Injectable()
export class MachinesService {
  constructor(private readonly db: Db) {}

  async list() {
    const rows = await this.db.query<Row>(
      `SELECT m.id, m.serial, m.model, m.tid, m.status, m.shop_id, s.name AS shop_name, m.holder_name, m.holder_phone,
              m.given_on::text AS given_on, m.note, m.created_at, m.updated_at, m.device_id,
              d.code AS d_code, d.label AS d_label, d.app_version AS d_version, d.last_seen_at AS d_seen, u.phone AS d_phone
       FROM machines m LEFT JOIN shops s ON s.id = m.shop_id
       LEFT JOIN devices d ON d.id = m.device_id LEFT JOIN users u ON u.id = d.user_id
       ORDER BY (m.status = 'given') DESC, s.name NULLS LAST, m.serial`);
    // App logins that could be a machine: every non-website device still signed in, newest first.
    const devices = await this.db.query<{ id: string; shop_id: string | null; shop_name: string | null; code: string | null; label: string; app_version: string; last_seen_at: Date | null; created_at: Date; phone: string; machine_id: string | null }>(
      `SELECT d.id, d.shop_id, s.name AS shop_name, d.code, d.label, d.app_version, d.last_seen_at, d.created_at, u.phone, m.id AS machine_id
       FROM devices d JOIN users u ON u.id = d.user_id LEFT JOIN shops s ON s.id = d.shop_id LEFT JOIN machines m ON m.device_id = d.id
       WHERE d.platform <> 'web' AND d.revoked_at IS NULL AND d.shop_id IS NOT NULL
       ORDER BY d.last_seen_at DESC NULLS LAST LIMIT 300`);
    return {
      machines: rows.map((r) => ({
        id: r.id, serial: r.serial, model: r.model, tid: r.tid, status: r.status, note: r.note,
        shopId: r.shop_id, shopName: r.shop_name, holderName: r.holder_name, holderPhone: r.holder_phone, givenOn: r.given_on,
        device: r.device_id ? { id: r.device_id, code: r.d_code, label: r.d_label, appVersion: r.d_version, lastSeenAt: r.d_seen, phone: r.d_phone } : null,
        updatedAt: r.updated_at,
      })),
      devices: devices.map((d) => ({
        id: d.id, shopId: d.shop_id, shopName: d.shop_name, code: d.code, label: d.label, appVersion: d.app_version,
        lastSeenAt: d.last_seen_at, createdAt: d.created_at, phone: d.phone, machineId: d.machine_id,
      })),
    };
  }

  /** A machine's whole story, newest first. */
  async history(id: string) {
    const events = await this.db.query<{ id: string; action: string; shop_name: string | null; holder_name: string; holder_phone: string; on_day: string; note: string; by_phone: string; created_at: Date }>(
      `SELECT e.id, e.action, s.name AS shop_name, e.holder_name, e.holder_phone, e.on_day::text AS on_day, e.note, e.by_phone, e.created_at
       FROM machine_events e LEFT JOIN shops s ON s.id = e.shop_id WHERE e.machine_id = $1 ORDER BY e.created_at DESC`, [id]);
    return { events: events.map((e) => ({ id: e.id, action: e.action, shopName: e.shop_name, holderName: e.holder_name, holderPhone: e.holder_phone, onDay: e.on_day, note: e.note, byPhone: e.by_phone, at: e.created_at })) };
  }

  /** Adds a machine to the register, or corrects its serial/model/TID/note. */
  async save(id: string | null, input: MachineInput, by: string) {
    const serial = input.serial.trim().toUpperCase();
    return this.db.tx(async (tx) => {
      const clash = await tx.query(`SELECT 1 FROM machines WHERE upper(serial) = $1 AND id IS DISTINCT FROM $2`, [serial, id]);
      if (clash.rowCount) throw new ConflictException(`Serial ${serial} pehle se register mein hai`);
      if (!id) {
        const newId = uuidv7();
        await tx.query(`INSERT INTO machines (id, serial, model, tid, note) VALUES ($1, $2, $3, $4, $5)`,
          [newId, serial, (input.model ?? '').trim(), (input.tid ?? '').trim(), (input.note ?? '').trim()]);
        await this.event(tx, newId, 'added', by, { note: input.note });
        return { id: newId };
      }
      const r = await tx.query(
        `UPDATE machines SET serial = $2, model = COALESCE($3, model), tid = COALESCE($4, tid), note = COALESCE($5, note), updated_at = now() WHERE id = $1`,
        [id, serial, input.model?.trim() ?? null, input.tid?.trim() ?? null, input.note?.trim() ?? null]);
      if (!r.rowCount) throw new NotFoundException('Machine nahi mili');
      await this.event(tx, id, 'edited', by, {});
      return { id };
    });
  }

  /** Hands the machine to a shop/person (or moves it to another), optionally naming its app login. */
  async give(id: string, input: GiveInput, by: string) {
    const name = input.name.trim().toUpperCase();
    if (!input.shopId && !name) throw new BadRequestException('Dukaan ya naam batayein');
    const onDay = input.onDay ?? istToday();
    return this.db.tx(async (tx) => {
      await this.mustExist(tx, id);
      if (input.shopId && !(await tx.query(`SELECT 1 FROM shops WHERE id = $1`, [input.shopId])).rowCount) throw new BadRequestException('Dukaan nahi mili');
      if (input.deviceId) await this.checkDevice(tx, id, input.deviceId);
      await tx.query(
        `UPDATE machines SET status = 'given', shop_id = $2, holder_name = $3, holder_phone = $4, given_on = $5, device_id = $6, updated_at = now() WHERE id = $1`,
        [id, input.shopId, name, input.phone, onDay, input.deviceId ?? null]);
      await this.event(tx, id, 'given', by, { shopId: input.shopId, name, phone: input.phone, onDay, note: input.note });
      return { id };
    });
  }

  /** The machine comes back to stock, goes for repair, or is lost: it is with nobody any more. */
  async back(id: string, input: BackInput, by: string) {
    const onDay = input.onDay ?? istToday();
    return this.db.tx(async (tx) => {
      const m = await this.mustExist(tx, id);
      await tx.query(
        `UPDATE machines SET status = $2, shop_id = NULL, holder_name = '', holder_phone = '', given_on = NULL, device_id = NULL, updated_at = now() WHERE id = $1`,
        [id, input.status]);
      // Name whom it came back from, so the history reads by itself.
      await this.event(tx, id, input.status === 'stock' ? 'returned' : input.status, by,
        { shopId: m.shop_id, name: m.holder_name, phone: m.holder_phone, onDay, note: input.note });
      return { id };
    });
  }

  /** Which app login runs on this machine (null clears it). */
  async link(id: string, deviceId: string | null, by: string) {
    return this.db.tx(async (tx) => {
      await this.mustExist(tx, id);
      if (deviceId) await this.checkDevice(tx, id, deviceId);
      await tx.query(`UPDATE machines SET device_id = $2, updated_at = now() WHERE id = $1`, [id, deviceId]);
      const d = deviceId ? (await tx.query<{ code: string | null; label: string }>(`SELECT code, label FROM devices WHERE id = $1`, [deviceId])).rows[0] : null;
      await this.event(tx, id, 'linked', by, { note: d ? `${d.code ?? ''} ${d.label}`.trim() : 'hata diya' });
      return { id };
    });
  }

  private async mustExist(tx: Tx, id: string) {
    const m = (await tx.query<{ shop_id: string | null; holder_name: string; holder_phone: string }>(
      `SELECT shop_id, holder_name, holder_phone FROM machines WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!m) throw new NotFoundException('Machine nahi mili');
    return m;
  }

  private async checkDevice(tx: Tx, id: string, deviceId: string) {
    if (!(await tx.query(`SELECT 1 FROM devices WHERE id = $1`, [deviceId])).rowCount) throw new BadRequestException('Yeh login nahi mila');
    const other = (await tx.query<{ serial: string }>(`SELECT serial FROM machines WHERE device_id = $1 AND id <> $2`, [deviceId, id])).rows[0];
    if (other) throw new ConflictException(`Yeh login machine ${other.serial} se juda hai`);
  }

  private async event(tx: Tx, machineId: string, action: string, by: string,
    e: { shopId?: string | null; name?: string; phone?: string; onDay?: string; note?: string }) {
    await tx.query(
      `INSERT INTO machine_events (id, machine_id, action, shop_id, holder_name, holder_phone, on_day, note, by_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [uuidv7(), machineId, action, e.shopId ?? null, e.name ?? '', e.phone ?? '', e.onDay ?? istToday(), (e.note ?? '').trim(), by]);
  }
}
