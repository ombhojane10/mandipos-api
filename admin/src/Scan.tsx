import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { api, ApiError } from './api'
import { count } from './format'
import { t } from './i18n'
import { Field, Sheet } from './entries/fields'
import { booksChanged } from './useLoad'

/**
 * Dispatch at the gaadi from the website, as the app's scanner does it: the slip's QR (its bill
 * id) through the camera, a handheld scanner typing into the box, or the slip number typed;
 * then how many boxes go now. A sound says each step: a beep on a read, a chime when saved, a buzz
 * when something is wrong. After a save it is back on the camera for the next slip.
 */
type Slip = { billId: string; slipNo: number | null; buyer: string; date: string; boxes: number; picked: number; left: number
  lines: { brandId: string | null; truckId: string | null; quality: string; gaadi: string; location: string; qty: number }[] }

const SCAN_EVENT = 'mp:scan'
export const openScan = (shopId: string) => dispatchEvent(new CustomEvent<string>(SCAN_EVENT, { detail: shopId }))

// ---------------------------------------------------------------- sound

let audio: AudioContext | null = null
let out: AudioNode | null = null
/** Made on the click that opens the scanner: browsers only let a page play sound after a tap. */
export function wakeSound() {
  try {
    if (!audio) {
      audio = new AudioContext()
      // A compressor in front of the speaker lets the tones run near full scale without clipping:
      // a mandi floor is loud, and a laptop speaker is small.
      const c = audio.createDynamicsCompressor()
      c.threshold.value = -6; c.ratio.value = 12
      c.connect(audio.destination)
      out = c
    }
    void audio.resume()
  } catch { /* no sound on this browser */ }
}
export function sound(kind: 'read' | 'ok' | 'error') {
  if (!audio || !out) return
  // Square and sawtooth carry far further than a sine at the same level: a scanner's beep, not a chime.
  const notes: [number, number, OscillatorType][] =
    kind === 'read' ? [[2000, 0.15, 'square']]
      : kind === 'ok' ? [[1050, 0.14, 'square'], [1400, 0.14, 'square'], [2100, 0.3, 'square']]
        : [[260, 0.22, 'sawtooth'], [180, 0.35, 'sawtooth']]
  let at = audio.currentTime
  for (const [hz, len, type] of notes) {
    const o = audio.createOscillator(), g = audio.createGain()
    o.type = type; o.frequency.value = hz
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(0.9, at + 0.005)
    g.gain.setValueAtTime(0.9, at + len * 0.7)
    g.gain.exponentialRampToValueAtTime(0.0001, at + len)
    o.connect(g).connect(out)
    o.start(at); o.stop(at + len + 0.02)
    at += len
  }
  try { navigator.vibrate?.(kind === 'error' ? [80, 60, 80] : 40) } catch { /* not a phone */ }
}

// ---------------------------------------------------------------- the sheet

export function ScanHost() {
  const [shopId, setShopId] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  useEffect(() => {
    const on = (e: Event) => { wakeSound(); setShopId((e as CustomEvent<string>).detail) }
    addEventListener(SCAN_EVENT, on)
    return () => removeEventListener(SCAN_EVENT, on)
  }, [])
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 3500); return () => clearTimeout(id) }, [toast])
  return (
    <>
      {shopId && <ScanSheet shopId={shopId} onClose={() => setShopId(null)} onSaved={(msg) => { booksChanged(); setToast(msg) }} />}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </>
  )
}

function ScanSheet({ shopId, onClose, onSaved }: { shopId: string; onClose: () => void; onSaved: (msg: string) => void }) {
  const [slip, setSlip] = useState<Slip | null>(null)
  const [code, setCode] = useState('')
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [camera, setCamera] = useState<'on' | 'off' | 'none'>('on')
  const [broken, setBroken] = useState<{ line: number; qty: string; note: string } | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const looking = useRef(false)

  const open = async (raw: string) => {
    const c = raw.trim()
    if (!c || looking.current) return
    looking.current = true; setBusy(true); setError('')
    try {
      const s = await api<Slip>(`/v1/admin/shops/${shopId}/pickup?code=${encodeURIComponent(c)}`)
      setSlip(s); setQty(s.left > 0 ? String(s.left) : ''); setCode('')
      sound(s.left > 0 ? 'read' : 'error')
    } catch (e) {
      sound('error')
      setError(e instanceof ApiError && e.status === 404 ? t('Yeh parchi nahi mili') : e instanceof Error ? e.message : String(e))
    } finally { looking.current = false; setBusy(false) }
  }

  // The camera reads while no slip is open. BarcodeDetector where the browser has it, else jsQR.
  useEffect(() => {
    if (slip || camera !== 'on') return
    let stream: MediaStream | null = null, timer = 0, stopped = false
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    type Detector = { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> }
    const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector
    const native = Native ? new Native({ formats: ['qr_code'] }) : null
    const tick = async () => {
      if (stopped) return
      const v = video.current
      if (v && v.readyState >= 2 && !looking.current) {
        let found = ''
        try {
          if (native) found = (await native.detect(v))[0]?.rawValue ?? ''
          else if (ctx) {
            const w = Math.min(640, v.videoWidth), h = Math.round((v.videoHeight / v.videoWidth) * w)
            canvas.width = w; canvas.height = h
            ctx.drawImage(v, 0, 0, w, h)
            found = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data ?? ''
          }
        } catch { /* a frame that would not read */ }
        if (found) await open(found)
      }
      if (!stopped) timer = window.setTimeout(tick, 180)
    }
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((s) => {
        if (stopped) { s.getTracks().forEach((x) => x.stop()); return }
        stream = s
        if (video.current) { video.current.srcObject = s; void video.current.play() }
        void tick()
      })
      .catch(() => setCamera('none'))
    if (!navigator.mediaDevices) setCamera('none')
    return () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((x) => x.stop()) }
  }, [slip, camera]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!slip) return void open(code)
    if (slip.left <= 0) { setSlip(null); return }
    const n = Number(qty)
    if (!Number.isInteger(n) || n <= 0) { sound('error'); setError(t('Kitne box diye, woh likhein')); return }
    if (n > slip.left) { sound('error'); setError(t('Is parchi par sirf {n} box baaki', { n: count(slip.left) })); return }
    setBusy(true); setError('')
    try {
      await api(`/v1/admin/shops/${shopId}/pickup`, { method: 'POST', body: { billId: slip.billId, qty: n } })
      sound('ok')
      onSaved(t('{slip} · {n} box diye', { slip: slip.slipNo ? `#${slip.slipNo}` : t('Parchi'), n: count(n) }))
      setSlip(null); setQty('')
    } catch (e) {
      sound('error'); setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  // Boxes found broken after they left: a request to the accountant, who writes them at a new bhav.
  const report = async () => {
    if (!slip || !broken) return
    const l = slip.lines[broken.line], n = Number(broken.qty)
    if (!Number.isInteger(n) || n <= 0) { sound('error'); setError(t('Kitne box toote, woh likhein')); return }
    if (n > l.qty) { sound('error'); setError(t('{q} sirf {n} box hai', { q: l.quality, n: count(l.qty) })); return }
    setBusy(true); setError('')
    try {
      await api(`/v1/admin/shops/${shopId}/breakages`, { method: 'POST', body: { billId: slip.billId, brandId: l.brandId, truckId: l.truckId, qty: n, note: broken.note || undefined } })
      sound('ok')
      onSaved(t('{slip} · {n} toote box accountant ko bheje', { slip: slip.slipNo ? `#${slip.slipNo}` : t('Parchi'), n: count(n) }))
      setBroken(null); setSlip(null)
    } catch (e) {
      sound('error'); setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  if (slip && broken) {
    return (
      <Sheet title={`${t('Toote box')} · ${slip.slipNo ? `#${slip.slipNo}` : t('Parchi')}`} onClose={() => { setBroken(null); setError('') }}
        onSave={() => void report()} saving={busy} error={error} saveLabel={t('Accountant ko bhejein')}>
        {slip.lines.length > 1 && (
          <Field label={t('Quality')}>
            <select className="field" value={broken.line} onChange={(e) => setBroken({ ...broken, line: Number(e.target.value) })}>
              {slip.lines.map((l, i) => <option key={i} value={i}>{l.quality}{l.gaadi && ` · ${l.gaadi}`} · {t('{n} box', { n: count(l.qty) })}</option>)}
            </select>
          </Field>
        )}
        <Field label={t('Kitne box toote')}>
          <input className="field scan-qty" inputMode="numeric" autoFocus value={broken.qty} onChange={(e) => setBroken({ ...broken, qty: e.target.value.replace(/\D/g, '') })} />
        </Field>
        <Field label={t('Note (optional)')}>
          <input className="field" maxLength={200} value={broken.note} onChange={(e) => setBroken({ ...broken, note: e.target.value })} />
        </Field>
      </Sheet>
    )
  }

  if (slip) {
    const gaadis = [...new Map(slip.lines.filter((l) => l.gaadi).map((l) => [l.gaadi, l.location])).entries()]
    return (
      <Sheet title={`${slip.slipNo ? `#${slip.slipNo}` : t('Parchi')} · ${slip.buyer}`} onClose={() => { setSlip(null); setError('') }}
        onSave={() => void save()} saving={busy} error={error} saveLabel={slip.left > 0 ? t('Maal diya') : t('Agla scan')}>
        {gaadis.length > 0 && <div className="scan-gaadi">{gaadis.map(([g, at]) => <div key={g}><b>{g}</b>{at && <span> · 📍 {at}</span>}</div>)}</div>}
        <div className="lines-list scan-lines">
          {slip.lines.map((l, i) => <div key={i}><span className="grow">{l.quality}{gaadis.length > 1 && <small className="muted"> · {l.gaadi}</small>}</span><span className="money">{t('{n} box', { n: count(l.qty) })}</span></div>)}
          <div><span className="grow muted">{t('Le gaye')}</span><span className="money">{t('{n} box', { n: count(slip.picked) })}</span></div>
          <div><span className="grow b">{t('Baaki')}</span><span className={`money b${slip.left ? ' due' : ''}`}>{t('{n} box', { n: count(slip.left) })}</span></div>
        </div>
        {slip.left > 0
          ? <Field label={t('Abhi kitne box')}><input className="field scan-qty" inputMode="numeric" autoFocus value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} /></Field>
          : <p className="error">{t('Is parchi ka saara maal ja chuka hai')}</p>}
        {slip.picked > 0 && slip.lines.length > 0 && (
          <button type="button" className="link-row" onClick={() => { setError(''); setBroken({ line: 0, qty: '', note: '' }) }}>
            {t('Toote box batayein')} ›
          </button>
        )}
      </Sheet>
    )
  }

  return (
    <Sheet title={t('Maal dein')} onClose={onClose} onSave={() => void save()} saving={busy} error={error} saveLabel={t('Number se kholein')}>
      {camera === 'on' && <div className="scan-cam"><video ref={video} playsInline muted /><span className="scan-frame" /></div>}
      {camera === 'none' && <p className="muted">{t('Camera nahi mila — parchi number likhein')}</p>}
      <Field label={t('Parchi number')}>
        <input className="field" autoFocus inputMode="numeric" value={code} placeholder="12"
          onChange={(e) => setCode(e.target.value)} />
      </Field>
    </Sheet>
  )
}
