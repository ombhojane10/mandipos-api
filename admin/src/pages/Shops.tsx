import { useEffect, useState } from 'react'
import { api, type Shop } from '../api'
import { href } from '../routes'
import { ago, date, phone, rupees } from '../format'
import { useLoad } from '../useLoad'

export function Shops() {
  const { data, error, loading, reload } = useLoad(() => api<{ shops: Shop[] }>('/v1/admin/shops').then((r) => r.shops), [])
  // New requests turn up without a reload.
  useEffect(() => {
    const t = setInterval(reload, 30_000)
    return () => clearInterval(t)
  }, [reload])
  const shops = data ?? []
  const pending = shops.filter((s) => s.status === 'pending')
  const open = shops.filter((s) => s.status === 'approved')
  const rejected = shops.filter((s) => s.status === 'rejected')

  if (loading && !data) return <Skeleton />
  if (error && !data) return <p className="error">{error}</p>

  return (
    <>
      <h1>MandiPlus POS</h1>

      <section className="section">
        <h2>Requests {pending.length > 0 && <span className="badge">{pending.length}</span>}</h2>
        {pending.length > 0 ? (
          <div className="stack">
            {pending.map((s) => <Request key={s.id} shop={s} onDone={reload} />)}
          </div>
        ) : (
          <p className="card muted">No new shop requests. New ones show up here.</p>
        )}
      </section>

      <section className="section">
        <h2>Shops</h2>
        <div className="table">
          <div className="tr th">
            <span>Shop</span><span>Owner</span><span className="num">Today</span><span className="num hide-sm">Devices</span><span className="num hide-sm">Last active</span>
          </div>
          {open.map((s) => (
            <a key={s.id} className="tr link" href={href({ page: 'shop', shopId: s.id, tab: 'overview' })}>
              <span><b>{s.name}</b><small>{[s.mandi, s.shopNo].filter(Boolean).join(' · ')}</small></span>
              <span>{s.owner.name || phone(s.owner.phone)}{s.owner.name && <small>{phone(s.owner.phone)}</small>}</span>
              <span className="num">{rupees(s.todaySalesPaise)}</span>
              <span className="num hide-sm">{s.devices}</span>
              <span className="num hide-sm">{ago(s.lastSeenAt)}</span>
            </a>
          ))}
          {open.length === 0 && <p className="empty">No shops yet</p>}
        </div>
      </section>

      {rejected.length > 0 && (
        <details className="section">
          <summary className="muted">Rejected ({rejected.length})</summary>
          <div className="table">
            {rejected.map((s) => (
              <div key={s.id} className="tr">
                <span><b>{s.name}</b><small>{s.mandi}</small></span>
                <span>{phone(s.owner.phone)}<small>{date(s.createdAt)}</small></span>
                <span className="muted">{s.rejectReason}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
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
    <div className="card request">
      <div className="grow">
        <b>{shop.name}</b>
        <p className="muted">
          {[shop.mandi, shop.shopNo && `Shop ${shop.shopNo}`, shop.commodity === 'amrud' ? 'Amrud' : 'Nariyal', shop.gstin].filter(Boolean).join(' · ')}
        </p>
        <p className="muted">{phone(shop.owner.phone)} · {ago(shop.createdAt)}</p>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <div className="actions">
        <button className="ghost" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
        <button className="primary" disabled={busy} onClick={() => act('approve')}>Approve</button>
      </div>

      {rejecting && (
        <div className="scrim" onClick={() => !busy && setRejecting(false)}>
          <div className="dialog" role="alertdialog" aria-labelledby={`r-${shop.id}`} onClick={(e) => e.stopPropagation()}>
            <h3 id={`r-${shop.id}`}>Reject {shop.name}?</h3>
            <p className="muted">The owner sees this reason in the app and can send a new request.</p>
            <input className="field" placeholder="Reason (optional)" value={reason} maxLength={200} autoFocus onChange={(e) => setReason(e.target.value)} />
            {error && <p className="error" role="alert">{error}</p>}
            <div className="actions end">
              <button className="ghost" disabled={busy} onClick={() => setRejecting(false)}>Cancel</button>
              <button className="danger" disabled={busy} onClick={() => act('reject')}>Reject</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Skeleton() {
  return (
    <>
      <h1>MandiPlus POS</h1>
      <div className="table">{[0, 1, 2, 3].map((i) => <div key={i} className="tr"><span className="sk" /></div>)}</div>
    </>
  )
}
