import { Injectable } from '@nestjs/common';
import { DatabaseError } from 'pg';
import { Principal } from '../auth/tokens.service';
import { Db, Tx } from '../db/db.service';
import { IMMUTABLE_ON_UPDATE, SYNC_TABLES } from './tables';

export type PushItem = { table: string; row: Record<string, unknown> };
/** applied: stored now · skipped: already had it (or a newer version) · rejected: invalid, will never apply */
export type PushResult = { id: string | null; status: 'applied' | 'skipped' | 'rejected'; error?: string };
export type Change = { seq: number; table: string; row: Record<string, unknown> };

export const MAX_PUSH_ITEMS = 200;
export const MAX_PULL_LIMIT = 500;

@Injectable()
export class SyncService {
  constructor(private readonly db: Db) {}

  /**
   * Applies a device's batch in order, one savepoint per row so a bad row never blocks
   * the rest. Every applied row is appended to `changes` with the shop's next sequence
   * number; the per-shop lock makes those numbers commit in order, so a device pulling
   * `after=N` can never skip a row that committed late.
   */
  async push(p: Principal, shopId: string, items: PushItem[]): Promise<PushResult[]> {
    return this.db.withShop(shopId, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [shopId]);
      const results: PushResult[] = [];
      for (const item of items) results.push(await this.applyOne(tx, p, shopId, item));
      return results;
    });
  }

  async pull(shopId: string, after: number, limit: number): Promise<{ changes: Change[]; lastSeq: number; hasMore: boolean }> {
    return this.db.withShop(shopId, async (tx) => {
      const { rows } = await tx.query<{ seq: string; table_name: string; row: Record<string, unknown> }>(
        `SELECT seq, table_name, row FROM changes WHERE shop_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
        [shopId, after, limit + 1],
      );
      const page = rows.slice(0, limit).map((r) => ({ seq: Number(r.seq), table: r.table_name, row: r.row }));
      return { changes: page, lastSeq: page.length ? page[page.length - 1].seq : after, hasMore: rows.length > limit };
    });
  }

  private async applyOne(tx: Tx, p: Principal, shopId: string, item: PushItem): Promise<PushResult> {
    const rawId = typeof item?.row?.id === 'string' ? item.row.id : null;
    const def = SYNC_TABLES[item?.table];
    if (!def) return { id: rawId, status: 'rejected', error: `unknown table ${item?.table}` };
    const parsed = def.row.safeParse(item.row);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return { id: rawId, status: 'rejected', error: `${i.path.join('.')}: ${i.message}` };
    }

    const row: Record<string, unknown> = { ...parsed.data, shop_id: shopId, device_id: p.deviceId, created_by: p.userId };
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
      return { id: row.id as string, status: 'applied' };
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT item');
      return { id: row.id as string, status: 'rejected', error: describe(err) };
    }
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
