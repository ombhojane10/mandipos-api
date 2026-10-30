import { useEffect, useState } from 'react'
import { api } from '../api'
import { count, phone, rupees, todayIst } from '../format'
import { usePeriod } from '../hooks'
import { t } from '../i18n'
import { hashQuery, href, setHashQuery } from '../routes'
import { useLoad } from '../useLoad'
import { Bal, PeriodBar, Skeleton } from '../ui'
import { amt, bal, customerLedgerDoc, dmy, dmyLong, fileName, openExport, rs, useExport, type ExportDoc, type KhataLine } from '../export/doc'
import { FyButton } from './Books'

type Party = { id: string; code: string; name: string; kind: string; area: string; phone: string; address: string; hidden: boolean; balancePaise: number }
type Khata = {
  buyer: { id: string; name: string; phone: string; code: string; kind: string; address: string; destination: string; area: string; city: string }
  openingPaise: number; rows: (KhataLine & { id: string; kind: string })[]; closingPaise: number
}

const MOBILE = /^[6-9]\d{9}$/
const has = (q: string, ...xs: string[]) => { const f = q.trim().toLowerCase(); return !f || xs.some((x) => x.toLowerCase().includes(f)) }
/** The khata's party block, as the single khata prints it. */
const partyOf = (b: Khata['buyer']) => ({
  code: b.code || b.name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 6),
  description: [b.name, b.destination, MOBILE.test(b.phone) ? b.phone : ''].filter(Boolean).join(' '),
  address: [b.address, b.city].filter(Boolean).join(', '),
})

/** Grahak and laddan parties with baaki as on [on], and the areas to filter them by. */
function useParties(shopId: string, on: string) {
  const list = useLoad(() => api<{ parties: Party[] }>(`/v1/admin/shops/${shopId}/books/parties?on=${on}`).then((r) => r.parties), [shopId, on])
  const [areas, setAreas] = useState<string[]>([])
  useEffect(() => { api<{ areas: { name: string }[] }>(`/v1/admin/shops/${shopId}/areas`).then((r) => setAreas(r.areas.map((a) => a.name))).catch(() => {}) }, [shopId])
  const all = [...new Set([...areas, ...(list.data ?? []).map((p) => p.area).filter(Boolean)])].sort()
  return { ...list, areas: all }
}

/** Search, area, "only with baaki": the filters every party list here shares. */
function Filters({ q, setQ, area, setArea, areas, only, setOnly }: {
  q: string; setQ: (v: string) => void; area: string; setArea: (v: string) => void; areas: string[]; only?: boolean; setOnly?: (v: boolean) => void
}) {
  return (
    <div className="toolbar">
      <input className="field grow" data-search type="search" placeholder={t('Naam, mobile ya code')} value={q} onChange={(e) => setQ(e.target.value)} />
      <select className="field" aria-label={t('Area')} style={{ flex: '0 1 180px' }} value={area} onChange={(e) => setArea(e.target.value)}>
        <option value="">{t('Sab area')}</option>
        {areas.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
      {setOnly && <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
        <input type="checkbox" checked={!!only} onChange={(e) => setOnly(e.target.checked)} /> {t('Sirf baaki wale')}</label>}
    </div>
  )
}

/** A checkbox per party, select-all on the header for what the filters show. */
function PickList({ rows, sel, setSel }: { rows: Party[]; sel: Set<string>; setSel: (s: Set<string>) => void }) {
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.id))
  const flip = (id: string) => { const s = new Set(sel); if (s.has(id)) s.delete(id); else s.add(id); setSel(s) }
  return (
    <div className="card wrap-x">
      <table className="tbl fold">
        <thead><tr>
          <th style={{ width: 1 }}><input type="checkbox" aria-label={t('Sab chunein')} checked={allOn} onChange={() => {
            const s = new Set(sel)
            for (const r of rows) { if (allOn) s.delete(r.id); else s.add(r.id) }
            setSel(s)
          }} /></th>
          <th className="opt-col">{t('Code')}</th><th>{t('Grahak')}</th><th className="opt-col">{t('Area')}</th><th className="num">{t('Baaki')}</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-row tabIndex={0} onClick={() => flip(r.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(r.id) } }}>
              <td><input type="checkbox" tabIndex={-1} aria-label={r.name} checked={sel.has(r.id)} onChange={() => flip(r.id)} onClick={(e) => e.stopPropagation()} /></td>
              <td className="opt-col">{r.code ? <span className="code">{r.code}</span> : null}</td>
              <td className="main-col"><b className="name">{r.name}</b><small>{[r.kind === 'laddan' ? t('Laddan') : '', r.area, MOBILE.test(r.phone) ? phone(r.phone) : ''].filter(Boolean).join(' · ')}</small></td>
              <td className="opt-col muted">{r.area}</td>
              <td className="num amt-col"><Bal paise={r.balancePaise} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="empty">{t('Koi grahak nahi mila')}</p>}
    </div>
  )
}

// ================================================================ Ledger Multiple

/** Many grahak's khatas for a period in one print, each on its own pages, as the single khata prints. */
export function LedgerMultiple({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('30')
  const [q, setQ] = useState('')
  const [area, setArea] = useState(() => hashQuery().get('area') ?? '')
  const [only, setOnly] = useState(true)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [docs, setDocs] = useState<ExportDoc | null>(null)
  const list = useParties(shopId, period.to)
  const pickArea = (a: string) => { setArea(a); setHashQuery({ ...Object.fromEntries(hashQuery()), area: a }) }
  const rows = (list.data ?? []).filter((p) => (!only || p.balancePaise > 0) && (!area || p.area === area) && (p.balancePaise !== 0 || !p.hidden) && has(q, p.name, p.code, p.phone))
  const picked = (list.data ?? []).filter((p) => sel.has(p.id))
  useEffect(() => setDocs(null), [sel, period.from, period.to])

  // Ready: the prints. Not yet: the list itself.
  useExport(docs ? () => docs : list.data ? () => ({
    style: 'book' as const, title: t('Ledger Multiple'), dateLine: `${dmyLong(period.from)} - ${dmyLong(period.to)}`, file: fileName('Ledger-Multiple'),
    columns: [{ label: t('Code') }, { label: t('Grahak'), wide: true }, { label: t('Area') }, { label: t('Baaki'), num: true }],
    rows: (picked.length ? picked : rows).map((p) => ({ cells: [p.code, p.name, p.area, rs(p.balancePaise)] })),
  }) : null, [docs, list.data, sel, rows.length])
  // After useExport, so the prints are registered before the preview asks for them.
  useEffect(() => { if (docs) openExport() }, [docs])

  const print = async () => {
    setBusy(true); setError('')
    try {
      const r = await api<{ from: string; to: string; khatas: Khata[] }>(`/v1/admin/shops/${shopId}/books/khatas`, { method: 'POST', body: { ids: picked.map((p) => p.id), from: period.from, to: period.to } })
      const parts = r.khatas.map((k) => customerLedgerDoc({ title: 'CUSTOMER LEDGER', banks: true, party: partyOf(k.buyer), from: r.from, to: r.to,
        openingPaise: k.openingPaise, closingPaise: k.closingPaise, rows: k.rows }))
      setDocs({ style: 'ledger', title: 'CUSTOMER LEDGER', file: fileName('Ledger-Multiple', r.from, r.to), rows: [], parts, party: { description: t('{n} grahak', { n: parts.length }) } })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="toolbar">
        <PeriodBar value={period} onChange={setPeriod} />
        <FyButton value={period} onChange={setPeriod} />
        <button type="button" className="btn primary" disabled={!picked.length || busy} onClick={() => void print()}>{busy ? '…' : `${t('Print')} (${count(picked.length)})`}</button>
        {picked.length > 0 && <button type="button" className="btn ghost sm" onClick={() => setSel(new Set())}>{t('Hatayein')}</button>}
      </div>
      <Filters q={q} setQ={setQ} area={area} setArea={pickArea} areas={list.areas} only={only} setOnly={setOnly} />
      {(error || list.error) && <p className="error">{error || list.error}</p>}
      {!list.data ? <Skeleton /> : <PickList rows={rows} sel={sel} setSel={setSel} />}
    </>
  )
}

// ================================================================ Chithi / Schedule

/**
 * Schedule: every debtor (or one area's) with code, mobile and baaki on one sheet, for the
 * recovery round. Chithi: a short statement per grahak on the shop's letterhead — baaki as on a
 * day, the last few entries, the bank accounts to pay into — one per page.
 */
export function Chithi({ shopId }: { shopId: string }) {
  const [tab, setTab] = useState<'schedule' | 'chithi'>(() => (hashQuery().get('v') === 'chithi' ? 'chithi' : 'schedule'))
  const [on, setOn] = useState(() => hashQuery().get('on') ?? todayIst())
  const [area, setArea] = useState(() => hashQuery().get('area') ?? '')
  const [q, setQ] = useState('')
  const [last, setLast] = useState(5)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [docs, setDocs] = useState<ExportDoc | null>(null)
  const list = useParties(shopId, on)
  const keep = (k: Record<string, string>) => setHashQuery({ ...Object.fromEntries(hashQuery()), ...k })
  const due = (list.data ?? []).filter((p) => p.balancePaise > 0 && (!area || p.area === area) && has(q, p.name, p.code, p.phone))
    .sort((a, b) => a.area.localeCompare(b.area) || (a.code || '~').localeCompare(b.code || '~', 'en', { numeric: true }) || a.name.localeCompare(b.name))
  const picked = (list.data ?? []).filter((p) => sel.has(p.id))
  const total = due.reduce((s, p) => s + p.balancePaise, 0)
  useEffect(() => setDocs(null), [sel, on, last])

  useExport(tab === 'chithi' && docs ? () => docs : list.data ? () => {
    // Without an area chosen, the schedule goes area by area, each with its own total.
    const byArea = !area && due.some((p) => p.area)
    const out: ExportDoc['rows'] = []
    let cur: string | null = null
    for (const p of due) {
      if (byArea && p.area !== cur) {
        cur = p.area
        const sub = due.filter((x) => x.area === cur)
        out.push({ kind: 'band', cells: [`${cur || t('Bina area')}  ·  ${count(sub.length)}  ·  ${rs(sub.reduce((s, x) => s + x.balancePaise, 0))}`] })
      }
      out.push({ cells: [p.code, p.name, p.area, MOBILE.test(p.phone) ? phone(p.phone) : '', rs(p.balancePaise)] })
    }
    return {
      style: 'book' as const, title: area ? `SCHEDULE · ${area}` : 'SCHEDULE', dateLine: `AS ON ${dmyLong(on)}`, file: fileName('Schedule', area || undefined, on),
      summary: [[t('Grahak'), count(due.length)], [t('Kul baaki'), rs(total)]],
      columns: [{ label: t('Code') }, { label: t('Grahak'), wide: true }, { label: t('Area') }, { label: t('Mobile') }, { label: t('Baaki'), num: true }],
      rows: out, foot: ['', t('Kul'), '', '', rs(total)],
    }
  } : null, [tab, docs, list.data, area, q, on])
  // After useExport, so the prints are registered before the preview asks for them.
  useEffect(() => { if (docs) openExport() }, [docs])

  const print = async () => {
    setBusy(true); setError('')
    try {
      const r = await api<{ khatas: Khata[] }>(`/v1/admin/shops/${shopId}/books/khatas`, { method: 'POST', body: { ids: picked.map((p) => p.id), from: '2000-01-01', to: on, last } })
      const parts = r.khatas.map((k): ExportDoc => {
        const owe = k.closingPaise >= 0
        const amount = rupees(Math.abs(k.closingPaise))
        return {
          style: 'ledger', title: 'BAAKI SUCHNA', contact: true, banks: true, party: partyOf(k.buyer), to: on, file: fileName('Chithi', k.buyer.name),
          letter: [
            t('Shriman {name} ji,', { name: k.buyer.name }),
            owe ? t('{date} tak aapke khate mein {amount} baaki hai. Kripya jald bhugtan karein.', { date: dmyLong(on), amount })
              : t('{date} tak aapke khate mein {amount} jama hai.', { date: dmyLong(on), amount }),
          ],
          columns: [{ label: 'Date' }, { label: 'Particulars', wide: true }, { label: 'DEBIT', num: true }, { label: 'CREDIT', num: true }, { label: 'Balance', num: true }],
          rows: [
            { cells: ['', t('Pichhla baaki'), '', '', bal(k.openingPaise)] },
            ...k.rows.map((x) => ({ cells: [dmy(x.date), [x.title, x.detail].filter(Boolean).join(' · '), amt(x.debitPaise), amt(x.creditPaise), bal(x.balancePaise)] })),
          ],
          foot: ['', owe ? 'BAAKI' : 'JAMA', '', '', bal(k.closingPaise)],
          note: t('Bhugtan upar diye bank khaton mein karein. Hisaab mein farq ho to sampark karein.'),
        }
      })
      setDocs({ style: 'ledger', title: 'BAAKI SUCHNA', file: fileName('Chithi', on), rows: [], parts, party: { description: t('{n} grahak', { n: parts.length }) } })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const chithiRows = (list.data ?? []).filter((p) => p.balancePaise > 0 && (!area || p.area === area) && has(q, p.name, p.code, p.phone))
  return (
    <>
      <div className="toolbar">
        <div className="seg" role="group">
          <button aria-pressed={tab === 'schedule'} onClick={() => { setTab('schedule'); keep({ v: 'schedule' }) }}>{t('Schedule')}</button>
          <button aria-pressed={tab === 'chithi'} onClick={() => { setTab('chithi'); keep({ v: 'chithi' }) }}>{t('Chithi')}</button>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="muted">{t('Tak')}</span>
          <input className="field" type="date" max={todayIst()} value={on} onChange={(e) => { if (e.target.value) { setOn(e.target.value); keep({ on: e.target.value }) } }} /></label>
        {tab === 'chithi' && <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="muted">{t('Aakhri entry')}</span>
            <select className="field" value={last} onChange={(e) => setLast(Number(e.target.value))}>{[3, 5, 10, 20].map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
          <button type="button" className="btn primary" disabled={!picked.length || busy} onClick={() => void print()}>{busy ? '…' : `${t('Print')} (${count(picked.length)})`}</button>
        </>}
      </div>
      <Filters q={q} setQ={setQ} area={area} setArea={(a) => { setArea(a); keep({ area: a }) }} areas={list.areas} />
      {(error || list.error) && <p className="error">{error || list.error}</p>}
      {!list.data ? <Skeleton /> : tab === 'chithi' ? <PickList rows={chithiRows} sel={sel} setSel={setSel} /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Grahak')}</span><span className="v">{count(due.length)}</span></div>
            <div><span className="lb">{t('Kul baaki')}</span><span className="v due">{rupees(total)}</span></div>
          </div>
          <div className="card wrap-x">
            <table className="tbl fold">
              <thead><tr><th className="opt-col">{t('Code')}</th><th>{t('Grahak')}</th><th className="opt-col">{t('Area')}</th><th className="opt-col">{t('Mobile')}</th><th className="num">{t('Baaki')}</th></tr></thead>
              <tbody>
                {due.map((p) => (
                  <tr key={p.id} data-row tabIndex={0} onClick={() => { location.hash = href({ page: 'grahak', shopId, buyerId: p.id }) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') location.hash = href({ page: 'grahak', shopId, buyerId: p.id }) }}>
                    <td className="opt-col">{p.code ? <span className="code">{p.code}</span> : null}</td>
                    <td className="main-col"><b className="name">{p.name}</b><small>{[p.area, MOBILE.test(p.phone) ? phone(p.phone) : ''].filter(Boolean).join(' · ')}</small></td>
                    <td className="opt-col muted">{p.area}</td>
                    <td className="opt-col muted">{MOBILE.test(p.phone) ? phone(p.phone) : ''}</td>
                    <td className="num amt-col money b due">{rupees(p.balancePaise)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td className="opt-col" /><td className="main-col">{t('Kul')}</td><td className="opt-col" /><td className="opt-col" /><td className="num amt-col money">{rupees(total)}</td></tr></tfoot>
            </table>
            {due.length === 0 && <p className="empty">{t('Kisi par baaki nahi')}</p>}
          </div>
        </>
      )}
    </>
  )
}
