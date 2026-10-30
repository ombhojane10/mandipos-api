import { useState } from 'react'
import { api, type SupplierKhata as Khata, type Suppliers as List } from '../api'
import { ago, count, rupees } from '../format'
import { href } from '../routes'
import { useLoad } from '../useLoad'
import { Bal, Crumb, Ledger, Skeleton } from '../ui'
import { t } from '../i18n'
import { balRs, fileName, rs, useExport } from '../export/doc'

/** Every supplier: gaadis, kharid, diya, and what the shop still has to give — aged. */
export function Suppliers({ shopId }: { shopId: string }) {
  const [q, setQ] = useState('')
  const { data, error } = useLoad(() => api<List>(`/v1/admin/shops/${shopId}/suppliers`), [shopId])
  const query = q.trim().toLowerCase()
  const rows = (data?.rows ?? []).filter((r) => !query || r.name.toLowerCase().includes(query))
  const open = (key: string) => { location.hash = href({ page: 'supplier', shopId, key }) }
  useExport(data ? () => ({
    style: 'book' as const, title: t('Supplier Khata'), file: fileName(t('Supplier Khata')),
    summary: [[t('Supplier ko dena'), rs(data.totals.duePaise)], [t('Supplier'), count(data.totals.count)]],
    columns: [{ label: t('Supplier'), wide: true }, { label: t('Gaadi'), num: true }, { label: t('Kharid'), num: true }, { label: t('Diya'), num: true }, { label: t('Baaki'), num: true }],
    rows: rows.map((r) => ({ cells: [r.name, count(r.gaadis), rs(r.purchasePaise), rs(r.paidPaise), balRs(r.duePaise, 'supplier')] })),
    foot: [t('Kul'), count(rows.reduce((s, r) => s + r.gaadis, 0)), rs(rows.reduce((s, r) => s + r.purchasePaise, 0)), rs(rows.reduce((s, r) => s + r.paidPaise, 0)), balRs(rows.reduce((s, r) => s + r.duePaise, 0), 'supplier')],
  }) : null, [data, query])

  return (
    <>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className="stack">
          <div className="card sum">
            <div><span className="lb">{t('Supplier ko dena')}</span><span className="v">{rupees(data.totals.duePaise)}</span></div>
            <div><span className="lb">{t('Supplier')}</span><span className="v">{count(data.totals.count)}</span></div>
          </div>
          <div className="toolbar" style={{ margin: 0 }}>
            <input className="field grow" data-search type="search" placeholder={t('Supplier ka naam')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="card wrap-x">
            <table className="tbl fold">
              <thead><tr><th>{t('Supplier')}</th><th className="num">{t('Gaadi')}</th><th className="num">{t('Kharid')}</th><th className="num">{t('Diya')}</th><th className="num">{t('Baaki')}</th><th>{t('Aakhri')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} data-row tabIndex={0} onClick={() => open(r.key)} onKeyDown={(e) => { if (e.key === 'Enter') open(r.key) }}>
                    <td className="main-col"><b>{r.name}</b></td>
                    <td className="num opt-col">{count(r.gaadis)}</td>
                    <td className="num opt-col money">{rupees(r.purchasePaise)}</td>
                    <td className="num opt-col money">{rupees(r.paidPaise)}</td>
                    <td className="num amt-col"><Bal paise={r.duePaise} who="supplier" /></td>
                    <td className="opt-col muted">{r.lastAt ? ago(r.lastAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="empty">{t('Koi supplier nahi')}</p>}
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
  if (error) return <><Crumb to={back}>{t('Supplier Khata')}</Crumb><p className="error">{error}</p></>
  if (!data) return <><Crumb to={back}>{t('Supplier Khata')}</Crumb><Skeleton /></>
  const tot = data.totals
  return (
    <div className="stack">
      <div>
        <Crumb to={back}>{t('Supplier Khata')}</Crumb>
        <h1>{data.name}</h1>
      </div>
      <div className="card sum">
        <div><span className="lb">{t('Baaki')}</span><span className="v"><Bal paise={tot.duePaise} who="supplier" /></span></div>
        {tot.openingPaise !== 0 && <div><span className="lb">{t('Opening')}</span><span className="v"><Bal paise={tot.openingPaise} who="supplier" /></span></div>}
        <div><span className="lb">{t('Kharid')}</span><span className="v">{rupees(tot.purchasePaise)}</span></div>
        <div><span className="lb">{t('Diya')}</span><span className="v">{rupees(tot.paidPaise)}</span></div>
        <div><span className="lb">{t('Gaadi')}</span><span className="v">{count(tot.gaadis)} · {t('{n} nag', { n: count(tot.dana) })}</span></div>
      </div>
      <Ledger who="supplier" closingPaise={tot.duePaise} exportAs={{
        title: 'SUPPLIER LEDGER', party: { description: data.name },
      }}
        rows={data.history.map((r) => ({ ...r, detail: r.kind === 'gaadi' ? [r.detail, r.open ? t('{n} baaki', { n: count(r.left) }) : t('band')].filter(Boolean).join(' · ') : r.detail }))} />
    </div>
  )
}
