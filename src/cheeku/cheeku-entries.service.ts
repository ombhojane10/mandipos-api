import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Principal } from '../auth/tokens.service';
import { uuidv7 } from '../common/uuid';
import { Db, Tx } from '../db/db.service';
import { PrintService } from '../print/print.service';
import { PushItem } from '../sync/sync.service';
import { LIVE_BILLS, STORE_BACK, n } from '../admin/sql';
import { nameKey } from '../admin/reports.service';
import {
  EntriesService, billMoney, nextNumber, payModeCode, todayIst,
  type GaadiInput, type LiveBill, type ParchiInput,
} from '../admin/entries.service';
import { CHEEKU_CAPS_NAMES, requireCheeku, requireCheekuTx } from './cheeku';

/**
 * Cheeku's website entries: its own copy of every grapes entry (the lot-wise parchi, Nayi gaadi
 * and its edit, the gaadi scanner's pickups and broken boxes, the labour page). The shared
 * EntriesService sends a cheeku shop here and lends only its plumbing — the website's device,
 * the bill number, pushing rows like a terminal — never grape logic.
 */
@Injectable()
export class CheekuEntriesService {
  constructor(private readonly db: Db, private readonly print: PrintService, private readonly modules: ModuleRef) {}

  /** The shared plumbing, looked up when first used (EntriesService also sends cheeku shops here). */
  private get e(): EntriesService {
    return this.modules.get(EntriesService, { strict: false });
  }

  /**
   * What the cheeku entry forms add to entry-options: every quality on every open gaadi (sold past
   * its count included — cheeku never refuses a sale), and each supplier's last gaadi for Nayi
   * gaadi's smart defaults.
   */
  async options(tx: Tx, apmcOn: boolean) {
      const lots = (await tx.query<{ truck_id: string; number: string; supplier: string; location: string; brand_id: string; quality: string; recv: string; sold: string; off: string; grams: number; cost: string }>(
        `SELECT t.id AS truck_id, t.number, t.supplier, t.location, g.brand_id, COALESCE(br.name, '?') AS quality,
                SUM(g.billed_qty + g.free_qty) AS recv, MAX(g.box_grams) AS grams, MAX(g.rate_paise) AS cost,
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
        apmcOn: apmcOn,
        lots: lots.map((l) => ({ truckId: l.truck_id, number: l.number, supplier: l.supplier, location: l.location, brandId: l.brand_id,
          quality: l.quality, left: n(l.recv) - n(l.sold) - n(l.off), boxGrams: l.grams ?? 0, costPaise: n(l.cost) })),
        lastArrivals: [...lastBySupplier.values()].map((v) => ({ supplier: v.supplier, location: v.location,
          lots: lastLots.filter((l) => l.truck_id === v.truckId).map((l) => ({ quality: l.quality, boxGrams: l.grams ?? 0, ratePaise: n(l.rate) })) })),
      };
  }

  /**
   * Cheeku's parchi (its own copy of the grapes one), as the app writes it (Store.saveParchi): each line one quality off one
   * gaadi, several gaadis on a slip, no count limit. The grahak pays the goods plus 1% APMC
   * (when the shop has it on) plus, on any slip but a Free one with labour ticked, boxes × the labour
   * rate. chungi_paise holds APMC + labour, apmc_paise the APMC, labour_paise the labour.
   */
  async writeParchi(p: Principal, shopId: string, input: ParchiInput, editing: LiveBill | null) {
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
      return { apmcOn: shop.apmc_on, slipNo: await nextNumber(tx, 'bills', 'slip_no', 'bill_voids'), number: await this.e.billNumber(tx, p.deviceId) };
    });

    const items: PushItem[] = [];
    let buyerId = input.buyerId ?? null;
    let buyerName = (input.buyerName ?? '').trim();
    const walkIn = /^(cash|bank|free)$/i.test(buyerName) || (!buyerId && !buyerName);
    if (!buyerId && buyerName && !walkIn) {
      buyerId = uuidv7();
      if (CHEEKU_CAPS_NAMES) buyerName = buyerName.toUpperCase();
      items.push({ table: 'buyers', row: this.e.buyerRow(buyerId, { name: buyerName, phone: input.buyerPhone || '' }, now), txn: uuidv7() });
    }
    if (buyerId && !input.buyerName) buyerName = (await this.db.withShop(shopId, async (tx) => (await tx.query<{ name: string }>(`SELECT name FROM buyers WHERE id = $1`, [buyerId])).rows[0]?.name)) ?? '';
    if (free) { buyerId = null; buyerName = 'Free'; }
    if (!buyerId && !buyerName) buyerName = 'Cash';

    const boxes = lots.reduce((s, l) => s + l.qty, 0);
    const goods = free ? 0 : lots.reduce((s, l) => s + l.qty * l.ratePaise, 0);
    // This slip's own switch when the form sent one, else the shop's setting.
    const apmc = (input.apmc ?? pre.apmcOn) ? Math.round(goods * 0.01) : 0;
    // Labour for any grahak who is charged it — Cash, UPI or Udhaar — never on a Free slip.
    const labour = !free && input.labour ? boxes * (input.labourRatePaise ?? 1000) : 0;
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
    const results = await this.e.push(p, shopId, items);
    const bill = results.find((r) => r.id === billId)!;
    const no = bill.renumbered?.to ?? slipNo;
    const printing = !editing && await this.print.queueBill(p, billId, `Order Parchi #${no}`).then(() => true, () => false);
    // Said on the page: a website slip waits in the queue while no print machine is on.
    const printOnline = printing && !!(await this.print.stationOf(shopId).catch(() => null))?.online;
    return { billId, number: pre.number, slipNo: no, buyerId, replaced: editing?.id ?? null, printing, printOnline, results };
  }

  // ---------------------------------------------------------------- Nayi gaadi

  async gaadi(phone: string, shopId: string, input: GaadiInput) {
    const lots = input.lots.filter((l) => l.qty > 0);
    if (!lots.length) throw new BadRequestException('Kam se kam ek maal ka dana daalein');
    const number = input.number.toUpperCase().replace(/\s+/g, '');
    if (!number) throw new BadRequestException('Gaadi number daalein');
    const p = await this.e.device(phone, shopId);
    const now = new Date().toISOString();
    const { supplier, brandIds } = await this.db.withShop(shopId, async (tx) => {
      await requireCheekuTx(tx, shopId);
      if (!input.supplier.trim()) throw new BadRequestException('Supplier ka naam daalein');
      const known = (await tx.query<{ s: string }>(`SELECT TRIM(supplier) AS s FROM trucks WHERE TRIM(supplier) <> '' ORDER BY arrived_at DESC`)).rows
        .find((r) => nameKey(r.s) === nameKey(input.supplier))?.s;
      const brands = (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM brands`)).rows;
      const ids = lots.map((l) => l.brandId ?? brands.find((b) => nameKey(b.name) === nameKey(l.brandName ?? ''))?.id ?? null);
      return { supplier: known ?? input.supplier.trim().toUpperCase(), brandIds: ids };
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
      // Where the gaadi stands, printed on every slip off it.
      ...(input.location?.trim() ? { location: input.location.trim().slice(0, 80) } : {}),
    } });
    lots.forEach((l, i) => items.push({ table: 'truck_grades', txn, row: {
      id: uuidv7(), created_at: now, truck_id: truckId, brand_id: brandIds[i], grade: l.grade,
      billed_qty: l.qty, free_qty: 0, received_qty: l.qty, rate_paise: l.ratePaise, box_grams: l.boxGrams ?? 0,
    } }));
    const results = await this.e.push(p, shopId, items);
    return { truckId, results };
  }

  // ---------------------------------------------------------------- broken boxes

  /** Broken-box requests, newest first, each with its slip as it stands now (a slip changed since is followed by its number). */
  async breakages(shopId: string, status: 'pending' | 'all') {
    await requireCheeku(this.db, shopId);
    return this.db.withShop(shopId, async (tx) => {
      const rows = (await tx.query<{ id: string; bill_id: string; slip_no: number | null; brand_id: string | null; truck_id: string | null; qty: number; note: string; reported_by: string; status: string; rate_paise: string; resolved_by: string; created_at: Date; updated_at: Date; quality: string | null; gaadi: string | null; reporter: string | null }>(
        `SELECT k.*, br.name AS quality, t.number AS gaadi, u.name AS reporter FROM breakages k
         LEFT JOIN brands br ON br.id = k.brand_id LEFT JOIN trucks t ON t.id = k.truck_id LEFT JOIN users u ON u.id = k.created_by
         WHERE ${status === 'pending' ? `k.status = 'pending'` : 'true'} ORDER BY k.created_at DESC LIMIT 200`)).rows;
      const out = [];
      for (const r of rows) {
        const bill = await this.currentBill(tx, r.bill_id, r.slip_no);
        const line = bill ? (await tx.query<{ qty: string; rate: string }>(
          `SELECT SUM(qty) AS qty, MAX(rate_paise) AS rate FROM bill_lines WHERE bill_id = $1 AND brand_id IS NOT DISTINCT FROM $2 AND ($3::uuid IS NULL OR truck_id = $3)`,
          [bill.id, r.brand_id, r.truck_id])).rows[0] : null;
        out.push({
          id: r.id, status: r.status, qty: r.qty, note: r.note, reportedBy: /^\d{10}$/.test(r.reported_by) && r.reporter ? r.reporter : r.reported_by, at: r.created_at.toISOString(),
          quality: r.quality ?? '', gaadi: r.gaadi ?? '', ratePaise: n(r.rate_paise), resolvedBy: r.resolved_by, resolvedAt: r.status === 'pending' ? null : r.updated_at.toISOString(),
          bill: bill ? {
            id: bill.id, slipNo: bill.slip_no, buyer: bill.buyer_name, buyerId: bill.buyer_id, payMode: bill.pay_mode,
            totalPaise: n(bill.total_paise), paidPaise: n(bill.paid_paise), apmcPaise: n(bill.apmc_paise), lineQty: n(line?.qty), lineRatePaise: n(line?.rate),
          } : null,
        });
      }
      return { breakages: out };
    });
  }

  /** The slip a request was raised on, or the one that replaced it under the same number. */
  private async currentBill(tx: Tx, billId: string, slipNo: number | null) {
    const live = `SELECT b.id, b.slip_no, b.buyer_id, b.buyer_name, b.pay_mode, b.total_paise, b.paid_paise, b.cash_paise, b.upi_paise, b.labour_paise, b.apmc_paise,
                         b.upi_bank, b.staff_name, b.truck_id, b.business_date::text AS day, b.created_at
                  FROM bills b WHERE NOT EXISTS (SELECT 1 FROM bill_voids v WHERE v.bill_id = b.id)`;
    type Row = LiveBill & { total_paise: string; labour_paise: string; apmc_paise: string; upi_bank: string; staff_name: string };
    return (await tx.query<Row>(`${live} AND b.id = $1`, [billId])).rows[0]
      ?? (slipNo ? (await tx.query<Row>(`${live} AND b.slip_no = $1 ORDER BY b.created_at DESC LIMIT 1`, [slipNo])).rows[0] : undefined);
  }

  /**
   * The accountant settles a broken-box request: those boxes are written at [ratePaise] (a line
   * of their own, the rest of the slip as it was), the slip is rewritten under its own number
   * (the old one voided 'edited', its dispatch scans carried over), and money already paid
   * beyond the new total goes back — cash from the galla (UPI as cash, as a refund is done) — or
   * stays as the grahak's jama. The request is marked done, and the new slip printed.
   */
  async resolveBreakage(phone: string, shopId: string, id: string, input: { ratePaise: number; giveBack?: 'cash' | 'advance' }) {
    await requireCheeku(this.db, shopId);
    const p = await this.e.device(phone, shopId);
    const pre = await this.db.withShop(shopId, async (tx) => {
      const brk = (await tx.query<{ id: string; bill_id: string; slip_no: number | null; brand_id: string | null; truck_id: string | null; qty: number; note: string; reported_by: string; status: string; created_at: Date }>(
        `SELECT * FROM breakages WHERE id = $1`, [id])).rows[0];
      if (!brk) throw new NotFoundException('Request nahi mili');
      if (brk.status !== 'pending') throw new ConflictException('Yeh request pehle hi nipat chuki hai');
      const bill = await this.currentBill(tx, brk.bill_id, brk.slip_no);
      if (!bill) throw new ConflictException('Yeh parchi ab nahi hai');
      const lines = (await tx.query<{ truck_id: string; brand_id: string; qty: number; rate_paise: string }>(
        `SELECT truck_id, brand_id, qty, rate_paise FROM bill_lines WHERE bill_id = $1 ORDER BY created_at`, [bill.id])).rows;
      const pickups = (await tx.query<{ qty: number; note: string; created_at: Date }>(`SELECT qty, note, created_at FROM pickups WHERE bill_id = $1`, [bill.id])).rows;
      return { brk, bill, lines, pickups };
    });
    const { brk, bill, lines, pickups } = pre;
    // The broken boxes become a line of their own at the new bhav.
    let left = brk.qty;
    const lots: { truckId: string; brandId: string; qty: number; ratePaise: number }[] = [];
    for (const l of lines) {
      const hit = left > 0 && l.brand_id === brk.brand_id && (!brk.truck_id || l.truck_id === brk.truck_id);
      const k = hit ? Math.min(l.qty, left) : 0;
      if (l.qty - k > 0) lots.push({ truckId: l.truck_id, brandId: l.brand_id, qty: l.qty - k, ratePaise: n(l.rate_paise) });
      if (k > 0) { lots.push({ truckId: l.truck_id, brandId: l.brand_id, qty: k, ratePaise: input.ratePaise }); left -= k; }
    }
    if (left > 0) throw new BadRequestException(`Parchi par ${brk.qty} box is quality ke nahi hain`);
    const goods = lots.reduce((s, l) => s + l.qty * l.ratePaise, 0);
    const apmc = n(bill.apmc_paise) > 0 ? Math.round(goods * 0.01) : 0;
    const labour = n(bill.labour_paise);
    const boxes = lots.reduce((s, l) => s + l.qty, 0);
    const total = bill.pay_mode === 'free' ? 0 : goods + apmc + labour;
    const [cash, upi] = billMoney(bill);
    const excess = Math.max(0, cash + upi - total);
    const cashBack = Math.min(cash, excess), upiBack = excess - cashBack;
    if (excess > 0 && input.giveBack === 'advance' && !bill.buyer_id) throw new BadRequestException('Cash grahak ka khata nahi — paisa wapas chunein');
    if (excess > 0 && !input.giveBack) throw new BadRequestException('Bache paise: wapas dein ya khate mein jama — chunein');
    const pay: ParchiInput['pay'] = bill.pay_mode === 'free' ? 'free' : cash + upi - excess > 0 ? 'split' : bill.pay_mode === 'after' ? 'after' : 'credit';
    const r = await this.writeParchi(p, shopId, {
      buyerId: bill.buyer_id ?? undefined, buyerName: bill.buyer_id ? undefined : bill.buyer_name, lots, pay,
      cashPaise: cash - cashBack, upiPaise: upi - upiBack, upiBank: bill.upi_bank || undefined, packing: 'loose',
      labour: labour > 0, labourRatePaise: labour > 0 && boxes ? Math.round(labour / boxes) : undefined, staff: bill.staff_name,
      apmc: n(bill.apmc_paise) > 0, // the slip keeps its own APMC choice, whatever the shop setting is now
    }, bill);
    const now = new Date().toISOString();
    const items: PushItem[] = pickups.map((k) => ({ table: 'pickups', txn: uuidv7(), row: { id: uuidv7(), created_at: k.created_at.toISOString(), bill_id: r.billId, qty: k.qty, note: k.note } }));
    items.push({ table: 'breakages', txn: uuidv7(), row: {
      id: brk.id, created_at: brk.created_at.toISOString(), updated_at: now, bill_id: brk.bill_id, slip_no: brk.slip_no, brand_id: brk.brand_id, truck_id: brk.truck_id,
      qty: brk.qty, note: brk.note, reported_by: brk.reported_by, status: 'done', rate_paise: input.ratePaise, resolved_bill_id: r.billId, resolved_by: 'Website',
    } });
    await this.e.push(p, shopId, items);
    if (excess > 0 && input.giveBack === 'advance') await this.e.vasooli(phone, shopId, { buyerId: bill.buyer_id!, cashPaise: cashBack, upiPaise: upiBack });
    if (excess > 0 && input.giveBack === 'cash' && upiBack > 0) {
      const slip = `Parchi #${r.slipNo}`, party = bill.buyer_id ? bill.buyer_name : '';
      await this.e.dayRow(p, shopId, { direction: 'in', category: 'aur_aaya', mode: 'upi', amountPaise: upiBack, party, note: `${slip} toote box · UPI aaya tha` });
      await this.e.dayRow(p, shopId, { direction: 'out', category: 'aur_gaya', mode: 'cash', amountPaise: upiBack, party, note: `${slip} toote box · cash wapas` });
    }
    const printing = await this.print.queueBill(p, r.billId, `Badli Parchi #${r.slipNo}`).then(() => true, () => false);
    return { billId: r.billId, slipNo: r.slipNo, totalPaise: total, backPaise: excess, printing };
  }

  /** The accountant turns a broken-box request down: it stays on the books as rejected. */
  async rejectBreakage(phone: string, shopId: string, id: string) {
    await requireCheeku(this.db, shopId);
    const p = await this.e.device(phone, shopId);
    const brk = await this.db.withShop(shopId, async (tx) => (await tx.query<Record<string, unknown> & { status: string; created_at: Date }>(`SELECT * FROM breakages WHERE id = $1`, [id])).rows[0]);
    if (!brk) throw new NotFoundException('Request nahi mili');
    if (brk.status !== 'pending') throw new ConflictException('Yeh request pehle hi nipat chuki hai');
    await this.e.push(p, shopId, [{ table: 'breakages', txn: uuidv7(), row: {
      id: brk.id, created_at: brk.created_at.toISOString(), updated_at: new Date().toISOString(), bill_id: brk.bill_id, slip_no: brk.slip_no, brand_id: brk.brand_id, truck_id: brk.truck_id,
      qty: brk.qty, note: brk.note, reported_by: brk.reported_by, status: 'rejected', rate_paise: 0, resolved_bill_id: null, resolved_by: 'Website',
    } }]);
    return { ok: true };
  }

  /**
   * A cheeku gaadi changed after it came, as the app's Gaadi screen does: number, supplier, where
   * it stands and bhada on the gaadi itself; a quality's boxes by the difference — more boxes as
   * another lot line at its own bhav and kg, fewer as a correction — and a new quality as a new lot.
   */
  async editGaadi(phone: string, shopId: string, truckId: string, input: GaadiInput) {
    await requireCheeku(this.db, shopId);
    const number = input.number.toUpperCase().replace(/\s+/g, '');
    if (!number) throw new BadRequestException('Gaadi number daalein');
    if (!input.supplier.trim()) throw new BadRequestException('Supplier ka naam daalein');
    const p = await this.e.device(phone, shopId);
    const now = new Date().toISOString();
    const { truck, have, brands } = await this.db.withShop(shopId, async (tx) => {
      const truck = (await tx.query<{ id: string; created_at: Date; arrived_at: Date; labour_paise: string; commission_paise: string; closed_at: Date | null }>(
        `SELECT id, created_at, arrived_at, labour_paise, commission_paise, closed_at FROM trucks WHERE id = $1`, [truckId])).rows[0];
      if (!truck) throw new NotFoundException('Gaadi nahi mili');
      const have = (await tx.query<{ brand_id: string; qty: string; rate: string; box_grams: number }>(
        `SELECT g.brand_id, SUM(g.received_qty) - COALESCE((SELECT SUM(qty) FROM spoilage s WHERE s.truck_id = $1 AND s.brand_id = g.brand_id AND s.kind = 'correction'), 0)
                  - ${STORE_BACK('$1', 'g.brand_id')} AS qty,
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
    await this.e.push(p, shopId, items);
    return { truckId, number };
  }

  /** Gaadi band karein (it leaves New slip and Gaadi kahan; its books stay) or wapas chalu karein. */
  async closeGaadi(phone: string, shopId: string, truckId: string, closed: boolean) {
    await requireCheeku(this.db, shopId);
    const p = await this.e.device(phone, shopId);
    const t = await this.db.withShop(shopId, async (tx) => (await tx.query<{ id: string; created_at: Date; number: string; supplier: string; arrived_at: Date; freight_paise: string; labour_paise: string; commission_paise: string; closed_at: Date | null; location: string }>(
      `SELECT id, created_at, number, supplier, arrived_at, freight_paise, labour_paise, commission_paise, closed_at, location FROM trucks WHERE id = $1`, [truckId])).rows[0]);
    if (!t) throw new NotFoundException('Gaadi nahi mili');
    if (!!t.closed_at === closed) return;
    const now = new Date().toISOString();
    await this.e.push(p, shopId, [{ table: 'trucks', txn: uuidv7(), row: {
      id: t.id, created_at: t.created_at.toISOString(), updated_at: now, number: t.number, supplier: t.supplier, arrived_at: t.arrived_at.toISOString(),
      freight_paise: n(t.freight_paise), labour_paise: n(t.labour_paise), commission_paise: n(t.commission_paise),
      closed_at: closed ? now : null, location: t.location,
    } }]);
  }

  /** Gaadi hatayein: gone from every machine, only while no slip, set-aside or beejak uses it (migration 074). */
  async deleteGaadi(phone: string, shopId: string, truckId: string) {
    await requireCheeku(this.db, shopId);
    const p = await this.e.device(phone, shopId);
    const r = await this.db.withShop(shopId, async (tx) =>
      (await tx.query<{ r: string }>(`SELECT cheeku_delete_truck($1, $2, $3) AS r`, [shopId, truckId, p.deviceId])).rows[0].r);
    if (r === 'not_found') throw new NotFoundException('Gaadi nahi mili');
    if (r === 'used') throw new ConflictException('Is gaadi ki parchi ya hisaab ban chuka hai, ise hataya nahi ja sakta. Ise band kar dein.');
    if (r !== 'deleted') throw new BadRequestException('Yeh dukaan cheeku ki nahi hai');
    return { deleted: true };
  }

  /** The gaadis closed in the last 60 days, newest first, with what came and what sold. */
  async closedGaadis(shopId: string) {
    await requireCheeku(this.db, shopId);
    return this.db.withShop(shopId, async (tx) => ({
      gaadis: (await tx.query<{ id: string; number: string; supplier: string; location: string; arrived: Date; closed: Date; received: string; sold: string; used: boolean }>(
        `SELECT t.id, t.number, TRIM(t.supplier) AS supplier, t.location, t.arrived_at AS arrived, t.closed_at AS closed,
                COALESCE((SELECT SUM(received_qty) FROM truck_grades g WHERE g.truck_id = t.id), 0)
                  - COALESCE((SELECT SUM(qty) FROM spoilage s WHERE s.truck_id = t.id AND s.kind = 'correction'), 0) AS received,
                (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE l.truck_id = t.id) AS sold,
                EXISTS (SELECT 1 FROM bill_lines l WHERE l.truck_id = t.id) OR EXISTS (SELECT 1 FROM spoilage s WHERE s.truck_id = t.id AND s.kind <> 'correction') AS used
         FROM trucks t WHERE t.closed_at > now() - interval '60 days' ORDER BY t.closed_at DESC LIMIT 200`)).rows
        .map((r) => ({ truckId: r.id, number: r.number, supplier: r.supplier, location: r.location, arrivedAt: r.arrived, closedAt: r.closed,
          received: n(r.received), sold: n(r.sold), used: r.used })),
    }));
  }

  // ---------------------------------------------------------------- the gaadi scanner and the labour page

  /**
   * A slip for the dispatch scanner: its QR carries the bill id, or the slip number is typed.
   * An edited slip keeps its number on a new bill, so an old QR is followed to the live one.
   */
  async pickupSlip(shopId: string, code: string) {
    await requireCheeku(this.db, shopId);
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
      const lines = (await tx.query<{ brand_id: string | null; truck_id: string | null; quality: string | null; number: string | null; location: string | null; qty: string }>(
        `SELECT l.brand_id, l.truck_id, br.name AS quality, t.number, t.location, SUM(l.qty) AS qty FROM bill_lines l
         LEFT JOIN brands br ON br.id = l.brand_id LEFT JOIN trucks t ON t.id = l.truck_id
         WHERE l.bill_id = $1 GROUP BY l.brand_id, l.truck_id, br.name, t.number, t.location ORDER BY t.number, br.name`, [live.id])).rows;
      const boxes = lines.reduce((s, l) => s + Number(l.qty), 0), picked = Math.min(Number(head.picked), boxes);
      return { billId: head.id, slipNo: head.slip_no, buyer: head.buyer_name, date: head.business_date, boxes, picked, left: boxes - picked,
        lines: lines.map((l) => ({ brandId: l.brand_id, truckId: l.truck_id, quality: l.quality ?? '', gaadi: l.number ?? '', location: l.location ?? '', qty: Number(l.qty) })) };
    });
  }

  /** Boxes handed over at the gaadi against a slip, as the app's scanner records them. Never more than is left. */
  async pickup(phone: string, shopId: string, input: { billId: string; qty: number }) {
    const slip = await this.pickupSlip(shopId, input.billId);
    if (slip.billId !== input.billId) throw new BadRequestException('Parchi badal gayi hai, dobara scan karein');
    if (input.qty > slip.left) throw new BadRequestException(slip.left ? `Is parchi par sirf ${slip.left} box baaki` : 'Is parchi ka saara maal ja chuka hai');
    const p = await this.e.device(phone, shopId);
    await this.e.push(p, shopId, [{ table: 'pickups', txn: uuidv7(), row: { id: uuidv7(), created_at: new Date().toISOString(), bill_id: slip.billId, qty: input.qty } }]);
    return { ...slip, picked: slip.picked + input.qty, left: slip.left - input.qty };
  }

  /** Broken boxes on a slip already handed over, for the accountant to write at a new bhav — as the app's scanner raises it. */
  async reportBreakage(phone: string, shopId: string, input: { billId: string; brandId: string | null; truckId: string | null; qty: number; note?: string }) {
    await requireCheeku(this.db, shopId);
    const slip = await this.pickupSlip(shopId, input.billId);
    if (slip.billId !== input.billId) throw new BadRequestException('Parchi badal gayi hai, dobara scan karein');
    if (slip.picked <= 0) throw new BadRequestException('Is parchi ka maal abhi diya nahi gaya');
    const line = slip.lines.find((l) => l.brandId === input.brandId && l.truckId === input.truckId);
    if (!line) throw new BadRequestException('Yeh quality is parchi par nahi hai');
    if (input.qty > line.qty) throw new BadRequestException(`${line.quality} sirf ${line.qty} box hai`);
    const p = await this.e.device(phone, shopId);
    const name = (await this.db.query<{ name: string | null }>(`SELECT name FROM users WHERE phone = $1`, [phone]))[0]?.name?.trim() || phone;
    const at = new Date().toISOString();
    await this.e.push(p, shopId, [{ table: 'breakages', txn: uuidv7(), row: {
      id: uuidv7(), created_at: at, updated_at: at, bill_id: slip.billId, slip_no: slip.slipNo, brand_id: input.brandId, truck_id: input.truckId,
      qty: input.qty, note: input.note ?? '', reported_by: name, status: 'pending', rate_paise: 0, resolved_bill_id: null, resolved_by: '' } }]);
    return { ok: true };
  }

  /** A labour login's page: boxes handed over today on live slips, and the broken boxes they reported. */
  async labourHome(phone: string, shopId: string) {
    await requireCheeku(this.db, shopId);
    return this.db.withShop(shopId, async (tx) => {
      const today = (await tx.query<{ n: string }>(
        `SELECT COALESCE(SUM(p.qty), 0) AS n FROM pickups p
         WHERE p.created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
           AND NOT EXISTS (SELECT 1 FROM bill_voids v WHERE v.bill_id = p.bill_id)`)).rows[0].n;
      const reports = (await tx.query<{ id: string; slip_no: number | null; qty: number; status: string; quality: string | null; created_at: Date }>(
        `SELECT k.id, k.slip_no, k.qty, k.status, br.name AS quality, k.created_at FROM breakages k
         LEFT JOIN brands br ON br.id = k.brand_id
         WHERE k.created_by = (SELECT id FROM users WHERE phone = $1) ORDER BY k.created_at DESC LIMIT 30`, [phone])).rows;
      return { today: Number(today), reports: reports.map((r) => ({ id: r.id, slipNo: r.slip_no, qty: r.qty, status: r.status, quality: r.quality ?? '', at: r.created_at.toISOString() })) };
    });
  }
}

