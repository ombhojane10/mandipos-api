import { useCallback, useEffect, useRef } from 'react'
import { audioContext } from './player'

/** What the browser records best: Opus in WebM (Chrome, Edge, Firefox), else MP4/AAC (Safari). */
const MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  .find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? ''

export type Clip = { blob: Blob; mime: string; ms: number }

/**
 * The microphone for Bolo. The stream is opened once and kept while the sheet is up, so
 * "Phir boliye" starts instantly; the level is read every animation frame into [onLevel]
 * (a DOM write, never React state), and [onSilence] fires once the person has spoken and then
 * gone quiet — measured against the room's own floor, as a mandi is never silent.
 */
export function useRecorder(onLevel: (level: number) => void, onSilence: () => void) {
  const stream = useRef<MediaStream | null>(null)
  const ctx = useRef<AudioContext | null>(null)
  const analyser = useRef<AnalyserNode | null>(null)
  const source = useRef<MediaStreamAudioSourceNode | null>(null)
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const started = useRef(0)
  const frame = useRef(0)
  const cb = useRef({ onLevel, onSilence })
  cb.current = { onLevel, onSilence }

  /** Asks for the mic (once) and wires the meter. */
  const open = useCallback(async () => {
    if (stream.current) return
    stream.current = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    // The context the tap unlocked (player.ts), not a new one: Safari would leave a new one paused
    // and the meter flat, so "stopped talking" would never be heard.
    ctx.current = audioContext()
    analyser.current = ctx.current.createAnalyser()
    analyser.current.fftSize = 512
    source.current = ctx.current.createMediaStreamSource(stream.current)
    source.current.connect(analyser.current)
  }, [])

  const meter = useCallback(() => {
    const a = analyser.current
    if (!a) return
    const buf = new Uint8Array(a.fftSize)
    let floor = 1, loud = 0, quietSince = 0
    const tick = () => {
      a.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
      const rms = Math.sqrt(sum / buf.length)
      const now = performance.now()
      cb.current.onLevel(Math.min(1, rms * 6))
      if (now - started.current > 250) {
        floor = Math.min(floor, Math.max(rms, 0.002))
        if (rms > Math.max(0.02, floor * 3)) { loud++; quietSince = 0 }
        else if (!quietSince) quietSince = now
        // Spoke (a few loud frames, not one click), then 0.8 s of quiet: done.
        if (loud > 8 && quietSince && now - quietSince > 800) { cb.current.onSilence(); return }
      }
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [])

  const start = useCallback(async () => {
    await open()
    if (ctx.current?.state === 'suspended') await ctx.current.resume()
    chunks.current = []
    const r = new MediaRecorder(stream.current!, { ...(MIME ? { mimeType: MIME } : {}), audioBitsPerSecond: 24_000 })
    r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data) }
    r.start()
    rec.current = r
    started.current = performance.now()
    meter()
  }, [open, meter])

  /** The recording so far, as one clip; null if nothing was captured. */
  const stop = useCallback(() => new Promise<Clip | null>((resolve) => {
    cancelAnimationFrame(frame.current)
    const r = rec.current
    if (!r || r.state === 'inactive') return resolve(null)
    const ms = Math.round(performance.now() - started.current)
    r.onstop = () => {
      const mime = (r.mimeType || MIME || 'audio/webm').split(';')[0]
      const blob = new Blob(chunks.current, { type: mime })
      resolve(blob.size > 800 ? { blob, mime, ms } : null)
    }
    r.stop()
    rec.current = null
  }), [])

  const close = useCallback(() => {
    cancelAnimationFrame(frame.current)
    if (rec.current && rec.current.state !== 'inactive') { rec.current.onstop = null; rec.current.stop() }
    rec.current = null
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    // The shared context stays open for the answer's voice; only this mic's nodes are let go.
    source.current?.disconnect()
    source.current = null
    analyser.current = null
    ctx.current = null
  }, [])

  useEffect(() => close, [close])
  return { start, stop, close }
}

/** A clip as base64 for the JSON body (FileReader: no string building in JS). */
export const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const fr = new FileReader()
  fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '')
  fr.onerror = () => reject(fr.error)
  fr.readAsDataURL(blob)
})
