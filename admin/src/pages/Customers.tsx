import { useEffect, useState } from 'react'
import { api, type MarketCustomer } from '../api'
import { href } from '../routes'
import { count, phone, rupees, shortDate } from '../format'
import { useLoad } from '../useLoad'
import { Bal, Rows } from '../ui'

/** Home: any grahak in the market. Empty search = who owes the market most. */
export function Customers() {
  const [q, setQ] = useState(() => remembered())
  const [query, setQuery] = useState(q.trim())
  useEffect(() => {
    const t = setTimeout(() => { setQuery(q.trim()); remember(q) }, 250)
    return () => clearTimeout(t)
  }, [q])
  const { data, error, loading } = useLoad(
    () => api<{ customers: MarketCustomer[]; market: { duePaise: number; debtors: number } | null }>(`/v1/admin/customers?q=${encodeURIComponent(query)}`),
    [query])

  return (
    <>
      <div className="head"><h1 className="grow">Grahak</h1></div>
      <input
        className="field search" type="search" inputMode="search" enterKeyHint="search" autoComplete="off"
        placeholder="Naam, mobile ya A/C code" value={q} onChange={(e) => setQ(e.target.value)}
        aria-label="Grahak dhoondhein"
      />
      {error && <p className="error">{error}</p>}

      {!query && data?.market && (
        <div className="summary">
          <span className="label">Market mein kul baaki</span>
          <span className="big due">{rupees(data.market.duePaise)}</span>
          <span className="line">{count(data.market.debtors)} grahak par · sabse zyada baaki pehle</span>
        </div>
      )}

      {!data ? <Rows /> : (
        <div className={`list${loading ? ' dim' : ''}`}>
          {data.customers.map((c) => (
            <a key={c.key} className="row" data-row href={href({ page: 'person', key: c.key })}>
              <span className="grow">
                <b>{c.name}</b>
                <small>{[c.phone ? phone(c.phone) : 'Mobile nahi', traders(c)].join(' · ')}</small>
              </span>
              <span className="right">
                <span className="amt"><Bal paise={c.balancePaise} /></span>
                <small>{c.lastSlipOn ? shortDate(c.lastSlipOn) : ''}</small>
              </span>
            </a>
          ))}
          {data.customers.length === 0 && <p className="empty">“{query}” naam ya number ka koi grahak nahi</p>}
        </div>
      )}
    </>
  )
}

function traders(c: MarketCustomer): string {
  return c.shops.length === 1 ? c.shops[0].shopName : `${c.shops.length} dukaan`
}

// The search survives opening a grahak and coming back.
function remembered(): string {
  try { return sessionStorage.getItem('grahak-q') ?? '' } catch { return '' }
}
function remember(v: string) {
  try { sessionStorage.setItem('grahak-q', v) } catch { /* private mode */ }
}
