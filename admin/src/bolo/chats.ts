import { useSyncExternalStore } from 'react'
import type { EditBill, VoiceDraft } from '../entries/kinds'
import type { Answer, Card } from '../voice/Cards'

/** What one turn of POST /voice answers (PortalVoiceService.turn), kept whole in the thread. */
export type Ask = { question: string; expect: 'phone' | 'choice' | 'yes' | 'number' | 'text'; options: { label: string; value: string }[]; detail?: string[]; tap?: boolean }
export type Turn = {
  reply?: { transcript: string; kind: string; say: string }
  ask?: Ask; say?: string; sent?: unknown; saved?: unknown
  draft?: VoiceDraft; cards?: Card[]; answer?: Answer
  call?: { phone: string; name: string }; go?: { shopId: string; buyerId: string }
  open?: { to: string; buyerId: string | null; truckId: string | null }
  edit?: EditBill; editMiss?: string; downloadMiss?: string
  whatsapp?: { buyerId: string; name: string }; whatsappMiss?: string
  download?: { report: string; format: 'pdf' | 'excel'; buyerId: string | null; from: string | null; to: string | null }
}

export type Msg = {
  id: string; at: number
  /** me: what was typed, said or tapped. bolo: the answer, or 'thinking' while it is worked out. */
  role: 'me' | 'bolo'
  text?: string; voiceMs?: number
  turn?: Turn; error?: string; thinking?: boolean
  /** A draft saved from its card: the slip number it became. */
  savedAs?: string
}
export type Chat = { id: string; session: string; title: string; at: number; msgs: Msg[] }

/**
 * The conversations, per shop, kept on this computer (the server keeps a session only for its
 * ten-minute memory). One store feeds the full page and the side panel, so they share the thread.
 */
const MAX_CHATS = 30, MAX_MSGS = 80
const key = (shopId: string) => `bolo.chats.${shopId}`
type State = { chats: Chat[]; current: string | null }
const states = new Map<string, State>()
const listeners = new Set<() => void>()

function read(shopId: string): State {
  let s = states.get(shopId)
  if (!s) {
    let chats: Chat[] = []
    try { chats = JSON.parse(localStorage.getItem(key(shopId)) ?? '[]') as Chat[] } catch { /* a fresh start */ }
    // A turn cut off by a reload is not still thinking.
    chats = chats.map((c) => ({ ...c, msgs: c.msgs.filter((m) => !m.thinking) }))
    s = { chats, current: null }
    states.set(shopId, s)
  }
  return s
}

function write(shopId: string, next: State) {
  states.set(shopId, next)
  try {
    const keep = next.chats.filter((c) => c.msgs.length).slice(0, MAX_CHATS).map((c) => ({ ...c, msgs: c.msgs.filter((m) => !m.thinking).slice(-MAX_MSGS) }))
    localStorage.setItem(key(shopId), JSON.stringify(keep))
  } catch { /* storage full or private: the thread still lives for this visit */ }
  listeners.forEach((l) => l())
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)

export function useChats(shopId: string) {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => read(shopId))
}

export const chatStore = {
  get: (shopId: string) => read(shopId),
  current(shopId: string): Chat | null {
    const s = read(shopId)
    return s.chats.find((c) => c.id === s.current) ?? null
  },
  /** The open chat, made when the first message goes. */
  ensure(shopId: string): Chat {
    const s = read(shopId)
    const hit = s.chats.find((c) => c.id === s.current)
    if (hit) return hit
    const c: Chat = { id: uid(), session: uid(), title: '', at: Date.now(), msgs: [] }
    write(shopId, { chats: [c, ...s.chats], current: c.id })
    return c
  },
  fresh(shopId: string) { write(shopId, { ...read(shopId), current: null }) },
  open(shopId: string, id: string) { write(shopId, { ...read(shopId), current: id }) },
  remove(shopId: string, id: string) {
    const s = read(shopId)
    write(shopId, { chats: s.chats.filter((c) => c.id !== id), current: s.current === id ? null : s.current })
  },
  /** Changes one chat; the chat moves to the top of the list. */
  update(shopId: string, id: string, fn: (c: Chat) => Chat) {
    const s = read(shopId)
    const c = s.chats.find((x) => x.id === id)
    if (!c) return
    const next = { ...fn(c), at: Date.now() }
    write(shopId, { ...s, chats: [next, ...s.chats.filter((x) => x.id !== id)] })
  },
  patchMsg(shopId: string, chatId: string, msgId: string, patch: Partial<Msg>) {
    chatStore.update(shopId, chatId, (c) => ({ ...c, msgs: c.msgs.map((m) => (m.id === msgId ? { ...m, ...patch } : m)) }))
  },
}
