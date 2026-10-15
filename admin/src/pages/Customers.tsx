import { useEffect, useState } from 'react'
import { api, type MarketCustomer } from '../api'
import { href } from '../routes'
import { date, phone } from '../format'
import { useLoad } from '../useLoad'
import { Balance } from './Shop'

/** The landing page: any grahak in the market, by name, mobile or A/C code. Empty = biggest udhaar. */
export function Customers() {
  const [q, setQ] = useState(() => sessionStorageGet('customers-q'))
  const [query, setQuery] = useState(q.trim())
  useEffect(() => {
    const t = setTimeout(() => { setQuery(q.trim()); sessionStorageSet('customers-q', q) }, 250)
    return () => clearTimeout(t)
  }, [q])
  const { data, error, loading } = useLoad(
    () => api<{ customers: MarketCustomer[] }>(`/v1/admin/customers?q=${encodeURIComponent(query)}`).then((r) => r.customers), [query])

  return (
    <>
      <h1>Customers</h1>
      <input className="field search" type="search" placeholder="Search name, mobile or A/C code" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
      {error && <p className="error">{error}</p>}
      {!query && data && data.length > 0 && <p className="muted hint">Most udhaar in the market</p>}
      <div className={`table${loading ? ' dim' : ''}`}>
        <div className="tr th"><span>Customer</span><span className="hide-sm">Traders</span><span className="num hide-sm">Last slip</span><span className="num">Market udhaar</span></div>
        {(data ?? []).map((c) => (
          <a key={c.key} className="tr link" href={href({ page: 'person', key: c.key })}>
            <span><b>{c.name}</b><small>{c.phone ? phone(c.phone) : 'No mobile'}</small></span>
            <span className="hide-sm muted">{c.shops.map((s) => s.shopName).join(', ')}</span>
            <span className="num hide-sm">{c.lastSlipOn ? date(c.lastSlipOn) : '—'}</span>
            <Balance paise={c.balancePaise} />
          </a>
        ))}
        {data && data.length === 0 && <p className="empty">No customer found</p>}
      </div>
    </>
  )
}

// The search survives going into a customer and coming back.
function sessionStorageGet(k: string): string {
  try { return sessionStorage.getItem(k) ?? '' } catch { return '' }
}
function sessionStorageSet(k: string, v: string) {
  try { sessionStorage.setItem(k, v) } catch { /* private mode */ }
}
