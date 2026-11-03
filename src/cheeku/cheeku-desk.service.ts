import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Db } from '../db/db.service';
import { IST_DAY, LIVE_BILLS, STORE_BACK, n } from '../admin/sql';
import { nameKey } from '../admin/reports.service';
import { uuidv7 } from '../common/uuid';
import { requireCheeku } from './cheeku';
import { CheekuCommissionsService } from './cheeku-commissions.service';

/**
 * The beejak's kharcha heads, in the order of the shop's old software: a % of the gross (rate in
 * basis points), ₹ a box (rate in paise, times the boxes on the beejak), or a flat amount.
 */
export const CHEEKU_BEEJAK_HEADS = [
  { key: 'commission', kind: 'pct' }, { key: 'association', kind: 'box' }, { key: 'loading', kind: 'box' },
  { key: 'labour', kind: 'box' }, { key: 'bardana', kind: 'box' }, { key: 'freight', kind: 'flat' },
  { key: 'dak', kind: 'flat' }, { key: 'bank', kind: 'pct' }, { key: 'crate', kind: 'box' },
  { key: 'store', kind: 'flat' }, { key: 'custom', kind: 'flat' }, { key: 'other', kind: 'flat' },
] as const;
export type CheekuBeejakInput = { day?: string; bhav: { quality: string; ratePaise: number }[]; heads: { key: string; rate?: number; amountPaise?: number }[] };
type CheekuBeejakRow = { id: string; truck_id: string; beejak_no: number; party: string; gaadi: string; day: Date | string; lines: unknown; expenses: unknown;
  boxes: number; gross_paise: string; expenses_paise: string; net_paise: string; made_by: string; created_at: Date; updated_at: Date };
const cheekuBeejakView = (r: CheekuBeejakRow) => ({
  id: r.id, truckId: r.truck_id, no: r.beejak_no, party: r.party, gaadi: r.gaadi, day: typeof r.day === 'string' ? r.day : r.day.toISOString().slice(0, 10),
  lines: r.lines as { quality: string; qty: number; ratePaise: number; amountPaise: number }[],
  expenses: r.expenses as { key: string; kind: string; rate: number | null; amountPaise: number }[],
  boxes: r.boxes, grossPaise: n(r.gross_paise), expensesPaise: n(r.expenses_paise), netPaise: n(r.net_paise), madeAt: r.updated_at.toISOString(),
});
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/**
 * Cheeku's desk and beejaks: its own copy of the grapes desk (InsightsService.angoor) and the
 * grapes beejak (InsightsService.beejak…), so a change to either side never moves the other.
 * Beejaks are kept in the shared beejaks table, one a gaadi, as the grapes ones are.
 */
@Injectable()
export class CheekuDeskService {
  constructor(private readonly db: Db, private readonly commissions: CheekuCommissionsService) {}

  /**
   * The cheeku desk (its own copy of the grapes desk), over business dates [from, to]:
   *  - dispatch: each slip's boxes against what the labour has handed over at the gaadi (pickups);
   *  - gaadis: every open gaadi, where it stands and what each quality has left;
   *  - suppliers: each party's boxes and bikri, and the shop's commission on it at the party's
   *    own % (cheeku_commissions), else the shop's default;
   *  - days: APMC, and mazdoori charged on slips against mazdoori paid out of the daybook.
   */
  async desk(shopId: string, from: string, to: string) {
    await requireCheeku(this.db, shopId);
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
      const lots = (await tx.query<{ truck_id: string; number: string; supplier: string; location: string; arrived: string; freight: string; brand_id: string | null; quality: string | null; box_grams: number; rate: string; received: string; corrected: string; sold: string; sold_now: string; off: string; back: string }>(
        `SELECT t.id AS truck_id, t.number, TRIM(t.supplier) AS supplier, t.location, ${IST_DAY('t.arrived_at')}::text AS arrived, t.freight_paise AS freight,
                g.brand_id, br.name AS quality, g.box_grams, g.rate, g.received,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.brand_id IS NOT DISTINCT FROM g.brand_id AND s.kind = 'correction') AS corrected,
                (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id
                 WHERE l.truck_id = t.id AND l.brand_id IS NOT DISTINCT FROM g.brand_id) AS sold,
                (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id
                 WHERE l.truck_id = t.id AND l.brand_id IS NOT DISTINCT FROM g.brand_id AND lb.business_date = $1) AS sold_now,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.brand_id IS NOT DISTINCT FROM g.brand_id AND s.kind <> 'correction') AS off,
                ${STORE_BACK('t.id', 'g.brand_id')} AS back
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
        // Boxes back from a cold store came in as a lot line; they are not more maal, so out of both.
        const received = Math.max(0, n(r.received) - n(r.corrected) - n(r.back)), sold = n(r.sold), off = Math.max(0, n(r.off) - n(r.back));
        // Cheeku never refuses a sale on the count: more sold than came shows as "over", never as a minus.
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
      const parties = new Map<string, { key: string; name: string; bps: number; ownRate: boolean; gaadis: Consignment[]; boxes: number; salesPaise: number; commissionPaise: number; netPaise: number }>();
      const rates = await this.commissions.ratesTx(tx);
      const commissionBps = rates.defaultBps;
      for (const r of sales) {
        const key = nameKey(r.supplier) || `gaadi:${r.truck_id}`;
        const own = rates.byKey.get(nameKey(r.supplier));
        const p = parties.get(key) ?? { key, name: r.supplier || r.number, bps: own ?? commissionBps, ownRate: own !== undefined, gaadis: [], boxes: 0, salesPaise: 0, commissionPaise: 0, netPaise: 0 };
        const sale = n(r.sales), commission = Math.round((sale * p.bps) / 10_000);
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
    await requireCheeku(this.db, shopId);
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
      const came = (await tx.query<{ received: string; corrected: string; off: string; back: string }>(
        `SELECT (SELECT COALESCE(SUM(received_qty), 0) FROM truck_grades WHERE truck_id = $1) AS received,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage WHERE truck_id = $1 AND kind = 'correction') AS corrected,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage WHERE truck_id = $1 AND kind <> 'correction') AS off,
                (SELECT COALESCE(SUM(qty), 0) FROM store_sync WHERE truck_id = $1 AND kind = 'lot') AS back`, [truckId])).rows[0];
      came.off = String(n(came.off) - n(came.back));
      const received = Math.max(0, n(came.received) - n(came.corrected) - n(came.back));
      const sold = groups.reduce((s, g) => s + g.qty, 0);
      const saved = (await tx.query<CheekuBeejakRow>(`SELECT * FROM beejaks WHERE truck_id = $1`, [truckId])).rows[0];
      const rate = await this.commissions.rateTx(tx, t.supplier);
      return {
        commissionBps: rate.bps, ownRate: rate.own,
        truckId: t.id, number: t.number, party: t.supplier, supplierKey: nameKey(t.supplier), location: t.location, arrivedOn: t.arrived, closed: t.closed,
        received, sold, off: n(came.off), left: Math.max(0, received - sold - n(came.off)), freightPaise: n(t.freight),
        groups, grossPaise: groups.reduce((s, g) => s + g.amountPaise, 0),
        from: groups.map((g) => g.first).sort()[0] ?? null, to: groups.map((g) => g.last).sort().at(-1) ?? null,
        saved: saved ? cheekuBeejakView(saved) : null,
      };
    });
  }

  /**
   * Makes (or makes again) a gaadi's beejak and keeps it. The boxes per quality are what has sold
   * off the gaadi now; the bhav is the shop's; each kharcha head is worked out here from its rate
   * — a % of the gross, ₹ a box, or a flat amount — so a kept beejak always adds up.
   */
  async saveBeejak(by: string, shopId: string, truckId: string, input: CheekuBeejakInput) {
    await requireCheeku(this.db, shopId);
    const b = await this.beejak(shopId, truckId);
    if (!b.groups.length) throw new BadRequestException('Is gaadi ka abhi koi box nahi bika');
    const bhav = new Map(input.bhav.map((x) => [x.quality, x.ratePaise]));
    const lines = b.groups.map((g) => {
      const ratePaise = bhav.get(g.quality) ?? 0;
      return { quality: g.quality, qty: g.qty, ratePaise, amountPaise: g.qty * ratePaise };
    });
    if (lines.some((l) => l.ratePaise <= 0)) throw new BadRequestException('Har quality ka bhav likhein');
    const boxes = lines.reduce((s, l) => s + l.qty, 0);
    const gross = lines.reduce((s, l) => s + l.amountPaise, 0);
    const given = new Map(input.heads.map((h) => [h.key, h]));
    const expenses = CHEEKU_BEEJAK_HEADS.map((head) => {
      const h = given.get(head.key);
      const rate = head.kind === 'flat' ? null : Math.max(0, h?.rate ?? 0);
      const amountPaise = head.kind === 'pct' ? Math.round((gross * rate!) / 10_000)
        : head.kind === 'box' ? rate! * boxes
          : Math.max(0, h?.amountPaise ?? 0);
      return { key: head.key, kind: head.kind, rate, amountPaise };
    });
    const spent = expenses.reduce((s, e) => s + e.amountPaise, 0);
    return this.db.withShop(shopId, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('beejak:' || $1::text, 0))`, [shopId]);
      const row = (await tx.query<CheekuBeejakRow>(
        `INSERT INTO beejaks (id, shop_id, truck_id, beejak_no, party, gaadi, day, lines, expenses, boxes, gross_paise, expenses_paise, net_paise, made_by)
         VALUES ($1, $2, $3, (SELECT COALESCE(MAX(beejak_no), 0) + 1 FROM beejaks WHERE shop_id = $2), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (shop_id, truck_id) DO UPDATE SET party = EXCLUDED.party, gaadi = EXCLUDED.gaadi, day = EXCLUDED.day, lines = EXCLUDED.lines,
           expenses = EXCLUDED.expenses, boxes = EXCLUDED.boxes, gross_paise = EXCLUDED.gross_paise, expenses_paise = EXCLUDED.expenses_paise,
           net_paise = EXCLUDED.net_paise, made_by = EXCLUDED.made_by, updated_at = now()
         RETURNING *`,
        [uuidv7(), shopId, truckId, b.party, b.number, input.day ?? istToday(), JSON.stringify(lines), JSON.stringify(expenses), boxes, gross, spent, gross - spent, by])).rows[0];
      // A beejak made at another % than the party is charged remembers it as the party's own.
      const typed = expenses.find((e) => e.key === 'commission')?.rate;
      if (b.party.trim() && typed != null && typed !== b.commissionBps && typed <= 5000) await this.commissions.setTx(tx, shopId, b.party, typed, by);
      return cheekuBeejakView(row);
    });
  }

  /** Every beejak the shop has made, newest first; [q] finds a party or gaadi. */
  async beejaks(shopId: string, q = '') {
    await requireCheeku(this.db, shopId);
    return this.db.withShop(shopId, async (tx) => {
      const like = `%${q.trim()}%`;
      const rows = (await tx.query<CheekuBeejakRow>(
        `SELECT * FROM beejaks WHERE $1 = '%%' OR party ILIKE $1 OR gaadi ILIKE $1 OR beejak_no::text = $2
         ORDER BY day DESC, beejak_no DESC LIMIT 500`, [like, q.trim()])).rows;
      return { beejaks: rows.map(cheekuBeejakView) };
    });
  }

  async beejakById(shopId: string, id: string) {
    await requireCheeku(this.db, shopId);
    return this.db.withShop(shopId, async (tx) => {
      const row = (await tx.query<CheekuBeejakRow>(`SELECT * FROM beejaks WHERE id = $1`, [id])).rows[0];
      if (!row) throw new NotFoundException('Beejak nahi mila');
      return cheekuBeejakView(row);
    });
  }
}
