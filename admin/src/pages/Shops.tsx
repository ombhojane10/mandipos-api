import { useShops } from '../App'
import { href } from '../routes'
import { ago, phone, rupees } from '../format'
import { Rows } from '../ui'

/** Every approved dukaan with today's bikri; pending requests are one tap away. */
export function Shops({ onSignOut }: { onSignOut: () => void }) {
  const { shops } = useShops()
  const open = (shops ?? []).filter((s) => s.status === 'approved')
  const pending = (shops ?? []).filter((s) => s.status === 'pending').length
  const today = open.reduce((t, s) => t + s.todaySalesPaise, 0)

  return (
    <>
      <div className="head"><h1 className="grow">Dukaan</h1></div>
      {pending > 0 && (
        <a className="row" data-row href="#/requests" style={{ background: 'var(--accent-soft)', borderRadius: 'var(--radius-sm)', border: 0, marginBottom: 12 }}>
          <span className="grow"><b>{pending} nayi dukaan approval ke liye</b><small>Dekhein aur approve karein</small></span>
          <span className="chev">›</span>
        </a>
      )}
      {!shops ? <Rows n={4} /> : (
        <>
          <div className="summary">
            <span className="label">Aaj market ki bikri</span>
            <span className="big">{rupees(today)}</span>
            <span className="line">{open.length} dukaan</span>
          </div>
          <div className="list">
            {open.map((s) => (
              <a key={s.id} className="row" data-row href={href({ page: 'shop', shopId: s.id, tab: 'hisab' })}>
                <span className="grow">
                  <b>{s.name}</b>
                  <small>{[s.mandi, s.shopNo, s.owner.name || phone(s.owner.phone)].filter(Boolean).join(' · ')}</small>
                </span>
                <span className="right">
                  <span className="amt money">{rupees(s.todaySalesPaise)}</span>
                  <small>{s.lastSeenAt ? `Chalu ${ago(s.lastSeenAt).replace('Just now', 'abhi').replace(' ago', ' pehle')}` : 'Kabhi nahi chali'}</small>
                </span>
              </a>
            ))}
            {open.length === 0 && <p className="empty">Abhi koi dukaan nahi</p>}
          </div>
        </>
      )}
      <p className="hint muted" style={{ marginTop: 24, textAlign: 'center' }}>
        <button className="btn ghost" onClick={onSignOut}>Sign out</button>
      </p>
    </>
  )
}
