import { api, type Stock as S } from '../api'
import { count, rupees, shortDate } from '../format'
import { useLoad } from '../useLoad'
import { Skeleton } from '../ui'

/** Tally's Stock Summary, gaadi-wise: aaya, gaya, phoota, baaki, and its worth at kharid bhav. */
export function Stock({ shopId }: { shopId: string }) {
  const { data, error } = useLoad(() => api<S>(`/v1/admin/shops/${shopId}/stock`), [shopId])
  if (error) return <p className="error">{error}</p>
  if (!data) return <Skeleton />
  const t = data.totals
  return (
    <div className="stack">
      <div className="card sum">
        <div><span className="lb">Baaki maal</span><span className="v">{count(t.left)} nag</span></div>
        <div><span className="lb">Kharid bhav par</span><span className="v">{rupees(t.valuePaise)}</span></div>
        <div><span className="lb">Khuli gaadi</span><span className="v">{count(t.gaadis)}</span></div>
        <div><span className="lb">Purani gaadi</span><span className={`v${t.stale ? ' due' : ''}`}>{count(t.stale)}</span></div>
      </div>
      <div className="card wrap-x">
        <table className="tbl fold">
          <thead><tr><th>Gaadi</th><th>Aayi</th><th className="num">Aaya</th><th className="num">Gaya</th><th className="num">Phoota</th><th className="num">Baaki</th><th className="num">Keemat</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.truckId}>
                <td className="main-col">
                  <b>{r.number}</b> {r.stale && r.left > 0 && <span className="chip amber">Purani</span>}
                  <small>{[r.supplier, r.brands].filter(Boolean).join(' · ')}<span className="show-sm"> · {r.ageDays} din · {count(r.sold)}/{count(r.received)} bika</span></small>
                </td>
                <td className="opt-col muted">{shortDate(r.arrivedOn)}<small>{r.ageDays === 0 ? 'aaj' : `${r.ageDays} din`}</small></td>
                <td className="num opt-col money">{count(r.received)}</td>
                <td className="num opt-col money">{count(r.sold)}</td>
                <td className="num opt-col money muted">{r.spoiled ? count(r.spoiled) : ''}</td>
                <td className="num amt-col money b">{count(r.left)} <small className="inline">nag</small><span className="sm-block muted" style={{ fontWeight: 400 }}>{rupees(r.valuePaise)}</span></td>
                <td className="num opt-col money">{rupees(r.valuePaise)}</td>
              </tr>
            ))}
          </tbody>
          {data.rows.length > 1 && (
            <tfoot><tr>
              <td className="main-col">Kul</td><td className="opt-col" />
              <td className="num opt-col money">{count(data.rows.reduce((s, r) => s + r.received, 0))}</td>
              <td className="num opt-col money">{count(data.rows.reduce((s, r) => s + r.sold, 0))}</td>
              <td className="num opt-col money">{count(data.rows.reduce((s, r) => s + r.spoiled, 0))}</td>
              <td className="num amt-col money">{count(t.left)}</td>
              <td className="num opt-col money">{rupees(t.valuePaise)}</td>
            </tr></tfoot>
          )}
        </table>
        {data.rows.length === 0 && <p className="empty">Koi khuli gaadi nahi</p>}
      </div>
    </div>
  )
}
