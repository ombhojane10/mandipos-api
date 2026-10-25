import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { api, type BuyerRow } from '../api'
import { t } from '../i18n'
import { toBase64, useRecorder } from '../voice/useRecorder'
import { unlock } from '../voice/player'
import { useOptions } from './options'

export type ComposerHandle = { listen: () => void; focus: () => void; fill: (text: string) => void }
type Props = {
  shopId: string; busy: boolean; big?: boolean; placeholder: string
  onText: (text: string) => void
  onVoice: (clip: { audio: string; mime: string; audioMs: number }) => void
  onStop: () => void
  onWarm: () => void
}
type Pick = { kind: '@' | '#'; q: string; start: number }
type Option = { label: string; sub: string; insert: string }

const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

/**
 * Where everything starts: type, or tap the mic and talk (it stops by itself when the person
 * does), or hold Space with the box empty — a walkie-talkie for the counter. "@" picks a grahak
 * and "#" a gaadi from the books as you type, so the name Bolo gets is the exact one.
 */
export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ shopId, busy, big, placeholder, onText, onVoice, onStop, onWarm }, ref) {
  const [text, setText] = useState('')
  const [rec, setRec] = useState<'idle' | 'on' | 'sending'>('idle')
  const [ms, setMs] = useState(0)
  const [pick, setPick] = useState<Pick | null>(null)
  const [opts, setOpts] = useState<Option[]>([])
  const [sel, setSel] = useState(0)
  const [err, setErr] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const meter = useRef<HTMLDivElement>(null)
  const started = useRef(0)
  const held = useRef<{ at: number } | null>(null)
  const finish = useRef<() => void>(() => {})
  const o = useOptions(shopId)

  const recorder = useRecorder((l) => meter.current?.style.setProperty('--lv', l.toFixed(2)), () => finish.current())

  const listen = useCallback(async () => {
    if (rec !== 'idle') return
    unlock(); setErr(''); onWarm()
    try { await recorder.start(); started.current = Date.now(); setMs(0); setRec('on') } catch { setErr(t('Mic ki permission dein')) }
  }, [rec, recorder, onWarm])

  finish.current = async () => {
    if (rec !== 'on') return
    setRec('sending')
    const clip = await recorder.stop()
    setRec('idle')
    if (!clip || clip.ms < 400) return
    onVoice({ audio: await toBase64(clip.blob), mime: clip.mime, audioMs: clip.ms })
  }
  const cancel = async () => { await recorder.stop().catch(() => null); setRec('idle') }

  useEffect(() => {
    if (rec !== 'on') return
    const id = setInterval(() => setMs(Date.now() - started.current), 250)
    return () => clearInterval(id)
  }, [rec])
  // The mic is let go when the composer goes (useRecorder hands back a new object every render).
  const closeMic = useRef(recorder.close)
  closeMic.current = recorder.close
  useEffect(() => () => closeMic.current(), [])

  useImperativeHandle(ref, () => ({
    listen: () => void listen(),
    focus: () => box.current?.focus(),
    fill: (s: string) => { setText(s); requestAnimationFrame(() => { box.current?.focus(); grow() }) },
  }), [listen])

  const grow = () => { const el = box.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 180)}px` }

  // The picker: "@ra" lists grahak, "#32" open gaadis; the books answer, not the model.
  useEffect(() => {
    if (!pick) { setOpts([]); return }
    let live = true
    const q = pick.q.toLowerCase()
    if (pick.kind === '#') {
      const list: Option[] = o?.lots?.length
        ? o.lots.map((l) => ({ label: l.number, sub: [l.quality, l.supplier, l.location].filter(Boolean).join(' · '), insert: l.number }))
        : (o?.trucks ?? []).map((tr) => ({ label: tr.number, sub: [tr.brand, tr.supplier].filter(Boolean).join(' · '), insert: tr.number }))
      const seen = new Set<string>()
      setOpts(list.filter((x) => x.label.toLowerCase().includes(q) && !seen.has(x.label + x.sub) && seen.add(x.label + x.sub)).slice(0, 8)); setSel(0)
      return
    }
    const timer = setTimeout(() => {
      api<{ buyers: BuyerRow[] }>(`/v1/admin/shops/${shopId}/buyers?q=${encodeURIComponent(pick.q)}`).then((r) => {
        if (!live) return
        setOpts(r.buyers.filter((b) => !b.hidden).slice(0, 8).map((b) => ({ label: b.name, sub: [b.code, b.phone].filter(Boolean).join(' · '), insert: b.name })))
        setSel(0)
      }).catch(() => {})
    }, 120)
    return () => { live = false; clearTimeout(timer) }
  }, [pick, o, shopId])

  const onChange = (v: string) => {
    setText(v); grow()
    const el = box.current
    const at = el?.selectionStart ?? v.length
    const m = /(^|\s)([@#])([^\s@#]*)$/.exec(v.slice(0, at))
    setPick(m ? { kind: m[2] as '@' | '#', q: m[3], start: at - m[3].length - 1 } : null)
  }
  const choose = (x: Option) => {
    if (!pick) return
    const at = box.current?.selectionStart ?? text.length
    const next = `${text.slice(0, pick.start)}${x.insert} ${text.slice(at)}`
    setText(next); setPick(null)
    requestAnimationFrame(() => { const el = box.current; if (el) { el.focus(); el.selectionStart = el.selectionEnd = pick.start + x.insert.length + 1; grow() } })
  }
  const submit = () => {
    const s = text.trim()
    if (!s || busy) return
    onText(s); setText(''); setPick(null)
    requestAnimationFrame(grow)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pick && opts.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((sel + 1) % opts.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((sel - 1 + opts.length) % opts.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(opts[sel]); return }
      if (e.key === 'Escape') { e.preventDefault(); setPick(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); return }
    // Hold Space on an empty box to talk; let go to send.
    if (e.key === ' ' && !text && !e.repeat && rec === 'idle') { e.preventDefault(); held.current = { at: Date.now() }; void listen() }
    else if (e.key === ' ' && !text && held.current) e.preventDefault()
  }
  const onKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== ' ' || !held.current) return
    const quick = Date.now() - held.current.at < 300
    held.current = null
    if (quick) return // a tap: the mic stays on and stops by itself
    void finish.current()
  }

  return (
    <div className={`bc-composer${big ? ' big' : ''}${rec === 'on' ? ' rec' : ''}`}>
      {pick && opts.length > 0 && (
        <div className="bc-pick" role="listbox">
          {opts.map((x, i) => (
            <button key={x.label + x.sub + i} type="button" role="option" aria-selected={i === sel} className={i === sel ? 'on' : undefined}
              onMouseDown={(e) => { e.preventDefault(); choose(x) }}>
              <span className="bc-pick-mark">{pick.kind}</span><b>{x.label}</b>{x.sub && <small>{x.sub}</small>}
            </button>
          ))}
        </div>
      )}
      {rec === 'idle' ? (
        <textarea ref={box} rows={1} value={text} placeholder={placeholder} aria-label={t('Bolo se poochhein')}
          onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onFocus={onWarm} />
      ) : (
        <div className="bc-listening" aria-live="polite">
          <div ref={meter} className="bc-wave" aria-hidden>{Array.from({ length: 28 }, (_, i) => <i key={i} style={{ ['--f' as string]: (0.3 + 0.7 * Math.abs(Math.sin(i * 1.7))).toFixed(2) }} />)}</div>
          <span className="bc-timer">{rec === 'sending' ? '…' : fmt(ms)}</span>
        </div>
      )}
      <div className="bc-tools">
        {rec === 'idle' && <>
          <button type="button" className="bc-chip" onClick={() => { onChange(`${text}${text && !text.endsWith(' ') ? ' ' : ''}@`); box.current?.focus() }}>@ {t('grahak')}</button>
          <button type="button" className="bc-chip" onClick={() => { onChange(`${text}${text && !text.endsWith(' ') ? ' ' : ''}#`); box.current?.focus() }}># {t('gaadi')}</button>
        </>}
        {err && <span className="bc-err">{err}</span>}
        <span className="bc-grow" />
        {rec === 'on' && <button type="button" className="bc-round ghost" aria-label={t('Rehne dein')} onClick={() => void cancel()}><svg viewBox="0 0 24 24" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg></button>}
        {busy && rec === 'idle'
          ? <button type="button" className="bc-round" aria-label={t('Roko')} onClick={onStop}><svg viewBox="0 0 24 24" aria-hidden><rect x="7" y="7" width="10" height="10" rx="1.5" className="fill" /></svg></button>
          : rec === 'on'
            ? <button type="button" className="bc-round send" aria-label={t('Bhejein')} onClick={() => void finish.current()}><svg viewBox="0 0 24 24" aria-hidden><path d="M5 12l5 5 9-10" /></svg></button>
            : text.trim()
              ? <button type="button" className="bc-round send" aria-label={t('Bhejein')} onClick={submit}><svg viewBox="0 0 24 24" aria-hidden><path d="M12 19V5M5 12l7-7 7 7" /></svg></button>
              : <button type="button" className="bc-round mic" aria-label={t('Boliye')} title={t('Boliye — ya Space dabaa kar rakhein')} onClick={() => void listen()}>
                  <svg viewBox="0 0 24 24" aria-hidden><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></svg>
                </button>}
      </div>
    </div>
  )
})
