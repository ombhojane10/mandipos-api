import { useState } from 'react'
import { api, type BuyerDetail, type HistoryRow } from '../api'
import { href } from '../routes'
import { count, date, phone, rate, rupees, shortDate } from '../format'
import { useLoad } from '../useLoad'
import { Balance } from './Shop'

export function CustomerPage({ shopId, buyerId }: { shopId: string; buyerId: string }) {
  const { data, error } = useLoad(() => api<BuyerDetail>(`/v1/admin/shops/${shopId}/buyers/${buyerId}`), [shopId, buyerId])
  if (error) return <p className="error">{error}</p>
  if (!data) return <h1 className="sk-line">&nbsp;</h1>
  const { buyer: b, totals: t, history } = data

  const facts = [
    b.phone && ['Mobile', phone(b.phone)],
    b.code && ['A/C', b.code],
    b.kind && ['Type', b.kind],
    b.address && ['Address', b.address],
    b.destination && ['Goes to', b.destination],
    b.vehicle && ['Vehicle', b.vehicle],
    b.creditLimitPaise > 0 && ['Credit limit', rupees(b.creditLimitPaise)],
    b.marketPaise !== null && ['Owes the market', rupees(b.marketPaise)],
  ].filter(Boolean) as [string, string][]

  return (
    <>
      <a className="back" href={href({ page: 'shop', shopId, tab: 'customers' })}>‹ Customers</a>
      <h1>{b.name}</h1>
      {/^[6-9]\d{9}$/.test(b.phone) && <a className="back" href={href({ page: 'person', key: b.phone })}>Whole market ›</a>}
      <dl className="facts">
        {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>

      <div className="tiles">
        <div className="tile">
          <span className="label">{t.balancePaise < 0 ? 'Jama' : 'Baaki'}</span>
          <span className="value"><Balance paise={t.balancePaise} /></span>
        </div>
        <div className="tile"><span className="label">Bought</span><span className="value">{rupees(t.boughtPaise)}</span><span className="note">{count(t.slips)} slips · {count(t.nags)} nag</span></div>
        <div className="tile"><span className="label">Paid</span><span className="value">{rupees(t.paidPaise)}</span></div>
        <div className="tile"><span className="label">Last slip</span><span className="value">{t.lastSlipOn ? date(t.lastSlipOn) : '—'}</span></div>
      </div>

      <h2>History</h2>
      <div className="table history">
        <div className="tr th"><span className="hide-sm">Date</span><span>Entry</span><span className="num hide-sm">Nag</span><span className="num">Debit</span><span className="num">Credit</span><span className="num">Balance</span></div>
        {history.map((r) => <Row key={r.id} r={r} />)}
        {history.length === 0 && <p className="empty">Nothing yet</p>}
      </div>
    </>
  )
}

function Row({ r }: { r: HistoryRow }) {
  const [open, setOpen] = useState(false)
  const lines = r.lines ?? []
  return (
    <>
      <div
        className={`tr${lines.length ? ' link' : ''}`}
        onClick={() => lines.length && setOpen(!open)}
        role={lines.length ? 'button' : undefined}
        aria-expanded={lines.length ? open : undefined}
        tabIndex={lines.length ? 0 : undefined}
        onKeyDown={(e) => { if (lines.length && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(!open) } }}
      >
        <span className="muted hide-sm">{date(r.date)}</span>
        <span>{r.title}<small><span className="show-sm">{shortDate(r.date)} · </span>{r.detail}</small></span>
        <span className="num hide-sm">{r.nags ? count(r.nags) : ''}</span>
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
