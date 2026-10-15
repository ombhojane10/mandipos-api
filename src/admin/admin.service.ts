import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Db } from '../db/db.service';

/**
 * What the MandiPlus admin portal reads. Every figure follows the app's own sums (Store.kt), so
 * the portal and the shop's counter never disagree:
 *  - a voided slip or payment counts nowhere (the app deletes them locally);
 *  - a payment's cash/UPI split falls back to its pay_mode for rows from before the split;
 *  - a grahak's baaki is their unpaid slips plus udhaar entries minus everything they paid.
 */

const LIVE_BILLS = `(SELECT * FROM bills b WHERE NOT EXISTS (SELECT 1 FROM bill_voids v WHERE v.bill_id = b.id))`;
const LIVE_COLS = `(SELECT * FROM collections c WHERE NOT EXISTS (SELECT 1 FROM collection_voids v WHERE v.collection_id = c.id))`;
const CASH_PART = `CASE WHEN cash_paise + upi_paise > 0 THEN cash_paise WHEN pay_mode = 'cash' THEN amount_paise ELSE 0 END`;
const UPI_PART = `CASE WHEN cash_paise + upi_paise > 0 THEN upi_paise WHEN pay_mode IN ('upi', 'card') THEN amount_paise ELSE 0 END`;
/** Per grahak: what they owe (positive) or the shop holds for them (negative). */
const BALANCES = `
  SELECT buyer_id, SUM(amt) AS bal FROM (
    SELECT buyer_id, total_paise - paid_paise AS amt FROM ${LIVE_BILLS} lb WHERE buyer_id IS NOT NULL AND total_paise > paid_paise
    UNION ALL SELECT buyer_id, amount_paise FROM udhaar_entries
    UNION ALL SELECT buyer_id, -amount_paise FROM ${LIVE_COLS} lc
  ) x GROUP BY buyer_id`;
const IST_DAY = (col: string) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date`;

const n = (v: unknown) => Number(v ?? 0);
// Dates come back as text (::text in SQL): a DATE parsed into a JS Date shifts with the server's zone.
const day = (v: string) => v.slice(0, 10);

export type ShopRow = {
  id: string; name: string; mandi: string; shopNo: string; gstin: string; commodity: string;
  status: 'pending' | 'approved' | 'rejected'; createdAt: string; approvedAt: string | null; rejectReason: string;
  owner: { name: string; phone: string }; members: number; devices: number; lastSeenAt: string | null;
  todaySalesPaise: number;
};

@Injectable()
export class AdminService {
  constructor(private readonly db: Db) {}

  /** Every shop, requests first, with today's sales for the ones that are open. */
  async shops(): Promise<ShopRow[]> {
    const rows = await this.db.query<{
      id: string; name: string; mandi: string; shop_no: string; gstin: string; commodity: string; created_at: Date;
      approved_at: Date | null; rejected_at: Date | null; reject_reason: string; owner_name: string; owner_phone: string;
      members: string; devices: string; last_seen_at: Date | null;
    }>(
      `SELECT s.id, s.name, s.mandi, s.shop_no, s.gstin, s.commodity, s.created_at, s.approved_at, s.rejected_at, s.reject_reason,
              u.name AS owner_name, u.phone AS owner_phone,
              (SELECT count(*) FROM shop_members m WHERE m.shop_id = s.id) AS members,
              (SELECT count(*) FROM devices d WHERE d.shop_id = s.id AND d.revoked_at IS NULL) AS devices,
              (SELECT max(d.last_seen_at) FROM devices d WHERE d.shop_id = s.id) AS last_seen_at
       FROM shops s JOIN users u ON u.id = s.created_by
       ORDER BY (s.approved_at IS NULL AND s.rejected_at IS NULL) DESC, s.created_at DESC`,
    );
    const out: ShopRow[] = [];
    for (const r of rows) {
      const approved = !!r.approved_at;
      // Few shops, each a cheap indexed sum; row-level security needs one scope per shop anyway.
      const today = approved
        ? await this.db.withShop(r.id, async (tx) => n((await tx.query<{ s: string }>(
          `SELECT COALESCE(SUM(total_paise), 0) AS s FROM ${LIVE_BILLS} lb WHERE business_date = ${IST_DAY('now()')}`)).rows[0].s))
        : 0;
      out.push({
        id: r.id, name: r.name, mandi: r.mandi, shopNo: r.shop_no, gstin: r.gstin, commodity: r.commodity,
        status: approved ? 'approved' : r.rejected_at ? 'rejected' : 'pending',
        createdAt: r.created_at.toISOString(), approvedAt: r.approved_at?.toISOString() ?? null, rejectReason: r.reject_reason,
        owner: { name: r.owner_name, phone: r.owner_phone }, members: n(r.members), devices: n(r.devices),
        lastSeenAt: r.last_seen_at?.toISOString() ?? null, todaySalesPaise: today,
      });
    }
    return out;
  }

  /** Opens the shop: the owner's phone attaches on its next /v1/me. */
  async approve(shopId: string, by: string) {
    const r = await this.db.one<{ id: string }>(
      `UPDATE shops SET approved_at = now(), approved_by = $2, rejected_at = NULL, reject_reason = ''
       WHERE id = $1 AND approved_at IS NULL RETURNING id`, [shopId, by]);
    if (!r) await this.requireShop(shopId, 'Yeh dukaan pehle se approved hai');
  }

  /** Turns a request down. The number is freed, so the owner can register again. */
  async reject(shopId: string, by: string, reason: string) {
    await this.db.tx(async (tx) => {
      const r = await tx.query(
        `UPDATE shops SET rejected_at = now(), reject_reason = $3, approved_by = $2
         WHERE id = $1 AND approved_at IS NULL RETURNING id`, [shopId, by, reason]);
      if (!r.rowCount) {
        const exists = (await tx.query(`SELECT 1 FROM shops WHERE id = $1`, [shopId])).rowCount;
        if (!exists) throw new NotFoundException('Dukaan nahi mili');
        throw new ConflictException('Approved dukaan reject nahi ho sakti');
      }
      await tx.query(`DELETE FROM shop_members WHERE shop_id = $1`, [shopId]);
    });
  }

  /** The shop's profile, team and devices. */
  async shop(shopId: string) {
    const s = (await this.shops()).find((x) => x.id === shopId);
    if (!s) throw new NotFoundException('Dukaan nahi mili');
    const team = await this.db.query<{ name: string; phone: string; role: string; created_at: Date }>(
      `SELECT u.name, u.phone, m.role, m.created_at FROM shop_members m JOIN users u ON u.id = m.user_id
       WHERE m.shop_id = $1 ORDER BY m.created_at`, [shopId]);
    const devices = await this.db.query<{ code: string | null; label: string; app_version: string; last_seen_at: Date | null; phone: string }>(
      `SELECT d.code, d.label, d.app_version, d.last_seen_at, u.phone FROM devices d JOIN users u ON u.id = d.user_id
       WHERE d.shop_id = $1 AND d.revoked_at IS NULL ORDER BY d.code`, [shopId]);
    return {
      ...s,
      team: team.map((t) => ({ name: t.name, phone: t.phone, role: t.role === 'owner' ? 'admin' : 'accountant', joinedAt: t.created_at.toISOString() })),
      devices: devices.map((d) => ({ code: d.code, label: d.label, appVersion: d.app_version, phone: d.phone, lastSeenAt: d.last_seen_at?.toISOString() ?? null })),
    };
  }

  /** The app's Home and Hisab figures for [from, to] (business dates), plus the daily sales bars. */
  async summary(shopId: string, from: string, to: string) {
    if (from > to) throw new BadRequestException('from must be on or before to');
    await this.requireApproved(shopId);
    return this.db.withShop(shopId, async (tx) => {
      const one = async (sql: string, params: unknown[] = [from, to]) => (await tx.query<Record<string, string>>(sql, params)).rows[0];

      const sales = await one(
        `SELECT COUNT(*) AS slips, COALESCE(SUM(total_paise),0) AS sales, COALESCE(SUM(cash_paise),0) AS cash, COALESCE(SUM(upi_paise),0) AS upi
         FROM ${LIVE_BILLS} lb WHERE business_date BETWEEN $1 AND $2`);
      const nags = await one(
        `SELECT COALESCE(SUM(l.qty),0) AS nags FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id
         WHERE lb.business_date BETWEEN $1 AND $2`);
      // Left unpaid on the period's slips, net of vasooli taken against them on any day since.
      const credit = await one(
        `SELECT COALESCE(SUM(GREATEST(0, lb.total_paise - lb.paid_paise
            - COALESCE((SELECT SUM(c.amount_paise) FROM ${LIVE_COLS} c WHERE c.bill_id = lb.id), 0))),0) AS left
         FROM ${LIVE_BILLS} lb WHERE lb.business_date BETWEEN $1 AND $2 AND lb.total_paise > lb.paid_paise`);
      const col = await one(
        `SELECT COUNT(*) AS n, COALESCE(SUM(${CASH_PART}),0) AS cash, COALESCE(SUM(${UPI_PART}),0) AS upi
         FROM ${LIVE_COLS} lc WHERE business_date BETWEEN $1 AND $2`);
      const labour = await one(
        `SELECT (SELECT COALESCE(SUM(labour_paise),0) FROM ${LIVE_BILLS} lb WHERE business_date BETWEEN $1 AND $2 AND labour_paise > 0)
              + (SELECT COALESCE(SUM(amount_paise),0) FROM labour_adjustments WHERE hidden = false AND business_date BETWEEN $1 AND $2) AS paise`);
      const spoiled = await one(
        `SELECT COALESCE(SUM(qty),0) AS nags FROM spoilage WHERE kind = 'spoiled' AND business_date BETWEEN $1 AND $2`);
      // Aaya-Gaya: the daybook's typed lines, without moves between books or mazdoori.
      const book = await one(
        `SELECT COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'in'),0) AS inp, COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'out'),0) AS outp
         FROM daybook_entries WHERE hidden = false AND business_date BETWEEN $1 AND $2
           AND category NOT IN ('opening', 'handover', 'float', 'bank_jama', 'bank_nikala', 'mazdoori')`);
      const voids = await one(
        `SELECT COUNT(*) AS n, COALESCE(SUM(b.total_paise),0) AS paise FROM bill_voids v JOIN bills b ON b.id = v.bill_id
         WHERE ${IST_DAY('v.created_at')} BETWEEN $1 AND $2 AND v.reason <> 'edited'`);

      // As of now, not the period: who owes, and what's still on the gaadis.
      const dues = await one(
        `SELECT COALESCE(SUM(bal) FILTER (WHERE bal > 0),0) AS due, COUNT(*) FILTER (WHERE bal > 0) AS buyers
         FROM (${BALANCES}) x JOIN buyers g ON g.id = x.buyer_id WHERE g.hidden = false`, []);
      const stock = await one(
        `SELECT COALESCE(SUM(GREATEST(0, recv - sold - spoiled)),0) AS left, COUNT(*) AS trucks FROM (
           SELECT t.id,
             (SELECT COALESCE(SUM(billed_qty + free_qty),0) FROM truck_grades g WHERE g.truck_id = t.id)
               - (SELECT COALESCE(SUM(qty),0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind = 'correction') AS recv,
             (SELECT COALESCE(SUM(l.qty),0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE l.truck_id = t.id) AS sold,
             (SELECT COALESCE(SUM(qty),0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind = 'spoiled') AS spoiled
           FROM trucks t WHERE t.closed_at IS NULL) x`, []);

      const series = (await tx.query<{ d: string; sales: string; slips: string }>(
        `SELECT d::date::text AS d, COALESCE(SUM(lb.total_paise),0) AS sales, COUNT(lb.id) AS slips
         FROM generate_series($1::date, $2::date, interval '1 day') d
         LEFT JOIN ${LIVE_BILLS} lb ON lb.business_date = d::date
         GROUP BY d ORDER BY d`, [from, to])).rows;
      const topBuyers = (await tx.query<{ id: string; name: string; sales: string; slips: string }>(
        `SELECT lb.buyer_id AS id, MAX(lb.buyer_name) AS name, SUM(lb.total_paise) AS sales, COUNT(*) AS slips
         FROM ${LIVE_BILLS} lb WHERE lb.buyer_id IS NOT NULL AND business_date BETWEEN $1 AND $2
         GROUP BY lb.buyer_id ORDER BY SUM(lb.total_paise) DESC LIMIT 5`, [from, to])).rows;

      const cash = n(sales.cash), upi = n(sales.upi);
      return {
        from, to,
        salesPaise: n(sales.sales), slips: n(sales.slips), nags: n(nags.nags),
        cashPaise: cash, upiPaise: upi, creditLeftPaise: n(credit.left),
        collectedCashPaise: n(col.cash), collectedUpiPaise: n(col.upi), collections: n(col.n),
        labourPaise: n(labour.paise), spoiledNags: n(spoiled.nags),
        daybookInPaise: n(book.inp), daybookOutPaise: n(book.outp),
        deletedSlips: n(voids.n), deletedPaise: n(voids.paise),
        duePaise: n(dues.due), dueBuyers: n(dues.buyers), stockNags: n(stock.left), openTrucks: n(stock.trucks),
        series: series.map((r) => ({ date: day(r.d), salesPaise: n(r.sales), slips: n(r.slips) })),
        topBuyers: topBuyers.map((r) => ({ id: r.id, name: r.name, salesPaise: n(r.sales), slips: n(r.slips) })),
      };
    });
  }

  /** Grahak matching [q] by name, phone or A/C code; biggest baaki first. */
  async buyers(shopId: string, q: string) {
    await this.requireApproved(shopId);
    return this.db.withShop(shopId, async (tx) => {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = (await tx.query<{ id: string; name: string; phone: string; code: string; kind: string; hidden: boolean; bal: string | null; last_at: string | null; bought: string }>(
        `SELECT g.id, g.name, g.phone, g.code, g.kind, g.hidden, x.bal,
                (SELECT MAX(business_date)::text FROM ${LIVE_BILLS} lb WHERE lb.buyer_id = g.id) AS last_at,
                (SELECT COALESCE(SUM(total_paise),0) FROM ${LIVE_BILLS} lb WHERE lb.buyer_id = g.id) AS bought
         FROM buyers g LEFT JOIN (${BALANCES}) x ON x.buyer_id = g.id
         WHERE ($1 = '' OR g.name ILIKE $2 OR g.phone LIKE $2 OR g.code ILIKE $2)
         ORDER BY g.hidden, GREATEST(COALESCE(x.bal, 0), 0) DESC, g.name LIMIT 60`, [q, like])).rows;
      return rows.map((r) => ({
        id: r.id, name: r.name, phone: r.phone, code: r.code, kind: r.kind, hidden: r.hidden,
        balancePaise: n(r.bal), lastSlipOn: r.last_at ? day(r.last_at) : null, boughtPaise: n(r.bought),
      }));
    });
  }

  /** One grahak: profile, totals, and every slip, payment and udhaar entry with a running balance. */
  async buyer(shopId: string, buyerId: string) {
    await this.requireApproved(shopId);
    return this.db.withShop(shopId, async (tx) => {
      const g = (await tx.query<{ id: string; name: string; phone: string; code: string; kind: string; address: string; destination: string; vehicle: string; credit_limit_paise: string; market_paise: string | null; created_at: Date }>(
        `SELECT id, name, phone, code, kind, address, destination, vehicle, credit_limit_paise, market_paise, created_at FROM buyers WHERE id = $1`, [buyerId])).rows[0];
      if (!g) throw new NotFoundException('Grahak nahi mila');

      const bills = (await tx.query<{ id: string; created_at: Date; business_date: string; slip_no: number | null; number: string; pay_mode: string; total_paise: string; paid_paise: string; cash_paise: string; upi_paise: string; packing: string; staff_name: string }>(
        `SELECT id, created_at, business_date::text AS business_date, slip_no, number, pay_mode, total_paise, paid_paise, cash_paise, upi_paise, packing, staff_name
         FROM ${LIVE_BILLS} lb WHERE buyer_id = $1`, [buyerId])).rows;
      const lines = (await tx.query<{ bill_id: string; brand: string | null; grade: string; qty: number; rate_paise: string; leak: boolean }>(
        `SELECT l.bill_id, br.name AS brand, l.grade, l.qty, l.rate_paise, l.leak FROM bill_lines l
         LEFT JOIN brands br ON br.id = l.brand_id
         WHERE l.bill_id = ANY($1::uuid[]) ORDER BY l.created_at`, [bills.map((b) => b.id)])).rows;
      const cols = (await tx.query<{ id: string; created_at: Date; business_date: string; amount_paise: string; pay_mode: string; receipt_no: number | null; cash: string; upi: string }>(
        `SELECT id, created_at, business_date::text AS business_date, amount_paise, pay_mode, receipt_no, ${CASH_PART} AS cash, ${UPI_PART} AS upi
         FROM ${LIVE_COLS} lc WHERE buyer_id = $1`, [buyerId])).rows;
      const entries = (await tx.query<{ id: string; created_at: Date; business_date: string; amount_paise: string; note: string }>(
        `SELECT id, created_at, business_date::text AS business_date, amount_paise, note FROM udhaar_entries WHERE buyer_id = $1`, [buyerId])).rows;

      type Row = { id: string; at: string; date: string; kind: 'slip' | 'payment' | 'udhaar'; title: string; detail: string; nags: number; debitPaise: number; creditPaise: number; lines?: { brand: string; grade: string; qty: number; ratePaise: number; leak: boolean }[] };
      const mode = (cash: number, upi: number) => (cash && upi ? 'Cash + UPI' : upi ? 'UPI' : 'Cash');
      const byBill = new Map<string, Row['lines']>();
      for (const l of lines) {
        const list = byBill.get(l.bill_id) ?? [];
        list.push({ brand: l.brand ?? '', grade: l.grade, qty: l.qty, ratePaise: n(l.rate_paise), leak: l.leak });
        byBill.set(l.bill_id, list);
      }
      const rows: Row[] = [
        ...bills.map((b): Row => {
          const ls = byBill.get(b.id) ?? [];
          const paid = n(b.paid_paise);
          return {
            id: b.id, at: b.created_at.toISOString(), date: day(b.business_date), kind: 'slip',
            title: `Slip ${b.slip_no ?? b.number}`,
            detail: paid > 0 ? `Paid ${mode(n(b.cash_paise), n(b.upi_paise))}` : b.pay_mode === 'free' ? 'Free' : 'Udhaar',
            nags: ls.reduce((s, l) => s + l.qty, 0), debitPaise: n(b.total_paise), creditPaise: paid, lines: ls,
          };
        }),
        ...cols.map((c): Row => ({
          id: c.id, at: c.created_at.toISOString(), date: day(c.business_date), kind: 'payment',
          title: c.receipt_no ? `Payment #${c.receipt_no}` : 'Payment', detail: mode(n(c.cash), n(c.upi)),
          nags: 0, debitPaise: 0, creditPaise: n(c.amount_paise),
        })),
        ...entries.map((e): Row => {
          const amt = n(e.amount_paise);
          return {
            id: e.id, at: e.created_at.toISOString(), date: day(e.business_date), kind: 'udhaar',
            title: e.note || (amt < 0 ? 'Jama' : 'Udhaar'), detail: amt < 0 ? 'Jama' : 'Udhaar',
            nags: 0, debitPaise: Math.max(0, amt), creditPaise: Math.max(0, -amt),
          };
        }),
      ].sort((a, b) => a.at.localeCompare(b.at));

      let bal = 0;
      const history = rows.map((r) => ({ ...r, balancePaise: (bal += r.debitPaise - r.creditPaise) })).reverse();
      return {
        buyer: {
          id: g.id, name: g.name, phone: g.phone, code: g.code, kind: g.kind, address: g.address, destination: g.destination,
          vehicle: g.vehicle, creditLimitPaise: n(g.credit_limit_paise), marketPaise: g.market_paise === null ? null : n(g.market_paise),
          since: g.created_at.toISOString(),
        },
        totals: {
          balancePaise: bal,
          boughtPaise: bills.reduce((s, b) => s + n(b.total_paise), 0),
          nags: rows.reduce((s, r) => s + r.nags, 0),
          slips: bills.length,
          paidPaise: cols.reduce((s, c) => s + n(c.amount_paise), 0) + bills.reduce((s, b) => s + n(b.paid_paise), 0),
          lastSlipOn: bills.length ? bills.map((b) => day(b.business_date)).sort().at(-1)! : null,
        },
        history,
      };
    });
  }

  private async requireShop(shopId: string, conflict: string) {
    const exists = await this.db.one(`SELECT 1 FROM shops WHERE id = $1`, [shopId]);
    if (!exists) throw new NotFoundException('Dukaan nahi mili');
    throw new ConflictException(conflict);
  }

  private async requireApproved(shopId: string) {
    const s = await this.db.one<{ approved_at: Date | null }>(`SELECT approved_at FROM shops WHERE id = $1`, [shopId]);
    if (!s) throw new NotFoundException('Dukaan nahi mili');
    if (!s.approved_at) throw new ConflictException('Yeh dukaan abhi approve nahi hui');
  }
}
