import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '../common/uuid';
import { Db, Tx } from '../db/db.service';
import { EntriesService } from './entries.service';
import { nameKey } from './reports.service';
import { LIVE_BILLS, n } from './sql';

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export type CrateTypeInput = { id?: string; name: string; depositPaise?: number };
export type CrateMoveInput = {
  day?: string; dir: 'out' | 'in'; buyerId?: string | null; party?: string; crateTypeId: string; qty: number;
  /** The parchi's slip number, to link the crates to it; null/absent = none. */
  slipNo?: number | null; note?: string;
};

type MoveRow = {
  id: string; day: string; dir: 'out' | 'in'; buyer_id: string | null; party: string; name: string | null; crate_type_id: string; type: string;
  deposit: string; qty: number; bill_id: string | null; slip_no: number | null; note: string; created_at: Date;
};

/** A party's key: a grahak (or laddan party) by id, a supplier by name. */
const keyOf = (r: { buyer_id: string | null; party: string }) => (r.buyer_id ? `g:${r.buyer_id}` : `s:${nameKey(r.party)}`);

/**
 * Crate In / Crate Out (the old software's crate register): returnable crates out to a grahak,
 * laddan party or supplier with the maal, and back in. A party's crates baaki is out − in;
 * what it is worth is the crate type's deposit for each one not back. Website only.
 */
@Injectable()
export class CratesService {
  constructor(private readonly db: Db, private readonly entries: EntriesService) {}

  // ---------------------------------------------------------------- crate types

  async types(shopId: string) {
    return this.db.withShop(shopId, async (tx) => ({ types: await this.typeRows(tx) }));
  }

  private async typeRows(tx: Tx) {
    return (await tx.query<{ id: string; name: string; deposit_paise: string; hidden: boolean; outs: string; ins: string }>(
      `SELECT t.id, t.name, t.deposit_paise, t.hidden,
              COALESCE(SUM(m.qty) FILTER (WHERE m.dir = 'out'), 0) AS outs, COALESCE(SUM(m.qty) FILTER (WHERE m.dir = 'in'), 0) AS ins
       FROM crate_types t LEFT JOIN crate_moves m ON m.crate_type_id = t.id
       GROUP BY t.id ORDER BY t.hidden, t.name`)).rows
      .map((t) => ({ id: t.id, name: t.name, depositPaise: n(t.deposit_paise), hidden: t.hidden, out: n(t.outs), in: n(t.ins), balance: n(t.outs) - n(t.ins) }));
  }

  async saveType(shopId: string, input: CrateTypeInput) {
    const caps = await this.entries.capsNames(shopId);
    const name = caps ? input.name.trim().toUpperCase() : input.name.trim();
    if (!name) throw new BadRequestException('Crate ka naam daalein');
    return this.db.withShop(shopId, async (tx) => {
      if ((await tx.query(`SELECT 1 FROM crate_types WHERE upper(trim(name)) = upper($1) AND id <> COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000')`, [name, input.id ?? null])).rowCount) {
        throw new ConflictException(`${name} pehle se hai`);
      }
      const deposit = Math.max(0, Math.round(input.depositPaise ?? 0));
      if (input.id) {
        if (!(await tx.query(`UPDATE crate_types SET name = $2, deposit_paise = $3, updated_at = now() WHERE id = $1`, [input.id, name, deposit])).rowCount) {
          throw new NotFoundException('Crate nahi mila');
        }
        return { id: input.id, name };
      }
      const id = uuidv7();
      await tx.query(`INSERT INTO crate_types (id, shop_id, name, deposit_paise) VALUES ($1, $2, $3, $4)`, [id, shopId, name, deposit]);
      return { id, name };
    });
  }

  /** A crate type with entries is hidden (its entries stay); an unused one is deleted. hidden=false shows it again. */
  async deleteType(shopId: string, id: string, hidden = true) {
    return this.db.withShop(shopId, async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM crate_types WHERE id = $1`, [id])).rowCount) throw new NotFoundException('Crate nahi mila');
      if (!hidden) { await tx.query(`UPDATE crate_types SET hidden = false, updated_at = now() WHERE id = $1`, [id]); return { id, hidden: false }; }
      if ((await tx.query(`SELECT 1 FROM crate_moves WHERE crate_type_id = $1 LIMIT 1`, [id])).rowCount) {
        await tx.query(`UPDATE crate_types SET hidden = true, updated_at = now() WHERE id = $1`, [id]);
        return { id, hidden: true };
      }
      await tx.query(`DELETE FROM crate_types WHERE id = $1`, [id]);
      return { id, deleted: true };
    });
  }

  // ---------------------------------------------------------------- register

  /**
   * The crate register: the period's entries (every one, newest first), each party's crates
   * baaki over all time (biggest first), and the totals. Suppliers are offered for the party box.
   */
  async register(shopId: string, from: string, to: string) {
    return this.db.withShop(shopId, async (tx) => {
      const types = await this.typeRows(tx);
      const moves = (await this.moveRows(tx, `m.day BETWEEN $1 AND $2`, [from, to])).map(view);
      const all = await this.moveRows(tx, `true`, []);
      const parties = new Map<string, { key: string; buyerId: string | null; name: string; out: number; in: number; balance: number; valuePaise: number; lastDay: string }>();
      for (const m of all) {
        const k = keyOf(m);
        const p = parties.get(k) ?? { key: k, buyerId: m.buyer_id, name: m.name ?? m.party, out: 0, in: 0, balance: 0, valuePaise: 0, lastDay: m.day };
        const sign = m.dir === 'out' ? 1 : -1;
        if (m.dir === 'out') p.out += m.qty; else p.in += m.qty;
        p.balance += sign * m.qty;
        p.valuePaise += sign * m.qty * n(m.deposit);
        if (m.day > p.lastDay) p.lastDay = m.day;
        parties.set(k, p);
      }
      const list = [...parties.values()].sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
      const suppliers = new Map<string, string>();
      for (const r of (await tx.query<{ s: string }>(
        `SELECT s FROM (SELECT TRIM(supplier) AS s, arrived_at AS at FROM trucks UNION ALL SELECT TRIM(name), updated_at FROM supplier_phones) x
         WHERE s <> '' ORDER BY at DESC LIMIT 2000`)).rows) if (!suppliers.has(nameKey(r.s))) suppliers.set(nameKey(r.s), r.s);
      const sum = (rows: { dir: string; qty: number }[], dir: string) => rows.filter((m) => m.dir === dir).reduce((s, m) => s + m.qty, 0);
      return {
        from, to, types, moves, parties: list, suppliers: [...suppliers.values()],
        totals: {
          periodOut: sum(moves, 'out'), periodIn: sum(moves, 'in'), out: sum(all, 'out'), in: sum(all, 'in'),
          balance: sum(all, 'out') - sum(all, 'in'), baakiParties: list.filter((p) => p.balance > 0).length,
          valuePaise: list.reduce((s, p) => s + Math.max(0, p.valuePaise), 0),
        },
      };
    });
  }

  /** One party's crate khata: every entry with the running baaki, and the baaki by crate type. */
  async party(shopId: string, who: { buyerId?: string; name?: string }) {
    return this.db.withShop(shopId, async (tx) => {
      const rows = who.buyerId
        ? await this.moveRows(tx, `m.buyer_id = $1`, [who.buyerId], 'ASC')
        : (await this.moveRows(tx, `m.buyer_id IS NULL`, [], 'ASC')).filter((m) => nameKey(m.party) === nameKey(who.name ?? ''));
      let name = rows[0]?.name ?? rows[0]?.party ?? who.name ?? '';
      if (who.buyerId && !rows.length) {
        const b = (await tx.query<{ name: string }>(`SELECT name FROM buyers WHERE id = $1`, [who.buyerId])).rows[0];
        if (!b) throw new NotFoundException('Grahak nahi mila');
        name = b.name;
      }
      let bal = 0;
      const lines = rows.map((m) => { bal += m.dir === 'out' ? m.qty : -m.qty; return { ...view(m), balance: bal }; });
      const byType = new Map<string, { typeId: string; name: string; balance: number; valuePaise: number }>();
      for (const m of rows) {
        const t = byType.get(m.crate_type_id) ?? { typeId: m.crate_type_id, name: m.type, balance: 0, valuePaise: 0 };
        const q = m.dir === 'out' ? m.qty : -m.qty;
        t.balance += q; t.valuePaise += q * n(m.deposit);
        byType.set(m.crate_type_id, t);
      }
      const types = [...byType.values()];
      return {
        buyerId: who.buyerId ?? null, name, lines: lines.reverse(), byType: types, balance: bal,
        out: rows.filter((m) => m.dir === 'out').reduce((s, m) => s + m.qty, 0), in: rows.filter((m) => m.dir === 'in').reduce((s, m) => s + m.qty, 0),
        valuePaise: types.reduce((s, t) => s + t.valuePaise, 0),
      };
    });
  }

  async one(shopId: string, id: string) {
    return this.db.withShop(shopId, async (tx) => {
      const m = (await this.moveRows(tx, `m.id = $1`, [id]))[0];
      if (!m) throw new NotFoundException('Entry nahi mili');
      return view(m);
    });
  }

  /** A new entry, or [id] written again. */
  async save(phone: string, shopId: string, id: string | null, input: CrateMoveInput) {
    const day = input.day && /^\d{4}-\d{2}-\d{2}$/.test(input.day) ? input.day : istToday();
    const caps = await this.entries.capsNames(shopId);
    let party = (input.party ?? '').trim().slice(0, 120);
    if (caps) party = party.toUpperCase();
    return this.db.withShop(shopId, async (tx) => {
      const type = (await tx.query<{ id: string }>(`SELECT id FROM crate_types WHERE id = $1`, [input.crateTypeId])).rows[0];
      if (!type) throw new BadRequestException('Crate chunein');
      let buyerId = input.buyerId ?? null;
      let billId: string | null = null;
      if (input.slipNo) {
        const b = (await tx.query<{ id: string; buyer_id: string | null }>(
          `SELECT id, buyer_id FROM ${LIVE_BILLS} lb WHERE slip_no = $1 ORDER BY created_at DESC LIMIT 1`, [input.slipNo])).rows[0];
        if (!b) throw new BadRequestException(`Parchi ${input.slipNo} nahi mili`);
        billId = b.id;
        // Only the parchi given: the crates are its grahak's.
        if (!buyerId && !party && b.buyer_id) buyerId = b.buyer_id;
      }
      if (buyerId) {
        const b = (await tx.query<{ name: string }>(`SELECT name FROM buyers WHERE id = $1`, [buyerId])).rows[0];
        if (!b) throw new BadRequestException('Grahak nahi mila');
        party = b.name;
      }
      if (!buyerId && !party) throw new BadRequestException('Party chunein');
      const vals = [day, input.dir, buyerId, party, input.crateTypeId, input.qty, billId, (input.note ?? '').trim().slice(0, 200)];
      if (id) {
        if (!(await tx.query(`UPDATE crate_moves SET day = $2, dir = $3, buyer_id = $4, party = $5, crate_type_id = $6, qty = $7, bill_id = $8, note = $9, updated_at = now() WHERE id = $1`,
          [id, ...vals])).rowCount) throw new NotFoundException('Entry nahi mili');
        return { id };
      }
      const newId = uuidv7();
      await tx.query(`INSERT INTO crate_moves (id, shop_id, day, dir, buyer_id, party, crate_type_id, qty, bill_id, note, created_by)
                      VALUES ($1, current_setting('app.shop_id')::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [newId, ...vals, phone]);
      return { id: newId };
    });
  }

  async remove(shopId: string, id: string) {
    return this.db.withShop(shopId, async (tx) => {
      if (!(await tx.query(`DELETE FROM crate_moves WHERE id = $1`, [id])).rowCount) throw new NotFoundException('Entry nahi mili');
      return { id, deleted: true };
    });
  }

  private async moveRows(tx: Tx, where: string, params: unknown[], order: 'ASC' | 'DESC' = 'DESC') {
    return (await tx.query<MoveRow>(
      `SELECT m.id, m.day::text AS day, m.dir, m.buyer_id, m.party, g.name, m.crate_type_id, t.name AS type, t.deposit_paise AS deposit, m.qty,
              m.bill_id, b.slip_no, m.note, m.created_at
       FROM crate_moves m JOIN crate_types t ON t.id = m.crate_type_id LEFT JOIN buyers g ON g.id = m.buyer_id LEFT JOIN bills b ON b.id = m.bill_id
       WHERE ${where} ORDER BY m.day ${order}, m.created_at ${order}`, params)).rows;
  }
}

const view = (m: MoveRow) => ({
  id: m.id, day: m.day, dir: m.dir, buyerId: m.buyer_id, party: m.name ?? m.party, typeId: m.crate_type_id, type: m.type, qty: m.qty,
  depositPaise: n(m.deposit), billId: m.bill_id, slipNo: m.slip_no, note: m.note,
});
