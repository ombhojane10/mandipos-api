import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { Db, Tx } from '../db/db.service';
import { IST_DAY, LIVE_BILLS, n } from '../admin/sql';
import { uuidv7 } from '../common/uuid';

/**
 * Nariyal only: the beejak for a gaadi taken on Commission (trucks.deal = 'commission').
 * Nariyal's own copy of the grapes beejak idea, written for dana, maal and grade — it shares no
 * code with grapes (src/admin/insights.service.ts) and keeps its rows in `nariyal_beejaks` (081).
 */

export const NOT_NARIYAL = 'Yeh sirf Nariyal dukaan ke liye hai';
export const NOT_COMMISSION = 'Yeh gaadi Commission ki nahi hai';

/** The kharcha heads: a % of the gross, ₹ a dana, or a flat ₹. */
export const NARIYAL_BEEJAK_HEADS = [
  { key: 'commission', kind: 'pct' },
  { key: 'mazdoori', kind: 'dana' },
  { key: 'bhada', kind: 'flat' },
  { key: 'dak', kind: 'flat' },
  { key: 'other', kind: 'flat' },
  { key: 'package', kind: 'flat' },
] as const;

/** A supplier name as one key: lower case, letters and digits only (the app's GrahakSearch.norm). */
const NAME_KEY = (col: string) => `regexp_replace(lower(${col}), '[^[:alnum:]]', '', 'g')`;

export const NariyalBeejakBody = z.object({
  by: z.string().trim().max(60).default(''),
  bhav: z.array(z.object({ line: z.string().max(80), ratePaise: z.number().int().min(0).max(10_000_000) })).max(100),
  heads: z.array(z.object({
    key: z.string().max(20),
    rate: z.number().int().min(0).max(10_000_000).optional(),
    amountPaise: z.number().int().min(0).max(1_000_000_000).optional(),
  })).max(20),
});
export type NariyalBeejakInput = z.infer<typeof NariyalBeejakBody>;

const GRADE_LABEL: Record<string, string> = { '1': 'I', '2': 'II', '3': 'III', mix: 'Mix' };

type Row = { id: string; truck_id: string; beejak_no: number; party: string; gaadi: string; day: Date | string; lines: unknown; expenses: unknown;
  dana: number; gross_paise: string; expenses_paise: string; net_paise: string; made_by: string; updated_at: Date };
const view = (r: Row) => ({
  id: r.id, truckId: r.truck_id, no: r.beejak_no, party: r.party, gaadi: r.gaadi,
  day: typeof r.day === 'string' ? r.day : r.day.toISOString().slice(0, 10),
  lines: r.lines as { line: string; qty: number; ratePaise: number; amountPaise: number }[],
  expenses: r.expenses as { key: string; kind: string; rate: number | null; amountPaise: number }[],
  dana: r.dana, grossPaise: n(r.gross_paise), expensesPaise: n(r.expenses_paise), netPaise: n(r.net_paise), madeAt: r.updated_at.toISOString(),
});
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

@Injectable()
export class NariyalBeejakService {
  constructor(private readonly db: Db) {}

  /** A nariyal shop's Commission gaadi, or a 422 / 404 that says why not. */
  private async gaadi(tx: Tx, shopId: string, truckId: string) {
    const shop = (await tx.query<{ commodity: string }>(`SELECT commodity FROM shops WHERE id = $1`, [shopId])).rows[0];
    if (shop?.commodity !== 'nariyal') throw new UnprocessableEntityException(NOT_NARIYAL);
    const t = (await tx.query<{ id: string; number: string; supplier: string; arrived: string; freight: string; deal: string | null }>(
      `SELECT id, number, TRIM(supplier) AS supplier, ${IST_DAY('arrived_at')}::text AS arrived, freight_paise AS freight, deal
       FROM trucks WHERE id = $1`, [truckId])).rows[0];
    if (!t) throw new NotFoundException('Gaadi nahi mili');
    if (t.deal !== 'commission') throw new UnprocessableEntityException(NOT_COMMISSION);
    return t;
  }

  /** The gaadi as the beejak sees it: dana sold per maal and grade (live slips only), in, phoota, left, and the kept beejak. */
  async beejak(shopId: string, truckId: string) {
    return this.db.withShop(shopId, async (tx) => {
      const t = await this.gaadi(tx, shopId, truckId);
      // A line per maal and dana quality the gaadi brought (its lots), plus any it sold beyond them:
      // aaye (less count fixes), bike (live slips; leak nuts count under their grade), phoota,
      // baaki, and the average bhav they really sold at.
      const lines = (await tx.query<{ brand: string | null; grade: string; recv: string; sold: string; amount: string; corr: string | null; spoiled: string | null }>(
        `WITH g AS (
           SELECT brand_id, grade, SUM(received_qty)::bigint AS recv, 0::bigint AS sold, 0::bigint AS amount, 0::bigint AS corr, 0::bigint AS spoiled
             FROM truck_grades WHERE truck_id = $1 GROUP BY 1, 2
           UNION ALL
           SELECT l.brand_id, l.grade, 0, SUM(l.qty), SUM(l.qty::bigint * l.rate_paise), 0, 0
             FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE l.truck_id = $1 GROUP BY 1, 2
           UNION ALL
           SELECT brand_id, grade, 0, 0, 0, COALESCE(SUM(qty) FILTER (WHERE kind = 'correction'), 0), COALESCE(SUM(qty) FILTER (WHERE kind <> 'correction'), 0)
             FROM spoilage WHERE truck_id = $1 GROUP BY 1, 2)
         SELECT br.name AS brand, g.grade, SUM(g.recv) AS recv, SUM(g.sold) AS sold, SUM(g.amount) AS amount, SUM(g.corr) AS corr, SUM(g.spoiled) AS spoiled
         FROM g LEFT JOIN brands br ON br.id = g.brand_id
         GROUP BY br.name, g.grade
         ORDER BY br.name, CASE g.grade WHEN '1' THEN 1 WHEN '2' THEN 2 WHEN '3' THEN 3 ELSE 4 END`, [truckId])).rows
        .map((r) => {
          const received = Math.max(0, n(r.recv) - n(r.corr)), qty = n(r.sold), phoota = n(r.spoiled);
          return { line: `${r.brand ?? '?'} ${GRADE_LABEL[r.grade] ?? r.grade}`, grade: r.grade, received, qty, phoota,
            left: Math.max(0, received - qty - phoota), salesPaise: n(r.amount), avgPaise: qty > 0 ? Math.round(n(r.amount) / qty) : 0 };
        })
        .filter((l) => l.received > 0 || l.qty > 0);
      const came = (await tx.query<{ received: string; corrected: string; spoiled: string }>(
        `SELECT (SELECT COALESCE(SUM(received_qty), 0) FROM truck_grades WHERE truck_id = $1) AS received,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage WHERE truck_id = $1 AND kind = 'correction') AS corrected,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage WHERE truck_id = $1 AND kind <> 'correction') AS spoiled`, [truckId])).rows[0];
      const received = Math.max(0, n(came.received) - n(came.corrected));
      const sold = lines.reduce((s, l) => s + l.qty, 0);
      const saved = (await tx.query<Row>(`SELECT * FROM nariyal_beejaks WHERE truck_id = $1`, [truckId])).rows[0];
      // What the shop owed him before this gaadi: the nets of his earlier Commission gaadis'
      // saved beejaks, less what was paid him for those gaadis. Can go below 0 (paid ahead).
      const before = (await tx.query<{ made: string; paid: string }>(
        `WITH earlier AS (
           SELECT t.id FROM trucks t
           WHERE t.deal = 'commission' AND t.id <> $1
             AND ${NAME_KEY('t.supplier')} = ${NAME_KEY('$2::text')} AND ${NAME_KEY('$2::text')} <> ''
             AND t.arrived_at < (SELECT arrived_at FROM trucks WHERE id = $1))
         SELECT (SELECT COALESCE(SUM(net_paise), 0) FROM nariyal_beejaks WHERE truck_id IN (SELECT id FROM earlier)) AS made,
                (SELECT COALESCE(SUM(amount_paise), 0) FROM daybook_entries
                  WHERE category = 'supplier' AND direction = 'out' AND NOT hidden
                    AND purchase_bill IN (SELECT id::text FROM earlier)) AS paid`, [truckId, t.supplier])).rows[0];
      return {
        openingPaise: n(before.made) - n(before.paid),
        truckId: t.id, number: t.number, party: t.supplier, arrivedOn: t.arrived, freightPaise: n(t.freight),
        received, sold, phoota: n(came.spoiled), left: Math.max(0, received - sold - n(came.spoiled)),
        lines, saved: saved ? view(saved) : null,
      };
    });
  }

  /**
   * The saved beejaks of the gaadis asked for (the Bikri list on screen): number and net, so the
   * app can tell which are fully paid (it adds the payments up itself). Gaadis with none are left out.
   */
  async nets(shopId: string, truckIds: string[]) {
    return this.db.withShop(shopId, async (tx) => {
      const shop = (await tx.query<{ commodity: string }>(`SELECT commodity FROM shops WHERE id = $1`, [shopId])).rows[0];
      if (shop?.commodity !== 'nariyal') throw new UnprocessableEntityException(NOT_NARIYAL);
      if (!truckIds.length) return { items: [] };
      const items = (await tx.query<{ truck_id: string; beejak_no: number; net_paise: string }>(
        `SELECT truck_id, beejak_no, net_paise FROM nariyal_beejaks WHERE truck_id = ANY($1::uuid[]) ORDER BY beejak_no`, [truckIds])).rows
        .map((r) => ({ truckId: r.truck_id, no: r.beejak_no, netPaise: n(r.net_paise) }));
      return { items };
    });
  }

  /** Makes (or makes again) the gaadi's beejak; every amount is worked out here from the typed rates. */
  async save(shopId: string, truckId: string, input: NariyalBeejakInput) {
    const b = await this.beejak(shopId, truckId);
    // Only what sold goes on the beejak; a quality with nothing sold has no line.
    const sold = b.lines.filter((l) => l.qty > 0);
    if (!sold.length) throw new BadRequestException('Is gaadi ka abhi koi dana nahi bika');
    const bhav = new Map(input.bhav.map((x) => [x.line, x.ratePaise]));
    const lines = sold.map((l) => {
      const ratePaise = bhav.get(l.line) ?? 0;
      return { line: l.line, qty: l.qty, ratePaise, amountPaise: l.qty * ratePaise };
    });
    if (lines.some((l) => l.ratePaise <= 0)) throw new BadRequestException('Har maal ka bhav likhein');
    const dana = lines.reduce((s, l) => s + l.qty, 0);
    const gross = lines.reduce((s, l) => s + l.amountPaise, 0);
    const given = new Map(input.heads.map((h) => [h.key, h]));
    // A % head is in basis points (600 = 6%): more than 100% is a typo, never a real commission.
    for (const head of NARIYAL_BEEJAK_HEADS) {
      if (head.kind === 'pct' && (given.get(head.key)?.rate ?? 0) > 10_000) throw new BadRequestException('Commission 100% se zyada nahi ho sakta');
    }
    const expenses = NARIYAL_BEEJAK_HEADS.map((head) => {
      const h = given.get(head.key);
      const rate = head.kind === 'flat' ? null : Math.max(0, h?.rate ?? 0);
      const amountPaise = head.kind === 'pct' ? Math.round((gross * rate!) / 10_000)
        : head.kind === 'dana' ? rate! * dana
          : Math.max(0, h?.amountPaise ?? 0);
      return { key: head.key, kind: head.kind, rate, amountPaise };
    });
    const spent = expenses.reduce((s, e) => s + e.amountPaise, 0);
    return this.db.withShop(shopId, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('nariyal-beejak:' || $1::text, 0))`, [shopId]);
      const row = (await tx.query<Row>(
        `INSERT INTO nariyal_beejaks (id, shop_id, truck_id, beejak_no, party, gaadi, day, lines, expenses, dana, gross_paise, expenses_paise, net_paise, made_by)
         VALUES ($1, $2, $3, (SELECT COALESCE(MAX(beejak_no), 0) + 1 FROM nariyal_beejaks WHERE shop_id = $2), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (shop_id, truck_id) DO UPDATE SET party = EXCLUDED.party, gaadi = EXCLUDED.gaadi, day = EXCLUDED.day, lines = EXCLUDED.lines,
           expenses = EXCLUDED.expenses, dana = EXCLUDED.dana, gross_paise = EXCLUDED.gross_paise, expenses_paise = EXCLUDED.expenses_paise,
           net_paise = EXCLUDED.net_paise, made_by = EXCLUDED.made_by, updated_at = now()
         RETURNING *`,
        [uuidv7(), shopId, truckId, b.party, b.number, istToday(), JSON.stringify(lines), JSON.stringify(expenses), dana, gross, spent, gross - spent, input.by || 'App'])).rows[0];
      return view(row);
    });
  }
}
