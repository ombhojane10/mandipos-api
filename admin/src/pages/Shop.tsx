import { useEffect, useState } from 'react'
import { api, type BuyerRow, type ShopDetail, type Summary } from '../api'
import { href } from '../routes'
import { addDays, ago, count, date, phone, rupees, todayIst } from '../format'
import { useLoad } from '../useLoad'
import { SalesChart } from '../SalesChart'

type Tab = 'overview' | 'customers' | 'team'

export function ShopPage({ shopId, tab }: { shopId: string; tab: Tab }) {
  const { data: shop, error } = useLoad(() => api<ShopDetail>(`/v1/admin/shops/${shopId}`), [shopId])
  if (error) return <p className="error">{error}</p>
  if (!shop) return <h1 className="sk-line">&nbsp;</h1>

  return (
    <>
      <a className="back" href="#/shops">‹ Shops</a>
      <h1>{shop.name}</h1>
      <p className="muted sub">
        {[shop.mandi, shop.shopNo && `Shop ${shop.shopNo}`, shop.owner.name, phone(shop.owner.phone)].filter(Boolean).join(' · ')}
      </p>
      {shop.status !== 'approved' ? (
        <p className="card">This shop is {shop.status}. Its books open once it is approved.</p>
      ) : (
        <>
          <nav className="tabs" aria-label="Shop">
            {(['overview', 'customers', 'team'] as Tab[]).map((t) => (
              <a key={t} href={href({ page: 'shop', shopId, tab: t })} aria-current={t === tab ? 'page' : undefined}>
                {t === 'overview' ? 'Overview' : t === 'customers' ? 'Customers' : 'Team'}
              </a>
            ))}
          </nav>
          {tab === 'overview' && <Overview shopId={shopId} />}
          {tab === 'customers' && <Customers shopId={shopId} />}
          {tab === 'team' && <Team shop={shop} />}
        </>
      )}
    </>
  )
}

const RANGES = [
  { key: 'today', label: 'Today', days: 1 },
  { key: 'yesterday', label: 'Yesterday', days: 1 },
  { key: '7', label: '7 days', days: 7 },
  { key: '30', label: '30 days', days: 30 },
] as const

function rangeOf(key: string): [string, string] {
  const today = todayIst()
  if (key === 'yesterday') return [addDays(today, -1), addDays(today, -1)]
  const r = RANGES.find((x) => x.key === key) ?? RANGES[0]
  return [addDays(today, 1 - r.days), today]
}

function Overview({ shopId }: { shopId: string }) {
  const [range, setRange] = useState('today')
  const [from, to] = rangeOf(range)
  const { data: s, error, loading } = useLoad(
    () => api<Summary>(`/v1/admin/shops/${shopId}/summary?from=${from}&to=${to}`), [shopId, from, to])

  return (
    <>
      <div className="segmented" role="tablist">
        {RANGES.map((r) => (
          <button key={r.key} role="tab" aria-selected={range === r.key} onClick={() => setRange(r.key)}>{r.label}</button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {!s ? <div className="tiles">{Array.from({ length: 8 }, (_, i) => <div key={i} className="tile sk" />)}</div> : (
        <div className={loading ? 'dim' : undefined}>
          <div className="hero">
            <span className="label">Sales</span>
            <span className="big">{rupees(s.salesPaise)}</span>
            <span className="muted">{count(s.slips)} slips · {count(s.nags)} nag</span>
          </div>

          <div className="tiles">
            <Tile label="Cash" value={rupees(s.cashPaise)} />
            <Tile label="UPI" value={rupees(s.upiPaise)} />
            <Tile label="Udhaar given" value={rupees(s.creditLeftPaise)} note="Still unpaid on these slips" />
            <Tile label="Collection" value={rupees(s.collectedCashPaise + s.collectedUpiPaise)}
              note={`${rupees(s.collectedCashPaise)} cash · ${rupees(s.collectedUpiPaise)} UPI`} />
            <Tile label="Mazdoori" value={rupees(s.labourPaise)} />
            <Tile label="Aaya · Gaya" value={`${rupees(s.daybookInPaise)} · ${rupees(s.daybookOutPaise)}`} note="Daybook entries" />
            <Tile label="Phoota" value={`${count(s.spoiledNags)} nag`} />
            <Tile label="Deleted slips" value={count(s.deletedSlips)} note={s.deletedSlips ? rupees(s.deletedPaise) : undefined} />
          </div>

          <h2>Right now</h2>
          <div className="tiles two">
            <Tile label="Total baaki" value={rupees(s.duePaise)} note={`${count(s.dueBuyers)} customers owe`} />
            <Tile label="Stock" value={`${count(s.stockNags)} nag`} note={`${count(s.openTrucks)} open gaadi`} />
          </div>

          {s.series.length > 1 && (
            <>
              <h2>Daily sales</h2>
              <div className="card"><SalesChart series={s.series} /></div>
            </>
          )}

          {s.topBuyers.length > 0 && (
            <>
              <h2>Top customers</h2>
              <div className="table">
                {s.topBuyers.map((b) => (
                  <a key={b.id} className="tr link" href={href({ page: 'customer', shopId, buyerId: b.id })}>
                    <span><b>{b.name}</b></span>
                    <span className="num muted">{count(b.slips)} slips</span>
                    <span className="num">{rupees(b.salesPaise)}</span>
                  </a>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="tile">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {note && <span className="note">{note}</span>}
    </div>
  )
}

function Customers({ shopId }: { shopId: string }) {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  const { data, error, loading } = useLoad(
    () => api<{ buyers: BuyerRow[] }>(`/v1/admin/shops/${shopId}/buyers?q=${encodeURIComponent(query)}`).then((r) => r.buyers), [shopId, query])

  return (
    <>
      <input className="field search" type="search" placeholder="Search name, mobile or A/C code" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
      {error && <p className="error">{error}</p>}
      <div className={`table${loading ? ' dim' : ''}`}>
        <div className="tr th"><span>Customer</span><span className="num hide-sm">Bought</span><span className="num hide-sm">Last slip</span><span className="num">Baaki</span></div>
        {(data ?? []).map((b) => (
          <a key={b.id} className="tr link" href={href({ page: 'customer', shopId, buyerId: b.id })}>
            <span><b>{b.name}</b><small>{[b.phone && phone(b.phone), b.code && `A/C ${b.code}`, b.hidden && 'Hidden'].filter(Boolean).join(' · ')}</small></span>
            <span className="num hide-sm">{rupees(b.boughtPaise)}</span>
            <span className="num hide-sm">{b.lastSlipOn ? date(b.lastSlipOn) : '—'}</span>
            <Balance paise={b.balancePaise} />
          </a>
        ))}
        {data && data.length === 0 && <p className="empty">No customer found</p>}
      </div>
    </>
  )
}

export function Balance({ paise }: { paise: number }) {
  if (paise > 0) return <span className="num due">{rupees(paise)}</span>
  if (paise < 0) return <span className="num jama">{rupees(-paise)} jama</span>
  return <span className="num muted">—</span>
}

function Team({ shop }: { shop: ShopDetail }) {
  return (
    <>
      <h2>Members</h2>
      <div className="table">
        {shop.team.map((m) => (
          <div key={m.phone} className="tr">
            <span><b>{m.name || phone(m.phone)}</b><small>{phone(m.phone)}</small></span>
            <span className="muted">{m.role === 'admin' ? 'Admin' : 'Accountant'}</span>
            <span className="num muted">Since {date(m.joinedAt)}</span>
          </div>
        ))}
      </div>
      <h2>Devices</h2>
      <div className="table">
        {shop.devices.map((d) => (
          <div key={`${d.code}-${d.phone}`} className="tr">
            <span><b>{d.code ?? '—'}</b><small>{d.label}</small></span>
            <span className="muted">{phone(d.phone)}<small>v{d.appVersion}</small></span>
            <span className="num muted">{ago(d.lastSeenAt)}</span>
          </div>
        ))}
      </div>
    </>
  )
}
