import { useState } from 'react'
import { api, type Shop } from '../api'
import { useSession } from '../App'
import { ago, date, phone } from '../format'
import { Skeleton } from '../ui'

/** New shops waiting for approval; the owner's app opens the shop the moment it is approved. */
export function Requests() {
  const { shops, reload } = useSession()
  if (!shops) return <Skeleton rows={3} />
  const pending = shops.filter((s) => s.status === 'pending')
  const rejected = shops.filter((s) => s.status === 'rejected')
  return (
    <div className="stack">
      {pending.length > 0
        ? <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>{pending.map((s) => <Request key={s.id} shop={s} onDone={reload} />)}</div>
        : <div className="card empty">Koi nayi request nahi</div>}
      {rejected.length > 0 && (
        <div className="card wrap-x">
          <div className="hd"><h3>Reject ki gayi</h3></div>
          <table className="tbl fold"><tbody>
            {rejected.map((s) => (
              <tr key={s.id}>
                <td className="main-col"><b>{s.name}</b><small>{[s.mandi, phone(s.owner.phone), date(s.createdAt)].filter(Boolean).join(' · ')}</small></td>
                <td className="amt-col muted">{s.rejectReason}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
    </div>
  )
}

function Request({ shop, onDone }: { shop: Shop; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')

  async function act(path: 'approve' | 'reject') {
    setBusy(true); setError('')
    try {
      await api(`/v1/admin/shops/${shop.id}/${path}`, { method: 'POST', body: path === 'reject' ? { reason } : {} })
      setRejecting(false)
      onDone()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="card req">
      <b style={{ fontSize: 16 }}>{shop.name}</b>
      <span className="muted">{[shop.mandi, shop.shopNo && `Dukaan ${shop.shopNo}`, shop.commodity === 'amrud' ? 'Amrud' : 'Nariyal', shop.gstin].filter(Boolean).join(' · ')}</span>
      <span className="muted"><a className="call" href={`tel:+91${shop.owner.phone}`}>☎ {phone(shop.owner.phone)}</a> · {ago(shop.createdAt).replace('Just now', 'abhi').replace(' ago', ' pehle')}</span>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn primary" disabled={busy} onClick={() => act('approve')}>Approve</button>
        <button className="btn line" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
      </div>
      {rejecting && (
        <div className="scrim" onClick={() => !busy && setRejecting(false)}>
          <div className="dialog" role="alertdialog" aria-labelledby={`r-${shop.id}`} onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Escape') setRejecting(false) }}>
            <h3 id={`r-${shop.id}`}>{shop.name} reject karein?</h3>
            <p className="muted">Dukaan wale ko app mein yeh wajah dikhegi.</p>
            <input className="field" placeholder="Wajah (optional)" value={reason} maxLength={200} autoFocus onChange={(e) => setReason(e.target.value)} />
            {error && <p className="error" role="alert">{error}</p>}
            <div className="actions">
              <button className="btn ghost" disabled={busy} onClick={() => setRejecting(false)}>Rehne dein</button>
              <button className="btn danger" disabled={busy} onClick={() => act('reject')}>Reject</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
