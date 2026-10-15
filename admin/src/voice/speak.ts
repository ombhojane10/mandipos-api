import type { Card } from './Cards'
import { todayIst } from '../format'

/**
 * Bolo reads its answer out, as the terminal does: the browser's own voice (no server call, no
 * wait), Hindi when the machine has one. Chrome loads its voices late, so the pick is redone
 * when they arrive.
 */
const synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
let voice: SpeechSynthesisVoice | null = null
const pick = () => {
  const vs = synth?.getVoices() ?? []
  return vs.find((v) => v.lang === 'hi-IN' && /google/i.test(v.name)) ?? vs.find((v) => v.lang.toLowerCase().startsWith('hi'))
    ?? vs.find((v) => v.lang === 'en-IN') ?? null
}
if (synth) { voice = pick(); synth.addEventListener('voiceschanged', () => { voice = pick() }) }

export function speak(text: string) {
  if (!synth || !text.trim()) return
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  if (voice) { u.voice = voice; u.lang = voice.lang } else u.lang = 'hi-IN'
  u.rate = 1.05
  synth.speak(u)
}

export const hush = () => synth?.cancel()

const inr = new Intl.NumberFormat('en-IN')
const words = (paise: number) => `${inr.format(Math.round(Math.abs(paise) / 100))} रुपये`
const day = (d: string) => (d === todayIst() ? 'आज'
  : new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('hi-IN', { day: 'numeric', month: 'long', timeZone: 'UTC' }))

/** One line per card, said the way the terminal says it (VoiceViews' speak lines). */
export function sayCard(c: Card): string {
  switch (c.view) {
    case 'udhaar': return c.balancePaise > 0 ? `${c.name} का उधार ${words(c.balancePaise)}` : c.balancePaise < 0 ? `${c.name} का ${words(c.balancePaise)} जमा है` : `${c.name} का कुछ बाकी नहीं`
    case 'udhaar_list': return c.rows[0] ? `कुल उधार ${words(c.totalPaise)}। सबसे ज़्यादा ${c.rows[0].name} का, ${words(c.rows[0].duePaise)}` : 'किसी का उधार नहीं'
    case 'bikri': return `${day(c.from)} की बिक्री ${words(c.salesPaise)}, ${inr.format(c.nags)} दाना`
    case 'vasooli': return `${day(c.from)} की वसूली ${words(c.collectedCashPaise + c.collectedUpiPaise)}`
    case 'mazdoori': return `${day(c.from)} की मज़दूरी ${words(c.labourPaise)}`
    case 'galla': return `${day(c.to)} गल्ले में ${words(c.closingPaise)}`
    case 'stock': return `${inr.format(c.totalLeft)} दाना बचा है`
    case 'supplier': return `सप्लायरों को ${words(c.totalPaise)} देना है`
    case 'parchi': return `${day(c.from)} ${c.count} पर्ची`
  }
}
