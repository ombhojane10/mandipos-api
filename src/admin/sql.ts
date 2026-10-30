/** SQL and helpers shared by the admin portal's queries; every sum follows the app's Store.kt. */
import type { Tx } from '../db/db.service';

export const LIVE_BILLS = `(SELECT * FROM bills b WHERE NOT EXISTS (SELECT 1 FROM bill_voids v WHERE v.bill_id = b.id))`;
export const LIVE_COLS = `(SELECT * FROM collections c WHERE NOT EXISTS (SELECT 1 FROM collection_voids v WHERE v.collection_id = c.id))`;
export const CASH_PART = `CASE WHEN cash_paise + upi_paise > 0 THEN cash_paise WHEN pay_mode = 'cash' THEN amount_paise ELSE 0 END`;
export const UPI_PART = `CASE WHEN cash_paise + upi_paise > 0 THEN upi_paise WHEN pay_mode IN ('upi', 'card') THEN amount_paise ELSE 0 END`;
/** Per grahak: what they owe (positive) or the shop holds for them (negative). */
export const BALANCES = `
  SELECT buyer_id, SUM(amt) AS bal FROM (
    SELECT buyer_id, total_paise - paid_paise AS amt FROM ${LIVE_BILLS} lb WHERE buyer_id IS NOT NULL AND total_paise > paid_paise
    UNION ALL SELECT buyer_id, amount_paise FROM udhaar_entries
    UNION ALL SELECT buyer_id, -amount_paise FROM ${LIVE_COLS} lc
  ) x GROUP BY buyer_id`;
/**
 * Boxes a cold store gave back to a gaadi as lot lines (066 store_sync, ColdStoreService): not
 * more maal, so the reports leave them out of the boxes that came and of the boxes taken off.
 */
export const STORE_BACK = (truck: string, brand: string) =>
  `(SELECT COALESCE(SUM(x.qty), 0) FROM store_sync x WHERE x.truck_id = ${truck} AND x.brand_id IS NOT DISTINCT FROM ${brand} AND x.kind = 'lot')`;
/**
 * A truck_grades row [g] that came with the gaadi, not one a cold store put back. Those carry the
 * gaadi's bhav for the app's stock but were bought once already: what a gaadi cost (kharid,
 * supplier dues, laagat per box) leaves them out.
 */
export const BOUGHT = (g: string) => `NOT EXISTS (SELECT 1 FROM store_sync x WHERE x.id = ${g}.id AND x.kind = 'lot')`;

export const IST_DAY = (col: string) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date`;

export const n = (v: unknown) => Number(v ?? 0);
/** A grahak's mobile, the one thing that says two shops' buyers are the same person. */
export const MOBILE = /^[6-9]\d{9}$/;
// Dates come back as text (::text in SQL): a DATE parsed into a JS Date shifts with the server's zone.
export const day = (v: string) => v.slice(0, 10);

/**
 * Journal vouchers with a supplier on a side (website only, 067): what each did to that supplier.
 * amountPaise > 0 = the supplier debited (we owe him less, as a payment does); < 0 = credited
 * (we owe him more, as a beejak does). Supplier creditors, Supplier Khata and the Trial Balance
 * all read this one list, so they agree.
 */
export async function supplierJvs(tx: Tx) {
  const rows = (await tx.query<{ id: string; no: number; day: string; at: Date; dr_kind: string; dr_ref: string; dr_name: string; cr_kind: string; cr_ref: string; cr_name: string; amount_paise: string; narration: string }>(
    `SELECT id, no, day::text AS day, created_at AS at, dr_kind, dr_ref, dr_name, cr_kind, cr_ref, cr_name, amount_paise, narration FROM journal_vouchers
     WHERE voided_at IS NULL AND (dr_kind = 'supplier' OR cr_kind = 'supplier') ORDER BY day, no`)).rows;
  return rows.flatMap((r) => [
    ...(r.dr_kind === 'supplier' ? [{ id: r.id, no: r.no, date: r.day, at: r.at, name: r.dr_ref, amountPaise: n(r.amount_paise), other: r.cr_name, narration: r.narration }] : []),
    ...(r.cr_kind === 'supplier' ? [{ id: r.id, no: r.no, date: r.day, at: r.at, name: r.cr_ref, amountPaise: -n(r.amount_paise), other: r.dr_name, narration: r.narration }] : []),
  ]);
}
