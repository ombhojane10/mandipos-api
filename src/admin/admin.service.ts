import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Db, Tx } from '../db/db.service';

/**
 * What the MandiPlus admin portal reads. Every figure follows the app's own sums (Store.kt), so
 * the portal and the shop's counter never disagree:
 *  - a voided slip or payment counts nowhere (the app deletes them locally);
 *  - a payment's cash/UPI split falls back to its pay_mode for rows from before the split;
 *  - a grahak's baaki is their unpaid slips plus udhaar entries minus everything they paid.
 */

import { BALANCES, CASH_PART, IST_DAY, LIVE_BILLS, LIVE_COLS, MOBILE, OPENING_NOTES, UPI_PART, day, n } from './sql';

type KhataRow = { id: string; at: string; date: string; kind: 'slip' | 'payment' | 'udhaar'; title: string; detail: string; nags: number; debitPaise: number; creditPaise: number; lines?: { brand: string; grade: string; qty: number; ratePaise: number; leak: boolean }[]; charges?: { label: string; paise: number } };

export type ShopRow = {
  id: string; name: string; mandi: string; shopNo: string; gstin: string; commodity: string;
  nickname: string; ownerPhones: string[];
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
      members: string; devices: string; last_seen_at: Date | null; nickname: string; owner_phones: string[] | null;
    }>(
      `SELECT s.id, s.name, s.nickname, s.mandi, s.shop_no, s.gstin, s.commodity, s.created_at, s.approved_at, s.rejected_at, s.reject_reason,
              u.name AS owner_name, u.phone AS owner_phone,
              (SELECT count(*) FROM shop_members m WHERE m.shop_id = s.id) AS members,
              (SELECT count(*) FROM devices d WHERE d.shop_id = s.id AND d.revoked_at IS NULL) AS devices,
              (SELECT max(d.last_seen_at) FROM devices d WHERE d.shop_id = s.id) AS last_seen_at,
              (SELECT array_agg(ou.phone) FROM shop_members om JOIN users ou ON ou.id = om.user_id WHERE om.shop_id = s.id AND om.role = 'owner') AS owner_phones
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
        id: r.id, name: r.name, mandi: r.mandi, shopNo: r.shop_no, gstin: r.gstin, commodity: r.commodity, nickname: r.nickname, ownerPhones: r.owner_phones ?? [],
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
    const devices = await this.db.query<{ code: string | null; label: string; platform: string; app_version: string; last_seen_at: Date | null; created_at: Date; phone: string; name: string }>(
      `SELECT d.code, d.label, d.platform, d.app_version, d.last_seen_at, d.created_at, u.phone, u.name FROM devices d JOIN users u ON u.id = d.user_id
       WHERE d.shop_id = $1 AND d.revoked_at IS NULL ORDER BY d.last_seen_at DESC NULLS LAST, d.code`, [shopId]);
    return {
      ...s,
      team: team.map((t) => ({ name: t.name, phone: t.phone, role: t.role === 'owner' ? 'admin' : 'accountant', joinedAt: t.created_at.toISOString() })),
      devices: devices.map((d) => ({
        code: d.code, label: d.label, web: d.platform === 'web', appVersion: d.app_version, phone: d.phone, name: d.name,
        lastSeenAt: d.last_seen_at?.toISOString() ?? null, addedAt: d.created_at.toISOString(),
      })),
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
             (SELECT COALESCE(SUM(qty),0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind <> 'correction') AS spoiled
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
  async buyers(shopId: string, q: string, area = '') {
    await this.requireApproved(shopId);
    return this.db.withShop(shopId, async (tx) => {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = (await tx.query<{ id: string; name: string; phone: string; code: string; kind: string; hidden: boolean; address: string; destination: string; area: string; bal: string | null; last_at: string | null; bought: string }>(
        `SELECT g.id, g.name, g.phone, g.code, g.kind, g.hidden, g.address, g.destination, g.area, x.bal,
                (SELECT MAX(business_date)::text FROM ${LIVE_BILLS} lb WHERE lb.buyer_id = g.id) AS last_at,
                (SELECT COALESCE(SUM(total_paise),0) FROM ${LIVE_BILLS} lb WHERE lb.buyer_id = g.id) AS bought
         FROM buyers g LEFT JOIN (${BALANCES}) x ON x.buyer_id = g.id
         WHERE ($1 = '' OR g.name ILIKE $2 OR g.phone LIKE $2 OR g.code ILIKE $2)
           AND ($3 = '' OR upper(trim(g.area)) = upper($3))
         ORDER BY g.hidden, GREATEST(COALESCE(x.bal, 0), 0) DESC, g.name LIMIT ${area ? 1000 : 60}`, [q, like, area.trim()])).rows;
      return rows.map((r) => ({
        id: r.id, name: r.name, phone: r.phone, code: r.code, kind: r.kind, hidden: r.hidden, address: r.address, destination: r.destination, area: r.area,
        balancePaise: n(r.bal), lastSlipOn: r.last_at ? day(r.last_at) : null, boughtPaise: n(r.bought),
      }));
    });
  }

  /** One grahak: profile, totals, and every slip, payment and udhaar entry with a running balance. */
  async buyer(shopId: string, buyerId: string) {
    await this.requireApproved(shopId);
    return this.db.withShop(shopId, async (tx) => {
      const g = (await tx.query<{ id: string; name: string; phone: string; code: string; kind: string; address: string; destination: string; area: string; vehicle: string; credit_limit_paise: string; market_paise: string | null; created_at: Date; gstin: string | null; hidden: boolean }>(
        `SELECT id, name, phone, code, kind, address, destination, area, vehicle, credit_limit_paise, market_paise, created_at, hidden,
                (SELECT x.gstin FROM buyer_gstin x WHERE x.buyer_id = b.id) AS gstin FROM buyers b WHERE id = $1`, [buyerId])).rows[0];
      if (!g) throw new NotFoundException('Grahak nahi mila');

      const { rows, bills, cols } = (await this.histories(tx, [buyerId])).get(buyerId)!;
      let bal = 0;
      const history = rows.map((r) => ({ ...r, balancePaise: (bal += r.debitPaise - r.creditPaise) })).reverse();
      return {
        buyer: {
          id: g.id, name: g.name, phone: g.phone, code: g.code, kind: g.kind, address: g.address, destination: g.destination, area: g.area,
          vehicle: g.vehicle, creditLimitPaise: n(g.credit_limit_paise), marketPaise: g.market_paise === null ? null : n(g.market_paise),
          since: g.created_at.toISOString(), gstin: g.gstin ?? '', hidden: g.hidden,
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

  /**
   * Each grahak's khata rows, oldest first (the same rows the single khata shows), with their
   * slips and payments for the totals: one set of queries for any number of grahak, so the
   * Ledger Multiple and Chithi prints don't run four queries per grahak.
   */
  private async histories(tx: Tx, buyerIds: string[]) {
    const bills = (await tx.query<{ id: string; buyer_id: string; created_at: Date; business_date: string; slip_no: number | null; number: string; pay_mode: string; total_paise: string; paid_paise: string; cash_paise: string; upi_paise: string; packing: string; staff_name: string; labour_paise: string; chungi_paise: string; apmc_paise: string }>(
      `SELECT id, buyer_id, created_at, business_date::text AS business_date, slip_no, number, pay_mode, total_paise, paid_paise, cash_paise, upi_paise, packing, staff_name,
              labour_paise, chungi_paise, apmc_paise
       FROM ${LIVE_BILLS} lb WHERE buyer_id = ANY($1::uuid[])`, [buyerIds])).rows;
    const lines = (await tx.query<{ bill_id: string; brand: string | null; grade: string; qty: number; rate_paise: string; leak: boolean }>(
      `SELECT l.bill_id, br.name AS brand, l.grade, l.qty, l.rate_paise, l.leak FROM bill_lines l
       LEFT JOIN brands br ON br.id = l.brand_id
       WHERE l.bill_id = ANY($1::uuid[]) ORDER BY l.created_at`, [bills.map((b) => b.id)])).rows;
    const cols = (await tx.query<{ id: string; buyer_id: string; created_at: Date; business_date: string; amount_paise: string; pay_mode: string; receipt_no: number | null; cash: string; upi: string }>(
      `SELECT id, buyer_id, created_at, business_date::text AS business_date, amount_paise, pay_mode, receipt_no, ${CASH_PART} AS cash, ${UPI_PART} AS upi
       FROM ${LIVE_COLS} lc WHERE buyer_id = ANY($1::uuid[])`, [buyerIds])).rows;
    const entries = (await tx.query<{ id: string; buyer_id: string; created_at: Date; business_date: string; amount_paise: string; note: string }>(
      `SELECT id, buyer_id, created_at, business_date::text AS business_date, amount_paise, note FROM udhaar_entries WHERE buyer_id = ANY($1::uuid[])`, [buyerIds])).rows;

    const mode = (cash: number, upi: number) => (cash && upi ? 'Cash + UPI' : upi ? 'UPI' : 'Cash');
    const byBill = new Map<string, KhataRow['lines']>();
    for (const l of lines) {
      const list = byBill.get(l.bill_id) ?? [];
      list.push({ brand: l.brand ?? '', grade: l.grade, qty: l.qty, ratePaise: n(l.rate_paise), leak: l.leak });
      byBill.set(l.bill_id, list);
    }
    const out = new Map(buyerIds.map((id) => [id, { rows: [] as KhataRow[], bills: [] as typeof bills, cols: [] as typeof cols }]));
    for (const b of bills) {
      const ls = byBill.get(b.id) ?? [];
      const paid = n(b.paid_paise);
      const o = out.get(b.buyer_id)!;
      o.bills.push(b);
      o.rows.push({
        id: b.id, at: b.created_at.toISOString(), date: day(b.business_date), kind: 'slip',
        title: `Parchi ${b.slip_no ?? b.number}`,
        detail: paid > 0 ? (paid >= n(b.total_paise) ? `Nakad · ${mode(n(b.cash_paise), n(b.upi_paise))}` : `Kuch nakad · ${mode(n(b.cash_paise), n(b.upi_paise))}`) : b.pay_mode === 'free' ? 'Free' : 'Udhaar',
        nags: ls.reduce((s, l) => s + l.qty, 0), debitPaise: n(b.total_paise), creditPaise: paid, lines: ls, charges: chargesOf(b, ls),
      });
    }
    for (const c of cols) {
      const o = out.get(c.buyer_id)!;
      o.cols.push(c);
      o.rows.push({
        id: c.id, at: c.created_at.toISOString(), date: day(c.business_date), kind: 'payment',
        title: c.receipt_no ? `Vasooli · Raseed ${c.receipt_no}` : 'Vasooli', detail: mode(n(c.cash), n(c.upi)),
        nags: 0, debitPaise: 0, creditPaise: n(c.amount_paise),
      });
    }
    // The opening (purana udhaar) is one line however many times it was set: the Opening balance
    // page adds each change as a difference entry, since a synced entry can't be edited.
    const openings = new Map<string, { id: string; at: string; date: string; paise: number }>();
    for (const e of entries) {
      const amt = n(e.amount_paise);
      if (OPENING_NOTES.includes(e.note)) {
        const o = openings.get(e.buyer_id);
        const at = e.created_at.toISOString(), date = day(e.business_date);
        if (!o) openings.set(e.buyer_id, { id: e.id, at, date, paise: amt });
        else { o.paise += amt; if (date < o.date) o.date = date; if (at < o.at) { o.at = at; o.id = e.id; } }
        continue;
      }
      out.get(e.buyer_id)!.rows.push({
        id: e.id, at: e.created_at.toISOString(), date: day(e.business_date), kind: 'udhaar',
        title: e.note || (amt < 0 ? 'Jama' : 'Udhaar'), detail: amt < 0 ? 'Jama' : 'Udhaar',
        nags: 0, debitPaise: Math.max(0, amt), creditPaise: Math.max(0, -amt),
      });
    }
    for (const [buyerId, o] of openings) {
      if (!o.paise) continue;
      const rows = out.get(buyerId)!.rows;
      // First on its day, ahead of whatever was entered before it (an opening set later, dated back).
      const earlier = rows.filter((r) => r.date >= o.date).map((r) => r.at).sort()[0];
      const at = earlier && earlier < o.at ? new Date(Date.parse(earlier) - 1).toISOString() : o.at;
      rows.push({ id: o.id, at, date: o.date, kind: 'udhaar', title: 'Purana udhaar', detail: o.paise < 0 ? 'Jama' : 'Udhaar',
        nags: 0, debitPaise: Math.max(0, o.paise), creditPaise: Math.max(0, -o.paise) });
    }
    for (const o of out.values()) o.rows.sort((a, b) => a.at.localeCompare(b.at));
    return out;
  }

  /**
   * Many grahak's khatas over business dates [from, to], for one print (Ledger Multiple, Chithi):
   * the balance brought forward to [from], the rows in the period with the running balance, the
   * closing. [last] keeps only the period's last few rows (a chithi), the rest folded into the
   * opening. Rows are ordered by date, then as entered, as the khata prints them.
   */
  async khatas(shopId: string, buyerIds: string[], from: string, to: string, last?: number) {
    if (from > to) throw new BadRequestException('from must be on or before to');
    await this.requireApproved(shopId);
    return this.db.withShop(shopId, async (tx) => {
      const people = (await tx.query<{ id: string; name: string; phone: string; code: string; kind: string; address: string; destination: string; area: string; city: string }>(
        `SELECT id, name, phone, code, kind, address, destination, area, city FROM buyers WHERE id = ANY($1::uuid[])`, [buyerIds])).rows;
      const hist = await this.histories(tx, people.map((p) => p.id));
      const order = new Map(buyerIds.map((id, i) => [id, i]));
      return people.sort((a, b) => order.get(a.id)! - order.get(b.id)!).map((p) => {
        const all = hist.get(p.id)!.rows.filter((r) => r.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at));
        let inPeriod = all.filter((r) => r.date >= from);
        if (last !== undefined) inPeriod = inPeriod.slice(-last);
        const firstShown = inPeriod[0];
        const before = firstShown ? all.slice(0, all.indexOf(firstShown)) : all;
        let bal = before.reduce((s, r) => s + r.debitPaise - r.creditPaise, 0);
        const openingPaise = bal;
        const rows = inPeriod.map((r) => ({ ...r, balancePaise: (bal += r.debitPaise - r.creditPaise) }));
        return {
          buyer: { id: p.id, name: p.name, phone: p.phone, code: p.code, kind: p.kind, address: p.address, destination: p.destination, area: p.area, city: p.city },
          openingPaise, rows, closingPaise: bal,
        };
      });
    });
  }

  private async requireShop(shopId: string, conflict: string) {
    const exists = await this.db.one(`SELECT 1 FROM shops WHERE id = $1`, [shopId]);
    if (!exists) throw new NotFoundException('Dukaan nahi mili');
    throw new ConflictException(conflict);
  }

  /**
   * Grahak across every shop. The same person is a separate buyer row in each shop they buy
   * from, so they are matched by mobile number; a buyer without a valid mobile stays its own
   * entry (key "shopId~buyerId"). Empty [q] = the biggest debtors of the whole market.
   */
  async customers(q: string) {
    const groups = new Map<string, {
      key: string; name: string; phone: string; balancePaise: number; boughtPaise: number; lastSlipOn: string | null;
      shops: { shopId: string; shopName: string; buyerId: string; balancePaise: number }[]; topBought: number;
    }>();
    for (const s of await this.openShops()) {
      for (const b of await this.buyers(s.id, q)) {
        const key = MOBILE.test(b.phone) ? b.phone : `${s.id}~${b.id}`;
        const g = groups.get(key) ?? { key, name: b.name, phone: MOBILE.test(b.phone) ? b.phone : '', balancePaise: 0, boughtPaise: 0, lastSlipOn: null, shops: [], topBought: -1 };
        // The name the busiest shop knows them by.
        if (b.boughtPaise > g.topBought) { g.name = b.name; g.topBought = b.boughtPaise; }
        g.balancePaise += b.balancePaise;
        g.boughtPaise += b.boughtPaise;
        if (b.lastSlipOn && (!g.lastSlipOn || b.lastSlipOn > g.lastSlipOn)) g.lastSlipOn = b.lastSlipOn;
        g.shops.push({ shopId: s.id, shopName: s.name, buyerId: b.id, balancePaise: b.balancePaise });
        groups.set(key, g);
      }
    }
    return [...groups.values()]
      .sort((a, b) => Math.max(b.balancePaise, 0) - Math.max(a.balancePaise, 0) || b.boughtPaise - a.boughtPaise || a.name.localeCompare(b.name))
      .slice(0, 60)
      .map(({ topBought: _, ...g }) => g);
  }

  /** One person across the market: what they owe each trader, and every slip and payment, newest first. */
  async customer(key: string) {
    const shops = await this.openShops();
    const found: { shop: { id: string; name: string; mandi: string }; buyerId: string }[] = [];
    if (MOBILE.test(key)) {
      for (const s of shops) {
        const ids = await this.db.withShop(s.id, async (tx) =>
          (await tx.query<{ id: string }>(`SELECT id FROM buyers WHERE phone = $1 ORDER BY created_at`, [key])).rows);
        for (const r of ids) found.push({ shop: s, buyerId: r.id });
      }
    } else {
      const [shopId, buyerId] = key.split('~');
      const shop = shops.find((s) => s.id === shopId);
      if (shop && buyerId) found.push({ shop, buyerId });
    }
    if (!found.length) throw new NotFoundException('Grahak nahi mila');

    const traders = [];
    const rows = [];
    let first: Awaited<ReturnType<AdminService['buyer']>>['buyer'] | null = null;
    for (const f of found) {
      const d = await this.buyer(f.shop.id, f.buyerId);
      first ??= d.buyer;
      traders.push({
        shopId: f.shop.id, shopName: f.shop.name, mandi: f.shop.mandi, buyerId: f.buyerId, name: d.buyer.name, code: d.buyer.code,
        balancePaise: d.totals.balancePaise, boughtPaise: d.totals.boughtPaise, slips: d.totals.slips, nags: d.totals.nags,
        lastSlipOn: d.totals.lastSlipOn, marketPaise: d.buyer.marketPaise, creditLimitPaise: d.buyer.creditLimitPaise,
      });
      for (const r of d.history) rows.push({ ...r, shopId: f.shop.id, shopName: f.shop.name });
    }
    // One running balance for the whole market, oldest first.
    rows.sort((a, b) => a.at.localeCompare(b.at));
    let bal = 0;
    const history = rows.map((r) => ({ ...r, balancePaise: (bal += r.debitPaise - r.creditPaise) })).reverse();
    const busiest = [...traders].sort((a, b) => b.boughtPaise - a.boughtPaise)[0];
    return {
      key, name: busiest.name, phone: MOBILE.test(key) ? key : first!.phone,
      profile: { address: first!.address, destination: first!.destination, vehicle: first!.vehicle, kind: first!.kind },
      totals: {
        balancePaise: traders.reduce((s, t) => s + t.balancePaise, 0),
        duePaise: traders.reduce((s, t) => s + Math.max(0, t.balancePaise), 0),
        boughtPaise: traders.reduce((s, t) => s + t.boughtPaise, 0),
        slips: traders.reduce((s, t) => s + t.slips, 0),
        nags: traders.reduce((s, t) => s + t.nags, 0),
        traders: traders.length,
        owedTo: traders.filter((t) => t.balancePaise > 0).length,
      },
      traders: traders.sort((a, b) => b.balancePaise - a.balancePaise),
      history,
    };
  }

  /** What the whole market is owed right now: the sum over every shop, and how many people owe it. */
  async marketDues() {
    const people = new Set<string>();
    let duePaise = 0;
    for (const s of await this.openShops()) {
      const rows = await this.db.withShop(s.id, async (tx) => (await tx.query<{ id: string; phone: string; bal: string }>(
        `SELECT g.id, g.phone, x.bal FROM (${BALANCES}) x JOIN buyers g ON g.id = x.buyer_id WHERE x.bal > 0`)).rows);
      for (const r of rows) {
        duePaise += n(r.bal);
        people.add(MOBILE.test(r.phone) ? r.phone : `${s.id}~${r.id}`);
      }
    }
    return { duePaise, debtors: people.size };
  }

  /**
   * The shop's Day Book for business dates [from, to]: every slip (cancelled ones too, marked),
   * every payment taken and every daybook line, newest first. Tally's most-read report.
   */
  /** One parchi, as Tally opens a voucher: its maal, money, who made it on which machine, and what happened to it since. */
  async bill(shopId: string, billId: string) {
    await this.requireApproved(shopId);
    return this.db.withShop(shopId, async (tx) => {
      const b = (await tx.query<{ id: string; number: string; slip_no: number | null; created_at: Date; day: string; buyer_id: string | null; buyer_name: string; pay_mode: string; total: string; paid: string; cash: string; upi: string; labour: string; chungi: string; apmc: string; packing: string; panni_name: string; packs: number; staff_name: string; upi_bank: string; truck_id: string | null; truck: string | null; device: string | null; device_label: string | null }>(
        `SELECT b.id, b.number, b.truck_id, b.slip_no, b.created_at, b.business_date::text AS day, b.buyer_id, b.buyer_name, b.pay_mode,
                b.total_paise AS total, b.paid_paise AS paid, b.cash_paise AS cash, b.upi_paise AS upi, b.labour_paise AS labour,
                b.chungi_paise AS chungi, b.apmc_paise AS apmc, b.packing, b.panni_name, b.packs, b.staff_name, b.upi_bank,
                t.number AS truck, d.code AS device, d.label AS device_label
         FROM bills b LEFT JOIN trucks t ON t.id = b.truck_id LEFT JOIN devices d ON d.id = b.device_id WHERE b.id = $1`, [billId])).rows[0];
      if (!b) throw new NotFoundException('Parchi nahi mili');
      const lines = (await tx.query<{ brand: string | null; grade: string; qty: number; rate: string; leak: boolean; truck_id: string; brand_id: string }>(
        `SELECT br.name AS brand, l.grade, l.qty, l.rate_paise AS rate, l.leak, l.truck_id, l.brand_id FROM bill_lines l LEFT JOIN brands br ON br.id = l.brand_id
         WHERE l.bill_id = $1 ORDER BY l.created_at`, [billId])).rows;
      const later = (await tx.query<{ id: string; at: Date; amount: string; cash: string; upi: string; receipt_no: number | null; voided: boolean }>(
        `SELECT c.id, c.created_at AS at, c.amount_paise AS amount, c.receipt_no,
                ${CASH_PART.replace(/\b(cash_paise|upi_paise|pay_mode|amount_paise)\b/g, 'c.$1')} AS cash,
                ${UPI_PART.replace(/\b(cash_paise|upi_paise|pay_mode|amount_paise)\b/g, 'c.$1')} AS upi,
                EXISTS (SELECT 1 FROM collection_voids v WHERE v.collection_id = c.id) AS voided
         FROM collections c WHERE c.bill_id = $1 ORDER BY c.created_at`, [billId])).rows;
      const voided = (await tx.query<{ reason: string; at: Date; by: string | null }>(
        `SELECT v.reason, v.created_at AS at, CONCAT_WS(' · ', d.code, NULLIF(d.label, '')) AS by
         FROM bill_voids v LEFT JOIN devices d ON d.id = v.device_id WHERE v.bill_id = $1 LIMIT 1`, [billId])).rows[0];
      const delivery = (await tx.query<{ address: string; destination: string }>(
        `SELECT address, destination FROM delivery_slips WHERE bill_id = $1 ORDER BY created_at DESC LIMIT 1`, [billId])).rows[0];
      const live = later.filter((c) => !c.voided);
      const paidLater = live.reduce((s, c) => s + n(c.amount), 0);
      return {
        id: b.id, number: b.number, slipNo: b.slip_no, at: b.created_at.toISOString(), date: b.day,
        buyerId: b.buyer_id, buyerName: b.buyer_name, payMode: b.pay_mode,
        totalPaise: n(b.total), paidPaise: n(b.paid), cashPaise: n(b.cash), upiPaise: n(b.upi), labourPaise: n(b.labour), chungiPaise: n(b.chungi), apmcPaise: n(b.apmc),
        openPaise: Math.max(0, n(b.total) - n(b.paid) - paidLater),
        packing: b.packing, panniName: b.panni_name, packs: b.packs, staff: b.staff_name, upiBank: b.upi_bank, truckId: b.truck_id, truck: b.truck,
        // Vasooli still standing on the slip: an edit is refused, a delete hands it back or keeps it.
        collected: { cashPaise: live.reduce((s, c) => s + n(c.cash), 0), upiPaise: live.reduce((s, c) => s + n(c.upi), 0) },
        // Angoor: boxes already handed over at the gaadi — the slip is locked.
        pickedQty: n((await tx.query<{ n: string }>(`SELECT COALESCE(SUM(qty), 0) AS n FROM pickups WHERE bill_id = $1`, [billId])).rows[0].n),
        // The dispatch log: each hand-over at the gaadi, when, how many, on which machine.
        pickups: (await tx.query<{ at: Date; qty: number; by: string | null }>(
          `SELECT p.created_at AS at, p.qty, CONCAT_WS(' · ', d.code, NULLIF(d.label, '')) AS by
           FROM pickups p LEFT JOIN devices d ON d.id = p.device_id WHERE p.bill_id = $1 ORDER BY p.created_at`, [billId])).rows
          .map((p) => ({ at: p.at.toISOString(), qty: p.qty, by: p.by ?? '' })),
        machine: [b.device, b.device_label].filter(Boolean).join(' · '),
        // truckId/brandId: a party slip's lines each come off their own gaadi (angoor's Alter needs them).
        lines: lines.map((l) => ({ brand: l.brand ?? 'Maal', grade: l.grade, qty: l.qty, ratePaise: n(l.rate), leak: l.leak, truckId: l.truck_id, brandId: l.brand_id })),
        payments: later.map((c) => ({ id: c.id, at: c.at.toISOString(), amountPaise: n(c.amount), receiptNo: c.receipt_no, voided: c.voided })),
        voided: voided ? { reason: voided.reason, at: voided.at.toISOString(), by: voided.by ?? '' } : null,
        delivery: delivery ? { address: delivery.address, stand: delivery.destination } : null,
      };
    });
  }

  async daybook(shopId: string, from: string, to: string) {
    if (from > to) throw new BadRequestException('from must be on or before to');
    await this.requireApproved(shopId);
    return this.db.withShop(shopId, async (tx) => {
      const slips = (await tx.query<{ id: string; at: Date; day: string; slip_no: number | null; number: string; buyer_id: string | null; buyer_name: string; pay_mode: string; total: string; paid: string; cash: string; upi: string; nags: string; void_reason: string | null; staff: string }>(
        `SELECT b.id, b.created_at AS at, b.business_date::text AS day, b.slip_no, b.number, b.buyer_id, b.buyer_name, b.pay_mode,
                b.total_paise AS total, b.paid_paise AS paid, b.cash_paise AS cash, b.upi_paise AS upi, b.staff_name AS staff,
                (SELECT COALESCE(SUM(qty), 0) FROM bill_lines l WHERE l.bill_id = b.id) AS nags,
                (SELECT v.reason FROM bill_voids v WHERE v.bill_id = b.id LIMIT 1) AS void_reason
         FROM bills b WHERE b.business_date BETWEEN $1 AND $2 ORDER BY b.created_at DESC LIMIT 1000`, [from, to])).rows;
      const pays = (await tx.query<{ id: string; at: Date; day: string; buyer_id: string; name: string | null; amount: string; cash: string; upi: string; receipt_no: number | null; voided: string | null }>(
        `SELECT c.id, c.created_at AS at, c.business_date::text AS day, c.buyer_id, g.name, c.amount_paise AS amount,
                ${CASH_PART} AS cash, ${UPI_PART} AS upi,
                c.receipt_no, (SELECT v.reason FROM collection_voids v WHERE v.collection_id = c.id LIMIT 1) AS voided
         FROM collections c LEFT JOIN buyers g ON g.id = c.buyer_id
         WHERE c.business_date BETWEEN $1 AND $2 ORDER BY c.created_at DESC LIMIT 1000`, [from, to])).rows;
      const book = (await tx.query<{ id: string; at: Date; day: string; direction: string; mode: string; category: string; party: string; note: string; amount: string }>(
        `SELECT id, created_at AS at, business_date::text AS day, direction, mode, category, party_name AS party, note, amount_paise AS amount
         FROM daybook_entries WHERE hidden = false AND category <> 'opening' AND business_date BETWEEN $1 AND $2
         ORDER BY created_at DESC LIMIT 1000`, [from, to])).rows;

      const entries = [
        ...slips.map((b) => ({
          kind: 'slip' as const, id: b.id, at: b.at.toISOString(), date: b.day,
          title: `Parchi ${b.slip_no ?? b.number}`, party: b.buyer_name, buyerId: b.buyer_id, nags: n(b.nags),
          amountPaise: n(b.total), cashPaise: n(b.cash), upiPaise: n(b.upi), udhaarPaise: Math.max(0, n(b.total) - n(b.paid)),
          payMode: b.pay_mode, staff: b.staff, voided: b.void_reason,
        })),
        ...pays.map((c) => ({
          kind: 'payment' as const, id: c.id, at: c.at.toISOString(), date: c.day,
          title: c.receipt_no ? `Raseed ${c.receipt_no}` : 'Vasooli', party: c.name ?? '', buyerId: c.buyer_id, nags: 0,
          amountPaise: n(c.amount), cashPaise: n(c.cash), upiPaise: n(c.upi), udhaarPaise: 0,
          payMode: '', staff: '', voided: c.voided,
        })),
        ...book.map((e) => ({
          kind: (e.direction === 'in' ? 'in' : 'out') as 'in' | 'out', id: e.id, at: e.at.toISOString(), date: e.day,
          title: e.category, party: e.party, buyerId: null, nags: 0, note: e.note, mode: e.mode,
          amountPaise: n(e.amount), cashPaise: 0, upiPaise: 0, udhaarPaise: 0, payMode: '', staff: '', voided: null,
        })),
      ].sort((a, b) => b.at.localeCompare(a.at));
      return { from, to, entries };
    });
  }

  private openShops() {
    return this.db.query<{ id: string; name: string; mandi: string }>(
      `SELECT id, name, mandi FROM shops WHERE approved_at IS NOT NULL ORDER BY created_at`);
  }

  private async requireApproved(shopId: string) {
    const s = await this.db.one<{ approved_at: Date | null }>(`SELECT approved_at FROM shops WHERE id = $1`, [shopId]);
    if (!s) throw new NotFoundException('Dukaan nahi mili');
    if (!s.approved_at) throw new ConflictException('Yeh dukaan abhi approve nahi hui');
  }
}

/**
 * What a slip's total carries over its maal (qty × bhav), named so the khata can show it as a line:
 * coconut's mazdoori, amrud's chungi, angoor's APMC + labour. Null when the total is just the maal.
 */
function chargesOf(b: { total_paise: string; labour_paise: string; chungi_paise: string; apmc_paise: string }, ls: { qty: number; ratePaise: number }[]) {
  const paise = n(b.total_paise) - ls.reduce((s, l) => s + l.qty * l.ratePaise, 0);
  if (!paise) return undefined;
  const apmc = n(b.apmc_paise), labour = n(b.labour_paise), chungi = n(b.chungi_paise) - apmc - labour;
  const parts = [apmc > 0 && 'APMC', chungi > 0 && 'Chungi', labour > 0 && 'Mazdoori'].filter(Boolean);
  return { label: paise < 0 ? 'Chhoot' : parts.join(' + ') || 'Kharcha', paise };
}
