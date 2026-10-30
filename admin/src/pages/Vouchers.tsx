import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useSession } from '../App'
import { api, type BuyerRow, type ShopSettings } from '../api'
import { count, date, phone as fmtPhone, rate as fmtRate, rupees, todayIst } from '../format'
import { usePeriod } from '../hooks'
import { t } from '../i18n'
import { openVoucher } from '../keys'
import { openDraft } from '../entries/kinds'
import { hashQuery, href, setHashQuery } from '../routes'
import { booksChanged, useLoad } from '../useLoad'
import { PeriodBar, Skeleton } from '../ui'
import { dayRange, dmyLong, fileName, rs, useExport } from '../export/doc'
import { BuyerPicker, Field, Money, Seg, Sheet, Tick, type PickedBuyer } from '../entries/fields'

// ================================================================ Vouchers: JV, Credit Note, Invoices, Bikri Entry

type Kind = 'grahak' | 'supplier' | 'head'
type SideRow = { kind: Kind; ref: string; name: string }
type Jv = { id: string; no: number; date: string; dr: SideRow; cr: SideRow; amountPaise: number; narration: string; by: string; at: string; voided: boolean }
type JvOptions = { heads: { key: string; name: string; type: string }[]; suppliers: string[]; nextNo: number }
type Reason = 'rate' | 'kharab' | 'wapsi' | 'discount' | 'other'
type CnLine = { quality: string; grade: string; boxes: number; ratePaise: number; amountPaise: number }
type Cn = {
  id: string; no: number; date: string; buyerId: string; buyerName: string; billId: string | null; slipNo: number | null; reason: Reason
  lines: CnLine[]; amountPaise: number; note: string; by: string; at: string; voided: boolean
  buyer?: { name: string; code: string; phone: string; address: string; gstin: string }
}
type InvoiceRow = { id: string; number: string; date: string; buyerId: string | null; buyerName: string; totalPaise: number; slips: number; slipNos: number[]; gstin: string; voided: boolean; voidReason: string }
type InvoiceDoc = {
  id: string; number: string; date: string; fy: string; commodity: string; item: string; voided: boolean; voidReason: string
  seller: { name: string; address: string; mandi: string; shopNo: string; gstin: string; licenceNo: string; phone: string; email: string; contactPerson: string; banks: { holder: string; bank: string; ifsc: string; account: string; branch?: string }[] }
  buyer: { name: string; code: string; address: string; phone: string; gstin: string }
  slips: { billId: string; slipNo: number | null; date: string }[]
  lines: { slipNo: number | null; date: string; quality: string; grade: string; gaadi: string; hsn: string; qty: number; unit: string; kg: number; ratePaise: number; amountPaise: number }[]
  charges: { label: string; amountPaise: number }[]
  goodsPaise: number; chargesPaise: number; taxRate: number; taxPaise: number; taxNote: string; totalPaise: number; words: string
}

const REASONS: { key: Reason; label: string }[] = [
  { key: 'rate', label: t('Rate farq') }, { key: 'kharab', label: t('Maal kharab') }, { key: 'wapsi', label: t('Maal wapas') }, { key: 'discount', label: t('Discount') }, { key: 'other', label: t('Aur') },
]
const reasonLabel = (r: Reason) => REASONS.find((x) => x.key === r)?.label ?? r
/** A coconut grade as the counter says it: 1st, 2nd, 3rd, Mix. */
const gradeLabel = (g: string) => ({ '1': '1st', '2': '2nd', '3': '3rd', mix: 'Mix' } as Record<string, string>)[g] ?? g
const KINDS: { key: Kind; label: string }[] = [{ key: 'grahak', label: t('Grahak') }, { key: 'supplier', label: t('Supplier') }, { key: 'head', label: t('Head') }]
const caps = { textTransform: 'uppercase' as const }
const useCaps = (shopId: string) => useSession().shops?.find((s) => s.id === shopId)?.commodity === 'angoor'

/** Rupees in Indian words: "Rupees One Lakh Twenty Thousand Only". */
function inWords(paise: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  const two = (x: number) => (x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]} ${ones[x % 10]}`.trim())
  const three = (x: number) => [x >= 100 ? `${ones[Math.floor(x / 100)]} Hundred` : '', two(x % 100)].filter(Boolean).join(' ')
  let r = Math.floor(Math.abs(paise) / 100)
  const p = Math.round(Math.abs(paise) % 100)
  if (!r && !p) return 'Rupees Zero Only'
  const parts: string[] = []
  const crore = Math.floor(r / 1e7); r %= 1e7
  const lakh = Math.floor(r / 1e5); r %= 1e5
  const thousand = Math.floor(r / 1e3); r %= 1e3
  if (crore) parts.push(`${three(crore)} Crore`)
  if (lakh) parts.push(`${two(lakh)} Lakh`)
  if (thousand) parts.push(`${two(thousand)} Thousand`)
  if (r) parts.push(three(r))
  return `Rupees ${parts.join(' ')}${p ? ` and ${two(p)} Paise` : ''} Only`.replace(/\s+/g, ' ')
}

/** A register's search box, kept in the URL with the period. */
function useQuery(key = 'q'): [string, (v: string) => void] {
  const [q, setQ] = useState(() => hashQuery().get(key) ?? '')
  return [q, (v: string) => { setQ(v); setHashQuery({ ...Object.fromEntries(hashQuery()), [key]: v }) }]
}
/** Debounced, so a register does not ask the server on every key. */
function useDebounced<T>(v: T, ms = 250): T {
  const [d, setD] = useState(v)
  useEffect(() => { const x = setTimeout(() => setD(v), ms); return () => clearTimeout(x) }, [v, ms])
  return d
}

// ================================================================ Journal Voucher

/** The JV register: every voucher in the period, struck-out ones too; a row opens it to alter or delete. */
export function JournalVouchers({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('30')
  const [q, setQ] = useQuery()
  const dq = useDebounced(q)
  const [open, setOpen] = useState<Jv | 'new' | null>(null)
  const [toast, say] = useToast()
  const { data, error, loading } = useLoad(() => api<{ vouchers: Jv[]; totalPaise: number }>(
    `/v1/admin/shops/${shopId}/jv?from=${period.from}&to=${period.to}&q=${encodeURIComponent(dq)}`), [shopId, period.from, period.to, dq])
  useExport(data ? () => ({
    style: 'book' as const, title: t('Journal Voucher'), dateLine: dayRange(period.from, period.to), file: fileName('JV', period.from, period.to),
    columns: [{ label: t('No.') }, { label: t('Tarikh') }, { label: t('Naam (Dr)') }, { label: t('Jama (Cr)') }, { label: t('Narration'), wide: true }, { label: t('Rakam'), num: true }],
    rows: data.vouchers.map((v) => ({ strike: v.voided, cells: [String(v.no), dmyLong(v.date), v.dr.name, v.cr.name, v.narration, rs(v.amountPaise)] })),
    foot: ['', '', '', '', t('Kul'), rs(data.totalPaise)],
  }) : null, [data])
  return (
    <>
      <div className="toolbar">
        <PeriodBar value={period} onChange={setPeriod} />
        <input className="field search grow" data-search type="search" placeholder={t('Naam, narration ya JV no.')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn primary" onClick={() => setOpen('new')}>+ {t('JV')}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th className="opt-col">{t('No.')}</th><th className="opt-col">{t('Tarikh')}</th><th>{t('Naam (Dr)')}</th><th>{t('Jama (Cr)')}</th><th className="opt-col">{t('Narration')}</th><th className="num">{t('Rakam')}</th></tr></thead>
            <tbody>
              {data.vouchers.map((v) => (
                <tr key={v.id} data-row tabIndex={0} className={v.voided ? 'muted' : ''} onClick={() => setOpen(v)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(v) }}>
                  <td className="opt-col money">{v.no}</td>
                  <td className="opt-col muted">{date(v.date)}</td>
                  <td className="main-col"><b style={v.voided ? { textDecoration: 'line-through' } : undefined}>{v.dr.name}</b><small><span className="show-sm">#{v.no} · {date(v.date)} · </span>{t(KINDS.find((k) => k.key === v.dr.kind)!.label)}</small></td>
                  <td><span style={v.voided ? { textDecoration: 'line-through' } : undefined}>{v.cr.name}</span><small>{t(KINDS.find((k) => k.key === v.cr.kind)!.label)}</small></td>
                  <td className="opt-col muted">{v.narration}{v.voided && <span className="chip grey" style={{ marginLeft: 6 }}>{t('Hata diya')}</span>}</td>
                  <td className="num amt-col money b">{rupees(v.amountPaise)}</td>
                </tr>
              ))}
            </tbody>
            {data.vouchers.length > 0 && <tfoot><tr><td className="opt-col" /><td className="opt-col" /><td><b>{t('Kul')}</b></td><td /><td className="opt-col" /><td className="num money b">{rupees(data.totalPaise)}</td></tr></tfoot>}
          </table>
          {data.vouchers.length === 0 && <p className="empty">{t('Is samay koi JV nahi')}</p>}
        </div>
      )}
      {open && <JvSheet shopId={shopId} jv={open === 'new' ? null : open} onClose={() => setOpen(null)} onDone={(m) => { setOpen(null); say(m) }} />}
      {toast}
    </>
  )
}

type Acct = { kind: Kind; buyer: PickedBuyer | null; name: string; key: string }
const blankAcct = (kind: Kind = 'grahak'): Acct => ({ kind, buyer: null, name: '', key: '' })
const fromSide = (s: SideRow): Acct => ({ kind: s.kind, buyer: s.kind === 'grahak' ? { id: s.ref, name: s.name } : null, name: s.kind === 'supplier' ? s.name : '', key: s.kind === 'head' ? s.ref : '' })
const acctBody = (a: Acct) => (a.kind === 'grahak' ? { kind: 'grahak', id: a.buyer?.id } : a.kind === 'supplier' ? { kind: 'supplier', name: a.name.trim() } : { kind: 'head', key: a.key })
const acctName = (a: Acct, o: JvOptions | null) => (a.kind === 'grahak' ? a.buyer?.name ?? '' : a.kind === 'supplier' ? a.name.trim() : o?.heads.find((h) => h.key === a.key)?.name ?? '')
const acctReady = (a: Acct) => (a.kind === 'grahak' ? !!a.buyer?.id : a.kind === 'supplier' ? !!a.name.trim() : !!a.key)
/** A supplier name as the books match it (case, spaces and dots aside). */
const supKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
/** Both sides the same account: a voucher that would move nothing. */
const sameAcct = (a: Acct, b: Acct) => a.kind === b.kind && acctReady(a) && acctReady(b)
  && (a.kind === 'grahak' ? a.buyer?.id === b.buyer?.id : a.kind === 'supplier' ? supKey(a.name) === supKey(b.name) : a.key === b.key)
/** What a side does, in plain words: who owes more or less, what we owe, which kharcha or aamdani. */
function effect(a: Acct, dr: boolean, paise: number, o: JvOptions | null): [string, string] | null {
  const name = acctName(a, o)
  if (!name || !paise) return null
  const amt = rupees(paise)
  if (a.kind === 'grahak') return [name, dr ? t('baaki {amt} badhega', { amt }) : t('baaki {amt} ghatega', { amt })]
  if (a.kind === 'supplier') return [name, dr ? t('humara dena {amt} ghatega', { amt }) : t('humara dena {amt} badhega', { amt })]
  const income = o?.heads.find((h) => h.key === a.key)?.type === 'income'
  return [name, income ? (dr ? t('aamdani {amt} kam', { amt }) : t('aamdani {amt}', { amt })) : (dr ? t('kharcha {amt}', { amt }) : t('kharcha {amt} kam', { amt }))]
}

/** One account: grahak (by name, mobile or code), supplier (by name), or a ledger head (or a new one). The other side's account is not offered. */
function AccountPicker({ shopId, value, onChange, o, reload, autoFocus, other }: {
  shopId: string; value: Acct; onChange: (a: Acct) => void; o: JvOptions | null; reload: () => Promise<JvOptions | null>; autoFocus?: boolean; other: Acct
}) {
  const upper = useCaps(shopId)
  const [newHead, setNewHead] = useState<{ name: string; type: 'expense' | 'income' } | null>(null)
  const [err, setErr] = useState('')
  const make = async () => {
    if (!newHead?.name.trim()) return setErr(t('Naam daalein'))
    try {
      const r = await api<{ id: string }>(`/v1/admin/shops/${shopId}/heads`, { method: 'POST', body: { name: upper ? newHead.name.toUpperCase() : newHead.name, type: newHead.type } })
      await reload(); onChange({ ...value, key: `h:${r.id}` }); setNewHead(null); setErr('')
    } catch (e) { setErr((e as Error).message) }
  }
  const [listId] = useState(() => `jv-sup-${Math.random().toString(36).slice(2, 7)}`)
  const otherSup = other.kind === 'supplier' && other.name.trim() ? supKey(other.name) : null
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Seg value={value.kind} onChange={(k) => onChange(blankAcct(k))} options={KINDS} />
      {value.kind === 'grahak' && <BuyerPicker shopId={shopId} value={value.buyer} autoFocus={autoFocus} exclude={other.kind === 'grahak' ? [other.buyer?.id] : undefined}
        onChange={(b) => onChange({ ...value, buyer: b?.id ? b : null })} />}
      {value.kind === 'supplier' && <>
        <input className="field" style={upper ? caps : undefined} list={listId} placeholder={t('Supplier ka naam')} value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} />
        <datalist id={listId}>{o?.suppliers.filter((s) => supKey(s) !== otherSup).map((s) => <option key={s} value={s} />)}</datalist>
      </>}
      {value.kind === 'head' && !newHead && (
        <select className="field" value={value.key} onChange={(e) => (e.target.value === '__new' ? setNewHead({ name: '', type: 'expense' }) : onChange({ ...value, key: e.target.value }))}>
          <option value="">—</option>
          {o?.heads.filter((h) => !(other.kind === 'head' && other.key === h.key) || h.key === value.key).map((h) => <option key={h.key} value={h.key}>{h.name}</option>)}
          <option value="__new">+ {t('Naya head')}</option>
        </select>
      )}
      {value.kind === 'head' && newHead && (
        <div className="row2">
          <input className="field" style={upper ? caps : undefined} autoFocus placeholder={t('Head ka naam (Discount, Byaaj…)')} value={newHead.name} onChange={(e) => setNewHead({ ...newHead, name: e.target.value })} />
          <div style={{ display: 'flex', gap: 6 }}>
            <select className="field" value={newHead.type} onChange={(e) => setNewHead({ ...newHead, type: e.target.value as 'expense' | 'income' })}>
              <option value="expense">{t('Kharcha')}</option><option value="income">{t('Aamdani')}</option>
            </select>
            <button type="button" className="btn" onClick={() => void make()}>{t('Banayein')}</button>
            <button type="button" className="icon-btn" aria-label={t('Rehne dein')} onClick={() => setNewHead(null)}>✕</button>
          </div>
        </div>
      )}
      {err && <p className="error" style={{ margin: 0 }}>{err}</p>}
    </div>
  )
}

/**
 * A JV: whose khata is debited (naam) and whose credited (jama), amount, date, narration. Opened
 * on one, it alters it or deletes it. A JV moves an amount between khatas without cash; money
 * received from a grahak is a Vasooli, which is one tap away when the form looks like one.
 */
export function JvSheet({ shopId, jv, onClose, onDone }: { shopId: string; jv: Jv | null; onClose: () => void; onDone: (msg: string) => void }) {
  const [o, setO] = useState<JvOptions | null>(null)
  const reload = () => api<JvOptions>(`/v1/admin/shops/${shopId}/jv/options`).then((r) => { setO(r); return r }).catch(() => null)
  useEffect(() => { void reload() }, [shopId]) // eslint-disable-line react-hooks/exhaustive-deps
  const [day, setDay] = useState(jv?.date ?? todayIst())
  const [dr, setDr] = useState<Acct>(jv ? fromSide(jv.dr) : blankAcct())
  const [cr, setCr] = useState<Acct>(jv ? fromSide(jv.cr) : blankAcct())
  const [amount, setAmount] = useState(jv?.amountPaise ?? 0)
  const [narration, setNarration] = useState(jv?.narration ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [tried, setTried] = useState(false)
  const locked = !!jv?.voided
  const same = sameAcct(dr, cr)
  const bad = {
    dr: tried && !acctReady(dr) ? t('Khata chunein') : '',
    cr: same ? t('Dono taraf ek hi khata — doosra chunein') : tried && !acctReady(cr) ? t('Khata chunein') : '',
    amount: tried && amount <= 0 ? t('Rakam daalein') : '',
  }
  const save = async () => {
    if (locked) return onClose()
    // What is missing is said beside its box.
    setTried(true); setError('')
    if (!acctReady(dr) || !acctReady(cr) || same || amount <= 0) return
    setSaving(true); setError('')
    try {
      const r = await api<{ no: number }>(jv ? `/v1/admin/shops/${shopId}/jv/${jv.id}` : `/v1/admin/shops/${shopId}/jv`, {
        method: 'POST', body: { day, dr: acctBody(dr), cr: acctBody(cr), amountPaise: amount, narration },
      })
      booksChanged(); onDone(t('JV #{n} save hua', { n: String(r.no) }))
    } catch (e) { setError((e as Error).message); setSaving(false) }
  }
  const remove = async () => {
    if (!jv || !confirm(t('JV #{n} hatayein? Khate ulte ho jayenge.', { n: String(jv.no) }))) return
    setSaving(true)
    try { await api(`/v1/admin/shops/${shopId}/jv/${jv.id}/delete`, { method: 'POST' }); booksChanged(); onDone(t('JV #{n} hata diya', { n: String(jv.no) })) }
    catch (e) { setError((e as Error).message); setSaving(false) }
  }
  const lines = same ? [] : [effect(dr, true, amount, o), effect(cr, false, amount, o)].filter((x): x is [string, string] => !!x)
  // A grahak on one side and nothing (or the same grahak) on the other: most likely money came in — that is a Vasooli.
  const lone = !jv && (dr.kind === 'grahak' && dr.buyer?.id && (!acctReady(cr) || same) ? dr.buyer : cr.kind === 'grahak' && cr.buyer?.id && !acctReady(dr) ? cr.buyer : null)
  const vasooli = (b: PickedBuyer) => { onClose(); openDraft({ kind: 'vasooli', buyer: { id: b.id, name: b.name, balancePaise: b.balancePaise }, cashPaise: amount, upiPaise: 0, notes: [] }) }
  return (
    <Sheet wide title={jv ? `JV #${jv.no}${locked ? ` · ${t('Hata diya')}` : ''}` : `${t('Journal Voucher')}${o ? ` #${o.nextNo}` : ''}`}
      onClose={onClose} onSave={() => void save()} saving={saving} error={error} saveLabel={locked ? t('Band karein') : amount ? `${t('Save')} · ${rupees(amount)}` : t('Save')}>
      <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 14, minWidth: 0 }}>
        <div className="row2 jv-sides">
          <Field label={t('Kiske khate mein naam (Dr)')} error={bad.dr}><AccountPicker shopId={shopId} value={dr} onChange={setDr} o={o} reload={reload} autoFocus={!jv} other={cr} /></Field>
          <Field label={t('Kiske khate mein jama (Cr)')} error={bad.cr}><AccountPicker shopId={shopId} value={cr} onChange={setCr} o={o} reload={reload} other={dr} /></Field>
        </div>
        <div className="row2">
          <Field label={t('Rakam')} error={bad.amount}><Money value={amount} onChange={setAmount} /></Field>
          <Field label={t('Tarikh')}><input className="field" type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        </div>
        <Field label={t('Narration')}><input className="field" maxLength={200} value={narration} onChange={(e) => setNarration(e.target.value)} /></Field>
      </fieldset>
      {lines.length > 0 && <div className="total-line jv-preview">{lines.map(([who, what], i) => <div key={i}><b>{who}</b><span>{what}</span></div>)}</div>}
      {lone && <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => vasooli(lone)}>{t('{name} se paisa mila? Vasooli likhein ›', { name: lone.name })}</button>}
      {jv && !locked && <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} disabled={saving} onClick={() => void remove()}>{t('Hatayein')}</button>}
    </Sheet>
  )
}

/** A short "saved" note at the foot of a register page. */
function useToast(): [ReactNode, (m: string) => void] {
  const [msg, setMsg] = useState('')
  useEffect(() => { if (!msg) return; const x = setTimeout(() => setMsg(''), 3500); return () => clearTimeout(x) }, [msg])
  return [msg ? <div className="toast" role="status">✓ {msg}</div> : null, setMsg]
}

// ================================================================ Credit Note

export function CreditNotes({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('30')
  const [q, setQ] = useQuery()
  const dq = useDebounced(q)
  const [edit, setEdit] = useState<Cn | 'new' | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [toast, say] = useToast()
  const { data, error, loading } = useLoad(() => api<{ notes: Cn[]; totalPaise: number }>(
    `/v1/admin/shops/${shopId}/credit-notes?from=${period.from}&to=${period.to}&q=${encodeURIComponent(dq)}`), [shopId, period.from, period.to, dq])
  useExport(!open && data ? () => ({
    style: 'book' as const, title: t('Credit Note'), dateLine: dayRange(period.from, period.to), file: fileName('Credit notes', period.from, period.to),
    columns: [{ label: t('No.') }, { label: t('Tarikh') }, { label: t('Grahak'), wide: true }, { label: t('Parchi') }, { label: t('Wajah') }, { label: t('Rakam'), num: true }],
    rows: data.notes.map((c) => ({ strike: c.voided, cells: [String(c.no), dmyLong(c.date), c.buyerName, c.slipNo ? String(c.slipNo) : '', reasonLabel(c.reason), rs(c.amountPaise)] })),
    foot: ['', '', t('Kul'), '', '', rs(data.totalPaise)],
  }) : null, [data, open])
  if (open) return <><CnView shopId={shopId} id={open} onBack={() => setOpen(null)} onSaid={say} />{toast}</>
  return (
    <>
      <div className="toolbar">
        <PeriodBar value={period} onChange={setPeriod} />
        <input className="field search grow" data-search type="search" placeholder={t('Grahak, parchi ya CN no.')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn primary" onClick={() => setEdit('new')}>+ {t('Credit note')}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th className="opt-col">{t('No.')}</th><th className="opt-col">{t('Tarikh')}</th><th>{t('Grahak')}</th><th className="opt-col">{t('Parchi')}</th><th className="opt-col">{t('Wajah')}</th><th className="num">{t('Rakam')}</th></tr></thead>
            <tbody>
              {data.notes.map((c) => (
                <tr key={c.id} data-row tabIndex={0} className={c.voided ? 'muted' : ''} onClick={() => setOpen(c.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(c.id) }}>
                  <td className="opt-col money">{c.no}</td>
                  <td className="opt-col muted">{date(c.date)}</td>
                  <td className="main-col"><b style={c.voided ? { textDecoration: 'line-through' } : undefined}>{c.buyerName}</b>
                    <small><span className="show-sm">#{c.no} · {date(c.date)} · {reasonLabel(c.reason)}{c.slipNo ? ` · ${t('Parchi')} ${c.slipNo}` : ''}</span>{c.note && <span className="hide-sm">{c.note}</span>}</small></td>
                  <td className="opt-col">{c.slipNo ?? ''}</td>
                  <td className="opt-col">{reasonLabel(c.reason)}{c.voided && <span className="chip grey" style={{ marginLeft: 6 }}>{t('Hata diya')}</span>}</td>
                  <td className="num amt-col money b">{rupees(c.amountPaise)}</td>
                </tr>
              ))}
            </tbody>
            {data.notes.length > 0 && <tfoot><tr><td className="opt-col" /><td className="opt-col" /><td><b>{t('Kul')}</b></td><td className="opt-col" /><td className="opt-col" /><td className="num money b">{rupees(data.totalPaise)}</td></tr></tfoot>}
          </table>
          {data.notes.length === 0 && <p className="empty">{t('Is samay koi credit note nahi')}</p>}
        </div>
      )}
      {edit && <CnSheet shopId={shopId} cn={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={(m) => { setEdit(null); say(m) }} />}
      {toast}
    </>
  )
}

function CnView({ shopId, id, onBack, onSaid }: { shopId: string; id: string; onBack: () => void; onSaid: (m: string) => void }) {
  const { data: c, error } = useLoad(() => api<Cn>(`/v1/admin/shops/${shopId}/credit-notes/${id}`), [shopId, id])
  const [edit, setEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState('')
  const remove = async () => {
    if (!c || !confirm(t('Credit note #{n} hatayein? Grahak ka khata wapas ho jayega.', { n: String(c.no) }))) return
    setBusy(true); setFail('')
    try { await api(`/v1/admin/shops/${shopId}/credit-notes/${id}/delete`, { method: 'POST' }); booksChanged(); onSaid(t('Credit note #{n} hata diya', { n: String(c.no) })) }
    catch (e) { setFail((e as Error).message) } finally { setBusy(false) }
  }
  const print = async () => {
    if (!c) return
    try { printCreditNotes([c], await api<ShopSettings>(`/v1/admin/shops/${shopId}/settings`)) } catch (e) { setFail((e as Error).message) }
  }
  return (
    <>
      <div className="toolbar">
        <button type="button" className="btn ghost" data-back onClick={onBack}>‹ {t('Credit Note')}</button>
        <span className="grow" />
        {c && <button type="button" className="btn" onClick={() => void print()}>{t('Print')}</button>}
        {c && !c.voided && <>
          <button type="button" className="btn" onClick={() => setEdit(true)}>{t('Badlein')}</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void remove()}>{t('Hatayein')}</button>
        </>}
      </div>
      {(error || fail) && <p className="error">{error || fail}</p>}
      {!c ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Credit note')} #{c.no}</span><span className="v">{date(c.date)}</span>{c.voided && <span className="chip grey">{t('Hata diya')}</span>}</div>
            <div><span className="lb">{t('Grahak')}</span><span className="v"><a href={href({ page: 'grahak', shopId, buyerId: c.buyerId })}>{c.buyerName}</a></span><small>{[c.buyer?.gstin && `GSTIN ${c.buyer.gstin}`, c.buyer?.phone && fmtPhone(c.buyer.phone)].filter(Boolean).join(' · ')}</small></div>
            <div><span className="lb">{reasonLabel(c.reason)}{c.slipNo ? ` · ${t('Parchi')} ${c.slipNo}` : ''}</span><span className="v">{rupees(c.amountPaise)}</span><small>{inWords(c.amountPaise)}</small></div>
          </div>
          {c.lines.length > 0 && (
            <div className="card wrap-x">
              <table className="tbl">
                <thead><tr><th>{t('Quality')}</th><th className="num">{t('Box')}</th><th className="num">{c.reason === 'wapsi' ? t('Bhav') : t('Rate farq')}</th><th className="num">{t('Rakam')}</th></tr></thead>
                <tbody>{c.lines.map((l, i) => <tr key={i}><td>{l.quality}{l.grade && l.grade !== '1' ? ` · ${l.grade}` : ''}</td><td className="num">{count(l.boxes)}</td><td className="num money">{fmtRate(l.ratePaise)}</td><td className="num money b">{rupees(l.amountPaise)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          {c.billId && <p><button type="button" className="link" onClick={() => openVoucher(shopId, c.billId!)}>{t('Parchi')} #{c.slipNo}</button>{c.note && <span className="muted"> · {c.note}</span>}</p>}
          {!c.billId && c.note && <p className="muted">{c.note}</p>}
        </>
      )}
      {edit && c && <CnSheet shopId={shopId} cn={c} onClose={() => setEdit(false)} onDone={(m) => { setEdit(false); onSaid(m) }} />}
    </>
  )
}

type Slip = { billId: string; slipNo: number | null; date: string; totalPaise: number; boxes: number }
const lineKey = (l: { quality: string; grade: string }) => `${l.quality}|${l.grade}`
type SlipDetail = { billId: string; slipNo: number | null; totalPaise: number; creditedPaise: number; lines: { quality: string; grade: string; qty: number; ratePaise: number }[] }

/** A credit note: grahak, an optional parchi (its lines to pick boxes and rate difference from), or a flat amount. */
export function CnSheet({ shopId, cn, onClose, onDone }: { shopId: string; cn: Cn | null; onClose: () => void; onDone: (msg: string) => void }) {
  const [buyer, setBuyer] = useState<PickedBuyer | null>(cn ? { id: cn.buyerId, name: cn.buyerName } : null)
  const [slips, setSlips] = useState<Slip[]>([])
  const [billId, setBillId] = useState(cn?.billId ?? '')
  const [slip, setSlip] = useState<SlipDetail | null>(null)
  const [reason, setReason] = useState<Reason>(cn?.reason ?? 'rate')
  const reasonRef = useRef(reason)
  reasonRef.current = reason
  const [byLines, setByLines] = useState(cn ? cn.lines.length > 0 : true)
  const [picks, setPicks] = useState<Record<string, { boxes: number; ratePaise: number }>>(() =>
    Object.fromEntries((cn?.lines ?? []).map((l) => [`${l.quality}|${l.grade}`, { boxes: l.boxes, ratePaise: l.ratePaise }])))
  const [flat, setFlat] = useState(cn && !cn.lines.length ? cn.amountPaise : 0)
  const [day, setDay] = useState(cn?.date ?? todayIst())
  const [note, setNote] = useState(cn?.note ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!buyer?.id) { setSlips([]); return }
    api<{ slips: Slip[] }>(`/v1/admin/shops/${shopId}/credit-notes/slips/${buyer.id}`).then((r) => setSlips(r.slips)).catch(() => setSlips([]))
  }, [shopId, buyer?.id])
  useEffect(() => {
    if (!billId) { setSlip(null); return }
    // What other notes already gave back on it; this note itself is not counted when it is being altered.
    api<SlipDetail>(`/v1/admin/shops/${shopId}/credit-notes/slip/${billId}${cn ? `?except=${cn.id}` : ''}`).then((d) => {
      setSlip(d)
      // Maal wapas picked before the parchi: the bhav comes in with its lines.
      if (reasonRef.current === 'wapsi') setPicks((p) => Object.fromEntries(d.lines.map((l) => [lineKey(l), { boxes: p[lineKey(l)]?.boxes ?? 0, ratePaise: p[lineKey(l)]?.ratePaise || l.ratePaise }])))
    }).catch(() => setSlip(null))
  }, [shopId, billId]) // eslint-disable-line react-hooks/exhaustive-deps
  const lines = slip && byLines ? slip.lines.map((l) => ({ ...l, pick: picks[lineKey(l)] ?? { boxes: 0, ratePaise: 0 } })) : []
  const amount = slip && byLines ? lines.reduce((s, l) => s + l.pick.boxes * l.pick.ratePaise, 0) : flat
  const setPick = (k: string, p: Partial<{ boxes: number; ratePaise: number }>) => setPicks({ ...picks, [k]: { ...(picks[k] ?? { boxes: 0, ratePaise: 0 }), ...p } })
  // What is left to give back on the parchi.
  const room = slip ? Math.max(0, slip.totalPaise - slip.creditedPaise) : null
  const over = room !== null && amount > room
  const [tried, setTried] = useState(false)
  const save = async () => {
    setTried(true); setError('')
    if (!buyer?.id || amount <= 0 || over) return
    setSaving(true)
    try {
      const body = {
        day, buyerId: buyer.id, billId: billId || null, reason, note,
        ...(slip && byLines ? { lines: lines.filter((l) => l.pick.boxes > 0 && l.pick.ratePaise > 0).map((l) => ({ quality: l.quality, grade: l.grade, boxes: l.pick.boxes, ratePaise: l.pick.ratePaise })) } : { amountPaise: flat }),
      }
      const r = await api<{ no: number }>(cn ? `/v1/admin/shops/${shopId}/credit-notes/${cn.id}` : `/v1/admin/shops/${shopId}/credit-notes`, { method: 'POST', body })
      booksChanged(); onDone(t('Credit note #{n} save hua', { n: String(r.no) }))
    } catch (e) { setError((e as Error).message); setSaving(false) }
  }
  return (
    <Sheet wide title={cn ? `${t('Credit note')} #${cn.no}` : t('Credit Note')} onClose={onClose} onSave={() => void save()} saving={saving} error={error}
      saveLabel={amount ? `${t('Save')} · ${rupees(amount)}` : t('Save')}>
      <div className="row2">
        <Field label={t('Grahak')} error={tried && !buyer?.id ? t('Grahak chunein') : ''}><BuyerPicker shopId={shopId} value={buyer} autoFocus={!cn} onChange={(b) => { setBuyer(b?.id ? b : null); setBillId(''); setPicks({}) }} /></Field>
        <Field label={t('Tarikh')}><input className="field" type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
      </div>
      <Field label={t('Wajah')}><Seg value={reason} onChange={(r) => {
        setReason(r)
        // Maal wapas: the whole bhav comes off each box sent back; leaving it, that bhav is not a rate farq.
        if (r === 'wapsi' && slip) setPicks(Object.fromEntries(slip.lines.map((l) => [lineKey(l), { boxes: picks[lineKey(l)]?.boxes ?? 0, ratePaise: l.ratePaise }])))
        else if (reason === 'wapsi' && slip) setPicks(Object.fromEntries(slip.lines.map((l) => { const p = picks[lineKey(l)]; return [lineKey(l), { boxes: p?.boxes ?? 0, ratePaise: p && p.ratePaise !== l.ratePaise ? p.ratePaise : 0 }] })))
      }} options={REASONS} /></Field>
      <Field label={t('Parchi')}>
        <select className="field" value={billId} disabled={!buyer} onChange={(e) => { setBillId(e.target.value); setPicks({}) }}>
          <option value="">{t('— bina parchi')}</option>
          {billId && !slips.some((s) => s.billId === billId) && <option value={billId}>#{cn?.slipNo ?? ''}</option>}
          {slips.map((s) => <option key={s.billId} value={s.billId}>#{s.slipNo} · {date(s.date)} · {count(s.boxes)} {t('box')} · {rupees(s.totalPaise)}</option>)}
        </select>
      </Field>
      {slip && <Tick label={t('Box aur rate farq se')} on={byLines} onChange={setByLines} />}
      {slip && byLines ? (
        <div className="card wrap-x" style={{ padding: 0 }}>
          <table className="tbl cn-lines">
            <thead><tr><th>{t('Quality')}</th><th className="num">{t('Parchi')}</th><th className="num">{t('Box')}</th><th className="num">{reason === 'wapsi' ? t('Bhav') : t('Rate farq')}</th><th className="num">{t('Rakam')}</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={lineKey(l)}>
                  <td>{l.quality}{l.grade && l.grade !== '1' ? ` · ${l.grade}` : ''}</td>
                  <td className="num muted">{count(l.qty)} × {fmtRate(l.ratePaise)}</td>
                  <td className="num"><input className="field num-in" inputMode="numeric" aria-label={t('Box')} value={l.pick.boxes || ''} placeholder="0"
                    onChange={(e) => setPick(lineKey(l), { boxes: Math.min(l.qty, Number(e.target.value.replace(/\D/g, '') || 0)) })} /></td>
                  <td className="num"><Money value={l.pick.ratePaise} onChange={(v) => setPick(lineKey(l), { ratePaise: v })} /></td>
                  <td className="num money b">{l.pick.boxes * l.pick.ratePaise ? rupees(l.pick.boxes * l.pick.ratePaise) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Field label={t('Rakam')} error={tried && amount <= 0 ? t('Rakam daalein') : ''}><Money value={flat} onChange={setFlat} /></Field>
      )}
      {slip && byLines && tried && amount <= 0 && <p className="error" style={{ margin: 0 }}>{reason === 'wapsi' ? t('Wapas aaye box daalein') : t('Box aur rate farq daalein')}</p>}
      {over && <p className="error" style={{ margin: 0 }}>{t('Parchi {total} ki hai{before} — {room} se zyada credit nahi', { total: rupees(slip!.totalPaise), before: slip!.creditedPaise ? `, ${t('pehle {amt} credit', { amt: rupees(slip!.creditedPaise) })}` : '', room: rupees(room!) })}</p>}
      {!over && slip && slip.creditedPaise > 0 && <p className="muted" style={{ margin: 0 }}>{t('Is parchi par pehle {amt} credit', { amt: rupees(slip.creditedPaise) })}</p>}
      <Field label={t('Note')}><input className="field" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="total-line"><span>{inWords(amount)}</span><b className="money">{rupees(amount)}</b></div>
    </Sheet>
  )
}

// ================================================================ Generate Invoices

export function TaxInvoices({ shopId }: { shopId: string }) {
  const [tab, setTab] = useState<'list' | 'make'>(() => (hashQuery().get('tab') === 'make' ? 'make' : 'list'))
  const [open, setOpen] = useState<string | null>(null)
  if (open) return <InvoiceView shopId={shopId} id={open} onBack={() => setOpen(null)} />
  return (
    <>
      <div className="toolbar">
        <Seg value={tab} onChange={(v) => { setTab(v); setHashQuery({ ...Object.fromEntries(hashQuery()), tab: v }) }} options={[{ key: 'list', label: t('Invoices') }, { key: 'make', label: t('Banayein') }]} />
      </div>
      {tab === 'list' ? <InvoiceList shopId={shopId} onOpen={setOpen} /> : <InvoiceMaker shopId={shopId} onMade={() => { setTab('list'); setHashQuery({ ...Object.fromEntries(hashQuery()), tab: 'list' }) }} />}
    </>
  )
}

async function printInvoiceIds(shopId: string, ids: string[]) {
  const r = await api<{ invoices: InvoiceDoc[] }>(`/v1/admin/shops/${shopId}/invoices/docs`, { method: 'POST', body: { ids } })
  printInvoices(r.invoices)
}

function InvoiceList({ shopId, onOpen }: { shopId: string; onOpen: (id: string) => void }) {
  const [period, setPeriod] = usePeriod('30')
  const [q, setQ] = useQuery()
  const dq = useDebounced(q)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const { data, error, loading } = useLoad(() => api<{ invoices: InvoiceRow[]; totalPaise: number }>(
    `/v1/admin/shops/${shopId}/invoices?from=${period.from}&to=${period.to}&q=${encodeURIComponent(dq)}`), [shopId, period.from, period.to, dq])
  useExport(data ? () => ({
    style: 'book' as const, title: t('Invoices'), dateLine: dayRange(period.from, period.to), file: fileName('Invoices', period.from, period.to),
    columns: [{ label: t('Invoice no.') }, { label: t('Tarikh') }, { label: t('Grahak'), wide: true }, { label: 'GSTIN' }, { label: t('Parchi') }, { label: t('Rakam'), num: true }],
    rows: data.invoices.map((i) => ({ strike: i.voided, cells: [i.number, dmyLong(i.date), i.buyerName, i.gstin, i.slipNos.join(', '), rs(i.totalPaise)] })),
    foot: ['', '', t('Kul'), '', '', rs(data.totalPaise)],
  }) : null, [data])
  const rows = data?.invoices ?? []
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.id))
  const flip = (id: string) => { const s = new Set(sel); if (s.has(id)) s.delete(id); else s.add(id); setSel(s) }
  return (
    <>
      <div className="toolbar">
        <PeriodBar value={period} onChange={setPeriod} />
        <input className="field search grow" data-search type="search" placeholder={t('Invoice no., grahak ya parchi')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn" disabled={!sel.size} onClick={() => void printInvoiceIds(shopId, [...sel])}>{t('Print')}{sel.size ? ` (${sel.size})` : ''}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr>
              <th style={{ width: 1 }}><input type="checkbox" aria-label={t('Sab chunein')} checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
              <th>{t('Invoice no.')}</th><th className="opt-col">{t('Tarikh')}</th><th className="opt-col">{t('Grahak')}</th><th className="opt-col">{t('Parchi')}</th><th className="num">{t('Rakam')}</th>
            </tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} data-row tabIndex={0} className={i.voided ? 'muted' : ''} onClick={() => onOpen(i.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(i.id) }}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={i.number} checked={sel.has(i.id)} onChange={() => flip(i.id)} /></td>
                  <td className="main-col"><b className="money" style={i.voided ? { textDecoration: 'line-through' } : undefined}>{i.number}</b>
                    <small><span className="show-sm">{date(i.date)} · {i.buyerName}</span>{i.voided && <span className="chip grey" style={{ marginLeft: 6 }}>{t('Cancel')}</span>}</small></td>
                  <td className="opt-col muted">{date(i.date)}</td>
                  <td className="opt-col">{i.buyerName}<small>{i.gstin}</small></td>
                  <td className="opt-col muted">{i.slipNos.join(', ')}</td>
                  <td className="num amt-col money b">{rupees(i.totalPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="empty">{t('Is samay koi invoice nahi')}</p>}
        </div>
      )}
    </>
  )
}

function InvoiceView({ shopId, id, onBack }: { shopId: string; id: string; onBack: () => void }) {
  const { data: d, error } = useLoad(() => api<InvoiceDoc>(`/v1/admin/shops/${shopId}/invoices/${id}`), [shopId, id])
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState('')
  const cancel = async () => {
    if (!d) return
    const reason = prompt(t('Invoice {n} cancel karein? Wajah:', { n: d.number }), '')
    if (reason === null) return
    setBusy(true); setFail('')
    try { await api(`/v1/admin/shops/${shopId}/invoices/${id}/cancel`, { method: 'POST', body: { reason } }); booksChanged() }
    catch (e) { setFail((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <>
      <div className="toolbar">
        <button type="button" className="btn ghost" data-back onClick={onBack}>‹ {t('Invoices')}</button>
        <span className="grow" />
        {d && <button type="button" className="btn" onClick={() => printInvoices([d])}>{t('Print')}</button>}
        {d && !d.voided && <button type="button" className="btn ghost" disabled={busy} onClick={() => void cancel()}>{t('Invoice cancel')}</button>}
      </div>
      {(error || fail) && <p className="error">{error || fail}</p>}
      {!d ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Invoice')}</span><span className="v money">{d.number}</span><small>{date(d.date)}</small>{d.voided && <span className="chip grey">{t('Cancel')}{d.voidReason ? ` · ${d.voidReason}` : ''}</span>}</div>
            <div><span className="lb">{t('Grahak')}</span><span className="v">{d.buyer.name}</span><small>{[d.buyer.gstin && `GSTIN ${d.buyer.gstin}`, d.buyer.address].filter(Boolean).join(' · ')}</small></div>
            <div><span className="lb">{t('Kul')}</span><span className="v">{rupees(d.totalPaise)}</span><small>{d.words}</small></div>
          </div>
          <div className="card wrap-x">
            <table className="tbl">
              <thead><tr><th>{t('Parchi')}</th><th>{t('Maal')}</th><th className="opt-col">HSN</th><th className="num">{t('Qty')}</th><th className="num opt-col">Kg</th><th className="num">{t('Bhav')}</th><th className="num">{t('Rakam')}</th></tr></thead>
              <tbody>
                {d.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.slipNo}<small>{date(l.date)}</small></td>
                    <td>{l.quality}{l.grade ? ` · ${gradeLabel(l.grade)}` : ''}<small>{l.gaadi}</small></td>
                    <td className="opt-col muted">{l.hsn}</td>
                    <td className="num">{count(l.qty)} {l.unit}</td>
                    <td className="num opt-col">{l.kg ? count(l.kg) : ''}</td>
                    <td className="num money">{fmtRate(l.ratePaise)}</td>
                    <td className="num money b">{rupees(l.amountPaise)}</td>
                  </tr>
                ))}
                {d.charges.map((c) => <tr key={c.label}><td /><td colSpan={5}>{c.label}</td><td className="num money">{rupees(c.amountPaise)}</td></tr>)}
                <tr><td /><td colSpan={5}>GST {d.taxRate}% · {d.taxNote}</td><td className="num money">{rupees(d.taxPaise)}</td></tr>
              </tbody>
              <tfoot><tr><td /><td colSpan={5}><b>{t('Kul')}</b></td><td className="num money b">{rupees(d.totalPaise)}</td></tr></tfoot>
            </table>
          </div>
        </>
      )}
    </>
  )
}

type Candidate = { billId: string; slipNo: number | null; date: string; buyerId: string | null; buyerName: string; qty: number; totalPaise: number; invoice: string | null }

/** Pick a grahak and a period (or the parchis themselves), then one invoice per parchi or one for them all. */
function InvoiceMaker({ shopId, onMade }: { shopId: string; onMade: () => void }) {
  const [period, setPeriod] = usePeriod('7')
  const [buyer, setBuyer] = useState<PickedBuyer | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<'each' | 'one'>('each')
  const [day, setDay] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [made, setMade] = useState<{ id: string; number: string }[] | null>(null)
  const { data, loading } = useLoad(() => api<{ parchis: Candidate[] }>(
    `/v1/admin/shops/${shopId}/invoices/parchis?from=${period.from}&to=${period.to}${buyer?.id ? `&buyerId=${buyer.id}` : ''}`), [shopId, period.from, period.to, buyer?.id])
  const rows = data?.parchis ?? []
  const free = rows.filter((r) => !r.invoice)
  // A fresh list starts with every parchi not yet invoiced picked.
  useEffect(() => { setSel(new Set(free.map((r) => r.billId))) }, [data]) // eslint-disable-line react-hooks/exhaustive-deps
  const picked = rows.filter((r) => sel.has(r.billId))
  const total = picked.reduce((s, r) => s + r.totalPaise, 0)
  const flip = (id: string) => { const s = new Set(sel); if (s.has(id)) s.delete(id); else s.add(id); setSel(s) }
  const late = day ? picked.find((p) => p.date > day) : undefined
  const make = async () => {
    if (!picked.length) return setError(t('Parchi chunein'))
    if (mode === 'one' && new Set(picked.map((p) => p.buyerId ?? p.buyerName)).size > 1) return setError(t('Ek invoice mein ek hi grahak ki parchiyan'))
    if (late) return
    setBusy(true); setError('')
    try {
      const r = await api<{ invoices: { id: string; number: string }[] }>(`/v1/admin/shops/${shopId}/invoices`, { method: 'POST', body: { billIds: picked.map((p) => p.billId), mode, day: day || undefined } })
      setMade(r.invoices); booksChanged()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  if (made) return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 10 }}>
      <b>{t('{n} invoice bane', { n: made.length })}</b>
      <p className="money" style={{ margin: 0 }}>{made.map((m) => m.number).join(' · ')}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn primary" onClick={() => void printInvoiceIds(shopId, made.map((m) => m.id))}>{t('Print')}</button>
        <button type="button" className="btn" onClick={onMade}>{t('Invoices')}</button>
        <button type="button" className="btn ghost" onClick={() => setMade(null)}>{t('Aur banayein')}</button>
      </div>
    </div>
  )
  return (
    <>
      <div className="toolbar">
        <PeriodBar value={period} onChange={setPeriod} />
        <div style={{ flex: '1 1 260px', minWidth: 0 }}><BuyerPicker shopId={shopId} value={buyer} onChange={(b) => setBuyer(b?.id ? b : null)} /></div>
        {buyer && <button type="button" className="btn ghost sm" onClick={() => setBuyer(null)}>{t('Sab grahak')}</button>}
      </div>
      <div className={`card wrap-x${loading ? ' dim' : ''}`}>
        <table className="tbl fold">
          <thead><tr>
            <th style={{ width: 1 }}><input type="checkbox" aria-label={t('Sab chunein')} checked={free.length > 0 && free.every((r) => sel.has(r.billId))}
              onChange={(e) => setSel(e.target.checked ? new Set(free.map((r) => r.billId)) : new Set())} /></th>
            <th>{t('Parchi')}</th><th className="opt-col">{t('Tarikh')}</th><th>{t('Grahak')}</th><th className="num opt-col">{t('Qty')}</th><th className="num">{t('Rakam')}</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.billId} data-row tabIndex={0} className={r.invoice ? 'muted' : ''} onClick={() => !r.invoice && flip(r.billId)}
                onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !r.invoice) { e.preventDefault(); flip(r.billId) } }}>
                <td><input type="checkbox" tabIndex={-1} aria-label={String(r.slipNo)} disabled={!!r.invoice} checked={sel.has(r.billId)} onChange={() => flip(r.billId)} onClick={(e) => e.stopPropagation()} /></td>
                <td className="main-col"><b className="money">#{r.slipNo}</b><small><span className="show-sm">{date(r.date)} · </span>{r.invoice ?? ''}</small></td>
                <td className="opt-col muted">{date(r.date)}</td>
                <td>{r.buyerName}</td>
                <td className="num opt-col">{count(r.qty)}</td>
                <td className="num amt-col money">{rupees(r.totalPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="empty">{t('Is samay koi parchi nahi')}</p>}
      </div>
      <div className="card" style={{ padding: 14, display: 'grid', gap: 12 }}>
        <div className="row2">
          <Field label={t('Kaise')}><Seg value={mode} onChange={setMode} options={[{ key: 'each', label: t('Har parchi ka') }, { key: 'one', label: t('Sab ka ek') }]} /></Field>
          <Field label={t('Invoice ki tarikh')} hint={t('Khaali = parchi ki tarikh')}
            error={late ? t('Parchi #{n} {date} ki hai — invoice usse pehle ki nahi', { n: String(late.slipNo ?? ''), date: date(late.date) }) : ''}>
            <input className="field" type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        </div>
        {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
        <button type="button" className="btn primary" disabled={busy || !picked.length} onClick={() => void make()}>
          {busy ? '…' : `${t('Invoice banayein')} · ${count(mode === 'one' ? Math.min(1, picked.length) : picked.length)} · ${rupees(total)}`}
        </button>
      </div>
    </>
  )
}

// ================================================================ Bikri Entry

type Opts = {
  commodity: string; apmcOn?: boolean
  lots?: { truckId: string; number: string; supplier: string; brandId: string; quality: string; left: number }[]
  trucks: { id: string; number: string; supplier: string; left: number; brand: string }[]
}
type Row = { key: number; buyer: { id: string | null; name: string } | null; text: string; brandId: string; grade: '1' | '2' | '3' | 'mix'; qty: number; ratePaise: number; pay: 'credit' | 'cash' | 'upi' }
type Made = { line: number; billId: string; slipNo: number; buyerName: string; totalPaise: number; qty: number }
let rowSeq = 0
const blankRow = (brandId = ''): Row => ({ key: ++rowSeq, buyer: null, text: '', brandId, grade: '1', qty: 0, ratePaise: 0, pay: 'credit' })

/**
 * GFA's Bikri Entry: one gaadi, a grid of grahak — quality (or grade), boxes, bhav, payment —
 * and one Save writes a parchi per row exactly as Nayi Parchi does. Enter moves along the row
 * and down; a new row appears as the last one is filled.
 */
export function BikriEntry({ shopId }: { shopId: string }) {
  const { data: o } = useLoad(() => api<Opts>(`/v1/admin/shops/${shopId}/entry-options`), [shopId])
  const angoor = o?.commodity === 'angoor'
  const gaadis = angoor
    ? [...new Map((o?.lots ?? []).map((l) => [l.truckId, { id: l.truckId, number: l.number, supplier: l.supplier }])).values()]
    : (o?.trucks ?? []).map((t) => ({ id: t.id, number: t.number, supplier: t.supplier }))
  const [truckId, setTruckId] = useState('')
  useEffect(() => { if (!truckId && gaadis[0]) setTruckId(gaadis[0].id) }, [o]) // eslint-disable-line react-hooks/exhaustive-deps
  const lots = (o?.lots ?? []).filter((l) => l.truckId === truckId)
  const truck = (o?.trucks ?? []).find((x) => x.id === truckId)
  const [rows, setRows] = useState<Row[]>(() => [blankRow(), blankRow()])
  useEffect(() => { if (lots[0]) setRows((rs) => rs.map((r) => (r.brandId && lots.some((l) => l.brandId === r.brandId) ? r : { ...r, brandId: lots[0].brandId }))) }, [truckId, o]) // eslint-disable-line react-hooks/exhaustive-deps
  const [labour, setLabour] = useState(false)
  const [labourRate, setLabourRate] = useState(1000)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ made: Made[]; failed: { line: number; error: string }[] } | null>(null)
  const grid = useRef<HTMLTableElement>(null)
  const upper = useCaps(shopId)

  const set = (key: number, patch: Partial<Row>) => setRows((rs) => {
    const next = rs.map((r) => (r.key === key ? { ...r, ...patch } : r))
    // A new row appears as soon as the last one is being filled.
    const last = next[next.length - 1]
    // It starts on the quality and grade the row above it took.
    return last && (last.qty > 0 || last.buyer || last.text.trim()) ? [...next, { ...blankRow(last.brandId || lots[0]?.brandId), grade: last.grade }] : next
  })
  const filled = rows.filter((r) => r.qty > 0)
  const apmc = (goods: number) => (angoor && o?.apmcOn ? Math.round(goods * 0.01) : 0)
  const totalOf = (r: Row) => r.qty * r.ratePaise + apmc(r.qty * r.ratePaise) + (angoor && labour && r.pay === 'credit' ? r.qty * labourRate : 0)
  const total = filled.reduce((s, r) => s + totalOf(r), 0)
  const boxes = filled.reduce((s, r) => s + r.qty, 0)
  const soldOf = (brandId: string) => filled.filter((r) => r.brandId === brandId).reduce((s, r) => s + r.qty, 0)

  /** Enter: the next box in the row, then the first of the next row. */
  const onEnter = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    const all = [...(grid.current?.querySelectorAll<HTMLElement>('input, select') ?? [])]
    const i = all.indexOf(e.target as HTMLElement)
    const next = all[i + 1]
    if (next) { next.focus(); if (next instanceof HTMLInputElement) next.select() }
  }

  const [badKey, setBadKey] = useState<number | null>(null)
  const save = async () => {
    setError(''); setBadKey(null)
    if (busy) return
    if (!truckId) return setError(t('Gaadi chunein'))
    if (!filled.length) return setError(t('Kam se kam ek grahak aur box daalein'))
    const bad = filled.find((r) => r.pay === 'credit' && !r.buyer?.id && !r.text.trim())
    if (bad) {
      // The row is marked and its name box takes the cursor.
      setBadKey(bad.key)
      grid.current?.querySelector<HTMLInputElement>(`tr[data-key="${bad.key}"] .grahak-cell input`)?.focus()
      return setError(t('Line {n}: udhaar ke liye grahak ka naam', { n: rows.indexOf(bad) + 1 }))
    }
    setBusy(true)
    try {
      const r = await api<{ made: Made[]; failed: { line: number; error: string }[] }>(`/v1/admin/shops/${shopId}/bikri`, { method: 'POST', body: {
        truckId, labour: angoor ? labour : undefined, labourRatePaise: angoor ? labourRate : undefined,
        rows: rows.map((r) => ({
          buyerId: r.buyer?.id ?? undefined, buyerName: r.buyer?.id ? undefined : (r.buyer?.name ?? r.text).trim(),
          brandId: angoor ? r.brandId : undefined, grade: angoor ? undefined : r.grade, qty: r.qty, ratePaise: r.ratePaise, pay: r.pay,
        })),
      } })
      setResult(r); booksChanged()
      // What saved leaves the grid; what was refused stays to be put right.
      const failed = new Set(r.failed.map((f) => f.line))
      setRows((rs) => { const keep = rs.filter((_, i) => failed.has(i + 1)); return [...keep, blankRow(lots[0]?.brandId)] })
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  // Ctrl+Enter saves the grid, as it saves every form.
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !document.querySelector('.scrim')) { e.preventDefault(); void saveRef.current() }
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [])
  return (
    <>
      <div className="toolbar">
        <select className="field" aria-label={t('Gaadi')} style={{ flex: '1 1 260px' }} value={truckId} onChange={(e) => setTruckId(e.target.value)}>
          {!gaadis.length && <option value="">{t('Koi khuli gaadi nahi')}</option>}
          {gaadis.map((g) => <option key={g.id} value={g.id}>{g.number} · {g.supplier}</option>)}
        </select>
        {angoor && <Tick label={t('Mazdoori (udhaar)')} on={labour} onChange={setLabour}>{labour && <span style={{ width: 110 }}><Money value={labourRate} onChange={setLabourRate} /></span>}</Tick>}
      </div>
      {angoor && lots.length > 0 && (
        <div className="chips" style={{ marginBottom: 12 }}>
          {lots.map((l) => {
            const sold = soldOf(l.brandId)
            return <span key={l.brandId} className={`chip${sold > l.left ? ' red' : sold ? ' blue' : ''}`}>{l.quality}: {count(sold)} / {count(l.left)}</span>
          })}
        </div>
      )}
      {!angoor && truck && <div className="chips" style={{ marginBottom: 12 }}><span className={`chip${boxes > truck.left ? ' red' : boxes ? ' blue' : ''}`}>{truck.brand}: {count(boxes)} / {count(truck.left)}</span></div>}
      <div className="card wrap-x bikri-grid">
        <table className="tbl" ref={grid}>
          <thead><tr>
            <th style={{ width: 28 }}>#</th><th>{t('Grahak')}</th><th>{angoor ? t('Quality') : t('Grade')}</th><th className="num">{angoor ? t('Box') : t('Nag')}</th>
            <th className="num">{t('Bhav')}</th><th className="num opt-col">{t('Rakam')}</th><th>{t('Pay')}</th><th style={{ width: 28 }} />
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key} data-key={r.key}>
                <td className="muted">{i + 1}</td>
                <td><GrahakCell shopId={shopId} row={r} upper={upper} bad={badKey === r.key && !r.buyer?.id && !r.text.trim()} onPick={(b, text) => set(r.key, { buyer: b, text })} onEnter={onEnter} /></td>
                <td>{angoor
                  ? <select className="field" value={r.brandId} onKeyDown={onEnter} onChange={(e) => set(r.key, { brandId: e.target.value })}>
                      {lots.map((l) => <option key={l.brandId} value={l.brandId}>{l.quality}</option>)}
                    </select>
                  : <select className="field" value={r.grade} onKeyDown={onEnter} onChange={(e) => set(r.key, { grade: e.target.value as Row['grade'] })}>
                      <option value="1">1st</option><option value="2">2nd</option><option value="3">3rd</option><option value="mix">{t('Mix')}</option>
                    </select>}
                </td>
                <td className="num"><input className="field num-in" inputMode="numeric" aria-label={t('Box')} value={r.qty || ''} placeholder="0" onKeyDown={onEnter}
                  onChange={(e) => set(r.key, { qty: Number(e.target.value.replace(/\D/g, '').slice(0, 7) || 0) })} /></td>
                <td className="num" onKeyDown={onEnter}><Money value={r.ratePaise} onChange={(v) => set(r.key, { ratePaise: v })} /></td>
                <td className="num opt-col money">{r.qty && r.ratePaise ? rupees(totalOf(r)) : ''}</td>
                <td><select className="field" value={r.pay} onKeyDown={onEnter} onChange={(e) => set(r.key, { pay: e.target.value as Row['pay'] })}>
                  <option value="credit">{t('Udhaar')}</option><option value="cash">{t('Cash')}</option><option value="upi">UPI</option>
                </select></td>
                <td>{rows.length > 1 && <button type="button" className="icon-btn" tabIndex={-1} aria-label={t('Hatayein')} onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="total-line big">
        <span>{t('{n} parchi', { n: filled.length })} · {count(boxes)} {angoor ? t('box') : t('nag')}{angoor && o?.apmcOn ? ` · ${t('APMC 1% saath')}` : ''}</span>
        <b className="money">{rupees(total)}</b>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="toolbar" style={{ marginTop: 12 }}>
        <span className="grow" />
        <button type="button" className="btn primary" disabled={busy || !filled.length} onClick={() => void save()}>{busy ? '…' : <><kbd>Ctrl+↵: </kbd>{`${t('Save')} · ${t('{n} parchi', { n: filled.length })} · ${rupees(total)}`}</>}</button>
      </div>
      {result && (
        <div className="card" style={{ padding: 14, display: 'grid', gap: 8 }}>
          <b>{t('{n} parchi bani', { n: result.made.length })} · {rupees(result.made.reduce((s, m) => s + m.totalPaise, 0))}</b>
          <div className="chips">
            {result.made.map((m) => <button key={m.billId} type="button" className="chip blue" onClick={() => openVoucher(shopId, m.billId)}>#{m.slipNo} · {m.buyerName} · {rupees(m.totalPaise)}</button>)}
          </div>
          {result.failed.map((f) => <p key={f.line} className="error" style={{ margin: 0 }}>{t('Line {n}', { n: f.line })}: {f.error}</p>)}
        </div>
      )}
    </>
  )
}

/** A grahak in the grid: type-ahead by name, mobile or code; Enter takes the lit one (or the typed name as a new grahak). */
function GrahakCell({ shopId, row, upper, bad, onPick, onEnter }: {
  shopId: string; row: Row; upper: boolean; bad?: boolean; onPick: (b: Row['buyer'], text: string) => void; onEnter: (e: KeyboardEvent) => void
}) {
  const [list, setList] = useState<BuyerRow[]>([])
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState(0)
  const text = row.buyer?.name ?? row.text
  useEffect(() => {
    if (!open || !row.text.trim()) { setList([]); return }
    let live = true
    const x = setTimeout(() => api<{ buyers: BuyerRow[] }>(`/v1/admin/shops/${shopId}/buyers?q=${encodeURIComponent(row.text.trim())}`)
      .then((r) => { if (live) { setList(r.buyers.filter((b) => !b.hidden).slice(0, 6)); setSel(0) } }).catch(() => {}), 150)
    return () => { live = false; clearTimeout(x) }
  }, [row.text, open, shopId])
  const exact = list.find((b) => b.name.trim().toLowerCase() === row.text.trim().toLowerCase())
  return (
    <div className="combo grahak-cell">
      <input className={`field${bad ? ' bad' : ''}`} style={upper ? caps : undefined} value={text} placeholder={t('Naam')} aria-label={t('Grahak')} aria-invalid={bad || undefined}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { onPick(null, e.target.value); setOpen(true) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(list.length - 1, sel + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, sel - 1)) }
          else if (e.key === 'Enter') {
            const b = open && list[sel] ? list[sel] : exact
            if (b) onPick({ id: b.id, name: b.name }, b.name)
            setOpen(false); onEnter(e)
          }
        }} />
      {row.buyer?.id ? null : row.text.trim() && !exact && !open ? <span className="chip blue cell-tag">{t('Naya')}</span> : null}
      {open && list.length > 0 && (
        <div className="combo-list" role="listbox">
          {list.map((b, i) => (
            <div key={b.id} role="option" aria-selected={i === sel} className="opt" onMouseDown={(e) => { e.preventDefault(); onPick({ id: b.id, name: b.name }, b.name); setOpen(false) }}>
              <span className="grow"><b>{b.name}</b>{b.phone ? <small>{fmtPhone(b.phone)}</small> : null}</span>
              {b.balancePaise ? <span className={`money ${b.balancePaise > 0 ? 'due' : 'jama'}`}>{rupees(Math.abs(b.balancePaise))}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ================================================================ print

const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const r2 = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const PRINT_CSS = `
  @page { size: A4; margin: 12mm } * { box-sizing: border-box }
  body { font: 11.5px/1.45 Verdana, Arial, sans-serif; color: #000; margin: 0 }
  .doc { page-break-after: always; position: relative } .doc:last-child { page-break-after: auto }
  .head { display: grid; grid-template-columns: 1fr auto; gap: 12px; border: 1px solid #000; padding: 8px 10px }
  .firm { font-size: 18px; font-weight: bold; letter-spacing: .5px } .title { font-size: 15px; font-weight: bold; text-align: right; letter-spacing: 1px }
  .muted { color: #333 } .row { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #000; border-top: 0 } .row > div { padding: 6px 10px } .row > div + div { border-left: 1px solid #000 }
  table { width: 100%; border-collapse: collapse; border: 1px solid #000; border-top: 0 } th, td { border: 1px solid #000; padding: 3px 6px; text-align: left; vertical-align: top }
  th { background: #eee; font-size: 10.5px } .n { text-align: right; white-space: nowrap } .tot td { font-weight: bold } .words { border: 1px solid #000; border-top: 0; padding: 6px 10px }
  .sig { display: flex; justify-content: space-between; margin-top: 36px } .void { position: absolute; top: 38%; left: 0; right: 0; text-align: center; font-size: 72px; color: rgba(200,0,0,.25); transform: rotate(-20deg); font-weight: bold }
`
function printHtml(title: string, body: string) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument!
  doc.open(); doc.write(html); doc.close()
  setTimeout(() => { frame.contentWindow?.focus(); frame.contentWindow?.print(); setTimeout(() => frame.remove(), 1000) }, 200)
}
const sellerBlock = (s: { name: string; address: string; mandi?: string; shopNo?: string; gstin: string; licenceNo: string; phone: string; email: string }) => `
  <div class="firm">${esc(s.name.toUpperCase())}</div>
  <div class="muted">${esc([s.address, s.shopNo && `Shop ${s.shopNo}`, s.mandi].filter(Boolean).join(', '))}</div>
  <div class="muted">${esc([s.gstin && `GSTIN ${s.gstin}`, s.licenceNo && `Licence ${s.licenceNo}`, s.phone && `Ph ${s.phone}`, s.email].filter(Boolean).join(' · '))}</div>`

/** Tax invoices as issued, one to a page, in the shop's letterhead; a cancelled one marked so. */
function printInvoices(docs: InvoiceDoc[]) {
  const body = docs.map((d) => `
    <div class="doc">${d.voided ? '<div class="void">CANCELLED</div>' : ''}
      <div class="head"><div>${sellerBlock(d.seller)}</div>
        <div><div class="title">BILL OF SUPPLY</div><div class="n">No. <b>${esc(d.number)}</b></div><div class="n">Date ${dmyLong(d.date)}</div></div></div>
      <div class="row">
        <div><b>Bill to</b><br>${esc(d.buyer.name)}${d.buyer.code ? ` (${esc(d.buyer.code)})` : ''}<br>${esc(d.buyer.address)}${d.buyer.phone ? `<br>Ph ${esc(d.buyer.phone)}` : ''}${d.buyer.gstin ? `<br>GSTIN <b>${esc(d.buyer.gstin)}</b>` : ''}</div>
        <div><b>Parchi</b><br>${esc(d.slips.map((s) => `${s.slipNo ?? ''} (${dmyLong(s.date)})`).join(', '))}<br>Place of supply: ${esc(d.seller.mandi || '-')}</div>
      </div>
      <table>
        <tr><th>#</th><th>Description</th><th>HSN</th><th class="n">Qty</th><th class="n">Kg</th><th class="n">Rate</th><th class="n">Amount</th></tr>
        ${d.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc([d.item, l.quality, l.grade && gradeLabel(l.grade)].filter(Boolean).join(' · '))}${l.gaadi ? ` <span class="muted">(${esc(l.gaadi)}, parchi ${l.slipNo ?? ''})</span>` : ''}</td>
          <td>${esc(l.hsn)}</td><td class="n">${l.qty} ${esc(l.unit)}</td><td class="n">${l.kg ? l.kg.toLocaleString('en-IN') : ''}</td><td class="n">${r2(l.ratePaise)}</td><td class="n">${r2(l.amountPaise)}</td></tr>`).join('')}
        <tr class="tot"><td></td><td colspan="5">Goods value</td><td class="n">${r2(d.goodsPaise)}</td></tr>
        ${d.charges.map((c) => `<tr><td></td><td colspan="5">${esc(c.label)}</td><td class="n">${r2(c.amountPaise)}</td></tr>`).join('')}
        <tr><td></td><td colspan="5">Taxable value ${r2(d.goodsPaise)} · GST ${d.taxRate}% (CGST 0% + SGST 0%) · ${esc(d.taxNote)}</td><td class="n">${r2(d.taxPaise)}</td></tr>
        <tr class="tot"><td></td><td colspan="5">TOTAL</td><td class="n">${r2(d.totalPaise)}</td></tr>
      </table>
      <div class="words">${esc(d.words)}</div>
      ${d.seller.banks.length ? `<div class="words"><b>Bank</b> ${d.seller.banks.map((b) => esc([b.holder, b.bank, b.branch, b.account && `A/c ${b.account}`, b.ifsc && `IFSC ${b.ifsc}`].filter(Boolean).join(', '))).join('<br>')}</div>` : ''}
      <div class="sig"><span>Receiver's signature</span><span>For ${esc(d.seller.name.toUpperCase())}<br><br>Authorised signatory</span></div>
    </div>`).join('')
  printHtml(docs.length === 1 ? docs[0].number : `${docs.length} invoices`, body)
}

/** A credit note on the shop's letterhead: grahak, parchi, what comes off and why, in words. */
function printCreditNotes(notes: Cn[], s: ShopSettings) {
  const body = notes.map((c) => `
    <div class="doc">${c.voided ? '<div class="void">CANCELLED</div>' : ''}
      <div class="head"><div>${sellerBlock(s)}</div>
        <div><div class="title">CREDIT NOTE</div><div class="n">No. <b>${c.no}</b></div><div class="n">Date ${dmyLong(c.date)}</div></div></div>
      <div class="row">
        <div><b>To</b><br>${esc(c.buyer?.name ?? c.buyerName)}${c.buyer?.code ? ` (${esc(c.buyer.code)})` : ''}<br>${esc(c.buyer?.address ?? '')}${c.buyer?.gstin ? `<br>GSTIN <b>${esc(c.buyer.gstin)}</b>` : ''}</div>
        <div><b>Reason</b> ${esc(reasonLabel(c.reason))}${c.slipNo ? `<br><b>Against parchi</b> ${c.slipNo}` : ''}${c.note ? `<br>${esc(c.note)}` : ''}</div>
      </div>
      <table>
        <tr><th>#</th><th>Particulars</th><th class="n">Boxes</th><th class="n">Rate</th><th class="n">Amount</th></tr>
        ${c.lines.length ? c.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc([l.quality, l.grade && l.grade !== '1' ? l.grade : ''].filter(Boolean).join(' · '))}</td><td class="n">${l.boxes}</td><td class="n">${r2(l.ratePaise)}</td><td class="n">${r2(l.amountPaise)}</td></tr>`).join('')
          : `<tr><td>1</td><td>${esc(reasonLabel(c.reason))}${c.note ? ` · ${esc(c.note)}` : ''}</td><td></td><td></td><td class="n">${r2(c.amountPaise)}</td></tr>`}
        <tr class="tot"><td></td><td colspan="3">TOTAL (credited to your account)</td><td class="n">${r2(c.amountPaise)}</td></tr>
      </table>
      <div class="words">${esc(inWords(c.amountPaise))}</div>
      <div class="sig"><span>Receiver's signature</span><span>For ${esc(s.name.toUpperCase())}<br><br>Authorised signatory</span></div>
    </div>`).join('')
  printHtml(notes.length === 1 ? `Credit note ${notes[0].no}` : `${notes.length} credit notes`, body)
}
