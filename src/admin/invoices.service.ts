import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '../common/uuid';
import { Db, Tx } from '../db/db.service';
import { fyOf, fyRange } from './creditors.service';
import { SettingsService } from './settings.service';
import { LIVE_BILLS, n } from './sql';

const isDay = (d?: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
export const GSTIN = /^[0-9]{2}[A-Z0-9]{13}$/;

/** Fresh fruit is nil-rated under GST: the invoice keeps the tax columns, at 0%, saying so. */
const HSN: Record<string, { hsn: string; item: string; unit: string }> = {
  angoor: { hsn: '0806 10', item: 'Fresh grapes', unit: 'Box' },
  nariyal: { hsn: '0801 19', item: 'Tender coconut', unit: 'Nag' },
  amrud: { hsn: '0804 50', item: 'Fresh guava', unit: 'Box' },
};
const TAX_NOTE = 'Exempt (nil rated, fresh fruit)';

export type InvoiceLine = { slipNo: number | null; date: string; quality: string; grade: string; gaadi: string; hsn: string; qty: number; unit: string; kg: number; ratePaise: number; amountPaise: number };
export type InvoiceDoc = {
  number: string; date: string; fy: string; commodity: string; item: string
  seller: { name: string; address: string; mandi: string; shopNo: string; gstin: string; licenceNo: string; phone: string; email: string; contactPerson: string; banks: { holder: string; bank: string; ifsc: string; account: string; branch?: string }[] }
  buyer: { name: string; code: string; address: string; phone: string; gstin: string }
  slips: { billId: string; slipNo: number | null; date: string }[]
  lines: InvoiceLine[]
  charges: { label: string; amountPaise: number }[]
  goodsPaise: number; chargesPaise: number; taxRate: number; taxPaise: number; taxNote: string; totalPaise: number; words: string
};

type Bill = { id: string; slip_no: number | null; number: string; day: string; buyer_id: string | null; buyer_name: string; total_paise: string; apmc_paise: string; chungi_paise: string; pay_mode: string };

/**
 * Generate Invoices (the old software's tax invoice): one per parchi, or one for many of a
 * grahak's parchis, numbered per financial year from the company code (GFA/2026-27/0001). The
 * invoice is kept exactly as issued, so printing it again gives the same paper; a parchi on a
 * live invoice is not invoiced twice; a cancelled invoice keeps its number and frees its parchis.
 */
@Injectable()
export class InvoicesService {
  constructor(private readonly db: Db, private readonly settings: SettingsService) {}

  /** Live parchis in [from, to] (of one grahak when given), each with the invoice it is on, if any. */
  async parchis(shopId: string, from: string, to: string, buyerId?: string) {
    if (from > to) throw new BadRequestException('from must be on or before to');
    return this.db.withShop(shopId, async (tx) => {
      const rows = (await tx.query<Bill & { qty: string; invoice: string | null }>(
        `SELECT lb.id, lb.slip_no, lb.number, lb.business_date::text AS day, lb.buyer_id, COALESCE(g.name, lb.buyer_name) AS buyer_name, lb.total_paise,
                (SELECT COALESCE(SUM(qty), 0) FROM bill_lines l WHERE l.bill_id = lb.id) AS qty,
                (SELECT i.number FROM tax_invoices i WHERE lb.id = ANY(i.bill_ids) AND i.voided_at IS NULL LIMIT 1) AS invoice
         FROM ${LIVE_BILLS} lb LEFT JOIN buyers g ON g.id = lb.buyer_id
         WHERE lb.business_date BETWEEN $1 AND $2 AND lb.pay_mode <> 'free' AND lb.total_paise > 0 AND ($3::uuid IS NULL OR lb.buyer_id = $3)
         ORDER BY lb.business_date, lb.slip_no NULLS LAST LIMIT 3000`, [from, to, buyerId ?? null])).rows;
      return { from, to, parchis: rows.map((r) => ({ billId: r.id, slipNo: r.slip_no, date: r.day, buyerId: r.buyer_id, buyerName: r.buyer_name, qty: n(r.qty), totalPaise: n(r.total_paise), invoice: r.invoice })) };
    });
  }

  /** The register: invoices in [from, to], searchable by number, grahak or parchi. */
  async list(shopId: string, from: string, to: string, q = '') {
    if (from > to) throw new BadRequestException('from must be on or before to');
    return this.db.withShop(shopId, async (tx) => {
      const like = `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = (await tx.query<{ id: string; number: string; day: string; buyer_id: string | null; buyer_name: string; total_paise: string; slips: number; voided_at: Date | null; void_reason: string; doc: InvoiceDoc }>(
        `SELECT id, number, day::text AS day, buyer_id, buyer_name, total_paise, cardinality(bill_ids) AS slips, voided_at, void_reason, doc FROM tax_invoices
         WHERE day BETWEEN $1 AND $2 AND ($3 = ''
           OR ($3 ~ '^[0-9]+$' AND (seq::text = ltrim($3, '0') OR EXISTS (SELECT 1 FROM jsonb_array_elements(doc->'slips') s WHERE s->>'slipNo' = $3)))
           OR ($3 !~ '^[0-9]+$' AND (number ILIKE $4 OR buyer_name ILIKE $4 OR doc->'buyer'->>'gstin' ILIKE $4)))
         ORDER BY day DESC, fy DESC, seq DESC LIMIT 2000`, [from, to, q.trim(), like])).rows;
      const view = rows.map((r) => ({ id: r.id, number: r.number, date: r.day, buyerId: r.buyer_id, buyerName: r.buyer_name, totalPaise: n(r.total_paise), slips: r.slips,
        slipNos: (r.doc.slips ?? []).map((s) => s.slipNo).filter((x) => x != null), gstin: r.doc.buyer?.gstin ?? '', voided: !!r.voided_at, voidReason: r.void_reason }));
      return { from, to, invoices: view, totalPaise: view.filter((r) => !r.voided).reduce((s, r) => s + r.totalPaise, 0) };
    });
  }

  /** Invoices in full, as issued, for printing one or many. */
  async docs(shopId: string, ids: string[]) {
    return this.db.withShop(shopId, async (tx) => {
      const rows = (await tx.query<{ id: string; doc: InvoiceDoc; voided_at: Date | null; void_reason: string }>(
        `SELECT id, doc, voided_at, void_reason FROM tax_invoices WHERE id = ANY($1::uuid[]) ORDER BY fy, seq`, [ids])).rows;
      return { invoices: rows.map((r) => ({ id: r.id, ...r.doc, voided: !!r.voided_at, voidReason: r.void_reason })) };
    });
  }

  async one(shopId: string, id: string) {
    const r = (await this.docs(shopId, [id])).invoices[0];
    if (!r) throw new NotFoundException('Invoice nahi mila');
    return r;
  }

  /**
   * Issues invoices for [billIds]: 'each' = one per parchi (dated the parchi's day unless [day]
   * is given), 'one' = one for them all (one grahak; dated the last parchi's day unless given).
   */
  async generate(phone: string, shopId: string, input: { billIds: string[]; mode: 'each' | 'one'; day?: string }) {
    const ids = [...new Set(input.billIds)];
    if (!ids.length) throw new BadRequestException('Parchi chunein');
    const s = await this.settings.get(shopId);
    return this.db.withShop(shopId, async (tx) => {
      // One issuer at a time per shop, so two clicks never take the same number.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('tax_invoices:' || $1, 0))`, [shopId]);
      const bills = (await tx.query<Bill>(
        `SELECT lb.id, lb.slip_no, lb.number, lb.business_date::text AS day, lb.buyer_id, lb.buyer_name, lb.total_paise, lb.apmc_paise, lb.chungi_paise, lb.pay_mode
         FROM ${LIVE_BILLS} lb WHERE lb.id = ANY($1::uuid[]) ORDER BY lb.business_date, lb.slip_no NULLS LAST, lb.created_at`, [ids])).rows;
      if (bills.length !== ids.length) throw new BadRequestException('Koi parchi hat gayi ya badal gayi hai, list dobara kholein');
      const taken = (await tx.query<{ number: string; slip_no: number | null }>(
        `SELECT i.number, b.slip_no FROM tax_invoices i JOIN bills b ON b.id = ANY(i.bill_ids) WHERE i.voided_at IS NULL AND b.id = ANY($1::uuid[]) LIMIT 1`, [ids])).rows[0];
      if (taken) throw new ConflictException(`Parchi ${taken.slip_no ?? ''} pehle se invoice ${taken.number} par hai`);
      if (bills.some((b) => b.pay_mode === 'free' || n(b.total_paise) <= 0)) throw new BadRequestException('Free parchi ka invoice nahi banta');
      // An invoice is never dated before the supply it bills.
      const early = isDay(input.day) ? bills.find((b) => b.day > input.day!) : undefined;
      if (early) throw new BadRequestException(`Parchi #${early.slip_no ?? ''} ${early.day.split('-').reverse().join('-')} ki hai — invoice usse pehle ki nahi`);
      const groups = input.mode === 'one' ? [bills] : bills.map((b) => [b]);
      if (input.mode === 'one') {
        const who = new Set(bills.map((b) => b.buyer_id ?? `name:${b.buyer_name.trim().toLowerCase()}`));
        if (who.size > 1) throw new BadRequestException('Ek invoice mein ek hi grahak ki parchiyan');
      }
      const made: { id: string; number: string }[] = [];
      for (const group of groups) {
        const day = isDay(input.day) ? input.day : group[group.length - 1].day;
        const fy = fyOf(day);
        const seq = n((await tx.query<{ m: string | null }>(`SELECT MAX(seq) AS m FROM tax_invoices WHERE fy = $1`, [fy])).rows[0].m) + 1;
        const prefix = (s.companyCode || s.slipCode || 'INV').toUpperCase().replace(/[^A-Z0-9&-]/g, '') || 'INV';
        const number = `${prefix}/${fyRange(fy).label}/${String(seq).padStart(4, '0')}`;
        const doc = await this.build(tx, s, group, number, day, fyRange(fy).label);
        const id = uuidv7();
        await tx.query(`INSERT INTO tax_invoices (id, shop_id, fy, seq, number, day, buyer_id, buyer_name, bill_ids, total_paise, doc, created_by)
                        VALUES ($1, current_setting('app.shop_id')::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [id, fy, seq, number, day, group[0].buyer_id, doc.buyer.name, group.map((b) => b.id), doc.totalPaise, JSON.stringify(doc), phone]);
        made.push({ id, number });
      }
      return { invoices: made };
    });
  }

  /** Cancel: the invoice stays in the register struck out, its number kept; its parchis can be invoiced again. */
  async cancel(shopId: string, id: string, reason: string) {
    return this.db.withShop(shopId, async (tx) => {
      const r = (await tx.query<{ voided_at: Date | null; number: string }>(`SELECT voided_at, number FROM tax_invoices WHERE id = $1`, [id])).rows[0];
      if (!r) throw new NotFoundException('Invoice nahi mila');
      if (r.voided_at) throw new ConflictException('Yeh invoice pehle hi cancel hai');
      await tx.query(`UPDATE tax_invoices SET voided_at = now(), void_reason = $2 WHERE id = $1`, [id, reason.trim().slice(0, 200)]);
      return { id, number: r.number, cancelled: true };
    });
  }

  /** A grahak's GSTIN (website only, for the invoice); '' clears it. */
  async setGstin(shopId: string, buyerId: string, gstin: string) {
    const v = gstin.trim().toUpperCase();
    if (v && !GSTIN.test(v)) throw new BadRequestException('GSTIN 15 akshar ka hota hai (jaise 07ABCDE1234F1Z5)');
    return this.db.withShop(shopId, async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM buyers WHERE id = $1`, [buyerId])).rowCount) throw new NotFoundException('Grahak nahi mila');
      await tx.query(`INSERT INTO buyer_gstin (buyer_id, shop_id, gstin) VALUES ($1, current_setting('app.shop_id')::uuid, $2)
                      ON CONFLICT (buyer_id) DO UPDATE SET gstin = EXCLUDED.gstin, updated_at = now()`, [buyerId, v]);
      return { id: buyerId, gstin: v };
    });
  }

  private async build(tx: Tx, s: Awaited<ReturnType<SettingsService['get']>>, bills: Bill[], number: string, day: string, fyLabel: string): Promise<InvoiceDoc> {
    const shop = (await tx.query<{ name: string; mandi: string; shop_no: string }>(`SELECT name, mandi, shop_no FROM shops WHERE id = current_setting('app.shop_id')::uuid`)).rows[0];
    const kind = HSN[s.commodity] ?? { hsn: '', item: 'Fresh fruit', unit: 'Box' };
    const lines = (await tx.query<{ bill_id: string; quality: string | null; grade: string; gaadi: string | null; qty: string; rate_paise: string; grams: number | null }>(
      `SELECT l.bill_id, br.name AS quality, l.grade, t.number AS gaadi, SUM(l.qty) AS qty, l.rate_paise,
              (SELECT MAX(g.box_grams) FROM truck_grades g WHERE g.truck_id = l.truck_id AND g.brand_id = l.brand_id) AS grams
       FROM bill_lines l LEFT JOIN brands br ON br.id = l.brand_id LEFT JOIN trucks t ON t.id = l.truck_id
       WHERE l.bill_id = ANY($1::uuid[]) GROUP BY l.bill_id, br.name, l.grade, t.number, l.rate_paise, l.truck_id, l.brand_id
       ORDER BY MIN(l.created_at)`, [bills.map((b) => b.id)])).rows;
    const out: InvoiceLine[] = [];
    for (const b of bills) {
      for (const l of lines.filter((x) => x.bill_id === b.id)) {
        const qty = n(l.qty), rate = n(l.rate_paise);
        out.push({ slipNo: b.slip_no, date: b.day, quality: l.quality ?? kind.item, grade: s.commodity === 'angoor' ? '' : l.grade, gaadi: l.gaadi ?? '', hsn: kind.hsn,
          qty, unit: kind.unit, kg: Math.round(qty * (l.grams ?? 0) / 10) / 100, ratePaise: rate, amountPaise: qty * rate });
      }
    }
    const goods = out.reduce((t, l) => t + l.amountPaise, 0);
    const total = bills.reduce((t, b) => t + n(b.total_paise), 0);
    // What rides on the slip besides the goods: APMC, and the rest of chungi_paise (grapes: mazdoori; amrud: chungi).
    const apmc = bills.reduce((t, b) => t + Math.min(n(b.apmc_paise), n(b.chungi_paise)), 0);
    const rest = bills.reduce((t, b) => t + Math.max(0, n(b.chungi_paise) - n(b.apmc_paise)), 0);
    const charges = [
      ...(apmc ? [{ label: 'APMC (mandi fee)', amountPaise: apmc }] : []),
      ...(rest ? [{ label: s.commodity === 'angoor' ? 'Mazdoori (labour)' : 'Chungi', amountPaise: rest }] : []),
    ];
    const other = total - goods - apmc - rest;
    if (other) charges.push({ label: 'Other', amountPaise: other });
    const b0 = bills[0];
    const g = b0.buyer_id ? (await tx.query<{ name: string; code: string; phone: string; address: string; city: string; district: string; state: string; gstin: string | null }>(
      `SELECT g.name, g.code, g.phone, g.address, g.city, g.district, g.state, x.gstin FROM buyers g LEFT JOIN buyer_gstin x ON x.buyer_id = g.id WHERE g.id = $1`, [b0.buyer_id])).rows[0] : null;
    return {
      number, date: day, fy: fyLabel, commodity: s.commodity, item: kind.item,
      seller: { name: s.name || shop.name, address: s.address, mandi: shop.mandi ?? '', shopNo: shop.shop_no ?? '', gstin: s.gstin, licenceNo: s.licenceNo, phone: s.phone, email: s.email,
        contactPerson: s.contactPerson, banks: s.bankAccounts.map((a) => ({ holder: a.holder, bank: a.bank, ifsc: a.ifsc, account: a.account, branch: a.branch })) },
      buyer: { name: g?.name ?? b0.buyer_name, code: g?.code ?? '', phone: /^[6-9]\d{9}$/.test(g?.phone ?? '') ? g!.phone : '',
        address: [g?.address, g?.city, g?.district, g?.state].filter(Boolean).join(', '), gstin: g?.gstin ?? '' },
      slips: bills.map((b) => ({ billId: b.id, slipNo: b.slip_no, date: b.day })),
      lines: out, charges, goodsPaise: goods, chargesPaise: total - goods, taxRate: 0, taxPaise: 0, taxNote: TAX_NOTE, totalPaise: total, words: inWords(total),
    };
  }
}

/** Rupees in Indian words, as a slip or invoice asks for: "Rupees One Lakh Twenty Thousand Only". */
export function inWords(paise: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (x: number) => (x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]} ${ones[x % 10]}`.trim());
  const three = (x: number) => [x >= 100 ? `${ones[Math.floor(x / 100)]} Hundred` : '', two(x % 100)].filter(Boolean).join(' ');
  let r = Math.floor(Math.abs(paise) / 100);
  const p = Math.round(Math.abs(paise) % 100);
  if (!r && !p) return 'Rupees Zero Only';
  const parts: string[] = [];
  const crore = Math.floor(r / 1e7); r %= 1e7;
  const lakh = Math.floor(r / 1e5); r %= 1e5;
  const thousand = Math.floor(r / 1e3); r %= 1e3;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (r) parts.push(three(r));
  return `Rupees ${parts.join(' ')}${p ? ` and ${two(p)} Paise` : ''} Only`.replace(/\s+/g, ' ');
}
