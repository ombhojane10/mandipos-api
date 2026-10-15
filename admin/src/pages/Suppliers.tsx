import { useState } from 'react'
import { api, type SupplierKhata as Khata, type Suppliers as List } from '../api'
import { ago, count, rupees } from '../format'
import { href } from '../routes'
import { useLoad } from '../useLoad'
import { Ages, Bal, Crumb, Ledger, Skeleton } from '../ui'

/** Every supplier: gaadis, kharid, diya, and what the shop still has to give — aged. */
export function Suppliers({ shopId }: { shopId: string }) {
  const [q, setQ] = useState('')
  const { data, error } = useLoad(() => api<List>(`/v1/admin/shops/${shopId}/suppliers`), [shopId])
  const query = q.trim().toLowerCase()
  const rows = (data?.rows ?? []).filter((r) => !query || r.name.toLowerCase().includes(query))
  const open = (key: string) => { location.hash = href({ page: 'supplier', shopId, key }) }

  return (
    <>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className="stack">
          <div className="grid g3">
            <div className="card kpi" style={{ flexDirection: 'column', gap: 2 }}>
              <span className="lb">Supplier ko dena</span>
              <span className="v">{rupees(data.totals.duePaise)}</span>
              <span className="s">{count(data.totals.count)} supplier</span>
            </div>
            <div className="card" style={{ gridColumn: 'span 2', padding: '6px 16px 14px' }}>
              <Ages b={data.totals} total={data.totals.duePaise} />
            </div>
          </div>
          <div className="toolbar" style={{ margin: 0 }}>
            <input className="field grow" data-search type="search" placeholder="Supplier ka naam" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="card wrap-x">
            <table className="tbl fold">
              <thead><tr><th>Supplier</th><th className="num">Gaadi</th><th className="num">Kharid</th><th className="num">Diya</th><th className="num">Baaki</th><th>Aakhri</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} data-row tabIndex={0} onClick={() => open(r.key)} onKeyDown={(e) => { if (e.key === 'Enter') open(r.key) }}>
                    <td className="main-col"><b>{r.name}</b><small>{count(r.gaadis)} gaadi{r.openGaadis ? ` · ${r.openGaadis} khuli` : ''}</small></td>
                    <td className="num opt-col">{count(r.gaadis)}</td>
                    <td className="num opt-col money">{rupees(r.purchasePaise)}</td>
                    <td className="num opt-col money">{rupees(r.paidPaise)}</td>
                    <td className="num amt-col"><Bal paise={r.duePaise} who="supplier" /></td>
                    <td className="opt-col muted">{r.lastAt ? ago(r.lastAt).replace('Just now', 'abhi').replace(' ago', ' pehle') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="empty">Koi supplier nahi</p>}
          </div>
        </div>
      )}
    </>
  )
}

/** One supplier's khata: each gaadi (kharid) and each payment (diya), running baaki. */
export function SupplierKhata({ shopId, supplierKey }: { shopId: string; supplierKey: string }) {
  const back = href({ page: 'report', shopId, report: 'suppliers' })
  const { data, error } = useLoad(() => api<Khata>(`/v1/admin/shops/${shopId}/suppliers/${encodeURIComponent(supplierKey)}`), [shopId, supplierKey])
  if (error) return <><Crumb to={back}>Supplier Khata</Crumb><p className="error">{error}</p></>
  if (!data) return <><Crumb to={back}>Supplier Khata</Crumb><Skeleton /></>
  const t = data.totals
  return (
    <div className="stack">
      <div>
        <Crumb to={back}>Supplier Khata</Crumb>
        <h1>{data.name}</h1>
      </div>
      <div className="card sum">
        <div><span className="lb">Baaki</span><span className="v"><Bal paise={t.duePaise} who="supplier" /></span></div>
        <div><span className="lb">Kharid</span><span className="v">{rupees(t.purchasePaise)}</span></div>
        <div><span className="lb">Diya</span><span className="v">{rupees(t.paidPaise)}</span></div>
        <div><span className="lb">Gaadi</span><span className="v">{count(t.gaadis)} · {count(t.dana)} nag</span></div>
      </div>
      <Ledger who="supplier" closingPaise={t.duePaise}
        rows={data.history.map((r) => ({ ...r, detail: r.kind === 'gaadi' ? [r.detail, r.open ? `${count(r.left)} baaki` : 'band'].filter(Boolean).join(' · ') : r.detail }))} />
    </div>
  )
}
