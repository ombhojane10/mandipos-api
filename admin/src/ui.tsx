import { useEffect, useState, type ReactNode } from 'react'
import { PERIOD_EVENT, openVoucher } from './keys'
import { addDays, count, dayHeader, rate, rupees, shortDate, spanDays, todayIst } from './format'
import { PRESETS, periodLabel, type Period } from './period'
import type { Buckets } from './api'
import { t } from './i18n'
import { fileName, useExport } from './export/doc'

/**
 * An amount that is owed, in words as well as colour. [who] says whose side it is on:
 * grahak → "baaki" (they owe the shop) / "jama" (shop holds theirs);
 * supplier → "dena" (shop owes him) / "advance"; cash → a plain balance.
 */
export function Bal({ paise, who = 'grahak', plain }: { paise: number; who?: 'grahak' | 'supplier' | 'cash'; plain?: boolean }) {
  if (who === 'cash') return <span className={`money${paise < 0 ? ' due' : ''}`}>{paise < 0 ? '−' : ''}{rupees(Math.abs(paise))}</span>
  if (paise === 0) return <span className="muted">{t('Clear')}</span>
  const pos = paise > 0
  const word = who === 'grahak' ? (pos ? t('baaki') : t('jama')) : (pos ? t('dena') : t('advance'))
  const cls = plain ? '' : pos ? (who === 'grahak' ? ' due' : ' due') : ' jama'
  return <span className={`money b${cls}`}>{rupees(Math.abs(paise))} <small className="inline">{word}</small></span>
}

/** Bal as plain text, for an export. */
export function balText(paise: number, who: 'grahak' | 'supplier' | 'cash' = 'grahak'): string {
  if (who === 'cash') return `${paise < 0 ? '−' : ''}${rupees(Math.abs(paise))}`
  if (paise === 0) return t('Clear')
  const word = who === 'grahak' ? (paise > 0 ? t('baaki') : t('jama')) : (paise > 0 ? t('dena') : t('advance'))
  return `${rupees(Math.abs(paise))} ${word}`
}

export function Kpi({ icon, tone, label, value, sub, to }: { icon: ReactNode; tone: 'green' | 'blue' | 'amber' | 'red'; label: string; value: ReactNode; sub?: ReactNode; to?: string }) {
  const body = (
    <>
      <span className={`ic t-${tone}`}>{icon}</span>
      <span style={{ minWidth: 0 }}>
        <span className="lb">{label}</span>
        <span className="v" style={{ display: 'block' }}>{value}</span>
        {sub && <span className="s">{sub}</span>}
      </span>
    </>
  )
  return to ? <a className="card kpi" href={to}>{body}</a> : <div className="card kpi">{body}</div>
}

export function Change({ now, before }: { now: number; before: number }) {
  if (!before) return now ? <span className="muted">{t('Pichhla ₹0')}</span> : <span className="muted">—</span>
  const pct = Math.round(((now - before) / before) * 100)
  if (pct === 0) return <span className="muted">{t('Pichhle jitna')}</span>
  return <span className={pct > 0 ? 'up' : 'down'}>{pct > 0 ? '↑' : '↓'} {Math.abs(pct)}% <span className="muted" style={{ fontWeight: 400 }}>{t('pichhle se')}</span></span>
}

/** 0–7 / 8–30 / 30+ din: a bar, then the three amounts. */
export function Ages({ b }: { b: Buckets }) {
  return (
    <>
      <div className="ages" style={{ marginTop: 10 }}>
        <div><span className="dot a0" /><span>{t('0–7 din')}</span><span className="money">{rupees(b.d0_7)}</span></div>
        <div><span className="dot a1" /><span>{t('8–30 din')}</span><span className="money">{rupees(b.d8_30)}</span></div>
        <div><span className="dot a2" /><span>{t('30+ din')}</span><span className={`money${b.d31 ? ' due b' : ''}`}>{rupees(b.d31)}</span></div>
      </div>
    </>
  )
}

export function Crumb({ to, children }: { to: string; children: ReactNode }) {
  return <a className="crumb" href={to}>‹ {children}</a>
}

export function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 14 }}>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="sk" style={{ width: `${45 + ((i * 17) % 45)}%` }} />)}
    </div>
  )
}

/** ‹ period › with presets: arrows step by the period's own length, the label opens a date picker. F2 lands here. */
export function PeriodBar({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const [asking, setAsking] = useState(false)
  const len = spanDays(value.from, value.to)
  const today = todayIst()
  const step = (dir: number) => {
    if (dir > 0 && value.to >= today) return
    onChange({ key: 'custom', from: addDays(value.from, dir * len), to: addDays(value.to, dir * len) })
  }
  // ← → step, F2 asks for From and To (Tally's Change Period).
  useEffect(() => {
    const on = (e: Event) => {
      const what = (e as CustomEvent<'open' | 'prev' | 'next'>).detail
      if (what === 'open') setAsking(true); else step(what === 'prev' ? -1 : 1)
    }
    addEventListener(PERIOD_EVENT, on)
    return () => removeEventListener(PERIOD_EVENT, on)
  })
  return (
    <>
      <div className="seg period" role="group" aria-label={t('Period')}>
        {PRESETS.map((p) => (
          <button key={p.key} aria-pressed={value.key === p.key} onClick={() => onChange(presetOf(p.key))}>{p.label}</button>
        ))}
      </div>
      <div className="stepper">
        <button aria-label={t('Pichhla')} onClick={() => step(-1)}>‹</button>
        <label>
          {periodLabel(value)}
          <input type="date" aria-label={t('Tarikh chunein')} max={today} value={value.to}
            onChange={(e) => e.target.value && onChange({ key: 'custom', from: e.target.value, to: e.target.value })} />
        </label>
        <button aria-label={t('Agla')} disabled={value.to >= today} onClick={() => step(1)}>›</button>
      </div>
      {asking && <PeriodAsk value={value} onClose={() => setAsking(false)} onChange={(p) => { onChange(p); setAsking(false) }} />}
    </>
  )
}

/** From–To, as Tally's F2 asks it. Enter applies, Esc leaves it as it was. */
function PeriodAsk({ value, onChange, onClose }: { value: Period; onChange: (p: Period) => void; onClose: () => void }) {
  const [from, setFrom] = useState(value.from)
  const [to, setTo] = useState(value.to)
  const today = todayIst()
  return (
    <div className="scrim" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label={t('Period badlein')} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
        onSubmit={(e) => { e.preventDefault(); if (from && to) onChange({ key: 'custom', from: from <= to ? from : to, to: from <= to ? to : from }) }}>
        <h3>{t('Period badlein')}</h3>
        <div className="row2">
          <label className="fld"><span className="fld-lb">{t('Se')}</span><input className="field" type="date" autoFocus max={today} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="fld"><span className="fld-lb">{t('Tak')}</span><input className="field" type="date" max={today} value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>{t('Rehne dein')}</button>
          <button type="submit" className="btn primary">{t('Dikhayein')}</button>
        </div>
      </form>
    </div>
  )
}
function presetOf(key: string): Period {
  const today = todayIst()
  const p = PRESETS.find((x) => x.key === key) ?? PRESETS[0]
  const to = addDays(today, -p.back)
  return { key: p.key, from: addDays(to, 1 - p.days), to }
}

export type LedgerRow = {
  id: string; at: string; date: string; title: string; detail: string; shop?: string; nags: number
  debitPaise: number; creditPaise: number; balancePaise: number; void?: boolean
  lines?: { brand: string; grade: string; qty: number; ratePaise: number; leak: boolean }[]
  /** A parchi's row opens its voucher on Enter; [shopId] when the khata spans shops. */
  kind?: string; shopId?: string
}

const WORDS = {
  grahak: { dr: t('Udhaar (Dr)'), cr: t('Jama (Cr)'), drPhone: t('udhaar'), crPhone: t('jama') },
  supplier: { dr: t('Diya (Dr)'), cr: t('Kharid (Cr)'), drPhone: t('diya'), crPhone: t('kharid') },
}

/**
 * Tally's Ledger Vouchers: Tarikh · Vivaran · (Dukaan) · Nag · Dr · Cr · Baaki, newest first,
 * closing balance on top. On a phone each entry folds into one row: what happened on the left,
 * the amount and running balance on the right. A parchi opens to show its maal.
 */
export type LedgerExport = { title: string; name: string; sub?: string; summary?: [string, string][] }

export function Ledger({ rows, withShop, closingPaise, who = 'grahak', shopId, exportAs }: {
  rows: LedgerRow[]; withShop?: boolean; closingPaise: number; who?: 'grahak' | 'supplier'; shopId?: string; exportAs?: LedgerExport
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [all, setAll] = useState(false)
  const w = WORDS[who]
  // Exported the way a khata is read on paper: oldest first, the running baaki on each line.
  useExport(exportAs ? () => {
    const live = rows.filter((r) => !r.void)
    const sum = (k: 'debitPaise' | 'creditPaise' | 'nags') => live.reduce((s, r) => s + r[k], 0)
    return {
      ...exportAs, file: fileName(exportAs.title, exportAs.name),
      columns: [{ label: t('Tarikh') }, { label: t('Vivaran'), wide: true }, ...(withShop ? [{ label: t('Dukaan') }] : []),
        { label: t('Nag'), num: true }, { label: w.dr, num: true }, { label: w.cr, num: true }, { label: t('Baaki'), num: true }],
      rows: [...rows].reverse().map((r) => ({
        strike: r.void,
        cells: [shortDate(r.date), [r.title, r.detail].filter(Boolean).join(' · '), ...(withShop ? [r.shop ?? ''] : []),
          r.nags ? count(r.nags) : '', r.debitPaise ? rupees(r.debitPaise) : '', r.creditPaise ? rupees(r.creditPaise) : '', balText(r.balancePaise, who)],
      })),
      foot: [t('Kul'), '', ...(withShop ? [''] : []), count(sum('nags')), rupees(sum('debitPaise')), rupees(sum('creditPaise')), balText(closingPaise, who)],
    }
  } : null, [rows, closingPaise, exportAs?.name])
  const hasLines = rows.some((r) => r.lines?.length)
  const totals = rows.reduce((t, r) => ({ dr: t.dr + r.debitPaise, cr: t.cr + r.creditPaise }), { dr: 0, cr: 0 })
  const cols = withShop ? 7 : 6
  let lastDay = ''
  return (
    <div className="card">
      <div className="hd">
        <h3>{t('Khata')}</h3>
        {hasLines && <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {t('Poori detail')}</label>}
      </div>
      <div className="wrap-x">
        <table className="tbl fold">
          <thead>
            <tr>
              <th>{t('Tarikh')}</th><th>{t('Vivaran')}</th>{withShop && <th>{t('Dukaan')}</th>}<th className="num">{t('Nag')}</th>
              <th className="num">{w.dr}</th><th className="num">{w.cr}</th><th className="num">{t('Baaki')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="opt-col" /><td className="main-col"><b>{t('Abhi ka baaki')}</b></td>{withShop && <td className="opt-col" />}<td className="opt-col" />
              <td className="num money opt-col">{rupees(totals.dr)}</td><td className="num money opt-col">{rupees(totals.cr)}</td>
              <td className="num amt-col"><Bal paise={closingPaise} who={who} /></td>
            </tr>
            {rows.map((r) => {
              const lines = r.lines ?? []
              const isOpen = all || open.has(r.id)
              const toggle = () => { if (!lines.length) return; const s = new Set(open); if (s.has(r.id)) s.delete(r.id); else s.add(r.id); setOpen(s) }
              const header = r.date !== lastDay ? <tr className="day show-day"><td colSpan={cols}>{dayHeader(r.date)}</td></tr> : null
              lastDay = r.date
              const net = r.debitPaise - r.creditPaise
              return (
                <FragmentRows key={`${r.shop ?? ''}-${r.id}`}>
                  {header}
                  <tr data-row tabIndex={0} className={r.void ? 'void' : undefined} onClick={toggle}
                    onDoubleClick={() => { const sid = r.shopId ?? shopId; if (r.kind === 'slip' && sid) openVoucher(sid, r.id) }}
                    onKeyDown={(e) => {
                      const sid = r.shopId ?? shopId
                      if (e.key === 'Enter' && r.kind === 'slip' && sid) { e.preventDefault(); openVoucher(sid, r.id) }
                      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
                    }}>
                    <td className="opt-col muted">{shortDate(r.date)}</td>
                    <td className="main-col">
                      <span className="name b">{r.title}</span>
                      <small>{[withShop && r.shop, r.detail, r.nags ? t('{n} nag', { n: count(r.nags) }) : ''].filter(Boolean).join(' · ')}</small>
                    </td>
                    {withShop && <td className="opt-col muted">{r.shop}</td>}
                    <td className="num opt-col muted">{r.nags ? count(r.nags) : ''}</td>
                    <td className="num money opt-col">{r.debitPaise ? rupees(r.debitPaise) : ''}</td>
                    <td className="num money opt-col">{r.creditPaise ? rupees(r.creditPaise) : ''}</td>
                    <td className="num amt-col">
                      <span className="sm-block money b">
                        {net === 0 ? <>{rupees(r.debitPaise)} <small className="inline">{t('nakad')}</small></>
                          : net > 0 ? <>+{rupees(net)} <small className="inline">{w.drPhone}</small></>
                          : <>−{rupees(-net)} <small className="inline">{w.crPhone}</small></>}
                      </span>
                      <span className="money"><Bal paise={r.balancePaise} who={who} plain /></span>
                    </td>
                  </tr>
                  {isOpen && lines.length > 0 && (
                    <tr className="open-lines"><td colSpan={cols}>
                      {lines.map((l, i) => (
                        <div key={i} style={{ display: 'flex', gap: 16, padding: '2px 0' }}>
                          <span style={{ flex: 1 }}>{l.brand || t('Maal')} · {t('Grade {g}', { g: l.grade })}{l.leak ? ` · ${t('Leak')}` : ''}</span>
                          <span className="money">{count(l.qty)} × {rate(l.ratePaise)}</span>
                          <span className="money" style={{ minWidth: 90, textAlign: 'right' }}>{rupees(l.qty * l.ratePaise)}</span>
                        </div>
                      ))}
                    </td></tr>
                  )}
                </FragmentRows>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="empty">{t('Koi entry nahi')}</p>}
      </div>
    </div>
  )
}

function FragmentRows({ children }: { children: ReactNode }) { return <>{children}</> }
