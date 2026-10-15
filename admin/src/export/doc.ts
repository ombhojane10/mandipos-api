import { useEffect, useSyncExternalStore } from 'react'

/**
 * What a report hands over to be exported: the same figures it shows, as one printable table.
 * The page registers a builder (useExport); the top bar's Export button and the E key open the
 * preview of whichever page is showing.
 */
export type ExportCol = { label: string; num?: boolean; wide?: boolean }
export type ExportRow = { cells: string[]; bold?: boolean; muted?: boolean; strike?: boolean; band?: boolean }
export type ExportDoc = {
  /** The report, e.g. "Grahak Khata". */
  title: string
  /** Whose it is — the grahak or supplier — printed large; blank for a whole-shop report. */
  name?: string
  sub?: string
  period?: string
  summary?: [string, string][]
  columns: ExportCol[]
  rows: ExportRow[]
  foot?: string[]
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
