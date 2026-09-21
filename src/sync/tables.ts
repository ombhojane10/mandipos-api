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
const grade = z.enum(['A', 'B', 'C']);
const text = (max: number) => z.string().max(max).default('');

export type TableDef = { kind: 'fact' | 'master'; row: z.ZodObject };

export const SYNC_TABLES: Record<string, TableDef> = {
  buyers: {
    kind: 'master',
    row: z.object({
      id, created_at: at, updated_at: at,
      name: z.string().trim().min(1).max(120), phone: text(15), kind: text(40),
      credit_limit_paise: paise.default(0), vehicle: text(20),
    }),
  },
  trucks: {
    kind: 'master',
    row: z.object({
      id, created_at: at, updated_at: at,
      number: z.string().trim().min(1).max(20), supplier: text(120), arrived_at: at,
      billed_qty: qty, free_qty: z.number().int().min(0).default(0),
      rate_paise: paise, freight_paise: paise.default(0), labour_paise: paise.default(0),
      closed_at: at.nullable().default(null),
    }),
  },
  truck_grades: {
    kind: 'fact',
    row: z.object({ id, created_at: at, truck_id: id, grade, received_qty: z.number().int().min(0) }),
  },
  bills: {
    kind: 'fact',
    row: z.object({
      id, created_at: at,
      number: z.string().max(16).regex(/^[A-Za-z0-9/-]+$/), kind: z.enum(['kachchi', 'pakka']),
      buyer_id: id.nullable().default(null), buyer_name: z.string().max(120), business_date: day,
      pay_mode: z.enum(['cash', 'upi', 'card', 'credit']), total_paise: paise, paid_paise: paise, payment_ref: text(40),
    }),
  },
  bill_lines: {
    kind: 'fact',
    row: z.object({ id, created_at: at, bill_id: id, truck_id: id, grade, qty, rate_paise: paise }),
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
    row: z.object({ id, created_at: at, truck_id: id, grade, qty, business_date: day }),
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
