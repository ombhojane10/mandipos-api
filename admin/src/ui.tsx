import { useState, type ReactNode } from 'react'
import { addDays, count, dayHeader, rate, rupees, shortDate, spanDays, todayIst } from './format'
import { PRESETS, periodLabel, preset, type Period } from './period'

/** A balance in words as well as colour: "₹38,700 baaki" (they owe) / "₹500 jama" (shop holds theirs). */
export function Bal({ paise, plain }: { paise: number; plain?: boolean }) {
  if (paise > 0) return <span className={`money${plain ? '' : ' due'}`}>{rupees(paise)} <small className="inline">baaki</small></span>
  if (paise < 0) return <span className={`money${plain ? '' : ' jama'}`}>{rupees(-paise)} <small className="inline">jama</small></span>
  return <span className="muted">Clear</span>
}

export function Crumb({ to, children }: { to: string; children: ReactNode }) {
  return <a className="crumb" href={to}>‹ {children}</a>
}

export function Rows({ n = 6 }: { n?: number }) {
  return <div className="list">{Array.from({ length: n }, (_, i) => <div key={i} className="skrow"><div className="sk" style={{ width: `${40 + ((i * 17) % 45)}%` }} /></div>)}</div>
}

/**
 * ‹ period › with presets, like Tally's Day Book in the browser: the arrows step by the
 * period's own length, the label opens a date picker for one day, F2 lands here.
 */
export function PeriodBar({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const len = spanDays(value.from, value.to)
  const today = todayIst()
  const step = (dir: number) => onChange({ key: 'custom', from: addDays(value.from, dir * len), to: addDays(value.to, dir * len) })
  return (
    <div className="period">
      <div className="stepper">
        <button aria-label="Pichhla" onClick={() => step(-1)}>‹</button>
        <label>
          {periodLabel(value)}
          <input type="date" aria-label="Tarikh chunein" id="period-date" max={today} value={value.to}
            onChange={(e) => e.target.value && onChange({ key: 'custom', from: e.target.value, to: e.target.value })} />
        </label>
        <button aria-label="Agla" disabled={value.to >= today} onClick={() => step(1)}>›</button>
      </div>
      <div className="chips">
        {PRESETS.map((p) => (
          <button key={p.key} className="chip" aria-pressed={value.key === p.key} onClick={() => onChange(preset(p.key))}>{p.label}</button>
        ))}
      </div>
    </div>
  )
}

export type LedgerRow = {
  id: string; at: string; date: string; title: string; detail: string; shop?: string; nags: number
  debitPaise: number; creditPaise: number; balancePaise: number; void?: boolean
  lines?: { brand: string; grade: string; qty: number; ratePaise: number; leak: boolean }[]
}

/**
 * Tally's Ledger Vouchers: Date · Particulars · (Dukaan) · Nag · Udhaar (Dr) · Jama (Cr) · Baaki,
 * newest first, closing balance on top. On a phone each entry folds into two lines under a
 * sticky date header. Enter or a tap on a parchi shows what was in it; "Poori detail" opens all.
 */
export function Ledger({ rows, withShop, closingPaise }: { rows: LedgerRow[]; withShop?: boolean; closingPaise: number }) {
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const hasLines = rows.some((r) => r.lines?.length)
  const totals = rows.reduce((t, r) => ({ dr: t.dr + r.debitPaise, cr: t.cr + r.creditPaise }), { dr: 0, cr: 0 })
  let lastDay = ''
  return (
    <>
      {hasLines && (
        <label className="toggle" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Poori detail
        </label>
      )}
      <div className={`ledger${withShop ? ' with-shop' : ''}`}>
        <div className="lhead">
          <span>Tarikh</span><span>Vivaran</span><span className="l-shop">Dukaan</span><span className="num">Nag</span>
          <span className="num">Udhaar (Dr)</span><span className="num">Jama (Cr)</span><span className="num">Baaki</span>
        </div>
        <div className="ltotal">
          <span className="l-date" /><span className="l-part">Abhi ka baaki</span><span className="l-shop" /><span className="l-nag" />
          <span className="num l-dr money">{rupees(totals.dr)}</span><span className="num l-cr money">{rupees(totals.cr)}</span>
          <span className="num l-bal"><Bal paise={closingPaise} /></span>
        </div>
        {rows.map((r) => {
          const lines = r.lines ?? []
          const isOpen = all || open.has(r.id)
          const toggle = () => { if (!lines.length) return; const s = new Set(open); if (s.has(r.id)) s.delete(r.id); else s.add(r.id); setOpen(s) }
          const header = r.date !== lastDay ? <div className="lday">{dayHeader(r.date)}</div> : null
          lastDay = r.date
          const meta = [r.shop, r.detail, r.nags ? `${count(r.nags)} nag` : ''].filter(Boolean).join(' · ')
          return (
            <div key={`${r.shop ?? ''}-${r.id}`}>
              {header}
              <div
                className={`lrow${r.void ? ' void' : ''}`} data-row tabIndex={0}
                role={lines.length ? 'button' : undefined} aria-expanded={lines.length ? isOpen : undefined}
                onClick={toggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
              >
                <span className="l-date muted">{shortDate(r.date)}</span>
                <span className="l-part"><b>{r.title}</b><small>{r.detail}</small></span>
                <span className="l-shop">{r.shop}</span>
                <span className="num l-nag muted">{r.nags ? count(r.nags) : ''}</span>
                <span className="num l-dr money">{r.debitPaise ? rupees(r.debitPaise) : ''}</span>
                <span className="num l-cr money">{r.creditPaise ? rupees(r.creditPaise) : ''}</span>
                <span className="l-amt money">{phoneAmount(r)}</span>
                <span className="l-meta">{meta}</span>
                <span className="num l-bal"><Bal paise={r.balancePaise} plain /></span>
              </div>
              {isOpen && lines.length > 0 && (
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
            </div>
          )
        })}
        {rows.length === 0 && <p className="empty">Koi entry nahi</p>}
      </div>
    </>
  )
}

/** One amount for a phone row: what this entry did to the balance, in words. */
function phoneAmount(r: LedgerRow): ReactNode {
  if (r.debitPaise && r.creditPaise) {
    const net = r.debitPaise - r.creditPaise
    if (net === 0) return <span>{rupees(r.debitPaise)} <small className="inline">nakad</small></span>
    return <span className={net > 0 ? 'due' : 'jama'}>{rupees(Math.abs(net))} <small className="inline">{net > 0 ? 'udhaar' : 'jama'}</small></span>
  }
  if (r.debitPaise) return <span className="due">+{rupees(r.debitPaise)} <small className="inline">udhaar</small></span>
  if (r.creditPaise) return <span className="jama">−{rupees(r.creditPaise)} <small className="inline">jama</small></span>
  return null
}
