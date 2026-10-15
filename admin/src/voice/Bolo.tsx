import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { lang, t } from '../i18n'
import { href, type Report } from '../routes'
import { editEntry, openEntry, type EditBill, type EntryKind, type VoiceDraft } from '../entries/kinds'
import { exportWhenReady } from '../export/doc'
import { AnswerTable, VoiceCard, type Answer, type Card } from './Cards'
import { MicIcon } from './MicIcon'
import { sayCard, speakLocal } from './speak'
import { hush, speakText, unlock } from './player'
import { toBase64, useRecorder } from './useRecorder'

type Reply = { transcript: string; kind: string; say: string }
type Turn = {
  id: string; reply: Reply; draft?: VoiceDraft; cards?: Card[]; answer?: Answer
  open?: { to: string; buyerId: string | null; truckId: string | null }
  edit?: EditBill; editMiss?: string; downloadMiss?: string
  download?: { report: string; format: 'pdf' | 'excel'; buyerId: string | null; from: string | null; to: string | null }
}
type Phase = 'listening' | 'thinking' | 'answer' | 'error'

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
export default function Bolo({ shopId, onDraft, onClose }: { shopId: string; onDraft: (d: VoiceDraft) => void; onClose: () => void }) {
  const speak = useCallback((text: string) => { void speakText(shopId, text, speakLocal) }, [shopId])
  const [phase, setPhase] = useState<Phase>('listening')
  const [title, setTitle] = useState('')
  const [turn, setTurn] = useState<Turn | null>(null)
  const orb = useRef<HTMLDivElement>(null)
  const inFlight = useRef<AbortController | null>(null)
  const history = useRef<{ q: string; a: string }[]>([])
  const sending = useRef(false)

  const onLevel = useCallback((l: number) => { orb.current?.style.setProperty('--lv', l.toFixed(2)) }, [])
  const send = useRef<() => void>(() => {})
  const rec = useRecorder(onLevel, () => send.current())

  const listen = useCallback(async () => {
    hush()
    setPhase('listening'); setTurn(null); setTitle('')
    sending.current = false
    try { await rec.start() } catch {
      setPhase('error'); setTitle(t('Mic ki permission dein'))
    }
  }, [rec])

  send.current = async () => {
    if (sending.current) return
    sending.current = true
    const clip = await rec.stop()
    if (!clip) { setPhase('error'); setTitle(t('Kuch suna nahi')); return }
    setPhase('thinking')
    const ctl = new AbortController()
    inFlight.current = ctl
    try {
      const r = await api<Turn>(`/v1/admin/shops/${shopId}/voice`, {
        method: 'POST', signal: ctl.signal,
        body: {
          audio: await toBase64(clip.blob), mime: clip.mime, audioMs: clip.ms, screen: 'portal',
          lang: lang === 'en' ? 'english' : lang === 'hi' ? 'hindi' : 'hinglish', history: history.current,
        },
      })
      if (r.reply.transcript) history.current = [...history.current, { q: r.reply.transcript, a: r.reply.say }].slice(-3)
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
      const miss = r.editMiss ?? r.downloadMiss
      if (miss) { setPhase('error'); setTitle(miss); speak(miss); return }
      if (r.open) {
        rec.close(); onClose()
        const entry = ENTRY_OPEN[r.open.to]
        if (entry) openEntry(entry)
        else location.hash = r.open.to === 'grahak_khata' && r.open.buyerId ? href({ page: 'grahak', shopId, buyerId: r.open.buyerId })
          : href({ page: 'report', shopId, report: OPEN[r.open.to] ?? 'dashboard' })
        return
      }
      setTurn(r)
      // Read out, as the terminal does: the answer, or each card's figure from the books.
      if (r.answer) speak(r.answer.speak || r.answer.say)
      else if (r.cards?.length) speak(r.cards.map(sayCard).join('। '))
      else if (r.reply.kind === 'answer') speak(r.reply.say)
      setTitle(r.answer ? r.answer.title : r.reply.kind === 'answer' ? t('Jawaab') : r.reply.say || t('Samajh nahi aaya, phir boliye'))
      setPhase(r.reply.kind === 'unclear' ? 'error' : 'answer')
    } catch (e) {
      if (ctl.signal.aborted) return
      setPhase('error'); setTitle((e as Error).message || t('Samajh nahi paaye, phir boliye'))
    }
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
          {phase === 'answer' && turn?.answer && <p className="bolo-say">{turn.answer.say}</p>}
          {phase === 'answer' && turn?.answer && <AnswerTable a={turn.answer} shopId={shopId} />}
          {phase === 'answer' && turn?.cards?.map((c, i) => <VoiceCard key={i} c={c} shopId={shopId} />)}
          {phase === 'answer' && !turn?.cards?.length && turn?.reply.kind === 'answer' && <p className="bolo-say">{turn.reply.say}</p>}
        </div>
        <div className="bolo-ft">
          {phase === 'listening'
            ? <button type="button" className="btn primary" autoFocus onClick={() => { unlock(); send.current() }}>{t('Ho gaya')}</button>
            : phase !== 'thinking' && <button type="button" className="btn primary" autoFocus onClick={() => { unlock(); void listen() }}>{t('Phir boliye')}</button>}
        </div>
      </div>
    </div>
  )
}

