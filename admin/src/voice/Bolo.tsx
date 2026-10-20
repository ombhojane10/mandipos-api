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
import { sayCard, speakLocal } from './speak'
import { hush, speakText, unlock } from './player'
import { toBase64, useRecorder } from './useRecorder'

type Reply = { transcript: string; kind: string; say: string }
type Ask = { question: string; expect: 'phone' | 'choice' | 'yes' | 'number' | 'text'; options: { label: string; value: string }[]; detail?: string[] }
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
        // Listen again once Bolo has finished asking — never to its own voice.
        void speakText(shopId, r.ask.question, speakLocal).then((ms) => {
          setTimeout(() => { if (inFlight.current === ctl) void rec.start().catch(() => {}) }, ms + 250)
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

  return (
    <div className="scrim sheet-scrim" onClick={close} onKeyDown={(e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
      if ((e.key === 'Enter' || e.key === ' ') && phase === 'listening') { e.preventDefault(); send.current() }
    }}>
      <div className="sheet bolo" role="dialog" aria-label={t('Bolo')} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-hd">
          <h3>{title || (phase === 'thinking' ? t('Samajh rahe hain…') : t('Boliye…'))}</h3>
          <button type="button" className="icon-btn" aria-label={t('Band karein')} onClick={close}>✕</button>
        </div>
        <div className="bolo-body">
          {phase === 'listening' && <div ref={orb} className="bolo-orb" aria-hidden><MicIcon /></div>}
          {phase === 'thinking' && <div className="bolo-spin" aria-hidden />}
          {phase === 'ask' && asked && (
            <div className="bolo-ask">
              <div ref={orb} className="bolo-orb small" aria-hidden><MicIcon /></div>
              {asked.detail?.length ? <div className="bolo-detail">{asked.detail.map((l, i) => <div key={i}>{l}</div>)}</div> : null}
              {asked.options.length > 0 && (
                <div className="bolo-opts">
                  {asked.options.map((o) => <button key={o.value} type="button" className="btn line" onClick={() => void answer({ pick: o.value })}>{o.label}</button>)}
                </div>
              )}
              {(asked.expect === 'phone' || asked.expect === 'text' || asked.expect === 'number') && (
                <form className="bolo-type" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) void answer({ text: typed.trim() }) }}>
                  <input className="field" autoFocus inputMode={asked.expect === 'text' ? 'text' : 'numeric'} maxLength={asked.expect === 'phone' ? 14 : 80}
                    placeholder={asked.expect === 'phone' ? '98765 43210' : ''} value={typed} onChange={(e) => setTyped(e.target.value)} />
                  <button type="submit" className="btn primary">{t('Theek hai')}</button>
                </form>
              )}
            </div>
          )}
          {phase === 'answer' && turn?.answer && <p className="bolo-say">{turn.answer.say}</p>}
          {phase === 'answer' && turn?.answer && <AnswerTable a={turn.answer} shopId={shopId} />}
          {phase === 'answer' && turn?.cards?.map((c, i) => <VoiceCard key={i} c={c} shopId={shopId} />)}
          {phase === 'answer' && !turn?.cards?.length && turn?.reply?.kind === 'answer' && <p className="bolo-say">{turn.reply.say}</p>}
        </div>
        <div className="bolo-ft">
          {phase === 'listening' || phase === 'ask'
            ? <button type="button" className="btn primary" autoFocus={phase === 'listening'} onClick={() => { unlock(); send.current() }}>{t('Ho gaya')}</button>
            : phase !== 'thinking' && <button type="button" className="btn primary" autoFocus onClick={() => { unlock(); void listen() }}>{turn?.say || turn?.answer || turn?.cards?.length ? t('Aur boliye') : t('Phir boliye')}</button>}
        </div>
      </div>
    </div>
  )
}

