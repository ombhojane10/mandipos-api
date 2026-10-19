/**
 * What Bolo remembers within one conversation: the last few exchanges, who and what they are
 * talking about ("uska ledger bhejo" after "Om ka udhaar"), and a job waiting on an answer
 * ("Om ka number boliye" → the number → the WhatsApp goes). Kept in memory for 10 minutes of
 * quiet; one API instance serves the portal, so nothing is shared across machines.
 */
export type Expect = 'phone' | 'choice' | 'yes' | 'number' | 'text'
export type Option = { label: string; value: string }
export type Pending = {
  /** The job: what happens once the missing piece is in. */
  job: 'whatsapp' | 'call' | 'grahak' | 'draft' | 'show' | 'edit' | 'download' | 'open'
  /** What was asked and how to read the answer. */
  expect: Expect
  slot: 'buyer' | 'phone' | 'confirm' | 'name'
  question: string
  options?: Option[]
  /** Everything known so far (the model's reply, resolved ids, the number given…). */
  data: Record<string, unknown>
  tries: number
}
export type Session = {
  id: string
  shopId: string
  at: number
  turns: { q: string; a: string }[]
  focus: { buyerId?: string; buyerName?: string; billId?: string; slipNo?: number }
  pending?: Pending
}

const TTL = 10 * 60_000
const MAX = 2_000

export class Sessions {
  private readonly map = new Map<string, Session>()

  get(id: string | undefined, shopId: string): Session {
    const now = Date.now()
    const key = `${shopId}:${id ?? ''}`
    const hit = id ? this.map.get(key) : undefined
    if (hit && now - hit.at < TTL) { hit.at = now; return hit }
    const s: Session = { id: id ?? '', shopId, at: now, turns: [], focus: {} }
    if (id) {
      if (this.map.size >= MAX) for (const [k, v] of this.map) if (now - v.at > TTL || this.map.size >= MAX) this.map.delete(k)
      this.map.set(key, s)
    }
    return s
  }

  /** Remember an exchange, keeping the last four. */
  note(s: Session, q: string, a: string) {
    if (!q && !a) return
    s.turns = [...s.turns, { q: q.slice(0, 300), a: a.slice(0, 300) }].slice(-4)
  }
}

/** Yes / no in the ways a counter says it. */
export function yesNo(s: string): 'yes' | 'no' | null {
  const t = s.toLowerCase().replace(/[^a-zऀ-ॿ\s]/g, ' ').trim()
  if (/\b(haan|han|ha|haa|ji|ok|okay|theek|thik|bilkul|bhejo|bhej do|kar do|yes|sahi|chalega|हाँ|हां|जी|ठीक)\b/.test(t)) return 'yes'
  if (/\b(nahi|nahin|na|no|mat|ruko|cancel|rehne do|नहीं|ना|मत)\b/.test(t)) return 'no'
  return null
}

/** Ten digits out of "nau zero do do…" already transcribed, or "98765 43210". */
export function phoneIn(s: string): string | null {
  const d = s.replace(/\D/g, '')
  const m = d.match(/[6-9]\d{9}$/) ?? (d.length === 12 && d.startsWith('91') ? [d.slice(2)] : null)
  return m && /^[6-9]\d{9}$/.test(m[0]) ? m[0] : null
}
