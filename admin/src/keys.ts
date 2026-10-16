import type { Report } from './routes'
import type { EntryKind } from './entries/kinds'

/**
 * Tally's way with keys: one letter opens a report from anywhere, the letter shown underlined
 * inside the menu's own word (no tags). Letters work only when no box is being typed in.
 */
export const REPORT_KEYS: Record<string, Report> = {
  h: 'dashboard', d: 'daybook', c: 'cashbook', o: 'outstanding', l: 'ledger', p: 'suppliers', s: 'stock', i: 'items', t: 'team',
  r: 'register', m: 'munafa', v: 'vasooli', a: 'gaadis', b: 'bhav', x: 'nigrani',
}
/** Inside the Nayi entry menu (N): one letter per entry. */
export const ENTRY_KEYS: Record<string, EntryKind> = {
  p: 'parchi', v: 'vasooli', k: 'kharcha', s: 'supplier', g: 'gaadi', n: 'grahak', u: 'udhaar',
}
/** Tally's voucher keys: F8 Sales, F9 Purchase, F6 Receipt. */
export const F_KEYS: Record<string, EntryKind> = { F8: 'parchi', F9: 'gaadi', F6: 'vasooli' }

export const letterOf = (map: Record<string, string>, value: string) => Object.keys(map).find((k) => map[k] === value) ?? ''

/** Events the keyboard sends to whichever part of the page owns the thing. */
export const PERIOD_EVENT = 'mandipos:period'
export const periodKey = (what: 'open' | 'prev' | 'next') => dispatchEvent(new CustomEvent(PERIOD_EVENT, { detail: what }))
export const VOUCHER_EVENT = 'mandipos:voucher'
export type VoucherRef = { shopId: string; billId: string } | { shopId: string; raseedId: string }
export const openVoucher = (shopId: string, billId: string) => dispatchEvent(new CustomEvent<VoucherRef>(VOUCHER_EVENT, { detail: { shopId, billId } }))
/** A vasooli opens as its raseed, with Alter and Delete, as a parchi does. */
export const openRaseed = (shopId: string, raseedId: string) => dispatchEvent(new CustomEvent<VoucherRef>(VOUCHER_EVENT, { detail: { shopId, raseedId } }))
export const HELP_EVENT = 'mandipos:help'
export const openHelp = () => dispatchEvent(new Event(HELP_EVENT))

/** The row you were on in each list, so Esc back lands on it again. */
export const lastRow = new Map<string, number>()
export const pagePath = () => location.hash.split('?')[0] || '#/'
export const WHATSAPP_EVENT = 'mandipos:whatsapp'
/** Opens the "send udhaar on WhatsApp" confirmation for one grahak (khata, Vasooli, Bolo). */
export const openWhatsApp = (shopId: string, buyerId: string) => dispatchEvent(new CustomEvent(WHATSAPP_EVENT, { detail: { shopId, buyerId } }))
