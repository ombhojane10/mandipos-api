import { addDays, spanDays } from '../../format'
import type { Dashboard, DayEntry } from '../../api'

export type Metric = 'bikri' | 'vasooli' | 'kharid' | 'parchi'
export type Point = { x: string; now: number; before: number | null }

const hourOf = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' })
export const istHour = (iso: string) => Number(hourOf.format(new Date(iso)))

const live = (e: DayEntry) => !e.voided
export const slipsOf = (es: DayEntry[]) => es.filter((e) => e.kind === 'slip' && live(e))
export const paymentsOf = (es: DayEntry[]) => es.filter((e) => e.kind === 'payment' && live(e))

const valueOf = (m: Metric, e: DayEntry) =>
  m === 'bikri' && e.kind === 'slip' ? e.amountPaise
    : m === 'vasooli' && e.kind === 'payment' ? e.amountPaise
      : m === 'parchi' && e.kind === 'slip' ? 1 : 0

export type Books = { d: Dashboard; prev: Dashboard; book: DayEntry[]; prevBook: DayEntry[] }

/**
 * One metric along the period: by hour for a single day, by date otherwise. The previous period
 * of the same length is laid on the same slots, for the "pichhla" line.
 */
export function series(m: Metric, b: Books, from: string, to: string): { points: Point[]; hourly: boolean } {
  const len = spanDays(from, to)
  if (m === 'kharid') {
    // Gaadis carry a day, not an hour: a single day shows its week.
    const prev = new Map(b.prev.trend.map((p) => [p.date, p.purchasePaise]))
    const back = Math.max(len, 7)
    return { hourly: false, points: b.d.trend.map((p) => ({ x: p.date, now: p.purchasePaise, before: prev.get(addDays(p.date, -back)) ?? (len >= 7 ? 0 : null) })) }
  }
  const cur = b.book.filter(live), old = b.prevBook.filter(live)
  if (len === 1) {
    const sum = (es: DayEntry[]) => {
      const by = new Array(24).fill(0) as number[]
      for (const e of es) by[istHour(e.at)] += valueOf(m, e)
      return by
    }
    const a = sum(cur), z = sum(old)
    const used = a.map((v, h) => (v || z[h] ? h : -1)).filter((h) => h >= 0)
    const lo = Math.min(7, ...used), hi = Math.max(21, ...used)
    const points: Point[] = []
    for (let h = lo; h <= hi; h++) points.push({ x: String(h), now: a[h], before: z[h] })
    return { hourly: true, points }
  }
  const sumBy = (es: DayEntry[]) => {
    const by = new Map<string, number>()
    for (const e of es) by.set(e.date, (by.get(e.date) ?? 0) + valueOf(m, e))
    return by
  }
  const a = sumBy(cur), z = sumBy(old)
  const points: Point[] = []
  for (let i = 0; i < len; i++) {
    const day = addDays(from, i)
    points.push({ x: day, now: a.get(day) ?? 0, before: z.get(addDays(day, -len)) ?? 0 })
  }
  return { hourly: false, points }
}

/** A figure per slot, for the small lines under the insight tiles. */
export function perSlot(es: DayEntry[], from: string, to: string, pick: (e: DayEntry) => number): number[] {
  const len = spanDays(from, to)
  if (len === 1) {
    const by = new Array(24).fill(0) as number[]
    for (const e of es) by[istHour(e.at)] += pick(e)
    const first = by.findIndex(Boolean), last = 23 - [...by].reverse().findIndex(Boolean)
    return first < 0 ? by.slice(7, 22) : by.slice(Math.min(first, 7), Math.max(last, 21) + 1)
  }
  const by = new Map<string, number>()
  for (const e of es) by.set(e.date, (by.get(e.date) ?? 0) + pick(e))
  return Array.from({ length: len }, (_, i) => by.get(addDays(from, i)) ?? 0)
}

/** "9 am", "12 pm". */
export const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`

/** ₹2.4L, ₹50K: for axes and tight tiles; every full figure elsewhere is exact. */
export function compact(paise: number): string {
  const r = paise / 100
  if (Math.abs(r) >= 1e7) return `₹${+(r / 1e7).toFixed(2)}Cr`
  if (Math.abs(r) >= 1e5) return `₹${+(r / 1e5).toFixed(1)}L`
  if (Math.abs(r) >= 1e3) return `₹${+(r / 1e3).toFixed(1)}K`
  return `₹${Math.round(r)}`
}
