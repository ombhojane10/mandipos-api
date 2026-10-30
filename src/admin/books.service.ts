import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Writable } from 'node:stream';
import { types as pgTypes } from 'pg';
import { Db, Tx } from '../db/db.service';
import { fyOf, fyRange, CreditorsService } from './creditors.service';
import { BEEJAK_HEADS, NOT_EXPENSE, TRUCK_COST } from './insights.service';
import { BUILTIN_HEADS, OPENING_NOTES, type HeadType } from './masters.service';
import { ReportsService, nameKey, type Pot } from './reports.service';
import { CASH_PART, IST_DAY, LIVE_BILLS, LIVE_COLS, STORE_BACK, UPI_PART, n } from './sql';
import { writeXlsx, type Cell } from './xlsx';

const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const POTS: Pot[] = ['galla', 'office', 'bank'];

/**
 * The shop's books as a journal: every slip, raseed, udhaar entry, Day Book line, beejak (grapes)
 * or gaadi (others) written as balanced Dr/Cr postings to named accounts, so the old software's
 * General Ledger and Trial Balance can be read off books that were kept single-entry.
 *
 * Accounts (key → what it is):
 *  - pot:galla / pot:office / pot:bank — the Cash/Bank Book's three books (Store.book);
 *  - g:<buyer>    — a grahak or laddan party (their khata, BALANCES);
 *  - creditors    — the suppliers: beejak net (grapes, CreditorsService) or gaadi kharid + bhada (others, Supplier Khata);
 *  - sales        — bikri: the slip total less what rides on it (chungi_paise = APMC + mazdoori or chungi);
 *  - apmc / chungi — APMC and chungi collected on slips: owed onward, so liabilities;
 *  - mazdoori     — labour as Munafa counts it: earned on slips (labour_paise + adjustments, Dr) less what the
 *                   slip charged the buyer for it (Cr); labour — what is still owed to the labour (earned − paid in Day Book);
 *  - purchase / bhada_in — kharid: beejak gross (grapes) or gaadi goods at kharid bhav and gaadi bhada (others);
 *  - bj:<head>    — a beejak's deductions (commission, loading…): the shop's income;
 *  - b:<category> — a Day Book head (committee di/mili and udhaar diya/wapas paired); h:<id> — a head from the
 *                   General Ledger master, claimed by name exactly as MastersService does;
 *  - cnote        — credit notes (rate farq, maal kharab, wapsi, discount): bikri given back, so a sales-side debit;
 *  - journal vouchers (website, 067) post each side to its own account: a grahak through the synced udhaar
 *    entries the voucher wrote (voucher_udhaar), a supplier to creditors, a head to h:/b:. Every side goes
 *    against diff:voucher, which a voucher's two sides (and a credit note's) bring back to zero — so it only
 *    shows when an entry went astray;
 *  - diff:*       — the other side of what the books hold with no contra: openings (grahak purana udhaar,
 *                   supplier and head openings, a stated Cash/Bank opening) and entries whose two sides
 *                   don't meet (a slip paid ≠ cash + UPI, a supplier payment without a name…).
 */
type Acct = { key: string; name: string; group: Group; pl: boolean };
type Group = 'capital' | 'creditors' | 'liabilities' | 'cash' | 'bank' | 'debtors' | 'laddan' | 'assets' | 'sales' | 'purchase' | 'expense' | 'income' | 'suspense';
const GROUPS: { key: Group; name: string }[] = [
  { key: 'capital', name: 'Capital' }, { key: 'creditors', name: 'Sundry creditors' }, { key: 'liabilities', name: 'Duties aur dena' },
  { key: 'cash', name: 'Cash-in-hand' }, { key: 'bank', name: 'Bank' }, { key: 'debtors', name: 'Sundry debtors (grahak)' }, { key: 'laddan', name: 'Laddan parties' },
  { key: 'assets', name: 'Loans aur advances' }, { key: 'sales', name: 'Sales' }, { key: 'purchase', name: 'Purchase' },
  { key: 'expense', name: 'Kharcha' }, { key: 'income', name: 'Aamdani' }, { key: 'suspense', name: 'Difference in opening / suspense' },
];
const DIFF: Record<string, string> = {
  'diff:opening_grahak': 'Grahak opening (purana udhaar)', 'diff:udhaar': 'Grahak udhaar/jama entry', 'diff:opening_supplier': 'Supplier opening',
  'diff:opening_head': 'Head opening', 'diff:opening_cash': 'Cash/Bank opening', 'diff:bill': 'Parchi: paid ≠ cash + UPI', 'diff:raseed': 'Raseed: amount ≠ cash + UPI',
  'diff:transfer': 'Transfer ek hi book mein', 'diff:supplier': 'Supplier payment bina naam', 'diff:beejak': 'Beejak bina party', 'diff:gaadi': 'Gaadi bina supplier',
  'diff:mode': 'Day Book: mode nahi', 'diff:other': 'Supplier khata se farq', 'diff:voucher': 'JV / Credit note farq',
};
const PAIRED: Record<string, string> = { committee_di: 'committee', committee_mili: 'committee', udhaar_diya: 'udhaar_diya', udhaar_wapas: 'udhaar_diya' };
const TRANSFERS = ['handover', 'float', 'bank_jama', 'bank_nikala'];
const HEAD_CATS = `CASE h.type WHEN 'expense' THEN ARRAY['kharcha'] WHEN 'income' THEN ARRAY['aur_aaya'] ELSE ARRAY['aur_gaya', 'aur_aaya'] END`;

type Posting = { day: string; acct: string; dr: string; cr: string; kind: string; ref: string | null; ref2: string | null; title: string; detail: string; n?: string };

/** $1 = up to (a business date), $2 = the opening notes, $3 = grapes (beejak books) or not. */
const FRAGMENTS = {
  bills: `
    SELECT lb.business_date AS day, v.acct, v.dr, v.cr, 'bill' AS kind, lb.id AS ref, lb.buyer_id AS ref2, lb.created_at AS at,
           'Parchi ' || COALESCE(lb.slip_no::text, lb.number) AS title, lb.buyer_name AS detail
    FROM ${LIVE_BILLS} lb
    CROSS JOIN LATERAL (SELECT LEAST(lb.apmc_paise, lb.chungi_paise) AS ap, GREATEST(lb.chungi_paise - lb.apmc_paise, 0) AS ch,
                               CASE WHEN lb.buyer_id IS NOT NULL AND lb.total_paise > lb.paid_paise THEN lb.total_paise - lb.paid_paise ELSE 0 END AS ud) x
    CROSS JOIN LATERAL (VALUES
      ('pot:galla', lb.cash_paise, 0::bigint), ('pot:bank', lb.upi_paise, 0), ('g:' || lb.buyer_id, x.ud, 0),
      ('sales', 0, lb.total_paise - x.ap - x.ch), ('apmc', 0, x.ap),
      ('mazdoori', lb.labour_paise, LEAST(lb.labour_paise, x.ch)), ('chungi', 0, x.ch - LEAST(lb.labour_paise, x.ch)), ('labour', 0, lb.labour_paise),
      ('diff:bill', GREATEST(lb.total_paise - lb.cash_paise - lb.upi_paise - x.ud, 0), GREATEST(lb.cash_paise + lb.upi_paise + x.ud - lb.total_paise, 0))
    ) v(acct, dr, cr)
    WHERE lb.business_date <= $1`,
  labourAdj: `
    SELECT a.business_date AS day, v.acct, v.dr, v.cr, 'mazdoori' AS kind, a.id AS ref, NULL::uuid AS ref2, a.created_at AS at, 'Mazdoori adjustment' AS title, a.note AS detail
    FROM labour_adjustments a
    CROSS JOIN LATERAL (VALUES ('mazdoori', GREATEST(a.amount_paise, 0), GREATEST(-a.amount_paise, 0)), ('labour', GREATEST(-a.amount_paise, 0), GREATEST(a.amount_paise, 0))) v(acct, dr, cr)
    WHERE a.hidden = false AND a.business_date <= $1`,
  cols: `
    SELECT lc.business_date AS day, v.acct, v.dr, v.cr, 'raseed' AS kind, lc.id AS ref, lc.buyer_id AS ref2, lc.created_at AS at,
           COALESCE('Raseed ' || lc.receipt_no, 'Vasooli') AS title, COALESCE(g.name, '') AS detail
    FROM ${LIVE_COLS} lc LEFT JOIN buyers g ON g.id = lc.buyer_id
    CROSS JOIN LATERAL (SELECT ${CASH_PART.replace(/\b(cash_paise|upi_paise|pay_mode|amount_paise)\b/g, 'lc.$1')} AS c,
                               ${UPI_PART.replace(/\b(cash_paise|upi_paise|pay_mode|amount_paise)\b/g, 'lc.$1')} AS u) x
    CROSS JOIN LATERAL (VALUES
      ('pot:galla', x.c, 0::bigint), ('pot:bank', x.u, 0), ('g:' || lc.buyer_id, 0, lc.amount_paise),
      ('diff:raseed', GREATEST(lc.amount_paise - x.c - x.u, 0), GREATEST(x.c + x.u - lc.amount_paise, 0))
    ) v(acct, dr, cr)
    WHERE lc.business_date <= $1`,
  udhaar: `
    SELECT u.business_date AS day, v.acct, v.dr, v.cr, 'udhaar' AS kind, u.id AS ref, u.buyer_id AS ref2, u.created_at AS at,
           COALESCE(NULLIF(u.note, ''), CASE WHEN u.amount_paise < 0 THEN 'Jama' ELSE 'Udhaar' END) AS title, COALESCE(g.name, '') AS detail
    FROM udhaar_entries u LEFT JOIN buyers g ON g.id = u.buyer_id LEFT JOIN voucher_udhaar vu ON vu.udhaar_id = u.id
    CROSS JOIN LATERAL (VALUES
      ('g:' || u.buyer_id, GREATEST(u.amount_paise, 0), GREATEST(-u.amount_paise, 0)),
      (CASE WHEN vu.udhaar_id IS NOT NULL THEN 'diff:voucher' WHEN u.note = ANY($2::text[]) THEN 'diff:opening_grahak' ELSE 'diff:udhaar' END,
       GREATEST(-u.amount_paise, 0), GREATEST(u.amount_paise, 0))
    ) v(acct, dr, cr)
    WHERE u.business_date <= $1`,
  // A Day Book line moves its own book (Store.book's mode → book) and, for a transfer, the book it
  // went into; whatever is left over is the other side: the head, the supplier, the labour.
  daybook: `
    SELECT e.business_date AS day, v.acct, v.dr, v.cr, 'daybook' AS kind, e.id AS ref, h.id AS ref2, e.created_at AS at, COALESCE(h.name, e.category) AS title,
           concat_ws(' · ', NULLIF(trim(e.party_name), ''), NULLIF(trim(e.note), ''), e.mode) AS detail
    FROM daybook_entries e
    LEFT JOIN ledger_heads h ON upper(trim(h.name)) = upper(trim(e.party_name)) AND e.category = ANY(${HEAD_CATS})
    CROSS JOIN LATERAL (SELECT
      CASE e.mode WHEN 'cash' THEN 'galla' WHEN 'office' THEN 'office' WHEN 'upi' THEN 'bank' WHEN 'bank' THEN 'bank' END AS own,
      CASE e.category WHEN 'handover' THEN 'office' WHEN 'float' THEN 'galla' WHEN 'bank_jama' THEN 'bank' WHEN 'bank_nikala' THEN 'office' END AS dest,
      CASE WHEN e.direction = 'in' THEN e.amount_paise ELSE -e.amount_paise END AS own_amt) x
    CROSS JOIN LATERAL (SELECT CASE WHEN x.dest IS NOT NULL AND x.dest IS DISTINCT FROM x.own THEN e.amount_paise ELSE 0 END AS mirror) y
    CROSS JOIN LATERAL (SELECT -(x.own_amt + y.mirror) AS amt,
      CASE WHEN x.dest IS NOT NULL THEN 'diff:transfer'
           WHEN e.category = 'supplier' THEN CASE WHEN e.direction = 'out' AND trim(e.party_name) <> '' THEN 'creditors' ELSE 'diff:supplier' END
           WHEN e.category = 'mazdoori' THEN 'labour'
           WHEN h.id IS NOT NULL THEN 'h:' || h.id
           WHEN e.category IN ('committee_di', 'committee_mili') THEN 'b:committee'
           WHEN e.category IN ('udhaar_diya', 'udhaar_wapas') THEN 'b:udhaar_diya'
           ELSE 'b:' || e.category END AS other) z
    CROSS JOIN LATERAL (VALUES
      (COALESCE('pot:' || x.own, 'diff:mode'), GREATEST(x.own_amt, 0), GREATEST(-x.own_amt, 0)), ('pot:' || x.dest, y.mirror, 0::bigint),
      (z.other, GREATEST(z.amt, 0), GREATEST(-z.amt, 0))
    ) v(acct, dr, cr)
    WHERE e.hidden = false AND e.category <> 'opening' AND e.business_date <= $1`,
  // Grapes: the beejak is the purchase document. Gross to kharid, net to the party, deductions to income.
  beejaks: `
    SELECT b.day AS day, v.acct, v.dr, v.cr, 'beejak' AS kind, b.id AS ref, b.truck_id AS ref2, b.created_at AS at, 'Beejak #' || b.beejak_no AS title, concat_ws(' · ', b.party, 'Gaadi ' || b.gaadi) AS detail
    FROM beejaks b CROSS JOIN LATERAL (
      SELECT 'purchase'::text AS acct, b.gross_paise AS dr, 0::bigint AS cr
      UNION ALL SELECT CASE WHEN trim(b.party) <> '' THEN 'creditors' ELSE 'diff:beejak' END, 0, b.net_paise
      UNION ALL SELECT 'bj:' || (x->>'key'), 0, (x->>'amountPaise')::bigint FROM jsonb_array_elements(b.expenses) x
    ) v
    WHERE $3 AND b.day <= $1`,
  // Others: a gaadi is bought — goods at kharid bhav (less corrections, at its average) and its bhada, owed to the supplier.
  gaadis: `
    SELECT ${IST_DAY('t.arrived_at')} AS day, v.acct, v.dr, v.cr, 'gaadi' AS kind, t.id AS ref, t.id AS ref2, t.arrived_at AS at, 'Gaadi ' || t.number AS title, trim(t.supplier) AS detail
    FROM trucks t
    LEFT JOIN (SELECT truck_id, SUM(billed_qty) billed, SUM(billed_qty::bigint * rate_paise) goods FROM truck_grades GROUP BY truck_id) g ON g.truck_id = t.id
    LEFT JOIN (SELECT truck_id, SUM(qty) corrected FROM spoilage WHERE kind = 'correction' GROUP BY truck_id) sp ON sp.truck_id = t.id
    CROSS JOIN LATERAL (SELECT GREATEST(0, COALESCE(g.goods, 0) - CASE WHEN COALESCE(g.billed, 0) > 0 AND COALESCE(sp.corrected, 0) > 0
                                 THEN ROUND(g.goods::numeric * sp.corrected / g.billed)::bigint ELSE 0 END) AS goods) x
    CROSS JOIN LATERAL (VALUES ('purchase', x.goods, 0::bigint), ('bhada_in', t.freight_paise, 0),
      (CASE WHEN trim(t.supplier) <> '' THEN 'creditors' ELSE 'diff:gaadi' END, 0, x.goods + t.freight_paise)) v(acct, dr, cr)
    WHERE NOT $3 AND ${IST_DAY('t.arrived_at')} <= $1`,
  // A journal voucher's supplier and head sides (its grahak sides are udhaar entries), and a credit note's
  // bikri side; each against diff:voucher, which the grahak's udhaar entries bring back to zero.
  vouchers: `
    SELECT j.day AS day, v.acct, v.dr, v.cr, 'jv' AS kind, j.id AS ref, NULL::uuid AS ref2, j.created_at AS at, 'JV #' || j.no AS title,
           concat_ws(' · ', j.dr_name || ' / ' || j.cr_name, NULLIF(trim(j.narration), '')) AS detail
    FROM journal_vouchers j CROSS JOIN LATERAL (VALUES
      (CASE j.dr_kind WHEN 'supplier' THEN 'creditors' WHEN 'head' THEN j.dr_ref END, j.amount_paise, 0::bigint),
      (CASE WHEN j.dr_kind <> 'grahak' THEN 'diff:voucher' END, 0, j.amount_paise),
      (CASE j.cr_kind WHEN 'supplier' THEN 'creditors' WHEN 'head' THEN j.cr_ref END, 0, j.amount_paise),
      (CASE WHEN j.cr_kind <> 'grahak' THEN 'diff:voucher' END, j.amount_paise, 0)
    ) v(acct, dr, cr)
    WHERE j.voided_at IS NULL AND j.day <= $1
    UNION ALL
    SELECT c.day, v.acct, v.dr, v.cr, 'cn', c.id, c.buyer_id, c.created_at, 'Credit note #' || c.no, concat_ws(' · ', g.name, 'Parchi ' || c.slip_no, NULLIF(trim(c.note), ''))
    FROM credit_notes c LEFT JOIN buyers g ON g.id = c.buyer_id
    CROSS JOIN LATERAL (VALUES ('cnote', c.amount_paise, 0::bigint), ('diff:voucher', 0, c.amount_paise)) v(acct, dr, cr)
    WHERE c.voided_at IS NULL AND c.day <= $1`,
  headOpenings: `
    SELECT COALESCE(h.opening_on, '0001-01-01'::date) AS day, v.acct, v.dr, v.cr, 'opening' AS kind, h.id AS ref, h.id AS ref2, h.created_at AS at, 'Opening balance' AS title, h.name AS detail
    FROM ledger_heads h CROSS JOIN LATERAL (SELECT CASE WHEN h.type IN ('expense', 'asset') THEN h.opening_paise ELSE -h.opening_paise END AS amt) x
    CROSS JOIN LATERAL (VALUES ('h:' || h.id, GREATEST(x.amt, 0), GREATEST(-x.amt, 0)), ('diff:opening_head', GREATEST(-x.amt, 0), GREATEST(x.amt, 0))) v(acct, dr, cr)
    WHERE h.opening_paise <> 0 AND COALESCE(h.opening_on, '0001-01-01'::date) <= $1`,
  supplierOpenings: `
    SELECT COALESCE(s.opening_on, '0001-01-01'::date) AS day, v.acct, v.dr, v.cr, 'opening' AS kind, s.id AS ref, NULL::uuid AS ref2, s.created_at AS at, 'Opening balance' AS title, s.name AS detail
    FROM supplier_phones s
    CROSS JOIN LATERAL (VALUES ('creditors', GREATEST(-s.opening_paise, 0), GREATEST(s.opening_paise, 0)),
                               ('diff:opening_supplier', GREATEST(s.opening_paise, 0), GREATEST(-s.opening_paise, 0))) v(acct, dr, cr)
    WHERE s.opening_paise <> 0 AND COALESCE(s.opening_on, '0001-01-01'::date) <= $1`,
};
type Fragment = keyof typeof FRAGMENTS;

/** The sources an account's postings can come from (all of them for a difference account). */
function sourcesOf(key: string): Fragment[] {
  if (['sales', 'apmc', 'chungi'].includes(key)) return ['bills'];
  if (key === 'mazdoori') return ['bills', 'labourAdj'];
  if (key === 'labour') return ['bills', 'labourAdj', 'daybook'];
  if (key === 'purchase') return ['beejaks', 'gaadis'];
  if (key === 'bhada_in') return ['gaadis'];
  if (key === 'creditors') return ['beejaks', 'gaadis', 'daybook', 'supplierOpenings', 'vouchers'];
  if (key === 'cnote') return ['vouchers'];
  if (key.startsWith('bj:')) return ['beejaks'];
  if (key.startsWith('h:')) return ['daybook', 'headOpenings', 'vouchers'];
  if (key.startsWith('b:')) return ['daybook', 'vouchers'];
  if (key.startsWith('g:')) return ['bills', 'cols', 'udhaar'];
  return Object.keys(FRAGMENTS) as Fragment[];
}
// $2 and $3 are named once here too, so a source list that doesn't use them still types them.
const postingsSql = (from: Fragment[]) =>
  `SELECT * FROM (${from.map((f) => FRAGMENTS[f]).join('\nUNION ALL\n')}) p
   WHERE p.acct IS NOT NULL AND (p.dr <> 0 OR p.cr <> 0) AND $2::text[] IS NOT NULL AND $3::boolean IS NOT NULL`;

const BUILTIN_NAME = new Map(BUILTIN_HEADS.map((h) => [h.key, h.name]));
const BEEJAK_NAME: Record<string, string> = {
  commission: 'Commission', association: 'Association', loading: 'Loading', labour: 'Labour (beejak)', bardana: 'Bardana', freight: 'Bhada (beejak)',
  dak: 'Dak', bank: 'Bank charges', crate: 'Crate', store: 'Store', custom: 'Custom', other: 'Other',
};

/**
 * The backup's sheets: every table of the shop's books, a page at a time by id. Names joined in
 * where a row only holds an id; a slip or raseed says whether it was deleted.
 */
const BACKUP: { sheet: string; sql: string }[] = [
  { sheet: 'Company', sql: `SELECT s.id, s.name, s.mandi, s.shop_no, s.phad, s.gstin, s.commodity, s.phone, s.address, s.licence_no, s.company_code, s.contact_person, s.email, s.bank_accounts
    FROM shops s WHERE s.id = nullif(current_setting('app.shop_id', true), '')::uuid` },
  { sheet: 'Grahak', sql: `SELECT g.*, (SELECT COALESCE(SUM(lb.total_paise - lb.paid_paise), 0) FROM ${LIVE_BILLS} lb WHERE lb.buyer_id = g.id AND lb.total_paise > lb.paid_paise)
      + (SELECT COALESCE(SUM(u.amount_paise), 0) FROM udhaar_entries u WHERE u.buyer_id = g.id)
      - (SELECT COALESCE(SUM(lc.amount_paise), 0) FROM ${LIVE_COLS} lc WHERE lc.buyer_id = g.id) AS baaki_paise FROM buyers g` },
  { sheet: 'Supplier', sql: `SELECT * FROM supplier_phones` },
  { sheet: 'Gaadi', sql: `SELECT * FROM trucks` },
  { sheet: 'Gaadi maal', sql: `SELECT g.*, t.number AS gaadi, br.name AS maal FROM truck_grades g LEFT JOIN trucks t ON t.id = g.truck_id LEFT JOIN brands br ON br.id = g.brand_id` },
  { sheet: 'Parchi', sql: `SELECT b.*, (SELECT v.reason FROM bill_voids v WHERE v.bill_id = b.id LIMIT 1) AS delete_reason FROM bills b` },
  { sheet: 'Parchi maal', sql: `SELECT l.*, br.name AS maal, t.number AS gaadi FROM bill_lines l LEFT JOIN brands br ON br.id = l.brand_id LEFT JOIN trucks t ON t.id = l.truck_id` },
  { sheet: 'Parchi delete', sql: `SELECT * FROM bill_voids` },
  { sheet: 'Vasooli', sql: `SELECT c.*, g.name AS grahak, (SELECT v.reason FROM collection_voids v WHERE v.collection_id = c.id LIMIT 1) AS delete_reason
    FROM collections c LEFT JOIN buyers g ON g.id = c.buyer_id` },
  { sheet: 'Udhaar', sql: `SELECT u.*, g.name AS grahak FROM udhaar_entries u LEFT JOIN buyers g ON g.id = u.buyer_id` },
  { sheet: 'Day Book', sql: `SELECT * FROM daybook_entries` },
  { sheet: 'Beejak', sql: `SELECT * FROM beejaks` },
  { sheet: 'Bank jama', sql: `SELECT * FROM deposit_slips` },
  { sheet: 'Journal voucher', sql: `SELECT * FROM journal_vouchers` },
  { sheet: 'Credit note', sql: `SELECT c.*, g.name AS grahak FROM credit_notes c LEFT JOIN buyers g ON g.id = c.buyer_id` },
  { sheet: 'Tax invoice', sql: `SELECT i.id, i.number, i.day, i.buyer_name, i.total_paise, i.bill_ids, i.voided_at, i.void_reason, i.created_at FROM tax_invoices i` },
  { sheet: 'Cheque', sql: `SELECT d.*, g.name AS grahak FROM deposit_cheques d LEFT JOIN buyers g ON g.id = d.buyer_id` },
  { sheet: 'Crate type', sql: `SELECT * FROM crate_types` },
  { sheet: 'Crate in-out', sql: `SELECT m.*, t.name AS crate, g.name AS grahak FROM crate_moves m LEFT JOIN crate_types t ON t.id = m.crate_type_id LEFT JOIN buyers g ON g.id = m.buyer_id` },
  { sheet: 'Store', sql: `SELECT * FROM stores` },
  { sheet: 'Store in-out', sql: `SELECT m.*, s.name AS store, t.number AS gaadi, br.name AS maal FROM store_moves m LEFT JOIN stores s ON s.id = m.store_id
    LEFT JOIN trucks t ON t.id = m.truck_id LEFT JOIN brands br ON br.id = m.brand_id` },
  { sheet: 'Maal (product)', sql: `SELECT b.*, pg.name AS product_group FROM brands b LEFT JOIN brand_groups bg ON bg.brand_id = b.id LEFT JOIN product_groups pg ON pg.id = bg.group_id` },
  { sheet: 'Product group', sql: `SELECT * FROM product_groups` },
  { sheet: 'Area', sql: `SELECT * FROM areas` },
  { sheet: 'Ledger heads', sql: `SELECT * FROM ledger_heads` },
  { sheet: 'Phoota-store', sql: `SELECT s.*, t.number AS gaadi, br.name AS maal FROM spoilage s LEFT JOIN trucks t ON t.id = s.truck_id LEFT JOIN brands br ON br.id = s.brand_id` },
  { sheet: 'Mazdoori adjustment', sql: `SELECT * FROM labour_adjustments` },
  { sheet: 'Dispatch', sql: `SELECT * FROM pickups` },
  { sheet: 'Bhav', sql: `SELECT r.*, br.name AS maal FROM rates r LEFT JOIN brands br ON br.id = r.brand_id` },
];
/** Bookkeeping columns nobody reads in a backup. */
const SKIP = new Set(['shop_id', 'device_id', 'created_by', 'received_at']);
const PAGE = 2000;
/** Dates and times as Postgres writes them (the session in IST), never through a JS Date. */
const RAW = new Set([1082, 1114, 1184]);
const backupTypes = { getTypeParser: ((oid: number, format?: 'text' | 'binary') => (RAW.has(oid) ? (v: string) => v : pgTypes.getTypeParser(oid, format ?? 'text'))) as typeof pgTypes.getTypeParser };

@Injectable()
export class BooksService {
  constructor(private readonly db: Db, private readonly reports: ReportsService, private readonly creditors: CreditorsService) {}

  private async grapes(shopId: string) {
    const s = await this.db.one<{ commodity: string }>(`SELECT commodity FROM shops WHERE id = $1`, [shopId]);
    if (!s) throw new NotFoundException('Dukaan nahi mili');
    return s.commodity === 'angoor';
  }

  /** What an account is: its name, its group, and whether it closes into the year's P&L. */
  private describe(key: string, grapes: boolean, heads: Map<string, { name: string; type: HeadType }>): Acct {
    const fixed: Record<string, [string, Group, boolean]> = {
      'pot:galla': ['Galla (cash)', 'cash', false], 'pot:office': ['Office cash', 'cash', false], 'pot:bank': ['Bank', 'bank', false],
      sales: ['Bikri', 'sales', true], purchase: [grapes ? 'Kharid (beejak)' : 'Kharid (gaadi)', 'purchase', true], bhada_in: ['Gaadi bhada', 'purchase', true],
      apmc: ['APMC', 'liabilities', false], chungi: ['Chungi', 'liabilities', false], labour: ['Mazdoori dena', 'liabilities', false],
      mazdoori: ['Mazdoori', 'expense', true], creditors: ['Sundry creditors', 'creditors', false],
      cnote: ['Credit note (bikri kam)', 'sales', true],
      'b:committee': ['Committee', 'assets', false], 'b:udhaar_diya': ['Udhaar diya (loan)', 'assets', false],
      capital: ['Pichhle saalon ka munafa', 'capital', false],
    };
    if (fixed[key]) { const [name, group, pl] = fixed[key]; return { key, name, group, pl }; }
    if (key.startsWith('diff:')) return { key, name: DIFF[key] ?? key.slice(5), group: 'suspense', pl: false };
    if (key.startsWith('bj:')) return { key, name: BEEJAK_NAME[key.slice(3)] ?? key.slice(3), group: 'income', pl: true };
    if (key.startsWith('h:')) {
      const h = heads.get(key.slice(2));
      const type = h?.type ?? 'expense';
      return { key, name: h?.name ?? key, group: type === 'expense' ? 'expense' : type === 'income' ? 'income' : type === 'asset' ? 'assets' : 'liabilities', pl: type === 'expense' || type === 'income' };
    }
    if (key.startsWith('b:')) {
      const cat = key.slice(2);
      const b = BUILTIN_HEADS.find((x) => x.key === cat);
      return { key, name: BUILTIN_NAME.get(cat) ?? cat, group: b?.type === 'income' ? 'income' : 'expense', pl: true };
    }
    return { key, name: key, group: 'suspense', pl: false };
  }

  private async customHeads(tx: Tx) {
    const rows = (await tx.query<{ id: string; name: string; type: HeadType; hidden: boolean }>(`SELECT id, name, type, hidden FROM ledger_heads ORDER BY hidden, name`)).rows;
    return { rows, map: new Map(rows.map((h) => [h.id, { name: h.name, type: h.type }])) };
  }

  // ---------------------------------------------------------------- General Ledger

  /** Every account the General Ledger can open, in the Trial Balance's groups. */
  async accounts(shopId: string) {
    const grapes = await this.grapes(shopId);
    return this.db.withShop(shopId, async (tx) => {
      const heads = await this.customHeads(tx);
      const keys = [
        'pot:galla', 'pot:office', 'pot:bank', 'sales', 'cnote', 'purchase', ...(grapes ? [] : ['bhada_in']), 'apmc', 'chungi', 'mazdoori', 'labour', 'creditors',
        ...BUILTIN_HEADS.filter((h) => !TRANSFERS.includes(h.key) && !['supplier', 'mazdoori', ...Object.keys(PAIRED)].includes(h.key)).map((h) => `b:${h.key}`),
        'b:committee', 'b:udhaar_diya',
        ...heads.rows.map((h) => `h:${h.id}`),
        ...(grapes ? BEEJAK_HEADS.map((h) => `bj:${h.key}`) : []),
        ...Object.keys(DIFF),
      ];
      return { accounts: keys.map((k) => ({ ...this.describe(k, grapes, heads.map), hidden: k.startsWith('h:') ? heads.rows.find((h) => `h:${h.id}` === k)!.hidden : false })) };
    });
  }

  /**
   * One account over business dates [from, to]: the balance brought forward (a P&L account from
   * the start of [from]'s financial year, as Tally starts it again each April), every entry with a
   * running balance (Dr +), and the closing. Cash and Bank are the Cash/Bank Book itself.
   * [daily] folds each day's entries into one line (a year of bikri is thousands of slips).
   */
  async ledger(shopId: string, key: string, from: string, to: string, daily: boolean) {
    if (from > to) throw new BadRequestException('from must be on or before to');
    const grapes = await this.grapes(shopId);
    if (key.startsWith('pot:')) {
      const pot = key.slice(4) as Pot;
      if (!POTS.includes(pot)) throw new NotFoundException('Khata nahi mila');
      const b = await this.reports.cashbook(shopId, pot, from, to);
      const lines = b.lines.map((l) => ({ id: l.id, date: l.date, kind: l.kind === 'bikri' || l.kind === 'vasooli' ? 'day' : 'daybook', ref: null, ref2: null,
        title: l.kind === 'in' || l.kind === 'out' ? (BUILTIN_NAME.get(l.title) ?? l.title) : l.title, detail: [l.party, l.note].filter(Boolean).join(' · '),
        debitPaise: l.inPaise, creditPaise: l.outPaise, balancePaise: l.balancePaise, count: 1 }));
      return { ...this.describe(key, grapes, new Map()), from, to, openingPaise: b.openingPaise, debitPaise: b.inPaise, creditPaise: b.outPaise, closingPaise: b.closingPaise, lines };
    }
    return this.db.withShop(shopId, async (tx) => {
      const heads = await this.customHeads(tx);
      const acct = this.describe(key, grapes, heads.map);
      if (key.startsWith('h:') && !heads.map.has(key.slice(2))) throw new NotFoundException('Khata nahi mila');
      const since = acct.pl ? fyRange(fyOf(from)).from : '0001-01-01';
      const sql = postingsSql(sourcesOf(key));
      const opening = n((await tx.query<{ s: string }>(
        `SELECT COALESCE(SUM(dr - cr), 0) AS s FROM (${sql}) q WHERE q.acct = $4 AND q.day < $5 AND q.day >= $6::date`,
        [to, OPENING_NOTES, grapes, key, from, since])).rows[0].s);
      const rows = (await tx.query<Posting>(daily
        ? `SELECT day::text AS day, acct, SUM(dr) AS dr, SUM(cr) AS cr, 'day' AS kind, NULL AS ref, NULL AS ref2, '' AS title, '' AS detail, COUNT(*) AS n
           FROM (${sql}) q WHERE q.acct = $4 AND q.day >= $5 GROUP BY day, acct ORDER BY day`
        : `SELECT day::text AS day, acct, dr, cr, kind, ref, ref2, title, detail FROM (${sql}) q WHERE q.acct = $4 AND q.day >= $5 ORDER BY day, at`,
        [to, OPENING_NOTES, grapes, key, from])).rows;
      let bal = opening;
      const lines = rows.map((r, i) => {
        const dr = n(r.dr), cr = n(r.cr);
        const title = r.kind === 'day' ? `${n(r.n)} entry` : r.kind === 'daybook' ? (BUILTIN_NAME.get(r.title) ?? r.title) : r.title;
        return { id: r.ref ?? `${r.day}-${i}`, date: r.day, kind: r.kind, ref: r.ref, ref2: r.ref2, title, detail: r.detail,
          debitPaise: dr, creditPaise: cr, balancePaise: (bal += dr - cr), count: n(r.n ?? 1) };
      });
      return { ...acct, from, to, openingPaise: opening,
        debitPaise: lines.reduce((s, l) => s + l.debitPaise, 0), creditPaise: lines.reduce((s, l) => s + l.creditPaise, 0), closingPaise: bal, lines };
    });
  }

  // ---------------------------------------------------------------- Trial Balance

  /**
   * Trial Balance as on [on]: every ledger's closing, Dr or Cr. The financial year runs from
   * 1 April; a P&L ledger shows only this year, what it earned or cost before folded into
   * "Pichhle saalon ka munafa".
   *
   * Method: the books are single-entry (slips, raseeds, a Day Book), so each entry is written as
   * the balanced postings described on this class. The ledgers that have their own report are
   * then held to it — Cash/Bank to the Cash/Bank Book's closing for that day (which starts again
   * from a stated opening), each grahak to their khata (BALANCES), the suppliers to Supplier
   * creditors (grapes) or Supplier Khata (others). What the books hold with nothing on the other
   * side is not hidden or spread over other ledgers: it is the "Difference in opening / suspense"
   * group, line by line (grahak purana udhaar, supplier/head/cash openings, entries whose two
   * sides don't meet). So the Dr and Cr totals agree, and the difference says exactly why.
   */
  async trialBalance(shopId: string, on: string) {
    const grapes = await this.grapes(shopId);
    const fy = fyRange(fyOf(on));
    const books = await Promise.all(POTS.map(async (p) => [p, (await this.reports.cashbook(shopId, p, on, on)).closingPaise] as const));
    return this.db.withShop(shopId, async (tx) => {
      const heads = await this.customHeads(tx);
      const sums = (await tx.query<{ acct: string; before: string; dr: string; cr: string }>(
        `SELECT acct, COALESCE(SUM(dr - cr) FILTER (WHERE day < $4), 0) AS before, COALESCE(SUM(dr) FILTER (WHERE day >= $4), 0) AS dr,
                COALESCE(SUM(cr) FILTER (WHERE day >= $4), 0) AS cr
         FROM (${postingsSql(Object.keys(FRAGMENTS) as Fragment[])}) q GROUP BY acct`, [on, OPENING_NOTES, grapes, fy.from])).rows;
      const bal = new Map<string, { before: number; dr: number; cr: number }>();
      for (const s of sums) bal.set(s.acct, { before: n(s.before), dr: n(s.dr), cr: n(s.cr) });
      const add = (k: string, paise: number) => { if (!paise) return; const b = bal.get(k) ?? { before: 0, dr: 0, cr: 0 }; b.before += paise; bal.set(k, b); };
      const closing = (k: string) => { const b = bal.get(k); return b ? b.before + b.dr - b.cr : 0; };

      // Cash/Bank: the book's own closing; a stated opening is the difference.
      for (const [p, book] of books) { const d = book - closing(`pot:${p}`); add(`pot:${p}`, d); add('diff:opening_cash', -d); }

      // Suppliers, each as their own report has them on that day.
      let suppliers: { key: string; name: string; balance: number }[];
      if (grapes) {
        suppliers = (await this.creditors.books(tx)).map((p) => ({ key: p.key, name: p.name,
          balance: -p.moves.filter((m) => m.at <= on).reduce((t, m) => t + m.creditPaise - m.debitPaise, 0) }));
      } else {
        suppliers = (await this.reports.supplierBooks(tx)).map((s) => ({ key: s.key, name: s.name,
          balance: -((s.opening && s.opening.date <= on ? s.opening.paise : 0)
            + s.gaadis.filter((g) => istDay(g.arrivedAt) <= on).reduce((t, g) => t + g.purchasePaise, 0) - s.payments.filter((x) => x.date <= on).reduce((t, x) => t + x.amountPaise, 0)
            - s.jvs.filter((j) => j.date <= on).reduce((t, j) => t + j.amountPaise, 0)) }));
      }
      const owed = suppliers.reduce((t, s) => t + s.balance, 0);
      if (owed !== closing('creditors')) { const d = owed - closing('creditors'); add('creditors', d); add('diff:other', -d); }

      // Grahak and laddan parties, one by one.
      const people = (await tx.query<{ id: string; name: string; code: string; kind: string; area: string; hidden: boolean }>(
        `SELECT id, name, code, kind, area, hidden FROM buyers`)).rows;
      const who = new Map(people.map((p) => [p.id, p]));

      type Row = { key: string; name: string; dr: number; cr: number; sub?: string; link?: { kind: 'grahak' | 'supplier' | 'ledger'; id: string } };
      const groups = new Map<Group, Row[]>(GROUPS.map((g) => [g.key, []]));
      let pl = 0;
      const put = (g: Group, r: Row) => { if (r.dr || r.cr) groups.get(g)!.push(r); };
      const side = (paise: number) => ({ dr: Math.max(0, paise), cr: Math.max(0, -paise) });
      for (const [k, b] of bal) {
        if (k.startsWith('g:')) {
          const p = who.get(k.slice(2));
          put(p?.kind === 'laddan' ? 'laddan' : 'debtors', { key: k, name: p?.name ?? '?', sub: [p?.code, p?.area].filter(Boolean).join(' · '), ...side(b.before + b.dr - b.cr), link: { kind: 'grahak', id: k.slice(2) } });
          continue;
        }
        if (k === 'creditors') continue;
        const a = this.describe(k, grapes, heads.map);
        if (a.pl) pl += b.before;
        put(a.group, { key: k, name: a.name, ...side(a.pl ? b.dr - b.cr : b.before + b.dr - b.cr), link: { kind: 'ledger', id: k } });
      }
      for (const s of suppliers) put('creditors', { key: `s:${s.key}`, name: s.name, ...side(s.balance), link: { kind: 'supplier', id: s.key } });
      put('capital', { key: 'capital', name: 'Pichhle saalon ka munafa', ...side(pl) });

      const out = GROUPS.map((g) => {
        const rows = groups.get(g.key)!.sort((a, b) => (g.key === 'debtors' || g.key === 'laddan' || g.key === 'creditors' ? b.dr + b.cr - a.dr - a.cr : 0) || a.name.localeCompare(b.name));
        return { key: g.key, name: g.name, dr: rows.reduce((t, r) => t + r.dr, 0), cr: rows.reduce((t, r) => t + r.cr, 0), rows };
      }).filter((g) => g.rows.length);
      const dr = out.reduce((t, g) => t + g.dr, 0), cr = out.reduce((t, g) => t + g.cr, 0);
      const suspense = out.find((g) => g.key === 'suspense');
      // Crates out and not back, at their deposit: worth knowing, not a ledger.
      const crates = (await tx.query<{ qty: string; value: string }>(
        `SELECT COALESCE(SUM(CASE m.dir WHEN 'out' THEN m.qty ELSE -m.qty END), 0) AS qty,
                COALESCE(SUM(CASE m.dir WHEN 'out' THEN m.qty ELSE -m.qty END * t.deposit_paise), 0) AS value
         FROM crate_moves m JOIN crate_types t ON t.id = m.crate_type_id WHERE m.day <= $1`, [on])).rows[0];
      return {
        on, fy: { from: fy.from, label: fy.label }, grapes, groups: out, totals: { dr, cr },
        differencePaise: suspense ? suspense.dr - suspense.cr : 0,
        memo: { cratesQty: n(crates.qty), cratesPaise: n(crates.value) },
      };
    });
  }

  // ---------------------------------------------------------------- Ledger Multiple, Schedule, Chithi

  /** Every grahak and laddan party with area, mobile and baaki as on [on]: the pick list and the debtors' schedule. */
  async parties(shopId: string, on: string) {
    return this.db.withShop(shopId, async (tx) => {
      const rows = (await tx.query<{ id: string; code: string; name: string; kind: string; area: string; phone: string; address: string; city: string; hidden: boolean; bal: string | null }>(
        `SELECT g.id, g.code, g.name, g.kind, g.area, g.phone, g.address, g.city, g.hidden, x.bal
         FROM buyers g LEFT JOIN (
           SELECT buyer_id, SUM(amt) AS bal FROM (
             SELECT buyer_id, total_paise - paid_paise AS amt FROM ${LIVE_BILLS} lb WHERE buyer_id IS NOT NULL AND total_paise > paid_paise AND business_date <= $1
             UNION ALL SELECT buyer_id, amount_paise FROM udhaar_entries WHERE business_date <= $1
             UNION ALL SELECT buyer_id, -amount_paise FROM ${LIVE_COLS} lc WHERE business_date <= $1
           ) y GROUP BY buyer_id) x ON x.buyer_id = g.id
         ORDER BY g.hidden, g.code = '', g.code, g.name`, [on])).rows;
      return { on, parties: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, kind: r.kind, area: (r.area ?? '').trim().toUpperCase(), phone: r.phone,
        address: [r.address, r.city].filter(Boolean).join(', '), hidden: r.hidden, balancePaise: n(r.bal) })) };
    });
  }

  // ---------------------------------------------------------------- Transactions above ₹X

  /**
   * Every parchi, vasooli, supplier payment, Day Book line and bank jama slip of [min] or more in
   * business dates [from, to], with its cash / UPI-bank / udhaar / office parts (the ₹2 lakh cash
   * rule is about the cash); and month-wise, each party's total per kind per month at [min] or more.
   */
  async big(shopId: string, from: string, to: string, min: number) {
    if (from > to) throw new BadRequestException('from must be on or before to');
    return this.db.withShop(shopId, async (tx) => {
      const sql = `
        SELECT 'parchi' AS type, lb.id, lb.buyer_id AS party_id, lb.business_date::text AS day, lb.created_at AS at, COALESCE(g.name, lb.buyer_name) AS party,
               'Parchi ' || COALESCE(lb.slip_no::text, lb.number) AS title, lb.total_paise AS amount, lb.cash_paise AS cash, lb.upi_paise AS upi,
               GREATEST(lb.total_paise - lb.paid_paise, 0) AS udhaar, 0::bigint AS office
        FROM ${LIVE_BILLS} lb LEFT JOIN buyers g ON g.id = lb.buyer_id WHERE lb.business_date BETWEEN $1 AND $2
        UNION ALL
        SELECT 'vasooli', lc.id, lc.buyer_id, lc.business_date::text, lc.created_at, COALESCE(g.name, ''), COALESCE('Raseed ' || lc.receipt_no, 'Vasooli'), lc.amount_paise,
               ${CASH_PART.replace(/\b(cash_paise|upi_paise|pay_mode|amount_paise)\b/g, 'lc.$1')}, ${UPI_PART.replace(/\b(cash_paise|upi_paise|pay_mode|amount_paise)\b/g, 'lc.$1')}, 0, 0
        FROM ${LIVE_COLS} lc LEFT JOIN buyers g ON g.id = lc.buyer_id WHERE lc.business_date BETWEEN $1 AND $2
        UNION ALL
        SELECT CASE WHEN e.category = 'supplier' THEN 'supplier' ELSE 'daybook' END, e.id, NULL, e.business_date::text, e.created_at,
               COALESCE(NULLIF(trim(e.party_name), ''), e.category), e.direction || ':' || e.category, e.amount_paise,
               CASE WHEN e.mode = 'cash' THEN e.amount_paise ELSE 0 END, CASE WHEN e.mode IN ('upi', 'bank') THEN e.amount_paise ELSE 0 END, 0,
               CASE WHEN e.mode = 'office' THEN e.amount_paise ELSE 0 END
        FROM daybook_entries e WHERE e.hidden = false AND e.category <> 'opening' AND e.business_date BETWEEN $1 AND $2
          AND NOT EXISTS (SELECT 1 FROM deposit_slips d WHERE d.daybook_id = e.id AND d.voided_at IS NULL)
        UNION ALL
        SELECT 'bankjama', s.id, NULL, s.day::text, s.created_at, COALESCE(NULLIF(s.account->>'bank', ''), 'Bank'), 'Jama parchi ' || s.slip_no,
               s.cash_paise + COALESCE(c.amt, 0), s.cash_paise, COALESCE(c.amt, 0), 0, 0
        FROM deposit_slips s LEFT JOIN (SELECT slip_id, SUM(amount_paise) AS amt FROM deposit_cheques GROUP BY slip_id) c ON c.slip_id = s.id
        WHERE s.voided_at IS NULL AND s.day BETWEEN $1 AND $2`;
      type R = { type: string; id: string; party_id: string | null; day: string; at: Date; party: string; title: string; amount: string; cash: string; upi: string; udhaar: string; office: string };
      const view = (r: R) => ({ type: r.type, id: r.id, partyId: r.party_id, date: r.day, at: r.at.toISOString(), party: r.party, title: r.title,
        amountPaise: n(r.amount), cashPaise: n(r.cash), upiPaise: n(r.upi), udhaarPaise: n(r.udhaar), officePaise: n(r.office) });
      const rows = (await tx.query<R>(`SELECT * FROM (${sql}) x WHERE amount >= $3 ORDER BY amount DESC, at`, [from, to, min])).rows.map(view);
      const months = (await tx.query<{ type: string; party_id: string | null; party: string; month: string; n: string; amount: string; cash: string; upi: string; udhaar: string; office: string }>(
        `SELECT type, party_id, MIN(party) AS party, to_char(day::date, 'YYYY-MM') AS month, COUNT(*) AS n, SUM(amount) AS amount, SUM(cash) AS cash, SUM(upi) AS upi,
                SUM(udhaar) AS udhaar, SUM(office) AS office
         FROM (${sql}) x GROUP BY type, party_id, COALESCE(party_id::text, upper(trim(party))), to_char(day::date, 'YYYY-MM')
         HAVING SUM(amount) >= $3 ORDER BY month, SUM(amount) DESC`, [from, to, min])).rows
        .map((r) => ({ type: r.type, partyId: r.party_id, party: r.party, month: r.month, entries: n(r.n), amountPaise: n(r.amount), cashPaise: n(r.cash),
          upiPaise: n(r.upi), udhaarPaise: n(r.udhaar), officePaise: n(r.office) }));
      return { from, to, minPaise: min, rows, months };
    });
  }

  // ---------------------------------------------------------------- Sale Purchase Summary

  /**
   * Per day or month of [from, to]: kharid (gaadi kharid by the day it came, beejak to the party
   * for grapes), bikri, and Munafa's own lines — laagat of what sold and broke, kul munafa,
   * kharcha, other income, shuddh munafa — with the same SQL constants Munafa uses, so the
   * totals are the Munafa report's. Then per supplier and per quality.
   */
  async salePurchase(shopId: string, from: string, to: string, by: 'day' | 'month') {
    if (from > to) throw new BadRequestException('from must be on or before to');
    const grapes = await this.grapes(shopId);
    const bucket = (col: string) => (by === 'day' ? `${col}::text` : `to_char(${col}, 'YYYY-MM')`);
    return this.db.withShop(shopId, async (tx) => {
      const q = async (sql: string, params: unknown[] = [from, to]) => (await tx.query<{ b: string; s: string; k?: string; d?: string }>(sql, params)).rows;
      const sales = await q(`SELECT ${bucket('lb.business_date')} AS b, SUM(lb.total_paise) AS s FROM ${LIVE_BILLS} lb WHERE lb.business_date BETWEEN $1 AND $2 GROUP BY 1`);
      const cogs = await q(`SELECT ${bucket('lb.business_date')} AS b, SUM(l.qty * tc.cost::numeric / NULLIF(tc.recv, 0)) AS s
        FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id JOIN (${TRUCK_COST}) tc ON tc.id = l.truck_id WHERE lb.business_date BETWEEN $1 AND $2 GROUP BY 1`);
      const spoiled = await q(`SELECT ${bucket('s.business_date')} AS b, SUM(s.qty * tc.cost::numeric / NULLIF(tc.recv, 0)) AS s
        FROM spoilage s JOIN (${TRUCK_COST}) tc ON tc.id = s.truck_id WHERE s.kind = 'spoiled' AND s.business_date BETWEEN $1 AND $2 GROUP BY 1`);
      const labour = await q(`SELECT b, SUM(s) AS s FROM (
          SELECT ${bucket('lb.business_date')} AS b, lb.labour_paise AS s FROM ${LIVE_BILLS} lb WHERE lb.business_date BETWEEN $1 AND $2
          UNION ALL SELECT ${bucket('a.business_date')}, a.amount_paise FROM labour_adjustments a WHERE a.hidden = false AND a.business_date BETWEEN $1 AND $2) x GROUP BY b`);
      const heads = await q(`SELECT ${bucket('business_date')} AS b, direction AS d, category AS k, SUM(amount_paise) AS s FROM daybook_entries
        WHERE hidden = false AND business_date BETWEEN $1 AND $2 AND NOT (category = ANY($3)) AND category NOT IN ('udhaar_wapas', 'committee_mili') GROUP BY 1, 2, 3`, [from, to, NOT_EXPENSE]);
      const kharid = await q(`SELECT ${bucket(IST_DAY('t.arrived_at'))} AS b,
          SUM(GREATEST(0, COALESCE(g.goods, 0) - CASE WHEN COALESCE(g.billed, 0) > 0 AND COALESCE(sp.corrected, 0) > 0
                THEN ROUND(g.goods::numeric * sp.corrected / g.billed) ELSE 0 END) + t.freight_paise) AS s
        FROM trucks t
        LEFT JOIN (SELECT truck_id, SUM(billed_qty) billed, SUM(billed_qty::bigint * rate_paise) goods FROM truck_grades GROUP BY truck_id) g ON g.truck_id = t.id
        LEFT JOIN (SELECT truck_id, SUM(qty) corrected FROM spoilage WHERE kind = 'correction' GROUP BY truck_id) sp ON sp.truck_id = t.id
        WHERE ${IST_DAY('t.arrived_at')} BETWEEN $1 AND $2 GROUP BY 1`);
      const beejak = await q(`SELECT ${bucket('day')} AS b, SUM(net_paise) AS s FROM beejaks WHERE day BETWEEN $1 AND $2 GROUP BY 1`);

      const keys = [...new Set([sales, cogs, spoiled, labour, heads, kharid, beejak].flatMap((r) => r.map((x) => x.b)))].sort();
      const at = (rows: { b: string; s: string }[]) => new Map(rows.map((r) => [r.b, Number(r.s ?? 0)]));
      const S = at(sales), C = at(cogs), P = at(spoiled), L = at(labour), K = at(kharid), B = at(beejak);
      const exp = new Map<string, number>(), inc = new Map<string, number>();
      for (const h of heads) { const m = h.d === 'out' ? exp : inc; m.set(h.b, (m.get(h.b) ?? 0) + n(h.s)); }
      const raw = keys.map((k) => {
        const sale = S.get(k) ?? 0, laagat = (C.get(k) ?? 0) + (P.get(k) ?? 0), kharcha = (L.get(k) ?? 0) + (exp.get(k) ?? 0), other = inc.get(k) ?? 0;
        return { key: k, kharid: K.get(k) ?? 0, beejak: B.get(k) ?? 0, sales: sale, cogs: C.get(k) ?? 0, spoiled: P.get(k) ?? 0, laagat, kharcha, other };
      });
      const r0 = (x: number) => Math.round(x);
      const rows = raw.map((r) => ({ key: r.key, kharidPaise: r0(r.kharid), beejakPaise: r0(r.beejak), salesPaise: r0(r.sales), laagatPaise: r0(r.laagat),
        grossPaise: r0(r.sales - r.laagat), kharchaPaise: r0(r.kharcha), otherPaise: r0(r.other), netPaise: r0(r.sales - r.laagat - r.kharcha + r.other) }));
      // Totals as Munafa sums them: each part over the whole period, rounded once.
      const sum = (f: (r: (typeof raw)[number]) => number) => raw.reduce((t, r) => t + f(r), 0);
      // Munafa casts each numeric sum to bigint, which rounds.
      const cogsT = Math.round(sum((r) => r.cogs)), spoiledT = Math.round(sum((r) => r.spoiled));
      const salesT = sum((r) => r.sales), kharchaT = sum((r) => r.kharcha), otherT = sum((r) => r.other);
      const totals = { kharidPaise: r0(sum((r) => r.kharid)), beejakPaise: r0(sum((r) => r.beejak)), salesPaise: salesT, laagatPaise: cogsT + spoiledT,
        grossPaise: salesT - cogsT - spoiledT, kharchaPaise: kharchaT, otherPaise: otherT, netPaise: salesT - cogsT - spoiledT - kharchaT + otherT };

      // Per supplier: gaadis that came, what they cost, beejaks made, and what their maal sold for in the period.
      const came = (await tx.query<{ supplier: string; gaadis: string; boxes: string; kharid: string }>(
        `SELECT trim(t.supplier) AS supplier, COUNT(*) AS gaadis, SUM(COALESCE(g.recv, 0)) AS boxes,
                SUM(GREATEST(0, COALESCE(g.goods, 0) - CASE WHEN COALESCE(g.billed, 0) > 0 AND COALESCE(sp.corrected, 0) > 0
                      THEN ROUND(g.goods::numeric * sp.corrected / g.billed) ELSE 0 END) + t.freight_paise) AS kharid
         FROM trucks t
         LEFT JOIN (SELECT truck_id, SUM(billed_qty) billed, SUM(received_qty) recv, SUM(billed_qty::bigint * rate_paise) goods FROM truck_grades GROUP BY truck_id) g ON g.truck_id = t.id
         LEFT JOIN (SELECT truck_id, SUM(qty) corrected FROM spoilage WHERE kind = 'correction' GROUP BY truck_id) sp ON sp.truck_id = t.id
         WHERE ${IST_DAY('t.arrived_at')} BETWEEN $1 AND $2 GROUP BY 1`, [from, to])).rows;
      const sold = (await tx.query<{ supplier: string; qty: string; amount: string }>(
        `SELECT trim(t.supplier) AS supplier, SUM(l.qty) AS qty, SUM(l.qty::bigint * l.rate_paise) AS amount
         FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id JOIN trucks t ON t.id = l.truck_id
         WHERE lb.business_date BETWEEN $1 AND $2 GROUP BY 1`, [from, to])).rows;
      const bj = (await tx.query<{ party: string; n: string; boxes: string; net: string }>(
        `SELECT trim(party) AS party, COUNT(*) AS n, SUM(boxes) AS boxes, SUM(net_paise) AS net FROM beejaks WHERE day BETWEEN $1 AND $2 GROUP BY 1`, [from, to])).rows;
      const sup = new Map<string, { key: string; name: string; gaadis: number; boxesIn: number; kharidPaise: number; beejaks: number; beejakPaise: number; soldQty: number; salesPaise: number }>();
      const one = (name: string) => {
        const k = nameKey(name) || '-';
        return sup.get(k) ?? sup.set(k, { key: k === '-' ? '' : k, name: name || '—', gaadis: 0, boxesIn: 0, kharidPaise: 0, beejaks: 0, beejakPaise: 0, soldQty: 0, salesPaise: 0 }).get(k)!;
      };
      for (const r of came) { const s = one(r.supplier); s.gaadis += n(r.gaadis); s.boxesIn += n(r.boxes); s.kharidPaise += n(r.kharid); }
      for (const r of sold) { const s = one(r.supplier); s.soldQty += n(r.qty); s.salesPaise += n(r.amount); }
      for (const r of bj) { const s = one(r.party); s.beejaks += n(r.n); s.beejakPaise += n(r.net); }

      // Per quality: what came in (gaadis that arrived in the period) and what sold.
      const qIn = (await tx.query<{ q: string | null; qty: string; amount: string }>(
        `SELECT br.name AS q, SUM(g.received_qty) AS qty, SUM(g.billed_qty::bigint * g.rate_paise) AS amount
         FROM truck_grades g JOIN trucks t ON t.id = g.truck_id LEFT JOIN brands br ON br.id = g.brand_id
         WHERE ${IST_DAY('t.arrived_at')} BETWEEN $1 AND $2 AND NOT EXISTS (SELECT 1 FROM store_sync x WHERE x.id = g.id) GROUP BY 1`, [from, to])).rows;
      const qOut = (await tx.query<{ q: string | null; qty: string; amount: string }>(
        `SELECT br.name AS q, SUM(l.qty) AS qty, SUM(l.qty::bigint * l.rate_paise) AS amount
         FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id LEFT JOIN brands br ON br.id = l.brand_id
         WHERE lb.business_date BETWEEN $1 AND $2 GROUP BY 1`, [from, to])).rows;
      const qual = new Map<string, { name: string; inQty: number; inPaise: number; soldQty: number; salesPaise: number }>();
      const qq = (name: string | null) => { const k = name ?? 'Maal'; return qual.get(k) ?? qual.set(k, { name: k, inQty: 0, inPaise: 0, soldQty: 0, salesPaise: 0 }).get(k)!; };
      for (const r of qIn) { const x = qq(r.q); x.inQty += n(r.qty); x.inPaise += n(r.amount); }
      for (const r of qOut) { const x = qq(r.q); x.soldQty += n(r.qty); x.salesPaise += n(r.amount); }

      return {
        from, to, by, grapes, rows, totals,
        expenses: [...heads.filter((h) => h.d === 'out').reduce((m, h) => m.set(h.k!, (m.get(h.k!) ?? 0) + n(h.s)), new Map<string, number>())].map(([head, paise]) => ({ head, paise })),
        suppliers: [...sup.values()].sort((a, b) => b.salesPaise + b.kharidPaise - a.salesPaise - a.kharidPaise || a.name.localeCompare(b.name)),
        qualities: [...qual.values()].sort((a, b) => b.salesPaise - a.salesPaise || a.name.localeCompare(b.name)),
      };
    });
  }

  // ---------------------------------------------------------------- Purcha (purchase report)

  /**
   * Gaadis that came in [from, to]: supplier, each quality's boxes and kg (corrections and boxes
   * back from a cold store left out, as the grapes desk counts them), the kharid at its bhav (less
   * corrections, as Supplier Khata), bhada, and its beejak if one is made.
   */
  async purcha(shopId: string, from: string, to: string) {
    if (from > to) throw new BadRequestException('from must be on or before to');
    return this.db.withShop(shopId, async (tx) => {
      const lots = (await tx.query<{ id: string; number: string; supplier: string; location: string; arrived: string; freight: string; closed: boolean;
        brand_id: string | null; quality: string | null; received: string; billed: string; free: string; grams: number; goods: string; corrected: string; back: string }>(
        `SELECT t.id, t.number, trim(t.supplier) AS supplier, t.location, ${IST_DAY('t.arrived_at')}::text AS arrived, t.freight_paise AS freight, t.closed_at IS NOT NULL AS closed,
                g.brand_id, br.name AS quality, SUM(g.received_qty) AS received, SUM(g.billed_qty) AS billed, SUM(g.free_qty) AS free, MAX(g.box_grams) AS grams,
                SUM(g.billed_qty::bigint * g.rate_paise) AS goods,
                (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.brand_id IS NOT DISTINCT FROM g.brand_id AND s.kind = 'correction') AS corrected,
                ${STORE_BACK('t.id', 'g.brand_id')} AS back
         FROM trucks t JOIN truck_grades g ON g.truck_id = t.id LEFT JOIN brands br ON br.id = g.brand_id
         WHERE ${IST_DAY('t.arrived_at')} BETWEEN $1 AND $2
         GROUP BY t.id, g.brand_id, br.name ORDER BY t.arrived_at, t.number, MIN(g.created_at)`, [from, to])).rows;
      const beejaks = new Map((await tx.query<{ truck_id: string; id: string; no: number; day: string; net: string; gross: string }>(
        `SELECT truck_id, id, beejak_no AS no, day::text AS day, net_paise AS net, gross_paise AS gross FROM beejaks WHERE truck_id = ANY($1::uuid[])`,
        [[...new Set(lots.map((l) => l.id))]])).rows.map((b) => [b.truck_id, { id: b.id, no: b.no, date: b.day, netPaise: n(b.net), grossPaise: n(b.gross) }]));
      type Q = { name: string; boxes: number; kg: number; amountPaise: number; ratePaise: number };
      const gaadis = new Map<string, { truckId: string; number: string; supplier: string; supplierKey: string; location: string; date: string; closed: boolean; freightPaise: number;
        boxes: number; kg: number; goodsPaise: number; billed: number; corrected: number; qualities: Q[]; beejak: { id: string; no: number; date: string; netPaise: number; grossPaise: number } | null }>();
      for (const l of lots) {
        const g = gaadis.get(l.id) ?? gaadis.set(l.id, { truckId: l.id, number: l.number, supplier: l.supplier, supplierKey: nameKey(l.supplier), location: l.location, date: l.arrived,
          closed: l.closed, freightPaise: n(l.freight), boxes: 0, kg: 0, goodsPaise: 0, billed: 0, corrected: 0, qualities: [], beejak: beejaks.get(l.id) ?? null }).get(l.id)!;
        const boxes = Math.max(0, n(l.received) - n(l.corrected) - n(l.back));
        const kg = Math.round((boxes * (l.grams ?? 0)) / 10) / 100;
        g.qualities.push({ name: l.quality ?? 'Maal', boxes, kg, amountPaise: n(l.goods), ratePaise: n(l.billed) ? Math.round(n(l.goods) / n(l.billed)) : 0 });
        g.boxes += boxes; g.kg += kg; g.goodsPaise += n(l.goods); g.billed += n(l.billed); g.corrected += n(l.corrected);
      }
      const rows = [...gaadis.values()].map(({ billed, corrected, goodsPaise, ...g }) => {
        // A count entered too high comes off at the gaadi's own average bhav (Supplier Khata).
        const kharid = Math.max(0, billed > 0 && corrected > 0 ? goodsPaise - Math.round((goodsPaise * corrected) / billed) : goodsPaise);
        return { ...g, kg: Math.round(g.kg * 100) / 100, kharidPaise: kharid, totalPaise: kharid + g.freightPaise };
      });
      const by = new Map<string, { key: string; name: string; gaadis: number; boxes: number; kg: number; kharidPaise: number; freightPaise: number; beejakPaise: number; pending: number }>();
      for (const r of rows) {
        const k = r.supplierKey || '-';
        const s = by.get(k) ?? by.set(k, { key: r.supplierKey, name: r.supplier || '—', gaadis: 0, boxes: 0, kg: 0, kharidPaise: 0, freightPaise: 0, beejakPaise: 0, pending: 0 }).get(k)!;
        s.gaadis++; s.boxes += r.boxes; s.kg += r.kg; s.kharidPaise += r.kharidPaise; s.freightPaise += r.freightPaise; s.beejakPaise += r.beejak?.netPaise ?? 0; if (!r.beejak) s.pending++;
      }
      const suppliers = [...by.values()].map((s) => ({ ...s, kg: Math.round(s.kg * 100) / 100 })).sort((a, b) => b.boxes - a.boxes || a.name.localeCompare(b.name));
      const sum = (k: 'boxes' | 'kg' | 'kharidPaise' | 'freightPaise') => rows.reduce((t, r) => t + r[k], 0);
      return { from, to, gaadis: rows, suppliers,
        totals: { gaadis: rows.length, boxes: sum('boxes'), kg: Math.round(sum('kg') * 100) / 100, kharidPaise: sum('kharidPaise'), freightPaise: sum('freightPaise'),
          beejakPaise: rows.reduce((t, r) => t + (r.beejak?.netPaise ?? 0), 0), pending: rows.filter((r) => !r.beejak).length } };
    });
  }

  // ---------------------------------------------------------------- Backup

  /**
   * The shop's complete books as one Excel workbook, a sheet per table, streamed to [out] a page
   * of rows at a time — never the whole shop in memory. One read-only snapshot, so every sheet
   * is of the same moment. Amounts in rupees (the _paise columns divided), times in IST.
   */
  async backup(shopId: string, out: Writable) {
    await this.db.tx(async (tx) => {
      await tx.query(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.query(`SELECT set_config('app.shop_id', $1, true), set_config('TimeZone', 'Asia/Kolkata', true)`, [shopId]);
      const sheets = [];
      for (const b of BACKUP) {
        // The columns, from the query itself (a table with no rows still gets its header).
        const meta = (await tx.query({ text: `SELECT * FROM (${b.sql}) q LIMIT 0`, types: backupTypes })).fields.filter((f) => !SKIP.has(f.name));
        const fields = meta.map((f) => f.name);
        // bigint and numeric come back as text; they go in as numbers (a phone or code typed as text stays text).
        const numeric = new Set(meta.filter((f) => f.dataTypeID === 20 || f.dataTypeID === 1700).map((f) => f.name));
        let last: string | null = null;
        sheets.push({
          name: b.sheet,
          header: fields.map((f) => (f.endsWith('_paise') ? `${f.slice(0, -6)} (Rs)` : f)),
          rows: async (): Promise<Cell[][]> => {
            if (last === 'done') return [];
            const rows = (await tx.query<Record<string, unknown>>({
              text: `SELECT * FROM (${b.sql}) q WHERE $1::uuid IS NULL OR q.id > $1::uuid ORDER BY q.id LIMIT ${PAGE}`, values: [last], types: backupTypes })).rows;
            last = rows.length < PAGE ? 'done' : String(rows[rows.length - 1].id);
            return rows.map((r) => fields.map((f): Cell => {
              const v = r[f];
              if (v === null || v === undefined) return null;
              if (f.endsWith('_paise')) return Number(v) / 100;
              if (typeof v === 'object') return JSON.stringify(v);
              if (numeric.has(f)) return Number(v);
              return v as Cell;
            }));
          },
        });
      }
      await writeXlsx(out, sheets);
    });
  }
}
