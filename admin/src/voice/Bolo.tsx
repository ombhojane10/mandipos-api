import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { booksChanged } from '../useLoad'
import { lang, t } from '../i18n'
import { openWhatsApp } from '../keys'
import { href, type Report } from '../routes'
import { editEntry, openEntry, type EditBill, type EntryKind, type VoiceDraft } from '../entries/kinds'
import { exportWhenReady } from '../export/doc'
import { AnswerTable, VoiceCard, type Answer, type Card } from './Cards'
import { MicIcon } from './MicIcon'
import { Waveform } from 'ldrs/react'
import 'ldrs/react/Waveform.css'
import { sayCard, speakLocal } from './speak'
import { hush, speakText, unlock } from './player'
import { toBase64, useRecorder } from './useRecorder'

type Reply = { transcript: string; kind: string; say: string }
type Ask = { question: string; expect: 'phone' | 'choice' | 'yes' | 'number' | 'text'; options: { label: string; value: string }[]; detail?: string[]; tap?: boolean }
type Turn = {
  session?: string | null; ask?: Ask; say?: string; call?: { phone: string; name: string }
  go?: { shopId: string; buyerId: string }; sent?: { buyerId: string }; saved?: unknown
  id: string; reply?: Reply; draft?: VoiceDraft; cards?: Card[]; answer?: Answer
  open?: { to: string; buyerId: string | null; truckId: string | null }
  edit?: EditBill; editMiss?: string; downloadMiss?: string
  whatsapp?: { buyerId: string; name: string }; whatsappMiss?: string
  download?: { report: string; format: 'pdf' | 'excel'; buyerId: string | null; from: string | null; to: string | null }
}
type Phase = 'listening' | 'thinking' | 'answer' | 'error' | 'ask'

/** Where "kholo" goes on the website (the terminal's tabs, as the portal's reports). */
const OPEN: Record<string, Report> = {
  home: 'dashboard', gaadiyan: 'stock', grahak: 'outstanding', hisab: 'dashboard', aaya_gaya: 'cashbook',
  vasooli: 'vasooli', mazdoori: 'daybook', supplier: 'suppliers', settings: 'settings', gaadi_hisab: 'gaadis',
}
const ENTRY_OPEN: Record<string, EntryKind> = { nayi_parchi: 'parchi', nayi_gaadi: 'gaadi' }
/** "… download karo": the report page whose export is the file. */
const DOWNLOAD: Record<string, Report> = {
  daybook: 'daybook', outstanding: 'outstanding', cashbook: 'cashbook', stock: 'stock', register: 'register',
  suppliers: 'suppliers', vasooli: 'vasooli', gaadis: 'gaadis', munafa: 'munafa', items: 'items',
}

/**
 * Bolo on the website: listening starts the moment the sheet opens (and the shop's books are
 * read on the server meanwhile), one request answers. A slip, a vasooli or a kharcha opens its
 * entry form filled in — nothing is saved until Save; a question is answered from the books.
 */
/** One conversation, kept across closing and reopening Bolo for 10 minutes. */
function sessionId(): string {
  try {
    const o = JSON.parse(sessionStorage.getItem('bolo.session') ?? 'null') as { id: string; at: number } | null
    if (o && Date.now() - o.at < 10 * 60_000) { sessionStorage.setItem('bolo.session', JSON.stringify({ id: o.id, at: Date.now() })); return o.id }
  } catch { /* a fresh one */ }
  const id = crypto.randomUUID()
  try { sessionStorage.setItem('bolo.session', JSON.stringify({ id, at: Date.now() })) } catch { /* private window */ }
  return id
}

export default function Bolo({ shopId, onDraft, onClose }: { shopId: string; onDraft: (d: VoiceDraft) => void; onClose: () => void }) {
  const speak = useCallback((text: string) => { void speakText(shopId, text, speakLocal) }, [shopId])
  const [phase, setPhase] = useState<Phase>('listening')
  const [title, setTitle] = useState('')
  const [turn, setTurn] = useState<Turn | null>(null)
  const [asked, setAsked] = useState<Ask | null>(null)
  const [typed, setTyped] = useState('')
  const session = useRef(sessionId())
  const orb = useRef<HTMLDivElement>(null)
  const inFlight = useRef<AbortController | null>(null)
  const history = useRef<{ q: string; a: string }[]>([])
  const sending = useRef(false)

  const onLevel = useCallback((l: number) => { orb.current?.style.setProperty('--lv', l.toFixed(2)) }, [])
  const send = useRef<() => void>(() => {})
  const rec = useRecorder(onLevel, () => send.current())

  const listen = useCallback(async (keepAsk = false) => {
    hush()
    if (!keepAsk) { setPhase('listening'); setTurn(null); setTitle(''); setAsked(null) }
    sending.current = false
    try { await rec.start() } catch {
      setPhase('error'); setTitle(t('Mic ki permission dein'))
    }
  }, [rec])

  /** One turn: a recording, typed words, or a tapped answer to Bolo's question. */
  const post = async (input: { audio?: string; mime?: string; audioMs?: number; text?: string; pick?: string }) => {
    setPhase('thinking')
    const ctl = new AbortController()
    inFlight.current = ctl
    try {
      const r = await api<Turn>(`/v1/admin/shops/${shopId}/voice`, {
        method: 'POST', signal: ctl.signal,
        body: { ...input, screen: 'portal', session: session.current, lang: lang === 'en' ? 'english' : lang === 'hi' ? 'hindi' : 'hinglish', history: history.current },
      })
      if (r.reply?.transcript) history.current = [...history.current, { q: r.reply.transcript, a: r.reply.say }].slice(-3)
      // Bolo needs one more thing ("number boliye", "kaun sa Om?"): ask it, show the choices, listen again.
      if (r.ask) {
        setAsked(r.ask); setTyped(''); setTurn(null); setTitle(r.ask.question); setPhase('ask')
        sending.current = false
        // A preview waits for a tap — the mic stays off. A question listens again once Bolo has
        // finished asking, never to its own voice.
        const tap = !!r.ask.tap
        void speakText(shopId, r.ask.question, speakLocal).then((ms) => {
          if (!tap) setTimeout(() => { if (inFlight.current === ctl) void rec.start().catch(() => {}) }, ms + 250)
        })
        return
      }
      setAsked(null)
      if (r.draft) { rec.close(); onDraft(r.draft); return }
      // A saved slip, changed as asked: its alter form opens on the change, Save rewrites it.
      if (r.edit) { rec.close(); onClose(); editEntry({ kind: 'parchi', bill: r.edit }); return }
      if (r.download) {
        const d = r.download
        const period = d.from ? `?from=${d.from}&to=${d.to ?? d.from}` : ''
        rec.close(); onClose()
        location.hash = (d.report === 'ledger' && d.buyerId ? href({ page: 'grahak', shopId, buyerId: d.buyerId })
          : href({ page: 'report', shopId, report: (DOWNLOAD[d.report] ?? 'daybook') })) + period
        exportWhenReady(d.format)
        return
      }
      if (r.go) { rec.close(); onClose(); location.hash = href({ page: 'grahak', shopId: r.go.shopId, buyerId: r.go.buyerId }); return }
      if (r.call) { location.href = `tel:+91${r.call.phone}` }
      // Older answer for a hand-off to the WhatsApp dialog.
      if (r.whatsapp) { rec.close(); onClose(); openWhatsApp(shopId, r.whatsapp.buyerId); return }
      const miss = r.editMiss ?? r.downloadMiss ?? r.whatsappMiss
      if (miss) { setPhase('error'); setTitle(miss); speak(miss); return }
      if (r.open) {
        rec.close(); onClose()
        const entry = ENTRY_OPEN[r.open.to]
        if (entry) openEntry(entry)
        else location.hash = r.open.to === 'grahak_khata' && r.open.buyerId ? href({ page: 'grahak', shopId, buyerId: r.open.buyerId })
          : href({ page: 'report', shopId, report: OPEN[r.open.to] ?? 'dashboard' })
        return
      }
      // Done by Bolo itself (sent, saved, set, calling): say so.
      if (r.say) {
        setTurn(r); setTitle(r.sent || r.saved ? `✓ ${r.say}` : r.say); speak(r.say); setPhase('answer')
        if (r.sent || r.saved) booksChanged()
        return
      }
      setTurn(r)
      // Read out, as the terminal does: the answer, or each card's figure from the books.
      if (r.answer) speak(r.answer.speak || r.answer.say)
      else if (r.cards?.length) speak(r.cards.map(sayCard).join('। '))
      else if (r.reply?.kind === 'answer' || r.reply?.kind === 'unclear') speak(r.reply.say)
      setTitle(r.answer ? r.answer.title : r.reply?.kind === 'answer' ? t('Jawaab') : r.reply?.say || t('Samajh nahi aaya, phir boliye'))
      setPhase(r.reply?.kind === 'unclear' ? 'error' : 'answer')
    } catch (e) {
      if (ctl.signal.aborted) return
      setPhase('error'); setTitle((e as Error).message || t('Samajh nahi paaye, phir boliye'))
    }
  }

  send.current = async () => {
    if (sending.current) return
    sending.current = true
    const clip = await rec.stop()
    if (!clip) { if (asked) { setPhase('ask'); sending.current = false; return } setPhase('error'); setTitle(t('Kuch suna nahi')); return }
    await post({ audio: await toBase64(clip.blob), mime: clip.mime, audioMs: clip.ms })
  }

  /** A tapped choice or typed answer: the recording is dropped, no model call needed. */
  const answer = async (input: { pick?: string; text?: string }) => {
    sending.current = true
    await rec.stop().catch(() => null)
    await post(input)
  }

  useEffect(() => {
    // The server reads the books while the person talks; the turn then does not wait for them.
    void api(`/v1/admin/shops/${shopId}/voice/warm`, { method: 'POST' }).catch(() => {})
    void listen()
    return () => { inFlight.current?.abort(); rec.close(); hush() }
  }, [shopId]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { inFlight.current?.abort(); rec.close(); hush(); onClose() }

  const heard = turn?.reply?.transcript
  const done = !!(turn?.sent || turn?.saved)
  const orbEl = (size: 'big' | 'small') => (
    <div ref={orb} className={`vb-orb ${size}`} aria-hidden>
      <span className="vb-ring r3" /><span className="vb-ring r2" /><span className="vb-ring r1" />
      <span className="vb-core"><MicIcon /></span>
    </div>
  )
  return (
    <div className="vb" role="dialog" aria-label={t('Bolo')} onKeyDown={(e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
      if ((e.key === 'Enter' || e.key === ' ') && phase === 'listening') { e.preventDefault(); send.current() }
    }}>
      <div className="vb-top">
        <span className="vb-brand"><MicIcon />{t('Bolo')}</span>
        <button type="button" className="vb-x" aria-label={t('Band karein')} onClick={close}>
          <svg viewBox="0 0 24 24" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>

      <div className={`vb-stage ${phase}`}>
        {phase === 'listening' && (
          <div className="vb-center" key="listen">
            {orbEl('big')}
            <h2 className="vb-title">{title || t('Boliye…')}</h2>
            <p className="vb-hint">{t('Jaise: Ramesh ko 10 box 900 ke udhaar mein')}</p>
          </div>
        )}
        {phase === 'thinking' && (
          <div className="vb-center" key="think">
            <div className="vb-loader"><Waveform size="64" stroke="4.5" speed="1" color="#2a6b73" /></div>
            <h2 className="vb-title soft">{t('Samajh rahe hain…')}</h2>
          </div>
        )}
        {phase === 'error' && (
          <div className="vb-center" key="err">
            <span className="vb-badge warn"><svg viewBox="0 0 24 24" aria-hidden><path d="M12 8v5M12 16.5v.01" /><circle cx="12" cy="12" r="9" /></svg></span>
            <h2 className="vb-title">{title}</h2>
          </div>
        )}
        {phase === 'ask' && asked && (
          <div className="vb-center wide" key="ask">
            {heard && <p className="vb-heard">“{heard}”</p>}
            {!asked.tap && orbEl('small')}
            <h2 className="vb-title">{asked.question}</h2>
            {asked.detail?.length ? <div className="vb-detail">{asked.detail.map((l, i) => <div key={i}>{l}</div>)}</div> : null}
            {asked.options.length > 0 && (
              <div className="vb-opts">
                {asked.options.map((o) => (
                  <button key={o.value} type="button" className={`vb-opt${asked.tap && o.value === 'yes' ? ' primary' : ''}${o.value === 'cancel' ? ' quiet' : ''}`}
                    onClick={() => void answer({ pick: o.value })}>{o.label}</button>
                ))}
              </div>
            )}
            {(asked.expect === 'phone' || asked.expect === 'text' || asked.expect === 'number') && (
              <form className="vb-type" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) void answer({ text: typed.trim() }) }}>
                <input autoFocus inputMode={asked.expect === 'text' ? 'text' : 'numeric'} maxLength={asked.expect === 'phone' ? 14 : 80}
                  placeholder={asked.expect === 'phone' ? '98765 43210' : ''} value={typed} onChange={(e) => setTyped(e.target.value)} />
                <button type="submit" className="vb-go" aria-label={t('Theek hai')}><svg viewBox="0 0 24 24" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg></button>
              </form>
            )}
          </div>
        )}
        {phase === 'answer' && (
          <div className="vb-center wide" key="answer">
            {heard && <p className="vb-heard">“{heard}”</p>}
            {done && <span className="vb-badge ok"><svg viewBox="0 0 24 24" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>}
            <h2 className="vb-title">{turn?.answer ? turn.answer.say : turn?.say || (turn?.reply?.kind === 'answer' && !turn?.cards?.length ? turn.reply.say : title)}</h2>
            <div className="vb-cards">
              {turn?.answer && <AnswerTable a={turn.answer} shopId={shopId} />}
              {turn?.cards?.map((c, i) => <VoiceCard key={i} c={c} shopId={shopId} />)}
            </div>
          </div>
        )}
      </div>

      <div className="vb-foot">
        {phase === 'ask' && asked?.tap ? null : phase === 'listening' || phase === 'ask'
          ? <button type="button" className="vb-main done" autoFocus={phase === 'listening'} onClick={() => { unlock(); send.current() }}>
              <svg viewBox="0 0 24 24" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>{t('Ho gaya')}
            </button>
          : phase !== 'thinking' && <button type="button" className="vb-main" autoFocus onClick={() => { unlock(); void listen() }}>
              <MicIcon />{turn?.say || turn?.answer || turn?.cards?.length ? t('Aur boliye') : t('Phir boliye')}
            </button>}
        {phase === 'listening' && <small className="vb-keys">{t('Enter — ho gaya · Esc — band')}</small>}
      </div>
    </div>
  )
}
