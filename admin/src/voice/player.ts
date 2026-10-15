import { apiStream } from '../api'

/**
 * Bolo's voice, the same on every device: the server streams 16-bit PCM (24 kHz) from Gemini TTS
 * and each piece is scheduled on Web Audio the moment it lands, so speech starts in about a
 * second. Phones only let a page make sound that a tap began, so [unlock] runs inside the tap
 * that opens Bolo and keeps one AudioContext alive for every answer after it.
 */
const RATE = 24_000
let ctx: AudioContext | null = null
let playing: { ctl: AbortController; nodes: AudioBufferSourceNode[] } | null = null

/** Call from a click/tap handler (synchronously): creates and wakes the audio output. */
export function unlock() {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    // iOS needs one sound started inside the gesture; a single silent sample is enough.
    const s = ctx.createBufferSource()
    s.buffer = ctx.createBuffer(1, 1, 22_050)
    s.connect(ctx.destination)
    s.start(0)
  } catch { /* no Web Audio: the browser's own voice is the fallback */ }
}

export function hush() {
  if (!playing) return
  playing.ctl.abort()
  playing.nodes.forEach((n) => { try { n.stop() } catch { /* already ended */ } })
  playing = null
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
}

/** Reads [text] out. Resolves when the stream has been scheduled; never throws. */
export async function speakText(shopId: string, text: string, fallback: (t: string) => void) {
  hush()
  if (!text.trim()) return
  const me = { ctl: new AbortController(), nodes: [] as AudioBufferSourceNode[] }
  playing = me
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') await ctx.resume()
    const res = await apiStream(`/v1/admin/shops/${shopId}/voice/speak`, { text }, me.ctl.signal)
    const reader = res.body!.getReader()
    // A small lead so a late network chunk does not leave a gap at the start.
    let at = ctx.currentTime + 0.12
    let carry = new Uint8Array(0)
    for (;;) {
      const { done, value } = await reader.read()
      if (done || playing !== me) break
      const bytes = new Uint8Array(carry.length + value.length)
      bytes.set(carry); bytes.set(value, carry.length)
      const whole = bytes.length - (bytes.length % 2)
      carry = bytes.slice(whole)
      if (!whole) continue
      const pcm = new Int16Array(bytes.buffer, 0, whole / 2)
      const buf = ctx.createBuffer(1, pcm.length, RATE)
      const ch = buf.getChannelData(0)
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768
      const node = ctx.createBufferSource()
      node.buffer = buf
      node.connect(ctx.destination)
      at = Math.max(at, ctx.currentTime + 0.02)
      node.start(at)
      at += buf.duration
      me.nodes.push(node)
    }
  } catch {
    if (me.ctl.signal.aborted) return
    // The server's voice could not be had: the device's own, if it has one.
    fallback(text)
  }
}
