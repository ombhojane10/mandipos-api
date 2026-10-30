import { BadRequestException } from '@nestjs/common';
import { Db } from '../db/db.service';
import { BALANCES, BOUGHT, CASH_PART, LIVE_BILLS, LIVE_COLS, UPI_PART } from '../admin/sql';

/**
 * Questions the fixed views cannot answer ("sabse kam udhaar kiska", "30 din se kisne paisa
 * nahi diya") are answered by one SELECT the model writes — but only over these six tables, a
 * semantic layer that already follows the books' rules (voided slips and raseeds left out, udhaar
 * as the app works it out, stock as Gaadi Hisab has it). Amounts are rupees, dates are text.
 * The model never sees or names a base table; [guard] refuses any that slips in.
 */
const SEMANTIC = `
grahak AS (
  SELECT g.id, g.name AS naam, g.code, g.phone, g.address AS pata,
         ROUND(COALESCE(x.bal, 0) / 100.0, 2) AS udhaar,
         (SELECT MAX(business_date)::text FROM ${LIVE_BILLS} lb WHERE lb.buyer_id = g.id) AS aakhri_parchi,
         (SELECT MAX(business_date)::text FROM ${LIVE_COLS} lc WHERE lc.buyer_id = g.id) AS aakhri_vasooli,
         (SELECT COALESCE(SUM(total_paise), 0) / 100.0 FROM ${LIVE_BILLS} lb WHERE lb.buyer_id = g.id) AS kul_kharid,
         (SELECT COUNT(*) FROM ${LIVE_BILLS} lb WHERE lb.buyer_id = g.id) AS parchiyan
  FROM buyers g LEFT JOIN (${BALANCES}) x ON x.buyer_id = g.id
  WHERE NOT g.hidden AND lower(trim(g.name)) NOT IN ('cash', 'bank', 'free')
),
parchi AS (
  SELECT b.id, b.slip_no AS parchi_no, b.business_date::text AS din, to_char(b.created_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS samay,
         b.buyer_id AS grahak_id, b.buyer_name AS grahak, b.pay_mode AS bhugtan,
         b.total_paise / 100.0 AS rakam, b.paid_paise / 100.0 AS mila, (b.total_paise - b.paid_paise) / 100.0 AS baaki,
         b.cash_paise / 100.0 AS cash, b.upi_paise / 100.0 AS upi,
         (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l WHERE l.bill_id = b.id) AS dana,
         COALESCE(t.number, (SELECT string_agg(DISTINCT t2.number, ', ') FROM bill_lines l2 JOIN trucks t2 ON t2.id = l2.truck_id WHERE l2.bill_id = b.id)) AS gaadi_no,
         b.staff_name AS munim
  FROM ${LIVE_BILLS} b LEFT JOIN trucks t ON t.id = b.truck_id
),
parchi_line AS (
  SELECT l.bill_id AS parchi_id, b.slip_no AS parchi_no, b.business_date::text AS din, b.buyer_id AS grahak_id, b.buyer_name AS grahak,
         l.grade, l.qty AS dana, l.rate_paise / 100.0 AS bhav, l.qty * l.rate_paise / 100.0 AS rakam,
         t.number AS gaadi_no, COALESCE(br.name, 'Maal') AS maal, l.leak
  FROM bill_lines l JOIN ${LIVE_BILLS} b ON b.id = l.bill_id
  LEFT JOIN trucks t ON t.id = l.truck_id LEFT JOIN brands br ON br.id = l.brand_id
),
vasooli AS (
  SELECT c.id, c.receipt_no AS raseed_no, c.business_date::text AS din, to_char(c.created_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS samay,
         c.buyer_id AS grahak_id, g.name AS grahak, c.amount_paise / 100.0 AS rakam,
         (${CASH_PART}) / 100.0 AS cash, (${UPI_PART}) / 100.0 AS upi
  FROM ${LIVE_COLS} c LEFT JOIN buyers g ON g.id = c.buyer_id
),
gaadi AS (
  SELECT t.id, t.number AS gaadi_no, t.supplier, t.location AS jagah,
         (SELECT string_agg(DISTINCT br.name, ', ') FROM truck_grades g JOIN brands br ON br.id = g.brand_id WHERE g.truck_id = t.id) AS maal,
         (t.arrived_at AT TIME ZONE 'Asia/Kolkata')::date::text AS aayi, (t.closed_at AT TIME ZONE 'Asia/Kolkata')::date::text AS band,
         s.recv AS aaya_dana, s.sold AS bika_dana, s.spoiled AS kharab_dana, GREATEST(0, s.recv - s.sold - s.spoiled) AS bacha_dana,
         s.cost / 100.0 AS kharid_rakam
  FROM trucks t CROSS JOIN LATERAL (SELECT
         (SELECT COALESCE(SUM(billed_qty + free_qty), 0) FROM truck_grades g WHERE g.truck_id = t.id)
           - (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind = 'correction') AS recv,
         (SELECT COALESCE(SUM(l.qty), 0) FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE l.truck_id = t.id) AS sold,
         (SELECT COALESCE(SUM(qty), 0) FROM spoilage s WHERE s.truck_id = t.id AND s.kind <> 'correction') AS spoiled,
         (SELECT COALESCE(SUM(billed_qty::bigint * rate_paise), 0) FROM truck_grades g WHERE g.truck_id = t.id AND ${BOUGHT('g')})
           + t.freight_paise + t.labour_paise + t.commission_paise AS cost) s
),
maal_stock AS (
  SELECT t.number AS gaadi_no, t.supplier, g.maal, g.grade, g.qty AS aaya, COALESCE(sold.q, 0) AS bika, COALESCE(sp.q, 0) AS kharab,
         GREATEST(0, g.qty - COALESCE(sold.q, 0) - COALESCE(sp.q, 0)) AS bacha, (t.closed_at IS NULL) AS khuli,
         (t.arrived_at AT TIME ZONE 'Asia/Kolkata')::date::text AS aayi
  FROM (SELECT tg.truck_id, tg.grade, SUM(tg.billed_qty + tg.free_qty) AS qty, string_agg(DISTINCT COALESCE(br.name, 'Maal'), ', ') AS maal
          FROM truck_grades tg LEFT JOIN brands br ON br.id = tg.brand_id GROUP BY tg.truck_id, tg.grade) g
  JOIN trucks t ON t.id = g.truck_id
  LEFT JOIN LATERAL (SELECT SUM(l.qty) AS q FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE l.truck_id = g.truck_id AND l.grade = g.grade) sold ON true
  LEFT JOIN LATERAL (SELECT SUM(x.qty) AS q FROM spoilage x WHERE x.truck_id = g.truck_id AND x.grade = g.grade) sp ON true
),
dispatch AS (
  SELECT b.id, b.slip_no AS parchi_no, b.business_date::text AS din, b.buyer_id AS grahak_id, b.buyer_name AS grahak,
         to_char(b.created_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS parchi_samay,
         x.box, LEAST(x.diye, x.box) AS diye, GREATEST(x.box - x.diye, 0) AS baaki_box,
         CASE WHEN x.diye >= x.box THEN 'ho gaya' WHEN x.diye > 0 THEN 'aadha' ELSE 'baaki' END AS haal,
         to_char(x.pehla AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS pehla_dispatch, to_char(x.aakhri AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS aakhri_dispatch,
         x.gaadi_no, x.jagah
  FROM ${LIVE_BILLS} b CROSS JOIN LATERAL (SELECT
         (SELECT COALESCE(SUM(qty), 0) FROM bill_lines l WHERE l.bill_id = b.id) AS box,
         (SELECT COALESCE(SUM(qty), 0) FROM pickups p WHERE p.bill_id = b.id) AS diye,
         (SELECT MIN(created_at) FROM pickups p WHERE p.bill_id = b.id) AS pehla,
         (SELECT MAX(created_at) FROM pickups p WHERE p.bill_id = b.id) AS aakhri,
         (SELECT string_agg(DISTINCT t.number, ', ') FROM bill_lines l JOIN trucks t ON t.id = l.truck_id WHERE l.bill_id = b.id) AS gaadi_no,
         (SELECT string_agg(DISTINCT NULLIF(t.location, ''), ', ') FROM bill_lines l JOIN trucks t ON t.id = l.truck_id WHERE l.bill_id = b.id) AS jagah) x
  WHERE x.box > 0
),
rojmel AS (
  SELECT d.id, d.business_date::text AS din, CASE d.direction WHEN 'in' THEN 'aaya' ELSE 'gaya' END AS disha,
         d.category AS head, d.party_name AS party, d.note, d.mode, d.amount_paise / 100.0 AS rakam
  FROM daybook_entries d WHERE NOT d.hidden
)`;

/** What the model is told it may query (part of the portal prompt). */
export const ASK_TABLES = `
- grahak(id, naam, code, phone, pata, udhaar, aakhri_parchi, aakhri_vasooli, kul_kharid, parchiyan) — udhaar > 0 = owes the shop; < 0 = jama (paid ahead); 0 = clear. One row per grahak.
- parchi(id, parchi_no, din, samay, grahak_id, grahak, bhugtan, rakam, mila, baaki, cash, upi, dana, gaadi_no, munim) — one row per live slip. bhugtan: cash | upi | card | credit (udhaar) | mixed | after | free.
- parchi_line(parchi_id, parchi_no, din, grahak_id, grahak, grade, dana, bhav, rakam, gaadi_no, maal, leak) — one row per slip line; grade '1' | '2' | '3' | 'mix'; bhav = rupees per dana.
- vasooli(id, raseed_no, din, samay, grahak_id, grahak, rakam, cash, upi) — money collected from grahaks.
- gaadi(id, gaadi_no, supplier, jagah, maal, aayi, band, aaya_dana, bika_dana, kharab_dana, bacha_dana, kharid_rakam) — band NULL = still open. jagah = where the gaadi stands in the mandi ("C11 Shed 11").
- dispatch(id, parchi_no, din, grahak_id, grahak, parchi_samay, box, diye, baaki_box, haal, pehla_dispatch, aakhri_dispatch, gaadi_no, jagah) — angoor: each slip's boxes against what was handed over at the gaadi (scanned). haal 'ho gaya' | 'aadha' | 'baaki'; *_samay / *_dispatch are 'HH:MM'.
- maal_stock(gaadi_no, supplier, maal, grade, aaya, bika, kharab, bacha, khuli, aayi) — stock by gaadi and grade ('1' | '2' | '3'); khuli = the gaadi is still open. "Ek number kitna bacha" = SUM(bacha) WHERE grade = '1' AND khuli.
- rojmel(id, din, disha, head, party, note, mode, rakam) — other money in (disha 'aaya') or out ('gaya'): kharcha, mazdoori, bhada, supplier payments, etc.
On an angoor (grapes) shop "dana" in these columns counts boxes.
Amounts are rupees (numeric); din / aayi / band / aakhri_* are 'YYYY-MM-DD' text, compare them as text.`;

const BASE_TABLES = /\b(bills|bill_lines|bill_voids|collections|collection_voids|buyers|buyer_kyc|buyer_photos|trucks|truck_grades|spoilage|pickups|staff|daybook_entries|udhaar_entries|rates|brands|users|devices|sessions|shops|shop_members|shop_counters|otp_codes|changes|voice_turns|app_releases|print_jobs|print_stations|udhaar_alerts|slip_requests|labour_adjustments|information_schema|pg_catalog)\b/i;
const FORBIDDEN = /\b(insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|copy|call|do|lock|vacuum|analyze|refresh|listen|notify|set|reset|into|execute|prepare|current_setting|set_config|dblink|pg_sleep|pg_\w+|lo_\w+)\b/i;

/** The model's SELECT, refused unless it is one read over the semantic tables. */
export function guard(sql: string): string {
  const q = sql.trim().replace(/;+\s*$/, '');
  if (!/^(with|select)\b/i.test(q)) throw new BadRequestException('Only a SELECT');
  if (q.includes(';')) throw new BadRequestException('One statement only');
  if (FORBIDDEN.test(q)) throw new BadRequestException('Not a plain read');
  if (BASE_TABLES.test(q)) throw new BadRequestException('Only the voice tables');
  if (q.length > 4_000) throw new BadRequestException('Too long');
  return q;
}

export type AskResult = { columns: string[]; rows: Record<string, string | number | boolean | null>[] };

/**
 * Runs [sql] read-only, as this shop (row-level security), with a 3 s ceiling and 50 rows at most.
 * Read-only is the database's promise, not ours: even a query that got past [guard] cannot write.
 */
export async function ask(db: Db, shopId: string, sql: string): Promise<AskResult> {
  const q = guard(sql);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '3s'`);
    await client.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    const r = await client.query(`WITH ${SEMANTIC}, ans AS (${q}) SELECT * FROM ans LIMIT 50`);
    const columns = r.fields.map((f) => f.name).filter((c) => c !== 'id' && !c.endsWith('_id'));
    const rows = r.rows.map((row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, LABELS.test(k) && v !== null ? String(v) : cell(v)])));
    return { columns, rows: rows as AskResult['rows'] };
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Columns that are names, not figures: a gaadi "3289" or a phone stays as written, never "3,289". */
const LABELS = /(^|_)(gaadi|gaadi_no|phone|code|jagah)$|_no$/i;

/** Numbers as numbers (pg returns numeric as text), dates as their day. */
function cell(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return /^-?\d+(\.\d+)?$/.test(s) ? Math.round(Number(s) * 100) / 100 : s;
}
