import { api, type ItemRow } from '../api'
import { usePeriod } from '../hooks'
import { count, rate, rupees } from '../format'
import { useLoad } from '../useLoad'
import { PeriodBar, Skeleton } from '../ui'
import { periodLabel } from '../period'
import { t } from '../i18n'
import { fileName, useExport } from '../export/doc'

/** Maal-wise bikri over the period: nag, average bhav, rakam, and each maal's share. */
export function Items({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('30')
  const { data, error, loading } = useLoad(() => api<ItemRow[]>(`/v1/admin/shops/${shopId}/items?from=${period.from}&to=${period.to}`), [shopId, period.from, period.to])
  const total = (data ?? []).reduce((t, r) => t + r.amountPaise, 0)
  useExport(data ? () => ({
    title: t('Maal-wise Bikri'), period: periodLabel(period), file: fileName(t('Maal-wise Bikri'), period.from, period.to),
    columns: [{ label: t('Maal'), wide: true }, { label: t('Nag'), num: true }, { label: t('Avg bhav'), num: true }, { label: t('Parchi'), num: true }, { label: t('Rakam'), num: true }, { label: t('Hissa'), num: true }],
    rows: data.map((r) => ({ cells: [r.brand, count(r.nags), rate(r.ratePaise), count(r.slips), rupees(r.amountPaise), total ? `${Math.round((r.amountPaise / total) * 100)}%` : ''] })),
    foot: [t('Kul'), count(data.reduce((s, r) => s + r.nags, 0)), '', count(data.reduce((s, r) => s + r.slips, 0)), rupees(total), ''],
  }) : null, [data])
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
                <tr key={r.brand}>
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
