import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Db, Tx } from '../db/db.service';
import { CASH_PART, IST_DAY, LIVE_BILLS, LIVE_COLS, UPI_PART, n } from './sql';

/**
 * Tally's reports for one shop, read off the books the terminals sync. Each one ports the
 * app's own sum (Store.kt) so the website and the counter can never show two numbers:
 *  - Cash / Bank Book: Store.book/openingPaise — counter cash and UPI, typed lines, transfers;
 *  - Supplier dues: Store.suppliers — gaadi goods (less corrections) + bhada − supplier payments;
 *  - Stock: Models.stockOf — billed + free − corrections − sold − phoota, per open gaadi.
 */

export type Pot = 'galla' | 'office' | 'bank';
const POT_MODES: Record<Pot, string[]> = { galla: ['cash'], office: ['office'], bank: ['upi', 'bank'] };
/** Transfers: written once as "out" in the book the money left; this is the book it went into. */
const TRANSFER_INTO: Record<string, Pot> = { handover: 'office', float: 'galla', bank_jama: 'bank', bank_nikala: 'office' };
// The app's "0000-01-01"; Postgres has no year 0.
const ALL_FROM = '0001-01-01';

const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const prevDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
/** "Pintu Gujarat" and "PINTU GUJARAT." are one supplier (GrahakSearch.norm). */
export const nameKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export type Buckets = { d0_7: number; d8_30: number; d31: number };

/**
 * What is still unpaid, aged: payments clear the oldest dues first (FIFO), and whatever is left
 * of each due is bucketed by how many days old it is.
 */
export function age(dues: { at: Date; amount: number }[], paid: number, today: string): Buckets & { total: number; oldestDays: number | null } {
  const b: Buckets = { d0_7: 0, d8_30: 0, d31: 0 };
  let left = paid, total = 0, oldestDays: number | null = null;
  for (const d of [...dues].sort((x, y) => x.at.getTime() - y.at.getTime())) {
    const off = Math.min(left, d.amount);
    left -= off;
    const rest = d.amount - off;
    if (rest <= 0) continue;
    const days = daysBetween(istDay(d.at), today);
    oldestDays ??= days;
    total += rest;
    if (days <= 7) b.d0_7 += rest; else if (days <= 30) b.d8_30 += rest; else b.d31 += rest;
  }
  return { ...b, total, oldestDays };
}

type BookLine = { id: string; date: string; at: string; kind: 'bikri' | 'vasooli' | 'in' | 'out'; title: string; party: string; note: string; inPaise: number; outPaise: number; auto: boolean };

@Injectable()
export class ReportsService {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- Cash / Bank Book

  /** One book over [from, to], brought forward and carried forward, as the app's Daybook draws it. */
  async cashbook(shopId: string, pot: Pot, from: string, to: string) {
    if (from > to) throw new BadRequestException('from must be on or before to');
    return this.db.withShop(shopId, (tx) => this.book(tx, pot, from, to));
  }

  private async book(tx: Tx, pot: Pot, from: string, to: string) {
    const modes = POT_MODES[pot];
    const stated = (await tx.query<{ day: string; amount: string }>(
      `SELECT business_date::text AS day, amount_paise AS amount FROM daybook_entries
       WHERE category = 'opening' AND hidden = false AND mode = ANY($1) ORDER BY created_at DESC LIMIT 1`, [modes])).rows[0];
    const usable = stated && stated.day <= from ? stated : undefined;
    const since = usable?.day ?? ALL_FROM;
    const lines = await this.bookLines(tx, pot, since, to);
    const before = prevDay(from);
    const opening = n(usable?.amount) + lines.filter((l) => l.date <= before && l.date >= since).reduce((t, l) => t + l.inPaise - l.outPaise, 0);
    const period = lines.filter((l) => l.date >= from && l.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date) || Number(b.auto) - Number(a.auto) || a.at.localeCompare(b.at));
    let bal = opening;
    const rows = period.map((l) => ({ ...l, balancePaise: (bal += l.inPaise - l.outPaise) }));
    const inPaise = period.reduce((t, l) => t + l.inPaise, 0), outPaise = period.reduce((t, l) => t + l.outPaise, 0);
    return { pot, from, to, openingPaise: opening, inPaise, outPaise, closingPaise: opening + inPaise - outPaise, lines: rows };
  }

  private async bookLines(tx: Tx, pot: Pot, since: string, to: string): Promise<BookLine[]> {
    const modes = POT_MODES[pot];
    const out: BookLine[] = [];
    // The counter's money, a line a day: cash lands in the galla, UPI in the bank.
    if (pot !== 'office') {
      const bills = (await tx.query<{ day: string; amt: string; n: string }>(
        `SELECT business_date::text AS day, SUM(${pot === 'galla' ? 'cash_paise' : 'upi_paise'}) AS amt, COUNT(*) AS n
         FROM ${LIVE_BILLS} lb WHERE business_date BETWEEN $1 AND $2 GROUP BY business_date`, [since, to])).rows;
      for (const r of bills) if (n(r.amt) > 0) out.push({ id: `bikri-${r.day}`, date: r.day, at: `${r.day}T00:00:00Z`, kind: 'bikri', title: pot === 'galla' ? 'Cash bikri' : 'UPI bikri', party: '', note: `${r.n} parchi`, inPaise: n(r.amt), outPaise: 0, auto: true });
      const cols = (await tx.query<{ day: string; amt: string; n: string }>(
        `SELECT business_date::text AS day, SUM(${pot === 'galla' ? CASH_PART : UPI_PART}) AS amt, COUNT(*) AS n
         FROM ${LIVE_COLS} lc WHERE business_date BETWEEN $1 AND $2 GROUP BY business_date`, [since, to])).rows;
      for (const r of cols) if (n(r.amt) > 0) out.push({ id: `vasooli-${r.day}`, date: r.day, at: `${r.day}T00:00:01Z`, kind: 'vasooli', title: pot === 'galla' ? 'Cash vasooli' : 'UPI vasooli', party: '', note: `${r.n} raseed`, inPaise: n(r.amt), outPaise: 0, auto: true });
    }
    const into = Object.entries(TRANSFER_INTO).filter(([, p]) => p === pot).map(([c]) => c);
    const typed = (await tx.query<{ id: string; day: string; at: Date; direction: string; mode: string; category: string; party: string; note: string; amount: string }>(
      `SELECT id, business_date::text AS day, created_at AS at, direction, mode, category, party_name AS party, note, amount_paise AS amount
       FROM daybook_entries WHERE hidden = false AND category <> 'opening' AND business_date BETWEEN $1 AND $2
         AND (mode = ANY($3) OR (category = ANY($4) AND NOT mode = ANY($3)))`, [since, to, modes, into])).rows;
    for (const e of typed) {
      const mine = modes.includes(e.mode);
      // A transfer into this book from another: its mirror, as money in.
      const incoming = !mine || e.direction === 'in';
      out.push({ id: e.id + (mine ? '' : '-in'), date: e.day, at: e.at.toISOString(), kind: incoming ? 'in' : 'out', title: e.category, party: e.party, note: e.note,
        inPaise: incoming ? n(e.amount) : 0, outPaise: incoming ? 0 : n(e.amount), auto: false });
    }
    return out;
  }

  // ---------------------------------------------------------------- Outstanding (udhaar)

  /** Every grahak who owes, aged 0–7 / 8–30 / 31+ days, biggest first. */
  async outstanding(shopId: string, today: string) {
    return this.db.withShop(shopId, (tx) => this.receivables(tx, today));
  }

  private async receivables(tx: Tx, today: string) {
    const dues = (await tx.query<{ buyer_id: string; at: Date; amt: string }>(
      `SELECT buyer_id, created_at AS at, total_paise - paid_paise AS amt FROM ${LIVE_BILLS} lb WHERE buyer_id IS NOT NULL AND total_paise > paid_paise
       UNION ALL SELECT buyer_id, created_at, amount_paise FROM udhaar_entries WHERE amount_paise > 0`)).rows;
    const paid = (await tx.query<{ buyer_id: string; amt: string; last: Date | null }>(
      `SELECT buyer_id, SUM(amt) AS amt, MAX(at) FILTER (WHERE pay) AS last FROM (
         SELECT buyer_id, amount_paise AS amt, created_at AS at, true AS pay FROM ${LIVE_COLS} lc
         UNION ALL SELECT buyer_id, -amount_paise, created_at, false FROM udhaar_entries WHERE amount_paise < 0
       ) x GROUP BY buyer_id`)).rows;
    const buyers = (await tx.query<{ id: string; name: string; phone: string; code: string; last_slip: string | null }>(
      `SELECT g.id, g.name, g.phone, g.code, (SELECT MAX(business_date)::text FROM ${LIVE_BILLS} lb WHERE lb.buyer_id = g.id) AS last_slip
       FROM buyers g WHERE g.hidden = false`)).rows;
    const byBuyer = new Map<string, { at: Date; amount: number }[]>();
    for (const d of dues) { const l = byBuyer.get(d.buyer_id) ?? []; l.push({ at: d.at, amount: n(d.amt) }); byBuyer.set(d.buyer_id, l); }
    const paidBy = new Map(paid.map((p) => [p.buyer_id, p]));
    const rows = buyers.map((g) => {
      const a = age(byBuyer.get(g.id) ?? [], n(paidBy.get(g.id)?.amt), today);
      return { buyerId: g.id, name: g.name, phone: g.phone, code: g.code, duePaise: a.total, d0_7: a.d0_7, d8_30: a.d8_30, d31: a.d31, oldestDays: a.oldestDays,
        lastSlipOn: g.last_slip, lastPaidAt: paidBy.get(g.id)?.last?.toISOString() ?? null };
    }).filter((r) => r.duePaise > 0).sort((a, b) => b.duePaise - a.duePaise);
    const totals = rows.reduce((t, r) => ({ duePaise: t.duePaise + r.duePaise, d0_7: t.d0_7 + r.d0_7, d8_30: t.d8_30 + r.d8_30, d31: t.d31 + r.d31 }), { duePaise: 0, d0_7: 0, d8_30: 0, d31: 0 });
    return { totals: { ...totals, count: rows.length }, rows };
  }

  // ---------------------------------------------------------------- Suppliers (payables)

  /** Every supplier: gaadis, what they cost, what was paid, what the shop still owes, aged. */
  async suppliers(shopId: string, today: string) {
    return this.db.withShop(shopId, (tx) => this.payables(tx, today));
  }

  private async supplierBooks(tx: Tx) {
    const gaadis = (await tx.query<{ id: string; number: string; supplier: string; arrived_at: Date; closed: boolean; freight: string; received: string; billed: string; goods: string; brands: string | null; sold: string; spoiled: string; corrected: string }>(
      `SELECT t.id, t.number, TRIM(t.supplier) AS supplier, t.arrived_at, t.closed_at IS NOT NULL AS closed, t.freight_paise AS freight,
              COALESCE(g.received, 0) AS received, COALESCE(g.billed, 0) AS billed, COALESCE(g.goods, 0) AS goods, g.brands,
              COALESCE(s.sold, 0) AS sold, COALESCE(sp.spoiled, 0) AS spoiled, COALESCE(sp.corrected, 0) AS corrected
       FROM trucks t
       LEFT JOIN (SELECT gr.truck_id, SUM(gr.received_qty) received, SUM(gr.billed_qty) billed, SUM(gr.billed_qty::bigint * gr.rate_paise) goods,
                         string_agg(DISTINCT br.name, ', ') brands
                  FROM truck_grades gr LEFT JOIN brands br ON br.id = gr.brand_id GROUP BY gr.truck_id) g ON g.truck_id = t.id
       LEFT JOIN (SELECT l.truck_id, SUM(l.qty) sold FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id GROUP BY l.truck_id) s ON s.truck_id = t.id
       LEFT JOIN (SELECT truck_id, SUM(CASE WHEN kind = 'correction' THEN 0 ELSE qty END) spoiled,
                         SUM(CASE WHEN kind = 'correction' THEN qty ELSE 0 END) corrected FROM spoilage GROUP BY truck_id) sp ON sp.truck_id = t.id
       WHERE TRIM(t.supplier) <> '' ORDER BY t.arrived_at DESC`)).rows.map((r) => {
      const billed = n(r.billed), goods = n(r.goods), corrected = n(r.corrected);
      // A count entered too high comes off at the gaadi's own average bhav.
      const goodsNet = Math.max(0, billed > 0 && corrected > 0 ? goods - Math.round((goods * corrected) / billed) : goods);
      return { truckId: r.id, number: r.number, supplier: r.supplier, arrivedAt: r.arrived_at, closed: r.closed, brands: r.brands ?? '',
        dana: n(r.received) - corrected, sold: n(r.sold), spoiled: n(r.spoiled), goodsPaise: goodsNet, freightPaise: n(r.freight), purchasePaise: goodsNet + n(r.freight) };
    });
    const payments = (await tx.query<{ id: string; party: string; amount: string; mode: string; note: string; day: string; at: Date }>(
      `SELECT id, TRIM(party_name) AS party, amount_paise AS amount, mode, note, business_date::text AS day, created_at AS at FROM daybook_entries
       WHERE category = 'supplier' AND direction = 'out' AND hidden = false AND TRIM(party_name) <> ''
       ORDER BY business_date DESC, created_at DESC`)).rows;
    const names = new Map<string, string>();
    for (const g of gaadis) if (!names.has(nameKey(g.supplier))) names.set(nameKey(g.supplier), g.supplier);
    for (const p of payments) if (!names.has(nameKey(p.party))) names.set(nameKey(p.party), p.party);
    return [...names].filter(([k]) => k).map(([key, name]) => ({
      key, name,
      gaadis: gaadis.filter((g) => nameKey(g.supplier) === key),
      payments: payments.filter((p) => nameKey(p.party) === key).map((p) => ({ id: p.id, amountPaise: n(p.amount), mode: p.mode, note: p.note, date: p.day, at: p.at })),
    }));
  }

  private async payables(tx: Tx, today: string) {
    const rows = (await this.supplierBooks(tx)).map((s) => {
      const purchase = s.gaadis.reduce((t, g) => t + g.purchasePaise, 0);
      const paid = s.payments.reduce((t, p) => t + p.amountPaise, 0);
      const a = age(s.gaadis.map((g) => ({ at: g.arrivedAt, amount: g.purchasePaise })), paid, today);
      const last = [...s.gaadis.map((g) => g.arrivedAt.getTime()), ...s.payments.map((p) => p.at.getTime())].sort().at(-1);
      return { key: s.key, name: s.name, gaadis: s.gaadis.length, openGaadis: s.gaadis.filter((g) => !g.closed).length,
        purchasePaise: purchase, paidPaise: paid, duePaise: purchase - paid, d0_7: a.d0_7, d8_30: a.d8_30, d31: a.d31,
        lastAt: last ? new Date(last).toISOString() : null };
    }).sort((a, b) => b.duePaise - a.duePaise || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
    const owed = rows.filter((r) => r.duePaise > 0);
    const totals = owed.reduce((t, r) => ({ duePaise: t.duePaise + r.duePaise, d0_7: t.d0_7 + r.d0_7, d8_30: t.d8_30 + r.d8_30, d31: t.d31 + r.d31 }), { duePaise: 0, d0_7: 0, d8_30: 0, d31: 0 });
    return { totals: { ...totals, count: owed.length }, rows };
  }

  /** One supplier's khata: each gaadi (what the shop owes him) and each payment, running balance. */
  async supplier(shopId: string, key: string) {
    return this.db.withShop(shopId, async (tx) => {
      const s = (await this.supplierBooks(tx)).find((x) => x.key === key);
      if (!s) throw new NotFoundException('Supplier nahi mila');
      const rows = [
        ...s.gaadis.map((g) => ({ id: g.truckId, at: g.arrivedAt.toISOString(), date: istDay(g.arrivedAt), kind: 'gaadi' as const,
          title: `Gaadi ${g.number}`, detail: [g.brands, g.freightPaise ? `bhada ₹${Math.round(g.freightPaise / 100).toLocaleString('en-IN')}` : ''].filter(Boolean).join(' · '),
          nags: g.dana, debitPaise: 0, creditPaise: g.purchasePaise, open: !g.closed, sold: g.sold, left: Math.max(0, g.dana - g.sold - g.spoiled) })),
        ...s.payments.map((p) => ({ id: p.id, at: p.at.toISOString(), date: p.date, kind: 'payment' as const,
          title: 'Payment', detail: [p.mode === 'upi' || p.mode === 'bank' ? 'Bank' : p.mode === 'office' ? 'Office' : 'Galla', p.note].filter(Boolean).join(' · '),
          nags: 0, debitPaise: p.amountPaise, creditPaise: 0, open: false, sold: 0, left: 0 })),
      ].sort((a, b) => a.at.localeCompare(b.at));
      let bal = 0;
      const history = rows.map((r) => ({ ...r, balancePaise: (bal += r.creditPaise - r.debitPaise) })).reverse();
      return {
        key: s.key, name: s.name,
        totals: { purchasePaise: s.gaadis.reduce((t, g) => t + g.purchasePaise, 0), paidPaise: s.payments.reduce((t, p) => t + p.amountPaise, 0),
          duePaise: bal, gaadis: s.gaadis.length, dana: s.gaadis.reduce((t, g) => t + g.dana, 0) },
        history,
      };
    });
  }

  // ---------------------------------------------------------------- Stock, maal

  /** Every open gaadi: aaya, gaya, phoota, baaki, its age, and what the baaki is worth at cost. */
  /** [view] 'active': the open gaadis (Tally's stock summary); 'past': closed ones, newest first. */
  async stock(shopId: string, today: string, view: 'active' | 'past' = 'active') {
    return this.db.withShop(shopId, async (tx) => {
      const rows = (await tx.query<{ id: string; number: string; supplier: string; arrived_at: Date; closed_at: Date | null; brands: string | null; recv: string; sold: string; spoiled: string; cost: string; shelf: number | null }>(
        `SELECT t.id, t.number, t.supplier, t.arrived_at, t.closed_at,
                (SELECT string_agg(DISTINCT br.name, ', ') FROM truck_grades g JOIN brands br ON br.id = g.brand_id WHERE g.truck_id = t.id) AS brands,
                (SELECT COALESCE(SUM(billed_qty + free_qty), 0) FROM truck_grades g WHERE g.truck_id = t.id)
                  - (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind = 'correction') AS recv,
                (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE l.truck_id = t.id) AS sold,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind = 'spoiled') AS spoiled,
                (SELECT COALESCE(SUM(billed_qty::bigint * rate_paise), 0) FROM truck_grades g WHERE g.truck_id = t.id)
                  + t.freight_paise + t.labour_paise + t.commission_paise AS cost,
                (SELECT MIN(br.shelf_days) FROM truck_grades g JOIN brands br ON br.id = g.brand_id WHERE g.truck_id = t.id) AS shelf
         FROM trucks t WHERE ${view === 'past' ? 't.closed_at IS NOT NULL' : 't.closed_at IS NULL'}
         ORDER BY ${view === 'past' ? 't.closed_at DESC LIMIT 300' : 't.arrived_at'}`)).rows.map((r) => {
        const recv = n(r.recv), left = Math.max(0, recv - n(r.sold) - n(r.spoiled));
        const ageDays = daysBetween(istDay(r.arrived_at), today);
        return { truckId: r.id, number: r.number, supplier: r.supplier, brands: r.brands ?? '', arrivedOn: istDay(r.arrived_at), ageDays,
          closedOn: r.closed_at ? istDay(r.closed_at) : null,
          stale: r.shelf !== null && ageDays >= r.shelf, received: recv, sold: n(r.sold), spoiled: n(r.spoiled), left,
          valuePaise: recv > 0 ? Math.round((n(r.cost) * left) / recv) : 0 };
      });
      return {
        totals: { left: rows.reduce((t, r) => t + r.left, 0), valuePaise: rows.reduce((t, r) => t + r.valuePaise, 0), gaadis: rows.length, stale: rows.filter((r) => r.stale && r.left > 0).length },
        rows,
      };
    });
  }

  /** Maal-wise bikri over business dates [from, to]: nag, amount and average bhav per maal. */
  async items(shopId: string, from: string, to: string) {
    return this.db.withShop(shopId, (tx) => this.itemRows(tx, from, to));
  }

  private async itemRows(tx: Tx, from: string, to: string) {
    return (await tx.query<{ brand: string | null; nags: string; amount: string; slips: string }>(
      `SELECT br.name AS brand, SUM(l.qty) AS nags, SUM(l.qty::bigint * l.rate_paise) AS amount, COUNT(DISTINCT l.bill_id) AS slips
       FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id LEFT JOIN brands br ON br.id = l.brand_id
       WHERE lb.business_date BETWEEN $1 AND $2 GROUP BY br.name ORDER BY SUM(l.qty::bigint * l.rate_paise) DESC`, [from, to])).rows
      .map((r) => ({ brand: r.brand ?? 'Maal', nags: n(r.nags), amountPaise: n(r.amount), slips: n(r.slips), ratePaise: n(r.nags) ? Math.round(n(r.amount) / n(r.nags)) : 0 }));
  }

  // ---------------------------------------------------------------- Dashboard

  /** Everything the dashboard shows, in one round trip. */
  async dashboard(shopId: string, from: string, to: string, today: string) {
    if (from > to) throw new BadRequestException('from must be on or before to');
    const len = daysBetween(from, to) + 1;
    // The trend always shows at least a week, ending on the period's last day.
    const trendFrom = len >= 7 ? from : new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
    const prevFrom = new Date(Date.parse(`${from}T00:00:00Z`) - len * 86_400_000).toISOString().slice(0, 10);
    return this.db.withShop(shopId, async (tx) => {
      const totals = async (a: string, b: string) => {
        const s = (await tx.query<{ sales: string; slips: string }>(
          `SELECT COALESCE(SUM(total_paise), 0) AS sales, COUNT(*) AS slips FROM ${LIVE_BILLS} lb WHERE business_date BETWEEN $1 AND $2`, [a, b])).rows[0];
        const p = await this.purchases(tx, a, b);
        return { salesPaise: n(s.sales), slips: n(s.slips), purchasePaise: p.reduce((t, x) => t + x.paise, 0), gaadis: p.reduce((t, x) => t + x.gaadis, 0) };
      };
      const now = await totals(from, to);
      const before = await totals(prevFrom, prevDay(from));
      const sales = (await tx.query<{ d: string; s: string }>(
        `SELECT d::date::text AS d, COALESCE(SUM(lb.total_paise), 0) AS s FROM generate_series($1::date, $2::date, interval '1 day') d
         LEFT JOIN ${LIVE_BILLS} lb ON lb.business_date = d::date GROUP BY d ORDER BY d`, [trendFrom, to])).rows;
      const buys = new Map((await this.purchases(tx, trendFrom, to)).map((p) => [p.day, p.paise]));
      const receivables = await this.receivables(tx, today);
      const payables = await this.payables(tx, today);
      const pots = await Promise.all((['galla', 'office', 'bank'] as Pot[]).map(async (p) => [p, (await this.book(tx, p, today, today)).closingPaise] as const));
      const items = (await this.itemRows(tx, from, to)).slice(0, 5);
      return {
        from, to, now, before,
        trend: sales.map((r) => ({ date: r.d, salesPaise: n(r.s), purchasePaise: buys.get(r.d) ?? 0 })),
        receivables: receivables.totals, payables: payables.totals,
        cash: Object.fromEntries(pots) as Record<Pot, number>,
        items,
      };
    });
  }

  /** Kharid by the day the gaadi came: goods at kharid bhav (less corrections) + bhada, as the supplier's account counts it. */
  private async purchases(tx: Tx, from: string, to: string) {
    return (await tx.query<{ day: string; paise: string; gaadis: string }>(
      `SELECT ${IST_DAY('t.arrived_at')}::text AS day, COUNT(*) AS gaadis,
              SUM(GREATEST(0, COALESCE(g.goods, 0) - CASE WHEN COALESCE(g.billed, 0) > 0 AND COALESCE(sp.corrected, 0) > 0
                    THEN ROUND(g.goods::numeric * sp.corrected / g.billed) ELSE 0 END) + t.freight_paise) AS paise
       FROM trucks t
       LEFT JOIN (SELECT truck_id, SUM(billed_qty) billed, SUM(billed_qty::bigint * rate_paise) goods FROM truck_grades GROUP BY truck_id) g ON g.truck_id = t.id
       LEFT JOIN (SELECT truck_id, SUM(qty) corrected FROM spoilage WHERE kind = 'correction' GROUP BY truck_id) sp ON sp.truck_id = t.id
       WHERE ${IST_DAY('t.arrived_at')} BETWEEN $1 AND $2 GROUP BY 1`, [from, to])).rows
      .map((r) => ({ day: r.day, paise: n(r.paise), gaadis: n(r.gaadis) }));
  }
}
