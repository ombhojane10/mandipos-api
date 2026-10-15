import { addDays, shortDate, todayIst, date as fullDate } from './format'
import { t } from './i18n'

export type Period = { key: string; from: string; to: string }

export const PRESETS = [
  { key: 'aaj', label: t('Aaj'), days: 1, back: 0 },
  { key: 'kal', label: t('Kal'), days: 1, back: 1 },
  { key: '7', label: t('{n} din', { n: 7 }), days: 7, back: 0 },
  { key: '30', label: t('{n} din', { n: 30 }), days: 30, back: 0 },
]

export function preset(key: string): Period {
  const today = todayIst()
  const p = PRESETS.find((x) => x.key === key) ?? PRESETS[0]
  const to = addDays(today, -p.back)
  return { key: p.key, from: addDays(to, 1 - p.days), to }
}

export function periodLabel(p: Period): string {
  if (p.from === p.to) return p.from === todayIst() ? `${t('Aaj')}, ${shortDate(p.from)}` : dayHeaderLong(p.from)
  return `${shortDate(p.from)} – ${shortDate(p.to)}`
}
function dayHeaderLong(d: string) {
  return d === addDays(todayIst(), -1) ? `${t('Kal')}, ${shortDate(d)}` : fullDate(d)
}

