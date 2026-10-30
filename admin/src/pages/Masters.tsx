import { useEffect, useState, type ReactNode } from 'react'
import { api, type ShopSettings } from '../api'
import { useSession } from '../App'
import { count, phone as fmtPhone, rupees, shortDate, todayIst } from '../format'
import { t } from '../i18n'
import { href } from '../routes'
import { booksChanged, useLoad } from '../useLoad'
import { Skeleton } from '../ui'
import { fileName, rs, useExport } from '../export/doc'
import { Field, Money, Seg, Sheet } from '../entries/fields'

/** Grapes shops write every name in capitals; the inputs show it as typed. */
function useCaps(shopId: string) {
  const { shops } = useSession()
  return shops?.find((x) => x.id === shopId)?.commodity === 'angoor'
}
const CAPS = { textTransform: 'uppercase' as const }
const fyNow = () => { const [y, m] = todayIst().split('-').map(Number); return m >= 4 ? y : y - 1 }
const fyLabel = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`
const has = (q: string, ...v: (string | undefined)[]) => { const f = q.trim().toLowerCase(); return !f || v.some((x) => (x ?? '').toLowerCase().includes(f)) }

/** A save-and-close helper for the master sheets. */
function useSaver(onClose: () => void) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const run = async (fn: () => Promise<unknown>, close = true) => {
    setSaving(true); setError('')
    try { await fn(); booksChanged(); if (close) onClose() } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  return { saving, error, setError, run }
}

function Toolbar({ q, setQ, placeholder, children }: { q: string; setQ: (v: string) => void; placeholder: string; children?: ReactNode }) {
  return (
    <div className="toolbar">
      <input className="field search grow" data-search type="search" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      {children}
    </div>
  )
}

// ================================================================ Company

const COMPANY: { key: keyof ShopSettings; label: string; max: number; caps?: boolean; tel?: boolean }[] = [
  { key: 'name', label: 'Firm ka naam', max: 120 },
  { key: 'address', label: 'Pata', max: 200 },
  { key: 'licenceNo', label: 'Licence no.', max: 40, caps: true },
  { key: 'companyCode', label: 'Code', max: 20, caps: true },
  { key: 'phone', label: 'Telephone', max: 10, tel: true },
  { key: 'contactPerson', label: 'Contact person', max: 80 },
  { key: 'email', label: 'Email', max: 120 },
  { key: 'gstin', label: 'GSTIN', max: 15, caps: true },
]

/** The old Company Master: the firm's details; the rest stays in Settings. */
export function Company({ shopId }: { shopId: string }) {
  const [saved, setSaved] = useState<ShopSettings | null>(null)
  const [f, setF] = useState<ShopSettings | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  useEffect(() => { api<ShopSettings>(`/v1/admin/shops/${shopId}/settings`).then((s) => { setSaved(s); setF(s) }).catch((e: Error) => setError(e.message)) }, [shopId])
  if (!f || !saved) return error ? <p className="error">{error}</p> : <Skeleton rows={6} />
  const changed = COMPANY.filter((c) => f[c.key] !== saved[c.key])
  const save = async () => {
    setBusy(true); setError('')
    try {
      const s = await api<ShopSettings>(`/v1/admin/shops/${shopId}/settings`, { method: 'POST', body: Object.fromEntries(changed.map((c) => [c.key, f[c.key]])) })
      setSaved(s); setF(s); setDone(true); booksChanged()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <form className="card set-sec" style={{ maxWidth: 720 }} onSubmit={(e) => { e.preventDefault(); if (changed.length) void save() }}>
      <div className="set-body">
        {COMPANY.map((c) => (
          <div key={c.key} className="set-row">
            <span className="set-lb">{t(c.label)}</span>
            <span className="set-ctl">
              <input className="field" maxLength={c.max} inputMode={c.tel ? 'tel' : undefined} style={c.caps ? CAPS : undefined} value={String(f[c.key] ?? '')}
                onChange={(e) => { setDone(false); setF({ ...f, [c.key]: c.tel ? e.target.value.replace(/\D/g, '') : e.target.value }) }} />
            </span>
          </div>
        ))}
        <div className="set-row"><span className="set-lb">{t('Financial year')}</span><span className="set-ctl"><span className="set-static">1 April – 31 March</span></span></div>
      </div>
      <div className="set-bar" style={{ position: 'static' }}>
        {error && <span className="error">{error}</span>}
        {done && !changed.length && <span className="jama">{t('Save ho gaya')}</span>}
        <span className="grow" />
        {changed.length > 0 && <button type="button" className="btn ghost" disabled={busy} onClick={() => setF(saved)}>{t('Rehne dein')}</button>}
        <button type="submit" className="btn primary" disabled={busy || !changed.length}>{busy ? '…' : t('Save')}</button>
      </div>
    </form>
  )
}

// ================================================================ Products and groups

type Product = { id: string; name: string; sortOrder: number; hidden: boolean; shelfDays: number; groupId: string | null; nags: number; amountPaise: number }
type Group = { id: string; name: string; products: number; nags: number; amountPaise: number }
type Products = { fy: number; label: string; products: Product[]; groups: Group[] }

/** Product Master: every maal with its group and this year's bikri; add, rename, hide, reorder. */
export function Products({ shopId }: { shopId: string }) {
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Product | 'new' | null>(null)
  const [moving, setMoving] = useState(false)
  const { data, error, loading } = useLoad(() => api<Products>(`/v1/admin/shops/${shopId}/products`), [shopId])
  const groups = new Map((data?.groups ?? []).map((g) => [g.id, g.name]))
  const rows = (data?.products ?? []).filter((p) => has(q, p.name, groups.get(p.groupId ?? '')))
  const visible = (data?.products ?? []).filter((p) => !p.hidden)

  useExport(data ? () => ({
    style: 'book' as const, title: `${t('Product Master')} ${data.label}`, file: fileName('Product Master', data.label),
    columns: [{ label: t('Maal'), wide: true }, { label: t('Group') }, { label: t('Nag'), num: true }, { label: t('Rakam'), num: true }],
    rows: rows.map((p) => ({ cells: [p.name + (p.hidden ? ` (${t('Chhupa hua')})` : ''), groups.get(p.groupId ?? '') ?? '', count(p.nags), rs(p.amountPaise)] })),
  }) : null, [data, q])

  const move = async (id: string, by: -1 | 1) => {
    const ids = visible.map((p) => p.id)
    const i = ids.indexOf(id), j = i + by
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    setMoving(true)
    try { await api(`/v1/admin/shops/${shopId}/products/order`, { method: 'POST', body: { ids } }); booksChanged() } finally { setMoving(false) }
  }

  return (
    <>
      <Toolbar q={q} setQ={setQ} placeholder={t('Maal ya group')}>
        <button type="button" className="btn primary" onClick={() => setEdit('new')}>+ {t('Maal')}</button>
      </Toolbar>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading || moving ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th className="opt-col" /><th>{t('Maal')}</th><th className="opt-col">{t('Group')}</th><th className="num">{t('Nag')} {data.label}</th><th className="num opt-col">{t('Rakam')}</th></tr></thead>
            <tbody>
              {rows.map((p) => {
                const at = visible.findIndex((v) => v.id === p.id)
                return (
                  <tr key={p.id} data-row tabIndex={0} className={p.hidden ? 'void' : undefined} onClick={() => setEdit(p)} onKeyDown={(e) => { if (e.key === 'Enter') setEdit(p) }}>
                    <td className="opt-col act-col" onClick={(e) => e.stopPropagation()}>
                      {!p.hidden && !q && <span style={{ display: 'inline-flex', gap: 2 }}>
                        <button type="button" className="btn act" aria-label={t('Upar')} disabled={moving || at <= 0} onClick={() => void move(p.id, -1)}>↑</button>
                        <button type="button" className="btn act" aria-label={t('Neeche')} disabled={moving || at >= visible.length - 1} onClick={() => void move(p.id, 1)}>↓</button>
                      </span>}
                    </td>
                    <td className="main-col"><b className="name">{p.name}</b><small>{p.hidden ? t('Chhupa hua') : ''}<span className="show-sm">{groups.get(p.groupId ?? '') ?? ''}</span></small></td>
                    <td className="opt-col">{groups.get(p.groupId ?? '') ?? ''}</td>
                    <td className="num money">{count(p.nags)}</td>
                    <td className="num opt-col money">{rupees(p.amountPaise)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length === 0 && <p className="empty">{q ? t('Kuch nahi mila') : t('Abhi koi maal nahi')}</p>}
        </div>
      )}
      {edit && data && <ProductSheet shopId={shopId} p={edit === 'new' ? null : edit} groups={data.groups} onClose={() => setEdit(null)} />}
    </>
  )
}

function ProductSheet({ shopId, p, groups, onClose }: { shopId: string; p: Product | null; groups: Group[]; onClose: () => void }) {
  const caps = useCaps(shopId)
  const [name, setName] = useState(p?.name ?? '')
  const [groupId, setGroupId] = useState(p?.groupId ?? '')
  const [shelf, setShelf] = useState(String(p?.shelfDays ?? 7))
  const { saving, error, setError, run } = useSaver(onClose)
  const body = (extra: object = {}) => ({ ...(p ? { id: p.id } : {}), name, groupId: groupId || null, shelfDays: Math.min(60, Math.max(1, Number(shelf) || 7)), ...extra })
  const save = () => { if (!name.trim()) return setError(t('Naam daalein')); void run(() => api(`/v1/admin/shops/${shopId}/products`, { method: 'POST', body: body() })) }
  return (
    <Sheet title={p ? t('Maal badlein') : t('Naya maal')} onClose={onClose} onSave={save} saving={saving} error={error}>
      <Field label={t('Naam')}><input className="field" style={caps ? CAPS : undefined} autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="row2">
        <Field label={t('Group')}>
          <select className="field" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">—</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
        <Field label={t('Kitne din chalta')}><input className="field" inputMode="numeric" maxLength={2} value={shelf} onChange={(e) => setShelf(e.target.value.replace(/\D/g, ''))} /></Field>
      </div>
      {p && <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} disabled={saving}
        onClick={() => void run(() => api(`/v1/admin/shops/${shopId}/products`, { method: 'POST', body: body({ hidden: !p.hidden }) }))}>{p.hidden ? t('Wapas dikhayein') : t('Chhupayein')}</button>}
    </Sheet>
  )
}

/** Product Group Master: groups of maal, what each sold this year, which maal is in it. */
export function ProductGroups({ shopId }: { shopId: string }) {
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Group | 'new' | null>(null)
  const { data, error, loading } = useLoad(() => api<Products>(`/v1/admin/shops/${shopId}/products`), [shopId])
  const rows = (data?.groups ?? []).filter((g) => has(q, g.name, ...(data?.products ?? []).filter((p) => p.groupId === g.id).map((p) => p.name)))
  const loose = (data?.products ?? []).filter((p) => !p.groupId && !p.hidden)

  useExport(data ? () => ({
    style: 'book' as const, title: `${t('Product Group')} ${data.label}`, file: fileName('Product Group', data.label),
    columns: [{ label: t('Group'), wide: true }, { label: t('Maal'), num: true }, { label: t('Nag'), num: true }, { label: t('Rakam'), num: true }],
    rows: rows.map((g) => ({ cells: [g.name, count(g.products), count(g.nags), rs(g.amountPaise)] })),
  }) : null, [data, q])

  return (
    <>
      <Toolbar q={q} setQ={setQ} placeholder={t('Group ya maal')}>
        <button type="button" className="btn primary" onClick={() => setEdit('new')}>+ {t('Group')}</button>
      </Toolbar>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th>{t('Group')}</th><th className="num">{t('Maal')}</th><th className="num">{t('Nag')} {data.label}</th><th className="num opt-col">{t('Rakam')}</th></tr></thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id} data-row tabIndex={0} onClick={() => setEdit(g)} onKeyDown={(e) => { if (e.key === 'Enter') setEdit(g) }}>
                  <td className="main-col"><b>{g.name}</b><small>{data.products.filter((p) => p.groupId === g.id).map((p) => p.name).join(', ')}</small></td>
                  <td className="num money">{count(g.products)}</td>
                  <td className="num money">{count(g.nags)}</td>
                  <td className="num opt-col money">{rupees(g.amountPaise)}</td>
                </tr>
              ))}
              {loose.length > 0 && !q && (
                <tr className="void"><td className="main-col"><b>{t('Bina group')}</b><small>{loose.map((p) => p.name).join(', ')}</small></td>
                  <td className="num money">{count(loose.length)}</td><td className="num money">{count(loose.reduce((s, p) => s + p.nags, 0))}</td>
                  <td className="num opt-col money">{rupees(loose.reduce((s, p) => s + p.amountPaise, 0))}</td></tr>
              )}
            </tbody>
          </table>
          {rows.length === 0 && <p className="empty">{q ? t('Kuch nahi mila') : t('Abhi koi group nahi')}</p>}
        </div>
      )}
      {edit && data && <GroupSheet shopId={shopId} g={edit === 'new' ? null : edit} products={data.products} onClose={() => setEdit(null)} />}
    </>
  )
}

function GroupSheet({ shopId, g, products, onClose }: { shopId: string; g: Group | null; products: Product[]; onClose: () => void }) {
  const caps = useCaps(shopId)
  const [name, setName] = useState(g?.name ?? '')
  const [inIt, setInIt] = useState(() => new Set(products.filter((p) => g && p.groupId === g.id).map((p) => p.id)))
  const { saving, error, setError, run } = useSaver(onClose)
  const save = () => {
    if (!name.trim()) return setError(t('Naam daalein'))
    void run(async () => {
      const r = await api<{ id: string }>(`/v1/admin/shops/${shopId}/product-groups`, { method: 'POST', body: { ...(g ? { id: g.id } : {}), name } })
      for (const p of products) {
        const was = !!g && p.groupId === g.id, now = inIt.has(p.id)
        if (was !== now) await api(`/v1/admin/shops/${shopId}/products`, { method: 'POST', body: { id: p.id, groupId: now ? r.id : null } })
      }
    })
  }
  const remove = () => {
    if (!g || !confirm(t('{name} hatayein?', { name: g.name }))) return
    void run(() => api(`/v1/admin/shops/${shopId}/product-groups/${g.id}/delete`, { method: 'POST' }))
  }
  return (
    <Sheet title={g ? t('Group badlein') : t('Naya group')} onClose={onClose} onSave={save} saving={saving} error={error}>
      <Field label={t('Naam')}><input className="field" style={caps ? CAPS : undefined} autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="fld">
        <span className="fld-lb">{t('Maal')}</span>
        <div className="chips" role="group">
          {products.filter((p) => !p.hidden || inIt.has(p.id)).map((p) => (
            <button type="button" key={p.id} aria-pressed={inIt.has(p.id)}
              onClick={() => setInIt((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n })}>{p.name}</button>
          ))}
        </div>
      </div>
      {g && <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} disabled={saving} onClick={remove}>{t('Hatayein')}</button>}
    </Sheet>
  )
}

// ================================================================ Area Master

type Area = { id: string | null; name: string; code: string; grahak: number; suppliers: number }

/** The area names, for a datalist on any form that takes an area. */
export function AreaDatalist({ shopId, id }: { shopId: string; id: string }) {
  const [names, setNames] = useState<string[]>([])
  useEffect(() => { api<{ areas: Area[] }>(`/v1/admin/shops/${shopId}/areas`).then((r) => setNames(r.areas.map((a) => a.name))).catch(() => {}) }, [shopId])
  return <datalist id={id}>{names.map((n) => <option key={n} value={n} />)}</datalist>
}

/** Area Master: every area with its grahak and suppliers; a rename moves them all. */
export function Areas({ shopId }: { shopId: string }) {
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Area | 'new' | null>(null)
  const { data, error, loading } = useLoad(() => api<{ areas: Area[] }>(`/v1/admin/shops/${shopId}/areas`), [shopId])
  const rows = (data?.areas ?? []).filter((a) => has(q, a.name, a.code))

  useExport(data ? () => ({
    style: 'book' as const, title: t('Area Master'), file: fileName('Area Master'),
    columns: [{ label: t('Code') }, { label: t('Area'), wide: true }, { label: t('Grahak'), num: true }, { label: t('Supplier'), num: true }],
    rows: rows.map((a) => ({ cells: [a.code, a.name, count(a.grahak), count(a.suppliers)] })),
  }) : null, [data, q])

  return (
    <>
      <Toolbar q={q} setQ={setQ} placeholder={t('Area ya code')}>
        <button type="button" className="btn primary" onClick={() => setEdit('new')}>+ {t('Area')}</button>
      </Toolbar>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th className="opt-col">{t('Code')}</th><th>{t('Area')}</th><th className="num">{t('Grahak')}</th><th className="num">{t('Supplier')}</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.name} data-row tabIndex={0} onClick={() => setEdit(a)} onKeyDown={(e) => { if (e.key === 'Enter') setEdit(a) }}>
                  <td className="opt-col">{a.code}</td>
                  <td className="main-col"><b>{a.name}</b><small>{a.id ? '' : <span className="chip amber">{t('Master mein nahi')}</span>}<span className="show-sm">{a.code}</span></small></td>
                  <td className="num money">{a.grahak ? <a href={`${href({ page: 'report', shopId, report: 'ledger' })}?area=${encodeURIComponent(a.name)}`} onClick={(e) => e.stopPropagation()}>{count(a.grahak)}</a> : 0}</td>
                  <td className="num money">{count(a.suppliers)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="empty">{q ? t('Kuch nahi mila') : t('Abhi koi area nahi')}</p>}
        </div>
      )}
      {edit && <AreaSheet shopId={shopId} a={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  )
}

function AreaSheet({ shopId, a, onClose }: { shopId: string; a: Area | null; onClose: () => void }) {
  const [name, setName] = useState(a?.name ?? '')
  const [code, setCode] = useState(a?.code ?? '')
  const { saving, error, setError, run } = useSaver(onClose)
  const used = (a?.grahak ?? 0) + (a?.suppliers ?? 0)
  const save = () => {
    if (!name.trim()) return setError(t('Naam daalein'))
    void run(() => api(`/v1/admin/shops/${shopId}/areas`, { method: 'POST', body: { ...(a?.id ? { id: a.id } : {}), ...(a && !a.id ? { from: a.name } : {}), name, code } }))
  }
  const remove = () => {
    if (!a?.id || !confirm(t('{name} hatayein?', { name: a.name }))) return
    void run(() => api(`/v1/admin/shops/${shopId}/areas/${a.id}/delete`, { method: 'POST' }))
  }
  return (
    <Sheet title={a ? t('Area badlein') : t('Naya area')} onClose={onClose} onSave={save} saving={saving} error={error}>
      <div className="row2">
        <Field label={t('Area')}><input className="field" style={CAPS} autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('Code')}><input className="field" style={CAPS} maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
      </div>
      {a?.id && used === 0 && <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} disabled={saving} onClick={remove}>{t('Hatayein')}</button>}
    </Sheet>
  )
}

// ================================================================ Store Master

type Store = { id: string; name: string; address: string; contactPerson: string; phone: string; hidden: boolean }

/** Store Master: the cold stores the shop keeps maal in. */
export function Stores({ shopId }: { shopId: string }) {
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Store | 'new' | null>(null)
  const { data, error, loading } = useLoad(() => api<{ stores: Store[] }>(`/v1/admin/shops/${shopId}/stores`), [shopId])
  const rows = (data?.stores ?? []).filter((s) => has(q, s.name, s.address, s.contactPerson, s.phone))

  useExport(data ? () => ({
    style: 'book' as const, title: t('Store Master'), file: fileName('Store Master'),
    columns: [{ label: t('Store'), wide: true }, { label: t('Pata') }, { label: t('Contact') }, { label: t('Mobile') }],
    rows: rows.map((s) => ({ cells: [s.name, s.address, s.contactPerson, s.phone] })),
  }) : null, [data, q])

  return (
    <>
      <Toolbar q={q} setQ={setQ} placeholder={t('Store, pata ya contact')}>
        <button type="button" className="btn primary" onClick={() => setEdit('new')}>+ {t('Store')}</button>
      </Toolbar>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th>{t('Store')}</th><th className="opt-col">{t('Pata')}</th><th className="opt-col">{t('Contact')}</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} data-row tabIndex={0} className={s.hidden ? 'void' : undefined} onClick={() => setEdit(s)} onKeyDown={(e) => { if (e.key === 'Enter') setEdit(s) }}>
                  <td className="main-col"><b className="name">{s.name}</b><small>{s.hidden ? t('Chhupa hua') : ''}<span className="show-sm">{[s.address, s.contactPerson, s.phone ? fmtPhone(s.phone) : ''].filter(Boolean).join(' · ')}</span></small></td>
                  <td className="opt-col">{s.address}</td>
                  <td className="opt-col">{[s.contactPerson, s.phone ? fmtPhone(s.phone) : ''].filter(Boolean).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="empty">{q ? t('Kuch nahi mila') : t('Abhi koi store nahi')}</p>}
        </div>
      )}
      {edit && <StoreSheet shopId={shopId} s={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  )
}

function StoreSheet({ shopId, s, onClose }: { shopId: string; s: Store | null; onClose: () => void }) {
  const caps = useCaps(shopId)
  const [f, setF] = useState({ name: s?.name ?? '', address: s?.address ?? '', contactPerson: s?.contactPerson ?? '', phone: s?.phone ?? '' })
  const { saving, error, setError, run } = useSaver(onClose)
  const save = () => {
    if (!f.name.trim()) return setError(t('Naam daalein'))
    if (f.phone && !/^[6-9]\d{9}$/.test(f.phone)) return setError(t('Mobile number 10 ank ka hona chahiye'))
    void run(() => api(`/v1/admin/shops/${shopId}/stores`, { method: 'POST', body: { ...(s ? { id: s.id } : {}), ...f } }))
  }
  const up = caps ? CAPS : undefined
  return (
    <Sheet title={s ? t('Store badlein') : t('Naya store')} onClose={onClose} onSave={save} saving={saving} error={error}>
      <Field label={t('Naam')}><input className="field" style={up} autoFocus maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label={t('Pata')}><input className="field" style={up} maxLength={200} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
      <div className="row2">
        <Field label={t('Contact person')}><input className="field" style={up} maxLength={80} value={f.contactPerson} onChange={(e) => setF({ ...f, contactPerson: e.target.value })} /></Field>
        <Field label={t('Mobile')}><input className="field" inputMode="tel" maxLength={10} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '') })} /></Field>
      </div>
      {s && <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} disabled={saving}
        onClick={() => void run(() => api(`/v1/admin/shops/${shopId}/stores/${s.id}/hide`, { method: 'POST', body: { hidden: !s.hidden } }))}>{s.hidden ? t('Wapas dikhayein') : t('Chhupayein')}</button>}
    </Sheet>
  )
}

// ================================================================ General Ledger (heads)

type HeadType = 'expense' | 'income' | 'asset' | 'liability'
type Head = {
  key: string; id: string | null; name: string; type: HeadType; builtin: boolean; hidden: boolean
  masterOpeningPaise: number; masterOpeningOn: string | null; openingPaise: number; debitPaise: number; creditPaise: number; closingPaise: number
}
type HeadLedger = {
  key: string; name: string; type: HeadType; builtin: boolean; label: string; from: string; openingPaise: number; closingPaise: number
  lines: { id: string; date: string; title: string; detail: string; debitPaise: number; creditPaise: number; balancePaise: number }[]
}
const TYPES: { key: HeadType; label: string }[] = [
  { key: 'expense', label: t('Kharcha') }, { key: 'income', label: t('Aamdani') }, { key: 'asset', label: t('Asset') }, { key: 'liability', label: t('Liability') },
]
const typeLabel = (k: HeadType) => TYPES.find((x) => x.key === k)?.label ?? k
/** Debit +, credit −, as the books write it. */
const drCr = (p: number) => (p === 0 ? rupees(0) : `${rupees(Math.abs(p))} ${p > 0 ? 'Dr' : 'Cr'}`)

function FyStep({ fy, onChange }: { fy: number; onChange: (y: number) => void }) {
  return (
    <div className="stepper">
      <button type="button" aria-label={t('Pichhla')} onClick={() => onChange(fy - 1)}>‹</button>
      <label>{fyLabel(fy)}</label>
      <button type="button" aria-label={t('Agla')} disabled={fy >= fyNow()} onClick={() => onChange(fy + 1)}>›</button>
    </div>
  )
}

/** General Ledger: the Day Book's own heads and the shop's, each with its year; one opens its ledger. */
export function Heads({ shopId }: { shopId: string }) {
  const [fy, setFy] = useState(fyNow)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [edit, setEdit] = useState<Head | 'new' | null>(null)
  const { data, error, loading } = useLoad(() => api<{ label: string; heads: Head[] }>(`/v1/admin/shops/${shopId}/heads?fy=${fy}`), [shopId, fy])
  const rows = (data?.heads ?? []).filter((h) => has(q, h.name, typeLabel(h.type)))

  useExport(data && !open ? () => ({
    style: 'book' as const, title: `${t('General Ledger')} ${data.label}`, file: fileName('General Ledger', data.label),
    columns: [{ label: t('Head'), wide: true }, { label: t('Type') }, { label: t('Opening'), num: true }, { label: 'Dr', num: true }, { label: 'Cr', num: true }, { label: t('Closing'), num: true }],
    rows: rows.map((h) => ({ cells: [h.name, typeLabel(h.type), drCr(h.openingPaise), rs(h.debitPaise), rs(h.creditPaise), drCr(h.closingPaise)] })),
  }) : null, [data, q, open])

  if (open) return <HeadLedgerView shopId={shopId} k={open} fy={fy} onFy={setFy} onBack={() => setOpen(null)} />
  return (
    <>
      <div className="toolbar">
        <FyStep fy={fy} onChange={setFy} />
        <input className="field search grow" data-search type="search" placeholder={t('Head ya type')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn primary" onClick={() => setEdit('new')}>+ {t('Head')}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th>{t('Head')}</th><th className="opt-col">{t('Type')}</th><th className="num opt-col">{t('Opening')}</th><th className="num opt-col">Dr</th><th className="num opt-col">Cr</th><th className="num">{t('Closing')}</th><th className="opt-col" /></tr></thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.key} data-row tabIndex={0} className={h.hidden ? 'void' : undefined} onClick={() => setOpen(h.key)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(h.key) }}>
                  <td className="main-col"><b className="name">{h.builtin ? t(h.name) : h.name}</b><small>{h.builtin ? <span className="chip grey">{t('Day Book')}</span> : ''}<span className="show-sm"> {typeLabel(h.type)}</span></small></td>
                  <td className="opt-col">{typeLabel(h.type)}</td>
                  <td className="num opt-col money">{drCr(h.openingPaise)}</td>
                  <td className="num opt-col money">{h.debitPaise ? rupees(h.debitPaise) : ''}</td>
                  <td className="num opt-col money">{h.creditPaise ? rupees(h.creditPaise) : ''}</td>
                  <td className="num amt-col money b">{drCr(h.closingPaise)}</td>
                  <td className="opt-col act-col">{!h.builtin && <button type="button" className="btn act" onClick={(e) => { e.stopPropagation(); setEdit(h) }}>{t('Badlein')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="empty">{t('Kuch nahi mila')}</p>}
        </div>
      )}
      {edit && <HeadSheet shopId={shopId} h={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  )
}

function HeadLedgerView({ shopId, k, fy, onFy, onBack }: { shopId: string; k: string; fy: number; onFy: (y: number) => void; onBack: () => void }) {
  const { data, error, loading } = useLoad(() => api<HeadLedger>(`/v1/admin/shops/${shopId}/heads/${encodeURIComponent(k)}?fy=${fy}`), [shopId, k, fy])
  const name = data ? (data.builtin ? t(data.name) : data.name) : ''
  useExport(data ? () => ({
    style: 'book' as const, title: `${name} · ${data.label}`, file: fileName(name, data.label),
    columns: [{ label: t('Tarikh') }, { label: t('Vivaran'), wide: true }, { label: 'Dr', num: true }, { label: 'Cr', num: true }, { label: t('Baaki'), num: true }],
    rows: [{ cells: [shortDate(data.from), t('Pichhle saal se'), '', '', drCr(data.openingPaise)] },
      ...data.lines.map((l) => ({ cells: [shortDate(l.date), [l.title, l.detail].filter(Boolean).join(' · '), l.debitPaise ? rs(l.debitPaise) : '', l.creditPaise ? rs(l.creditPaise) : '', drCr(l.balancePaise)] }))],
    foot: [t('Closing'), '', '', '', drCr(data.closingPaise)],
  }) : null, [data])
  return (
    <>
      <div className="toolbar">
        <button type="button" className="btn ghost" onClick={onBack}>‹ {t('General Ledger')}</button>
        <FyStep fy={fy} onChange={onFy} />
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Head')}</span><span className="v">{name}</span><small>{typeLabel(data.type)}</small></div>
            <div><span className="lb">{t('Pichhle saal se')}</span><span className="v">{drCr(data.openingPaise)}</span></div>
            <div><span className="lb">{t('Closing')}</span><span className="v">{drCr(data.closingPaise)}</span></div>
          </div>
          <div className={`card wrap-x${loading ? ' dim' : ''}`}>
            <table className="tbl fold">
              <thead><tr><th className="opt-col">{t('Tarikh')}</th><th>{t('Vivaran')}</th><th className="num">Dr</th><th className="num">Cr</th><th className="num">{t('Baaki')}</th></tr></thead>
              <tbody>
                <tr className="open-lines"><td className="opt-col muted">{shortDate(data.from)}</td><td className="main-col">{t('Pichhle saal se')}</td><td /><td /><td className="num money b">{drCr(data.openingPaise)}</td></tr>
                {data.lines.map((l) => (
                  <tr key={l.id} data-row tabIndex={0}>
                    <td className="opt-col muted money">{shortDate(l.date)}</td>
                    <td className="main-col"><b>{l.title}</b><small><span className="show-sm">{shortDate(l.date)} · </span>{l.detail}</small></td>
                    <td className="num money">{l.debitPaise ? rupees(l.debitPaise) : ''}</td>
                    <td className="num money jama">{l.creditPaise ? rupees(l.creditPaise) : ''}</td>
                    <td className="num amt-col money b">{drCr(l.balancePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.lines.length === 0 && <p className="empty">{t('Is saal koi len-den nahi')}</p>}
          </div>
        </>
      )}
    </>
  )
}

function HeadSheet({ shopId, h, onClose }: { shopId: string; h: Head | null; onClose: () => void }) {
  const caps = useCaps(shopId)
  const [name, setName] = useState(h?.name ?? '')
  const [type, setType] = useState<HeadType>(h?.type ?? 'expense')
  const [opening, setOpening] = useState(h?.masterOpeningPaise ?? 0)
  const [on, setOn] = useState(h?.masterOpeningOn ?? `${fyNow()}-04-01`)
  const { saving, error, setError, run } = useSaver(onClose)
  const save = () => {
    if (!name.trim()) return setError(t('Naam daalein'))
    void run(() => api(`/v1/admin/shops/${shopId}/heads`, { method: 'POST', body: { ...(h?.id ? { id: h.id } : {}), name, type, openingPaise: opening, openingOn: opening ? on : null } }))
  }
  const remove = (hidden: boolean) => {
    if (!h?.id || (hidden && !confirm(t('{name} hatayein?', { name: h.name })))) return
    void run(() => api(`/v1/admin/shops/${shopId}/heads/${h.id}/delete`, { method: 'POST', body: { hidden } }))
  }
  return (
    <Sheet title={h ? t('Head badlein') : t('Naya head')} onClose={onClose} onSave={save} saving={saving} error={error}>
      <Field label={t('Naam')}><input className="field" style={caps ? CAPS : undefined} autoFocus maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Seg value={type} onChange={setType} options={TYPES} />
      <div className="row2">
        <Field label={t('Opening')}><Money value={opening} onChange={setOpening} /></Field>
        <Field label={t('Kis tarikh ka')}><input className="field" type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
      </div>
      {h?.id && <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} disabled={saving} onClick={() => remove(!h.hidden)}>{h.hidden ? t('Wapas dikhayein') : t('Hatayein')}</button>}
    </Sheet>
  )
}

// ================================================================ Opening balances

type Openings = {
  grahak: { id: string; code: string; name: string; area: string; kind: string; hidden: boolean; openingPaise: number; openingOn: string | null }[]
  suppliers: { id: string | null; code: string; name: string; area: string; openingPaise: number; openingOn: string | null }[]
  heads: { id: string; name: string; type: HeadType; hidden: boolean; openingPaise: number; openingOn: string | null }[]
}
type Tab = 'grahak' | 'suppliers' | 'heads'

/** Rupees in and out, with a minus allowed (jama / they owe us). Saves on Enter or leaving the box. */
function OpeningInput({ paise, onSave, signed = true }: { paise: number; onSave: (p: number) => Promise<void>; signed?: boolean }) {
  const shown = (p: number) => (p ? String(p / 100) : '')
  const [text, setText] = useState(shown(paise))
  const [state, setState] = useState<'' | 'saving' | 'saved' | 'error'>('')
  useEffect(() => { setText(shown(paise)) }, [paise])
  const commit = async () => {
    const p = Math.round(Number(text || 0) * 100)
    if (!Number.isFinite(p) || p === paise) return
    setState('saving')
    try { await onSave(p); setState('saved') } catch (e) { setState('error'); alert((e as Error).message); setText(shown(paise)) }
  }
  return (
    <span className="money-in" style={{ minWidth: 120 }}>
      <span>₹</span>
      <input className="field num" inputMode="decimal" value={text} placeholder="0" aria-invalid={state === 'error'}
        style={state === 'saved' ? { borderColor: 'var(--accent)' } : undefined}
        onChange={(e) => { setState(''); setText(e.target.value.replace(signed ? /[^\d.-]/g : /[^\d.]/g, '').replace(/(?!^)-/g, '').replace(/(\..*)\./g, '$1')) }}
        onBlur={() => void commit()} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }} />
    </span>
  )
}

/** Every opening balance on one page: grahak (udhaar −jama), suppliers (dena −lena), ledger heads. */
export function Openings({ shopId }: { shopId: string }) {
  const [tab, setTab] = useState<Tab>('grahak')
  const [q, setQ] = useState('')
  const { data, error, loading, reload } = useLoad(() => api<Openings>(`/v1/admin/shops/${shopId}/openings`), [shopId])
  const base = `/v1/admin/shops/${shopId}/openings`
  const post = async (path: string, body: object) => { await api(`${base}/${path}`, { method: 'POST', body }); reload() }

  const g = (data?.grahak ?? []).filter((r) => has(q, r.name, r.code, r.area))
  const s = (data?.suppliers ?? []).filter((r) => has(q, r.name, r.code, r.area))
  const h = (data?.heads ?? []).filter((r) => has(q, r.name, typeLabel(r.type)))
  const total = (xs: { openingPaise: number }[]) => xs.reduce((t, x) => t + x.openingPaise, 0)

  useExport(data ? () => {
    const rows = tab === 'grahak' ? g.map((r) => [r.code, r.name, r.area, rs(r.openingPaise)])
      : tab === 'suppliers' ? s.map((r) => [r.code, r.name, r.area, rs(r.openingPaise)]) : h.map((r) => ['', r.name, typeLabel(r.type), rs(r.openingPaise)])
    return {
      style: 'book' as const, title: t('Opening balance'), file: fileName('Opening balance', tab),
      columns: [{ label: t('Code') }, { label: t('Naam'), wide: true }, { label: tab === 'heads' ? t('Type') : t('Area') }, { label: t('Opening'), num: true }],
      rows: rows.map((cells) => ({ cells })), foot: ['', t('Kul'), '', rs(total(tab === 'grahak' ? g : tab === 'suppliers' ? s : h))],
    }
  } : null, [data, tab, q])

  const dateCell = (value: string | null, onSave: (d: string) => void) => (
    <input className="field" type="date" value={value ?? ''} style={{ maxWidth: 150 }} onChange={(e) => e.target.value && onSave(e.target.value)} />
  )

  return (
    <>
      <div className="toolbar">
        <Seg value={tab} onChange={setTab} options={[{ key: 'grahak', label: t('Grahak') }, { key: 'suppliers', label: t('Supplier') }, { key: 'heads', label: t('Head') }]} />
        <input className="field search grow" data-search type="search" placeholder={t('Naam, code ya area')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th className="opt-col">{t('Code')}</th><th>{t('Naam')}</th><th className="opt-col">{tab === 'heads' ? t('Type') : t('Area')}</th><th className="num">{t('Opening')}</th><th className="opt-col">{t('Tarikh')}</th></tr></thead>
            <tbody>
              {tab === 'grahak' && g.map((r) => (
                <tr key={r.id} className={r.hidden ? 'void' : undefined}>
                  <td className="opt-col">{r.code}</td>
                  <td className="main-col"><a href={href({ page: 'grahak', shopId, buyerId: r.id })}><b>{r.name}</b></a><small>{r.kind === 'laddan' ? t('Laddan') : ''}<span className="show-sm"> {[r.code, r.area].filter(Boolean).join(' · ')}</span></small></td>
                  <td className="opt-col">{r.area}</td>
                  <td className="num"><OpeningInput paise={r.openingPaise} onSave={(p) => post(`grahak/${r.id}`, { openingPaise: p })} /></td>
                  <td className="opt-col muted">{r.openingOn ? shortDate(r.openingOn) : ''}</td>
                </tr>
              ))}
              {tab === 'suppliers' && s.map((r) => (
                <tr key={r.id ?? r.name}>
                  <td className="opt-col">{r.code}</td>
                  <td className="main-col"><b>{r.name}</b><small className="show-sm">{[r.code, r.area, r.openingOn ? shortDate(r.openingOn) : ''].filter(Boolean).join(' · ')}</small></td>
                  <td className="opt-col">{r.area}</td>
                  <td className="num"><OpeningInput paise={r.openingPaise} onSave={(p) => post('supplier', { id: r.id, name: r.name, openingPaise: p, openingOn: r.openingOn ?? `${fyNow()}-04-01` })} /></td>
                  <td className="opt-col">{r.openingPaise ? dateCell(r.openingOn, (d) => void post('supplier', { id: r.id, name: r.name, openingPaise: r.openingPaise, openingOn: d }).catch((e: Error) => alert(e.message))) : ''}</td>
                </tr>
              ))}
              {tab === 'heads' && h.map((r) => (
                <tr key={r.id} className={r.hidden ? 'void' : undefined}>
                  <td className="opt-col" />
                  <td className="main-col"><b>{r.name}</b><small className="show-sm">{typeLabel(r.type)}</small></td>
                  <td className="opt-col">{typeLabel(r.type)}</td>
                  <td className="num"><OpeningInput signed={false} paise={r.openingPaise} onSave={(p) => post(`head/${r.id}`, { openingPaise: p, openingOn: r.openingOn ?? `${fyNow()}-04-01` })} /></td>
                  <td className="opt-col">{r.openingPaise ? dateCell(r.openingOn, (d) => void post(`head/${r.id}`, { openingPaise: r.openingPaise, openingOn: d }).catch((e: Error) => alert(e.message))) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td className="opt-col" /><td className="main-col">{t('Kul')}</td><td className="opt-col" /><td className="num amt-col money">{rupees(total(tab === 'grahak' ? g : tab === 'suppliers' ? s : h))}</td><td className="opt-col" /></tr></tfoot>
          </table>
          {(tab === 'grahak' ? g : tab === 'suppliers' ? s : h).length === 0 && <p className="empty">{t('Kuch nahi mila')}</p>}
        </div>
      )}
    </>
  )
}
