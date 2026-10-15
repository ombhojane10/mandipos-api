const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

/** ₹1,23,456 — paise rounded to the rupee. */
export const rupees = (paise: number) => `₹${inr.format(Math.round(paise / 100))}`
/** ₹25.50 — for rates, where paise matter. */
export const rate = (paise: number) => `₹${inr2.format(paise / 100)}`
export const count = (n: number) => inr.format(n)

/** Today's date in India, as the shops' business dates are. */
export function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** 15 Oct 2026 */
export function date(day: string): string {
  return new Date(`${day.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** 15 Oct */
export function shortDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** "5 min ago", "3 days ago", or the date. */
export function ago(iso: string | null): string {
  if (!iso) return 'Never'
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (mins < 2) return 'Just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} days ago`
  return date(iso)
}

export const phone = (p: string) => (p.length === 10 ? `${p.slice(0, 5)} ${p.slice(5)}` : p)
