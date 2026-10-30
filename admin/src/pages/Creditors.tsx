import { useState } from 'react'
import { api } from '../api'
import { count, phone as fmtPhone, rupees, shortDate, todayIst } from '../format'
import { t } from '../i18n'
import { href } from '../routes'
import { booksChanged, useLoad } from '../useLoad'
import { Skeleton } from '../ui'
import { fileName, rs, useExport } from '../export/doc'
import { openDraft } from '../entries/kinds'
import { Field, Money, Sheet } from '../entries/fields'
import { AreaDatalist } from './Masters'

// ================================================================ Supplier creditors (April–March)

type Creditor = {
  key: string; id: string | null; name: string; code: string; area: string; phone: string
  masterOpeningPaise: number; masterOpeningOn: string | null
  openingPaise: number; creditPaise: number; paidPaise: number; balancePaise: number; beejaks: number
}
type Creditors = { fy: number; label: string; from: string; to: string; rows: Creditor[]; totals: { openingPaise: number; creditPaise: number; paidPaise: number; balancePaise: number } }
type Khata = {
  key: string; name: string; fy: number; label: string; from: string; to: string; openingPaise: number; closingPaise: number; years: number[]
  master: { id: string; name: string; phone: string; code: string; area: string; opening: number; openingOn: string | null } | null
  lines: { id: string; date: string; kind: 'opening' | 'beejak' | 'payment'; title: string; detail: string; creditPaise: number; debitPaise: number; balancePaise: number }[]
}

const fyNow = () => { const [y, m] = todayIst().split('-').map(Number); return m >= 4 ? y : y - 1 }
const fyLabel = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`
/** A balance with its side: what the shop owes (dena) or is owed (lena). */
const owed = (p: number) => (p < 0 ? <span className="jama">{rupees(-p)} {t('lena')}</span> : <span>{rupees(p)}</span>)

function FyStep({ fy, onChange }: { fy: number; onChange: (y: number) => void }) {
  return (
    <div className="stepper">
      <button type="button" aria-label={t('Pichhla')} onClick={() => onChange(fy - 1)}>‹</button>
      <label>{fyLabel(fy)}</label>
      <button type="button" aria-label={t('Agla')} disabled={fy >= fyNow()} onClick={() => onChange(fy + 1)}>›</button>
    </div>
  )
}

/** What the shop owes each supplier this financial year: carried opening, beejaks, paid, balance. */
export function Creditors({ shopId }: { shopId: string }) {
  const [fy, setFy] = useState(fyNow)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [edit, setEdit] = useState<Creditor | 'new' | null>(null)
  const { data, error, loading } = useLoad(() => api<Creditors>(`/v1/admin/shops/${shopId}/creditors?fy=${fy}`), [shopId, fy])
  const f = q.trim().toLowerCase()
  const rows = (data?.rows ?? []).filter((r) => !f || r.name.toLowerCase().includes(f) || r.code.toLowerCase().includes(f) || r.area.toLowerCase().includes(f))

  useExport(data && !open ? () => ({
    style: 'book' as const, title: `${t('Supplier creditors')} ${data.label}`, file: fileName('Supplier creditors', data.label),
    columns: [{ label: t('Code') }, { label: t('Supplier'), wide: true }, { label: t('Area') }, { label: t('Opening'), num: true }, { label: t('Beejak'), num: true }, { label: t('Diya'), num: true }, { label: t('Baaki'), num: true }],
    rows: rows.map((r) => ({ cells: [r.code, r.name, r.area, rs(r.openingPaise), rs(r.creditPaise), rs(r.paidPaise), rs(r.balancePaise)] })),
    foot: ['', t('Kul'), '', rs(data.totals.openingPaise), rs(data.totals.creditPaise), rs(data.totals.paidPaise), rs(data.totals.balancePaise)],
  }) : null, [data, q, open])

  if (open) return <CreditorKhata shopId={shopId} k={open} fy={fy} onFy={setFy} onBack={() => setOpen(null)} onEdit={(c) => setEdit(c)} edit={edit} onEdited={() => setEdit(null)} />

  return (
    <>
      <div className="toolbar">
        <FyStep fy={fy} onChange={setFy} />
        <input className="field search grow" data-search placeholder={t('Naam, code ya area')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn primary" onClick={() => setEdit('new')}>+ {t('Supplier')}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Opening')}</span><span className="v">{rupees(data.totals.openingPaise)}</span></div>
            <div><span className="lb">{t('Beejak')}</span><span className="v">{rupees(data.totals.creditPaise)}</span></div>
            <div><span className="lb">{t('Diya')}</span><span className="v">{rupees(data.totals.paidPaise)}</span></div>
            <div><span className="lb">{t('Baaki (dena)')}</span><span className="v due">{rupees(data.totals.balancePaise)}</span></div>
          </div>
          <div className={`card wrap-x${loading ? ' dim' : ''}`}>
            <table className="tbl fold">
              <thead><tr><th className="opt-col">{t('Code')}</th><th>{t('Supplier')}</th><th className="opt-col">{t('Area')}</th><th className="num">{t('Opening')}</th><th className="num">{t('Beejak')}</th><th className="num">{t('Diya')}</th><th className="num">{t('Baaki')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} data-row tabIndex={0} onClick={() => setOpen(r.key)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(r.key) }}>
                    <td className="opt-col">{r.code}</td>
                    <td className="main-col"><b>{r.name}</b><small><span className="show-sm">{[r.code, r.area].filter(Boolean).join(' · ')}</span></small></td>
                    <td className="opt-col">{r.area}</td>
                    <td className="num opt-col money">{rupees(r.openingPaise)}</td>
                    <td className="num opt-col money">{rupees(r.creditPaise)}</td>
                    <td className="num opt-col money">{rupees(r.paidPaise)}</td>
                    <td className="num amt-col"><span className={`money b${r.balancePaise > 0 ? ' due' : ''}`}>{owed(r.balancePaise)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="empty">{q ? t('Koi supplier nahi mila') : t('Abhi koi supplier nahi')}</p>}
          </div>
        </>
      )}
      {edit && <SupplierSheet shopId={shopId} c={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  )
}

function CreditorKhata({ shopId, k, fy, onFy, onBack, onEdit, edit, onEdited }: {
  shopId: string; k: string; fy: number; onFy: (y: number) => void; onBack: () => void; onEdit: (c: Creditor) => void; edit: Creditor | 'new' | null; onEdited: () => void
}) {
  const { data, error, loading } = useLoad(() => api<Khata>(`/v1/admin/shops/${shopId}/creditors/${encodeURIComponent(k)}?fy=${fy}`), [shopId, k, fy])
  useExport(data ? () => ({
    style: 'book' as const, title: `${data.name} · ${data.label}`, file: fileName(data.name, data.label),
    columns: [{ label: t('Tarikh') }, { label: t('Vivaran'), wide: true }, { label: t('Jama (dena)'), num: true }, { label: t('Diya'), num: true }, { label: t('Baaki'), num: true }],
    rows: [{ cells: [shortDate(data.from), t('Pichhle saal se'), '', '', rs(data.openingPaise)] },
      ...data.lines.map((l) => ({ cells: [shortDate(l.date), [l.title, l.detail].filter(Boolean).join(' · '), l.creditPaise ? rs(l.creditPaise) : '', l.debitPaise ? rs(l.debitPaise) : '', rs(l.balancePaise)] }))],
    foot: [t('Closing'), '', '', '', rs(data.closingPaise)],
  }) : null, [data])
  const m = data?.master
  return (
    <>
      <div className="toolbar">
        <button type="button" className="btn ghost" onClick={onBack}>‹ {t('Supplier creditors')}</button>
        <FyStep fy={fy} onChange={onFy} />
        <span className="grow" />
        {data && <button type="button" className="btn" onClick={() => onEdit({ key: data.key, id: m?.id ?? null, name: data.name, code: m?.code ?? '', area: m?.area ?? '', phone: m?.phone ?? '',
          masterOpeningPaise: m?.opening ?? 0, masterOpeningOn: m?.openingOn ?? null, openingPaise: 0, creditPaise: 0, paidPaise: 0, balancePaise: 0, beejaks: 0 })}>{t('Badlein')}</button>}
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Supplier')}</span><span className="v">{data.name}</span><small>{[m?.code, m?.area, m?.phone ? fmtPhone(m.phone) : ''].filter(Boolean).join(' · ')}</small></div>
            <div><span className="lb">{t('Pichhle saal se')}</span><span className="v">{owed(data.openingPaise)}</span></div>
            <div><span className="lb">{t('Closing')}</span><span className={`v${data.closingPaise > 0 ? ' due' : ''}`}>{owed(data.closingPaise)}</span></div>
          </div>
          <div className={`card wrap-x${loading ? ' dim' : ''}`}>
            <table className="tbl fold">
              <thead><tr><th className="opt-col">{t('Tarikh')}</th><th>{t('Vivaran')}</th><th className="num">{t('Jama (dena)')}</th><th className="num">{t('Diya')}</th><th className="num">{t('Baaki')}</th></tr></thead>
              <tbody>
                <tr className="open-lines"><td className="opt-col muted">{shortDate(data.from)}</td><td className="main-col">{t('Pichhle saal se')}</td><td /><td /><td className="num money b">{owed(data.openingPaise)}</td></tr>
                {data.lines.map((l) => (
                  <tr key={`${l.kind}-${l.id}`} data-row tabIndex={0}>
                    <td className="opt-col muted money">{shortDate(l.date)}</td>
                    <td className="main-col"><b>{l.title}</b><small><span className="show-sm">{shortDate(l.date)} · </span>{l.detail}</small></td>
                    <td className="num money">{l.creditPaise ? rupees(l.creditPaise) : ''}</td>
                    <td className="num money jama">{l.debitPaise ? rupees(l.debitPaise) : ''}</td>
                    <td className="num amt-col money b">{owed(l.balancePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.lines.length === 0 && <p className="empty">{t('Is saal koi len-den nahi')}</p>}
          </div>
        </>
      )}
      {edit && edit !== 'new' && <SupplierSheet shopId={shopId} c={edit} onClose={onEdited} />}
    </>
  )
}

function SupplierSheet({ shopId, c, onClose }: { shopId: string; c: Creditor | null; onClose: () => void }) {
  const [name, setName] = useState(c?.name ?? '')
  const [code, setCode] = useState(c?.code ?? '')
  const [area, setArea] = useState(c?.area ?? '')
  const [mobile, setMobile] = useState(c?.phone ?? '')
  const [opening, setOpening] = useState(c?.masterOpeningPaise ?? 0)
  const [openingOn, setOpeningOn] = useState(c?.masterOpeningOn ?? `${fyNow()}-04-01`)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    setSaving(true); setError('')
    try {
      await api(`/v1/admin/shops/${shopId}/creditors`, { method: 'POST', body: {
        ...(c?.id ? { id: c.id } : {}), name, code, area, phone: mobile, openingPaise: opening, openingOn: opening ? openingOn : null,
      } })
      booksChanged(); onClose()
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const caps = { textTransform: 'uppercase' as const }
  return (
    <Sheet title={c ? t('Supplier badlein') : t('Naya supplier')} onClose={onClose} onSave={() => void save()} saving={saving} error={error}>
      <Field label={t('Supplier ka naam')}><input className="field" style={caps} autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="grid g2">
        <Field label={t('Code')}><input className="field" style={caps} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <Field label={t('Area')}><input className="field" style={caps} list="supplier-areas" value={area} onChange={(e) => setArea(e.target.value)} /></Field>
      </div>
      <AreaDatalist shopId={shopId} id="supplier-areas" />
      <Field label={t('Mobile')}><input className="field" inputMode="numeric" value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))} /></Field>
      <div className="grid g2">
        <Field label={t('Opening balance (dena)')}><Money value={opening} onChange={setOpening} /></Field>
        <Field label={t('Kis tarikh ka')}><input className="field" type="date" value={openingOn} onChange={(e) => setOpeningOn(e.target.value)} /></Field>
      </div>
    </Sheet>
  )
}

// ================================================================ Laddan

type Party = {
  id: string; name: string; code: string; phone: string; address: string; city: string; district: string; state: string
  contactPerson: string; email: string; area: string; bankDetails: string; hidden: boolean; balancePaise: number
}

/** Parties in other mandis the shop sends maal to on sale: the master, their balance, a parchi to them. */
export function Laddan({ shopId }: { shopId: string }) {
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Party | 'new' | null>(null)
  const { data, error, loading } = useLoad(() => api<{ parties: Party[] }>(`/v1/admin/shops/${shopId}/laddan?q=${encodeURIComponent(q)}`), [shopId, q])
  const list = data?.parties ?? []

  useExport(data ? () => ({
    style: 'book' as const, title: t('Laddan'), file: fileName('Laddan'),
    columns: [{ label: t('Code') }, { label: t('Naam'), wide: true }, { label: t('City') }, { label: t('Contact') }, { label: t('Mobile') }, { label: t('Baaki'), num: true }],
    rows: list.map((p) => ({ cells: [p.code, p.name, p.city, p.contactPerson, p.phone, rs(p.balancePaise)] })),
  }) : null, [data])

  const parchi = (p: Party) => openDraft({
    kind: 'parchi', buyer: { id: p.id, name: p.name }, truckId: null, lines: [], lots: [], pay: 'credit', cashPaise: 0, upiPaise: 0,
    packing: null, size: null, kattaName: '', kattas: null, panni: '', parchune: false, delivery: false, labour: false, notes: [],
  })

  return (
    <>
      <div className="toolbar">
        <input className="field search grow" data-search placeholder={t('Naam, code, city ya mobile')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn primary" onClick={() => setEdit('new')}>+ {t('Laddan')}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th className="opt-col">{t('Code')}</th><th>{t('Naam')}</th><th className="opt-col">{t('City')}</th><th className="opt-col">{t('Contact')}</th><th className="num">{t('Baaki')}</th><th className="opt-col" /></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} data-row tabIndex={0} className={p.hidden ? 'void' : undefined} onClick={() => setEdit(p)} onKeyDown={(e) => { if (e.key === 'Enter') setEdit(p) }}>
                  <td className="opt-col">{p.code}</td>
                  <td className="main-col"><b>{p.name}</b><small>{[p.city, p.area].filter(Boolean).join(' · ')}<span className="show-sm">{p.phone ? ` · ${fmtPhone(p.phone)}` : ''}</span></small></td>
                  <td className="opt-col">{p.city}</td>
                  <td className="opt-col">{[p.contactPerson, p.phone ? fmtPhone(p.phone) : ''].filter(Boolean).join(' · ')}</td>
                  <td className="num amt-col"><a className={`money b${p.balancePaise > 0 ? ' due' : ''}`} href={href({ page: 'grahak', shopId, buyerId: p.id })} onClick={(e) => e.stopPropagation()}>{rupees(p.balancePaise)}</a></td>
                  <td className="opt-col act-col"><button type="button" className="btn act" onClick={(e) => { e.stopPropagation(); parchi(p) }}>{t('Parchi')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length === 0 && <p className="empty">{q ? t('Koi laddan party nahi mili') : t('Abhi koi laddan party nahi')}</p>}
        </div>
      )}
      {edit && <LaddanSheet shopId={shopId} p={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onParchi={edit !== 'new' ? () => { const p = edit; setEdit(null); parchi(p) } : undefined} />}
      {data && list.length > 0 && <p className="muted" style={{ marginTop: 8 }}>{count(list.length)} {t('party')}</p>}
    </>
  )
}

const FIELDS: { key: keyof Party; label: string; wide?: boolean; caps?: boolean; numeric?: boolean }[] = [
  { key: 'name', label: 'Naam', wide: true, caps: true },
  { key: 'code', label: 'Code', caps: true },
  { key: 'area', label: 'Area', caps: true },
  { key: 'address', label: 'Address', wide: true, caps: true },
  { key: 'city', label: 'City', caps: true },
  { key: 'district', label: 'District', caps: true },
  { key: 'state', label: 'State', caps: true },
  { key: 'contactPerson', label: 'Contact person', caps: true },
  { key: 'phone', label: 'Contact no.', numeric: true },
  { key: 'email', label: 'Email' },
  { key: 'bankDetails', label: 'Bank details', wide: true },
]

function LaddanSheet({ shopId, p, onClose, onParchi }: { shopId: string; p: Party | null; onClose: () => void; onParchi?: () => void }) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((f) => [f.key, String(p?.[f.key] ?? '')])))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    setSaving(true); setError('')
    try {
      const body = { name: v.name, code: v.code, area: v.area, address: v.address, city: v.city, district: v.district, state: v.state,
        contactPerson: v.contactPerson, phone: v.phone, email: v.email, bankDetails: v.bankDetails }
      if (p) await api(`/v1/admin/shops/${shopId}/grahak/${p.id}`, { method: 'POST', body })
      else await api(`/v1/admin/shops/${shopId}/entries/grahak`, { method: 'POST', body: { ...body, kind: 'laddan' } })
      booksChanged(); onClose()
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  return (
    <Sheet title={p ? t('Laddan party') : t('Nayi laddan party')} onClose={onClose} onSave={() => void save()} saving={saving} error={error}>
      <div className="grid g2">
        {FIELDS.map((f) => (
          <div key={f.key} style={f.wide ? { gridColumn: '1 / -1' } : undefined}>
            <Field label={t(f.label)}>
              <input className="field" autoFocus={f.key === 'name'} inputMode={f.numeric ? 'numeric' : undefined} style={f.caps ? { textTransform: 'uppercase' } : undefined}
                list={f.key === 'area' ? 'laddan-areas' : undefined}
                value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: f.numeric ? e.target.value.replace(/\D/g, '').slice(0, 10) : e.target.value })} />
            </Field>
          </div>
        ))}
      </div>
      <AreaDatalist shopId={shopId} id="laddan-areas" />
      {onParchi && <button type="button" className="btn" style={{ justifySelf: 'start' }} onClick={onParchi}>{t('Laddan parchi')} ›</button>}
    </Sheet>
  )
}
