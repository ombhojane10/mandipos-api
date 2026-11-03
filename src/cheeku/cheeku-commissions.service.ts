import { Injectable } from '@nestjs/common';
import { nameKey } from '../admin/reports.service';
import { Db, Tx } from '../db/db.service';
import { requireCheeku, requireCheekuTx } from './cheeku';

/** The shop's commission until it sets its own default: 6%, in basis points. */
export const CHEEKU_DEFAULT_COMMISSION_BPS = 600;

/** A party's own rate, as the pages list it. */
export type CheekuPartyRate = { key: string; name: string; bps: number; updatedBy: string; updatedAt: string };

/**
 * Cheeku only: the shop's commission on each party's sales, per party (cheeku_commissions).
 * A party with its own rate is charged that; everyone else the shop's default (the '' row,
 * 6% until set). The beejak and the Commission bikri page start from it, and saving a beejak
 * at another % remembers that % for the party.
 */
@Injectable()
export class CheekuCommissionsService {
  constructor(private readonly db: Db) {}

  /** The shop's default and every party's own rate. */
  async list(shopId: string): Promise<{ defaultBps: number; parties: CheekuPartyRate[] }> {
    await requireCheeku(this.db, shopId);
    return this.db.withShop(shopId, async (tx) => {
      const rows = (await tx.query<{ supplier_key: string; name: string; bps: number; updated_by: string; updated_at: Date }>(
        `SELECT supplier_key, name, bps, updated_by, updated_at FROM cheeku_commissions ORDER BY name`)).rows;
      const def = rows.find((r) => r.supplier_key === '');
      return {
        defaultBps: def?.bps ?? CHEEKU_DEFAULT_COMMISSION_BPS,
        parties: rows.filter((r) => r.supplier_key !== '')
          .map((r) => ({ key: r.supplier_key, name: r.name, bps: r.bps, updatedBy: r.updated_by, updatedAt: r.updated_at.toISOString() })),
      };
    });
  }

  /** Inside a transaction already on the shop: the default and each party's rate, for working commission out. */
  async ratesTx(tx: Tx): Promise<{ defaultBps: number; byKey: Map<string, number> }> {
    const rows = (await tx.query<{ supplier_key: string; bps: number }>(`SELECT supplier_key, bps FROM cheeku_commissions`)).rows;
    return {
      defaultBps: rows.find((r) => r.supplier_key === '')?.bps ?? CHEEKU_DEFAULT_COMMISSION_BPS,
      byKey: new Map(rows.filter((r) => r.supplier_key !== '').map((r) => [r.supplier_key, r.bps])),
    };
  }

  /** The % a party is charged: its own, else the shop's default. */
  async rateTx(tx: Tx, supplier: string): Promise<{ bps: number; own: boolean }> {
    const { defaultBps, byKey } = await this.ratesTx(tx);
    const own = byKey.get(nameKey(supplier));
    return own === undefined ? { bps: defaultBps, own: false } : { bps: own, own: true };
  }

  /**
   * Sets a party's own % ([supplier] blank = the shop's default). [bps] null takes the party's own
   * rate away, so it is charged the default again (the default itself goes back to 6%).
   */
  async set(shopId: string, supplier: string, bps: number | null, by: string) {
    await requireCheeku(this.db, shopId);
    await this.db.withShop(shopId, (tx) => this.setTx(tx, shopId, supplier, bps, by));
    return this.list(shopId);
  }

  async setTx(tx: Tx, shopId: string, supplier: string, bps: number | null, by: string) {
    await requireCheekuTx(tx, shopId);
    const name = supplier.trim();
    const key = name ? nameKey(name) : '';
    if (bps === null) {
      await tx.query(`DELETE FROM cheeku_commissions WHERE shop_id = $1 AND supplier_key = $2`, [shopId, key]);
      return;
    }
    await tx.query(
      `INSERT INTO cheeku_commissions (shop_id, supplier_key, name, bps, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (shop_id, supplier_key) DO UPDATE SET name = EXCLUDED.name, bps = EXCLUDED.bps, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [shopId, key, name, bps, by.slice(0, 60)]);
  }
}
