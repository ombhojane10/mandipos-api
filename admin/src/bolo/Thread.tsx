import { memo, useState } from 'react'
import { api } from '../api'
import { count, rupees } from '../format'
import { t } from '../i18n'
import { openWhatsApp } from '../keys'
import { href, type Report } from '../routes'
import { booksChanged } from '../useLoad'
import { editEntry, openDraft, openEntry, type EntryKind, type VoiceDraft } from '../entries/kinds'
import { exportWhenReady } from '../export/doc'
import { AnswerTable, VoiceCard } from '../voice/Cards'
import { speakLocal } from '../voice/speak'
import { speakText } from '../voice/player'
import { chatStore, type Msg, type Turn } from './chats'
import { spoken } from './useBolo'
import { loadOptions, useOptions, type Options } from './options'

type Send = (input: { text?: string; pick?: string; pickLabel?: string }) => void

const OPEN: Record<string, Report> = {
  home: 'dashboard', gaadiyan: 'stock', grahak: 'outstanding', hisab: 'dashboard', aaya_gaya: 'cashbook',
  vasooli: 'vasooli', mazdoori: 'daybook', supplier: 'suppliers', settings: 'settings', gaadi_hisab: 'gaadis',
}
const ENTRY_OPEN: Record<string, EntryKind> = { nayi_parchi: 'parchi', nayi_gaadi: 'gaadi' }
const DOWNLOAD: Record<string, Report> = {
  daybook: 'daybook', outstanding: 'outstanding', cashbook: 'cashbook', stock: 'stock', register: 'register',
  suppliers: 'suppliers', vasooli: 'vasooli', gaadis: 'gaadis', munafa: 'munafa', items: 'items',
}
const ROMAN: Record<string, string> = { '1': 'I', '2': 'II', '3': 'III', mix: 'Leak' }

/** The thread: what was asked, and Bolo's answer as cards, questions to tap, or a slip to save. */
export function Thread({ shopId, chatId, msgs, send, busy }: { shopId: string; chatId: string; msgs: Msg[]; send: Send; busy: boolean }) {
  const lastBolo = [...msgs].reverse().find((m) => m.role === 'bolo')?.id
  return (
    <div className="bc-thread">
      {msgs.map((m) => m.role === 'me'
        ? <Mine key={m.id} m={m} />
        : <Answer key={m.id} m={m} shopId={shopId} chatId={chatId} send={send} live={m.id === lastBolo && !busy} />)}
    </div>
  )
}

const Mine = memo(function Mine({ m }: { m: Msg }) {
  return (
    <div className="bc-me">
      <div className="bc-bubble">
        {m.voiceMs ? <span className="bc-voice-tag"><svg viewBox="0 0 24 24" aria-hidden><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0" /></svg>{Math.max(1, Math.round(m.voiceMs / 1000))}s</span> : null}
        {m.text || <span className="bc-muted">…</span>}
      </div>
    </div>
  )
})

function Answer({ m, shopId, chatId, send, live }: { m: Msg; shopId: string; chatId: string; send: Send; live: boolean }) {
  const r = m.turn
  return (
    <div className="bc-bolo">
      <span className="bc-avatar" aria-hidden><BoloMark /></span>
      <div className="bc-body">
        {m.thinking && <div className="bc-thinking"><i /><i /><i /><span>{t('Hisab dekh rahe hain')}</span></div>}
        {m.error && <p className="bc-error">{m.error}</p>}
        {r && <TurnView r={r} m={m} shopId={shopId} chatId={chatId} send={send} live={live} />}
      </div>
    </div>
  )
}

function TurnView({ r, m, shopId, chatId, send, live }: { r: Turn; m: Msg; shopId: string; chatId: string; send: Send; live: boolean }) {
  const miss = r.editMiss ?? r.downloadMiss ?? r.whatsappMiss
  const text = r.ask ? r.ask.question
    // A table says it all: its title above it, the full sentence is for speaking.
    : r.answer ? (r.answer.rows.length ? r.answer.title : r.answer.say)
      : r.say ? r.say
        : miss ?? (!r.cards?.length && !r.draft && !r.edit && !r.download && !r.open && !r.go ? r.reply?.say : '')
  const done = !!(r.sent || r.saved)
  const follow = live ? followUps(r) : []
  return (
    <>
      {text && <p className={`bc-text${done ? ' done' : ''}${miss || r.reply?.kind === 'unclear' ? ' warn' : ''}`}>{done && <Tick />}{text}</p>}
      {r.ask && <AskView r={r} send={send} live={live} />}
      {r.answer && <AnswerTable a={r.answer} shopId={shopId} />}
      {r.cards?.map((c, i) => <VoiceCard key={i} c={c} shopId={shopId} />)}
      {r.draft && <DraftCard d={r.draft} shopId={shopId} savedAs={m.savedAs} onSaved={(no) => chatStore.patchMsg(shopId, chatId, m.id, { savedAs: no })} />}
      <Actions r={r} shopId={shopId} />
      <div className="bc-row-tools">
        {spoken(r) && <button type="button" className="bc-icon" aria-label={t('Sunein')} title={t('Sunein')} onClick={() => void speakText(shopId, spoken(r), speakLocal)}>
          <svg viewBox="0 0 24 24" aria-hidden><path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /></svg>
        </button>}
      </div>
      {follow.length > 0 && <div className="bc-follow">{follow.map((f) => <button key={f} type="button" className="bc-chip" onClick={() => send({ text: f })}>{f}</button>)}</div>}
    </>
  )
}

function AskView({ r, send, live }: { r: Turn; send: Send; live: boolean }) {
  const a = r.ask!
  return (
    <div className="bc-ask">
      {a.detail?.length ? <div className="bc-detail">{a.detail.map((l, i) => <div key={i}>{l}</div>)}</div> : null}
      {a.options.length > 0 && (
        <div className="bc-options">
          {a.options.map((o) => (
            <button key={o.value} type="button" disabled={!live} className={`bc-option${a.tap && o.value === 'yes' ? ' primary' : ''}${o.value === 'cancel' ? ' quiet' : ''}`}
              onClick={() => send({ pick: o.value, pickLabel: o.label })}>{o.label}</button>
          ))}
        </div>
      )}
      {live && (a.expect === 'phone' || a.expect === 'number' || a.expect === 'text') && <p className="bc-hint">{a.expect === 'phone' ? t('Number neeche likhein ya boliye') : t('Neeche likhein ya boliye')}</p>}
    </div>
  )
}

/** What Bolo found to do that takes the person somewhere: a button, never a jump out of the chat. */
function Actions({ r, shopId }: { r: Turn; shopId: string }) {
  const items: { label: string; go: () => void; primary?: boolean }[] = []
  if (r.edit) items.push({ label: t('Parchi #{n} badlein', { n: String(r.edit.slipNo ?? '') }), primary: true, go: () => editEntry({ kind: 'parchi', bill: r.edit! }) })
  if (r.download) {
    const d = r.download
    items.push({ label: d.format === 'excel' ? t('Excel download') : t('PDF download'), primary: true, go: () => {
      const period = d.from ? `?from=${d.from}&to=${d.to ?? d.from}` : ''
      location.hash = (d.report === 'ledger' && d.buyerId ? href({ page: 'grahak', shopId, buyerId: d.buyerId })
        : href({ page: 'report', shopId, report: DOWNLOAD[d.report] ?? 'daybook' })) + period
      exportWhenReady(d.format)
    } })
  }
  if (r.go) items.push({ label: t('Khata kholein'), primary: true, go: () => { location.hash = href({ page: 'grahak', shopId: r.go!.shopId, buyerId: r.go!.buyerId }) } })
  if (r.open) {
    const o = r.open
    const entry = ENTRY_OPEN[o.to]
    items.push({ label: entry ? (entry === 'gaadi' ? t('Nayi Gaadi') : t('Nayi Parchi')) : t('Kholein'), primary: true, go: () => {
      if (entry) openEntry(entry)
      else location.hash = o.to === 'grahak_khata' && o.buyerId ? href({ page: 'grahak', shopId, buyerId: o.buyerId }) : href({ page: 'report', shopId, report: OPEN[o.to] ?? 'dashboard' })
    } })
  }
  if (r.call) items.push({ label: t('Call {name}', { name: r.call.name }), primary: true, go: () => { location.href = `tel:+91${r.call!.phone}` } })
  if (r.whatsapp) items.push({ label: t('WhatsApp {name}', { name: r.whatsapp.name }), primary: true, go: () => openWhatsApp(shopId, r.whatsapp!.buyerId) })
  const udhaar = r.cards?.find((c) => c.view === 'udhaar')
  if (udhaar && udhaar.view === 'udhaar') items.push({ label: t('Khata kholein'), go: () => { location.hash = href({ page: 'grahak', shopId, buyerId: udhaar.buyerId }) } })
  if (!items.length) return null
  return <div className="bc-actions">{items.map((x) => <button key={x.label} type="button" className={`bc-btn${x.primary ? ' primary' : ''}`} onClick={x.go}>{x.label}</button>)}</div>
}

/** Two or three next questions, from what was just answered. */
function followUps(r: Turn): string[] {
  if (r.ask || r.draft || r.sent || r.saved) return []
  const out: string[] = []
  for (const c of r.cards ?? []) {
    if (c.view === 'udhaar') out.push(`${c.name} ko udhaar WhatsApp karo`, `${c.name} ki aakhri parchi`)
    if (c.view === 'udhaar_list') out.push('Sabse purana udhaar kiska hai', '30 din se kisne paisa nahi diya')
    if (c.view === 'bikri') out.push('Kal ki bikri kitni thi', 'Is hafte sabse zyada kisne kharida')
    if (c.view === 'stock') out.push('Sabse purani gaadi kaunsi hai')
  }
  const cols = r.answer?.columns ?? []
  if (cols.includes('jagah')) out.push('Aaj dispatch kitna baaki hai')
  if (cols.includes('baaki_box')) out.push('Kaunsi gaadi kahan khadi hai')
  return [...new Set(out)].slice(0, 3)
}

// ================================================================ a slip, vasooli or kharcha to save

/** Bolo's draft as a card: check it here and Save — or Badlein opens the full form, filled in. */
function DraftCard({ d, shopId, savedAs, onSaved }: { d: VoiceDraft; shopId: string; savedAs?: string; onSaved: (no: string) => void }) {
  const o = useOptions(shopId)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const plan = o ? planOf(d, o) : null
  const save = async () => {
    if (!plan?.ready || saving) return
    setSaving(true); setError('')
    try {
      const r = await api<{ slipNo?: number; receiptNo?: number }>(`/v1/admin/shops/${shopId}${plan.path}`, { method: 'POST', body: plan.body })
      booksChanged(); void loadOptions(shopId, true)
      onSaved(r.slipNo ? `#${r.slipNo}` : r.receiptNo ? `#${r.receiptNo}` : '✓')
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  return (
    <div className={`bc-card draft${savedAs ? ' saved' : ''}`}>
      <div className="bc-card-hd">
        <b>{plan?.title ?? '…'}</b>
        {plan?.tag && <span className={`bc-tag ${plan.tagTone}`}>{plan.tag}</span>}
      </div>
      {plan?.rows.map((x, i) => <div key={i} className="bc-line"><span>{x[0]}</span><b>{x[1]}</b></div>)}
      {plan && plan.total !== null && <div className="bc-line total"><span>{t('Kul')}</span><b>{rupees(plan.total)}</b></div>}
      {d.notes.length > 0 && !savedAs && <p className="bc-note">{d.notes.join(' · ')}</p>}
      {!savedAs && plan?.over?.length ? <div className="bc-over"><b>{t('Gaadi mein itne box nahi')}</b>{plan.over.map((x) => <div key={x}>{x}</div>)}</div> : null}
      {error && <p className="bc-error">{error}</p>}
      {savedAs
        ? <div className="bc-saved"><Tick />{t('{what} {no} save hui', { what: plan?.noun ?? t('Entry'), no: savedAs === '✓' ? '' : savedAs })}</div>
        : (
          <div className="bc-card-ft">
            <button type="button" className="bc-btn" onClick={() => openDraft(d)}>{t('Badlein')}</button>
            <button type="button" className="bc-btn primary" disabled={!plan?.ready || saving} title={plan && !plan.ready ? plan.missing : undefined} onClick={() => void save()}>
              {saving ? '…' : plan && !plan.ready ? plan.missing : plan?.over?.length ? t('Phir bhi save') : t('Save')}
            </button>
          </div>
        )}
    </div>
  )
}

type Plan = { title: string; noun: string; tag: string; tagTone: string; rows: [string, string][]; total: number | null; ready: boolean; missing: string; path: string; body: unknown; over?: string[] }

const PAY: Record<string, [string, string]> = { cash: ['Cash', 'green'], upi: ['UPI', 'blue'], credit: ['Udhaar', 'amber'], after: ['Baad mein', 'amber'], split: ['Kuch', 'amber'], free: ['Free', 'grey'] }

function planOf(d: VoiceDraft, o: Options): Plan {
  if (d.kind === 'kharcha') {
    const head = d.category ?? (d.dir === 'in' ? 'aur_aaya' : 'kharcha')
    return {
      title: d.dir === 'in' ? t('Aaya') : t('Kharcha'), noun: t('Entry'), tag: head.replace(/_/g, ' '), tagTone: d.dir === 'in' ? 'green' : 'amber',
      rows: d.note ? [[t('Kis cheez ka'), d.note]] : [], total: d.amountPaise,
      ready: d.amountPaise > 0 && (!head.startsWith('aur_') || !!d.note.trim()), missing: d.amountPaise > 0 ? t('Wajah likhein') : t('Rakam bataiye'),
      path: '/entries/daybook', body: { direction: d.dir, category: head, mode: 'cash', amountPaise: d.amountPaise, note: d.note || undefined },
    }
  }
  if (d.kind === 'vasooli') {
    const total = d.cashPaise + d.upiPaise
    return {
      title: d.buyer?.name ?? t('Grahak?'), noun: t('Vasooli'), tag: t('Vasooli'), tagTone: 'green',
      rows: [...(d.cashPaise ? [[t('Cash'), rupees(d.cashPaise)] as [string, string]] : []), ...(d.upiPaise ? [['UPI', rupees(d.upiPaise)] as [string, string]] : [])],
      total, ready: !!d.buyer?.id && total > 0, missing: d.buyer?.id ? t('Rakam bataiye') : t('Grahak chunein'),
      path: '/entries/vasooli', body: { buyerId: d.buyer?.id, cashPaise: d.cashPaise, upiPaise: d.upiPaise },
    }
  }
  // A parchi: grapes lines are each a quality off a gaadi; coconut lines are grades off one gaadi.
  const pay = d.pay ?? (d.buyer?.id || (d.buyer && !d.buyer.id && !/^(cash|bank)$/i.test(d.buyer.name)) ? 'credit' : 'cash')
  const credit = pay === 'credit' || pay === 'after'
  const free = pay === 'free'
  const buyer = d.buyer
  const [tag, tone] = PAY[pay] ?? ['', 'grey']
  const angoor = !!d.lots?.length
  const lines = angoor
    ? d.lots!.map((l) => { const lot = o.lots?.find((x) => x.truckId === l.truckId && x.brandId === l.brandId); return { label: lot ? `${lot.quality} · ${lot.number}` : t('Quality?'), qty: l.qty, rate: l.ratePaise, ok: !!lot } })
    : d.lines.map((l) => ({ label: ROMAN[l.grade] ?? l.grade, qty: l.qty, rate: l.ratePaise, ok: true }))
  const goods = free ? 0 : lines.reduce((s, l) => s + l.qty * l.rate, 0)
  const boxes = lines.reduce((s, l) => s + l.qty, 0)
  const apmc = angoor && o.apmcOn ? Math.round(goods * 0.01) : 0
  const labourRate = (() => { try { return Number(localStorage.getItem('mp.angoorLabourRate') ?? '1000') || 1000 } catch { return 1000 } })()
  const labour = angoor && credit && d.labour ? boxes * labourRate : 0
  const truck = !angoor ? o.trucks.find((x) => x.id === d.truckId) : null
  const unit = angoor || o.commodity === 'amrud' ? 'box' : 'dana'
  const rows: [string, string][] = [
    ...(truck ? [[t('Gaadi'), [truck.number, truck.brand].filter(Boolean).join(' · ')] as [string, string]] : []),
    ...lines.map((l) => [l.label, l.rate || free ? `${count(l.qty)} ${unit} × ${free ? '0' : count(l.rate / 100)}` : `${count(l.qty)} ${unit} · ${t('bhav?')}`] as [string, string]),
    ...(apmc ? [['APMC 1%', rupees(apmc)] as [string, string]] : []),
    ...(labour ? [[t('Mazdoori'), rupees(labour)] as [string, string]] : []),
  ]
  const missing = !lines.length || lines.some((l) => !l.qty) ? t('Box/dana bataiye')
    : lines.some((l) => !l.ok) ? t('Quality chunein')
      : !angoor && !truck ? t('Gaadi chunein')
        : !free && lines.some((l) => !l.rate) ? t('Bhav bataiye')
          : credit && !buyer ? t('Grahak chunein')
            : pay === 'split' && d.cashPaise + d.upiPaise <= 0 ? t('Cash/UPI bataiye')
              // The delivery pata is the form's to take.
              : d.delivery ? t('Pata Badlein mein') : ''
  const buyerBody = buyer?.id ? { buyerId: buyer.id } : buyer?.name ? { buyerName: buyer.name } : {}
  const body = angoor
    ? { ...buyerBody, lots: d.lots, pay, cashPaise: d.cashPaise || undefined, upiPaise: d.upiPaise || undefined, labour: credit && d.labour, labourRatePaise: labourRate }
    : {
      ...buyerBody, truckId: d.truckId, lines: d.lines, pay, cashPaise: d.cashPaise || undefined, upiPaise: d.upiPaise || undefined,
      packing: d.packing === 'katta' ? (d.size ?? 'katta10') : d.packing === 'panni' ? 'panni' : 'loose',
      panniName: d.panni || undefined, kattaName: d.kattaName || undefined, parchune: d.parchune || undefined, labour: d.labour || undefined,
    }
  // Grapes overbooking: more boxes than the gaadi shows — warned on the card, still savable.
  const over = angoor ? d.lots!.flatMap((l) => {
    const lot = o.lots?.find((x) => x.truckId === l.truckId && x.brandId === l.brandId)
    return lot && l.qty > lot.left ? [t('{what}: {left} box baaki, {q} likhe ({n} zyada)', { what: `${lot.quality} · ${lot.number}`, left: count(Math.max(0, lot.left)), q: count(l.qty), n: count(l.qty - Math.max(0, lot.left)) })] : []
  }) : []
  return {
    title: buyer?.name ?? t('Cash grahak'), noun: t('Parchi'), tag, tagTone: tone, rows, total: goods + apmc + labour,
    ready: !missing, missing, path: '/entries/parchi', body, over,
  }
}

function Tick() {
  return <svg className="bc-tick" viewBox="0 0 24 24" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
}

/** Bolo's mark: a speech bubble with a sound wave inside — the one place it has a face. */
export function BoloMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5z" />
      <path d="M9 8v3M12 6.5v6M15 8v3" />
    </svg>
  )
}
