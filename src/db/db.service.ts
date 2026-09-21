import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from '../config';

export type Tx = PoolClient;

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool = new Pool({
    connectionString: config().DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  async onModuleDestroy() {
    await this.pool.end();
  }

  async query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(sql, params)).rows;
  }

  async one<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.pool.query<T>(sql, params)).rows[0] ?? null;
  }

  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Runs [fn] in a transaction scoped to one shop. Row-level security reads app.shop_id;
   * set_config(..., true) is transaction-local, so it never leaks through the pooler.
   */
  withShop<T>(shopId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.tx(async (tx) => {
      await tx.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
      return fn(tx);
    });
  }
}
