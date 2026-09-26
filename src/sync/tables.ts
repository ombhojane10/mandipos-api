import { z } from 'zod';

/**
 * Everything a device may sync, and exactly which columns it may set.
 * shop_id, device_id and created_by are never taken from the device — the server
 * fills them from the access token.
 *
 * - fact:   insert once; a repeat of the same id is ignored (safe retries).
 * - master: last write wins on updated_at (buyer details, closing a truck).
 */
const id = z.uuid();
const at = z.iso.datetime({ offset: true });
const day = z.iso.date();
const paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const qty = z.number().int().positive().max(10_000_000);
// Size grade within an origin: 1st, 2nd, 3rd, or a mixed lot sold at a blended rate.
const grade = z.enum(['1', '2', '3', 'mix']);
const text = (max: number) => z.string().max(max).default('');
/** SQLite has no boolean, so terminals send 0/1; accept either. */
const bool = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform(Boolean);

export type TableDef = { kind: 'fact' | 'master'; row: z.ZodObject };

export const SYNC_TABLES: Record<string, TableDef> = {
  // Origins the shop deals in — V. Kota, Pollachi, Gujarat — the axis rates hang off.
  brands: {
    kind: 'master',
    row: z.object({
      id, created_at: at, updated_at: at,
      name: z.string().trim().min(1).max(60), sort_order: z.number().int().min(0).max(999).default(0),
      hidden: bool.default(false), shelf_days: z.number().int().min(1).max(60).default(7),
    }),
  },
  // One row per shop-day-brand-grade; corrections overwrite, yesterday's rows stay for history.
  rates: {
    kind: 'master',
    row: z.object({
      id, created_at: at, updated_at: at,
      business_date: day, brand_id: id, grade, rate_paise: paise,
    }),
  },
  buyers: {
    kind: 'master',
    row: z.object({
      id, created_at: at, updated_at: at,
      name: z.string().trim().min(1).max(120), phone: text(15), kind: text(40),
      credit_limit_paise: paise.default(0), vehicle: text(20),
      // Where the rickshaw takes the goods: shop/gali, and the local transport stand.
      address: text(200), destination: text(120),
      // Taken off the counter's list without losing the slips that refer to them.
      hidden: bool.default(false),
    }),
  },
  trucks: {
    kind: 'master',
    row: z.object({
      id, created_at: at, updated_at: at,
      number: z.string().trim().min(1).max(20), supplier: text(120), arrived_at: at,
      freight_paise: paise.default(0), labour_paise: paise.default(0),
      // Arhat plus market fee, as an amount; part of landed cost.
      commission_paise: paise.default(0),
      closed_at: at.nullable().default(null),
    }),
  },
  // A lot: this many nuts of one brand and grade off one truck, at the rate they were bought.
  truck_grades: {
    kind: 'fact',
    row: z.object({
      id, created_at: at, truck_id: id, brand_id: id, grade,
      billed_qty: z.number().int().min(0), free_qty: z.number().int().min(0).default(0),
      received_qty: z.number().int().min(0), rate_paise: paise,
    }),
  },
  // The parchi. total_paise is goods plus packing labour, i.e. what the customer owes.
  bills: {
    kind: 'fact',
    row: z.object({
      id, created_at: at,
      number: z.string().max(16).regex(/^[A-Za-z0-9/-]+$/), kind: z.enum(['kachchi', 'pakka']),
      buyer_id: id.nullable().default(null), buyer_name: z.string().max(120), business_date: day,
      pay_mode: z.enum(['cash', 'upi', 'card', 'credit', 'mixed']), total_paise: paise, paid_paise: paise, payment_ref: text(40),
      // The trader's own serial, counted from 1 per shop; the night check is that none is missing.
      slip_no: z.number().int().positive().max(9_999_999).nullable().default(null),
      // The vehicle these nuts left, so a short truck can be traced back to its slips.
      truck_id: id.nullable().default(null),
      cash_paise: paise.default(0), upi_paise: paise.default(0),
      labour_paise: paise.default(0),
      packing: z.enum(['loose', 'katta10', 'katta20', 'panni']).default('loose'),
      packs: z.number().int().min(0).max(100_000).default(0),
      delivery: bool.default(false), staff_name: text(60),
    }),
  },
  bill_lines: {
    kind: 'fact',
    row: z.object({ id, created_at: at, bill_id: id, truck_id: id, brand_id: id, grade, qty, rate_paise: paise }),
  },
  // The driver's receiving, brought back after a delivery: proof it reached the right shop.
  receivings: {
    kind: 'fact',
    row: z.object({ id, created_at: at, bill_id: id, received_by: text(120), note: text(200) }),
  },
  lading_slips: {
    kind: 'fact',
    row: z.object({ id, created_at: at, bill_id: id, vehicle: text(20) }),
  },
  collections: {
    kind: 'fact',
    row: z.object({
      id, created_at: at, buyer_id: id, amount_paise: paise.positive(),
      pay_mode: z.enum(['cash', 'upi', 'card']), payment_ref: text(40), business_date: day,
    }),
  },
  spoilage: {
    kind: 'fact',
    row: z.object({ id, created_at: at, truck_id: id, brand_id: id, grade, qty, business_date: day }),
  },
  day_closes: {
    kind: 'fact',
    row: z.object({
      id, created_at: at, business_date: day,
      expected_cash_paise: z.number().int(), counted_cash_paise: paise, note: text(500),
    }),
  },
  terminal_payments: {
    kind: 'fact',
    row: z.object({
      id, created_at: at, purpose: z.enum(['bill', 'collection']), ref_id: id,
      pay_mode: z.enum(['upi', 'card']), amount_paise: paise.positive(), billing_ref: z.string().max(20),
      rrn: text(30), approval_code: text(20), response_code: z.number().int(), response_msg: text(200),
      raw: z.record(z.string(), z.unknown()).default({}),
    }),
  },
};

/** Columns a master row may change after creation. */
export const IMMUTABLE_ON_UPDATE = new Set(['id', 'shop_id', 'device_id', 'created_by', 'created_at']);
