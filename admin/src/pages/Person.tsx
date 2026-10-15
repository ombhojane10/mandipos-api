import { useState } from 'react'
import { api, type Person } from '../api'
import { href } from '../routes'
import { count, date, phone, rate, rupees, shortDate } from '../format'
import { useLoad } from '../useLoad'
import { Balance } from './Shop'

type Row = Person['history'][number]

/** One grahak across the market: what they owe each trader, and every trade, newest first. */
export function PersonPage({ personKey }: { personKey: string }) {
  const { data, error } = useLoad(() => api<Person>(`/v1/admin/customers/${encodeURIComponent(personKey)}`), [personKey])
  if (error) return <p className="error">{error}</p>
  if (!data) return <h1 className="sk-line">&nbsp;</h1>
  const { totals: t, traders, history, profile } = data
  const facts = [
    data.phone && ['Mobile', phone(data.phone)],
    profile.kind && ['Type', profile.kind],
    profile.address && ['Address', profile.address],
    profile.destination && ['Goes to', profile.destination],
    profile.vehicle && ['Vehicle', profile.vehicle],
  ].filter(Boolean) as [string, string][]

  return (
    <>
      <a className="back" href="#/">‹ Customers</a>
      <h1>{data.name}</h1>
      <dl className="facts">
        {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>

      <div className="tiles">
        <div className="tile">
          <span className="label">Market udhaar</span>
          <span className="value"><Balance paise={t.balancePaise} /></span>
          <span className="note">{t.owedTo ? `Owes ${t.owedTo} of ${t.traders} traders` : `${t.traders} traders`}</span>
        </div>
        <div className="tile"><span className="label">Bought</span><span className="value">{rupees(t.boughtPaise)}</span><span className="note">{count(t.slips)} slips · {count(t.nags)} nag</span></div>
        <div className="tile"><span className="label">Traders</span><span className="value">{t.traders}</span></div>
        <div className="tile"><span className="label">Last slip</span><span className="value">{lastSlip(traders) ?? '—'}</span></div>
      </div>

      <h2>Udhaar by trader</h2>
      <div className="table">
        <div className="tr th"><span>Trader</span><span className="num hide-sm">Bought</span><span className="num hide-sm">Last slip</span><span className="num">Baaki</span></div>
        {traders.map((tr) => (
          <a key={`${tr.shopId}-${tr.buyerId}`} className="tr link" href={href({ page: 'customer', shopId: tr.shopId, buyerId: tr.buyerId })}>
            <span>
              <b>{tr.shopName}</b>
              <small>{[tr.mandi, tr.code && `A/C ${tr.code}`, tr.marketPaise !== null && `Says owes market ${rupees(tr.marketPaise)}`].filter(Boolean).join(' · ')}</small>
            </span>
            <span className="num hide-sm">{rupees(tr.boughtPaise)}<small>{count(tr.slips)} slips</small></span>
            <span className="num hide-sm">{tr.lastSlipOn ? date(tr.lastSlipOn) : '—'}</span>
            <Balance paise={tr.balancePaise} />
          </a>
        ))}
      </div>

      <h2>Trades</h2>
      <div className="table history">
        <div className="tr th"><span className="hide-sm">Date</span><span>Entry</span><span className="hide-sm">Trader</span><span className="num">Debit</span><span className="num">Credit</span><span className="num">Market</span></div>
        {history.map((r) => <Trade key={`${r.shopId}-${r.id}`} r={r} />)}
        {history.length === 0 && <p className="empty">Nothing yet</p>}
      </div>
    </>
  )
}

function lastSlip(traders: Person['traders']): string | null {
  const d = traders.map((t) => t.lastSlipOn).filter((x): x is string => !!x).sort().at(-1)
  return d ? date(d) : null
}

function Trade({ r }: { r: Row }) {
  const [open, setOpen] = useState(false)
  const lines = r.lines ?? []
  const toggle = () => lines.length && setOpen(!open)
  return (
    <>
      <div
        className={`tr${lines.length ? ' link' : ''}`} onClick={toggle}
        role={lines.length ? 'button' : undefined} aria-expanded={lines.length ? open : undefined} tabIndex={lines.length ? 0 : undefined}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
      >
        <span className="muted hide-sm">{date(r.date)}</span>
        <span>{r.title}<small><span className="show-sm">{shortDate(r.date)} · {r.shopName} · </span>{r.detail}{r.nags ? ` · ${count(r.nags)} nag` : ''}</small></span>
        <span className="hide-sm muted">{r.shopName}</span>
        <span className="num">{r.debitPaise ? rupees(r.debitPaise) : ''}</span>
        <span className="num">{r.creditPaise ? rupees(r.creditPaise) : ''}</span>
        <Balance paise={r.balancePaise} />
      </div>
      {open && (
        <div className="lines">
          {lines.map((l, i) => (
            <div key={i}>
              <span>{l.brand || 'Maal'} · Grade {l.grade}{l.leak ? ' · Leak' : ''}</span>
              <span className="num">{count(l.qty)} × {rate(l.ratePaise)}</span>
              <span className="num">{rupees(l.qty * l.ratePaise)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
