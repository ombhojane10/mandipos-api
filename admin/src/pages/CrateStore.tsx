import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSession } from '../App'
import { usePeriod } from '../hooks'
import { count, rupees, shortDate, todayIst } from '../format'
import { t } from '../i18n'
import { hashQuery, href, setHashQuery } from '../routes'
import { booksChanged, useLoad } from '../useLoad'
import { PeriodBar, Skeleton } from '../ui'
import { dayRange, fileName, rs, useExport } from '../export/doc'
import { BuyerPicker, Field, Money, Seg, Sheet, type PickedBuyer } from '../entries/fields'

/** Grapes shops write every name in capitals; the inputs show it as typed. */
function useCaps(shopId: string) {
  const { shops } = useSession()
  return shops?.find((x) => x.id === shopId)?.commodity === 'angoor'
}
const CAPS = { textTransform: 'uppercase' as const }
const PAIR = { display: 'flex', gap: 8, marginLeft: 'auto' }
const LINK = { background: 'none', border: 0, padding: 0, color: 'var(--accent, inherit)', cursor: 'pointer', textAlign: 'left' as const, textDecoration: 'underline' }
const has = (q: string, ...v: (string | number | null | undefined)[]) => { const f = q.trim().toLowerCase(); return !f || v.some((x) => String(x ?? '').toLowerCase().includes(f)) }
const signed = (v: number) => (v < 0 ? `−${count(-v)}` : count(v))

function useSaver(onClose: () => void) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const run = async (fn: () => Promise<unknown>) => {
    setSaving(true); setError('')
    try { await fn(); booksChanged(); onClose() } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  return { saving, error, setError, run }
}

// ================================================================ Crate In / Crate Out

type CrateType = { id: string; name: string; depositPaise: number; hidden: boolean; out: number; in: number; balance: number }
type CrateMove = { id: string; day: string; dir: 'out' | 'in'; buyerId: string | null; party: string; typeId: string; type: string; qty: number; depositPaise: number; billId: string | null; slipNo: number | null; note: string }
type Party = { key: string; buyerId: string | null; name: string; out: number; in: number; balance: number; valuePaise: number; lastDay: string }
type Register = {
  from: string; to: string; types: CrateType[]; moves: CrateMove[]; parties: Party[]; suppliers: string[]
  totals: { periodOut: number; periodIn: number; out: number; in: number; balance: number; baakiParties: number; valuePaise: number }
}
type PartyKhata = {
  buyerId: string | null; name: string; balance: number; out: number; in: number; valuePaise: number
  byType: { typeId: string; name: string; balance: number; valuePaise: number }[]
  lines: (CrateMove & { balance: number })[]
}
type PartyRef = { buyerId: string | null; name: string }
type CrateDraft = { move?: CrateMove; dir: 'out' | 'in'; party?: PartyRef }

const partyKey = (p: PartyRef) => (p.buyerId ? `g:${p.buyerId}` : `s:${p.name}`)
const partyFromKey = (k: string): PartyRef | null => (k.startsWith('g:') ? { buyerId: k.slice(2), name: '' } : k.startsWith('s:') ? { buyerId: null, name: k.slice(2) } : null)
const partyUrl = (p: PartyRef) => (p.buyerId ? `buyerId=${p.buyerId}` : `name=${encodeURIComponent(p.name)}`)

/** Crates out to a party and back: who still has how many, every entry, and the crate types. */
export function Crates({ shopId }: { shopId: string }) {
  const [tab, setTab] = useState<'baaki' | 'register' | 'types'>('baaki')
  const [party, setPartyState] = useState<PartyRef | null>(() => partyFromKey(hashQuery().get('party') ?? ''))
  const [draft, setDraft] = useState<CrateDraft | null>(null)
  const [typeEdit, setTypeEdit] = useState<CrateType | 'new' | null>(null)
  const [period, setPeriod] = usePeriod('30')
  const { data, error, loading } = useLoad(() => api<Register>(`/v1/admin/shops/${shopId}/crates?from=${period.from}&to=${period.to}`), [shopId, period.from, period.to])
  const setParty = (p: PartyRef | null) => {
    setPartyState(p)
    const q = Object.fromEntries(hashQuery())
    if (p) q.party = partyKey(p); else delete q.party
    setHashQuery(q)
  }
  const types = data?.types ?? []
  const open = (d: CrateDraft) => { if (!types.some((x) => !x.hidden) && !d.move) setTypeEdit('new'); else setDraft(d) }
  const sheets = (
    <>
      {draft && data && <CrateSheet shopId={shopId} draft={draft} types={types} suppliers={data.suppliers} onClose={() => setDraft(null)} />}
      {typeEdit && <CrateTypeSheet shopId={shopId} c={typeEdit === 'new' ? null : typeEdit} onClose={() => setTypeEdit(null)} />}
    </>
  )
  if (party) return <><CrateKhata shopId={shopId} party={party} onBack={() => setParty(null)} onNew={(dir, p) => open({ dir, party: p })} onEdit={(m) => open({ move: m, dir: m.dir })} />{sheets}</>
  return (
    <>
      <div className="toolbar">
        <Seg value={tab} onChange={setTab} options={[{ key: 'baaki', label: t('Crates baaki') }, { key: 'register', label: t('Register') }, { key: 'types', label: t('Crate') }]} />
        <span className="grow" />
        {tab === 'types'
          ? <button type="button" className="btn primary" onClick={() => setTypeEdit('new')}>+ {t('Crate')}</button>
          : <span style={PAIR}>
            <button type="button" className="btn ghost" onClick={() => open({ dir: 'in' })}>+ {t('Crate In')}</button>
            <button type="button" className="btn primary" onClick={() => open({ dir: 'out' })}>+ {t('Crate Out')}</button>
          </span>}
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : tab === 'baaki' ? <CrateParties data={data} loading={loading} onOpen={(p) => setParty(p)} />
        : tab === 'register' ? <CrateRegister data={data} loading={loading} period={period} setPeriod={setPeriod} onEdit={(m) => open({ move: m, dir: m.dir })} />
          : <CrateTypes data={data} loading={loading} onEdit={setTypeEdit} />}
      {sheets}
    </>
  )
}

function CrateParties({ data, loading, onOpen }: { data: Register; loading: boolean; onOpen: (p: PartyRef) => void }) {
  const [q, setQ] = useState('')
  const [all, setAll] = useState<'baaki' | 'sab'>('baaki')
  const rows = data.parties.filter((p) => (all === 'sab' || p.balance !== 0) && has(q, p.name))
  const tot = data.totals
  useExport(() => ({
    style: 'book' as const, title: t('Crates baaki'), file: fileName('Crates baaki'),
    columns: [{ label: t('Party'), wide: true }, { label: t('Out'), num: true }, { label: t('In'), num: true }, { label: t('Baaki'), num: true }, { label: t('Value'), num: true }, { label: t('Aakhri') }],
    rows: rows.map((p) => ({ cells: [p.name, count(p.out), count(p.in), signed(p.balance), rs(p.valuePaise), shortDate(p.lastDay)] })),
    foot: [t('Kul'), count(rows.reduce((s, p) => s + p.out, 0)), count(rows.reduce((s, p) => s + p.in, 0)), signed(rows.reduce((s, p) => s + p.balance, 0)), rs(rows.reduce((s, p) => s + p.valuePaise, 0)), ''],
  }), [data, q, all])
  return (
    <>
      <div className="card sum">
        <div><span className="lb">{t('Crates baaki')}</span><span className={`v${tot.balance > 0 ? ' due' : ''}`}>{signed(tot.balance)}</span><small>{t('{n} party', { n: count(tot.baakiParties) })}</small></div>
        <div><span className="lb">{t('Kul out')}</span><span className="v">{count(tot.out)}</span></div>
        <div><span className="lb">{t('Kul in')}</span><span className="v">{count(tot.in)}</span></div>
        <div><span className="lb">{t('Value')}</span><span className="v">{rupees(tot.valuePaise)}</span></div>
      </div>
      <div className="toolbar">
        <input className="field search grow" data-search type="search" placeholder={t('Party ka naam')} value={q} onChange={(e) => setQ(e.target.value)} />
        <Seg value={all} onChange={setAll} options={[{ key: 'baaki', label: t('Baaki') }, { key: 'sab', label: `${t('Sab')} (${count(data.parties.length)})` }]} />
      </div>
      <div className={`card wrap-x${loading ? ' dim' : ''}`}>
        <table className="tbl fold">
          <thead><tr><th>{t('Party')}</th><th className="num opt-col">{t('Out')}</th><th className="num opt-col">{t('In')}</th><th className="num">{t('Baaki')}</th><th className="num opt-col">{t('Value')}</th><th className="opt-col">{t('Aakhri')}</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.key} data-row tabIndex={0} onClick={() => onOpen(p)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(p) }}>
                <td className="main-col"><b className="name">{p.name}</b><small>{p.buyerId ? '' : <span className="chip grey">{t('Supplier')}</span>}<span className="show-sm"> {t('Out')} {count(p.out)} · {t('In')} {count(p.in)}</span></small></td>
                <td className="num opt-col money">{count(p.out)}</td>
                <td className="num opt-col money">{count(p.in)}</td>
                <td className={`num amt-col money b${p.balance > 0 ? ' due' : p.balance < 0 ? ' jama' : ''}`}>{signed(p.balance)}</td>
                <td className="num opt-col money">{p.valuePaise ? rupees(p.valuePaise) : ''}</td>
                <td className="opt-col muted">{shortDate(p.lastDay)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="empty">{q ? t('Kuch nahi mila') : t('Koi crate baaki nahi')}</p>}
      </div>
    </>
  )
}

function CrateRegister({ data, loading, period, setPeriod, onEdit }: {
  data: Register; loading: boolean; period: { key: string; from: string; to: string }; setPeriod: (p: { key: string; from: string; to: string }) => void; onEdit: (m: CrateMove) => void
}) {
  const [q, setQ] = useState('')
  const rows = data.moves.filter((m) => has(q, m.party, m.type, m.note, m.slipNo))
  const sum = (dir: 'out' | 'in') => rows.filter((m) => m.dir === dir).reduce((s, m) => s + m.qty, 0)
  useExport(() => ({
    style: 'book' as const, title: t('Crate Register'), dateLine: dayRange(period.from, period.to), file: fileName('Crate Register', period.from, period.to),
    columns: [{ label: t('Tarikh') }, { label: t('Party'), wide: true }, { label: t('Crate') }, { label: t('Parchi') }, { label: t('Out'), num: true }, { label: t('In'), num: true }, { label: t('Note') }],
    rows: rows.map((m) => ({ cells: [shortDate(m.day), m.party, m.type, m.slipNo ? `#${m.slipNo}` : '', m.dir === 'out' ? count(m.qty) : '', m.dir === 'in' ? count(m.qty) : '', m.note] })),
    foot: ['', t('Kul'), '', '', count(sum('out')), count(sum('in')), ''],
  }), [data, q])
  return (
    <>
      <div className="toolbar">
        <PeriodBar value={period} onChange={setPeriod} />
        <input className="field search grow" data-search type="search" placeholder={t('Party, crate, parchi')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="card sum">
        <div><span className="lb">{t('Out')}</span><span className="v">{count(sum('out'))}</span></div>
        <div><span className="lb">{t('In')}</span><span className="v">{count(sum('in'))}</span></div>
        <div><span className="lb">{t('Entries')}</span><span className="v">{count(rows.length)}</span></div>
      </div>
      <div className={`card wrap-x${loading ? ' dim' : ''}`}>
        <table className="tbl fold">
          <thead><tr><th className="opt-col">{t('Tarikh')}</th><th>{t('Party')}</th><th className="opt-col">{t('Crate')}</th><th className="opt-col">{t('Parchi')}</th><th className="num">{t('Out')}</th><th className="num">{t('In')}</th><th className="opt-col">{t('Note')}</th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} data-row tabIndex={0} onClick={() => onEdit(m)} onKeyDown={(e) => { if (e.key === 'Enter') onEdit(m) }}>
                <td className="opt-col muted">{shortDate(m.day)}</td>
                <td className="main-col"><b className="name">{m.party}</b><small><span className="show-sm">{shortDate(m.day)} · {m.type}{m.slipNo ? ` · #${m.slipNo}` : ''}{m.note ? ` · ${m.note}` : ''}</span></small></td>
                <td className="opt-col">{m.type}</td>
                <td className="opt-col money">{m.slipNo ? `#${m.slipNo}` : ''}</td>
                <td className="num money due">{m.dir === 'out' ? count(m.qty) : ''}</td>
                <td className="num money jama">{m.dir === 'in' ? count(m.qty) : ''}</td>
                <td className="opt-col muted">{m.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="empty">{q ? t('Kuch nahi mila') : t('Is samay koi entry nahi')}</p>}
      </div>
    </>
  )
}

function CrateTypes({ data, loading, onEdit }: { data: Register; loading: boolean; onEdit: (c: CrateType) => void }) {
  useExport(() => ({
    style: 'book' as const, title: t('Crate'), file: fileName('Crate types'),
    columns: [{ label: t('Crate'), wide: true }, { label: t('Jama/crate'), num: true }, { label: t('Out'), num: true }, { label: t('In'), num: true }, { label: t('Baaki'), num: true }],
    rows: data.types.map((c) => ({ cells: [c.name + (c.hidden ? ` (${t('Chhupa hua')})` : ''), rs(c.depositPaise), count(c.out), count(c.in), signed(c.balance)] })),
  }), [data])
  return (
    <div className={`card wrap-x${loading ? ' dim' : ''}`}>
      <table className="tbl fold">
        <thead><tr><th>{t('Crate')}</th><th className="num">{t('Jama/crate')}</th><th className="num opt-col">{t('Out')}</th><th className="num opt-col">{t('In')}</th><th className="num">{t('Baaki')}</th></tr></thead>
        <tbody>
          {data.types.map((c) => (
            <tr key={c.id} data-row tabIndex={0} className={c.hidden ? 'void' : undefined} onClick={() => onEdit(c)} onKeyDown={(e) => { if (e.key === 'Enter') onEdit(c) }}>
              <td className="main-col"><b className="name">{c.name}</b><small>{c.hidden ? t('Chhupa hua') : ''}</small></td>
              <td className="num money">{rupees(c.depositPaise)}</td>
              <td className="num opt-col money">{count(c.out)}</td>
              <td className="num opt-col money">{count(c.in)}</td>
              <td className="num amt-col money b">{signed(c.balance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.types.length === 0 && <p className="empty">{t('Abhi koi crate nahi')}</p>}
    </div>
  )
}

/** One party's crates: every entry with the running baaki. */
function CrateKhata({ shopId, party, onBack, onNew, onEdit }: {
  shopId: string; party: PartyRef; onBack: () => void; onNew: (dir: 'out' | 'in', p: PartyRef) => void; onEdit: (m: CrateMove) => void
}) {
  const { data, error, loading } = useLoad(() => api<PartyKhata>(`/v1/admin/shops/${shopId}/crates/party?${partyUrl(party)}`), [shopId, party.buyerId, party.name])
  const me: PartyRef = { buyerId: party.buyerId, name: data?.name ?? party.name }
  useExport(data ? () => ({
    style: 'book' as const, title: `${t('Crate khata')} · ${data.name}`, file: fileName('Crate khata', data.name),
    columns: [{ label: t('Tarikh') }, { label: t('Vivaran'), wide: true }, { label: t('Out'), num: true }, { label: t('In'), num: true }, { label: t('Baaki'), num: true }],
    rows: [...data.lines].reverse().map((l) => ({ cells: [shortDate(l.day), [l.type, l.slipNo ? `#${l.slipNo}` : '', l.note].filter(Boolean).join(' · '), l.dir === 'out' ? count(l.qty) : '', l.dir === 'in' ? count(l.qty) : '', signed(l.balance)] })),
    foot: [t('Kul'), '', count(data.out), count(data.in), signed(data.balance)],
  }) : null, [data])
  return (
    <>
      <div className="toolbar">
        <button type="button" className="btn ghost" onClick={onBack}>‹ {t('Crates baaki')}</button>
        <span className="grow" />
        <span style={PAIR}>
          <button type="button" className="btn ghost" onClick={() => onNew('in', me)}>+ {t('Crate In')}</button>
          <button type="button" className="btn primary" onClick={() => onNew('out', me)}>+ {t('Crate Out')}</button>
        </span>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Party')}</span><span className="v">{party.buyerId ? <a href={href({ page: 'grahak', shopId, buyerId: party.buyerId })}>{data.name}</a> : data.name}</span></div>
            <div><span className="lb">{t('Crates baaki')}</span><span className={`v${data.balance > 0 ? ' due' : ''}`}>{signed(data.balance)}</span>
              <small>{data.byType.filter((x) => x.balance).map((x) => `${x.name} ${signed(x.balance)}`).join(' · ')}</small></div>
            <div><span className="lb">{t('Out')} · {t('In')}</span><span className="v">{count(data.out)} · {count(data.in)}</span></div>
            <div><span className="lb">{t('Value')}</span><span className="v">{rupees(data.valuePaise)}</span></div>
          </div>
          <div className={`card wrap-x${loading ? ' dim' : ''}`}>
            <table className="tbl fold">
              <thead><tr><th className="opt-col">{t('Tarikh')}</th><th>{t('Vivaran')}</th><th className="num">{t('Out')}</th><th className="num">{t('In')}</th><th className="num">{t('Baaki')}</th></tr></thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.id} data-row tabIndex={0} onClick={() => onEdit(l)} onKeyDown={(e) => { if (e.key === 'Enter') onEdit(l) }}>
                    <td className="opt-col muted">{shortDate(l.day)}</td>
                    <td className="main-col"><b>{l.type}</b><small><span className="show-sm">{shortDate(l.day)} · </span>{[l.slipNo ? `${t('Parchi')} #${l.slipNo}` : '', l.note].filter(Boolean).join(' · ')}</small></td>
                    <td className="num money due">{l.dir === 'out' ? count(l.qty) : ''}</td>
                    <td className="num money jama">{l.dir === 'in' ? count(l.qty) : ''}</td>
                    <td className="num amt-col money b">{signed(l.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.lines.length === 0 && <p className="empty">{t('Koi entry nahi')}</p>}
          </div>
        </>
      )}
    </>
  )
}

function CrateSheet({ shopId, draft, types, suppliers, onClose }: { shopId: string; draft: CrateDraft; types: CrateType[]; suppliers: string[]; onClose: () => void }) {
  const caps = useCaps(shopId)
  const m = draft.move
  const start = m ? { buyerId: m.buyerId, name: m.party } : draft.party
  const [dir, setDir] = useState<'out' | 'in'>(m?.dir ?? draft.dir)
  const [who, setWho] = useState<'grahak' | 'supplier'>(start && !start.buyerId ? 'supplier' : 'grahak')
  const [buyer, setBuyer] = useState<PickedBuyer | null>(start?.buyerId ? { id: start.buyerId, name: start.name } : null)
  const [supplier, setSupplier] = useState(start && !start.buyerId ? start.name : '')
  const live = types.filter((x) => !x.hidden || x.id === m?.typeId)
  const [typeId, setTypeId] = useState(m?.typeId ?? live[0]?.id ?? '')
  const [qty, setQty] = useState(m ? String(m.qty) : '')
  const [day, setDay] = useState(m?.day ?? todayIst())
  const [slip, setSlip] = useState(m?.slipNo ? String(m.slipNo) : '')
  const [note, setNote] = useState(m?.note ?? '')
  const { saving, error, setError, run } = useSaver(onClose)
  // A grahak picked by name from the khata arrives without one: fill it in.
  useEffect(() => {
    if (!start?.buyerId || start.name) return
    api<{ name: string }>(`/v1/admin/shops/${shopId}/crates/party?buyerId=${start.buyerId}`).then((r) => setBuyer({ id: start.buyerId, name: r.name })).catch(() => {})
  }, [shopId, start?.buyerId, start?.name])
  const save = () => {
    const n = Number(qty)
    const slipNo = slip.trim() ? Number(slip) : null
    const party = who === 'grahak' ? { buyerId: buyer?.id ?? null } : { buyerId: null, party: supplier.trim() }
    // Top to bottom, as the form reads.
    if (!party.buyerId && !('party' in party && party.party) && !slipNo) return setError(t('Party chunein'))
    if (!typeId) return setError(t('Crate chunein'))
    if (!Number.isInteger(n) || n <= 0) return setError(t('Kitne crate, woh likhein'))
    if (day > todayIst()) return setError(t('Aage ki tarikh nahi chalegi'))
    if (slipNo !== null && (!Number.isInteger(slipNo) || slipNo <= 0)) return setError(t('Parchi number sahi likhein'))
    const body = { day, dir, ...party, crateTypeId: typeId, qty: n, slipNo, note }
    void run(() => api(`/v1/admin/shops/${shopId}/crates${m ? `/${m.id}` : ''}`, { method: 'POST', body }))
  }
  const remove = () => {
    if (!m || !confirm(t('Yeh entry hatayein?'))) return
    void run(() => api(`/v1/admin/shops/${shopId}/crates/${m.id}/delete`, { method: 'POST' }))
  }
  return (
    <Sheet title={m ? t('Crate entry badlein') : dir === 'out' ? t('Crate Out') : t('Crate In')} onClose={onClose} onSave={save} saving={saving} error={error}>
      <Seg value={dir} onChange={setDir} options={[{ key: 'out', label: t('Crate Out') }, { key: 'in', label: t('Crate In') }]} />
      <Field label={t('Party')}>
        <Seg value={who} onChange={setWho} options={[{ key: 'grahak', label: t('Grahak') }, { key: 'supplier', label: t('Supplier') }]} />
      </Field>
      {who === 'grahak'
        ? <BuyerPicker shopId={shopId} value={buyer} onChange={(b) => setBuyer(b?.id ? b : null)} autoFocus={!buyer} />
        : <>
          <input className="field" style={caps ? CAPS : undefined} list="crate-suppliers" maxLength={120} placeholder={t('Supplier ka naam')} value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          <datalist id="crate-suppliers">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>
        </>}
      <div className="row2">
        <Field label={t('Crate')}>
          <select className="field" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {live.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
        <Field label={t('Kitne crate')}><input className="field" inputMode="numeric" maxLength={6} value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} /></Field>
      </div>
      <div className="row2">
        <Field label={t('Tarikh')}><input className="field" type="date" max={todayIst()} value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        <Field label={t('Parchi no.')}><input className="field" inputMode="numeric" maxLength={7} value={slip} onChange={(e) => setSlip(e.target.value.replace(/\D/g, ''))} /></Field>
      </div>
      <Field label={t('Note')}><input className="field" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {m && <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} disabled={saving} onClick={remove}>{t('Hatayein')}</button>}
    </Sheet>
  )
}

function CrateTypeSheet({ shopId, c, onClose }: { shopId: string; c: CrateType | null; onClose: () => void }) {
  const caps = useCaps(shopId)
  const [name, setName] = useState(c?.name ?? '')
  const [deposit, setDeposit] = useState(c?.depositPaise ?? 0)
  const { saving, error, setError, run } = useSaver(onClose)
  const save = () => {
    if (!name.trim()) return setError(t('Naam daalein'))
    void run(() => api(`/v1/admin/shops/${shopId}/crate-types`, { method: 'POST', body: { ...(c ? { id: c.id } : {}), name, depositPaise: deposit } }))
  }
  const used = !!c && (c.out > 0 || c.in > 0)
  return (
    <Sheet title={c ? t('Crate badlein') : t('Naya crate')} onClose={onClose} onSave={save} saving={saving} error={error}>
      <div className="row2">
        <Field label={t('Naam')}><input className="field" style={caps ? CAPS : undefined} autoFocus maxLength={60} placeholder="PLASTIC CRATE" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('Jama/crate')}><Money value={deposit} onChange={setDeposit} /></Field>
      </div>
      {c && <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} disabled={saving}
        onClick={() => void run(() => api(`/v1/admin/shops/${shopId}/crate-types/${c.id}/delete`, { method: 'POST', body: { hidden: !c.hidden } }))}>
        {c.hidden ? t('Wapas dikhayein') : used ? t('Chhupayein') : t('Hatayein')}</button>}
    </Sheet>
  )
}

/** On a grahak's khata: their crates not back yet, when there are any. */
export function GrahakCrates({ shopId, buyerId }: { shopId: string; buyerId: string }) {
  const { data } = useLoad(() => api<PartyKhata>(`/v1/admin/shops/${shopId}/crates/party?buyerId=${buyerId}`), [shopId, buyerId])
  if (!data || data.balance === 0) return null
  return (
    <div>
      <span className="lb">{t('Crates baaki')}</span>
      <a className={`v${data.balance > 0 ? ' due' : ''}`} href={`${href({ page: 'report', shopId, report: 'crates' })}?party=g:${buyerId}`}>{signed(data.balance)}</a>
    </div>
  )
}

// ================================================================ Store Entry (cold store)

type StoreRow = { id: string; name: string; hidden: boolean; boxes: number; kg: number }
type StockRow = {
  storeId: string; store: string; truckId: string; number: string; supplier: string; closed: boolean; brandId: string; quality: string
  in: number; out: number; boxes: number; kg: number; rentPaise: number; first: string; last: string
}
type Lot = { truckId: string; number: string; supplier: string; brandId: string; quality: string; left: number; boxGrams: number }
type StoreStock = {
  stores: StoreRow[]; stock: StockRow[]; lots: Lot[]
  app: { id: string; day: string; truckId: string; number: string; quality: string; boxes: number; note: string }[]
  totals: { boxes: number; kg: number; lots: number; in: number; out: number; rentPaise: number; appBoxes: number }
}
type StoreMove = {
  id: string; day: string; dir: 'in' | 'out'; storeId: string; store: string; truckId: string; number: string; supplier: string; brandId: string; quality: string
  boxes: number; kg: number; rentPaise: number; note: string; by: string; voided: boolean; balance: number | null
}
type StoreMoves = { from: string; to: string; store: { id: string; name: string } | null; opening: number; lines: StoreMove[] }
type StoreDraft = { move?: StoreMove; dir: 'in' | 'out'; storeId?: string; truckId?: string; brandId?: string }

const lotName = (x: { number: string; supplier?: string; quality: string }) => [x.number, x.supplier, x.quality].filter(Boolean).join(' · ')
const kgText = (kg: number) => (kg ? kg.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '')

/** Boxes in each cold store by gaadi and quality, every in and out, and each store's khata. */
export function StoreEntry({ shopId }: { shopId: string }) {
  const [tab, setTab] = useState<'stock' | 'register' | 'khata'>(() => (hashQuery().get('store') ? 'khata' : 'stock'))
  const [storeId, setStoreIdState] = useState(() => hashQuery().get('store') ?? '')
  const [draft, setDraft] = useState<StoreDraft | null>(null)
  const { data, error, loading } = useLoad(() => api<StoreStock>(`/v1/admin/shops/${shopId}/store-stock`), [shopId])
  const setStoreId = (id: string) => {
    setStoreIdState(id)
    const q = Object.fromEntries(hashQuery())
    if (id) q.store = id; else delete q.store
    setHashQuery(q)
  }
  const openKhata = (id: string) => { setStoreId(id); setTab('khata') }
  const noStores = !!data && !data.stores.some((s) => !s.hidden)
  return (
    <>
      <div className="toolbar">
        <Seg value={tab} onChange={setTab} options={[{ key: 'stock', label: t('Stock') }, { key: 'register', label: t('Register') }, { key: 'khata', label: t('Store khata') }]} />
        <span className="grow" />
        {!noStores && <span style={PAIR}>
          <button type="button" className="btn ghost" onClick={() => setDraft({ dir: 'out', storeId: storeId || undefined })}>+ {t('Store Out')}</button>
          <button type="button" className="btn primary" onClick={() => setDraft({ dir: 'in', storeId: storeId || undefined })}>+ {t('Store In')}</button>
        </span>}
      </div>
      {error && <p className="error">{error}</p>}
      {noStores && <p className="empty card"><a href={href({ page: 'report', shopId, report: 'stores' })}>+ {t('Store Master')}</a></p>}
      {!data ? <Skeleton /> : tab === 'stock' ? <StoreStockView data={data} loading={loading} onKhata={openKhata} onOut={(r) => setDraft({ dir: 'out', storeId: r.storeId, truckId: r.truckId, brandId: r.brandId })} />
        : tab === 'register' ? <StoreRegister shopId={shopId} onEdit={(m) => setDraft({ move: m, dir: m.dir })} />
          : <StoreKhata shopId={shopId} stores={data.stores} storeId={storeId || data.stores[0]?.id || ''} onStore={setStoreId} onEdit={(m) => setDraft({ move: m, dir: m.dir })} />}
      {draft && data && <StoreSheet shopId={shopId} draft={draft} data={data} onClose={() => setDraft(null)} />}
    </>
  )
}

function StoreStockView({ data, loading, onKhata, onOut }: { data: StoreStock; loading: boolean; onKhata: (storeId: string) => void; onOut: (r: StockRow) => void }) {
  const [q, setQ] = useState('')
  const [all, setAll] = useState<'baaki' | 'sab'>('baaki')
  const rows = data.stock.filter((r) => (all === 'sab' || r.boxes !== 0) && has(q, r.store, r.number, r.supplier, r.quality))
  const tot = data.totals
  useExport(() => ({
    style: 'book' as const, title: t('Store Stock'), file: fileName('Store Stock'),
    columns: [{ label: t('Store') }, { label: t('Gaadi'), wide: true }, { label: t('Maal') }, { label: t('In'), num: true }, { label: t('Out'), num: true }, { label: t('Box'), num: true }, { label: 'Kg', num: true }, { label: t('Kiraya'), num: true }],
    rows: rows.map((r) => ({ cells: [r.store, [r.number, r.supplier].filter(Boolean).join(' · '), r.quality, count(r.in), count(r.out), count(r.boxes), kgText(r.kg), rs(r.rentPaise)] })),
    foot: [t('Kul'), '', '', count(rows.reduce((s, r) => s + r.in, 0)), count(rows.reduce((s, r) => s + r.out, 0)), count(rows.reduce((s, r) => s + r.boxes, 0)),
      kgText(rows.reduce((s, r) => s + r.kg, 0)), rs(rows.reduce((s, r) => s + r.rentPaise, 0))],
  }), [data, q, all])
  return (
    <>
      <div className="card sum">
        <div><span className="lb">{t('Store mein box')}</span><span className="v">{count(tot.boxes)}</span><small>{kgText(tot.kg)} kg</small></div>
        {data.stores.filter((s) => s.boxes || !s.hidden).map((s) => (
          <div key={s.id}><span className="lb">{s.name}</span><button type="button" className="v" style={LINK} onClick={() => onKhata(s.id)}>{count(s.boxes)}</button></div>
        ))}
        <div><span className="lb">{t('Kiraya')}</span><span className="v">{rupees(tot.rentPaise)}</span></div>
      </div>
      <div className="toolbar">
        <input className="field search grow" data-search type="search" placeholder={t('Store, gaadi ya maal')} value={q} onChange={(e) => setQ(e.target.value)} />
        <Seg value={all} onChange={setAll} options={[{ key: 'baaki', label: t('Baaki') }, { key: 'sab', label: `${t('Sab')} (${count(data.stock.length)})` }]} />
      </div>
      <div className={`card wrap-x${loading ? ' dim' : ''}`}>
        <table className="tbl fold">
          <thead><tr><th className="opt-col">{t('Store')}</th><th>{t('Gaadi')}</th><th className="opt-col">{t('Maal')}</th><th className="num opt-col">{t('In')}</th><th className="num opt-col">{t('Out')}</th><th className="num">{t('Box')}</th><th className="num opt-col">Kg</th><th className="opt-col" /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.storeId}:${r.truckId}:${r.brandId}`} data-row tabIndex={0} onClick={() => onKhata(r.storeId)} onKeyDown={(e) => { if (e.key === 'Enter') onKhata(r.storeId) }}>
                <td className="opt-col">{r.store}</td>
                <td className="main-col"><b className="name">{r.number}</b><small>{r.supplier}{r.closed ? <span className="chip grey">{t('Band')}</span> : ''}<span className="show-sm"> · {r.store} · {r.quality}</span></small></td>
                <td className="opt-col">{r.quality}</td>
                <td className="num opt-col money">{count(r.in)}</td>
                <td className="num opt-col money">{count(r.out)}</td>
                <td className="num amt-col money b">{signed(r.boxes)}</td>
                <td className="num opt-col money">{kgText(r.kg)}</td>
                <td className="opt-col act-col">{r.boxes > 0 && <button type="button" className="btn act" onClick={(e) => { e.stopPropagation(); onOut(r) }}>{t('Nikalein')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="empty">{q ? t('Kuch nahi mila') : t('Store mein koi maal nahi')}</p>}
      </div>
      {data.app.length > 0 && (
        <div className="card wrap-x" style={{ marginTop: 12 }}>
          <table className="tbl fold">
            <thead><tr><th className="opt-col">{t('Tarikh')}</th><th>{t('App se store')} · {count(tot.appBoxes)} {t('box')}</th><th className="opt-col">{t('Maal')}</th><th className="num">{t('Box')}</th><th className="opt-col">{t('Note')}</th></tr></thead>
            <tbody>
              {data.app.map((a) => (
                <tr key={a.id}>
                  <td className="opt-col muted">{shortDate(a.day)}</td>
                  <td className="main-col"><b>{a.number}</b><small><span className="chip grey">{t('App se store')}</span><span className="show-sm"> {shortDate(a.day)} · {a.quality}{a.note ? ` · ${a.note}` : ''}</span></small></td>
                  <td className="opt-col">{a.quality}</td>
                  <td className="num money">{count(a.boxes)}</td>
                  <td className="opt-col muted">{a.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function MoveRows({ lines, onEdit, withStore, opening }: { lines: StoreMove[]; onEdit: (m: StoreMove) => void; withStore: boolean; opening?: number }) {
  return (
    <table className="tbl fold">
      <thead><tr><th className="opt-col">{t('Tarikh')}</th><th>{t('Gaadi')}</th>{withStore && <th className="opt-col">{t('Store')}</th>}<th className="opt-col">{t('Maal')}</th>
        <th className="num">{t('In')}</th><th className="num">{t('Out')}</th><th className="num opt-col">Kg</th><th className="num opt-col">{t('Kiraya')}</th>{!withStore && <th className="num">{t('Baaki')}</th>}</tr></thead>
      <tbody>
        {opening !== undefined && (
          <tr className="open-lines"><td className="opt-col" /><td className="main-col">{t('Pichhla stock')}</td><td className="opt-col" /><td /><td /><td className="opt-col" /><td className="opt-col" /><td className="num money b">{signed(opening)}</td></tr>
        )}
        {lines.map((m) => (
          <tr key={m.id} data-row tabIndex={0} className={m.voided ? 'void' : undefined} onClick={() => { if (!m.voided) onEdit(m) }} onKeyDown={(e) => { if (e.key === 'Enter' && !m.voided) onEdit(m) }}>
            <td className="opt-col muted">{shortDate(m.day)}</td>
            <td className="main-col"><b className="name">{m.number}</b><small>{m.voided ? <span className="chip grey">{t('Hatayi gayi')}</span> : ''}{m.supplier}
              <span className="show-sm"> · {shortDate(m.day)}{withStore ? ` · ${m.store}` : ''} · {m.quality}</span>{m.note ? ` · ${m.note}` : ''}</small></td>
            {withStore && <td className="opt-col">{m.store}</td>}
            <td className="opt-col">{m.quality}</td>
            <td className="num money">{m.dir === 'in' ? count(m.boxes) : ''}</td>
            <td className="num money">{m.dir === 'out' ? count(m.boxes) : ''}</td>
            <td className="num opt-col money">{kgText(m.kg)}</td>
            <td className="num opt-col money">{m.rentPaise ? rupees(m.rentPaise * m.boxes) : ''}</td>
            {!withStore && <td className="num amt-col money b">{m.balance === null ? '' : signed(m.balance)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const moveCells = (m: StoreMove, withStore: boolean) => [shortDate(m.day), [m.number, m.supplier].filter(Boolean).join(' · ') + (m.voided ? ` (${t('Hatayi gayi')})` : ''),
  ...(withStore ? [m.store] : []), m.quality, m.dir === 'in' ? count(m.boxes) : '', m.dir === 'out' ? count(m.boxes) : '', kgText(m.kg), m.rentPaise ? rs(m.rentPaise * m.boxes) : '', m.note]

function StoreRegister({ shopId, onEdit }: { shopId: string; onEdit: (m: StoreMove) => void }) {
  const [period, setPeriod] = usePeriod('30')
  const [q, setQ] = useState('')
  const { data, error, loading } = useLoad(() => api<StoreMoves>(`/v1/admin/shops/${shopId}/store-moves?from=${period.from}&to=${period.to}`), [shopId, period.from, period.to])
  const rows = (data?.lines ?? []).filter((m) => has(q, m.store, m.number, m.supplier, m.quality, m.note))
  const live = rows.filter((m) => !m.voided)
  const sum = (dir: 'in' | 'out') => live.filter((m) => m.dir === dir).reduce((s, m) => s + m.boxes, 0)
  useExport(data ? () => ({
    style: 'book' as const, title: t('Store Register'), dateLine: dayRange(period.from, period.to), file: fileName('Store Register', period.from, period.to),
    columns: [{ label: t('Tarikh') }, { label: t('Gaadi'), wide: true }, { label: t('Store') }, { label: t('Maal') }, { label: t('In'), num: true }, { label: t('Out'), num: true }, { label: 'Kg', num: true }, { label: t('Kiraya'), num: true }, { label: t('Note') }],
    rows: rows.map((m) => ({ cells: moveCells(m, true), strike: m.voided })),
    foot: [t('Kul'), '', '', '', count(sum('in')), count(sum('out')), '', '', ''],
  }) : null, [data, q])
  return (
    <>
      <div className="toolbar">
        <PeriodBar value={period} onChange={setPeriod} />
        <input className="field search grow" data-search type="search" placeholder={t('Store, gaadi ya maal')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Store In')}</span><span className="v">{count(sum('in'))}</span></div>
            <div><span className="lb">{t('Store Out')}</span><span className="v">{count(sum('out'))}</span></div>
            <div><span className="lb">{t('Kiraya')}</span><span className="v">{rupees(live.filter((m) => m.dir === 'in').reduce((s, m) => s + m.rentPaise * m.boxes, 0))}</span></div>
          </div>
          <div className={`card wrap-x${loading ? ' dim' : ''}`}>
            <MoveRows lines={rows} onEdit={onEdit} withStore />
            {rows.length === 0 && <p className="empty">{q ? t('Kuch nahi mila') : t('Is samay koi entry nahi')}</p>}
          </div>
        </>
      )}
    </>
  )
}

function StoreKhata({ shopId, stores, storeId, onStore, onEdit }: { shopId: string; stores: StoreRow[]; storeId: string; onStore: (id: string) => void; onEdit: (m: StoreMove) => void }) {
  const [period, setPeriod] = usePeriod('30')
  const { data, error, loading } = useLoad(() => (storeId
    ? api<StoreMoves>(`/v1/admin/shops/${shopId}/store-moves?from=${period.from}&to=${period.to}&store=${storeId}`)
    : Promise.resolve(null)), [shopId, storeId, period.from, period.to])
  const live = (data?.lines ?? []).filter((m) => !m.voided)
  const sum = (dir: 'in' | 'out') => live.filter((m) => m.dir === dir).reduce((s, m) => s + m.boxes, 0)
  const closing = (data?.opening ?? 0) + sum('in') - sum('out')
  useExport(data?.store ? () => ({
    style: 'book' as const, title: `${t('Store khata')} · ${data.store!.name}`, dateLine: dayRange(period.from, period.to), file: fileName('Store khata', data.store!.name, period.from, period.to),
    columns: [{ label: t('Tarikh') }, { label: t('Gaadi'), wide: true }, { label: t('Maal') }, { label: t('In'), num: true }, { label: t('Out'), num: true }, { label: 'Kg', num: true }, { label: t('Kiraya'), num: true }, { label: t('Note') }, { label: t('Baaki'), num: true }],
    rows: [{ cells: ['', t('Pichhla stock'), '', '', '', '', '', '', signed(data.opening)] },
      ...data.lines.map((m) => ({ cells: [...moveCells(m, false), m.balance === null ? '' : signed(m.balance)], strike: m.voided }))],
    foot: [t('Kul'), '', '', count(sum('in')), count(sum('out')), '', '', '', signed(closing)],
  }) : null, [data])
  return (
    <>
      <div className="toolbar">
        <select className="field" aria-label={t('Store')} style={{ flex: '0 1 220px' }} value={storeId} onChange={(e) => onStore(e.target.value)}>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.hidden ? ` (${t('Chhupa hua')})` : ''}</option>)}
        </select>
        <PeriodBar value={period} onChange={setPeriod} />
      </div>
      {error && <p className="error">{error}</p>}
      {!storeId ? null : !data ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Pichhla stock')}</span><span className="v">{signed(data.opening)}</span></div>
            <div><span className="lb">{t('In')}</span><span className="v">{count(sum('in'))}</span></div>
            <div><span className="lb">{t('Out')}</span><span className="v">{count(sum('out'))}</span></div>
            <div><span className="lb">{t('Baaki')}</span><span className="v">{signed(closing)}</span></div>
          </div>
          <div className={`card wrap-x${loading ? ' dim' : ''}`}>
            <MoveRows lines={data.lines} onEdit={onEdit} withStore={false} opening={data.opening} />
            {data.lines.length === 0 && <p className="empty">{t('Is samay koi entry nahi')}</p>}
          </div>
        </>
      )}
    </>
  )
}

function StoreSheet({ shopId, draft, data, onClose }: { shopId: string; draft: StoreDraft; data: StoreStock; onClose: () => void }) {
  const m = draft.move
  const [dir, setDir] = useState<'in' | 'out'>(m?.dir ?? draft.dir)
  // A hidden store takes nothing in, but what it still holds can come out.
  const stores = data.stores.filter((s) => !s.hidden || s.id === m?.storeId || (dir === 'out' && s.boxes > 0))
  const [storeId, setStoreId] = useState(m?.storeId ?? draft.storeId ?? stores[0]?.id ?? '')
  const [lotKey, setLotKey] = useState(m ? `${m.truckId}:${m.brandId}` : draft.truckId ? `${draft.truckId}:${draft.brandId}` : '')
  const [boxes, setBoxes] = useState(m ? String(m.boxes) : '')
  const [kg, setKg] = useState<string | null>(m ? String(m.kg) : null)
  const [rent, setRent] = useState(m?.rentPaise ?? 0)
  const [day, setDay] = useState(m?.day ?? todayIst())
  const [note, setNote] = useState(m?.note ?? '')
  const { saving, error, setError, run } = useSaver(onClose)

  // In: the open gaadis' qualities, with what is left on each. Out: what this store holds.
  type Opt = { key: string; truckId: string; brandId: string; label: string; boxGrams: number; max: number; none?: boolean }
  const grams = new Map(data.lots.map((l) => [`${l.truckId}:${l.brandId}`, l.boxGrams]))
  // In: lots with boxes left first; one with none left is listed (nothing hidden) but can't be picked.
  const opts: Opt[] = dir === 'in'
    ? [...data.lots].sort((a, b) => Number(b.left > 0) - Number(a.left > 0)).map((l) => ({ key: `${l.truckId}:${l.brandId}`, truckId: l.truckId, brandId: l.brandId,
      label: `${lotName(l)} — ${signed(l.left)} ${t('baaki')}`, boxGrams: l.boxGrams, max: l.left, none: l.left <= 0 && !(m && `${m.truckId}:${m.brandId}` === `${l.truckId}:${l.brandId}`) }))
    : data.stock.filter((r) => r.storeId === storeId && r.boxes > 0).map((r) => ({ key: `${r.truckId}:${r.brandId}`, truckId: r.truckId, brandId: r.brandId,
      label: `${lotName(r)} — ${count(r.boxes)} ${t('store mein')}`, boxGrams: grams.get(`${r.truckId}:${r.brandId}`) ?? (r.in ? Math.round((r.kg * 1000) / Math.max(1, r.boxes)) : 0), max: r.boxes }))
  if (m && !opts.some((o) => o.key === lotKey)) opts.unshift({ key: lotKey, truckId: m.truckId, brandId: m.brandId, label: lotName(m), boxGrams: grams.get(lotKey) ?? 0, max: Infinity })
  const lot = opts.find((o) => o.key === lotKey) ?? null
  const n = Number(boxes) || 0
  const autoKg = lot?.boxGrams ? (n * lot.boxGrams) / 1000 : 0
  useEffect(() => { if (!opts.some((o) => o.key === lotKey && !o.none)) setLotKey(opts.find((o) => !o.none)?.key ?? '') }, [dir, storeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => {
    if (!storeId) return setError(t('Store chunein'))
    if (!lot || lot.none) return setError(t('Gaadi ka maal chunein'))
    if (!Number.isInteger(n) || n <= 0) return setError(t('Kitne box, woh likhein'))
    // A new entry can't take more than is there; an edit is checked by the server (it gives back its own boxes first).
    if (!m && n > lot.max) return setError(dir === 'in' ? t('Gaadi par sirf {n} box baaki', { n: count(Math.max(0, lot.max)) }) : t('Store mein sirf {n} box hain', { n: count(lot.max) }))
    if (day > todayIst()) return setError(t('Aage ki tarikh nahi chalegi'))
    const kgNum = kg === null || kg.trim() === '' ? null : Number(kg)
    if (kgNum !== null && !(kgNum >= 0)) return setError(t('Kg sahi likhein'))
    const body = { day, dir, storeId, truckId: lot.truckId, brandId: lot.brandId, boxes: n, kg: kgNum, rentPaise: dir === 'in' ? rent : 0, note }
    void run(() => api(`/v1/admin/shops/${shopId}/store-moves${m ? `/${m.id}` : ''}`, { method: 'POST', body }))
  }
  const remove = () => {
    if (!m || !confirm(t('Yeh entry hatayein?'))) return
    void run(() => api(`/v1/admin/shops/${shopId}/store-moves/${m.id}/delete`, { method: 'POST' }))
  }
  return (
    <Sheet title={m ? t('Store entry badlein') : dir === 'in' ? t('Store In') : t('Store Out')} onClose={onClose} onSave={save} saving={saving} error={error}>
      <Seg value={dir} onChange={setDir} options={[{ key: 'in', label: t('Store In') }, { key: 'out', label: t('Store Out') }]} />
      <div className="row2">
        <Field label={t('Store')}>
          <select className="field" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label={t('Tarikh')}><input className="field" type="date" max={todayIst()} value={day} onChange={(e) => setDay(e.target.value)} /></Field>
      </div>
      <Field label={t('Gaadi · maal')}>
        <select className="field" value={lotKey} onChange={(e) => setLotKey(e.target.value)}>
          {!opts.some((o) => !o.none) && <option value="">{dir === 'in' ? t('Koi khuli gaadi nahi') : t('Is store mein koi maal nahi')}</option>}
          {opts.map((o) => <option key={o.key} value={o.key} disabled={o.none}>{o.label}</option>)}
        </select>
      </Field>
      <div className="row2">
        <Field label={t('Box')}><input className="field" inputMode="numeric" autoFocus maxLength={6} value={boxes} onChange={(e) => setBoxes(e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="Kg"><input className="field" inputMode="decimal" maxLength={10} placeholder={autoKg ? kgText(autoKg) : '0'} value={kg ?? ''}
          onChange={(e) => setKg(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
      </div>
      {dir === 'in' && <Field label={t('Kiraya / box')}><Money value={rent} onChange={setRent} /></Field>}
      <Field label={t('Note')}><input className="field" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {m && <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} disabled={saving} onClick={remove}>{t('Hatayein')}</button>}
    </Sheet>
  )
}
