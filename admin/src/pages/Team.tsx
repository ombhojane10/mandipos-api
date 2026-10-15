import { api, type ShopDetail } from '../api'
import { ago, date, phone } from '../format'
import { useLoad } from '../useLoad'
import { Skeleton } from '../ui'

/** Who is on the team, and which machines are logged in and when they last spoke to the server. */
export function Team({ shopId }: { shopId: string }) {
  const { data, error } = useLoad(() => api<ShopDetail>(`/v1/admin/shops/${shopId}`), [shopId])
  if (error) return <p className="error">{error}</p>
  if (!data) return <Skeleton />
  const seen = (iso: string | null) => (iso ? ago(iso).replace('Just now', 'abhi').replace(' ago', ' pehle') : 'Kabhi nahi')
  return (
    <div className="grid g2-1" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
      <div className="card">
        <div className="hd"><h3>Team</h3></div>
        <table className="tbl fold">
          <tbody>
            {data.team.map((m) => (
              <tr key={m.phone}>
                <td className="main-col"><b>{m.name || phone(m.phone)}</b><small>{phone(m.phone)} · {date(m.joinedAt)} se</small></td>
                <td className="amt-col"><span className={`chip ${m.role === 'admin' ? 'green' : 'grey'}`}>{m.role === 'admin' ? 'Admin' : 'Accountant'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <div className="hd"><h3>Machine</h3></div>
        <table className="tbl fold">
          <tbody>
            {data.devices.map((d) => (
              <tr key={`${d.code}-${d.phone}`}>
                <td className="main-col"><b>{d.code ?? '—'} · {d.label || 'Machine'}</b><small>{phone(d.phone)} · v{d.appVersion}</small></td>
                <td className="amt-col muted">{seen(d.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
