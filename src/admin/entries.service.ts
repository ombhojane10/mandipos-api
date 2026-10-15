import { BadRequestException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { AccountsService } from '../auth/accounts.service';
import { Principal } from '../auth/tokens.service';
import { uuidv7 } from '../common/uuid';
import { Db, Tx } from '../db/db.service';
import { SyncHub } from '../sync/sync.hub';
import { PushItem, PushResult, SyncService } from '../sync/sync.service';
import { LIVE_BILLS, n } from './sql';
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
  buyerId?: string; buyerName?: string; truckId: string;
  lines: { grade: Grade; qty: number; ratePaise: number }[];
  pay: 'cash' | 'upi' | 'credit' | 'after' | 'split' | 'free'; cashPaise?: number; upiPaise?: number; upiBank?: string;
  packing: 'loose' | 'katta10' | 'katta15' | 'katta20' | 'katta25' | 'panni'; panniName?: string;
};
export type VasooliInput = { buyerId: string; cashPaise: number; upiPaise: number; upiBank?: string; paymentRef?: string };
export type DaybookInput = { direction: 'in' | 'out'; category: string; mode: 'cash' | 'office' | 'upi' | 'bank'; amountPaise: number; party?: string; note?: string; date?: string };
export type UdhaarInput = { buyerId: string; amountPaise: number; note?: string; date?: string };
export type GrahakInput = { name: string; phone?: string; address?: string; destination?: string; code?: string; vehicle?: string; openingPaise?: number };
export type GaadiInput = { number: string; supplier: string; freightPaise?: number; lots: { brandId?: string; brandName?: string; grade: Grade; qty: number; ratePaise: number }[] };
export type SupplierPaymentInput = { supplier: string; mode: 'cash' | 'office' | 'upi' | 'bank'; amountPaise: number; note?: string; date?: string };

@Injectable()
export class EntriesService {
  constructor(
    private readonly db: Db, private readonly sync: SyncService, private readonly hub: SyncHub, private readonly accounts: AccountsService,
  ) {}

  /** What the entry forms need: open gaadis and their maal, today's bhav, maal list, suppliers, bank accounts. */
  async options(shopId: string) {
    return this.db.withShop(shopId, async (tx) => {
      const shop = (await tx.query<{ commodity: string; bank_accounts: { bank: string; account: string }[] }>(
        `SELECT commodity, bank_accounts FROM shops WHERE id = $1`, [shopId])).rows[0];
      const trucks = (await tx.query<{ id: string; number: string; supplier: string; arrived_at: Date; lots: { brand_id: string; brand: string; grade: string; qty: number }[] | null; recv: string; sold: string; spoiled: string }>(
        `SELECT t.id, t.number, t.supplier, t.arrived_at,
                (SELECT json_agg(json_build_object('brand_id', g.brand_id, 'brand', br.name, 'grade', g.grade, 'qty', g.billed_qty + g.free_qty) ORDER BY g.created_at)
                   FROM truck_grades g LEFT JOIN brands br ON br.id = g.brand_id WHERE g.truck_id = t.id) AS lots,
                (SELECT COALESCE(SUM(billed_qty + free_qty), 0) FROM truck_grades g WHERE g.truck_id = t.id)
                  - (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind = 'correction') AS recv,
                (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE l.truck_id = t.id) AS sold,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind = 'spoiled') AS spoiled
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
      return {
        commodity: shop.commodity,
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
    const p = await this.device(phone, shopId);
    const lines = input.lines.filter((l) => l.qty > 0);
    if (!lines.length) throw new BadRequestException('Kam se kam ek line daalein');
    const now = new Date().toISOString();
    const free = input.pay === 'free';

    const pre = await this.db.withShop(shopId, async (tx) => {
      const shop = (await tx.query<{ commodity: string }>(`SELECT commodity FROM shops WHERE id = $1`, [shopId])).rows[0];
      if (shop.commodity === 'amrud') throw new UnprocessableEntityException('Amrud ki parchi app se banayein');
      const truck = (await tx.query<{ id: string; recv: string; sold: string; spoiled: string }>(
        `SELECT t.id,
                (SELECT COALESCE(SUM(billed_qty + free_qty), 0) FROM truck_grades g WHERE g.truck_id = t.id)
                  - (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind = 'correction') AS recv,
                (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE l.truck_id = t.id) AS sold,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind = 'spoiled') AS spoiled
         FROM trucks t WHERE t.id = $1 AND t.closed_at IS NULL`, [input.truckId])).rows[0];
      if (!truck) throw new BadRequestException('Yeh gaadi khuli nahi hai');
      const left = n(truck.recv) - n(truck.sold) - n(truck.spoiled);
      const qty = lines.reduce((s, l) => s + l.qty, 0);
      if (qty > left) throw new UnprocessableEntityException(`Gaadi mein sirf ${left} nag baaki hain`);
      const brand = (await tx.query<{ brand_id: string }>(
        `SELECT brand_id FROM truck_grades WHERE truck_id = $1 GROUP BY brand_id ORDER BY SUM(billed_qty + free_qty) DESC LIMIT 1`, [input.truckId])).rows[0];
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
    const billId = uuidv7();
    const txn = uuidv7();
    items.push({
      table: 'bills', txn, row: {
        id: billId, created_at: now, number: pre.number, kind: 'kachchi', buyer_id: buyerId, buyer_name: buyerName,
        business_date: todayIst(), pay_mode: payMode, total_paise: goods, paid_paise: cash + upi, cash_paise: cash, upi_paise: upi,
        payment_ref: '', slip_no: pre.slipNo, truck_id: input.truckId, labour_paise: packed ? pre.qty * LABOUR_PAISE_PER_NAG : 0,
        packing: input.packing, panni_name: input.packing === 'panni' ? (input.panniName ?? '') : '', packs: packed ? pre.qty : 0,
        delivery: false, staff_name: 'Website', chungi_paise: 0, upi_bank: upi > 0 ? (input.upiBank ?? '') : '',
      },
    });
    for (const l of lines) {
      items.push({ table: 'bill_lines', txn, row: {
        id: uuidv7(), created_at: now, bill_id: billId, truck_id: input.truckId, brand_id: pre.brandId, grade: l.grade, qty: l.qty,
        rate_paise: free ? 0 : l.ratePaise, leak: false,
      } });
    }
    const results = await this.push(p, shopId, items);
    const bill = results.find((r) => r.id === billId)!;
    return { billId, number: pre.number, slipNo: bill.renumbered?.to ?? pre.slipNo, buyerId, results };
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
      if (shop.commodity === 'amrud') throw new UnprocessableEntityException('Amrud ki party app se jodein');
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
    } });
    lots.forEach((l, i) => items.push({ table: 'truck_grades', txn, row: {
      id: uuidv7(), created_at: now, truck_id: truckId, brand_id: brandIds[i], grade: l.grade,
      billed_qty: l.qty, free_qty: 0, received_qty: l.qty, rate_paise: l.ratePaise,
    } }));
    const results = await this.push(p, shopId, items);
    return { truckId, results };
  }

  // ---------------------------------------------------------------- plumbing

  private buyerRow(id: string, b: GrahakInput, now: string) {
    return {
      id, created_at: now, updated_at: now, name: b.name.trim(), phone: (b.phone ?? '').trim(), kind: '', credit_limit_paise: 0,
      vehicle: (b.vehicle ?? '').toUpperCase().replace(/\s+/g, ''), address: (b.address ?? '').trim(), destination: (b.destination ?? '').trim(),
      code: (b.code ?? '').trim().toUpperCase(),
    }
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
