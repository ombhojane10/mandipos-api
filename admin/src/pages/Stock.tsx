import { api, type Stock as S } from '../api'
import { count, rupees, shortDate } from '../format'
import { useLoad } from '../useLoad'
import { Skeleton } from '../ui'
import { t } from '../i18n'
import { fileName, useExport } from '../export/doc'

/** Tally's Stock Summary, gaadi-wise: aaya, gaya, phoota, baaki, and its worth at kharid bhav. */
export function Stock({ shopId }: { shopId: string }) {
  const { data, error } = useLoad(() => api<S>(`/v1/admin/shops/${shopId}/stock`), [shopId])
  useExport(data ? () => ({
    title: t('Stock Summary'), file: fileName(t('Stock Summary'), new Date().toISOString().slice(0, 10)),
    summary: [[t('Baaki maal'), t('{n} nag', { n: count(data.totals.left) })], [t('Kharid bhav par'), rupees(data.totals.valuePaise)], [t('Khuli gaadi'), count(data.totals.gaadis)]],
    columns: [{ label: t('Gaadi'), wide: true }, { label: t('Aayi') }, { label: t('Aaya'), num: true }, { label: t('Gaya'), num: true }, { label: t('Phoota'), num: true }, { label: t('Baaki'), num: true }, { label: t('Keemat'), num: true }],
    rows: data.rows.map((r) => ({ cells: [[r.number, r.supplier, r.brands].filter(Boolean).join(' · '), shortDate(r.arrivedOn), count(r.received), count(r.sold), r.spoiled ? count(r.spoiled) : '', count(r.left), rupees(r.valuePaise)] })),
    foot: [t('Kul'), '', count(data.rows.reduce((s, r) => s + r.received, 0)), count(data.rows.reduce((s, r) => s + r.sold, 0)), count(data.rows.reduce((s, r) => s + r.spoiled, 0)), count(data.totals.left), rupees(data.totals.valuePaise)],
  }) : null, [data])
  if (error) return <p className="error">{error}</p>
  if (!data) return <Skeleton />
  const tot = data.totals
  return (
    <div className="stack">
      <div className="card sum">
        <div><span className="lb">{t('Baaki maal')}</span><span className="v">{t('{n} nag', { n: count(tot.left) })}</span></div>
        <div><span className="lb">{t('Kharid bhav par')}</span><span className="v">{rupees(tot.valuePaise)}</span></div>
        <div><span className="lb">{t('Khuli gaadi')}</span><span className="v">{count(tot.gaadis)}</span></div>
        <div><span className="lb">{t('Purani gaadi')}</span><span className={`v${tot.stale ? ' due' : ''}`}>{count(tot.stale)}</span></div>
      </div>
      <div className="card wrap-x">
        <table className="tbl fold">
          <thead><tr><th>{t('Gaadi')}</th><th>{t('Aayi')}</th><th className="num">{t('Aaya')}</th><th className="num">{t('Gaya')}</th><th className="num">{t('Phoota')}</th><th className="num">{t('Baaki')}</th><th className="num">{t('Keemat')}</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.truckId}>
                <td className="main-col">
                  <b>{r.number}</b> {r.stale && r.left > 0 && <span className="chip amber">{t('Purani')}</span>}
                  <small>{[r.supplier, r.brands].filter(Boolean).join(' · ')}<span className="show-sm"> · {t('{n} din', { n: r.ageDays })} · {t('{a}/{b} bika', { a: count(r.sold), b: count(r.received) })}</span></small>
                </td>
                <td className="opt-col muted">{shortDate(r.arrivedOn)}<small>{r.ageDays === 0 ? t('aaj') : t('{n} din', { n: r.ageDays })}</small></td>
                <td className="num opt-col money">{count(r.received)}</td>
                <td className="num opt-col money">{count(r.sold)}</td>
                <td className="num opt-col money muted">{r.spoiled ? count(r.spoiled) : ''}</td>
                <td className="num amt-col money b">{count(r.left)} <small className="inline">{t('nag')}</small><span className="sm-block muted" style={{ fontWeight: 400 }}>{rupees(r.valuePaise)}</span></td>
                <td className="num opt-col money">{rupees(r.valuePaise)}</td>
              </tr>
            ))}
          </tbody>
          {data.rows.length > 1 && (
            <tfoot><tr>
              <td className="main-col">{t('Kul')}</td><td className="opt-col" />
              <td className="num opt-col money">{count(data.rows.reduce((s, r) => s + r.received, 0))}</td>
              <td className="num opt-col money">{count(data.rows.reduce((s, r) => s + r.sold, 0))}</td>
              <td className="num opt-col money">{count(data.rows.reduce((s, r) => s + r.spoiled, 0))}</td>
              <td className="num amt-col money">{count(tot.left)}</td>
              <td className="num opt-col money">{rupees(tot.valuePaise)}</td>
            </tr></tfoot>
          )}
        </table>
        {data.rows.length === 0 && <p className="empty">{t('Koi khuli gaadi nahi')}</p>}
      </div>
    </div>
  )
}
