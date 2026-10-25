import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Db } from '../db/db.service';
import { BALANCES, IST_DAY, LIVE_BILLS, n } from './sql';
import { nameKey } from './reports.service';

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

  /**
   * The grapes desk, over business dates [from, to]:
   *  - dispatch: each slip's boxes against what the labour has handed over at the gaadi (pickups);
   *  - gaadis: every open gaadi, where it stands and what each quality has left;
   *  - suppliers: each party's boxes and bikri, and the shop's commission on it;
   *  - days: APMC, and mazdoori charged on slips against mazdoori paid out of the daybook.
   */
  async angoor(shopId: string, from: string, to: string, commissionBps: number) {
    if (from > to) throw new BadRequestException('from must be on or before to');
    return this.db.withShop(shopId, async (tx) => {
      const slips = (await tx.query<{ id: string; slip_no: number | null; buyer: string; day: string; at: Date; pay_mode: string; total: string; boxes: string; picked: string; last_pick: Date | null; first_pick: Date | null; gaadis: { truckId: string; number: string; location: string; qty: number }[] }>(
        `SELECT lb.id, lb.slip_no, lb.buyer_name AS buyer, lb.business_date::text AS day, lb.created_at AS at, lb.pay_mode, lb.total_paise AS total,
                (SELECT COALESCE(SUM(qty), 0) FROM bill_lines l WHERE l.bill_id = lb.id) AS boxes,
                (SELECT COALESCE(SUM(qty), 0) FROM pickups p WHERE p.bill_id = lb.id) AS picked,
                (SELECT MAX(created_at) FROM pickups p WHERE p.bill_id = lb.id) AS last_pick,
                (SELECT MIN(created_at) FROM pickups p WHERE p.bill_id = lb.id) AS first_pick,
                (SELECT COALESCE(json_agg(json_build_object('truckId', t.id, 'number', t.number, 'location', t.location, 'qty', g.qty) ORDER BY t.number), '[]')
                 FROM (SELECT truck_id, SUM(qty)::int AS qty FROM bill_lines l WHERE l.bill_id = lb.id AND l.truck_id IS NOT NULL GROUP BY truck_id) g
                 JOIN trucks t ON t.id = g.truck_id) AS gaadis
         FROM ${LIVE_BILLS} lb WHERE lb.business_date BETWEEN $1 AND $2
         ORDER BY lb.created_at DESC`, [from, to])).rows.map((r) => {
        const boxes = n(r.boxes), picked = Math.min(n(r.picked), boxes);
        return { billId: r.id, slipNo: r.slip_no, buyer: r.buyer, date: r.day, at: r.at, payMode: r.pay_mode, totalPaise: n(r.total),
          boxes, picked, left: boxes - picked, lastPickAt: r.last_pick, firstPickAt: r.first_pick, gaadis: r.gaadis };
      }).filter((s) => s.boxes > 0);

      // What is still to be handed over at each open gaadi, whatever day the slip was cut: a slip's
      // pending boxes, shared over its gaadis.
      const pending = (await tx.query<{ truck_id: string; waiting: string }>(
        `SELECT x.truck_id, SUM(ROUND(x.left_qty::numeric * x.qty / NULLIF(x.boxes, 0)))::bigint AS waiting FROM (
           SELECT l.truck_id, SUM(l.qty) AS qty, bx.boxes, GREATEST(bx.boxes - bx.picked, 0) AS left_qty
           FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id JOIN trucks t ON t.id = l.truck_id AND t.closed_at IS NULL
           JOIN LATERAL (SELECT (SELECT SUM(qty) FROM bill_lines z WHERE z.bill_id = lb.id) AS boxes,
                                (SELECT COALESCE(SUM(qty), 0) FROM pickups p WHERE p.bill_id = lb.id) AS picked) bx ON true
           GROUP BY l.truck_id, lb.id, bx.boxes, bx.picked) x
         WHERE x.left_qty > 0 GROUP BY x.truck_id`)).rows;
      const waiting = new Map(pending.map((r) => [r.truck_id, n(r.waiting)] as const));

      // Each open gaadi's qualities, a box count added later or taken off as a correction folded in.
      const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
      const lots = (await tx.query<{ truck_id: string; number: string; supplier: string; location: string; arrived: string; freight: string; brand_id: string | null; quality: string | null; box_grams: number; rate: string; received: string; corrected: string; sold: string; sold_now: string; off: string }>(
        `SELECT t.id AS truck_id, t.number, TRIM(t.supplier) AS supplier, t.location, ${IST_DAY('t.arrived_at')}::text AS arrived, t.freight_paise AS freight,
                g.brand_id, br.name AS quality, g.box_grams, g.rate, g.received,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.brand_id IS NOT DISTINCT FROM g.brand_id AND s.kind = 'correction') AS corrected,
                (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id
                 WHERE l.truck_id = t.id AND l.brand_id IS NOT DISTINCT FROM g.brand_id) AS sold,
                (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id
                 WHERE l.truck_id = t.id AND l.brand_id IS NOT DISTINCT FROM g.brand_id AND lb.business_date = $1) AS sold_now,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.brand_id IS NOT DISTINCT FROM g.brand_id AND s.kind <> 'correction') AS off
         FROM trucks t
         JOIN (SELECT truck_id, brand_id, SUM(received_qty) AS received, MAX(box_grams) AS box_grams,
                      (array_agg(rate_paise ORDER BY created_at DESC))[1] AS rate, MIN(created_at) AS first_at
               FROM truck_grades GROUP BY truck_id, brand_id) g ON g.truck_id = t.id
         LEFT JOIN brands br ON br.id = g.brand_id
         WHERE t.closed_at IS NULL ORDER BY t.arrived_at, g.first_at`, [today])).rows;
      type Quality = { brandId: string | null; name: string; kg: number; ratePaise: number; received: number; sold: number; off: number; left: number; over: number }
      const gaadis = new Map<string, { truckId: string; number: string; supplier: string; supplierKey: string; location: string; arrivedOn: string; freightPaise: number; received: number; sold: number; soldNow: number; left: number; over: number; waiting: number; qualities: Quality[] }>();
      for (const r of lots) {
        const g = gaadis.get(r.truck_id) ?? { truckId: r.truck_id, number: r.number, supplier: r.supplier, supplierKey: nameKey(r.supplier), location: r.location, arrivedOn: r.arrived,
          freightPaise: n(r.freight), received: 0, sold: 0, soldNow: 0, left: 0, over: 0, waiting: waiting.get(r.truck_id) ?? 0, qualities: [] };
        const received = Math.max(0, n(r.received) - n(r.corrected)), sold = n(r.sold), off = n(r.off);
        // Grapes never refuses a sale on the count: more sold than came shows as "over", never as a minus.
        const left = Math.max(0, received - sold - off), over = Math.max(0, sold + off - received);
        g.qualities.push({ brandId: r.brand_id, name: r.quality ?? '', kg: r.box_grams / 1000, ratePaise: n(r.rate), received, sold, off, left, over });
        g.received += received; g.sold += sold; g.soldNow += n(r.sold_now); g.left += left; g.over += over;
        gaadis.set(r.truck_id, g);
      }

      // Commission is per consignment, as the beejak is: each gaadi with all it has sold. Every open
      // gaadi is listed (sold or not yet), and a closed one when it came or sold in the period.
      const sales = (await tx.query<{ truck_id: string; number: string; supplier: string; location: string; arrived: string; closed: boolean; boxes: string; sales: string }>(
        `SELECT t.id AS truck_id, t.number, TRIM(t.supplier) AS supplier, t.location, ${IST_DAY('t.arrived_at')}::text AS arrived, t.closed_at IS NOT NULL AS closed,
                COALESCE(SUM(l.qty), 0) AS boxes, COALESCE(SUM(l.qty::bigint * l.rate_paise), 0) AS sales
         FROM trucks t
         LEFT JOIN (SELECT l.* FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id) l ON l.truck_id = t.id
         WHERE t.closed_at IS NULL OR ${IST_DAY('t.arrived_at')} BETWEEN $1 AND $2
            OR EXISTS (SELECT 1 FROM bill_lines z JOIN ${LIVE_BILLS} zb ON zb.id = z.bill_id WHERE z.truck_id = t.id AND zb.business_date BETWEEN $1 AND $2)
         GROUP BY t.id ORDER BY t.arrived_at DESC`, [from, to])).rows;
      type Consignment = { truckId: string; number: string; location: string; arrivedOn: string; closed: boolean; boxes: number; salesPaise: number; commissionPaise: number; netPaise: number }
      const parties = new Map<string, { key: string; name: string; gaadis: Consignment[]; boxes: number; salesPaise: number; commissionPaise: number; netPaise: number }>();
      for (const r of sales) {
        const key = nameKey(r.supplier) || `gaadi:${r.truck_id}`;
        const p = parties.get(key) ?? { key, name: r.supplier || r.number, gaadis: [], boxes: 0, salesPaise: 0, commissionPaise: 0, netPaise: 0 };
        const sale = n(r.sales), commission = Math.round((sale * commissionBps) / 10_000);
        p.gaadis.push({ truckId: r.truck_id, number: r.number, location: r.location, arrivedOn: r.arrived, closed: r.closed, boxes: n(r.boxes), salesPaise: sale, commissionPaise: commission, netPaise: sale - commission });
        p.boxes += n(r.boxes); p.salesPaise += sale; p.commissionPaise += commission; p.netPaise += sale - commission;
        parties.set(key, p);
      }
      const suppliers = [...parties.values()].map((p) => ({ ...p, key: p.key.startsWith('gaadi:') ? '' : p.key }))
        .sort((a, b) => b.salesPaise - a.salesPaise || a.name.localeCompare(b.name));

      const dayRows = (await tx.query<{ day: string; slips: string; goods: string; apmc: string; labour: string; paid: string }>(
        `SELECT d::date::text AS day,
                (SELECT COUNT(*) FROM ${LIVE_BILLS} lb WHERE lb.business_date = d::date) AS slips,
                (SELECT COALESCE(SUM(total_paise - chungi_paise), 0) FROM ${LIVE_BILLS} lb WHERE lb.business_date = d::date) AS goods,
                (SELECT COALESCE(SUM(apmc_paise), 0) FROM ${LIVE_BILLS} lb WHERE lb.business_date = d::date) AS apmc,
                (SELECT COALESCE(SUM(labour_paise), 0) FROM ${LIVE_BILLS} lb WHERE lb.business_date = d::date) AS labour,
                (SELECT COALESCE(SUM(amount_paise), 0) FROM daybook_entries e
                 WHERE e.hidden = false AND e.category = 'mazdoori' AND e.direction = 'out' AND e.business_date = d::date) AS paid
         FROM generate_series($1::date, $2::date, interval '1 day') d ORDER BY d`, [from, to])).rows;
      const labourSlips = (await tx.query<{ id: string; slip_no: number | null; buyer: string; day: string; boxes: string; labour: string }>(
        `SELECT lb.id, lb.slip_no, lb.buyer_name AS buyer, lb.business_date::text AS day, lb.labour_paise AS labour,
                (SELECT COALESCE(SUM(qty), 0) FROM bill_lines l WHERE l.bill_id = lb.id) AS boxes
         FROM ${LIVE_BILLS} lb WHERE lb.labour_paise > 0 AND lb.business_date BETWEEN $1 AND $2 ORDER BY lb.created_at DESC`, [from, to])).rows
        .map((r) => ({ billId: r.id, slipNo: r.slip_no, buyer: r.buyer, date: r.day, boxes: n(r.boxes), labourPaise: n(r.labour) }));
      const labourPaid = (await tx.query<{ id: string; day: string; party: string; note: string; mode: string; amount: string }>(
        `SELECT id, business_date::text AS day, party_name AS party, note, mode, amount_paise AS amount FROM daybook_entries
         WHERE hidden = false AND category = 'mazdoori' AND direction = 'out' AND business_date BETWEEN $1 AND $2 ORDER BY created_at DESC`, [from, to])).rows
        .map((r) => ({ id: r.id, date: r.day, party: r.party, note: r.note, mode: r.mode, amountPaise: n(r.amount) }));
      const days = dayRows.map((r) => ({ date: r.day, slips: n(r.slips), goodsPaise: n(r.goods), apmcPaise: n(r.apmc), labourPaise: n(r.labour), labourPaidPaise: n(r.paid) }));
      const total = (k: 'goodsPaise' | 'apmcPaise' | 'labourPaise' | 'labourPaidPaise') => days.reduce((s, d) => s + d[k], 0);
      const g = [...gaadis.values()];

      return {
        from, to, commissionBps, slips, gaadis: g, suppliers, days, labourSlips, labourPaid,
        totals: {
          slips: slips.length, boxes: slips.reduce((s, x) => s + x.boxes, 0), picked: slips.reduce((s, x) => s + x.picked, 0),
          pendingSlips: slips.filter((x) => x.left > 0).length, doneSlips: slips.filter((x) => x.left === 0).length,
          openGaadis: g.length, boxesLeft: g.reduce((s, x) => s + Math.max(0, x.left), 0),
          salesPaise: suppliers.reduce((s, x) => s + x.salesPaise, 0), commissionPaise: suppliers.reduce((s, x) => s + x.commissionPaise, 0),
          goodsPaise: total('goodsPaise'), apmcPaise: total('apmcPaise'), labourPaise: total('labourPaise'), labourPaidPaise: total('labourPaidPaise'),
        },
      };
    });
  }

  /**
   * A party's beejak (sale proceed) for one gaadi, as the shop's old books print it: each quality
   * sold, its boxes, average bhav and amount, the gross, and the gaadi's bhada. The other
   * deductions (commission %, mazdoori a box, dak) are the counter's to set on the page.
   */
  async beejak(shopId: string, truckId: string) {
    return this.db.withShop(shopId, async (tx) => {
      const t = (await tx.query<{ id: string; number: string; supplier: string; location: string; arrived: string; closed: boolean; freight: string }>(
        `SELECT id, number, TRIM(supplier) AS supplier, location, ${IST_DAY('arrived_at')}::text AS arrived, closed_at IS NOT NULL AS closed, freight_paise AS freight
         FROM trucks WHERE id = $1`, [truckId])).rows[0];
      if (!t) throw new NotFoundException('Gaadi nahi mili');
      // A line per quality with the boxes sold. The bhav on a beejak is the shop's to write — the
      // party is not shown what each box actually went for — so it is typed on the page.
      const groups = (await tx.query<{ quality: string | null; qty: string; amount: string; first: string; last: string }>(
        `SELECT br.name AS quality, SUM(l.qty) AS qty, SUM(l.qty::bigint * l.rate_paise) AS amount,
                MIN(lb.business_date)::text AS first, MAX(lb.business_date)::text AS last
         FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id LEFT JOIN brands br ON br.id = l.brand_id
         WHERE l.truck_id = $1 GROUP BY br.name ORDER BY MIN(lb.created_at)`, [truckId])).rows
        .map((r) => ({ quality: r.quality ?? '', qty: n(r.qty), amountPaise: n(r.amount), first: r.first, last: r.last }));
      const came = (await tx.query<{ received: string; corrected: string; off: string }>(
        `SELECT (SELECT COALESCE(SUM(received_qty), 0) FROM truck_grades WHERE truck_id = $1) AS received,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage WHERE truck_id = $1 AND kind = 'correction') AS corrected,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage WHERE truck_id = $1 AND kind <> 'correction') AS off`, [truckId])).rows[0];
      const received = Math.max(0, n(came.received) - n(came.corrected));
      const sold = groups.reduce((s, g) => s + g.qty, 0);
      return {
        truckId: t.id, number: t.number, party: t.supplier, supplierKey: nameKey(t.supplier), location: t.location, arrivedOn: t.arrived, closed: t.closed,
        received, sold, off: n(came.off), left: Math.max(0, received - sold - n(came.off)), freightPaise: n(t.freight),
        groups, grossPaise: groups.reduce((s, g) => s + g.amountPaise, 0),
        from: groups.map((g) => g.first).sort()[0] ?? null, to: groups.map((g) => g.last).sort().at(-1) ?? null,
      };
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
