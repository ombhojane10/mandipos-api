/**
 * Who did they mean? A name as heard ("Om", "Raju bhai", "Jagriti") against the shop's grahaks,
 * scored rather than guessed: one clear winner is used; two close ones become a question
 * ("Om Bhojane ya Omi?"); nothing near enough becomes "naya grahak banayein?". The model's
 * own ref is a strong hint, never the last word — a near-miss name must not message the wrong
 * person.
 */
export type Person = { id: string; name: string; code: string; phone: string; balancePaise: number }
export type Scored = Person & { score: number }
export type Resolution =
  | { kind: 'one'; who: Person; sure: boolean }
  | { kind: 'some'; options: Scored[] }
  | { kind: 'none' }

/** Hinglish spellings of one sound folded together: "Jagreeti" = "Jagriti", "Wasim" = "Vasim", "Rajveer" = "Rajbeer". */
export function fold(s: string, drop = /\b(bhai|ji|sahab|saheb|seth|bhaiya|wale|wala|traders?|fruits?|co|company|and|sons)\b/g): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(drop, ' ')
    .replace(/ph/g, 'f').replace(/bh/g, 'b').replace(/[wb]/g, 'v').replace(/z/g, 'j').replace(/sh/g, 's').replace(/kh/g, 'k').replace(/gh/g, 'g')
    .replace(/aa/g, 'a').replace(/ee|ii/g, 'i').replace(/oo|uu/g, 'u').replace(/y\b/g, 'i')
    .replace(/(.)\1+/g, '$1')
    .replace(/\s+/g, ' ').trim()
}

function lev(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length, n = b.length
  if (!m || !n) return m || n
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]
}

/** 0–1: how well what was heard names this grahak. */
export function score(heard: string, p: Pick<Person, 'name' | 'code' | 'phone'>): number {
  const digits = heard.replace(/\D/g, '')
  if (digits.length >= 6 && p.phone && p.phone.endsWith(digits.slice(-10))) return 1
  const h = fold(heard), n = fold(p.name)
  if (!h || !n) return 0
  if (p.code && fold(p.code) === h.replace(/\s/g, '')) return 1
  if (h === n) return 1
  const ht = h.split(' '), nt = n.split(' ')
  // Every word they said is a word of the name ("Om" in "Om Bhojane", "Raju Fruits" for "Raju").
  if (ht.every((w) => nt.includes(w))) return 0.85 + 0.1 * (ht.length / nt.length)
  // A word they said begins a word of the name ("Om" → "Omi", "Jagri" → "Jagriti Agro").
  const prefix = ht.every((w) => w.length >= 2 && nt.some((x) => x.startsWith(w)))
  if (prefix) return 0.6 + 0.25 * Math.min(1, h.replace(/\s/g, '').length / n.replace(/\s/g, '').length)
  // Spelling drift across the whole name ("Jagreeti Agro" vs "Jagriti Agro").
  const d = lev(h.replace(/\s/g, ''), n.replace(/\s/g, ''))
  const ratio = 1 - d / Math.max(h.replace(/\s/g, '').length, n.replace(/\s/g, '').length)
  return ratio >= 0.75 ? ratio * 0.85 : 0
}

/** A name as it must match to be "exactly" that grahak: spellings folded, only honorifics dropped ("Bholu" is not "Bholu Traders"). */
export function key(s: string): string {
  return fold(s, /\b(bhai|ji|sahab|saheb|seth|bhaiya)\b/g);
}

/** 0–1: how close a name sounds even when it is not the same name ("Reliance Digital" ~ "Reliance Retail India Ltd"). */
export function near(heard: string, name: string): number {
  const ht = fold(heard).split(' ').filter(Boolean), nt = fold(name).split(' ').filter(Boolean);
  if (!ht.length || !nt.length) return 0;
  const best = (w: string) => Math.max(...nt.map((x) => 1 - lev(w, x) / Math.max(w.length, x.length)));
  return ht.reduce((a, w) => a + best(w), 0) / ht.length;
}

/** A clear winner, a short list to choose from, or nobody. [hintId]: the model's pick, if any. */
export function resolve(heard: string, people: Person[], hintId?: string | null): Resolution {
  const name = heard.trim()
  if (!name) {
    const hinted = hintId ? people.find((p) => p.id === hintId) : undefined
    return hinted ? { kind: 'one', who: hinted, sure: true } : { kind: 'none' }
  }
  const ranked = people.map((p) => ({ ...p, score: score(name, p) })).filter((p) => p.score >= 0.55)
    .sort((a, b) => b.score - a.score || b.balancePaise - a.balancePaise)
  if (!ranked.length) return { kind: 'none' }
  const [top, next] = ranked
  // Exact (or the model's pick agrees exactly) and nothing else close: that is the one.
  const clear = top.score >= 0.85 && (!next || next.score < top.score - 0.12)
  if (clear) return { kind: 'one', who: top, sure: top.score >= 0.95 || top.id === hintId }
  return { kind: 'some', options: ranked.slice(0, 4) }
}
