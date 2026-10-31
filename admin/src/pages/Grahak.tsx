import { useEffect, useState } from 'react'
import { api, type BuyerDetail, type BuyerRow } from '../api'
import { useSession } from '../App'
import { count, phone, rupees, shortDate } from '../format'
import { hashQuery, href, setHashQuery } from '../routes'
import { booksChanged, useLoad } from '../useLoad'
import { Bal, Crumb, Ledger, Skeleton } from '../ui'
import { t } from '../i18n'
import { openWhatsApp } from '../keys'
import { balRs, dmy, fileName, rs, useExport } from '../export/doc'
import { Field, Sheet } from '../entries/fields'
import { AreaDatalist } from './Masters'
import { GrahakCrates } from './CrateStore'

/** Every grahak of the shop, searchable; biggest baaki first. Enter opens the khata. */
export function GrahakList({ shopId }: { shopId: string }) {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [area, setArea] = useState(() => hashQuery().get('area') ?? '')
  const [areas, setAreas] = useState<string[]>([])
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 250); return () => clearTimeout(t) }, [q])
  useEffect(() => { api<{ areas: { name: string }[] }>(`/v1/admin/shops/${shopId}/areas`).then((r) => setAreas(r.areas.map((a) => a.name))).catch(() => {}) }, [shopId])
  const { data, error, loading } = useLoad(
    () => api<{ buyers: BuyerRow[] }>(`/v1/admin/shops/${shopId}/buyers?all=1&q=${encodeURIComponent(query)}&area=${encodeURIComponent(area)}`).then((r) => r.buyers), [shopId, query, area])
  const pickArea = (a: string) => { setArea(a); setHashQuery(a ? { area: a } : {}) }

  useExport(data ? () => ({
    style: 'book' as const, title: area ? `${t('Grahak Ledger')} · ${area}` : t('Grahak Ledger'), file: fileName(t('Grahak Ledger'), area || undefined),
    columns: [{ label: t('Code') }, { label: t('Grahak'), wide: true }, { label: t('Mobile') }, { label: t('Kharida'), num: true }, { label: t('Aakhri parchi') }, { label: t('Baaki'), num: true }],
    rows: data.map((b) => ({ cells: [b.code, b.name, b.phone ? phone(b.phone) : '', rs(b.boughtPaise), b.lastSlipOn ? dmy(b.lastSlipOn) : '—', balRs(b.balancePaise)] })),
    foot: ['', t('Kul'), '', rs(data.reduce((s, b) => s + b.boughtPaise, 0)), '', balRs(data.reduce((s, b) => s + b.balancePaise, 0))],
  }) : null, [data, area])

  return (
    <>
      <div className="toolbar">
        <input className="field grow" data-search type="search" placeholder={t('Naam, mobile ya code')} value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
        {(areas.length > 0 || area) && (
          <select className="field" aria-label={t('Area')} style={{ flex: '0 1 180px' }} value={area} onChange={(e) => pickArea(e.target.value)}>
            <option value="">{t('Sab area')}</option>
            {[...new Set([...areas, ...(area ? [area] : [])])].map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th>{t('Code')}</th><th>{t('Grahak')}</th><th>{t('Mobile')}</th><th className="num">{t('Kharida')}</th><th>{t('Aakhri parchi')}</th><th className="num">{t('Baaki')}</th></tr></thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id} data-row tabIndex={0} onClick={() => { location.hash = href({ page: 'grahak', shopId, buyerId: b.id }) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') location.hash = href({ page: 'grahak', shopId, buyerId: b.id }) }}>
                  <td className="code-col">{b.code ? <span className="code">{b.code}</span> : null}</td>
                  <td className="main-col"><b>{b.name}</b><small>{b.hidden ? t('Chhupa hua') : ''}<span className="show-sm">{b.phone ? phone(b.phone) : ''}</span></small></td>
                  <td className="opt-col muted">{b.phone ? phone(b.phone) : '—'}</td>
                  <td className="num opt-col money">{rupees(b.boughtPaise)}</td>
                  <td className="opt-col muted">{b.lastSlipOn ? shortDate(b.lastSlipOn) : '—'}</td>
                  <td className="num amt-col"><Bal paise={b.balancePaise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.length === 0 && <p className="empty">{t('Koi grahak nahi mila')}</p>}
        </div>
      )}
    </>
  )
}

/** One grahak's khata at this shop — Tally's Ledger Vouchers for a party. */
export function GrahakKhata({ shopId, buyerId }: { shopId: string; buyerId: string }) {
  const { me, shops } = useSession()
  const [editing, setEditing] = useState(false)
  const back = href({ page: 'report', shopId, report: 'ledger' })
  const { data, error } = useLoad(() => api<BuyerDetail>(`/v1/admin/shops/${shopId}/buyers/${buyerId}`), [shopId, buyerId])
  if (error) return <><Crumb to={back}>{t('Grahak Ledger')}</Crumb><p className="error">{error}</p></>
  if (!data) return <><Crumb to={back}>{t('Grahak Ledger')}</Crumb><Skeleton /></>
  const { buyer: b, totals: tot, history } = data
  const mobile = /^[6-9]\d{9}$/.test(b.phone)

  return (
    <div className="stack">
      <div>
        <Crumb to={back}>{t('Grahak Ledger')}</Crumb>
        <div className="head" style={{ marginBottom: 0 }}>
          <div className="grow">
            <h1>{b.code && <span className="code big">{b.code}</span>}{b.name}{b.hidden && <span className="chip grey" style={{ marginLeft: 8, verticalAlign: 'middle' }}>{t('Chhupa hua')}</span>}</h1>
            <p>{[b.kind, b.address, b.destination && `→ ${b.destination}`, b.vehicle, b.gstin && `GSTIN ${b.gstin}`].filter(Boolean).join(' · ')}</p>
          </div>
          {mobile && <a className="call" href={`tel:+91${b.phone}`}>☎ {phone(b.phone)}</a>}
          {mobile && tot.balancePaise > 0 && <button type="button" className="btn ghost wa-btn" onClick={() => openWhatsApp(shopId, buyerId)}>WhatsApp</button>}
          <button type="button" className="btn ghost" onClick={() => setEditing(true)}>{t('Badlein')}</button>
        </div>
      </div>
      <div className="card sum">
        <div><span className="lb">{t('Baaki')}</span><span className="v"><Bal paise={tot.balancePaise} /></span></div>
        <div><span className="lb">{t('Kharida')}</span><span className="v">{rupees(tot.boughtPaise)}</span></div>
        <div><span className="lb">{t('Diya')}</span><span className="v">{rupees(tot.paidPaise)}</span></div>
        <div><span className="lb">{t('Parchi')}</span><span className="v">{count(tot.slips)} · {t('{n} nag', { n: count(tot.nags) })}</span></div>
        {b.creditLimitPaise > 0 && <div><span className="lb">{t('Limit')}</span><span className="v">{rupees(b.creditLimitPaise)}</span></div>}
        <GrahakCrates shopId={shopId} buyerId={buyerId} />
        {me?.admin && mobile && <div><span className="lb">{t('Poora market')}</span><a className="v call" href={href({ page: 'person', key: b.phone })}>{t('Dekhein')} ›</a></div>}
      </div>
      <Ledger closingPaise={tot.balancePaise} rows={history} shopId={shopId} grades={shops?.find((x) => x.id === shopId)?.commodity !== 'angoor'} exportAs={{
        title: 'CUSTOMER LEDGER', banks: true,
        party: { code: b.code || b.name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 6), description: [b.name, b.destination, mobile ? b.phone : ''].filter(Boolean).join(' '), address: b.address },
      }} />
      {editing && <GrahakEdit shopId={shopId} b={b} balancePaise={tot.balancePaise} onClose={() => setEditing(false)} />}
    </div>
  )
}

/** A grahak's details changed: name (in capitals for a grapes shop), code, mobile, pata. One owing nothing can be hidden. */
function GrahakEdit({ shopId, b, balancePaise, onClose }: { shopId: string; b: BuyerDetail['buyer']; balancePaise: number; onClose: () => void }) {
  const { shops } = useSession()
  const caps = shops?.find((x) => x.id === shopId)?.commodity === 'angoor'
  const [f, setF] = useState({ name: b.name, code: b.code, phone: b.phone, address: b.address, destination: b.destination, area: b.area ?? '', gstin: b.gstin ?? '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [tried, setTried] = useState(false)
  // A refusal from the server is about what was sent: typing again clears it.
  useEffect(() => { setError('') }, [f])
  const send = async (body: object, then: () => void) => {
    setSaving(true); setError('')
    try { await api(`/v1/admin/shops/${shopId}/grahak/${b.id}`, { method: 'POST', body }); booksChanged(); then() }
    catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const bad = {
    name: tried && !f.name.trim() ? t('Naam daalein') : /naam/i.test(error) ? error : '',
    phone: tried && f.phone && !/^[6-9]\d{9}$/.test(f.phone) ? t('Mobile number 10 ank ka hona chahiye') : /mobile/i.test(error) ? error : '',
    code: /^code/i.test(error) ? error : '',
    gstin: tried && f.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(f.gstin) ? t('GSTIN 15 akshar ka hota hai') : /gstin/i.test(error) ? error : '',
  }
  const save = () => {
    setTried(true); setError('')
    if (!f.name.trim() || (f.phone && !/^[6-9]\d{9}$/.test(f.phone)) || (f.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(f.gstin))) return
    const up = (v: string) => (caps ? v.trim().toUpperCase() : v.trim())
    void send({ name: up(f.name), code: f.code.trim(), phone: f.phone, address: up(f.address), destination: up(f.destination), area: f.area, gstin: f.gstin }, onClose)
  }
  const hide = () => {
    if (!confirm(t('{name} ko list se hatayein?', { name: b.name }))) return
    void send({ hidden: true }, () => { location.hash = href({ page: 'report', shopId, report: 'ledger' }) })
  }
  const up = caps ? { textTransform: 'uppercase' as const } : undefined
  return (
    <Sheet title={t('Grahak badlein')} onClose={onClose} onSave={save} saving={saving} error={bad.name || bad.phone || bad.code || bad.gstin ? '' : error}>
      <Field label={t('Naam')} error={bad.name}><input className="field" style={up} autoFocus maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <div className="row2">
        <Field label={t('Mobile')} error={bad.phone}><input className="field" inputMode="tel" maxLength={10} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label={t('Code')} error={bad.code}><input className="field" maxLength={20} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
      </div>
      <Field label={t('Dukaan / pata')}><input className="field" style={up} maxLength={200} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
      <div className="row2">
        <Field label={t('Kahan jata hai')}><input className="field" style={up} maxLength={120} value={f.destination} onChange={(e) => setF({ ...f, destination: e.target.value })} /></Field>
        <Field label={t('Area')}><input className="field" style={{ textTransform: 'uppercase' }} list="grahak-areas" maxLength={60} value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })} /></Field>
      </div>
      <AreaDatalist shopId={shopId} id="grahak-areas" />
      <Field label={t('GSTIN (invoice ke liye)')} error={bad.gstin}><input className="field" style={{ textTransform: 'uppercase' }} maxLength={15} value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase().replace(/\s/g, '') })} /></Field>
      {b.hidden
        ? <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} disabled={saving} onClick={() => void send({ hidden: false }, onClose)}>{t('List mein wapas laayein')}</button>
        : balancePaise === 0 && <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} disabled={saving} onClick={hide}>{t('List se hatayein')}</button>}
    </Sheet>
  )
}
