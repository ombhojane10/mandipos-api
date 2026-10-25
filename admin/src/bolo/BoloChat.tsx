import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, type Outstanding } from '../api'
import { useSession } from '../App'
import { ago, count, todayIst } from '../format'
import { t } from '../i18n'
import { href } from '../routes'
import { loadDesk } from '../pages/Angoor'
import { chatStore, useChats } from './chats'
import { useBolo } from './useBolo'
import { Composer, type ComposerHandle } from './Composer'
import { BoloMark, Thread } from './Thread'

type Topic = { key: string; label: string; asks: string[] }

/** What to ask, by topic, in the shop's own trade: grapes in boxes off gaadis, coconut in dana. */
function topics(commodity: string, top: string): Topic[] {
  const angoor = commodity === 'angoor'
  const who = top || 'Ramesh'
  return [
    { key: 'bill', label: t('Bill'), asks: angoor
      ? [`${who} ko 10 box Tiger 900 ke udhaar mein bill kaat do`, 'Cash mein 5 box Royal 1200 ke', 'Aakhri parchi mein rate 950 kar do']
      : [`${who} ko 100 dana ek number 40 ke`, 'Cash 50 dana 35 ke panni mein', 'Aakhri parchi udhaar mein daal do'] },
    ...(angoor ? [{ key: 'dispatch', label: t('Dispatch'), asks: ['Aaj dispatch kitna baaki hai', 'Kis parchi ka maal abhi nahi gaya', 'Aaj kitne box de diye'] }] : []),
    { key: 'udhaar', label: t('Udhaar'), asks: ['Sabse zyada udhaar kiska hai', `${who} ka udhaar kitna hai`, `${who} ko udhaar WhatsApp karo`] },
    { key: 'gaadi', label: t('Gaadi'), asks: angoor
      ? ['Kaunsi gaadi kahan khadi hai', 'Kis gaadi ka kitna maal bika', 'Nayi gaadi aayi hai']
      : ['Kis gaadi mein kitna maal bacha hai', 'Sabse purani gaadi kaunsi hai', 'Nayi gaadi aayi hai'] },
    { key: 'hisab', label: t('Hisab'), asks: ['Aaj ki bikri kitni hui', 'Aaj galla mein kitna hai', 'Aaj kitna kharcha hua'] },
    { key: 'yaad', label: t('Yaad'), asks: [`Kal subah yaad dilana ${who} se paise lene hain`, 'Mere reminder dikhao'] },
  ]
}

type Hint = { ask: string; note: string; tone: 'warn' | 'plain' }

/** Three things worth asking right now, read off the books — not a fixed list. */
function useHints(shopId: string, commodity: string) {
  const [hints, setHints] = useState<Hint[]>([])
  const [top, setTop] = useState('')
  useEffect(() => {
    let live = true
    const day = todayIst()
    void (async () => {
      const out: Hint[] = []
      const [owe, desk] = await Promise.all([
        api<Outstanding>(`/v1/admin/shops/${shopId}/outstanding`).catch(() => null),
        commodity === 'angoor' ? loadDesk(shopId, day, day).catch(() => null) : Promise.resolve(null),
      ])
      if (desk) {
        const left = desk.totals.boxes - desk.totals.picked
        if (left > 0) out.push({ ask: 'Aaj dispatch kitna baaki hai', note: t('{n} box dena baaki', { n: count(left) }), tone: 'warn' })
        const g = desk.gaadis[0]
        if (g) out.push({ ask: `${g.number} kahan khadi hai`, note: [g.supplier, g.location].filter(Boolean).join(' · '), tone: 'plain' })
      }
      const first = owe?.rows[0]
      if (first) {
        if (live) setTop(first.name.split(' ').slice(0, 2).join(' '))
        out.push({ ask: `${first.name} ka udhaar kitna hai`, note: t('Sabse zyada udhaar'), tone: 'plain' })
      }
      if (out.length < 3) out.push({ ask: 'Aaj ki bikri kitni hui', note: t('Aaj'), tone: 'plain' })
      if (live) setHints(out.slice(0, 3))
    })()
    return () => { live = false }
  }, [shopId, commodity])
  return { hints, top }
}

const greeting = () => {
  const h = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()))
  return h < 12 ? t('Subah ki ram ram') : h < 17 ? t('Namaste') : t('Shubh sandhya')
}

/**
 * Bolo as a conversation, the whole page or a side panel over any page: ask by typing or talking,
 * and every answer stays in the thread as a card — a slip to check and save, a grahak's udhaar,
 * where a gaadi stands. The same POST /voice and Gemini routing as the terminal's Bolo.
 */
export function BoloChat({ shopId, mode, screen, onClose }: { shopId: string; mode: 'page' | 'panel'; screen: string; onClose?: () => void }) {
  const { shops } = useSession()
  const commodity = shops?.find((s) => s.id === shopId)?.commodity ?? 'nariyal'
  const state = useChats(shopId)
  const chat = state.chats.find((c) => c.id === state.current) ?? null
  const composer = useRef<ComposerHandle>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const relisten = useCallback(() => composer.current?.listen(), [])
  const { send, stop, busy, warm } = useBolo(shopId, screen, relisten)
  const { hints, top } = useHints(shopId, commodity)
  const list = useMemo(() => topics(commodity, top), [commodity, top])
  const [topic, setTopic] = useState<string | null>(null)
  const empty = !chat?.msgs.length

  // The newest message in view as it lands.
  const n = chat?.msgs.length ?? 0
  const last = chat?.msgs[n - 1]
  useLayoutEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight }, [n, last?.thinking, last?.turn])

  // "/" puts the cursor in the box, as in any chat.
  useEffect(() => {
    if (mode !== 'page') return
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.isContentEditable) { e.preventDefault(); composer.current?.focus() }
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [mode])
  useEffect(() => { composer.current?.focus() }, [shopId, state.current])

  const ask = (text: string) => void send({ text })
  const box = (
    <Composer ref={composer} shopId={shopId} busy={busy} big={empty && mode === 'page'} onWarm={warm} onStop={stop}
      placeholder={empty ? list[0].asks[0] : t('Likhein ya boliye…')}
      onText={(text) => void send({ text })} onVoice={(clip) => void send(clip)} />
  )

  const welcome = (
    <div className="bc-welcome">
      <div className="bc-hello">
        <span className="bc-mark"><BoloMark /></span>
        <small>{greeting()}</small>
        <h2>{t('Aaj kya karna hai?')}</h2>
      </div>
      {box}
      <div className="bc-topics" role="tablist">
        {list.map((x) => (
          <button key={x.key} type="button" role="tab" aria-selected={topic === x.key} className={`bc-topic${topic === x.key ? ' on' : ''}`}
            onClick={() => setTopic(topic === x.key ? null : x.key)}>{x.label}</button>
        ))}
      </div>
      <div className="bc-suggest">
        {(topic ? list.find((x) => x.key === topic)!.asks.map((a) => ({ ask: a, note: '', tone: 'plain' as const })) : hints).map((h) => (
          <button key={h.ask} type="button" className="bc-suggest-row" onClick={() => ask(h.ask)}>
            <span className={`bc-dot ${h.tone}`} aria-hidden />
            <span className="bc-suggest-ask">{h.ask}</span>
            {h.note && <small>{h.note}</small>}
            <svg viewBox="0 0 24 24" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        ))}
      </div>
    </div>
  )

  if (mode === 'panel') {
    return (
      <div className="bc bc-panel">
        <div className="bc-panel-hd">
          <span className="bc-mark sm"><BoloMark /></span>
          <b>{chat?.title || t('Bolo')}</b>
          <span className="bc-grow" />
          <button type="button" className="bc-icon" aria-label={t('Nayi baat')} title={t('Nayi baat')} onClick={() => chatStore.fresh(shopId)}>
            <svg viewBox="0 0 24 24" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <a className="bc-icon" aria-label={t('Poora page')} title={t('Poora page')} href={href({ page: 'report', shopId, report: 'bolo' })} onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" /></svg>
          </a>
          <button type="button" className="bc-icon" aria-label={t('Band karein')} onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div ref={scroller} className="bc-scroll">
          {empty ? welcome : <Thread shopId={shopId} chatId={chat!.id} msgs={chat!.msgs} send={(i) => void send(i)} busy={busy} />}
        </div>
        {!empty && <div className="bc-foot">{box}</div>}
      </div>
    )
  }

  return (
    <div className="bc bc-page">
      <aside className="bc-rail" aria-label={t('Purani baatein')}>
        <button type="button" className="bc-new" onClick={() => chatStore.fresh(shopId)}>
          <svg viewBox="0 0 24 24" aria-hidden><path d="M12 5v14M5 12h14" /></svg>{t('Nayi baat')}
        </button>
        <div className="bc-history">
          {state.chats.filter((c) => c.msgs.length).map((c) => (
            <div key={c.id} className={`bc-hist${c.id === state.current ? ' on' : ''}`}>
              <button type="button" onClick={() => chatStore.open(shopId, c.id)}>
                <span>{c.title || t('Baat')}</span><small>{ago(new Date(c.at).toISOString())}</small>
              </button>
              <button type="button" className="bc-hist-x" aria-label={t('Hatayein')} onClick={() => chatStore.remove(shopId, c.id)}>
                <svg viewBox="0 0 24 24" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </div>
          ))}
        </div>
      </aside>
      <section className="bc-main">
        <div ref={scroller} className="bc-scroll">
          {empty ? welcome : <Thread shopId={shopId} chatId={chat!.id} msgs={chat!.msgs} send={(i) => void send(i)} busy={busy} />}
        </div>
        {!empty && <div className="bc-foot">{box}</div>}
      </section>
    </div>
  )
}
