import { useEffect, useState } from 'react'
import { api } from '../api'
import { usePeriod } from '../hooks'
import { count, date, phone as fmtPhone, rupees, todayIst } from '../format'
import { t } from '../i18n'
import { openRaseed } from '../keys'
import { booksChanged, useLoad } from '../useLoad'
import { PeriodBar, Skeleton } from '../ui'
import { dayRange, fileName, rs, useExport } from '../export/doc'
import { BuyerPicker, Field, Money, Seg, Sheet, Tick, type PickedBuyer } from '../entries/fields'

// ================================================================ Bank jama parchi (deposit slips)

type Account = { holder: string; bank: string; branch: string; ifsc: string; account: string; phone: string; pan: string }
type Status = 'pending' | 'cleared' | 'bounced'
type Cheque = {
  id: string; slipId: string; slipNo: number; day: string; buyerId: string | null; name: string | null; drawer: string; bank: string; branch: string; city: string
  chequeNo: string; chequeDate: string | null; amountPaise: number; collectionId: string | null; madeRaseed: boolean; receiptNo: number | null; raseedLive: boolean
  status: Status; statusOn: string | null; bounceReason: string; chargesPaise: number
}
type SlipRow = {
  id: string; slipNo: number; day: string; bank: string; account: string; note: string; voided: boolean; cashPaise: number; chequePaise: number; totalPaise: number
  cheques: number; pending: number; cleared: number; bounced: number; names: string[]
}
type Slip = {
  id: string; slipNo: number; day: string; account: Account; notes: Record<string, number>; cashPaise: number; chequePaise: number; totalPaise: number
  note: string; daybook: boolean; by: string; at: string; voided: boolean; cheques: Cheque[]
}
type Form = { shopName: string; shopPhone: string; accounts: Account[]; nextNo: number; banks: { bank: string; branch: string; city: string }[]; today: string }

const NOTES = ['2000', '500', '200', '100', '50', '20', '10'] as const
const STATUS: Record<Status, { label: string; tone: string }> = {
  pending: { label: 'Bank mein', tone: 'amber' }, cleared: { label: 'Clear', tone: 'green' }, bounced: { label: 'Bounce', tone: 'red' },
}
const BOUNCE_REASONS = ['Funds insufficient', 'Signature mismatch', 'Payment stopped', 'Account closed', 'Date galat', 'Amount mismatch']
const blankAccount = (f?: Form): Account => ({ holder: f?.shopName ?? '', bank: '', branch: '', ifsc: '', account: '', phone: f?.shopPhone ?? '', pan: '' })
const acLabel = (a: { bank: string; account: string }) => [a.bank, a.account && `…${a.account.slice(-4)}`].filter(Boolean).join(' ')

/** Rupees in Indian words, as a slip asks for: "Rupees One Lakh Twenty Thousand Only". */
function inWords(paise: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  const two = (x: number) => (x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]} ${ones[x % 10]}`.trim())
  const three = (x: number) => [x >= 100 ? `${ones[Math.floor(x / 100)]} Hundred` : '', two(x % 100)].filter(Boolean).join(' ')
  let r = Math.floor(paise / 100)
  const p = Math.round(paise % 100)
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

/** The slips by day, and every cheque on them: where each stands. */
export function Deposits({ shopId }: { shopId: string }) {
  const [tab, setTab] = useState<'slips' | 'cheques'>('slips')
  const [edit, setEdit] = useState<Slip | 'new' | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  if (open) return <SlipView shopId={shopId} id={open} onBack={() => setOpen(null)} onEdit={setEdit} edit={edit} onEdited={() => setEdit(null)} />
  return (
    <>
      <div className="toolbar">
        <Seg value={tab} onChange={setTab} options={[{ key: 'slips', label: t('Parchiyan') }, { key: 'cheques', label: t('Cheques') }]} />
        <span className="grow" />
        <button type="button" className="btn primary" onClick={() => setEdit('new')}>+ {t('Bank jama parchi')}</button>
      </div>
      {tab === 'slips' ? <SlipList shopId={shopId} onOpen={setOpen} /> : <ChequeRegister shopId={shopId} onOpen={setOpen} />}
      {edit && <SlipSheet shopId={shopId} slip={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={(id) => { setEdit(null); setOpen(id) }} />}
    </>
  )
}

function StatusChips({ r }: { r: { pending: number; cleared: number; bounced: number; voided?: boolean } }) {
  if (r.voided) return <span className="chip grey">{t('Hatayi gayi')}</span>
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {r.pending > 0 && <span className="chip amber">{r.pending} {t(STATUS.pending.label)}</span>}
      {r.cleared > 0 && <span className="chip green">{r.cleared} {t(STATUS.cleared.label)}</span>}
      {r.bounced > 0 && <span className="chip red">{r.bounced} {t(STATUS.bounced.label)}</span>}
    </span>
  )
}

function SlipList({ shopId, onOpen }: { shopId: string; onOpen: (id: string) => void }) {
  const [period, setPeriod] = usePeriod('30')
  const { data, error, loading } = useLoad(() => api<{ slips: SlipRow[]; totals: { cashPaise: number; chequePaise: number; pendingPaise: number; bouncedPaise: number } }>(
    `/v1/admin/shops/${shopId}/deposits?from=${period.from}&to=${period.to}`), [shopId, period.from, period.to])
  useExport(data ? () => ({
    style: 'book' as const, title: t('Bank Jama Parchi'), dateLine: dayRange(period.from, period.to), file: fileName('Bank jama', period.from, period.to),
    columns: [{ label: t('No.') }, { label: t('Tarikh') }, { label: t('Bank') }, { label: t('Grahak'), wide: true }, { label: t('Cheque'), num: true }, { label: t('Cash'), num: true }, { label: t('Kul'), num: true }],
    rows: data.slips.filter((s) => !s.voided).map((s) => ({ cells: [String(s.slipNo), date(s.day), acLabel(s), s.names.join(', '), rs(s.chequePaise), rs(s.cashPaise), rs(s.totalPaise)] })),
    foot: ['', '', '', t('Kul'), rs(data.totals.chequePaise), rs(data.totals.cashPaise), rs(data.totals.chequePaise + data.totals.cashPaise)],
  }) : null, [data])
  return (
    <>
      <div className="toolbar"><PeriodBar value={period} onChange={setPeriod} /></div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Cheque')}</span><span className="v">{rupees(data.totals.chequePaise)}</span></div>
            <div><span className="lb">{t('Cash')}</span><span className="v">{rupees(data.totals.cashPaise)}</span></div>
            <div><span className="lb">{t('Bank mein')}</span><span className="v">{rupees(data.totals.pendingPaise)}</span></div>
            <div><span className="lb">{t('Bounce')}</span><span className={`v${data.totals.bouncedPaise ? ' due' : ''}`}>{rupees(data.totals.bouncedPaise)}</span></div>
          </div>
          <div className={`card wrap-x${loading ? ' dim' : ''}`}>
            <table className="tbl fold">
              <thead><tr><th className="opt-col">{t('No.')}</th><th className="opt-col">{t('Tarikh')}</th><th>{t('Grahak')}</th><th className="opt-col">{t('Bank')}</th><th className="num opt-col">{t('Cheque')}</th><th className="num opt-col">{t('Cash')}</th><th className="num">{t('Kul')}</th><th className="opt-col" /></tr></thead>
              <tbody>
                {data.slips.map((s) => (
                  <tr key={s.id} data-row tabIndex={0} className={s.voided ? 'muted' : ''} onClick={() => onOpen(s.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(s.id) }}>
                    <td className="opt-col money">{s.slipNo}</td>
                    <td className="opt-col muted">{date(s.day)}</td>
                    <td className="main-col"><b style={s.voided ? { textDecoration: 'line-through' } : undefined}>{s.names.join(', ') || (s.cashPaise ? t('Cash') : '—')}</b>
                      <small><span className="show-sm">#{s.slipNo} · {date(s.day)} · </span>{acLabel(s)}{s.cheques ? ` · ${count(s.cheques)} ${t('cheque')}` : ''}</small></td>
                    <td className="opt-col">{acLabel(s)}</td>
                    <td className="num opt-col money">{s.chequePaise ? rupees(s.chequePaise) : ''}</td>
                    <td className="num opt-col money">{s.cashPaise ? rupees(s.cashPaise) : ''}</td>
                    <td className="num amt-col money b">{rupees(s.totalPaise)}</td>
                    <td className="opt-col"><StatusChips r={s} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.slips.length === 0 && <p className="empty">{t('Is samay koi parchi nahi')}</p>}
          </div>
        </>
      )}
    </>
  )
}

function ChequeRegister({ shopId, onOpen }: { shopId: string; onOpen: (id: string) => void }) {
  const [status, setStatus] = useState<Status | ''>('pending')
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  useEffect(() => { const x = setTimeout(() => setDq(q.trim()), 250); return () => clearTimeout(x) }, [q])
  const [acting, setActing] = useState<Cheque | null>(null)
  const { data, error, loading } = useLoad(() => api<{ cheques: Cheque[] }>(`/v1/admin/shops/${shopId}/deposits/cheques?status=${status}&q=${encodeURIComponent(dq)}`), [shopId, status, dq])
  useExport(data ? () => ({
    style: 'book' as const, title: t('Cheque Register'), file: fileName('Cheques', todayIst()),
    columns: [{ label: t('Tarikh') }, { label: t('Grahak'), wide: true }, { label: t('Bank') }, { label: t('Cheque no.') }, { label: t('Rakam'), num: true }, { label: t('Haal') }],
    rows: data.cheques.map((c) => ({ cells: [date(c.day), c.name || c.drawer, [c.bank, c.branch].filter(Boolean).join(' '), c.chequeNo, rs(c.amountPaise), t(STATUS[c.status].label)] })),
    foot: ['', t('Kul'), '', '', rs(data.cheques.reduce((s, c) => s + c.amountPaise, 0)), ''],
  }) : null, [data])
  return (
    <>
      <div className="toolbar">
        <Seg value={status} onChange={setStatus} options={[{ key: 'pending', label: t('Bank mein') }, { key: 'cleared', label: t('Clear') }, { key: 'bounced', label: t('Bounce') }, { key: '', label: t('Sab') }]} />
        <input className="field search grow" data-search type="search" placeholder={t('Grahak, bank ya cheque no.')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <ChequeTable shopId={shopId} rows={data.cheques} onSlip={onOpen} onAct={setActing} />
          {data.cheques.length === 0 && <p className="empty">{t('Koi cheque nahi')}</p>}
        </div>
      )}
      {acting && <StatusSheet shopId={shopId} c={acting} onClose={() => setActing(null)} />}
    </>
  )
}

function ChequeTable({ shopId, rows, onSlip, onAct, inSlip }: { shopId: string; rows: Cheque[]; onSlip?: (id: string) => void; onAct?: (c: Cheque) => void; inSlip?: boolean }) {
  return (
    <table className="tbl fold">
      <thead><tr>{!inSlip && <th className="opt-col">{t('Tarikh')}</th>}<th>{t('Grahak')}</th><th className="opt-col">{t('Bank')}</th><th className="opt-col">{t('Cheque no.')}</th><th className="num">{t('Rakam')}</th><th className="opt-col">{t('Khata')}</th><th>{t('Haal')}</th></tr></thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.id} data-row tabIndex={0} onClick={() => (onSlip ? onSlip(c.slipId) : onAct?.(c))}>
            {!inSlip && <td className="opt-col muted">{date(c.day)}</td>}
            <td className="main-col"><b>{c.name || c.drawer || '—'}</b>
              <small><span className="show-sm">{[c.bank, c.chequeNo && `#${c.chequeNo}`].filter(Boolean).join(' · ')}</span>{c.name && c.drawer && c.drawer !== c.name.toUpperCase() ? ` ${c.drawer}` : ''}</small></td>
            <td className="opt-col">{[c.bank, c.branch].filter(Boolean).join(' · ')}<small>{c.city}</small></td>
            <td className="opt-col money">{c.chequeNo}<small>{c.chequeDate ? date(c.chequeDate) : ''}</small></td>
            <td className="num amt-col money b">{rupees(c.amountPaise)}</td>
            <td className="opt-col">{c.collectionId ? <button type="button" className="link" onClick={(e) => { e.stopPropagation(); openRaseed(shopId, c.collectionId!) }}
              style={!c.raseedLive ? { textDecoration: 'line-through' } : undefined}>{t('Raseed')}{c.receiptNo ? ` #${c.receiptNo}` : ''}</button> : <span className="muted">—</span>}</td>
            <td>
              <span className={`chip ${STATUS[c.status].tone}`}>{t(STATUS[c.status].label)}</span>
              {c.status === 'bounced' && <small>{[c.bounceReason, c.chargesPaise ? `${t('charges')} ${rupees(c.chargesPaise)}` : ''].filter(Boolean).join(' · ')}</small>}
              {c.status !== 'bounced' && onAct && <button type="button" className="btn ghost sm" style={{ marginLeft: 6 }} onClick={(e) => { e.stopPropagation(); onAct(c) }}>{t('Haal badlein')}</button>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Clear, or bounce with the bank's reason and charges (the raseed it made comes out of the khata). */
function StatusSheet({ shopId, c, onClose }: { shopId: string; c: Cheque; onClose: () => void }) {
  const [status, setStatus] = useState<Status>(c.status === 'pending' ? 'cleared' : 'pending')
  const [on, setOn] = useState(todayIst())
  const [reason, setReason] = useState(BOUNCE_REASONS[0])
  const [charges, setCharges] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    setSaving(true); setError('')
    try {
      await api(`/v1/admin/shops/${shopId}/deposits/cheques/${c.id}/status`, { method: 'POST', body: { status, on, reason, chargesPaise: charges } })
      booksChanged(); onClose()
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  return (
    <Sheet title={`${c.name || c.drawer} · ${rupees(c.amountPaise)}`} onClose={onClose} onSave={() => void save()} saving={saving} error={error}>
      <Seg value={status} onChange={setStatus} options={[{ key: 'cleared', label: t('Clear') }, { key: 'bounced', label: t('Bounce') }, { key: 'pending', label: t('Bank mein') }]} />
      {status !== 'pending' && <Field label={t('Tarikh')}><input className="field" type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>}
      {status === 'bounced' && (
        <>
          <Field label={t('Wajah')}>
            <input className="field" list="bounce-reasons" value={reason} onChange={(e) => setReason(e.target.value)} />
            <datalist id="bounce-reasons">{BOUNCE_REASONS.map((r) => <option key={r} value={r} />)}</datalist>
          </Field>
          <Field label={t('Bank charges')}><Money value={charges} onChange={setCharges} /></Field>
          {c.raseedLive && <p className="muted">{t('Raseed #{n} khate se hategi', { n: String(c.receiptNo) })}</p>}
        </>
      )}
    </Sheet>
  )
}

function SlipView({ shopId, id, onBack, onEdit, edit, onEdited }: {
  shopId: string; id: string; onBack: () => void; onEdit: (s: Slip) => void; edit: Slip | 'new' | null; onEdited: () => void
}) {
  const { data: s, error } = useLoad(() => api<Slip>(`/v1/admin/shops/${shopId}/deposits/${id}`), [shopId, id])
  const [acting, setActing] = useState<Cheque | null>(null)
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState('')
  const remove = async () => {
    if (!s || !confirm(t('Parchi #{n} hatayein? Iske raseed bhi hatenge.', { n: String(s.slipNo) }))) return
    setBusy(true); setFail('')
    try { await api(`/v1/admin/shops/${shopId}/deposits/${id}/delete`, { method: 'POST' }); booksChanged() }
    catch (e) { setFail((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <>
      <div className="toolbar">
        <button type="button" className="btn ghost" data-back onClick={onBack}>‹ {t('Bank Jama Parchi')}</button>
        <span className="grow" />
        {s && !s.voided && <>
          <button type="button" className="btn" onClick={() => printSlip(s)}>{t('Print')}</button>
          <button type="button" className="btn" onClick={() => onEdit(s)}>{t('Badlein')}</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void remove()}>{t('Hatayein')}</button>
        </>}
      </div>
      {(error || fail) && <p className="error">{error || fail}</p>}
      {!s ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Parchi')} #{s.slipNo}</span><span className="v">{date(s.day)}</span>{s.voided && <span className="chip grey">{t('Hatayi gayi')}</span>}</div>
            <div><span className="lb">{t('Account')}</span><span className="v">{acLabel(s.account)}</span><small>{[s.account.holder, s.account.branch, s.account.ifsc].filter(Boolean).join(' · ')}</small></div>
            <div><span className="lb">{t('Kul')}</span><span className="v">{rupees(s.totalPaise)}</span><small>{inWords(s.totalPaise)}</small></div>
          </div>
          {s.cheques.length > 0 && (
            <div className="card wrap-x"><ChequeTable shopId={shopId} rows={s.cheques} inSlip onAct={s.voided ? undefined : setActing} /></div>
          )}
          {s.cashPaise > 0 && (
            <div className="card" style={{ padding: 14 }}>
              <b>{t('Cash')} · {rupees(s.cashPaise)}</b>
              <p className="muted" style={{ margin: '6px 0 0' }}>
                {[...NOTES, 'coins'].filter((k) => s.notes[k]).map((k) => (k === 'coins' ? `${t('Sikke')} ${rupees(s.notes[k])}` : `₹${k} × ${s.notes[k]}`)).join(' · ')}
                {s.daybook ? ` · ${t('Day Book mein bank jama')}` : ''}
              </p>
            </div>
          )}
          {s.note && <p className="muted">{s.note}</p>}
        </>
      )}
      {acting && <StatusSheet shopId={shopId} c={acting} onClose={() => setActing(null)} />}
      {edit && edit !== 'new' && <SlipSheet shopId={shopId} slip={edit} onClose={onEdited} onSaved={() => { onEdited(); booksChanged() }} />}
    </>
  )
}

// ---------------------------------------------------------------- the form

type Line = {
  key: string; id?: string; buyer: PickedBuyer | null; drawer: string; bank: string; branch: string; city: string; chequeNo: string; chequeDate: string
  amount: number; raseed: 'new' | string | null; raseeds: { id: string; receiptNo: number | null; amountPaise: number; ref: string; day: string }[]
  locked?: boolean
}
let lineKey = 0
const blankLine = (): Line => ({ key: String(++lineKey), buyer: null, drawer: '', bank: '', branch: '', city: '', chequeNo: '', chequeDate: '', amount: 0, raseed: null, raseeds: [] })
const caps = { textTransform: 'uppercase' as const }

function SlipSheet({ shopId, slip, onClose, onSaved }: { shopId: string; slip: Slip | null; onClose: () => void; onSaved: (id: string) => void }) {
  const { data: form } = useLoad(() => api<Form>(`/v1/admin/shops/${shopId}/deposits/form`), [shopId])
  const [day, setDay] = useState(slip?.day ?? todayIst())
  const [acIndex, setAcIndex] = useState(-1)
  const [account, setAccount] = useState<Account>(slip?.account ?? blankAccount())
  const [lines, setLines] = useState<Line[]>(() => slip ? slip.cheques.map((c) => ({
    key: String(++lineKey), id: c.id, buyer: c.buyerId ? { id: c.buyerId, name: c.name ?? '' } : null, drawer: c.drawer, bank: c.bank, branch: c.branch, city: c.city,
    chequeNo: c.chequeNo, chequeDate: c.chequeDate ?? '', amount: c.amountPaise, raseed: c.collectionId && c.raseedLive ? (c.madeRaseed ? 'new' : c.collectionId) : null,
    raseeds: [], locked: c.status === 'bounced',
  })) : [blankLine()])
  const [notes, setNotes] = useState<Record<string, number>>(slip?.notes ?? {})
  const [note, setNote] = useState(slip?.note ?? '')
  const [daybook, setDaybook] = useState(slip ? slip.daybook || !slip.cashPaise : true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [tried, setTried] = useState(false)

  // A new slip starts on the shop's first account; one with none starts blank, to be remembered.
  useEffect(() => {
    if (!form || slip) return
    if (form.accounts.length) { setAcIndex(0); setAccount(form.accounts[0]) } else setAccount(blankAccount(form))
  }, [form, slip])

  const cash = NOTES.reduce((t, k) => t + (notes[k] ?? 0) * Number(k) * 100, 0) + (notes.coins ?? 0)
  const chequeTotal = lines.reduce((t, l) => t + l.amount, 0)
  const total = cash + chequeTotal
  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  // Picking a grahak: their last bank fills in, and a bank raseed not yet on a slip is offered.
  const pickBuyer = async (key: string, b: PickedBuyer | null) => {
    setLine(key, { buyer: b, raseed: b?.id ? 'new' : null, raseeds: [] })
    if (!b?.id) return
    try {
      const g = await api<{ last: { drawer: string; bank: string; branch: string; city: string } | null; raseeds: Line['raseeds'] }>(`/v1/admin/shops/${shopId}/deposits/grahak/${b.id}`)
      setLines((ls) => ls.map((l) => (l.key !== key ? l : {
        ...l, raseeds: g.raseeds,
        drawer: l.drawer || g.last?.drawer || '', bank: l.bank || g.last?.bank || '', branch: l.branch || g.last?.branch || '', city: l.city || g.last?.city || '',
        ...(g.raseeds.length && !l.amount ? { raseed: g.raseeds[0].id, amount: g.raseeds[0].amountPaise, chequeNo: l.chequeNo || g.raseeds[0].ref.replace(/^CHQ\s*/i, '') } : {}),
      })))
    } catch { /* the line still works by hand */ }
  }

  const needPan = cash >= 5_000_000 && !/^[A-Z]{5}\d{4}[A-Z]$/.test(account.pan)
  const save = async () => {
    setError(''); setTried(true)
    const filled = lines.filter((l) => l.amount > 0)
    // Each miss is said beside its box; only "nothing at all" goes at the foot.
    if (!account.account.trim() || needPan || filled.some((l) => !l.chequeNo.trim())) return
    if (!total) return setError(t('Cheque ya cash daalein'))
    setSaving(true)
    try {
      const body = {
        day, account, notes, note, daybook, saveAccount: acIndex < 0,
        cheques: filled.map((l) => ({
          id: l.id, buyerId: l.buyer?.id ?? null, drawer: l.drawer || (l.buyer?.id ? '' : l.buyer?.name ?? ''), bank: l.bank, branch: l.branch, city: l.city,
          chequeNo: l.chequeNo, chequeDate: l.chequeDate || null, amountPaise: l.amount, raseed: l.buyer?.id ? l.raseed : null,
        })),
      }
      const r = await api<{ id: string }>(slip ? `/v1/admin/shops/${shopId}/deposits/${slip.id}` : `/v1/admin/shops/${shopId}/deposits`, { method: 'POST', body })
      booksChanged(); onSaved(r.id)
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }

  return (
    <Sheet wide title={slip ? t('Parchi #{n} badlein', { n: String(slip.slipNo) }) : `${t('Bank jama parchi')}${form ? ` #${form.nextNo}` : ''}`}
      onClose={onClose} onSave={() => void save()} saving={saving} error={error} saveLabel={total ? `${t('Save')} · ${rupees(total)}` : t('Save')}>
      <div className="row2">
        <Field label={t('Account')}>
          <select className="field" value={acIndex} onChange={(e) => {
            const i = Number(e.target.value); setAcIndex(i)
            setAccount(i >= 0 && form ? form.accounts[i] : blankAccount(form ?? undefined))
          }}>
            {(form?.accounts ?? []).map((a, i) => <option key={a.account} value={i}>{acLabel(a)} · {a.holder}</option>)}
            <option value={-1}>{t('Naya account')}</option>
          </select>
        </Field>
        <Field label={t('Tarikh')}><input className="field" type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
      </div>
      {acIndex < 0 && (
        <div className="card" style={{ padding: 12, display: 'grid', gap: 10 }}>
          <div className="row2">
            <Field label={t('Naam (account)')}><input className="field" style={caps} value={account.holder} onChange={(e) => setAccount({ ...account, holder: e.target.value })} /></Field>
            <Field label={t('Account number')} error={tried && !account.account.trim() ? t('Account number daalein') : ''}><input className="field" inputMode="numeric" value={account.account} onChange={(e) => setAccount({ ...account, account: e.target.value.replace(/[^\d]/g, '') })} /></Field>
          </div>
          <div className="row2">
            <Field label={t('Bank')}><input className="field" style={caps} value={account.bank} onChange={(e) => setAccount({ ...account, bank: e.target.value })} /></Field>
            <Field label={t('Branch')}><input className="field" style={caps} value={account.branch} onChange={(e) => setAccount({ ...account, branch: e.target.value })} /></Field>
          </div>
          <div className="row2">
            <Field label={t('Contact no.')}><input className="field" inputMode="tel" value={account.phone} onChange={(e) => setAccount({ ...account, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} /></Field>
            <Field label={t('PAN')} error={tried && needPan ? t('PAN zaroori') : ''}><input className="field" style={caps} maxLength={10} value={account.pan} onChange={(e) => setAccount({ ...account, pan: e.target.value.toUpperCase() })} /></Field>
          </div>
        </div>
      )}
      {acIndex >= 0 && <p className="muted" style={{ margin: 0 }}>{[account.holder, account.account, account.phone && fmtPhone(account.phone), account.pan && `PAN ${account.pan}`].filter(Boolean).join(' · ')}</p>}

      <b>{t('Cheque')}</b>
      {lines.map((l, i) => (
        <div key={l.key} className="card" style={{ padding: 12, display: 'grid', gap: 10, opacity: l.locked ? 0.6 : 1 }}>
          <div className="row2">
            <Field label={`${i + 1}. ${t('Grahak')}`}>
              {l.locked ? <input className="field" disabled value={l.buyer?.name ?? l.drawer} /> : <BuyerPicker shopId={shopId} value={l.buyer} onChange={(b) => void pickBuyer(l.key, b)} walkIn autoFocus={!slip && i === 0} />}
            </Field>
            <Field label={t('Rakam')}>{l.locked ? <input className="field" disabled value={rupees(l.amount)} /> : <Money value={l.amount} onChange={(v) => setLine(l.key, { amount: v })} />}</Field>
          </div>
          <div className="g3" style={{ display: 'grid', gap: 10 }}>
            <Field label={t('Bank')}><input className="field" style={caps} list="dep-banks" value={l.bank} onChange={(e) => {
              const v = e.target.value; const known = form?.banks.find((b) => b.bank.toLowerCase() === v.toLowerCase())
              setLine(l.key, { bank: v, ...(known && !l.branch ? { branch: known.branch, city: known.city } : {}) })
            }} /></Field>
            <Field label={t('Branch')}><input className="field" style={caps} value={l.branch} onChange={(e) => setLine(l.key, { branch: e.target.value })} /></Field>
            <Field label={t('Shehar')}><input className="field" style={caps} value={l.city} onChange={(e) => setLine(l.key, { city: e.target.value })} /></Field>
          </div>
          <div className="row2">
            <Field label={t('Cheque no.')} error={tried && l.amount > 0 && !l.chequeNo.trim() ? t('Cheque number daalein') : ''}><input className="field" inputMode="numeric" maxLength={12} value={l.chequeNo} onChange={(e) => setLine(l.key, { chequeNo: e.target.value.replace(/\D/g, '') })} /></Field>
            <Field label={t('Cheque ki tarikh')}><input className="field" type="date" value={l.chequeDate} onChange={(e) => setLine(l.key, { chequeDate: e.target.value })} /></Field>
          </div>
          {l.buyer?.id && !l.locked && (
            <Seg value={l.raseed ?? ''} onChange={(v) => {
              const r = l.raseeds.find((x) => x.id === v)
              setLine(l.key, { raseed: v || null, ...(r ? { amount: r.amountPaise } : {}) })
            }} options={[
              { key: 'new', label: t('Khate mein jama') },
              // A raseed from an app without numbers is told apart by its day.
              ...l.raseeds.map((r) => ({ key: r.id, label: [r.receiptNo ? `${t('Raseed')} #${r.receiptNo}` : t('Raseed'), rupees(r.amountPaise), r.receiptNo ? '' : date(r.day)].filter(Boolean).join(' · ') })),
              ...(l.raseed && l.raseed !== 'new' && !l.raseeds.some((r) => r.id === l.raseed) ? [{ key: l.raseed, label: t('Raseed juda') }] : []),
              { key: '', label: t('Sirf parchi') },
            ]} />
          )}
          {!l.locked && lines.length > 1 && <button type="button" className="btn ghost sm" style={{ justifySelf: 'end' }} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>{t('Hatayein')}</button>}
        </div>
      ))}
      <datalist id="dep-banks">{[...new Set((form?.banks ?? []).map((b) => b.bank))].map((b) => <option key={b} value={b} />)}</datalist>
      <button type="button" className="btn ghost" onClick={() => setLines((ls) => [...ls, blankLine()])}>+ {t('Aur cheque')}</button>

      <b>{t('Cash')}</b>
      <div className="g3" style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
        {NOTES.map((k) => (
          <Field key={k} label={`₹${k} ×`}>
            <input className="field" inputMode="numeric" value={notes[k] || ''} placeholder="0"
              onChange={(e) => setNotes({ ...notes, [k]: Number(e.target.value.replace(/\D/g, '').slice(0, 6)) || 0 })} />
          </Field>
        ))}
        <Field label={t('Sikke')}><Money value={notes.coins ?? 0} onChange={(v) => setNotes({ ...notes, coins: v })} /></Field>
      </div>
      {cash > 0 && <Tick label={t('Day Book mein bank jama ({amt})', { amt: rupees(cash) })} on={daybook} onChange={setDaybook} />}
      {needPan && <p className="error" style={{ margin: 0 }}>{t('₹50,000 se zyada cash ke liye PAN zaroori hai')}</p>}

      <Field label={t('Note')}><input className="field" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="card" style={{ padding: 12, background: 'var(--box)' }}>
        <b>{t('Kul')} {rupees(total)}</b>
        <small style={{ display: 'block' }}>{inWords(total)}</small>
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------- print

/** The slip as the bank's paper has it — counterfoil and bank copy — on an A4, to file with the stamped one. */
function printSlip(s: Slip) {
  const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  const r = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })
  const boxes = (v: string, n: number) => `<span class="boxes">${Array.from({ length: n }, (_, i) => `<i>${esc(v[i] ?? '')}</i>`).join('')}</span>`
  const d = s.day.split('-').reverse().join('')
  const chequeRows = (full: boolean) => [...s.cheques, ...Array(Math.max(0, 4 - s.cheques.length)).fill(null)].map((c: Cheque | null) => c
    ? `<tr><td>${esc(full ? [c.bank, c.branch].filter(Boolean).join(', ') : [[c.bank, c.branch].filter(Boolean).join(', '), c.name || c.drawer].filter(Boolean).join(' · '))}</td>${full ? `<td>${esc(c.city)}</td>` : ''}<td>${esc(c.chequeNo)}</td><td class="n">${r(c.amountPaise)}</td></tr>`
    : `<tr><td>&nbsp;</td>${full ? '<td></td>' : ''}<td></td><td></td></tr>`).join('')
  const cashRows = [...NOTES, 'coins'].map((k) => `<tr><td>${k === 'coins' ? 'Coins' : `${k} ×`}</td><td class="n">${k === 'coins' ? (s.notes[k] ? r(s.notes[k]) : '') : (s.notes[k] || '')}</td><td class="n">${s.notes[k] ? r(k === 'coins' ? s.notes[k] : s.notes[k] * Number(k) * 100) : ''}</td></tr>`).join('')
  const head = (title: string) => `<div class="hd"><b>${esc(s.account.bank || 'BANK')}</b><span>${title} · No. ${s.slipNo}</span><span>Date ${boxes(d, 8)}</span></div>
    <div>Account Number ${boxes(s.account.account, Math.max(14, s.account.account.length))}</div>
    <div>Name <b>${esc(s.account.holder)}</b></div>`
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Deposit slip ${s.slipNo}</title><style>
    @page { size: A4 landscape; margin: 10mm } * { box-sizing: border-box }
    body { font: 11px/1.45 Verdana, Arial, sans-serif; color: #000; margin: 0 }
    .slip { display: grid; grid-template-columns: 1fr 1.5fr; gap: 0; border: 1px solid #000 }
    .part { padding: 8px 10px; display: grid; gap: 6px; align-content: start } .part + .part { border-left: 1px dashed #000 }
    .hd { display: flex; justify-content: space-between; align-items: center; gap: 8px; border-bottom: 1px solid #000; padding-bottom: 4px }
    .boxes { display: inline-flex; vertical-align: middle } .boxes i { font-style: normal; width: 15px; height: 17px; border: 1px solid #000; margin-left: -1px; text-align: center; font-weight: bold }
    table { width: 100%; border-collapse: collapse; font-size: 11px } th, td { border: 1px solid #000; padding: 2px 5px; text-align: left } th { font-size: 10px } .n { text-align: right }
    .two { display: grid; grid-template-columns: 1.6fr 1fr; gap: 8px } .sig { display: flex; justify-content: space-between; margin-top: 18px }
    .tot { font-weight: bold } .muted { color: #444 }
  </style></head><body><div class="slip">
    <div class="part">${head('Counterfoil')}
      <table><tr><th>Cheque details</th><th>Cheque No.</th><th class="n">Rupees</th></tr>${chequeRows(false)}
        ${s.cashPaise ? `<tr><td colspan="2">Cash</td><td class="n">${r(s.cashPaise)}</td></tr>` : ''}
        <tr class="tot"><td colspan="2">Total Rs.</td><td class="n">${r(s.totalPaise)}</td></tr></table>
      <div>${esc(inWords(s.totalPaise))}</div>
      <div class="sig"><span>Depositor's Signature</span><span>Teller's Signature</span></div>
    </div>
    <div class="part">${head('Deposit Slip (Bank Copy)')}
      <div>Contact No. ${boxes(s.account.phone, 10)} &nbsp; PAN ${boxes(s.account.pan, 10)}</div>
      <div class="two">
        <table><tr><th>Bank &amp; Branch</th><th>City</th><th>Cheque No.</th><th class="n">Rupees</th></tr>${chequeRows(true)}
          <tr class="tot"><td colspan="3">Total</td><td class="n">${r(s.chequePaise)}</td></tr></table>
        <table><tr><th>Denomination</th><th class="n">No.</th><th class="n">Rupees</th></tr>${cashRows}
          <tr class="tot"><td colspan="2">Total</td><td class="n">${r(s.cashPaise)}</td></tr></table>
      </div>
      <div class="tot">Total Rupees ${r(s.totalPaise)}</div>
      <div>${esc(inWords(s.totalPaise))}</div>
      ${s.note ? `<div class="muted">Purpose: ${esc(s.note)}</div>` : ''}
      <div class="sig"><span>Depositor's Signature</span><span>Teller's Signature</span></div>
    </div>
  </div></body></html>`
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument!
  doc.open(); doc.write(html); doc.close()
  setTimeout(() => { frame.contentWindow?.focus(); frame.contentWindow?.print(); setTimeout(() => frame.remove(), 1000) }, 200)
}
