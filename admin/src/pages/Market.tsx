import { useEffect, useState } from 'react'
import { api, type MarketCustomer, type Person as P } from '../api'
import { count, date, phone, rupees, shortDate } from '../format'
import { href } from '../routes'
import { useLoad } from '../useLoad'
import { Bal, Crumb, Ledger, Skeleton } from '../ui'

/** MandiPlus: any grahak across every dukaan, matched by mobile. Empty = who owes the market most. */
export function Market() {
  const [q, setQ] = useState(() => { try { return sessionStorage.getItem('market-q') ?? '' } catch { return '' } })
  const [query, setQuery] = useState(q.trim())
  useEffect(() => {
    const t = setTimeout(() => { setQuery(q.trim()); try { sessionStorage.setItem('market-q', q) } catch { /* private mode */ } }, 250)
    return () => clearTimeout(t)
  }, [q])
  const { data, error, loading } = useLoad(
    () => api<{ customers: MarketCustomer[]; market: { duePaise: number; debtors: number } | null }>(`/v1/admin/customers?q=${encodeURIComponent(query)}`), [query])
  const go = (key: string) => { location.hash = href({ page: 'person', key }) }

  return (
    <div className="stack">
      <input className="field" data-search type="search" placeholder="Naam, mobile ya A/C code — sab dukaan mein" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
      {!query && data?.market && (
        <div className="card sum">
          <div><span className="lb">Market mein kul udhaar</span><span className="v due">{rupees(data.market.duePaise)}</span></div>
          <div><span className="lb">Grahak</span><span className="v">{count(data.market.debtors)}</span></div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th>Grahak</th><th>Dukaan</th><th>Aakhri parchi</th><th className="num">Market baaki</th></tr></thead>
            <tbody>
              {data.customers.map((c) => (
                <tr key={c.key} data-row tabIndex={0} onClick={() => go(c.key)} onKeyDown={(e) => { if (e.key === 'Enter') go(c.key) }}>
                  <td className="main-col"><b>{c.name}</b><small>{c.phone ? phone(c.phone) : 'Mobile nahi'}<span className="show-sm"> · {c.shops.length > 1 ? `${c.shops.length} dukaan` : c.shops[0]?.shopName}</span></small></td>
                  <td className="opt-col muted">{c.shops.map((s) => s.shopName).join(', ')}</td>
                  <td className="opt-col muted">{c.lastSlipOn ? shortDate(c.lastSlipOn) : '—'}</td>
                  <td className="num amt-col"><Bal paise={c.balancePaise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.customers.length === 0 && <p className="empty">Koi grahak nahi mila</p>}
        </div>
      )}
    </div>
  )
}

/** One grahak across the market: kis dukaan ka kitna, and every trade from every dukaan. */
export function Person({ personKey }: { personKey: string }) {
  const { data, error } = useLoad(() => api<P>(`/v1/admin/customers/${encodeURIComponent(personKey)}`), [personKey])
  if (error) return <><Crumb to="#/market">Market Grahak</Crumb><p className="error">{error}</p></>
  if (!data) return <><Crumb to="#/market">Market Grahak</Crumb><Skeleton /></>
  const { totals: t, traders, history, profile } = data
  const last = traders.map((x) => x.lastSlipOn).filter((x): x is string => !!x).sort().at(-1)
  return (
    <div className="stack">
      <div>
        <Crumb to="#/market">Market Grahak</Crumb>
        <div className="head" style={{ marginBottom: 0 }}>
          <div className="grow"><h1>{data.name}</h1><p>{[profile.kind, profile.address, profile.destination && `→ ${profile.destination}`, profile.vehicle].filter(Boolean).join(' · ')}</p></div>
          {data.phone && <a className="call" href={`tel:+91${data.phone}`}>☎ {phone(data.phone)}</a>}
        </div>
      </div>
      <div className="card sum">
        <div><span className="lb">Market baaki</span><span className="v"><Bal paise={t.balancePaise} /></span></div>
        <div><span className="lb">Udhaar</span><span className="v">{t.owedTo} / {t.traders} dukaan</span></div>
        <div><span className="lb">Kharida</span><span className="v">{rupees(t.boughtPaise)}</span></div>
        <div><span className="lb">Parchi</span><span className="v">{count(t.slips)}</span></div>
        {last && <div><span className="lb">Aakhri</span><span className="v">{date(last)}</span></div>}
      </div>
      <div className="card wrap-x">
        <div className="hd"><h3>Kis dukaan ka kitna</h3></div>
        <table className="tbl fold">
          <thead><tr><th>Dukaan</th><th className="num">Kharida</th><th>Aakhri parchi</th><th className="num">Dukaan ke hisaab se market</th><th className="num">Baaki</th></tr></thead>
          <tbody>
            {traders.map((x) => (
              <tr key={`${x.shopId}-${x.buyerId}`} data-row tabIndex={0} onClick={() => { location.hash = href({ page: 'grahak', shopId: x.shopId, buyerId: x.buyerId }) }}
                onKeyDown={(e) => { if (e.key === 'Enter') location.hash = href({ page: 'grahak', shopId: x.shopId, buyerId: x.buyerId }) }}>
                <td className="main-col"><b>{x.shopName}</b><small>{[x.mandi, x.code && `A/C ${x.code}`].filter(Boolean).join(' · ')}{x.marketPaise !== null && <span className="show-sm"> · market {rupees(x.marketPaise)}</span>}</small></td>
                <td className="num opt-col money">{rupees(x.boughtPaise)}</td>
                <td className="opt-col muted">{x.lastSlipOn ? shortDate(x.lastSlipOn) : '—'}</td>
                <td className="num opt-col money muted">{x.marketPaise !== null ? rupees(x.marketPaise) : '—'}</td>
                <td className="num amt-col"><Bal paise={x.balancePaise} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Ledger withShop closingPaise={t.balancePaise} rows={history.map((r) => ({ ...r, shop: r.shopName }))} />
    </div>
  )
}
