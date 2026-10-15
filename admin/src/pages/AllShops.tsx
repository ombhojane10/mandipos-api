import { useSession } from '../App'
import { ago, count, phone, rupees } from '../format'
import { href } from '../routes'
import { Skeleton } from '../ui'

/** MandiPlus: every dukaan, today's bikri, when each was last active. */
export function AllShops() {
  const { shops } = useSession()
  if (!shops) return <Skeleton rows={4} />
  const open = shops.filter((s) => s.status === 'approved')
  const pending = shops.filter((s) => s.status === 'pending').length
  const today = open.reduce((t, s) => t + s.todaySalesPaise, 0)
  const go = (id: string) => { location.hash = href({ page: 'report', shopId: id, report: 'dashboard' }) }
  return (
    <div className="stack">
      {pending > 0 && <a className="card" href="#/requests" style={{ padding: 14, display: 'flex', gap: 10, alignItems: 'center', background: 'var(--accent-soft)', borderColor: 'transparent' }}>
        <span className="badge">{pending}</span><b style={{ flex: 1 }}>Nayi dukaan approval ke liye</b><span>›</span></a>}
      <div className="card sum">
        <div><span className="lb">Aaj market ki bikri</span><span className="v">{rupees(today)}</span></div>
        <div><span className="lb">Dukaan</span><span className="v">{count(open.length)}</span></div>
      </div>
      <div className="card wrap-x">
        <table className="tbl fold">
          <thead><tr><th>Dukaan</th><th>Malik</th><th className="num">Machine</th><th>Chalu</th><th className="num">Aaj bikri</th></tr></thead>
          <tbody>
            {open.map((s) => (
              <tr key={s.id} data-row tabIndex={0} onClick={() => go(s.id)} onKeyDown={(e) => { if (e.key === 'Enter') go(s.id) }}>
                <td className="main-col"><b>{s.name}</b><small>{[s.mandi, s.shopNo].filter(Boolean).join(' · ')}</small></td>
                <td className="opt-col">{s.owner.name || phone(s.owner.phone)}</td>
                <td className="num opt-col">{s.devices}</td>
                <td className="opt-col muted">{s.lastSeenAt ? ago(s.lastSeenAt).replace('Just now', 'abhi').replace(' ago', ' pehle') : '—'}</td>
                <td className="num amt-col money b">{rupees(s.todaySalesPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
