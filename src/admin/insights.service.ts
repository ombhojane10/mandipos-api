import { BadRequestException, Injectable } from '@nestjs/common';
import { Db } from '../db/db.service';
import { BALANCES, IST_DAY, LIVE_BILLS, n } from './sql';

/**
 * What an owner away from the counter asks of the books, beyond the registers:
 *  - Bikri Register: Tally's columnar sales register, a line per day — cash, UPI, udhaar;
 *  - Gaadi Hisab: each gaadi's landed cost against what it has sold for — its munafa;
 *  - Munafa: the period's profit — bikri, the laagat of the maal sold, phoota, kharcha;
 *  - Nigrani: Tally's exception reports for a mandi — slips deleted or changed, sold under
 *    the day's bhav, udhaar over a grahak's limit, entries at night, big kharche.
 *
 * Laagat is the gaadi's landed cost per nag: (kharid + bhada + mazdoori + commission) over the
 * nag it brought (billed + free − corrections), the same base the stock summary values at.
 */

/** Landed cost and what came in, per gaadi. */
const TRUCK_COST = `
  SELECT t.id,
         (SELECT COALESCE(SUM(billed_qty::bigint * rate_paise), 0) FROM truck_grades g WHERE g.truck_id = t.id)
           + t.freight_paise + t.labour_paise + t.commission_paise AS cost,
         (SELECT COALESCE(SUM(billed_qty + free_qty), 0) FROM truck_grades g WHERE g.truck_id = t.id)
           - (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind = 'correction') AS recv
  FROM trucks t`;

/** Money moved between the shop's own books, loans, chit and supplier payments: not kharcha. */
const NOT_EXPENSE = ['handover', 'float', 'bank_jama', 'bank_nikala', 'supplier', 'udhaar_diya', 'committee_di', 'bhada', 'mazdoori', 'opening'];
/** Mazdoori is counted as earned (on the slips), not as paid out, so paying it is not counted twice. */

const BIG_KHARCHA_PAISE = 500_000;

@Injectable()
export class InsightsService {
  constructor(private readonly db: Db) {}

  /** A line per business day: parchi, nag, cash, UPI, udhaar, total — Tally's Sales Register. */
  async salesRegister(shopId: string, from: string, to: string) {
    if (from > to) throw new BadRequestException('from must be on or before to');
    return this.db.withShop(shopId, async (tx) => {
      const rows = (await tx.query<{ day: string; slips: string; nags: string; total: string; cash: string; upi: string; free: string }>(
        `SELECT lb.business_date::text AS day, COUNT(*) AS slips,
                COALESCE(SUM((SELECT SUM(qty) FROM bill_lines l WHERE l.bill_id = lb.id)), 0) AS nags,
                SUM(lb.total_paise) AS total, SUM(lb.cash_paise) AS cash, SUM(lb.upi_paise) AS upi,
                COUNT(*) FILTER (WHERE lb.pay_mode = 'free') AS free
         FROM ${LIVE_BILLS} lb WHERE lb.business_date BETWEEN $1 AND $2
         GROUP BY lb.business_date ORDER BY lb.business_date`, [from, to])).rows;
      const days = rows.map((r) => {
        const total = n(r.total), cash = n(r.cash), upi = n(r.upi);
        return { date: r.day, slips: n(r.slips), nags: n(r.nags), cashPaise: cash, upiPaise: upi, udhaarPaise: Math.max(0, total - cash - upi), totalPaise: total, free: n(r.free) };
      });
      const sum = (k: 'slips' | 'nags' | 'cashPaise' | 'upiPaise' | 'udhaarPaise' | 'totalPaise') => days.reduce((s, d) => s + d[k], 0);
      return { from, to, days, totals: { slips: sum('slips'), nags: sum('nags'), cashPaise: sum('cashPaise'), upiPaise: sum('upiPaise'), udhaarPaise: sum('udhaarPaise'), totalPaise: sum('totalPaise') } };
    });
  }

  /**
   * Each gaadi's hisab: what it cost landed, what it has sold for, phoota, what is left at cost,
   * and the munafa on what is gone (sold + phoota) — final once the gaadi is closed.
   */
  async gaadiHisab(shopId: string, view: 'active' | 'past') {
    return this.db.withShop(shopId, async (tx) => {
      const rows = (await tx.query<{ id: string; number: string; supplier: string; arrived: string; closed: string | null; brands: string | null; cost: string; recv: string; billed: string; buy: string; sold: string; sales: string; spoiled: string }>(
        `SELECT t.id, t.number, t.supplier, ${IST_DAY('t.arrived_at')}::text AS arrived, ${IST_DAY('t.closed_at')}::text AS closed,
                (SELECT string_agg(DISTINCT br.name, ', ') FROM truck_grades g JOIN brands br ON br.id = g.brand_id WHERE g.truck_id = t.id) AS brands,
                tc.cost, tc.recv,
                (SELECT COALESCE(SUM(billed_qty), 0) FROM truck_grades g WHERE g.truck_id = t.id) AS billed,
                (SELECT COALESCE(SUM(billed_qty::bigint * rate_paise), 0) FROM truck_grades g WHERE g.truck_id = t.id) AS buy,
                (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE l.truck_id = t.id) AS sold,
                (SELECT COALESCE(SUM(l.qty::bigint * l.rate_paise), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE l.truck_id = t.id) AS sales,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind <> 'correction') AS spoiled
         FROM trucks t JOIN (${TRUCK_COST}) tc ON tc.id = t.id
         WHERE ${view === 'past' ? 't.closed_at IS NOT NULL' : 't.closed_at IS NULL'}
         ORDER BY ${view === 'past' ? 't.closed_at DESC LIMIT 300' : 't.arrived_at'}`)).rows;
      const out = rows.map((r) => {
        const cost = n(r.cost), recv = n(r.recv), sold = n(r.sold), spoiled = n(r.spoiled), sales = n(r.sales);
        const per = recv > 0 ? cost / recv : 0;
        const left = Math.max(0, recv - sold - spoiled);
        const gone = Math.round(per * (sold + spoiled));
        return {
          truckId: r.id, number: r.number, supplier: r.supplier, brands: r.brands ?? '', arrivedOn: r.arrived, closedOn: r.closed,
          received: recv, sold, spoiled, left, costPaise: cost,
          buyRatePaise: n(r.billed) ? Math.round(n(r.buy) / n(r.billed)) : 0, landedRatePaise: Math.round(per),
          sellRatePaise: sold ? Math.round(sales / sold) : 0,
          salesPaise: sales, spoiledPaise: Math.round(per * spoiled), leftValuePaise: Math.round(per * left),
          profitPaise: sales - gone,
        };
      });
      const sum = (k: 'costPaise' | 'salesPaise' | 'profitPaise' | 'leftValuePaise' | 'spoiledPaise') => out.reduce((s, r) => s + r[k], 0);
      return { rows: out, totals: { gaadis: out.length, costPaise: sum('costPaise'), salesPaise: sum('salesPaise'), profitPaise: sum('profitPaise'), leftValuePaise: sum('leftValuePaise'), spoiledPaise: sum('spoiledPaise') } };
    });
  }

  /** The period's Munafa (P&L): bikri − laagat of maal sold − phoota = kul munafa; − kharcha = shuddh. */
  async munafa(shopId: string, from: string, to: string) {
    if (from > to) throw new BadRequestException('from must be on or before to');
    return this.db.withShop(shopId, async (tx) => {
      const sales = n((await tx.query<{ s: string }>(
        `SELECT COALESCE(SUM(total_paise), 0) AS s FROM ${LIVE_BILLS} lb WHERE lb.business_date BETWEEN $1 AND $2`, [from, to])).rows[0].s);
      const cogs = n((await tx.query<{ s: string }>(
        `SELECT COALESCE(SUM(l.qty * tc.cost::numeric / NULLIF(tc.recv, 0)), 0)::bigint AS s
         FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id JOIN (${TRUCK_COST}) tc ON tc.id = l.truck_id
         WHERE lb.business_date BETWEEN $1 AND $2`, [from, to])).rows[0].s);
      const spoiled = n((await tx.query<{ s: string }>(
        `SELECT COALESCE(SUM(s.qty * tc.cost::numeric / NULLIF(tc.recv, 0)), 0)::bigint AS s
         FROM spoilage s JOIN (${TRUCK_COST}) tc ON tc.id = s.truck_id
         WHERE s.kind = 'spoiled' AND s.business_date BETWEEN $1 AND $2`, [from, to])).rows[0].s);
      const labour = n((await tx.query<{ s: string }>(
        `SELECT (SELECT COALESCE(SUM(labour_paise), 0) FROM ${LIVE_BILLS} lb WHERE lb.business_date BETWEEN $1 AND $2)
              + (SELECT COALESCE(SUM(amount_paise), 0) FROM labour_adjustments WHERE hidden = false AND business_date BETWEEN $1 AND $2) AS s`,
        [from, to])).rows[0].s);
      const heads = (await tx.query<{ category: string; direction: string; s: string }>(
        `SELECT category, direction, SUM(amount_paise) AS s FROM daybook_entries
         WHERE hidden = false AND business_date BETWEEN $1 AND $2 AND NOT (category = ANY($3)) AND category NOT IN ('udhaar_wapas', 'committee_mili')
         GROUP BY category, direction ORDER BY SUM(amount_paise) DESC`, [from, to, NOT_EXPENSE])).rows;
      const expenses = [
        ...(labour ? [{ head: 'mazdoori', paise: labour }] : []),
        ...heads.filter((h) => h.direction === 'out').map((h) => ({ head: h.category, paise: n(h.s) })),
      ];
      const otherIncome = heads.filter((h) => h.direction === 'in').map((h) => ({ head: h.category, paise: n(h.s) }));
      const gross = sales - cogs - spoiled;
      const exp = expenses.reduce((s, e) => s + e.paise, 0);
      const other = otherIncome.reduce((s, e) => s + e.paise, 0);
      return { from, to, salesPaise: sales, cogsPaise: cogs, spoiledPaise: spoiled, grossPaise: gross, expenses, expensePaise: exp, otherIncome, otherPaise: other, netPaise: gross - exp + other };
    });
  }

  /** Tally's Exception Reports, for a mandi shop, over business dates [from, to]. */
  async nigrani(shopId: string, from: string, to: string) {
    if (from > to) throw new BadRequestException('from must be on or before to');
    return this.db.withShop(shopId, async (tx) => {
      const machine = `COALESCE(NULLIF(CONCAT_WS(' · ', d.code, NULLIF(d.label, '')), ''), '—')`;
      const voids = (await tx.query<{ id: string; slip_no: number | null; number: string; buyer: string; total: string; reason: string; at: Date; day: string; machine: string; by: string }>(
        `SELECT b.id, b.slip_no, b.number, b.buyer_name AS buyer, b.total_paise AS total, v.reason, v.created_at AS at, b.business_date::text AS day, ${machine} AS machine,
                ${machine.replace(/\bd\./g, 'vd.')} AS by
         FROM bill_voids v JOIN bills b ON b.id = v.bill_id LEFT JOIN devices d ON d.id = b.device_id LEFT JOIN devices vd ON vd.id = v.device_id
         WHERE ${IST_DAY('v.created_at')} BETWEEN $1 AND $2 ORDER BY v.created_at DESC LIMIT 200`, [from, to])).rows;
      const receipts = (await tx.query<{ id: string; receipt_no: number | null; buyer: string; amount: string; reason: string; at: Date; by: string }>(
        `SELECT c.id, c.receipt_no, g.name AS buyer, c.amount_paise AS amount, v.reason, v.created_at AS at, ${machine} AS by
         FROM collection_voids v JOIN collections c ON c.id = v.collection_id LEFT JOIN buyers g ON g.id = c.buyer_id LEFT JOIN devices d ON d.id = v.device_id
         WHERE ${IST_DAY('v.created_at')} BETWEEN $1 AND $2 ORDER BY v.created_at DESC LIMIT 200`, [from, to])).rows;
      const below = (await tx.query<{ id: string; slip_no: number | null; buyer: string; day: string; grade: string; brand: string | null; qty: number; rate: string; bhav: string; machine: string }>(
        `SELECT lb.id, lb.slip_no, lb.buyer_name AS buyer, lb.business_date::text AS day, l.grade, br.name AS brand, l.qty, l.rate_paise AS rate, r.rate_paise AS bhav, ${machine} AS machine
         FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id
         JOIN rates r ON r.business_date = lb.business_date AND r.brand_id = l.brand_id AND r.grade = l.grade
         LEFT JOIN brands br ON br.id = l.brand_id LEFT JOIN devices d ON d.id = lb.device_id
         WHERE lb.business_date BETWEEN $1 AND $2 AND lb.pay_mode <> 'free' AND l.leak = false AND l.rate_paise < r.rate_paise
         ORDER BY l.qty::bigint * (r.rate_paise - l.rate_paise) DESC LIMIT 200`, [from, to])).rows;
      const overLimit = (await tx.query<{ id: string; name: string; phone: string; code: string; bal: string; limit_paise: string }>(
        `SELECT g.id, g.name, g.phone, g.code, x.bal, g.credit_limit_paise AS limit_paise
         FROM buyers g JOIN (${BALANCES}) x ON x.buyer_id = g.id
         WHERE g.credit_limit_paise > 0 AND x.bal > g.credit_limit_paise ORDER BY x.bal - g.credit_limit_paise DESC`)).rows;
      const night = (await tx.query<{ id: string; slip_no: number | null; buyer: string; total: string; at: Date; machine: string }>(
        `SELECT lb.id, lb.slip_no, lb.buyer_name AS buyer, lb.total_paise AS total, lb.created_at AS at, ${machine} AS machine
         FROM ${LIVE_BILLS} lb LEFT JOIN devices d ON d.id = lb.device_id
         WHERE lb.business_date BETWEEN $1 AND $2
           AND (EXTRACT(HOUR FROM lb.created_at AT TIME ZONE 'Asia/Kolkata') >= 22 OR EXTRACT(HOUR FROM lb.created_at AT TIME ZONE 'Asia/Kolkata') < 5)
         ORDER BY lb.created_at DESC LIMIT 200`, [from, to])).rows;
      const big = (await tx.query<{ id: string; category: string; party: string; note: string; amount: string; mode: string; day: string }>(
        `SELECT id, category, party_name AS party, note, amount_paise AS amount, mode, business_date::text AS day FROM daybook_entries
         WHERE hidden = false AND direction = 'out' AND business_date BETWEEN $1 AND $2 AND amount_paise >= $3
           AND category NOT IN ('handover', 'float', 'bank_jama', 'bank_nikala', 'supplier', 'opening')
         ORDER BY amount_paise DESC LIMIT 100`, [from, to, BIG_KHARCHA_PAISE])).rows;
      return {
        from, to,
        voids: voids.map((v) => ({ billId: v.id, slipNo: v.slip_no, number: v.number, buyer: v.buyer, totalPaise: n(v.total), reason: v.reason, at: v.at.toISOString(), date: v.day, machine: v.machine, by: v.by })),
        receipts: receipts.map((r) => ({ id: r.id, receiptNo: r.receipt_no, buyer: r.buyer ?? '', amountPaise: n(r.amount), reason: r.reason, at: r.at.toISOString(), by: r.by })),
        belowBhav: below.map((b) => ({ billId: b.id, slipNo: b.slip_no, buyer: b.buyer, date: b.day, brand: b.brand ?? 'Maal', grade: b.grade, qty: b.qty,
          ratePaise: n(b.rate), bhavPaise: n(b.bhav), lossPaise: b.qty * (n(b.bhav) - n(b.rate)), machine: b.machine })),
        overLimit: overLimit.map((o) => ({ buyerId: o.id, name: o.name, phone: o.phone, code: o.code, balancePaise: n(o.bal), limitPaise: n(o.limit_paise) })),
        night: night.map((x) => ({ billId: x.id, slipNo: x.slip_no, buyer: x.buyer, totalPaise: n(x.total), at: x.at.toISOString(), machine: x.machine })),
        bigKharcha: big.map((b) => ({ id: b.id, head: b.category, party: b.party, note: b.note, amountPaise: n(b.amount), mode: b.mode, date: b.day })),
      };
    });
  }
}
