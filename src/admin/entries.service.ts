import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AccountsService } from '../auth/accounts.service';
import { Principal } from '../auth/tokens.service';
import { uuidv7 } from '../common/uuid';
import { Db, Tx } from '../db/db.service';
import { PrintService } from '../print/print.service';
import { SyncHub } from '../sync/sync.hub';
import { PushItem, PushResult, SyncService } from '../sync/sync.service';
import { CASH_PART, LIVE_BILLS, LIVE_COLS, UPI_PART, n } from './sql';
import { nameKey } from './reports.service';

/**
 * Entries made on the website. Each one is built exactly as the app's Store writes it (Store.kt:
 * saveParchi, collectDues, addDayEntry, addUdhaar, addBuyer, addTruck, paySupplier) and pushed
 * through the same sync as a terminal, under the website's own device in the shop — so the
 * shop's machines pull it within seconds, numbers are settled the same way (a clashing slip or
 * raseed number is renumbered), and a slip's rows land together or not at all.
 *
 * What only a terminal knows (its labour and chungi rates, its staff name) takes the app's
 * defaults: labour 30 paise a nag when packed, nothing on loose; staff "Website".
 */

/** The app's word for a parchune, on panni_name. */
const PARCHUNE = 'Parchune';
const LABOUR_PAISE_PER_NAG = 30;
const istNow = () => new Date(Date.now() + 330 * 60_000);
const todayIst = () => istNow().toISOString().slice(0, 10);
/** Indian financial year as the app writes it in a bill number: Apr 2026–Mar 2027 → "2627". */
function fy(): string {
  const d = istNow();
  const start = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}
const payModeCode = (cash: number, upi: number) => (cash > 0 && upi > 0 ? 'mixed' : upi > 0 ? 'upi' : cash > 0 ? 'cash' : 'credit');

export type Grade = '1' | '2' | '3' | 'mix';

export type ParchiInput = {
  buyerId?: string; buyerName?: string; truckId?: string;
  lines?: { grade: Grade; qty: number; ratePaise: number }[];
  /** Angoor: each line is one quality off one gaadi. */
  lots?: { truckId: string; brandId: string; qty: number; ratePaise: number }[];
  pay: 'cash' | 'upi' | 'credit' | 'after' | 'split' | 'free'; cashPaise?: number; upiPaise?: number; upiBank?: string;
  packing: 'loose' | 'katta10' | 'katta15' | 'katta20' | 'katta25' | 'panni'; panniName?: string;
  /** Which katta (Green, Jaipur, White) — kept in panni_name, as the app does. */
  kattaName?: string;
  /** A parchune on top: rides on panni_name ("Jai Ho + Parchune", or just "Parchune" when loose). */
  parchune?: boolean;
  /** Mazdoori: on/off, how many dana it is for (default every nag), and the per-nag rate. */
  labour?: boolean; labourQty?: number; labourRatePaise?: number;
  delivery?: { address: string; stand: string };
  staff?: string; slipNo?: number;
};
export type VasooliInput = { buyerId: string; cashPaise: number; upiPaise: number; upiBank?: string; paymentRef?: string };
export type DaybookInput = { direction: 'in' | 'out'; category: string; mode: 'cash' | 'office' | 'upi' | 'bank'; amountPaise: number; party?: string; note?: string; date?: string };
export type UdhaarInput = { buyerId: string; amountPaise: number; note?: string; date?: string };
export type GrahakInput = { name: string; phone?: string; address?: string; destination?: string; code?: string; vehicle?: string; openingPaise?: number };
export type GaadiInput = {
  number: string; supplier: string; freightPaise?: number; location?: string;
  lots: { brandId?: string; brandName?: string; grade: Grade; qty: number; ratePaise: number; boxGrams?: number }[];
};
export type SupplierPaymentInput = { supplier: string; mode: 'cash' | 'office' | 'upi' | 'bank'; amountPaise: number; note?: string; date?: string };

/** Angoor: once boxes have left the gaadi against a slip (scanned), it is what they left on — as the app has it. */
async function notPickedUp(tx: Tx, billId: string) {
  const r = await tx.query<{ n: string }>(`SELECT COALESCE(SUM(qty), 0) AS n FROM pickups WHERE bill_id = $1`, [billId]);
  if (n(r.rows[0].n) > 0) throw new UnprocessableEntityException('Maal uth chuka hai — yeh parchi ab nahi badlegi');
}

@Injectable()
export class EntriesService {
  constructor(
    private readonly db: Db, private readonly sync: SyncService, private readonly hub: SyncHub, private readonly accounts: AccountsService,
    private readonly print: PrintService,
  ) {}

  /** What the entry forms need: open gaadis and their maal, today's bhav, maal list, suppliers, bank accounts. */
  async options(shopId: string) {
    return this.db.withShop(shopId, async (tx) => {
      const shop = (await tx.query<{ commodity: string; bank_accounts: { bank: string; account: string }[]; apmc_on: boolean }>(
        `SELECT commodity, bank_accounts, apmc_on FROM shops WHERE id = $1`, [shopId])).rows[0];
      const trucks = (await tx.query<{ id: string; number: string; supplier: string; arrived_at: Date; lots: { brand_id: string; brand: string; grade: string; qty: number }[] | null; recv: string; sold: string; spoiled: string }>(
        `SELECT t.id, t.number, t.supplier, t.arrived_at,
                (SELECT json_agg(json_build_object('brand_id', g.brand_id, 'brand', br.name, 'grade', g.grade, 'qty', g.billed_qty + g.free_qty) ORDER BY g.created_at)
                   FROM truck_grades g LEFT JOIN brands br ON br.id = g.brand_id WHERE g.truck_id = t.id) AS lots,
                (SELECT COALESCE(SUM(billed_qty + free_qty), 0) FROM truck_grades g WHERE g.truck_id = t.id)
                  - (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind = 'correction') AS recv,
                (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE l.truck_id = t.id) AS sold,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind <> 'correction') AS spoiled
         FROM trucks t WHERE t.closed_at IS NULL ORDER BY t.arrived_at DESC`)).rows.map((t) => {
        const lots = t.lots ?? [];
        // The maal a slip off this gaadi is booked under: the lot with the most (Models.sellBrandId).
        const byBrand = new Map<string, { brand: string; qty: number }>();
        for (const l of lots) { const b = byBrand.get(l.brand_id) ?? { brand: l.brand ?? 'Maal', qty: 0 }; b.qty += l.qty; byBrand.set(l.brand_id, b); }
        const sell = [...byBrand].sort((a, b) => b[1].qty - a[1].qty)[0];
        return { id: t.id, number: t.number, supplier: t.supplier, arrivedAt: t.arrived_at.toISOString(),
          left: Math.max(0, n(t.recv) - n(t.sold) - n(t.spoiled)), brandId: sell?.[0] ?? null, brand: sell?.[1].brand ?? '' };
      });
      const rates = (await tx.query<{ brand_id: string; grade: string; rate: string }>(
        `SELECT DISTINCT ON (brand_id, grade) brand_id, grade, rate_paise AS rate FROM rates ORDER BY brand_id, grade, business_date DESC, updated_at DESC`)).rows;
      const brands = (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM brands WHERE hidden = false ORDER BY sort_order, name`)).rows;
      const suppliers = new Map<string, string>();
      for (const r of (await tx.query<{ s: string }>(`SELECT TRIM(supplier) AS s FROM trucks WHERE TRIM(supplier) <> '' ORDER BY arrived_at DESC`)).rows) {
        if (!suppliers.has(nameKey(r.s))) suppliers.set(nameKey(r.s), r.s);
      }
      // Angoor: every quality on every open gaadi (sold past its count included — angoor never
      // refuses a sale), and each supplier's last gaadi for Nayi gaadi's smart defaults.
      const angoor = shop.commodity !== 'angoor' ? undefined : await (async () => {
        const lots = (await tx.query<{ truck_id: string; number: string; supplier: string; location: string; brand_id: string; quality: string; recv: string; sold: string; off: string; grams: number }>(
          `SELECT t.id AS truck_id, t.number, t.supplier, t.location, g.brand_id, COALESCE(br.name, '?') AS quality,
                  SUM(g.billed_qty + g.free_qty) AS recv, MAX(g.box_grams) AS grams,
                  (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE l.truck_id = t.id AND l.brand_id = g.brand_id) AS sold,
                  (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.brand_id = g.brand_id) AS off
           FROM trucks t JOIN truck_grades g ON g.truck_id = t.id LEFT JOIN brands br ON br.id = g.brand_id
           WHERE t.closed_at IS NULL GROUP BY t.id, g.brand_id, br.name ORDER BY t.arrived_at DESC, MIN(g.created_at)`)).rows;
        const lastBySupplier = new Map<string, { supplier: string; location: string; truckId: string }>();
        for (const r of (await tx.query<{ id: string; supplier: string; location: string }>(
          `SELECT id, TRIM(supplier) AS supplier, location FROM trucks WHERE TRIM(supplier) <> '' ORDER BY arrived_at DESC`)).rows) {
          if (!lastBySupplier.has(nameKey(r.supplier))) lastBySupplier.set(nameKey(r.supplier), { supplier: r.supplier, location: r.location, truckId: r.id });
        }
        const lastLots = (await tx.query<{ truck_id: string; quality: string; grams: number; rate: string }>(
          `SELECT g.truck_id, COALESCE(br.name, '?') AS quality, MAX(g.box_grams) AS grams, MAX(g.rate_paise) AS rate
           FROM truck_grades g LEFT JOIN brands br ON br.id = g.brand_id WHERE g.truck_id = ANY($1::uuid[])
           GROUP BY g.truck_id, g.brand_id, br.name ORDER BY MIN(g.created_at)`, [[...lastBySupplier.values()].map((v) => v.truckId)])).rows;
        return {
          apmcOn: shop.apmc_on,
          lots: lots.map((l) => ({ truckId: l.truck_id, number: l.number, supplier: l.supplier, location: l.location, brandId: l.brand_id,
            quality: l.quality, left: n(l.recv) - n(l.sold) - n(l.off), boxGrams: l.grams ?? 0 })),
          lastArrivals: [...lastBySupplier.values()].map((v) => ({ supplier: v.supplier, location: v.location,
            lots: lastLots.filter((l) => l.truck_id === v.truckId).map((l) => ({ quality: l.quality, boxGrams: l.grams ?? 0, ratePaise: n(l.rate) })) })),
        };
      })();
      return {
        commodity: shop.commodity,
        ...(angoor ?? {}),
        trucks: trucks.filter((t) => t.left > 0),
        rates: rates.map((r) => ({ brandId: r.brand_id, grade: r.grade, ratePaise: n(r.rate) })),
        brands,
        suppliers: [...suppliers.values()],
        banks: (shop.bank_accounts ?? []).map((b) => bankLabel(b)).filter(Boolean),
      }
    });
  }

  // ---------------------------------------------------------------- Nayi parchi

  async parchi(phone: string, shopId: string, input: ParchiInput) {
    return this.writeParchi(await this.device(phone, shopId), shopId, input, null);
  }

  /**
   * Badlein, as ParchiScreen saves an edit: the old slip is voided ('edited') and the corrected
   * one written in the same entry, keeping its slip number (Store.voidBill + saveParchi with
   * keepSlipNo) — so a terminal sees the number freed and taken again together, or not at all.
   * Like the app, a slip with vasooli on it stays as written; it can only be deleted.
   */
  async editParchi(phone: string, shopId: string, billId: string, input: ParchiInput) {
    const p = await this.device(phone, shopId);
    const old = await this.db.withShop(shopId, async (tx) => {
      const b = await liveBill(tx, billId);
      if ((await collectedOn(tx, billId)).rows.length) throw new UnprocessableEntityException('Is parchi par vasooli ho chuki hai — badal nahi sakte, sirf hata sakte hain');
      await notPickedUp(tx, billId);
      return b;
    });
    return this.writeParchi(p, shopId, input, old);
  }

  private async writeParchi(p: Principal, shopId: string, input: ParchiInput, editing: LiveBill | null) {
    const commodity = await this.db.withShop(shopId, async (tx) =>
      (await tx.query<{ commodity: string }>(`SELECT commodity FROM shops WHERE id = $1`, [shopId])).rows[0].commodity);
    if (commodity === 'angoor') return this.writeAngoorParchi(p, shopId, input, editing);
    if (!input.truckId || !input.lines) throw new BadRequestException('Gaadi aur maal chunein');
    const truckId = input.truckId;
    const lines = input.lines.filter((l) => l.qty > 0);
    if (!lines.length) throw new BadRequestException('Kam se kam ek line daalein');
    const now = new Date().toISOString();
    const free = input.pay === 'free';

    const pre = await this.db.withShop(shopId, async (tx) => {
      const shop = (await tx.query<{ commodity: string }>(`SELECT commodity FROM shops WHERE id = $1`, [shopId])).rows[0];
      if (shop.commodity !== 'nariyal') throw new UnprocessableEntityException('Is maal ki parchi app se banayein');
      const truck = (await tx.query<{ id: string; recv: string; sold: string; spoiled: string }>(
        `SELECT t.id,
                (SELECT COALESCE(SUM(billed_qty + free_qty), 0) FROM truck_grades g WHERE g.truck_id = t.id)
                  - (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind = 'correction') AS recv,
                (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE l.truck_id = t.id) AS sold,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind <> 'correction') AS spoiled
         FROM trucks t WHERE t.id = $1 AND (t.closed_at IS NULL OR t.id = $2)`, [truckId, editing?.truck_id ?? null])).rows[0];
      if (!truck) throw new BadRequestException('Yeh gaadi khuli nahi hai');
      // The dana the slip being edited took off this gaadi come back when it is replaced.
      const own = editing ? n((await tx.query<{ q: string }>(
        `SELECT COALESCE(SUM(qty), 0) AS q FROM bill_lines WHERE bill_id = $1 AND truck_id = $2`, [editing.id, truckId])).rows[0].q) : 0;
      const left = n(truck.recv) - n(truck.sold) - n(truck.spoiled) + own;
      const qty = lines.reduce((s, l) => s + l.qty, 0);
      if (qty > left) throw new UnprocessableEntityException(`Gaadi mein sirf ${left} nag baaki hain`);
      const brand = (await tx.query<{ brand_id: string }>(
        `SELECT brand_id FROM truck_grades WHERE truck_id = $1 GROUP BY brand_id ORDER BY SUM(billed_qty + free_qty) DESC LIMIT 1`, [truckId])).rows[0];
      let buyer: { id: string; name: string } | null = null;
      if (input.buyerId) {
        buyer = (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM buyers WHERE id = $1`, [input.buyerId])).rows[0] ?? null;
        if (!buyer) throw new BadRequestException('Grahak nahi mila');
      }
      return { brandId: brand?.brand_id, qty, slipNo: await nextNumber(tx, 'bills', 'slip_no', 'bill_voids'), number: await this.billNumber(tx, p.deviceId) };
    });
    if (!pre.brandId) throw new BadRequestException('Gaadi mein maal nahi');

    const items: PushItem[] = [];
    let buyerId = input.buyerId ?? null;
    let buyerName = (input.buyerName ?? '').trim();
    const walkIn = /^(cash|bank|free)$/i.test(buyerName) || (!buyerId && !buyerName);
    if (!buyerId && buyerName && !walkIn) {
      // A new name on a slip becomes a grahak first, in its own entry, as the app does.
      buyerId = uuidv7();
      items.push({ table: 'buyers', row: this.buyerRow(buyerId, { name: buyerName }, now), txn: uuidv7() });
    }
    if (buyerId && !input.buyerName) buyerName = (await this.db.withShop(shopId, async (tx) => (await tx.query<{ name: string }>(`SELECT name FROM buyers WHERE id = $1`, [buyerId])).rows[0]?.name)) ?? '';
    if (free) { buyerId = null; buyerName = 'Free'; }
    if (!buyerId && !buyerName) buyerName = 'Cash';

    const goods = free ? 0 : lines.reduce((s, l) => s + l.qty * l.ratePaise, 0);
    let cash = 0, upi = 0;
    if (input.pay === 'cash') cash = goods;
    else if (input.pay === 'upi') upi = goods;
    else if (input.pay === 'split') { cash = input.cashPaise ?? 0; upi = input.upiPaise ?? 0; }
    if (cash + upi > goods) throw new BadRequestException('Jama rakam parchi se zyada hai');
    if (!buyerId && cash + upi < goods && !free) throw new BadRequestException('Udhaar ke liye grahak chunein');
    const chosen = free ? 'free' : input.pay === 'split' ? null : input.pay;
    const payMode = chosen && (goods === 0 || chosen === 'after') ? chosen : payModeCode(cash, upi);
    const packed = input.packing !== 'loose';
    const isKatta = /^katta/.test(input.packing);
    // Mazdoori as the parchi screen charges it: on for packed maal, off for a loose parchune.
    const labourOn = input.labour ?? (packed && !(input.packing === 'loose' && input.parchune));
    const labourQty = labourOn ? (input.labourQty ?? pre.qty) : 0;
    const panniName = (input.packing === 'panni'
      ? [(input.panniName ?? '').trim(), input.parchune ? PARCHUNE : ''].filter(Boolean).join(' + ')
      : isKatta ? (input.kattaName ?? '').trim()
      : input.parchune ? PARCHUNE : '').slice(0, 40);
    const delivery = input.delivery && (input.delivery.address.trim() || input.delivery.stand.trim()) ? input.delivery : null;
    const billId = uuidv7();
    const txn = uuidv7();
    // An edit keeps the number the customer's copy carries; a slip without one takes the next.
    const slipNo = editing ? (editing.slip_no ?? pre.slipNo) : (input.slipNo ?? pre.slipNo);
    if (editing) items.push({ table: 'bill_voids', txn, row: {
      id: uuidv7(), created_at: now, bill_id: editing.id, slip_no: editing.slip_no, reason: 'edited',
    } });
    items.push({
      table: 'bills', txn, row: {
        // A corrected slip stays on its own day (and time): editing an old slip never moves it to today.
        id: billId, created_at: editing ? editing.created_at.toISOString() : now, number: pre.number, kind: 'kachchi', buyer_id: buyerId, buyer_name: buyerName,
        business_date: editing ? editing.day.slice(0, 10) : todayIst(), pay_mode: payMode, total_paise: goods, paid_paise: cash + upi, cash_paise: cash, upi_paise: upi,
        payment_ref: '', slip_no: slipNo, truck_id: truckId,
        labour_paise: labourQty * (input.labourRatePaise ?? LABOUR_PAISE_PER_NAG),
        packing: input.packing, panni_name: panniName, packs: labourQty,
        delivery: !!delivery, staff_name: (input.staff ?? '').trim().slice(0, 60) || 'Website', chungi_paise: 0,
        upi_bank: upi > 0 ? (input.upiBank ?? '') : '',
      },
    });
    for (const l of lines) {
      items.push({ table: 'bill_lines', txn, row: {
        id: uuidv7(), created_at: now, bill_id: billId, truck_id: truckId, brand_id: pre.brandId, grade: l.grade, qty: l.qty,
        rate_paise: free ? 0 : l.ratePaise, leak: false,
      } });
    }
    // The rickshaw's slip is its own record, made right after the parchi (Store.addDeliverySlip).
    if (delivery) items.push({ table: 'delivery_slips', txn: uuidv7(), row: {
      id: uuidv7(), created_at: now, bill_id: billId, address: delivery.address.trim().slice(0, 200), destination: delivery.stand.trim().slice(0, 120),
    } });
    const results = await this.push(p, shopId, items);
    const bill = results.find((r) => r.id === billId)!;
    const no = bill.renumbered?.to ?? slipNo;
    // A new slip prints on the shop's print machine by itself, as one saved on a phone does;
    // an edit prints only when asked, as in the app.
    const printing = !editing && await this.print.queueBill(p, billId, `Order Parchi #${no}`).then(() => true, () => false);
    return { billId, number: pre.number, slipNo: no, buyerId, replaced: editing?.id ?? null, printing, results };
  }

  /**
   * Angoor's parchi, as the app writes it (Store.saveParchi): each line one quality off one
   * gaadi, several gaadis on a slip, no count limit. The grahak pays the goods plus 1% APMC
   * (when the shop has it on) plus, on an udhaar slip with labour ticked, boxes × the labour
   * rate. chungi_paise holds APMC + labour, apmc_paise the APMC, labour_paise the labour.
   */
  private async writeAngoorParchi(p: Principal, shopId: string, input: ParchiInput, editing: LiveBill | null) {
    const lots = (input.lots ?? []).filter((l) => l.qty > 0);
    if (!lots.length) throw new BadRequestException('Kam se kam ek quality aur box daalein');
    const now = new Date().toISOString();
    const free = input.pay === 'free';

    const pre = await this.db.withShop(shopId, async (tx) => {
      const shop = (await tx.query<{ apmc_on: boolean }>(`SELECT apmc_on FROM shops WHERE id = $1`, [shopId])).rows[0];
      // The slip being changed may sit on a gaadi closed since; its own gaadis stay allowed.
      const own = editing ? (await tx.query<{ truck_id: string }>(`SELECT DISTINCT truck_id FROM bill_lines WHERE bill_id = $1`, [editing.id])).rows.map((r) => r.truck_id) : [];
      for (const l of lots) {
        const ok = (await tx.query(
          `SELECT 1 FROM truck_grades g JOIN trucks t ON t.id = g.truck_id
           WHERE g.truck_id = $1 AND g.brand_id = $2 AND (t.closed_at IS NULL OR t.id = ANY($3::uuid[])) LIMIT 1`,
          [l.truckId, l.brandId, own])).rowCount;
        if (!ok) throw new BadRequestException('Yeh quality is gaadi par nahi hai');
      }
      let buyer: { id: string; name: string } | null = null;
      if (input.buyerId) {
        buyer = (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM buyers WHERE id = $1`, [input.buyerId])).rows[0] ?? null;
        if (!buyer) throw new BadRequestException('Grahak nahi mila');
      }
      return { apmcOn: shop.apmc_on, slipNo: await nextNumber(tx, 'bills', 'slip_no', 'bill_voids'), number: await this.billNumber(tx, p.deviceId) };
    });

    const items: PushItem[] = [];
    let buyerId = input.buyerId ?? null;
    let buyerName = (input.buyerName ?? '').trim();
    const walkIn = /^(cash|bank|free)$/i.test(buyerName) || (!buyerId && !buyerName);
    if (!buyerId && buyerName && !walkIn) {
      buyerId = uuidv7();
      items.push({ table: 'buyers', row: this.buyerRow(buyerId, { name: buyerName }, now), txn: uuidv7() });
    }
    if (buyerId && !input.buyerName) buyerName = (await this.db.withShop(shopId, async (tx) => (await tx.query<{ name: string }>(`SELECT name FROM buyers WHERE id = $1`, [buyerId])).rows[0]?.name)) ?? '';
    if (free) { buyerId = null; buyerName = 'Free'; }
    if (!buyerId && !buyerName) buyerName = 'Cash';

    const boxes = lots.reduce((s, l) => s + l.qty, 0);
    const goods = free ? 0 : lots.reduce((s, l) => s + l.qty * l.ratePaise, 0);
    const apmc = pre.apmcOn ? Math.round(goods * 0.01) : 0;
    // Labour only for an udhaar grahak who is charged it.
    const credit = input.pay === 'credit' || input.pay === 'after';
    const labour = !free && credit && input.labour ? boxes * (input.labourRatePaise ?? 1000) : 0;
    const total = goods + apmc + labour;
    let cash = 0, upi = 0;
    if (input.pay === 'cash') cash = total;
    else if (input.pay === 'upi') upi = total;
    else if (input.pay === 'split') { cash = input.cashPaise ?? 0; upi = input.upiPaise ?? 0; }
    if (cash + upi > total) throw new BadRequestException('Jama rakam parchi se zyada hai');
    if (!buyerId && cash + upi < total && !free) throw new BadRequestException('Udhaar ke liye grahak chunein');
    const chosen = free ? 'free' : input.pay === 'split' ? null : input.pay;
    const payMode = chosen && (total === 0 || chosen === 'after') ? chosen : payModeCode(cash, upi);
    const delivery = input.delivery && (input.delivery.address.trim() || input.delivery.stand.trim()) ? input.delivery : null;
    const billId = uuidv7();
    const txn = uuidv7();
    const slipNo = editing ? (editing.slip_no ?? pre.slipNo) : (input.slipNo ?? pre.slipNo);
    if (editing) items.push({ table: 'bill_voids', txn, row: {
      id: uuidv7(), created_at: now, bill_id: editing.id, slip_no: editing.slip_no, reason: 'edited',
    } });
    items.push({
      table: 'bills', txn, row: {
        id: billId, created_at: editing ? editing.created_at.toISOString() : now, number: pre.number, kind: 'kachchi', buyer_id: buyerId, buyer_name: buyerName,
        business_date: editing ? editing.day.slice(0, 10) : todayIst(), pay_mode: payMode, total_paise: total, paid_paise: cash + upi, cash_paise: cash, upi_paise: upi,
        payment_ref: '', slip_no: slipNo, truck_id: null,
        labour_paise: labour, packing: 'loose', panni_name: '', packs: labour > 0 ? boxes : 0,
        delivery: !!delivery, staff_name: (input.staff ?? '').trim().slice(0, 60) || 'Website',
        chungi_paise: apmc + labour, apmc_paise: apmc,
        upi_bank: upi > 0 ? (input.upiBank ?? '') : '',
      },
    });
    for (const l of lots) {
      items.push({ table: 'bill_lines', txn, row: {
        id: uuidv7(), created_at: now, bill_id: billId, truck_id: l.truckId, brand_id: l.brandId, grade: '1', qty: l.qty,
        rate_paise: free ? 0 : l.ratePaise, leak: false,
      } });
    }
    if (delivery) items.push({ table: 'delivery_slips', txn: uuidv7(), row: {
      id: uuidv7(), created_at: now, bill_id: billId, address: delivery.address.trim().slice(0, 200), destination: delivery.stand.trim().slice(0, 120),
    } });
    const results = await this.push(p, shopId, items);
    const bill = results.find((r) => r.id === billId)!;
    const no = bill.renumbered?.to ?? slipNo;
    const printing = !editing && await this.print.queueBill(p, billId, `Order Parchi #${no}`).then(() => true, () => false);
    return { billId, number: pre.number, slipNo: no, buyerId, replaced: editing?.id ?? null, printing, results };
  }

  // ---------------------------------------------------------------- Vasooli

  /** One raseed with nothing picked: a single collections row, as the app writes it then (bill_id null). */
  async vasooli(phone: string, shopId: string, input: VasooliInput) {
    if (input.cashPaise + input.upiPaise <= 0) throw new BadRequestException('Rakam daalein');
    const p = await this.device(phone, shopId);
    const receiptNo = await this.db.withShop(shopId, async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM buyers WHERE id = $1`, [input.buyerId])).rowCount) throw new BadRequestException('Grahak nahi mila');
      return nextNumber(tx, 'collections', 'receipt_no', 'collection_voids');
    });
    const id = uuidv7();
    const results = await this.push(p, shopId, [{ table: 'collections', txn: uuidv7(), row: {
      id, created_at: new Date().toISOString(), buyer_id: input.buyerId, amount_paise: input.cashPaise + input.upiPaise,
      pay_mode: payModeCode(input.cashPaise, input.upiPaise), payment_ref: (input.paymentRef ?? '').slice(0, 40), business_date: todayIst(),
      bill_id: null, receipt_no: receiptNo, cash_paise: input.cashPaise, upi_paise: input.upiPaise,
      upi_bank: input.upiPaise > 0 ? (input.upiBank ?? '') : '',
    } }]);
    return { id, receiptNo: results[0].renumbered?.to ?? receiptNo, results };
  }

  // ---------------------------------------------------------------- Hatayein (delete) and Badlein (alter)

  /**
   * Deletes a parchi as ParchiDoneScreen does. A slip with no money on it is simply voided
   * (Store.voidBill): its dana go back on the gaadi. A slip with money on it — paid at the
   * counter, or vasooli taken on it later — asks what happens to the money:
   *  - refunded (Store.refundBill): the vasooli on it is cancelled too; cash leaves with the slip,
   *    and UPI, which can't go back over the counter, stays in the bank while the same amount
   *    leaves the galla in cash — an 'aur_aaya' UPI line in and an 'aur_gaya' cash line out.
   *  - advance (Store.billToAdvance): the counter money becomes a raseed with no slip; vasooli
   *    on the slip turns loose by itself and settles other dues. A walk-in has no khata for it.
   * Every row lands in one entry, so a terminal applies the whole delete or none of it.
   */
  async voidBill(phone: string, shopId: string, billId: string, reason: 'deleted' | 'refunded' | 'advance') {
    const p = await this.device(phone, shopId);
    const { b, later, receiptNo } = await this.db.withShop(shopId, async (tx) => {
      const b = await liveBill(tx, billId);
      await notPickedUp(tx, billId);
      return { b, later: await collectedOn(tx, billId), receiptNo: await nextNumber(tx, 'collections', 'receipt_no', 'collection_voids') };
    });
    const [cash, upi] = billMoney(b);
    const money = n(b.paid_paise) + later.cash + later.upi;
    if (reason === 'deleted' && money > 0) throw new UnprocessableEntityException('Is parchi par paisa liya gaya hai — refund ya advance chunein');
    if (reason !== 'deleted' && money === 0) throw new UnprocessableEntityException('Is parchi par koi paisa nahi — seedha hatayein');
    if (reason === 'advance' && !b.buyer_id) throw new UnprocessableEntityException('Cash grahak ka khata nahi — refund chunein');
    const now = new Date().toISOString();
    const txn = uuidv7();
    const items: PushItem[] = [];
    const voidRow = { table: 'bill_voids', txn, row: { id: uuidv7(), created_at: now, bill_id: b.id, slip_no: b.slip_no, reason } };
    let advance: { id: string; receiptNo: number } | null = null;
    if (reason === 'refunded') {
      for (const c of later.rows) items.push({ table: 'collection_voids', txn, row: {
        id: uuidv7(), created_at: now, collection_id: c.id, receipt_no: c.receipt_no, reason: 'deleted',
      } });
      const upiBack = upi + later.upi;
      if (upiBack > 0) {
        const slip = `Parchi #${b.slip_no ?? 0}`;
        const party = b.buyer_id ? b.buyer_name : '';
        for (const [direction, mode, category, note] of [['in', 'upi', 'aur_aaya', `${slip} wapas · UPI aaya tha`], ['out', 'cash', 'aur_gaya', `${slip} refund · cash diya`]]) {
          items.push({ table: 'daybook_entries', txn, row: {
            id: uuidv7(), created_at: now, updated_at: now, direction, mode, category, party_name: party, note,
            amount_paise: upiBack, business_date: todayIst(), hidden: false,
          } });
        }
      }
      items.push(voidRow);
    } else {
      items.push(voidRow);
      // Only the counter money becomes the raseed; vasooli taken on the slip is already a raseed.
      if (reason === 'advance' && cash + upi > 0) {
        advance = { id: uuidv7(), receiptNo };
        items.push({ table: 'collections', txn, row: {
          id: advance.id, created_at: now, buyer_id: b.buyer_id, amount_paise: cash + upi, pay_mode: payModeCode(cash, upi),
          payment_ref: '', business_date: todayIst(), bill_id: null, receipt_no: receiptNo, cash_paise: cash, upi_paise: upi, upi_bank: '',
        } });
      }
    }
    const results = await this.push(p, shopId, items);
    return {
      billId: b.id, slipNo: b.slip_no, reason,
      // What goes back over the counter: all of it in cash (the UPI part stays in the bank).
      refundPaise: reason === 'refunded' ? money : 0,
      advance: advance && { ...advance, receiptNo: results.find((r) => r.id === advance!.id)?.renumbered?.to ?? advance.receiptNo, amountPaise: cash + upi },
      results,
    };
  }

  /** A raseed as one payment: the rows taken together (same grahak, same moment), as Store.pastCollections groups them. */
  async collection(shopId: string, collectionId: string) {
    return this.db.withShop(shopId, async (tx) => {
      const g = await paymentRows(tx, collectionId);
      const head = g.rows[0];
      const buyer = (await tx.query<{ name: string }>(`SELECT name FROM buyers WHERE id = $1`, [head.buyer_id])).rows[0];
      const machine = (await tx.query<{ m: string }>(
        `SELECT CONCAT_WS(' · ', d.code, NULLIF(d.label, '')) AS m FROM devices d WHERE d.id = $1`, [head.device_id])).rows[0]?.m ?? '';
      const voided = (await tx.query<{ reason: string; at: Date }>(
        `SELECT reason, created_at AS at FROM collection_voids WHERE collection_id = $1 LIMIT 1`, [collectionId])).rows[0];
      return {
        id: collectionId, receiptNo: g.receiptNo, buyerId: head.buyer_id, buyerName: buyer?.name ?? '', at: head.created_at.toISOString(), date: head.day,
        cashPaise: g.rows.reduce((s, r) => s + n(r.cash), 0), upiPaise: g.rows.reduce((s, r) => s + n(r.upi), 0),
        ref: g.rows.map((r) => r.payment_ref).find(Boolean) ?? '', upiBank: g.rows.map((r) => r.upi_bank).find(Boolean) ?? '', machine,
        slips: g.rows.filter((r) => r.bill_id).map((r) => ({ billId: r.bill_id!, slipNo: r.slip_no, amountPaise: n(r.amount_paise) })),
        voided: voided ? { reason: voided.reason, at: voided.at.toISOString() } : null,
      };
    });
  }

  /** Hatayein on a raseed (Store.voidCollection): a void per row; the slips it paid are owed again. */
  async voidCollection(phone: string, shopId: string, collectionId: string) {
    const p = await this.device(phone, shopId);
    const g = await this.db.withShop(shopId, (tx) => paymentRows(tx, collectionId, true));
    const now = new Date().toISOString();
    const txn = uuidv7();
    const results = await this.push(p, shopId, g.rows.map((r) => ({ table: 'collection_voids', txn, row: {
      id: uuidv7(), created_at: now, collection_id: r.id, receipt_no: r.receipt_no ?? g.receiptNo, reason: 'deleted',
    } })));
    return { receiptNo: g.receiptNo, amountPaise: g.rows.reduce((s, r) => s + n(r.amount_paise), 0), results };
  }

  /**
   * Badlein on a raseed (Store.editCollection): the old rows are voided ('edited') and the money
   * taken again with the same raseed number and time — over the slips it paid, as they would stand
   * without it (duesIfVoided), oldest first, cash before UPI; on no slip, one loose row.
   */
  async editCollection(phone: string, shopId: string, collectionId: string, input: Omit<VasooliInput, 'buyerId'>) {
    if (input.cashPaise + input.upiPaise <= 0) throw new BadRequestException('Rakam daalein');
    const p = await this.device(phone, shopId);
    const { g, dues } = await this.db.withShop(shopId, async (tx) => {
      const g = await paymentRows(tx, collectionId, true);
      const bills = new Set(g.rows.map((r) => r.bill_id).filter(Boolean));
      const dues = bills.size ? (await openDues(tx, g.rows[0].buyer_id, g.rows.map((r) => r.id))).filter((d) => bills.has(d.billId)) : [];
      return { g, dues };
    });
    const head = g.rows[0];
    const at = head.created_at.toISOString();
    const now = new Date().toISOString();
    const txn = uuidv7();
    const items: PushItem[] = g.rows.map((r) => ({ table: 'collection_voids', txn, row: {
      id: uuidv7(), created_at: now, collection_id: r.id, receipt_no: r.receipt_no ?? g.receiptNo, reason: 'edited',
    } }));
    const ref = (input.paymentRef ?? '').slice(0, 40);
    const bank = (u: number) => (u > 0 ? (input.upiBank ?? '').trim() : '');
    const row = (amount: number, c: number, u: number, billId: string | null, first: boolean) => ({ table: 'collections', txn, row: {
      id: uuidv7(), created_at: at, buyer_id: head.buyer_id, amount_paise: amount, pay_mode: payModeCode(c, u),
      payment_ref: first ? ref : '', business_date: head.day, bill_id: billId, receipt_no: first ? g.receiptNo : null,
      cash_paise: c, upi_paise: u, upi_bank: bank(u),
    } });
    if (!dues.length) items.push(row(input.cashPaise + input.upiPaise, input.cashPaise, input.upiPaise, null, true));
    else {
      // Slips with no bhav go last and share what is left over by their dana (collectDues).
      const ordered = [...dues].sort((a, b) => Number(a.unpriced) - Number(b.unpriced) || a.at - b.at);
      const pricedOwed = ordered.filter((d) => !d.unpriced).reduce((s, d) => s + d.openPaise, 0);
      const spare = Math.max(0, input.cashPaise + input.upiPaise - pricedOwed);
      const unpricedQty = Math.max(1, ordered.filter((d) => d.unpriced).reduce((s, d) => s + d.qty, 0));
      let cash = input.cashPaise, upi = input.upiPaise, first = true;
      ordered.forEach((d, i) => {
        const share = d.unpriced ? Math.floor(spare * d.qty / unpricedQty) : d.openPaise;
        const want = i === ordered.length - 1 ? cash + upi : Math.min(share, cash + upi);
        if (want <= 0) return;
        const c = Math.min(cash, want), u = want - c;
        cash -= c; upi -= u;
        items.push(row(want, c, u, d.billId, first));
        first = false;
      });
    }
    const results = await this.push(p, shopId, items);
    const first = items.find((i) => i.table === 'collections')!;
    return { receiptNo: results.find((r) => r.id === first.row.id)?.renumbered?.to ?? g.receiptNo, results };
  }

  // ---------------------------------------------------------------- Daybook, supplier payment

  async daybook(phone: string, shopId: string, input: DaybookInput) {
    if (/^aur_/.test(input.category) && !(input.note ?? '').trim()) throw new BadRequestException('Aur ke saath wajah likhein');
    const p = await this.device(phone, shopId);
    return this.dayRow(p, shopId, input);
  }

  async supplierPayment(phone: string, shopId: string, input: SupplierPaymentInput) {
    const p = await this.device(phone, shopId);
    // Spelled as the shop already writes him, so his khata picks the payment up.
    const known = await this.db.withShop(shopId, async (tx) => (await tx.query<{ s: string }>(
      `SELECT TRIM(supplier) AS s FROM trucks WHERE TRIM(supplier) <> '' ORDER BY arrived_at DESC`)).rows.find((r) => nameKey(r.s) === nameKey(input.supplier))?.s);
    return this.dayRow(p, shopId, { direction: 'out', category: 'supplier', mode: input.mode, amountPaise: input.amountPaise, party: known ?? input.supplier.trim(), note: input.note, date: input.date });
  }

  private async dayRow(p: Principal, shopId: string, input: DaybookInput) {
    const now = new Date().toISOString();
    const id = uuidv7();
    const results = await this.push(p, shopId, [{ table: 'daybook_entries', txn: uuidv7(), row: {
      id, created_at: now, updated_at: now, direction: input.direction, mode: input.mode, category: input.category,
      party_name: (input.party ?? '').trim(), note: (input.note ?? '').trim(), amount_paise: input.amountPaise,
      business_date: input.date ?? todayIst(), hidden: false,
    } }]);
    return { id, results };
  }

  // ---------------------------------------------------------------- Udhaar, grahak

  /** Positive = udhaar (purana / added by hand); negative = jama. */
  async udhaar(phone: string, shopId: string, input: UdhaarInput) {
    if (!input.amountPaise) throw new BadRequestException('Rakam daalein');
    const p = await this.device(phone, shopId);
    await this.db.withShop(shopId, async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM buyers WHERE id = $1`, [input.buyerId])).rowCount) throw new BadRequestException('Grahak nahi mila');
    });
    const id = uuidv7();
    const results = await this.push(p, shopId, [{ table: 'udhaar_entries', txn: uuidv7(), row: {
      id, created_at: new Date().toISOString(), buyer_id: input.buyerId, amount_paise: input.amountPaise,
      note: (input.note ?? '').trim() || (input.amountPaise > 0 ? 'Udhaar' : 'Jama'), business_date: input.date ?? todayIst(),
    } }]);
    return { id, results };
  }

  async grahak(phone: string, shopId: string, input: GrahakInput) {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('Naam daalein');
    const p = await this.device(phone, shopId);
    const dup = await this.db.withShop(shopId, async (tx) => (await tx.query<{ id: string }>(
      `SELECT id FROM buyers WHERE hidden = false AND lower(trim(name)) = lower($1)`, [name])).rows[0]);
    if (dup) throw new UnprocessableEntityException('Is naam ka grahak pehle se hai');
    const now = new Date().toISOString();
    const id = uuidv7();
    const txn = uuidv7();
    const items: PushItem[] = [{ table: 'buyers', txn, row: this.buyerRow(id, input, now) }];
    if (input.openingPaise) items.push({ table: 'udhaar_entries', txn, row: {
      id: uuidv7(), created_at: now, buyer_id: id, amount_paise: input.openingPaise, note: 'Purana udhaar', business_date: todayIst(),
    } });
    const results = await this.push(p, shopId, items);
    return { id, results };
  }

  // ---------------------------------------------------------------- Nayi gaadi

  async gaadi(phone: string, shopId: string, input: GaadiInput) {
    const lots = input.lots.filter((l) => l.qty > 0);
    if (!lots.length) throw new BadRequestException('Kam se kam ek maal ka dana daalein');
    const number = input.number.toUpperCase().replace(/\s+/g, '');
    if (!number) throw new BadRequestException('Gaadi number daalein');
    const p = await this.device(phone, shopId);
    const now = new Date().toISOString();
    const { supplier, brandIds } = await this.db.withShop(shopId, async (tx) => {
      const shop = (await tx.query<{ commodity: string }>(`SELECT commodity FROM shops WHERE id = $1`, [shopId])).rows[0];
      if (shop.commodity === 'amrud') throw new UnprocessableEntityException('Is maal ki party app se jodein');
      if (shop.commodity === 'angoor' && !input.supplier.trim()) throw new BadRequestException('Supplier ka naam daalein');
      const known = (await tx.query<{ s: string }>(`SELECT TRIM(supplier) AS s FROM trucks WHERE TRIM(supplier) <> '' ORDER BY arrived_at DESC`)).rows
        .find((r) => nameKey(r.s) === nameKey(input.supplier))?.s;
      const brands = (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM brands`)).rows;
      const ids = lots.map((l) => l.brandId ?? brands.find((b) => nameKey(b.name) === nameKey(l.brandName ?? ''))?.id ?? null);
      return { supplier: known ?? input.supplier.trim(), brandIds: ids };
    });
    const items: PushItem[] = [];
    const newBrands = new Map<string, string>();
    lots.forEach((l, i) => {
      if (brandIds[i]) return;
      const name = (l.brandName ?? '').trim();
      if (!name) throw new BadRequestException('Maal ka naam daalein');
      if (!newBrands.has(nameKey(name))) {
        const id = uuidv7();
        newBrands.set(nameKey(name), id);
        items.push({ table: 'brands', txn: uuidv7(), row: { id, created_at: now, updated_at: now, name, sort_order: 999, hidden: false, shelf_days: 7 } });
      }
      brandIds[i] = newBrands.get(nameKey(name))!;
    });
    const truckId = uuidv7();
    const txn = uuidv7();
    items.push({ table: 'trucks', txn, row: {
      id: truckId, created_at: now, updated_at: now, number, supplier, arrived_at: now,
      freight_paise: input.freightPaise ?? 0, labour_paise: 0, commission_paise: 0, closed_at: null,
      // Angoor: where the gaadi stands, printed on every slip off it.
      ...(input.location?.trim() ? { location: input.location.trim().slice(0, 80) } : {}),
    } });
    lots.forEach((l, i) => items.push({ table: 'truck_grades', txn, row: {
      id: uuidv7(), created_at: now, truck_id: truckId, brand_id: brandIds[i], grade: l.grade,
      billed_qty: l.qty, free_qty: 0, received_qty: l.qty, rate_paise: l.ratePaise, box_grams: l.boxGrams ?? 0,
    } }));
    const results = await this.push(p, shopId, items);
    return { truckId, results };
  }

  /**
   * A grapes gaadi changed after it came, as the app's Gaadi screen does: number, supplier, where
   * it stands and bhada on the gaadi itself; a quality's boxes by the difference — more boxes as
   * another lot line at its own bhav and kg, fewer as a correction — and a new quality as a new lot.
   */
  async editGaadi(phone: string, shopId: string, truckId: string, input: GaadiInput) {
    const number = input.number.toUpperCase().replace(/\s+/g, '');
    if (!number) throw new BadRequestException('Gaadi number daalein');
    if (!input.supplier.trim()) throw new BadRequestException('Supplier ka naam daalein');
    const p = await this.device(phone, shopId);
    const now = new Date().toISOString();
    const { truck, have, brands } = await this.db.withShop(shopId, async (tx) => {
      const truck = (await tx.query<{ id: string; created_at: Date; arrived_at: Date; labour_paise: string; commission_paise: string; closed_at: Date | null }>(
        `SELECT id, created_at, arrived_at, labour_paise, commission_paise, closed_at FROM trucks WHERE id = $1`, [truckId])).rows[0];
      if (!truck) throw new NotFoundException('Gaadi nahi mili');
      const have = (await tx.query<{ brand_id: string; qty: string; rate: string; box_grams: number }>(
        `SELECT g.brand_id, SUM(g.received_qty) - COALESCE((SELECT SUM(qty) FROM spoilage s WHERE s.truck_id = $1 AND s.brand_id = g.brand_id AND s.kind = 'correction'), 0) AS qty,
                (array_agg(g.rate_paise ORDER BY g.created_at DESC))[1] AS rate, MAX(g.box_grams) AS box_grams
         FROM truck_grades g WHERE g.truck_id = $1 GROUP BY g.brand_id`, [truckId])).rows;
      const brands = (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM brands`)).rows;
      return { truck, have, brands };
    });
    const items: PushItem[] = [{ table: 'trucks', txn: uuidv7(), row: {
      id: truck.id, created_at: truck.created_at.toISOString(), updated_at: now, number, supplier: input.supplier.trim(), arrived_at: truck.arrived_at.toISOString(),
      freight_paise: input.freightPaise ?? 0, labour_paise: n(truck.labour_paise), commission_paise: n(truck.commission_paise),
      closed_at: truck.closed_at?.toISOString() ?? null, location: (input.location ?? '').trim().slice(0, 80),
    } }];
    const day = todayIst();
    for (const l of input.lots) {
      let brandId = l.brandId ?? brands.find((b) => nameKey(b.name) === nameKey(l.brandName ?? ''))?.id;
      if (!brandId) {
        const name = (l.brandName ?? '').trim();
        if (!name || !l.qty) continue;
        brandId = uuidv7();
        brands.push({ id: brandId, name });
        items.push({ table: 'brands', txn: uuidv7(), row: { id: brandId, created_at: now, updated_at: now, name, sort_order: 999, hidden: false, shelf_days: 7 } });
      }
      const old = have.find((h) => h.brand_id === brandId);
      const diff = l.qty - (old ? n(old.qty) : 0);
      if (diff > 0) items.push({ table: 'truck_grades', txn: uuidv7(), row: {
        id: uuidv7(), created_at: now, truck_id: truckId, brand_id: brandId, grade: '1', billed_qty: diff, free_qty: 0, received_qty: diff,
        rate_paise: old ? n(old.rate) : l.ratePaise, box_grams: old ? old.box_grams : l.boxGrams ?? 0,
      } });
      if (diff < 0) items.push({ table: 'spoilage', txn: uuidv7(), row: {
        id: uuidv7(), created_at: now, truck_id: truckId, brand_id: brandId, grade: '1', qty: -diff, business_date: day, kind: 'correction', note: 'Website',
      } });
    }
    await this.push(p, shopId, items);
    return { truckId, number };
  }

  // ---------------------------------------------------------------- plumbing

  /**
   * Changes a grahak's details (Bolo's "Om ka number 98… likh lo", or a number given so a
   * WhatsApp can go): the whole row as it is with the change, a newer updated_at, pushed as a
   * terminal pushes it. code, card and market udhaar are left out unless changed, so they stay.
   */
  async updateGrahak(phone: string, shopId: string, buyerId: string, patch: { phone?: string; address?: string; destination?: string; code?: string; name?: string }) {
    const p = await this.device(phone, shopId);
    const g = await this.db.withShop(shopId, async (tx) => (await tx.query<{
      id: string; created_at: Date; name: string; phone: string; kind: string; credit_limit_paise: string; vehicle: string; address: string; destination: string; hidden: boolean
    }>(`SELECT id, created_at, name, phone, kind, credit_limit_paise, vehicle, address, destination, hidden FROM buyers WHERE id = $1`, [buyerId])).rows[0]);
    if (!g) throw new BadRequestException('Grahak nahi mila');
    if (patch.phone !== undefined && patch.phone && !/^[6-9]\d{9}$/.test(patch.phone)) throw new BadRequestException('Mobile number 10 ank ka hona chahiye');
    const row: Record<string, unknown> = {
      id: g.id, created_at: g.created_at.toISOString(), updated_at: new Date().toISOString(),
      name: (patch.name ?? g.name).trim(), phone: patch.phone ?? g.phone, kind: g.kind, credit_limit_paise: n(g.credit_limit_paise),
      vehicle: g.vehicle, address: (patch.address ?? g.address).trim(), destination: (patch.destination ?? g.destination).trim(), hidden: g.hidden,
      ...(patch.code !== undefined ? { code: patch.code.trim().toUpperCase() } : {}),
    };
    await this.push(p, shopId, [{ table: 'buyers', txn: uuidv7(), row }]);
    return { id: g.id, name: row.name as string, phone: row.phone as string };
  }

  private buyerRow(id: string, b: GrahakInput, now: string) {
    return {
      id, created_at: now, updated_at: now, name: b.name.trim(), phone: (b.phone ?? '').trim(), kind: '', credit_limit_paise: 0,
      vehicle: (b.vehicle ?? '').toUpperCase().replace(/\s+/g, ''), address: (b.address ?? '').trim(), destination: (b.destination ?? '').trim(),
      code: (b.code ?? '').trim().toUpperCase(),
    }
  }

  // ---------------------------------------------------------------- Aaj ka bhav

  /** The rate sheet for a day: every maal × grade 1-3, its bhav that day and the last bhav before it. */
  async bhav(shopId: string, date?: string) {
    const d = date ?? todayIst();
    return this.db.withShop(shopId, async (tx) => {
      const brands = (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM brands WHERE hidden = false ORDER BY sort_order, name`)).rows;
      const today = (await tx.query<{ brand_id: string; grade: string; rate: string }>(
        `SELECT brand_id, grade, rate_paise AS rate FROM rates WHERE business_date = $1`, [d])).rows;
      const before = (await tx.query<{ brand_id: string; grade: string; rate: string; day: string }>(
        `SELECT DISTINCT ON (brand_id, grade) brand_id, grade, rate_paise AS rate, business_date::text AS day FROM rates
         WHERE business_date < $1 ORDER BY brand_id, grade, business_date DESC`, [d])).rows;
      const at = (rows: { brand_id: string; grade: string; rate: string }[], b: string, g: string) => {
        const r = rows.find((x) => x.brand_id === b && x.grade === g);
        return r ? n(r.rate) : null;
      };
      return {
        date: d,
        brands: brands.map((b) => ({
          id: b.id, name: b.name,
          grades: (['1', '2', '3'] as const).map((g) => ({ grade: g, ratePaise: at(today, b.id, g), lastPaise: at(before, b.id, g) })),
        })),
      };
    });
  }

  /** Sets the day's bhav as a terminal's rate sheet does: one row per day × maal × grade, overwritten. */
  async setBhav(phone: string, shopId: string, input: { date?: string; rates: { brandId: string; grade: '1' | '2' | '3'; ratePaise: number }[] }) {
    const d = input.date ?? todayIst();
    const p = await this.device(phone, shopId);
    const existing = await this.db.withShop(shopId, async (tx) => (await tx.query<{ id: string; brand_id: string; grade: string; created_at: Date }>(
      `SELECT id, brand_id, grade, created_at FROM rates WHERE business_date = $1`, [d])).rows);
    const brands = new Set(await this.db.withShop(shopId, async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM brands`)).rows.map((b) => b.id)));
    const now = new Date().toISOString();
    const items: PushItem[] = input.rates.filter((r) => brands.has(r.brandId)).map((r) => {
      const old = existing.find((e) => e.brand_id === r.brandId && e.grade === r.grade);
      return { table: 'rates', txn: uuidv7(), row: {
        id: old?.id ?? uuidv7(), created_at: old ? old.created_at.toISOString() : now, updated_at: now,
        business_date: d, brand_id: r.brandId, grade: r.grade, rate_paise: r.ratePaise,
      } };
    });
    if (!items.length) throw new BadRequestException('Koi bhav nahi');
    await this.push(p, shopId, items);
    return { date: d, saved: items.length };
  }

  /**
   * A slip for the dispatch scanner: its QR carries the bill id, or the slip number is typed.
   * An edited slip keeps its number on a new bill, so an old QR is followed to the live one.
   */
  async pickupSlip(shopId: string, code: string) {
    return this.db.withShop(shopId, async (tx) => {
      const c = code.trim();
      const uuid = /^[0-9a-f-]{36}$/i.test(c);
      const slipNo = uuid
        ? (await tx.query<{ slip_no: number | null }>(`SELECT slip_no FROM bills WHERE id = $1`, [c])).rows[0]?.slip_no ?? null
        : /^\d{1,7}$/.test(c) ? Number(c) : null;
      const live = (await tx.query<{ id: string }>(
        `SELECT lb.id FROM (SELECT * FROM bills b WHERE NOT EXISTS (SELECT 1 FROM bill_voids v WHERE v.bill_id = b.id)) lb
         WHERE ${uuid ? '(lb.id::text = $1 OR (lb.slip_no IS NOT NULL AND lb.slip_no = $2))' : 'lb.slip_no = $2'}
         ORDER BY (lb.id::text = $1) DESC, lb.created_at DESC LIMIT 1`, [uuid ? c : '', slipNo])).rows[0];
      if (!live) throw new NotFoundException('Yeh parchi nahi mili');
      const head = (await tx.query<{ id: string; slip_no: number | null; buyer_name: string; business_date: string; picked: string }>(
        `SELECT id, slip_no, buyer_name, business_date::text, (SELECT COALESCE(SUM(qty), 0) FROM pickups p WHERE p.bill_id = b.id) AS picked
         FROM bills b WHERE id = $1`, [live.id])).rows[0];
      const lines = (await tx.query<{ quality: string | null; number: string | null; location: string | null; qty: string }>(
        `SELECT br.name AS quality, t.number, t.location, SUM(l.qty) AS qty FROM bill_lines l
         LEFT JOIN brands br ON br.id = l.brand_id LEFT JOIN trucks t ON t.id = l.truck_id
         WHERE l.bill_id = $1 GROUP BY br.name, t.number, t.location ORDER BY t.number, br.name`, [live.id])).rows;
      const boxes = lines.reduce((s, l) => s + Number(l.qty), 0), picked = Math.min(Number(head.picked), boxes);
      return { billId: head.id, slipNo: head.slip_no, buyer: head.buyer_name, date: head.business_date, boxes, picked, left: boxes - picked,
        lines: lines.map((l) => ({ quality: l.quality ?? '', gaadi: l.number ?? '', location: l.location ?? '', qty: Number(l.qty) })) };
    });
  }

  /** Boxes handed over at the gaadi against a slip, as the app's scanner records them. Never more than is left. */
  async pickup(phone: string, shopId: string, input: { billId: string; qty: number }) {
    const slip = await this.pickupSlip(shopId, input.billId);
    if (slip.billId !== input.billId) throw new BadRequestException('Parchi badal gayi hai, dobara scan karein');
    if (input.qty > slip.left) throw new BadRequestException(slip.left ? `Is parchi par sirf ${slip.left} box baaki` : 'Is parchi ka saara maal ja chuka hai');
    const p = await this.device(phone, shopId);
    await this.push(p, shopId, [{ table: 'pickups', txn: uuidv7(), row: { id: uuidv7(), created_at: new Date().toISOString(), bill_id: slip.billId, qty: input.qty } }]);
    return { ...slip, picked: slip.picked + input.qty, left: slip.left - input.qty };
  }

  private async device(phone: string, shopId: string): Promise<Principal> {
    const p = await this.accounts.webDevice(phone, shopId);
    await this.db.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [p.deviceId]);
    return p;
  }

  /** This device's next bill number in the financial year: CODE/FY/000001, continuing its own series. */
  private async billNumber(tx: Tx, deviceId: string): Promise<string> {
    const code = (await tx.query<{ code: string }>(`SELECT code FROM devices WHERE id = $1`, [deviceId])).rows[0].code;
    const prefix = `${code}/${fy()}/`;
    const last = (await tx.query<{ m: string | null }>(
      `SELECT MAX(substring(number FROM '([0-9]+)$')::int) AS m FROM bills WHERE number LIKE $1`, [`${prefix}%`])).rows[0].m;
    return `${prefix}${String(n(last) + 1).padStart(6, '0')}`;
  }

  /** Pushes like a terminal, wakes the shop's terminals, and refuses loudly if any row was refused. */
  private async push(p: Principal, shopId: string, items: PushItem[]): Promise<PushResult[]> {
    const results = await this.sync.push(p, shopId, items);
    if (results.some((r) => r.status === 'applied')) void this.hub.wake(shopId).catch(() => undefined);
    const bad = results.find((r) => r.status === 'rejected');
    if (bad) throw new UnprocessableEntityException(`Save nahi hua: ${bad.error}`);
    return results;
  }
}

type LiveBill = { id: string; slip_no: number | null; buyer_id: string | null; buyer_name: string; truck_id: string | null; pay_mode: string; paid_paise: string; cash_paise: string; upi_paise: string; day: string; created_at: Date };

/** A slip still on the books; a voided one can't be voided or edited again. */
async function liveBill(tx: Tx, billId: string): Promise<LiveBill> {
  const b = (await tx.query<LiveBill & { voided: boolean }>(
    `SELECT b.id, b.slip_no, b.buyer_id, b.buyer_name, b.truck_id, b.pay_mode, b.paid_paise, b.cash_paise, b.upi_paise,
            b.business_date::text AS day, b.created_at,
            EXISTS (SELECT 1 FROM bill_voids v WHERE v.bill_id = b.id) AS voided
     FROM bills b WHERE b.id = $1`, [billId])).rows[0];
  if (!b) throw new NotFoundException('Parchi nahi mili');
  if (b.voided) throw new ConflictException('Yeh parchi pehle hi hatayi ya badli ja chuki hai');
  return b;
}

/** A slip's cash and UPI; a row from before the split was kept reads it off its pay mode. */
function billMoney(b: LiveBill): [number, number] {
  const cash = n(b.cash_paise), upi = n(b.upi_paise), paid = n(b.paid_paise);
  if (cash + upi > 0 || paid === 0) return [cash, upi];
  return b.pay_mode === 'upi' || b.pay_mode === 'card' ? [0, paid] : [paid, 0];
}

/** Vasooli taken on one slip and still standing (Store.collectedOn): its rows, cash and UPI. */
async function collectedOn(tx: Tx, billId: string) {
  const rows = (await tx.query<{ id: string; receipt_no: number | null; cash: string; upi: string }>(
    `SELECT c.id, c.receipt_no, ${CASH_PART} AS cash, ${UPI_PART} AS upi FROM ${LIVE_COLS} c WHERE c.bill_id = $1`, [billId])).rows;
  return { rows, cash: rows.reduce((s, r) => s + n(r.cash), 0), upi: rows.reduce((s, r) => s + n(r.upi), 0) };
}

type PaymentRow = { id: string; buyer_id: string; created_at: Date; day: string; bill_id: string | null; slip_no: number | null; receipt_no: number | null;
  amount_paise: string; cash: string; upi: string; payment_ref: string; upi_bank: string; device_id: string; voided: boolean };

/**
 * The rows one payment wrote (same grahak, same moment), its own first. [live]: refuse a raseed
 * already cancelled, and leave out rows of it cancelled before.
 */
async function paymentRows(tx: Tx, collectionId: string, live = false) {
  const rows = (await tx.query<PaymentRow>(
    `SELECT c.id, c.buyer_id, c.created_at, c.business_date::text AS day, c.bill_id, b.slip_no, c.receipt_no, c.amount_paise,
            ${CASH_PART.replace(/\b(cash_paise|upi_paise|pay_mode|amount_paise)\b/g, 'c.$1')} AS cash,
            ${UPI_PART.replace(/\b(cash_paise|upi_paise|pay_mode|amount_paise)\b/g, 'c.$1')} AS upi,
            c.payment_ref, c.upi_bank, c.device_id, EXISTS (SELECT 1 FROM collection_voids v WHERE v.collection_id = c.id) AS voided
     FROM collections c JOIN collections o ON o.id = $1 AND o.buyer_id = c.buyer_id AND o.created_at = c.created_at
     LEFT JOIN bills b ON b.id = c.bill_id
     ORDER BY (c.id = $1) DESC, c.receipt_no NULLS LAST, c.id`, [collectionId])).rows;
  if (!rows.length) throw new NotFoundException('Raseed nahi mili');
  if (live && rows[0].voided) throw new ConflictException('Yeh raseed pehle hi hatayi ya badli ja chuki hai');
  const kept = live ? rows.filter((r) => !r.voided) : rows;
  // The raseed number the printed copy carries: the highest of its rows (Store.pastCollections).
  const nos = rows.map((r) => r.receipt_no).filter((x): x is number => x != null);
  return { rows: kept, receiptNo: nos.length ? Math.max(...nos) : null };
}

type Due = { billId: string | null; at: number; qty: number; openPaise: number; unpriced: boolean };

/**
 * A grahak's open dues as Store.openDues works them out — leaving out the payment rows in
 * [without], as duesIfVoided does. Money not on a live slip (no slip, or a slip since voided)
 * and jama entries settle purana udhaar first, then the oldest slips.
 */
async function openDues(tx: Tx, buyerId: string, without: string[]): Promise<Due[]> {
  const cols = `(SELECT * FROM ${LIVE_COLS} lc WHERE NOT (lc.id = ANY($2::uuid[])))`;
  const slips = (await tx.query<{ id: string; at: Date; qty: string; open: string }>(
    `SELECT b.id, b.created_at AS at, (SELECT COALESCE(SUM(qty), 0) FROM bill_lines l WHERE l.bill_id = b.id) AS qty,
            b.total_paise - b.paid_paise - COALESCE((SELECT SUM(c.amount_paise) FROM ${cols} c WHERE c.bill_id = b.id), 0) AS open
     FROM ${LIVE_BILLS} b WHERE b.buyer_id = $1 AND b.total_paise > b.paid_paise`, [buyerId, without])).rows;
  const unpriced = (await tx.query<{ id: string; at: Date; qty: string }>(
    `SELECT b.id, b.created_at AS at, (SELECT COALESCE(SUM(qty), 0) FROM bill_lines l WHERE l.bill_id = b.id) AS qty
     FROM ${LIVE_BILLS} b WHERE b.buyer_id = $1 AND b.total_paise = 0 AND b.pay_mode IN ('credit', 'after')
       AND NOT EXISTS (SELECT 1 FROM ${cols} c WHERE c.bill_id = b.id)`, [buyerId, without])).rows;
  const entries = (await tx.query<{ at: Date; amount: string }>(
    `SELECT created_at AS at, amount_paise AS amount FROM udhaar_entries WHERE buyer_id = $1`, [buyerId])).rows;
  const loose = n((await tx.query<{ s: string }>(
    `SELECT COALESCE(SUM(c.amount_paise), 0) AS s FROM ${cols} c
     WHERE c.buyer_id = $1 AND (c.bill_id IS NULL OR NOT EXISTS (SELECT 1 FROM ${LIVE_BILLS} lb WHERE lb.id = c.bill_id))`, [buyerId, without])).rows[0].s);
  let pool = loose + entries.filter((e) => n(e.amount) < 0).reduce((s, e) => s - n(e.amount), 0);
  const dues: Due[] = [
    ...entries.filter((e) => n(e.amount) > 0).map((e) => ({ billId: null, at: e.at.getTime(), qty: 0, openPaise: n(e.amount), unpriced: false })),
    ...slips.map((b) => ({ billId: b.id, at: b.at.getTime(), qty: n(b.qty), openPaise: n(b.open), unpriced: false })),
  ].sort((a, b) => Number(a.billId !== null) - Number(b.billId !== null) || a.at - b.at);
  const settled = dues.map((d) => {
    const off = Math.min(pool, Math.max(0, d.openPaise));
    pool -= off;
    return { ...d, openPaise: d.openPaise - off };
  });
  return [...settled.filter((d) => d.openPaise > 0), ...unpriced.map((b) => ({ billId: b.id, at: b.at.getTime(), qty: n(b.qty), openPaise: 0, unpriced: true }))];
}

/** The shop's bank account as the app labels it on a UPI payment: "ICICI ··4521". */
function bankLabel(b: { bank?: string; account?: string }): string {
  const last = (b.account ?? '').replace(/\s+/g, '').slice(-4);
  return [b.bank?.trim(), last && `··${last}`].filter(Boolean).join(' ');
}

/** The shop's next slip or raseed number: one past the highest held, voids included (Store.nextSlipNo). */
async function nextNumber(tx: Tx, table: 'bills' | 'collections', col: string, voids: string): Promise<number> {
  const r = (await tx.query<{ m: string | null }>(
    `SELECT GREATEST((SELECT MAX(${col}) FROM ${table}), (SELECT MAX(${col}) FROM ${voids})) AS m`)).rows[0];
  return n(r.m) + 1;
}
