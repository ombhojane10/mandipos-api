import { useCallback, useRef, useState } from 'react'
import { api } from '../api'
import { lang } from '../i18n'
import { booksChanged } from '../useLoad'
import { sayCard, speakLocal } from '../voice/speak'
import { hush, speakText } from '../voice/player'
import { chatStore, uid, type Chat, type Turn } from './chats'

type Input = { text?: string; pick?: string; pickLabel?: string; audio?: string; mime?: string; audioMs?: number }

/** What Bolo says aloud for a turn: the answer, each card's figure, the question, or what it did. */
export function spoken(r: Turn): string {
  if (r.ask) return r.ask.question
  if (r.answer) return r.answer.speak || r.answer.say
  if (r.cards?.length) return r.cards.map(sayCard).join('। ')
  if (r.say) return r.say
  if (r.editMiss || r.downloadMiss || r.whatsappMiss) return (r.editMiss ?? r.downloadMiss ?? r.whatsappMiss)!
  return r.reply?.say ?? ''
}

/** The chat title: the first request, short. */
const titleOf = (s: string) => (s.length > 48 ? `${s.slice(0, 46).trim()}…` : s)

/**
 * One conversation with Bolo over POST /voice — the same endpoint and Gemini routing the terminal
 * and the old sheet use. Typed, spoken or tapped, each turn lands in the thread; a spoken one is
 * answered aloud too, and when Bolo then asks something, it listens again by itself.
 */
export function useBolo(shopId: string, screen: string, relisten: () => void) {
  const [busy, setBusy] = useState(false)
  const inFlight = useRef<AbortController | null>(null)

  const send = useCallback(async (input: Input) => {
    if (inFlight.current) return
    const chat: Chat = chatStore.ensure(shopId)
    const voice = !!input.audio
    const meId = uid(), boloId = uid()
    const shown = input.pickLabel ?? input.text ?? ''
    chatStore.update(shopId, chat.id, (c) => ({
      ...c, title: c.title || titleOf(shown || '…'),
      msgs: [...c.msgs, { id: meId, at: Date.now(), role: 'me', text: shown, voiceMs: input.audioMs }, { id: boloId, at: Date.now(), role: 'bolo', thinking: true }],
    }))
    const history = chat.msgs.filter((m) => m.role === 'bolo' && m.turn?.reply?.transcript)
      .slice(-3).map((m) => ({ q: m.turn!.reply!.transcript.slice(0, 500), a: (m.turn!.reply!.say ?? '').slice(0, 500) }))
    const ctl = new AbortController()
    inFlight.current = ctl
    setBusy(true)
    hush()
    try {
      const r = await api<Turn>(`/v1/admin/shops/${shopId}/voice`, {
        method: 'POST', signal: ctl.signal,
        body: {
          text: input.text, pick: input.pick, audio: input.audio, mime: input.mime, audioMs: input.audioMs,
          screen: screen.slice(0, 40), session: chat.session, history,
          lang: lang === 'en' ? 'english' : lang === 'hi' ? 'hindi' : 'hinglish',
        },
      })
      // A spoken request shows what was heard.
      if (voice && r.reply?.transcript) {
        chatStore.patchMsg(shopId, chat.id, meId, { text: r.reply.transcript })
        chatStore.update(shopId, chat.id, (c) => ({ ...c, title: c.title === '…' || !c.title ? titleOf(r.reply!.transcript) : c.title }))
      }
      chatStore.patchMsg(shopId, chat.id, boloId, { thinking: false, turn: r })
      if (r.sent || r.saved) booksChanged()
      inFlight.current = null
      const say = voice ? spoken(r) : ''
      // Spoken to, Bolo speaks back — without holding the thread: the next request can go while it talks.
      // Asked something that is not a tap-only preview, it listens for the answer once it has asked.
      if (say) void speakText(shopId, say, speakLocal).then((ms) => { if (r.ask && !r.ask.tap && !inFlight.current) setTimeout(relisten, ms + 250) })
    } catch (e) {
      if (ctl.signal.aborted) chatStore.update(shopId, chat.id, (c) => ({ ...c, msgs: c.msgs.filter((m) => m.id !== boloId) }))
      else chatStore.patchMsg(shopId, chat.id, boloId, { thinking: false, error: (e as Error).message || 'Samajh nahi paaye' })
    } finally {
      if (inFlight.current === ctl) inFlight.current = null
      setBusy(false)
    }
  }, [shopId, screen, relisten])

  const stop = useCallback(() => { inFlight.current?.abort(); inFlight.current = null; hush() }, [])

  /** The server reads the books while the person types or talks. */
  const warm = useCallback(() => { void api(`/v1/admin/shops/${shopId}/voice/warm`, { method: 'POST' }).catch(() => {}) }, [shopId])

  return { send, stop, busy, warm }
}
