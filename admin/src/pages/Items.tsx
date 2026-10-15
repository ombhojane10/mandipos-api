import { api, type ItemRow } from '../api'
import { usePeriod } from '../hooks'
import { count, rate, rupees } from '../format'
import { useLoad } from '../useLoad'
import { PeriodBar, Skeleton } from '../ui'

/** Maal-wise bikri over the period: nag, average bhav, rakam, and each maal's share. */
export function Items({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('30')
  const { data, error, loading } = useLoad(() => api<ItemRow[]>(`/v1/admin/shops/${shopId}/items?from=${period.from}&to=${period.to}`), [shopId, period.from, period.to])
  const total = (data ?? []).reduce((t, r) => t + r.amountPaise, 0)
  return (
    <>
      <div className="toolbar"><PeriodBar value={period} onChange={setPeriod} /></div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th>Maal</th><th className="num">Nag</th><th className="num">Avg bhav</th><th className="num">Parchi</th><th className="num">Rakam</th><th>Hissa</th></tr></thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.brand}>
                  <td className="main-col"><b>{r.brand}</b><small className="show-sm">{count(r.nags)} nag · {rate(r.ratePaise)}</small></td>
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
            {data.length > 1 && <tfoot><tr><td className="main-col">Kul</td><td className="num opt-col money">{count(data.reduce((s, r) => s + r.nags, 0))}</td><td className="opt-col" /><td className="opt-col" /><td className="num amt-col money">{rupees(total)}</td><td className="opt-col" /></tr></tfoot>}
          </table>
          {data.length === 0 && <p className="empty">Is period mein bikri nahi</p>}
        </div>
      )}
    </>
  )
}
