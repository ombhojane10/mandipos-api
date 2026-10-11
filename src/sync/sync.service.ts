import { ConflictException, Injectable } from '@nestjs/common';
import { DatabaseError } from 'pg';
import { Principal } from '../auth/tokens.service';
import { Db, Tx } from '../db/db.service';
import { IMMUTABLE_ON_UPDATE, SYNC_TABLES } from './tables';

/** txn: the terminal's local transaction the row was written in; rows sharing one apply together or not at all. */
export type PushItem = { table: string; row: Record<string, unknown>; txn?: string };
/** applied: stored now · skipped: already had it (or a newer version) · rejected: invalid, will never apply */
export type PushResult = {
  id: string | null; status: 'applied' | 'skipped' | 'rejected'; error?: string;
  /** The slip (or raseed) number was already taken: kept under [to] instead of [from]. */
  renumbered?: { from: number; to: number };
};

/** Numbers the shop hands out once: a slip's number, a collection's raseed number. */
const NUMBERED: Record<string, { col: string; asked: string; voids: string; fk: string }> = {
  bills: { col: 'slip_no', asked: 'asked_slip_no', voids: 'bill_voids', fk: 'bill_id' },
  collections: { col: 'receipt_no', asked: 'asked_receipt_no', voids: 'collection_voids', fk: 'collection_id' },
};
/** A void carries its row's number; it copies the number the server holds, which may be a new one. */
const VOID_OF: Record<string, { col: string; parent: string; fk: string }> = {
  bill_voids: { col: 'slip_no', parent: 'bills', fk: 'bill_id' },
  collection_voids: { col: 'receipt_no', parent: 'collections', fk: 'collection_id' },
};
export type Change = { seq: number; table: string; row: Record<string, unknown> };

export const MAX_PUSH_ITEMS = 200;
export const MAX_PULL_LIMIT = 500;

@Injectable()
export class SyncService {
  constructor(private readonly db: Db) {}

  /**
   * Applies a device's batch in order. Every applied row is appended to `changes` with the
   * shop's next sequence number; the per-shop lock makes those numbers commit in order, so a
   * device pulling `after=N` can never skip a row that committed late.
   *
   * Rows the terminal wrote in one local transaction (a slip: bill, lines, payment, delivery)
   * carry the same `txn` and are applied as one unit: if any of them is refused, none of them
   * is stored, so the server never holds half a slip. Rows without a txn (older terminals) are
   * applied one by one, a bad row never blocking the rest.
   *
   * [resetSeen] is the newest '_reset' the terminal has applied. If the shop's books were
   * started again after that, its outbox belongs to the old books: it must pull first.
   */
  async push(p: Principal, shopId: string, items: PushItem[], resetSeen?: number): Promise<PushResult[]> {
    return this.db.withShop(shopId, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [shopId]);
      if (resetSeen !== undefined) {
        const { rows } = await tx.query<{ reset_seq: string }>(`SELECT reset_seq FROM shop_counters WHERE shop_id = $1`, [shopId]);
        const resetSeq = Number(rows[0]?.reset_seq ?? 0);
        if (resetSeen < resetSeq) {
          throw new ConflictException({ code: 'reset', resetSeq, message: 'The shop\'s books were started again: pull before pushing' });
        }
      }
      const results: PushResult[] = [];
      // Read fresh, not from the token: a role changed an hour ago must bind now.
      let role: string | null | undefined;
      const roleOf = async () => role !== undefined ? role : (role = (await tx.query<{ role: string }>(
        `SELECT role FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [shopId, p.userId])).rows[0]?.role ?? null);
      for (let i = 0; i < items.length;) {
        const txn = typeof items[i]?.txn === 'string' && items[i].txn ? items[i].txn : null;
        let end = i + 1;
        if (txn) while (end < items.length && items[end]?.txn === txn) end++;
        if (!txn || end - i === 1) {
          results.push(await this.applyOne(tx, p, shopId, items[i], roleOf));
        } else {
          results.push(...await this.applyGroup(tx, p, shopId, items.slice(i, end), roleOf));
        }
        i = end;
      }
      return results;
    });
  }

  /** All of [group] or none of it. */
  private async applyGroup(
    tx: Tx, p: Principal, shopId: string, group: PushItem[], roleOf: () => Promise<string | null>,
  ): Promise<PushResult[]> {
    await tx.query('SAVEPOINT txn');
    const out: PushResult[] = [];
    for (const item of group) {
      const r = await this.applyOne(tx, p, shopId, item, roleOf);
      out.push(r);
      if (r.status === 'rejected') {
        await tx.query('ROLLBACK TO SAVEPOINT txn');
        await tx.query('RELEASE SAVEPOINT txn');
        const why = `not saved: ${item.table} in the same entry was refused (${r.error})`;
        const failed = out.length - 1;
        return group.map((g, i) => i === failed ? r
          : { id: typeof g.row?.id === 'string' ? g.row.id : null, status: 'rejected' as const, error: why });
      }
    }
    await tx.query('RELEASE SAVEPOINT txn');
    return out;
  }

  async pull(shopId: string, after: number, limit: number): Promise<{ changes: Change[]; lastSeq: number; hasMore: boolean; resetSeq: number }> {
    return this.db.withShop(shopId, async (tx) => {
      const { rows } = await tx.query<{ seq: string; table_name: string; row: Record<string, unknown> }>(
        `SELECT seq, table_name, row FROM changes WHERE shop_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
        [shopId, after, limit + 1],
      );
      const counters = await tx.query<{ reset_seq: string }>(`SELECT reset_seq FROM shop_counters WHERE shop_id = $1`, [shopId]);
      const page = rows.slice(0, limit).map((r) => ({ seq: Number(r.seq), table: r.table_name, row: r.row }));
      return {
        changes: page, lastSeq: page.length ? page[page.length - 1].seq : after, hasMore: rows.length > limit,
        resetSeq: Number(counters.rows[0]?.reset_seq ?? 0),
      };
    });
  }

  private async applyOne(
    tx: Tx, p: Principal, shopId: string, item: PushItem, roleOf: () => Promise<string | null>,
  ): Promise<PushResult> {
    const rawId = typeof item?.row?.id === 'string' ? item.row.id : null;
    const def = SYNC_TABLES[item?.table];
    if (!def) return { id: rawId, status: 'rejected', error: `unknown table ${item?.table}` };
    const parsed = def.row.safeParse(item.row);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return { id: rawId, status: 'rejected', error: `${i.path.join('.')}: ${i.message}` };
    }

    const row: Record<string, unknown> = { ...parsed.data, shop_id: shopId, device_id: p.deviceId, created_by: p.userId };
    const renumbered = await this.freeNumber(tx, shopId, p.deviceId, item.table, row);
    const cols = Object.keys(row);
    const values = cols.map((c) => (c === 'raw' ? JSON.stringify(row[c]) : row[c]));
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const table = item.table;
    const onConflict = def.kind === 'fact'
      ? 'DO NOTHING'
      : `DO UPDATE SET ${cols.filter((c) => !IMMUTABLE_ON_UPDATE.has(c)).map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
         WHERE ${table}.updated_at < EXCLUDED.updated_at`;

    await tx.query('SAVEPOINT item');
    try {
      const inserted = await tx.query(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) ${onConflict} RETURNING id`,
        values,
      );
      if (inserted.rowCount === 0) {
        await tx.query('RELEASE SAVEPOINT item');
        return { id: row.id as string, status: 'skipped' };
      }
      await tx.query(
        `WITH next AS (UPDATE shop_counters SET last_seq = last_seq + 1 WHERE shop_id = $1 RETURNING last_seq)
         INSERT INTO changes (shop_id, seq, table_name, row_id, row, device_id)
         SELECT $1, next.last_seq, $2, t.id, to_jsonb(t), $4 FROM next, ${table} t WHERE t.id = $3`,
        [shopId, table, row.id, p.deviceId],
      );
      await tx.query('RELEASE SAVEPOINT item');
      return renumbered ? { id: row.id as string, status: 'applied', renumbered } : { id: row.id as string, status: 'applied' };
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT item');
      return { id: row.id as string, status: 'rejected', error: describe(err) };
    }
  }

  /**
   * Two terminals can hand out the same slip number: one offline (light gone, no wifi) numbers
   * on from what it last saw while the other carries on online. The slip that reaches the
   * server second is kept — never refused, or its money and dana would stay on one machine —
   * under the shop's next free number, with the number it asked for in asked_slip_no. Pushes
   * of one shop run one at a time (the advisory lock), so "next free" can't be handed out twice.
   *
   * A corrected copy (Badlein) of a slip that was moved this way asks for the old number again;
   * it takes the number its original got, so the edit stays one slip. Voids copy the number the
   * server holds for the row they cancel. Collections' raseed numbers work the same way.
   */
  private async freeNumber(
    tx: Tx, shopId: string, deviceId: string, table: string, row: Record<string, unknown>,
  ): Promise<{ from: number; to: number } | undefined> {
    const v = VOID_OF[table];
    if (v) {
      const { rows } = await tx.query<{ n: number | null }>(
        `SELECT ${v.col} AS n FROM ${v.parent} WHERE shop_id = $1 AND id = $2`, [shopId, row[v.fk]]);
      const held = rows[0]?.n;
      if (held != null && held !== row[v.col]) row[v.col] = held;
      return undefined;
    }
    const n = NUMBERED[table];
    const asked = n ? row[n.col] : null;
    if (!n || typeof asked !== 'number') return undefined;
    const free = (k: string) => `NOT EXISTS (
      SELECT 1 FROM ${table} x WHERE x.shop_id = $1 AND x.${n.col} = ${k} AND x.id <> $2
         AND NOT EXISTS (SELECT 1 FROM ${n.voids} v WHERE v.shop_id = x.shop_id AND v.${n.fk} = x.id))`;
    const { rows: mine } = await tx.query<{ held: number | null; known: boolean; free: boolean }>(
      `SELECT (SELECT ${n.col} FROM ${table} WHERE shop_id = $1 AND id = $2) AS held,
              EXISTS (SELECT 1 FROM ${table} WHERE shop_id = $1 AND id = $2) AS known, ${free('$3')} AS free`,
      [shopId, row.id, asked]);
    // Already stored — a re-send after the answer got lost: it carries the number it was kept
    // under, so the number check passes and the insert is skipped, never refused.
    if (mine[0].known) { row[n.col] = mine[0].held; return undefined; }
    if (mine[0].free) return undefined;
    const { rows: was } = await tx.query<{ n: number }>(
      `SELECT y.${n.col} AS n FROM ${table} y
        WHERE y.shop_id = $1 AND y.device_id = $4 AND y.${n.asked} = $3 AND ${free(`y.${n.col}`)}
        ORDER BY y.created_at DESC LIMIT 1`,
      [shopId, row.id, asked, deviceId]);
    const to = was[0]?.n ?? Number((await tx.query<{ n: string }>(
      `SELECT GREATEST(COALESCE((SELECT MAX(${n.col}) FROM ${table} WHERE shop_id = $1), 0),
                       COALESCE((SELECT MAX(${n.col}) FROM ${n.voids} WHERE shop_id = $1), 0)) + 1 AS n`,
      [shopId])).rows[0].n);
    row[n.col] = to;
    row[n.asked] = asked;
    return { from: asked, to };
  }
}

function describe(err: unknown): string {
  if (err instanceof DatabaseError) {
    switch (err.code) {
      case '23503': return 'linked record not found (its parent was not synced)';
      case '23505': return `duplicate value (${err.constraint ?? 'unique'})`;
      case '23514': return `invalid value (${err.constraint ?? 'check'})`;
      case '42501': return 'not allowed for this shop';
    }
    return err.message;
  }
  return (err as Error).message ?? 'unknown error';
}
