import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
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
  /** A void of a row already voided elsewhere: it voided these, the rows standing in its place, instead. */
  passedOn?: string[];
};

/** Per push: the numbers its voids freed, as the terminal knew them → as the server holds them. */
type Freed = { bills: Map<number, number>; collections: Map<number, number> };

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
      // What the voids in this push freed: the number a terminal knew a slip by → the server's.
      const freed: Freed = { bills: new Map(), collections: new Map() };
      for (let i = 0; i < items.length;) {
        const txn = typeof items[i]?.txn === 'string' && items[i].txn ? items[i].txn : null;
        let end = i + 1;
        if (txn) while (end < items.length && items[end]?.txn === txn) end++;
        if (!txn || end - i === 1) {
          results.push(await this.applyOne(tx, p, shopId, items[i], roleOf, freed));
        } else {
          results.push(...await this.applyGroup(tx, p, shopId, items.slice(i, end), roleOf, freed));
        }
        i = end;
      }
      return results;
    });
  }

  /** All of [group] or none of it. */
  private async applyGroup(
    tx: Tx, p: Principal, shopId: string, group: PushItem[], roleOf: () => Promise<string | null>, freed: Freed,
  ): Promise<PushResult[]> {
    await tx.query('SAVEPOINT txn');
    const out: PushResult[] = [];
    for (const item of group) {
      const r = await this.applyOne(tx, p, shopId, item, roleOf, freed);
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
    tx: Tx, p: Principal, shopId: string, item: PushItem, roleOf: () => Promise<string | null>, freed: Freed,
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
    const table = item.table;
    const settled = await this.settle(tx, shopId, p.deviceId, table, row, freed);
    if (settled.skip) {
      // Already stored (a re-send), or a void of a row another terminal had already voided.
      await tx.query('SAVEPOINT item');
      try {
        // The later word wins: it carries on to the row now standing in the voided one's place.
        for (const target of settled.passOn ?? []) {
          const v = VOID_OF[table];
          const held = (await tx.query<{ n: number | null }>(
            `SELECT ${v.col} AS n FROM ${v.parent} WHERE shop_id = $1 AND id = $2`, [shopId, target])).rows[0]?.n ?? null;
          await this.insert(tx, p, shopId, table, def.kind, { ...row, id: randomUUID(), [v.fk]: target, [v.col]: held });
        }
        await tx.query('RELEASE SAVEPOINT item');
      } catch (err) {
        await tx.query('ROLLBACK TO SAVEPOINT item');
        return { id: row.id as string, status: 'rejected', error: describe(err) };
      }
      return settled.passOn?.length
        ? { id: row.id as string, status: 'skipped', passedOn: settled.passOn }
        : { id: row.id as string, status: 'skipped' };
    }
    const renumbered = settled.renumbered;

    await tx.query('SAVEPOINT item');
    try {
      if (!(await this.insert(tx, p, shopId, table, def.kind, row))) {
        await tx.query('RELEASE SAVEPOINT item');
        return { id: row.id as string, status: 'skipped' };
      }
      await tx.query('RELEASE SAVEPOINT item');
      return renumbered ? { id: row.id as string, status: 'applied', renumbered } : { id: row.id as string, status: 'applied' };
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT item');
      return { id: row.id as string, status: 'rejected', error: describe(err) };
    }
  }

  /** Inserts (or, for a master, updates) one row and appends it to the feed. False when nothing changed. */
  private async insert(
    tx: Tx, p: Principal, shopId: string, table: string, kind: 'fact' | 'master', row: Record<string, unknown>,
  ): Promise<boolean> {
    const cols = Object.keys(row);
    const values = cols.map((c) => (c === 'raw' ? JSON.stringify(row[c]) : row[c]));
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const onConflict = kind === 'fact'
      ? 'DO NOTHING'
      : `DO UPDATE SET ${cols.filter((c) => !IMMUTABLE_ON_UPDATE.has(c)).map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
         WHERE ${table}.updated_at < EXCLUDED.updated_at`;
    const inserted = await tx.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) ${onConflict} RETURNING id`,
      values,
    );
    if (inserted.rowCount === 0) return false;
    await tx.query(
      `WITH next AS (UPDATE shop_counters SET last_seq = last_seq + 1 WHERE shop_id = $1 RETURNING last_seq)
       INSERT INTO changes (shop_id, seq, table_name, row_id, row, device_id)
       SELECT $1, next.last_seq, $2, t.id, to_jsonb(t), $4 FROM next, ${table} t WHERE t.id = $3`,
      [shopId, table, row.id, p.deviceId],
    );
    return true;
  }

  /**
   * What a numbered row, or a void of one, needs before it is stored — the cases two terminals
   * make between them.
   *
   * Two terminals can hand out the same slip number: one offline (light gone, no wifi) numbers
   * on from what it last saw while the other carries on; or both online press print on the same
   * number at once. The slip that reaches the server second is kept — never refused, or its
   * money and dana would stay on one machine — under the shop's next free number, with the
   * number it asked for in asked_slip_no. Pushes of one shop run one at a time (the advisory
   * lock), so "next free" can't be handed out twice. A corrected copy (Badlein) of a slip that
   * was moved this way asks for the old number again; it takes the number its original got, so
   * the edit stays one slip. Raseed numbers on collections work the same way.
   *
   * A row the server already has (a re-send after the answer was lost) is skipped untouched.
   *
   * A void copies the number the server holds for the row it cancels. A void of a row another
   * terminal has already voided — both edited the same slip, or one edited and one deleted it —
   * isn't stored a second time: the later word wins, so it voids whatever now stands in that
   * row's place (the other terminal's corrected copy) and the slip ends up as this terminal left
   * it, on every terminal. With nothing standing there (both deleted it) it is simply skipped.
   */
  private async settle(
    tx: Tx, shopId: string, deviceId: string, table: string, row: Record<string, unknown>, freed: Freed,
  ): Promise<{ skip?: boolean; passOn?: string[]; renumbered?: { from: number; to: number } }> {
    const v = VOID_OF[table];
    if (v) {
      const { rows } = await tx.query<{ n: number | null; known: boolean; voided: boolean }>(
        `SELECT p.${v.col} AS n,
                EXISTS (SELECT 1 FROM ${table} x WHERE x.shop_id = $1 AND x.id = $3) AS known,
                EXISTS (SELECT 1 FROM ${table} x WHERE x.shop_id = $1 AND x.${v.fk} = $2) AS voided
           FROM ${v.parent} p WHERE p.shop_id = $1 AND p.id = $2`,
        [shopId, row[v.fk], row.id]);
      const parent = rows[0];
      if (!parent) return {};                  // its row never reached the server: the insert says so
      if (parent.known) return { skip: true };
      // A Badlein's corrected copy follows in the same push asking for the number this terminal
      // knew the slip by; it gets the one the server holds.
      if (parent.n != null && typeof row[v.col] === 'number') freed[v.parent as keyof Freed].set(row[v.col] as number, parent.n);
      if (parent.n != null && parent.n !== row[v.col]) row[v.col] = parent.n;
      if (!parent.voided) return {};
      const live = (alias: string, voids: string, fk: string) =>
        `NOT EXISTS (SELECT 1 FROM ${voids} z WHERE z.shop_id = ${alias}.shop_id AND z.${fk} = ${alias}.id)`;
      const standing = table === 'bill_voids'
        // A slip's corrected copy carries its number.
        ? (parent.n == null ? [] : (await tx.query<{ id: string }>(
          `SELECT b.id FROM bills b WHERE b.shop_id = $1 AND b.slip_no = $2 AND ${live('b', 'bill_voids', 'bill_id')}`,
          [shopId, parent.n])).rows)
        // A payment's corrected rows keep its payer and its time.
        : (await tx.query<{ id: string }>(
          `SELECT c.id FROM collections c JOIN collections o ON o.shop_id = c.shop_id AND o.id = $2
            WHERE c.shop_id = $1 AND c.id <> o.id AND c.buyer_id = o.buyer_id AND c.created_at = o.created_at
              AND ${live('c', 'collection_voids', 'collection_id')}`,
          [shopId, row[v.fk]])).rows;
      return { skip: true, passOn: standing.map((r) => r.id) };
    }
    const n = NUMBERED[table];
    const asked = n ? row[n.col] : null;
    if (!n) return {};
    const { rows: mine } = await tx.query<{ known: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${table} WHERE shop_id = $1 AND id = $2) AS known`, [shopId, row.id]);
    // Already stored — a re-send after the answer got lost. Its number may since have moved,
    // or a corrected copy may hold it now; either way there is nothing to store.
    if (mine[0].known) return { skip: true };
    if (typeof asked !== 'number') return {};
    const free = (k: string) => `NOT EXISTS (
      SELECT 1 FROM ${table} x WHERE x.shop_id = $1 AND x.${n.col} = ${k} AND x.id <> $2
         AND NOT EXISTS (SELECT 1 FROM ${n.voids} v WHERE v.shop_id = x.shop_id AND v.${n.fk} = x.id))`;
    // The corrected copy of a slip voided just before it in this push: the slip's own number.
    const own = freed[table as keyof Freed].get(asked);
    if (own !== undefined) {
      const { rows: ok } = await tx.query<{ free: boolean }>(`SELECT ${free('$3')} AS free`, [shopId, row.id, own]);
      if (ok[0].free) {
        if (own === asked) return {};
        row[n.col] = own;
        row[n.asked] = asked;
        return { renumbered: { from: asked, to: own } };
      }
    }
    const { rows: open } = await tx.query<{ free: boolean }>(`SELECT ${free('$3')} AS free`, [shopId, row.id, asked]);
    if (open[0].free) return {};
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
    return { renumbered: { from: asked, to } };
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
