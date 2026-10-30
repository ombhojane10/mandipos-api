import { useState } from 'react'
import { api, type ItemRow } from '../api'
import { usePeriod } from '../hooks'
import { count, date, rate, rupees, time } from '../format'
import { openVoucher } from '../keys'
import { useLoad } from '../useLoad'
import { PeriodBar, Skeleton } from '../ui'

import { t } from '../i18n'
import { dayRange, fileName, rs, useExport } from '../export/doc'

/** Maal-wise bikri over the period: nag, average bhav, rakam, and each maal's share. */
export function Items({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('30')
  const [open, setOpen] = useState<string | null>(null)
  const { data, error, loading } = useLoad(() => api<ItemRow[]>(`/v1/admin/shops/${shopId}/items?from=${period.from}&to=${period.to}`), [shopId, period.from, period.to])
  const total = (data ?? []).reduce((t, r) => t + r.amountPaise, 0)
  useExport(data ? () => ({
    style: 'book' as const, title: t('Maal-wise Bikri'), dateLine: dayRange(period.from, period.to), file: fileName(t('Maal-wise Bikri'), period.from, period.to),
    columns: [{ label: t('Maal'), wide: true }, { label: t('Nag'), num: true }, { label: t('Avg bhav'), num: true }, { label: t('Parchi'), num: true }, { label: t('Rakam'), num: true }, { label: t('Hissa'), num: true }],
    rows: data.map((r) => ({ cells: [r.brand, count(r.nags), rate(r.ratePaise), count(r.slips), rs(r.amountPaise), total ? `${Math.round((r.amountPaise / total) * 100)}%` : ''] })),
    foot: [t('Kul'), count(data.reduce((s, r) => s + r.nags, 0)), '', count(data.reduce((s, r) => s + r.slips, 0)), rs(total), ''],
  }) : null, [data, open])
  if (open) return <ItemLines shopId={shopId} brand={open} period={period} setPeriod={setPeriod} onBack={() => setOpen(null)} />
  return (
    <>
      <div className="toolbar"><PeriodBar value={period} onChange={setPeriod} /></div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th>{t('Maal')}</th><th className="num">{t('Nag')}</th><th className="num">{t('Avg bhav')}</th><th className="num">{t('Parchi')}</th><th className="num">{t('Rakam')}</th><th>{t('Hissa')}</th></tr></thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.brand} data-row tabIndex={0} onClick={() => setOpen(r.brand)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(r.brand) }}>
                  <td className="main-col"><b>{r.brand}</b><small className="show-sm">{t('{n} nag', { n: count(r.nags) })} · {rate(r.ratePaise)}</small></td>
                  <td className="num opt-col money">{count(r.nags)}</td>
                  <td className="num opt-col money">{rate(r.ratePaise)}</td>
                  <td className="num opt-col money">{count(r.slips)}</td>
                  <td className="num amt-col money b">{rupees(r.amountPaise)}</td>
                  <td className="opt-col" style={{ width: 160 }}>
                    <div className="agebar" style={{ margin: 0 }}><span className="a0" style={{ width: `${total ? (r.amountPaise / total) * 100 : 0}%`, background: 'var(--accent)' }} /></div>
                  </td>
                </tr>
              ))}
            </tbody>
            {data.length > 1 && <tfoot><tr><td className="main-col">{t('Kul')}</td><td className="num opt-col money">{count(data.reduce((s, r) => s + r.nags, 0))}</td><td className="opt-col" /><td className="opt-col" /><td className="num amt-col money">{rupees(total)}</td><td className="opt-col" /></tr></tfoot>}
          </table>
          {data.length === 0 && <p className="empty">{t('Is period mein bikri nahi')}</p>}
        </div>
      )}
    </>
  )
}

type Lines = {
  brand: string
  lines: { billId: string; slipNo: number | null; at: string; day: string; buyerId: string | null; name: string; qty: number; ratePaise: number; amountPaise: number }[]
  rates: { ratePaise: number; qty: number; amountPaise: number; slips: number }[]
}

/** One maal opened: how much went at each bhav, and every parchi it was sold on — to whom, at what bhav. */
function ItemLines({ shopId, brand, period, setPeriod, onBack }: {
  shopId: string; brand: string; period: ReturnType<typeof usePeriod>[0]; setPeriod: ReturnType<typeof usePeriod>[1]; onBack: () => void
}) {
  const { data, error, loading } = useLoad(() => api<Lines>(`/v1/admin/shops/${shopId}/items/lines?from=${period.from}&to=${period.to}&brand=${encodeURIComponent(brand)}`), [shopId, brand, period.from, period.to])
  const nags = data?.lines.reduce((t, l) => t + l.qty, 0) ?? 0
  const amount = data?.lines.reduce((t, l) => t + l.amountPaise, 0) ?? 0
  useExport(data ? () => ({
    style: 'book' as const, title: `${brand} · ${t('Maal-wise Bikri')}`, dateLine: dayRange(period.from, period.to), file: fileName(brand, period.from, period.to),
    columns: [{ label: t('Tarikh') }, { label: t('Parchi') }, { label: t('Grahak'), wide: true }, { label: t('Nag'), num: true }, { label: t('Bhav'), num: true }, { label: t('Rakam'), num: true }],
    rows: data.lines.map((l) => ({ cells: [date(l.day), l.slipNo ? String(l.slipNo) : '', l.name, count(l.qty), rate(l.ratePaise), rs(l.amountPaise)] })),
    foot: ['', '', t('Kul'), count(nags), nags ? rate(Math.round(amount / nags)) : '', rs(amount)],
  }) : null, [data])
  return (
    <>
      <div className="toolbar">
        <button type="button" className="btn ghost" onClick={onBack}>‹ {t('Maal-wise Bikri')}</button>
        <PeriodBar value={period} onChange={setPeriod} />
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Maal')}</span><span className="v">{brand}</span></div>
            <div><span className="lb">{t('Nag')}</span><span className="v">{count(nags)}</span></div>
            <div><span className="lb">{t('Avg bhav')}</span><span className="v">{nags ? rate(Math.round(amount / nags)) : '—'}</span></div>
            <div><span className="lb">{t('Rakam')}</span><span className="v">{rupees(amount)}</span></div>
          </div>
          {data.rates.length > 0 && (
            <div className={`card wrap-x${loading ? ' dim' : ''}`}>
              <table className="tbl">
                <thead><tr><th>{t('Bhav')}</th><th className="num">{t('Nag')}</th><th className="num">{t('Parchi')}</th><th className="num">{t('Rakam')}</th></tr></thead>
                <tbody>
                  {data.rates.map((r) => (
                    <tr key={r.ratePaise}><td className="money b">{rate(r.ratePaise)}</td><td className="num money">{count(r.qty)}</td><td className="num money">{count(r.slips)}</td><td className="num money">{rupees(r.amountPaise)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className={`card wrap-x${loading ? ' dim' : ''}`}>
            <table className="tbl fold">
              <thead><tr><th className="opt-col">{t('Tarikh')}</th><th className="opt-col">{t('Parchi')}</th><th>{t('Grahak')}</th><th className="num">{t('Nag')}</th><th className="num">{t('Bhav')}</th><th className="num opt-col">{t('Rakam')}</th></tr></thead>
              <tbody>
                {data.lines.map((l, i) => (
                  <tr key={`${l.billId}-${i}`} data-row tabIndex={0} onClick={() => openVoucher(shopId, l.billId)} onKeyDown={(e) => { if (e.key === 'Enter') openVoucher(shopId, l.billId) }}>
                    <td className="opt-col muted money">{date(l.day)}<small>{time(l.at)}</small></td>
                    <td className="opt-col money">{l.slipNo ?? ''}</td>
                    <td className="main-col"><b>{l.name}</b><small className="show-sm">#{l.slipNo} · {date(l.day)} · {rupees(l.amountPaise)}</small></td>
                    <td className="num money">{count(l.qty)}</td>
                    <td className="num money b">{rate(l.ratePaise)}</td>
                    <td className="num opt-col money">{rupees(l.amountPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.lines.length === 0 && <p className="empty">{t('Is period mein bikri nahi')}</p>}
          </div>
        </>
      )}
    </>
  )
}
