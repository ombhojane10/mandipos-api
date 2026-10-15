import { useEffect, useSyncExternalStore } from 'react'

/**
 * What a report hands over to be exported, laid out the way the POS app prints (LedgerPdf,
 * DaybookPdf): 'ledger' is the shop's own CUSTOMER LEDGER — firm and bank accounts at the head,
 * the party, From/To and the page, a boxed column head, typewriter figures, TOTAL ruled off;
 * 'book' is the daybook's page — firm centred, the book and the day under it, ruled, and the
 * body either as columns or as the app's sections (heading · lines · total).
 *
 * The page registers a builder (useExport); the top bar's Export button and the E key open the
 * preview of whichever page is showing.
 */
export type ExportCol = { label: string; num?: boolean; wide?: boolean }
export type ExportRow = {
  cells: string[]
  /** band: a day's divider; heading/total/final: the daybook's section lines. */
  kind?: 'band' | 'heading' | 'total' | 'final'
  bold?: boolean; strike?: boolean
}
export type ExportDoc = {
  style: 'ledger' | 'book'
  /** As printed: "CUSTOMER LEDGER", "DAYBOOK · GALLA". */
  title: string
  /** The book style's right-hand line: "SHUKRAVAR, 9 OCTOBER 2026". */
  dateLine?: string
  /** The ledger's party block. */
  party?: { code?: string; description: string; address?: string }
  from?: string; to?: string
  /** Print the shop's bank accounts at the head (the customer ledger does). */
  banks?: boolean
  summary?: [string, string][]
  /** Columns; none = the daybook's sections, rows as [label, detail, time, amount]. */
  columns?: ExportCol[]
  rows: ExportRow[]
  foot?: string[]
  /** A grey line above the signatures, e.g. how the galla figure is reached. */
  note?: string
  /** MALIK and MUNIM signature lines at the end. */
  sign?: boolean
  /** Overrides the shop's name at the head (the market khata is MandiPlus's, not one shop's). */
  firm?: string
  /** File name without extension. */
  file: string
}

type Builder = () => ExportDoc | null
let current: Builder | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Registers this page's export while it is on screen. */
export function useExport(build: Builder | null, deps: unknown[]) {
  useEffect(() => {
    if (!build) return
    current = build
    emit()
    return () => { if (current === build) { current = null; emit() } }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
}

export const exportBuilder = () => current
export function useCanExport() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => current !== null)
}

export const EXPORT_EVENT = 'mandipos:export'
export const openExport = () => { if (current) dispatchEvent(new Event(EXPORT_EVENT)) }

/** A safe file name: letters, digits and dashes. */
export const fileName = (...parts: (string | undefined)[]) =>
  parts.filter(Boolean).join(' ').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80) || 'report'

// ---------------------------------------------------------------- the print's own number and date forms

const group = (n: number) => n.toLocaleString('en-IN')

/** The ledger's amounts: "30,400.00"; nothing for zero. */
export const amt = (paise: number) => (paise ? (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '')
/** The ledger's balance: "34,480.00 baaki" or "1,200.00 jama". */
export const bal = (paise: number, owe = 'baaki', ahead = 'jama') =>
  `${(Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${paise >= 0 ? owe : ahead}`
/** The daybook's whole rupees: "3,97,520" (paise rounded off), "-" in front when negative. */
export const rs = (paise: number) => `${paise < 0 ? '-' : ''}${group(Math.round(Math.abs(paise) / 100))}`
/** Counts: "1,970". */
export const qty = (n: number) => (n ? group(n) : '')

const d = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`)
/** "15/10/26" */
export const dmy = (iso: string) => d(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'UTC' })
/** "15/10/2026" */
export const dmyLong = (iso: string) => d(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
const DAYS = ['RAVIVAR', 'SOMVAR', 'MANGALVAR', 'BUDHVAR', 'GURUVAR', 'SHUKRAVAR', 'SHANIVAR']
/** "SHUKRAVAR, 9 OCTOBER 2026", as the shop names its days. */
export const longDay = (iso: string) =>
  `${DAYS[d(iso).getUTCDay()]}, ${d(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).toUpperCase()}`
/** One day, or "from - to". */
export const dayRange = (from: string, to: string) => (from === to ? longDay(from) : `${longDay(from)}  -  ${longDay(to)}`)
/** A balance in whole rupees with its word, for the book-style registers. */
export const balRs = (paise: number, who: 'grahak' | 'supplier' = 'grahak') =>
  paise === 0 ? 'Clear' : `${rs(Math.abs(paise))} ${who === 'grahak' ? (paise > 0 ? 'baaki' : 'jama') : (paise > 0 ? 'dena' : 'advance')}`
