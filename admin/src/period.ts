import { addDays, dayHeader, shortDate, todayIst, date as fullDate } from './format'

export type Period = { key: string; from: string; to: string }

export const PRESETS = [
  { key: 'aaj', label: 'Aaj', days: 1, back: 0 },
  { key: 'kal', label: 'Kal', days: 1, back: 1 },
  { key: '7', label: '7 din', days: 7, back: 0 },
  { key: '30', label: '30 din', days: 30, back: 0 },
]

export function preset(key: string): Period {
  const today = todayIst()
  const p = PRESETS.find((x) => x.key === key) ?? PRESETS[0]
  const to = addDays(today, -p.back)
  return { key: p.key, from: addDays(to, 1 - p.days), to }
}

export function periodLabel(p: Period): string {
  if (p.from === p.to) return p.from === todayIst() ? `Aaj, ${shortDate(p.from)}` : dayHeaderLong(p.from)
  return `${shortDate(p.from)} – ${shortDate(p.to)}`
}
function dayHeaderLong(d: string) {
  const h = dayHeader(d)
  return h === 'Kal' ? `Kal, ${shortDate(d)}` : fullDate(d)
}

