import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { uuidv7 } from '../common/uuid';
import { Db, Tx } from '../db/db.service';
import { EntriesService, type Grade } from './entries.service';
import { BUILTIN_HEADS } from './masters.service';
import { nameKey } from './reports.service';
import { LIVE_BILLS, n } from './sql';

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const isDay = (d?: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
const clip = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

/** Built-in Day Book heads a journal voucher may post to (kharcha and aamdani; not transfers, supplier or mazdoori). */
export const JV_BUILTIN = ['kharcha', 'bhada', 'kiraya', 'tankhwah', 'bill', 'aur_gaya', 'aur_aaya'];

export type JvAccount = { kind: 'grahak'; id: string } | { kind: 'supplier'; name: string } | { kind: 'head'; key: string };
export type JvInput = { day?: string; dr: JvAccount; cr: JvAccount; amountPaise: number; narration?: string };
export type CnReason = 'rate' | 'kharab' | 'wapsi' | 'discount' | 'other';
export type CnLine = { quality: string; grade?: string; boxes: number; ratePaise: number };
export type CnInput = { day?: string; buyerId: string; billId?: string | null; reason: CnReason; lines?: CnLine[]; amountPaise?: number; note?: string };
export type BikriRow = { buyerId?: string; buyerName?: string; truckId?: string; brandId?: string; grade?: Grade; qty: number; ratePaise: number; pay?: 'credit' | 'cash' | 'upi' };
export type BikriInput = { truckId?: string; labour?: boolean; labourRatePaise?: number; staff?: string; rows: BikriRow[] };

export const CN_REASONS: Record<CnReason, string> = { rate: 'Rate farq', kharab: 'Maal kharab', wapsi: 'Maal wapas', discount: 'Discount', other: 'Aur' };

type Side = { kind: 'grahak' | 'supplier' | 'head'; ref: string; name: string };
type JvRow = {
  id: string; no: number; day: string; dr_kind: Side['kind']; dr_ref: string; dr_name: string; cr_kind: Side['kind']; cr_ref: string; cr_name: string;
  amount_paise: string; narration: string; created_by: string; created_at: Date; updated_at: Date; voided_at: Date | null;
};
type CnRow = {
  id: string; no: number; day: string; buyer_id: string; name: string | null; bill_id: string | null; slip_no: number | null; reason: CnReason;
  lines: { quality: string; grade: string; boxes: number; ratePaise: number; amountPaise: number }[]; amount_paise: string; note: string;
  created_by: string; created_at: Date; updated_at: Date; voided_at: Date | null;
};

/**
 * The old software's vouchers on the website: Journal Voucher, Credit Note, and Bikri Entry (a
 * gaadi sold to many grahak at once).
 *
 * What a voucher does to a grahak is written as a synced udhaar entry (positive = udhaar, negative
 * = jama), pushed as the website's terminal, so the grahak's khata, the Outstanding and the app
 * all carry it; voucher_udhaar remembers which entries are the voucher's. Changing a voucher
 * writes only the difference per grahak and date (as an opening is changed), deleting it writes
 * the reversal — udhaar entries are never edited once synced. A supplier's side stays on the
 * website (no synced row moves a supplier without cash) and Supplier creditors, Supplier Khata
 * and the books read it from journal_vouchers; a head's side is read by the books alone.
 */
@Injectable()
export class VouchersService {
  constructor(private readonly db: Db, private readonly entries: EntriesService) {}

  // ---------------------------------------------------------------- shared: a voucher's udhaar entries

  /**
   * Brings the voucher's synced udhaar entries to [want] (grahak|day → paise): what they hold now
   * is read back from the entries themselves, and only the difference is pushed, in one entry.
   */
  private async syncUdhaar(phone: string, shopId: string, kind: 'jv' | 'cn', voucherId: string, want: Map<string, number>, note: (buyerId: string, phase: 'new' | 'edit' | 'void') => string) {
    const have = await this.db.withShop(shopId, async (tx) => (await tx.query<{ buyer_id: string; day: string; s: string }>(
      `SELECT vu.buyer_id, vu.day::text AS day, SUM(u.amount_paise) AS s FROM voucher_udhaar vu JOIN udhaar_entries u ON u.id = vu.udhaar_id
       WHERE vu.voucher_id = $1 GROUP BY vu.buyer_id, vu.day`, [voucherId])).rows);
    const cur = new Map(have.map((r) => [`${r.buyer_id}|${r.day}`, n(r.s)]));
    const fresh = have.length === 0;
    const voiding = [...want.values()].every((v) => v === 0);
    const now = new Date().toISOString();
    const txn = uuidv7();
    const rows: { id: string; buyerId: string; day: string; amount: number }[] = [];
    for (const k of new Set([...cur.keys(), ...want.keys()])) {
      const diff = (want.get(k) ?? 0) - (cur.get(k) ?? 0);
      if (!diff) continue;
      const [buyerId, day] = k.split('|');
      rows.push({ id: uuidv7(), buyerId, day, amount: diff });
    }
    if (!rows.length) return;
    await this.entries.pushAsWeb(phone, shopId, rows.map((r) => ({ table: 'udhaar_entries', txn, row: {
      id: r.id, created_at: now, buyer_id: r.buyerId, amount_paise: r.amount, business_date: r.day,
      note: clip(note(r.buyerId, fresh ? 'new' : voiding ? 'void' : 'edit'), 200) || (r.amount > 0 ? 'Udhaar' : 'Jama'),
    } })));
    await this.db.withShop(shopId, async (tx) => {
      for (const r of rows) {
        await tx.query(`INSERT INTO voucher_udhaar (udhaar_id, shop_id, kind, voucher_id, buyer_id, day, amount_paise)
                        VALUES ($1, current_setting('app.shop_id')::uuid, $2, $3, $4, $5, $6) ON CONFLICT (udhaar_id) DO NOTHING`, [r.id, kind, voucherId, r.buyerId, r.day, r.amount]);
      }
    });
  }

  // ---------------------------------------------------------------- Journal Voucher

  /** What the form offers: heads (the shop's own and the built-in kharcha/aamdani ones) and every supplier name. */
  async jvOptions(shopId: string) {
    return this.db.withShop(shopId, async (tx) => {
      const own = (await tx.query<{ id: string; name: string; type: string }>(`SELECT id, name, type FROM ledger_heads WHERE hidden = false ORDER BY name`)).rows;
      return {
        heads: [
          ...own.map((h) => ({ key: `h:${h.id}`, name: h.name, type: h.type })),
          ...BUILTIN_HEADS.filter((h) => JV_BUILTIN.includes(h.key)).map((h) => ({ key: `b:${h.key}`, name: h.name, type: h.type })),
        ],
        suppliers: await supplierNames(tx),
        nextNo: await nextNo(tx, 'journal_vouchers'),
      };
    });
  }

  /** The register: every voucher in [from, to] (struck-out ones too), newest first, searchable. */
  async jvList(shopId: string, from: string, to: string, q = '') {
    if (from > to) throw new BadRequestException('from must be on or before to');
    return this.db.withShop(shopId, async (tx) => {
      const like = `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = (await tx.query<JvRow>(
        `SELECT *, day::text AS day FROM journal_vouchers WHERE day BETWEEN $1 AND $2
           AND ($3 = '' OR dr_name ILIKE $4 OR cr_name ILIKE $4 OR narration ILIKE $4 OR no::text = $3)
         ORDER BY journal_vouchers.day DESC, no DESC LIMIT 2000`, [from, to, q.trim(), like])).rows.map(jvView);
      return { from, to, vouchers: rows, totalPaise: rows.filter((r) => !r.voided).reduce((s, r) => s + r.amountPaise, 0) };
    });
  }

  async jvOne(shopId: string, id: string) {
    return this.db.withShop(shopId, async (tx) => {
      const r = (await tx.query<JvRow>(`SELECT *, day::text AS day FROM journal_vouchers WHERE id = $1`, [id])).rows[0];
      if (!r) throw new NotFoundException('JV nahi mila');
      const udhaar = (await tx.query<{ udhaar_id: string; buyer_id: string; name: string | null; day: string; amount_paise: string; note: string | null; created_at: Date }>(
        `SELECT vu.udhaar_id, vu.buyer_id, g.name, vu.day::text AS day, vu.amount_paise, u.note, vu.created_at FROM voucher_udhaar vu
         LEFT JOIN buyers g ON g.id = vu.buyer_id LEFT JOIN udhaar_entries u ON u.id = vu.udhaar_id WHERE vu.voucher_id = $1 ORDER BY vu.created_at`, [id])).rows;
      return { ...jvView(r), entries: udhaar.map((u) => ({ id: u.udhaar_id, buyerId: u.buyer_id, name: u.name ?? '', date: u.day, amountPaise: n(u.amount_paise), note: u.note ?? '', at: u.created_at.toISOString() })) };
    });
  }

  /** A new voucher, or [id] written again: its grahak sides follow by the difference. */
  async jvSave(phone: string, shopId: string, id: string | null, input: JvInput) {
    if (!(input.amountPaise > 0)) throw new BadRequestException('Rakam daalein');
    const day = isDay(input.day) ? input.day : istToday();
    const caps = await this.entries.capsNames(shopId);
    const { dr, cr, old } = await this.db.withShop(shopId, async (tx) => {
      const old = id ? (await tx.query<JvRow>(`SELECT *, day::text AS day FROM journal_vouchers WHERE id = $1`, [id])).rows[0] : null;
      if (id && !old) throw new NotFoundException('JV nahi mila');
      if (old?.voided_at) throw new UnprocessableEntityException('Yeh JV hata diya gaya hai');
      return { dr: await side(tx, input.dr, caps), cr: await side(tx, input.cr, caps), old };
    });
    if (dr.kind === cr.kind && (dr.kind === 'supplier' ? nameKey(dr.ref) === nameKey(cr.ref) : dr.ref === cr.ref)) throw new BadRequestException('Dono khate ek hi hain');
    const narration = clip(input.narration ?? '', 200);
    const want = new Map<string, number>();
    const add = (s: Side, paise: number) => { if (s.kind === 'grahak') want.set(`${s.ref}|${day}`, (want.get(`${s.ref}|${day}`) ?? 0) + paise); };
    add(dr, input.amountPaise); add(cr, -input.amountPaise);

    const vals = [day, dr.kind, dr.ref, dr.name, cr.kind, cr.ref, cr.name, input.amountPaise, narration];
    const row = old ?? await this.db.withShop(shopId, async (tx) => {
      const no = await nextNo(tx, 'journal_vouchers');
      const newId = uuidv7();
      await tx.query(`INSERT INTO journal_vouchers (id, shop_id, no, day, dr_kind, dr_ref, dr_name, cr_kind, cr_ref, cr_name, amount_paise, narration, created_by)
                      VALUES ($1, current_setting('app.shop_id')::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [newId, no, ...vals, phone]);
      return { id: newId, no } as Pick<JvRow, 'id' | 'no'>;
    });
    const label = `JV #${row.no}`;
    const other = (buyerId: string) => (dr.kind === 'grahak' && dr.ref === buyerId ? cr.name : dr.name);
    try {
      await this.syncUdhaar(phone, shopId, 'jv', row.id, want, (b, phase) =>
        [phase === 'edit' ? `${label} badla` : label, other(b), narration].filter(Boolean).join(' · '));
    } catch (e) {
      // A new voucher whose khata entry would not save is not kept: nothing is half-written.
      if (!old) await this.db.withShop(shopId, (tx) => tx.query(`DELETE FROM journal_vouchers WHERE id = $1`, [row.id]));
      throw e;
    }
    if (old) {
      await this.db.withShop(shopId, (tx) => tx.query(
        `UPDATE journal_vouchers SET day = $2, dr_kind = $3, dr_ref = $4, dr_name = $5, cr_kind = $6, cr_ref = $7, cr_name = $8, amount_paise = $9, narration = $10, updated_at = now()
         WHERE id = $1`, [row.id, ...vals]));
    }
    return { id: row.id, no: row.no };
  }

  /** Hatayein: the grahak sides reversed by udhaar entries, the voucher struck out (its number kept). */
  async jvRemove(phone: string, shopId: string, id: string) {
    const r = await this.db.withShop(shopId, async (tx) => (await tx.query<JvRow>(`SELECT *, day::text AS day FROM journal_vouchers WHERE id = $1`, [id])).rows[0]);
    if (!r) throw new NotFoundException('JV nahi mila');
    if (r.voided_at) throw new ConflictException('Yeh JV pehle hi hata diya gaya hai');
    await this.syncUdhaar(phone, shopId, 'jv', id, new Map(), () => `JV #${r.no} radd`);
    await this.db.withShop(shopId, (tx) => tx.query(`UPDATE journal_vouchers SET voided_at = now(), updated_at = now() WHERE id = $1`, [id]));
    return { id, no: r.no, deleted: true };
  }

  // ---------------------------------------------------------------- Credit Note

  async cnList(shopId: string, from: string, to: string, q = '') {
    if (from > to) throw new BadRequestException('from must be on or before to');
    return this.db.withShop(shopId, async (tx) => {
      const like = `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = (await this.cnRows(tx, `c.day BETWEEN $1 AND $2 AND ($3 = '' OR g.name ILIKE $4 OR c.note ILIKE $4 OR c.no::text = $3 OR c.slip_no::text = $3)`, [from, to, q.trim(), like])).map(cnView);
      return { from, to, notes: rows, totalPaise: rows.filter((r) => !r.voided).reduce((s, r) => s + r.amountPaise, 0), nextNo: await nextNo(tx, 'credit_notes') };
    });
  }

  async cnOne(shopId: string, id: string) {
    return this.db.withShop(shopId, async (tx) => {
      const r = (await this.cnRows(tx, `c.id = $1`, [id]))[0];
      if (!r) throw new NotFoundException('Credit note nahi mila');
      const g = (await tx.query<{ name: string; code: string; phone: string; address: string; city: string; gstin: string | null }>(
        `SELECT g.name, g.code, g.phone, g.address, g.city, x.gstin FROM buyers g LEFT JOIN buyer_gstin x ON x.buyer_id = g.id WHERE g.id = $1`, [r.buyer_id])).rows[0];
      return { ...cnView(r), buyer: { name: g?.name ?? '', code: g?.code ?? '', phone: g?.phone ?? '', address: [g?.address, g?.city].filter(Boolean).join(', '), gstin: g?.gstin ?? '' } };
    });
  }

  /** A parchi's lines, for a credit note against it: quality, grade, boxes and bhav. */
  async cnSlip(shopId: string, billId: string) {
    return this.db.withShop(shopId, async (tx) => {
      const b = (await tx.query<{ id: string; slip_no: number | null; buyer_id: string | null; buyer_name: string; day: string; total_paise: string }>(
        `SELECT id, slip_no, buyer_id, buyer_name, business_date::text AS day, total_paise FROM ${LIVE_BILLS} lb WHERE id = $1`, [billId])).rows[0];
      if (!b) throw new NotFoundException('Parchi nahi mili');
      return { billId: b.id, slipNo: b.slip_no, buyerId: b.buyer_id, buyerName: b.buyer_name, date: b.day, totalPaise: n(b.total_paise), lines: await slipLines(tx, b.id),
        creditedPaise: await credited(tx, b.id, null) };
    });
  }

  /** A grahak's live parchis, newest first, to pick one for a credit note. */
  async cnSlips(shopId: string, buyerId: string) {
    return this.db.withShop(shopId, async (tx) => ({ slips: (await tx.query<{ id: string; slip_no: number | null; day: string; total_paise: string; boxes: string }>(
      `SELECT lb.id, lb.slip_no, lb.business_date::text AS day, lb.total_paise, (SELECT COALESCE(SUM(qty), 0) FROM bill_lines l WHERE l.bill_id = lb.id) AS boxes
       FROM ${LIVE_BILLS} lb WHERE lb.buyer_id = $1 AND lb.pay_mode <> 'free' ORDER BY lb.business_date DESC, lb.created_at DESC LIMIT 200`, [buyerId])).rows
      .map((r) => ({ billId: r.id, slipNo: r.slip_no, date: r.day, totalPaise: n(r.total_paise), boxes: n(r.boxes) })) }));
  }

  async cnSave(phone: string, shopId: string, id: string | null, input: CnInput) {
    const day = isDay(input.day) ? input.day : istToday();
    const pre = await this.db.withShop(shopId, async (tx) => {
      const old = id ? (await this.cnRows(tx, `c.id = $1`, [id]))[0] : null;
      if (id && !old) throw new NotFoundException('Credit note nahi mila');
      if (old?.voided_at) throw new UnprocessableEntityException('Yeh credit note hata diya gaya hai');
      if (!(await tx.query(`SELECT 1 FROM buyers WHERE id = $1`, [input.buyerId])).rowCount) throw new BadRequestException('Grahak nahi mila');
      let bill: { id: string; slip_no: number | null; total: number; lines: Awaited<ReturnType<typeof slipLines>> } | null = null;
      if (input.billId) {
        const b = (await tx.query<{ id: string; slip_no: number | null; buyer_id: string | null; total_paise: string }>(
          `SELECT id, slip_no, buyer_id, total_paise FROM ${LIVE_BILLS} lb WHERE id = $1`, [input.billId])).rows[0];
        // A parchi edited since keeps its number on a new bill: the note stays on the one it was made for.
        if (!b && old?.bill_id !== input.billId) throw new BadRequestException('Parchi nahi mili');
        if (b && b.buyer_id !== input.buyerId) throw new BadRequestException('Yeh parchi is grahak ki nahi');
        if (b) bill = { id: b.id, slip_no: b.slip_no, total: n(b.total_paise), lines: await slipLines(tx, b.id) };
        else bill = { id: input.billId, slip_no: old?.slip_no ?? null, total: Number.MAX_SAFE_INTEGER, lines: [] };
      }
      return { old, bill, others: bill ? await credited(tx, bill.id, id) : 0 };
    });
    const lines = (input.lines ?? []).filter((l) => l.boxes > 0 && l.ratePaise > 0).map((l) => ({
      quality: clip(l.quality, 60), grade: l.grade ?? '', boxes: l.boxes, ratePaise: l.ratePaise, amountPaise: Math.round(l.boxes * l.ratePaise),
    }));
    if (pre.bill?.lines.length) {
      for (const l of lines) {
        const on = pre.bill.lines.filter((x) => nameKey(x.quality) === nameKey(l.quality) && (!l.grade || x.grade === l.grade)).reduce((s, x) => s + x.qty, 0);
        if (l.boxes > on) throw new BadRequestException(`Parchi par ${l.quality} sirf ${on} hain`);
      }
    }
    const amount = lines.length ? lines.reduce((s, l) => s + l.amountPaise, 0) : Math.round(input.amountPaise ?? 0);
    if (!(amount > 0)) throw new BadRequestException('Rakam daalein');
    if (pre.bill && pre.others + amount > pre.bill.total) throw new BadRequestException('Credit note parchi ki rakam se zyada hai');
    const note = clip(input.note ?? '', 200);
    const vals = [day, input.buyerId, pre.bill?.id ?? null, pre.bill?.slip_no ?? null, input.reason, JSON.stringify(lines), amount, note];
    const row = pre.old ?? await this.db.withShop(shopId, async (tx) => {
      const no = await nextNo(tx, 'credit_notes');
      const newId = uuidv7();
      await tx.query(`INSERT INTO credit_notes (id, shop_id, no, day, buyer_id, bill_id, slip_no, reason, lines, amount_paise, note, created_by)
                      VALUES ($1, current_setting('app.shop_id')::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [newId, no, ...vals, phone]);
      return { id: newId, no } as Pick<CnRow, 'id' | 'no'>;
    });
    const label = [`CN #${row.no}`, CN_REASONS[input.reason], pre.bill?.slip_no ? `Parchi ${pre.bill.slip_no}` : '', note].filter(Boolean).join(' · ');
    try {
      await this.syncUdhaar(phone, shopId, 'cn', row.id, new Map([[`${input.buyerId}|${day}`, -amount]]), (_, phase) => (phase === 'edit' ? label.replace(/^CN #\d+/, '$& badla') : label));
    } catch (e) {
      if (!pre.old) await this.db.withShop(shopId, (tx) => tx.query(`DELETE FROM credit_notes WHERE id = $1`, [row.id]));
      throw e;
    }
    if (pre.old) {
      await this.db.withShop(shopId, (tx) => tx.query(
        `UPDATE credit_notes SET day = $2, buyer_id = $3, bill_id = $4, slip_no = $5, reason = $6, lines = $7, amount_paise = $8, note = $9, updated_at = now() WHERE id = $1`, [row.id, ...vals]));
    }
    return { id: row.id, no: row.no, amountPaise: amount };
  }

  async cnRemove(phone: string, shopId: string, id: string) {
    const r = await this.db.withShop(shopId, async (tx) => (await this.cnRows(tx, `c.id = $1`, [id]))[0]);
    if (!r) throw new NotFoundException('Credit note nahi mila');
    if (r.voided_at) throw new ConflictException('Yeh credit note pehle hi hata diya gaya hai');
    await this.syncUdhaar(phone, shopId, 'cn', id, new Map(), () => `CN #${r.no} radd`);
    await this.db.withShop(shopId, (tx) => tx.query(`UPDATE credit_notes SET voided_at = now(), updated_at = now() WHERE id = $1`, [id]));
    return { id, no: r.no, deleted: true };
  }

  private async cnRows(tx: Tx, where: string, params: unknown[]) {
    return (await tx.query<CnRow>(
      `SELECT c.*, c.day::text AS day, g.name FROM credit_notes c LEFT JOIN buyers g ON g.id = c.buyer_id WHERE ${where} ORDER BY c.day DESC, c.no DESC LIMIT 2000`, params)).rows;
  }

  // ---------------------------------------------------------------- Bikri Entry

  /**
   * GFA's Bikri Entry: one gaadi sold to many grahak in one go — a parchi per row, each written
   * by the parchi writer exactly as Nayi Parchi writes it (APMC, labour, slip number settled by
   * the sync, print queue). Like the app's bulk sale, each slip is its own record, so one row
   * refused never takes the others with it: the rows that saved and those that didn't come back.
   * A new name becomes a grahak once, however many rows carry it.
   */
  async bikri(phone: string, shopId: string, input: BikriInput) {
    const rows = input.rows.map((r, i) => ({ ...r, i })).filter((r) => r.qty > 0);
    if (!rows.length) throw new BadRequestException('Kam se kam ek grahak aur box daalein');
    const angoor = await this.entries.capsNames(shopId);
    const walkIn = (r: BikriRow) => !r.buyerId && (!(r.buyerName ?? '').trim() || /^(cash|bank)$/i.test((r.buyerName ?? '').trim()));
    for (const r of rows) {
      if ((r.pay ?? 'credit') === 'credit' && walkIn(r)) throw new BadRequestException(`Line ${r.i + 1}: udhaar ke liye grahak ka naam`);
      if (!(r.truckId ?? input.truckId)) throw new BadRequestException('Gaadi chunein');
      if (angoor && !r.brandId) throw new BadRequestException(`Line ${r.i + 1}: quality chunein`);
    }
    // New names: one grahak each (an existing one by the same name is used, as the app's buyerNamed).
    const ids = new Map<string, string>();
    for (const r of rows) {
      if (r.buyerId || walkIn(r)) continue;
      const name = angoor ? r.buyerName!.trim().toUpperCase() : r.buyerName!.trim();
      if (ids.has(name.toLowerCase())) continue;
      const known = await this.db.withShop(shopId, async (tx) => (await tx.query<{ id: string }>(
        `SELECT id FROM buyers WHERE hidden = false AND lower(trim(name)) = lower($1) ORDER BY created_at LIMIT 1`, [name])).rows[0]?.id);
      ids.set(name.toLowerCase(), known ?? (await this.entries.grahak(phone, shopId, { name })).id);
    }
    const made: { line: number; billId: string; slipNo: number; buyerId: string | null }[] = [];
    const failed: { line: number; error: string }[] = [];
    for (const r of rows) {
      const buyerId = r.buyerId ?? (walkIn(r) ? undefined : ids.get((angoor ? r.buyerName!.trim().toUpperCase() : r.buyerName!.trim()).toLowerCase()));
      const pay = r.pay ?? 'credit';
      const truckId = r.truckId ?? input.truckId!;
      try {
        const res = await this.entries.parchi(phone, shopId, {
          buyerId, buyerName: buyerId ? undefined : (pay === 'upi' ? 'Bank' : 'Cash'), pay, packing: 'loose', staff: input.staff,
          ...(angoor
            ? { lots: [{ truckId, brandId: r.brandId!, qty: r.qty, ratePaise: r.ratePaise }], labour: pay === 'credit' && !!input.labour, labourRatePaise: input.labourRatePaise }
            : { truckId, lines: [{ grade: r.grade ?? '1', qty: r.qty, ratePaise: r.ratePaise }], labour: false }),
        });
        made.push({ line: r.i + 1, billId: res.billId, slipNo: res.slipNo, buyerId: res.buyerId });
      } catch (e) {
        failed.push({ line: r.i + 1, error: (e as Error).message });
      }
    }
    const slips = made.length ? await this.db.withShop(shopId, async (tx) => (await tx.query<{ id: string; buyer_name: string; total_paise: string; qty: string }>(
      `SELECT b.id, b.buyer_name, b.total_paise, (SELECT COALESCE(SUM(qty), 0) FROM bill_lines l WHERE l.bill_id = b.id) AS qty FROM bills b WHERE b.id = ANY($1::uuid[])`,
      [made.map((m) => m.billId)])).rows) : [];
    const by = new Map(slips.map((s) => [s.id, s]));
    const out = made.map((m) => ({ ...m, buyerName: by.get(m.billId)?.buyer_name ?? '', totalPaise: n(by.get(m.billId)?.total_paise), qty: n(by.get(m.billId)?.qty) }));
    return { made: out, failed, totalPaise: out.reduce((s, m) => s + m.totalPaise, 0), boxes: out.reduce((s, m) => s + m.qty, 0) };
  }
}

// ---------------------------------------------------------------- helpers

/** The shop's next number for a voucher table: one past the highest ever used (struck-out ones too). */
async function nextNo(tx: Tx, table: 'journal_vouchers' | 'credit_notes') {
  return n((await tx.query<{ m: string | null }>(`SELECT MAX(no) AS m FROM ${table}`)).rows[0].m) + 1;
}

/** Every supplier name the shop writes: the master's spelling first, then the gaadis'. */
async function supplierNames(tx: Tx) {
  const out = new Map<string, string>();
  for (const r of (await tx.query<{ s: string }>(
    `SELECT s FROM (SELECT TRIM(name) AS s, 0 AS o, updated_at AS at FROM supplier_phones UNION ALL SELECT TRIM(supplier), 1, arrived_at FROM trucks) x
     WHERE s <> '' ORDER BY o, at DESC LIMIT 5000`)).rows) if (!out.has(nameKey(r.s))) out.set(nameKey(r.s), r.s);
  return [...out.values()].sort((a, b) => a.localeCompare(b));
}

/** One side of a voucher, checked against the books and named as they name it. */
async function side(tx: Tx, a: JvAccount, caps: boolean): Promise<Side> {
  if (a.kind === 'grahak') {
    const g = (await tx.query<{ name: string }>(`SELECT name FROM buyers WHERE id = $1`, [a.id])).rows[0];
    if (!g) throw new BadRequestException('Grahak nahi mila');
    return { kind: 'grahak', ref: a.id, name: g.name };
  }
  if (a.kind === 'supplier') {
    const typed = a.name.trim();
    if (!typed) throw new BadRequestException('Supplier ka naam daalein');
    // Spelled as the shop already writes him, so his khata picks it up.
    const known = (await supplierNames(tx)).find((s) => nameKey(s) === nameKey(typed));
    const name = known ?? (caps ? typed.toUpperCase() : typed);
    return { kind: 'supplier', ref: name.slice(0, 120), name: name.slice(0, 120) };
  }
  if (a.key.startsWith('h:')) {
    const h = (await tx.query<{ name: string; hidden: boolean }>(`SELECT name, hidden FROM ledger_heads WHERE id = $1`, [a.key.slice(2)])).rows[0];
    if (!h || h.hidden) throw new BadRequestException('Head nahi mila');
    return { kind: 'head', ref: a.key, name: h.name };
  }
  const b = BUILTIN_HEADS.find((h) => `b:${h.key}` === a.key && JV_BUILTIN.includes(h.key));
  if (!b) throw new BadRequestException('Head nahi mila');
  return { kind: 'head', ref: a.key, name: b.name };
}

/** A parchi's lines by quality, grade and bhav (several gaadis folded together). */
async function slipLines(tx: Tx, billId: string) {
  return (await tx.query<{ quality: string | null; grade: string; qty: string; rate_paise: string }>(
    `SELECT br.name AS quality, l.grade, SUM(l.qty) AS qty, l.rate_paise FROM bill_lines l LEFT JOIN brands br ON br.id = l.brand_id
     WHERE l.bill_id = $1 GROUP BY br.name, l.grade, l.rate_paise ORDER BY br.name, l.grade`, [billId])).rows
    .map((r) => ({ quality: r.quality ?? 'Maal', grade: r.grade, qty: n(r.qty), ratePaise: n(r.rate_paise) }));
}

/** What live credit notes already gave back on a parchi, leaving out [except]. */
async function credited(tx: Tx, billId: string, except: string | null) {
  return n((await tx.query<{ s: string }>(`SELECT COALESCE(SUM(amount_paise), 0) AS s FROM credit_notes WHERE bill_id = $1 AND voided_at IS NULL AND id IS DISTINCT FROM $2::uuid`,
    [billId, except])).rows[0].s);
}

const jvView = (r: JvRow) => ({
  id: r.id, no: r.no, date: r.day,
  dr: { kind: r.dr_kind, ref: r.dr_ref, name: r.dr_name }, cr: { kind: r.cr_kind, ref: r.cr_ref, name: r.cr_name },
  amountPaise: n(r.amount_paise), narration: r.narration, by: r.created_by, at: r.created_at.toISOString(), voided: !!r.voided_at,
});

const cnView = (r: CnRow) => ({
  id: r.id, no: r.no, date: r.day, buyerId: r.buyer_id, buyerName: r.name ?? '', billId: r.bill_id, slipNo: r.slip_no, reason: r.reason,
  lines: r.lines ?? [], amountPaise: n(r.amount_paise), note: r.note, by: r.created_by, at: r.created_at.toISOString(), voided: !!r.voided_at,
});
