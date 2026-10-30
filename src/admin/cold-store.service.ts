import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { uuidv7 } from '../common/uuid';
import { Db, Tx } from '../db/db.service';
import type { PushItem } from '../sync/sync.service';
import { EntriesService } from './entries.service';
import { LIVE_BILLS, n } from './sql';

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export type StoreMoveInput = {
  day?: string; dir: 'in' | 'out'; storeId: string; truckId: string; brandId: string; boxes: number;
  /** Weight; absent = boxes × the lot's box weight. */
  kg?: number | null;
  /** Store rent, ₹ a box (Store In). */
  rentPaise?: number; note?: string;
};

type MoveRow = {
  id: string; day: string; dir: 'in' | 'out'; store_id: string; store: string; truck_id: string; number: string | null; supplier: string | null;
  brand_id: string; quality: string | null; boxes: number; kg: string; rent_paise: string; note: string; created_by: string; created_at: Date; voided_at: Date | null;
};

/**
 * Store Entry (the old software's cold store register): boxes of a gaadi's quality put into a
 * cold store from the Store Master, and taken out again to sell.
 *
 * Boxes in a store are not at the shop, so they come off the gaadi's baaki everywhere — the app,
 * the counter and every report — exactly as the app's own Store button does: a synced spoilage
 * row of kind 'store'. Boxes taken out come back onto the gaadi as a lot line of the same quality
 * and box weight, as free boxes (free_qty: bought once already, so no second kharid in the
 * supplier's khata, the gaadi's cost or the Trial Balance), since a spoilage row is a fact that
 * cannot be undone. Edits and deletes write only the
 * difference, so per gaadi and quality the rows written (store_sync) always come to the boxes in
 * stores now. The reports that show "aaye" and "store/off" leave the lines put back out of both
 * (STORE_BACK), so the gaadi still reads as it came. Website only, apart from those rows.
 */
@Injectable()
export class ColdStoreService {
  constructor(private readonly db: Db, private readonly entries: EntriesService) {}

  /**
   * Stock in each store by gaadi and quality (in − out), the open gaadis' qualities a Store In
   * can take from, boxes the app sent to store without a store named, and the totals.
   */
  async stock(shopId: string) {
    return this.db.withShop(shopId, async (tx) => {
      const stores = (await tx.query<{ id: string; name: string; hidden: boolean }>(`SELECT id, name, hidden FROM stores ORDER BY hidden, name`)).rows;
      const stock = (await tx.query<{ store_id: string; store: string; truck_id: string; number: string | null; supplier: string | null; closed: boolean | null;
        brand_id: string; quality: string | null; ins: string; outs: string; kg_in: string; kg_out: string; rent: string; first: string; last: string }>(
        `SELECT m.store_id, s.name AS store, m.truck_id, t.number, TRIM(t.supplier) AS supplier, t.closed_at IS NOT NULL AS closed, m.brand_id, br.name AS quality,
                SUM(m.boxes) FILTER (WHERE m.dir = 'in') AS ins, SUM(m.boxes) FILTER (WHERE m.dir = 'out') AS outs,
                SUM(m.kg) FILTER (WHERE m.dir = 'in') AS kg_in, SUM(m.kg) FILTER (WHERE m.dir = 'out') AS kg_out,
                SUM(m.boxes * m.rent_paise) FILTER (WHERE m.dir = 'in') AS rent, MIN(m.day)::text AS first, MAX(m.day)::text AS last
         FROM store_moves m JOIN stores s ON s.id = m.store_id LEFT JOIN trucks t ON t.id = m.truck_id LEFT JOIN brands br ON br.id = m.brand_id
         WHERE m.voided_at IS NULL GROUP BY m.store_id, s.name, m.truck_id, t.number, t.supplier, t.closed_at, m.brand_id, br.name
         ORDER BY s.name, MIN(m.day), t.number, br.name`)).rows.map((r) => {
        const boxes = n(r.ins) - n(r.outs);
        return { storeId: r.store_id, store: r.store, truckId: r.truck_id, number: r.number ?? '?', supplier: r.supplier ?? '', closed: !!r.closed,
          brandId: r.brand_id, quality: r.quality ?? '?', in: n(r.ins), out: n(r.outs), boxes, kg: round2(Number(r.kg_in ?? 0) - Number(r.kg_out ?? 0)),
          rentPaise: n(r.rent), first: r.first, last: r.last };
      });
      const lots = (await tx.query<{ truck_id: string; number: string; supplier: string; brand_id: string; quality: string | null; grams: number; recv: string; off: string; sold: string }>(
        `SELECT t.id AS truck_id, t.number, TRIM(t.supplier) AS supplier, g.brand_id, br.name AS quality, MAX(g.box_grams) AS grams, SUM(g.received_qty) AS recv,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.brand_id = g.brand_id) AS off,
                (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE l.truck_id = t.id AND l.brand_id = g.brand_id) AS sold
         FROM trucks t JOIN truck_grades g ON g.truck_id = t.id LEFT JOIN brands br ON br.id = g.brand_id
         WHERE t.closed_at IS NULL GROUP BY t.id, g.brand_id, br.name ORDER BY t.arrived_at DESC, MIN(g.created_at)`)).rows
        .map((l) => ({ truckId: l.truck_id, number: l.number, supplier: l.supplier, brandId: l.brand_id, quality: l.quality ?? '?',
          left: n(l.recv) - n(l.off) - n(l.sold), boxGrams: l.grams ?? 0 }));
      // The app's Store button names no store: listed as they are, so no box goes unseen.
      const app = (await tx.query<{ id: string; day: string; truck_id: string; number: string | null; quality: string | null; qty: number; note: string }>(
        `SELECT s.id, s.business_date::text AS day, s.truck_id, t.number, br.name AS quality, s.qty, s.note
         FROM spoilage s LEFT JOIN trucks t ON t.id = s.truck_id LEFT JOIN brands br ON br.id = s.brand_id
         WHERE s.kind = 'store' AND NOT EXISTS (SELECT 1 FROM store_sync x WHERE x.id = s.id) ORDER BY s.business_date DESC, s.created_at DESC`)).rows
        .map((r) => ({ id: r.id, day: r.day, truckId: r.truck_id, number: r.number ?? '?', quality: r.quality ?? '?', boxes: r.qty, note: r.note }));
      const live = stock.filter((s) => s.boxes !== 0);
      return {
        stores: stores.map((s) => ({ ...s, boxes: live.filter((x) => x.storeId === s.id).reduce((t, x) => t + x.boxes, 0),
          kg: round2(live.filter((x) => x.storeId === s.id).reduce((t, x) => t + x.kg, 0)) })),
        stock, lots, app,
        totals: { boxes: live.reduce((t, x) => t + x.boxes, 0), kg: round2(live.reduce((t, x) => t + x.kg, 0)), lots: live.length,
          in: stock.reduce((t, x) => t + x.in, 0), out: stock.reduce((t, x) => t + x.out, 0), rentPaise: stock.reduce((t, x) => t + x.rentPaise, 0),
          appBoxes: app.reduce((t, x) => t + x.boxes, 0) },
      };
    });
  }

  /**
   * The register for [from, to], every entry (removed ones struck out). With a store, its khata:
   * the boxes it held before [from], then each entry with the running stock.
   */
  async moves(shopId: string, from: string, to: string, storeId?: string) {
    return this.db.withShop(shopId, async (tx) => {
      if (!storeId) {
        const rows = await this.moveRows(tx, `m.day BETWEEN $1 AND $2`, [from, to], 'DESC');
        return { from, to, store: null, opening: 0, lines: rows.map((r) => ({ ...view(r), balance: null as number | null })) };
      }
      const store = (await tx.query<{ id: string; name: string; address: string; contact_person: string; phone: string }>(
        `SELECT id, name, address, contact_person, phone FROM stores WHERE id = $1`, [storeId])).rows[0];
      if (!store) throw new NotFoundException('Store nahi mila');
      const opening = n((await tx.query<{ b: string }>(
        `SELECT COALESCE(SUM(CASE WHEN dir = 'in' THEN boxes ELSE -boxes END), 0) AS b FROM store_moves WHERE store_id = $1 AND voided_at IS NULL AND day < $2`,
        [storeId, from])).rows[0].b);
      let bal = opening;
      const lines = (await this.moveRows(tx, `m.store_id = $3 AND m.day BETWEEN $1 AND $2`, [from, to, storeId], 'ASC')).map((r) => {
        if (!r.voided_at) bal += r.dir === 'in' ? r.boxes : -r.boxes;
        return { ...view(r), balance: bal as number | null };
      });
      return { from, to, store: { id: store.id, name: store.name, address: store.address, contactPerson: store.contact_person, phone: store.phone }, opening, lines };
    });
  }

  async one(shopId: string, id: string) {
    return this.db.withShop(shopId, async (tx) => {
      const r = (await this.moveRows(tx, `m.id = $1`, [id], 'ASC'))[0];
      if (!r) throw new NotFoundException('Entry nahi mili');
      return view(r);
    });
  }

  /** A Store In or Store Out, new or written again. */
  async save(phone: string, shopId: string, id: string | null, input: StoreMoveInput) {
    const day = input.day && /^\d{4}-\d{2}-\d{2}$/.test(input.day) ? input.day : istToday();
    if (day > istToday()) throw new BadRequestException('Aage ki tarikh nahi chalegi');
    return this.apply(phone, shopId, async (tx) => {
      const old = id ? await this.locked(tx, id) : null;
      const store = (await tx.query<{ hidden: boolean }>(`SELECT hidden FROM stores WHERE id = $1`, [input.storeId])).rows[0];
      if (!store) throw new BadRequestException('Store chunein');
      // A hidden store takes nothing new in; what it still holds can always come out.
      if (store.hidden && input.dir === 'in' && old?.store_id !== input.storeId) throw new BadRequestException('Yeh store chhupa hua hai');
      const lot = (await tx.query<{ grams: number }>(
        `SELECT MAX(box_grams) AS grams FROM truck_grades WHERE truck_id = $1 AND brand_id = $2 HAVING COUNT(*) > 0`, [input.truckId, input.brandId])).rows[0];
      if (!lot) throw new BadRequestException('Gaadi ka maal chunein');
      const kg = input.kg == null ? round2((input.boxes * (lot.grams ?? 0)) / 1000) : round2(input.kg);
      const vals = [day, input.dir, input.storeId, input.truckId, input.brandId, input.boxes, kg,
        input.dir === 'in' ? Math.max(0, Math.round(input.rentPaise ?? 0)) : 0, (input.note ?? '').trim().slice(0, 200)];
      if (old) {
        await tx.query(`UPDATE store_moves SET day = $2, dir = $3, store_id = $4, truck_id = $5, brand_id = $6, boxes = $7, kg = $8, rent_paise = $9, note = $10, updated_at = now()
                        WHERE id = $1`, [old.id, ...vals]);
      }
      const moveId = old?.id ?? uuidv7();
      if (!old) {
        await tx.query(`INSERT INTO store_moves (id, shop_id, day, dir, store_id, truck_id, brand_id, boxes, kg, rent_paise, note, created_by)
                        VALUES ($1, current_setting('app.shop_id')::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [moveId, ...vals, phone]);
      }
      const touched = [{ store: input.storeId, truck: input.truckId, brand: input.brandId }];
      if (old) touched.push({ store: old.store_id, truck: old.truck_id, brand: old.brand_id });
      return { moveId, day, touched };
    });
  }

  /** Hatayein: the entry stays, struck out, and the gaadi gets its boxes back (or gives them up) as before it. */
  async remove(phone: string, shopId: string, id: string) {
    return this.apply(phone, shopId, async (tx) => {
      const old = await this.locked(tx, id);
      await tx.query(`UPDATE store_moves SET voided_at = now(), updated_at = now() WHERE id = $1`, [id]);
      return { moveId: id, day: old.day, touched: [{ store: old.store_id, truck: old.truck_id, brand: old.brand_id }] };
    });
  }

  /**
   * Runs a change to the register, then: no store may hold fewer than 0 boxes of a lot, and each
   * gaadi quality touched gets the synced rows that bring it in line with its boxes in stores —
   * refused when the gaadi hasn't that many boxes left to give. All or nothing.
   */
  private async apply(phone: string, shopId: string, change: (tx: Tx) => Promise<{ moveId: string; day: string; touched: { store: string; truck: string; brand: string }[] }>) {
    return this.db.withShop(shopId, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':store', 0))`, [shopId]);
      const { moveId, day, touched } = await change(tx);
      for (const k of touched) {
        const left = n((await tx.query<{ b: string }>(
          `SELECT COALESCE(SUM(CASE WHEN dir = 'in' THEN boxes ELSE -boxes END), 0) AS b FROM store_moves
           WHERE voided_at IS NULL AND store_id = $1 AND truck_id = $2 AND brand_id = $3`, [k.store, k.truck, k.brand])).rows[0].b);
        if (left < 0) throw new UnprocessableEntityException(`Store mein is maal ke itne box nahi — ${-left} box kam padenge`);
      }
      const now = new Date().toISOString();
      const items: PushItem[] = [];
      const sync: { id: string; truck: string; brand: string; kind: 'store' | 'lot'; qty: number }[] = [];
      const lots = touched.filter((k, i) => touched.findIndex((x) => x.truck === k.truck && x.brand === k.brand) === i);
      for (const k of lots) {
        const r = (await tx.query<{ target: string; current: string }>(
          `SELECT (SELECT COALESCE(SUM(CASE WHEN dir = 'in' THEN boxes ELSE -boxes END), 0) FROM store_moves WHERE voided_at IS NULL AND truck_id = $1 AND brand_id = $2) AS target,
                  (SELECT COALESCE(SUM(CASE WHEN kind = 'store' THEN qty ELSE -qty END), 0) FROM store_sync WHERE truck_id = $1 AND brand_id = $2) AS current`,
          [k.truck, k.brand])).rows[0];
        const diff = n(r.target) - n(r.current);
        if (!diff) continue;
        const g = (await tx.query<{ grade: string; rate: string; grams: number; recv: string; off: string; sold: string; store: string }>(
          `SELECT (array_agg(g.grade ORDER BY g.created_at DESC))[1] AS grade, (array_agg(g.rate_paise ORDER BY g.created_at DESC))[1] AS rate, MAX(g.box_grams) AS grams,
                  SUM(g.received_qty) AS recv,
                  (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = $1 AND s.brand_id = $2) AS off,
                  (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE l.truck_id = $1 AND l.brand_id = $2) AS sold,
                  (SELECT name FROM stores WHERE id = $3) AS store
           FROM truck_grades g WHERE g.truck_id = $1 AND g.brand_id = $2`, [k.truck, k.brand, k.store])).rows[0];
        const id = uuidv7();
        if (diff > 0) {
          const left = n(g.recv) - n(g.off) - n(g.sold);
          if (diff > left) throw new UnprocessableEntityException(`Gaadi par sirf ${Math.max(0, left)} box baaki`);
          items.push({ table: 'spoilage', txn: uuidv7(), row: {
            id, created_at: now, truck_id: k.truck, brand_id: k.brand, grade: g.grade ?? '1', qty: diff, business_date: day, kind: 'store', note: (g.store ?? '').slice(0, 200),
          } });
          sync.push({ id, truck: k.truck, brand: k.brand, kind: 'store', qty: diff });
        } else {
          // Free boxes: already bought with the gaadi, so no kharid on them (billed × bhav stays as it came).
          items.push({ table: 'truck_grades', txn: uuidv7(), row: {
            id, created_at: now, truck_id: k.truck, brand_id: k.brand, grade: g.grade ?? '1', billed_qty: 0, free_qty: -diff, received_qty: -diff,
            rate_paise: n(g.rate), box_grams: g.grams ?? 0,
          } });
          sync.push({ id, truck: k.truck, brand: k.brand, kind: 'lot', qty: -diff });
        }
      }
      // Pushed as the website's terminal (its own transaction); kept here only once it is in.
      if (items.length) await this.entries.pushAsWeb(phone, shopId, items);
      for (const s of sync) {
        await tx.query(`INSERT INTO store_sync (id, shop_id, move_id, truck_id, brand_id, kind, qty) VALUES ($1, current_setting('app.shop_id')::uuid, $2, $3, $4, $5, $6)`,
          [s.id, moveId, s.truck, s.brand, s.kind, s.qty]);
      }
      return { id: moveId };
    });
  }

  private async locked(tx: Tx, id: string) {
    const r = (await tx.query<{ id: string; day: string; store_id: string; truck_id: string; brand_id: string; voided_at: Date | null }>(
      `SELECT id, day::text AS day, store_id, truck_id, brand_id, voided_at FROM store_moves WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!r) throw new NotFoundException('Entry nahi mili');
    if (r.voided_at) throw new UnprocessableEntityException('Yeh entry hata di gayi hai');
    return r;
  }

  private async moveRows(tx: Tx, where: string, params: unknown[], order: 'ASC' | 'DESC') {
    return (await tx.query<MoveRow>(
      `SELECT m.id, m.day::text AS day, m.dir, m.store_id, s.name AS store, m.truck_id, t.number, TRIM(t.supplier) AS supplier, m.brand_id, br.name AS quality,
              m.boxes, m.kg, m.rent_paise, m.note, m.created_by, m.created_at, m.voided_at
       FROM store_moves m JOIN stores s ON s.id = m.store_id LEFT JOIN trucks t ON t.id = m.truck_id LEFT JOIN brands br ON br.id = m.brand_id
       WHERE ${where} ORDER BY m.day ${order}, m.created_at ${order}`, params)).rows;
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

const view = (r: MoveRow) => ({
  id: r.id, day: r.day, dir: r.dir, storeId: r.store_id, store: r.store, truckId: r.truck_id, number: r.number ?? '?', supplier: r.supplier ?? '',
  brandId: r.brand_id, quality: r.quality ?? '?', boxes: r.boxes, kg: Number(r.kg), rentPaise: n(r.rent_paise), note: r.note, by: r.created_by, voided: !!r.voided_at,
});
