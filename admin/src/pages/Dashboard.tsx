import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import NumberFlow from '@number-flow/react'
import { Area, AreaChart, Bar, BarChart, Cell, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, type Buckets, type Dashboard as Dash, type DayEntry } from '../api'
import { usePeriod } from '../hooks'
import { addDays, count, rupees, shortDate, spanDays, time } from '../format'
import { href, periodQuery, type Report } from '../routes'
import { useLoad } from '../useLoad'
import { PeriodBar } from '../ui'
import * as I from '../icons'
import { openEntry, type EntryKind } from '../entries/kinds'
import { openRaseed, openVoucher } from '../keys'
import { MicIcon } from '../voice/MicIcon'
import { t } from '../i18n'
import { useSession } from '../App'
import { AngoorStrip } from './Angoor'
import { HEADS } from './DayBook'
import { openScan } from '../Scan'
import { compact, hourLabel, istHour, paymentsOf, perSlot, series, slipsOf, type Books, type Metric } from './dash/series'

const QUICK: { kind: EntryKind; key: string; label: string; icon: () => ReactNode }[] = [
  { kind: 'parchi', key: 'F8', label: t('Nayi Parchi'), icon: I.IRupee },
  { kind: 'vasooli', key: 'F6', label: t('Vasooli'), icon: I.IWallet },
  { kind: 'kharcha', key: 'N K', label: t('Kharcha'), icon: I.ICash },
  { kind: 'gaadi', key: 'F9', label: t('Nayi Gaadi'), icon: I.ITruck },
]

const C = { accent: '#0f766e', before: '#a3aab5', cash: '#12a150', upi: '#5b5bd6', udhaar: '#e8890c' }
const INR = { style: 'currency', currency: 'INR', maximumFractionDigits: 0 } as const
const rise = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } } as const

/** The shop at a glance: where the money is, how the period went against the last one, and what just happened. */
export function Dashboard({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod()
  const angoor = useSession().shops?.find((s) => s.id === shopId)?.commodity === 'angoor'
  const unit = angoor ? t('box') : t('nag')
  const { from, to } = period
  const len = spanDays(from, to)
  const pFrom = addDays(from, -len), pTo = addDays(from, -1)
  const { data, error, loading } = useLoad(async (): Promise<Books> => {
    const day = (a: string, b: string) => api<{ entries: DayEntry[] }>(`/v1/admin/shops/${shopId}/daybook?from=${a}&to=${b}`).then((r) => r.entries)
    const [d, prev, book, prevBook] = await Promise.all([
      api<Dash>(`/v1/admin/shops/${shopId}/dashboard?from=${from}&to=${to}`),
      api<Dash>(`/v1/admin/shops/${shopId}/dashboard?from=${pFrom}&to=${pTo}`),
      day(from, to), day(pFrom, pTo),
    ])
    return { d, prev, book, prevBook }
  }, [shopId, from, to])
  const go = (report: Report) => href({ page: 'report', shopId, report }) + periodQuery()

  return (
    <div className="pro-dash">
      <BoloBar shopId={shopId} angoor={angoor} />
      <div className="pro-actions">
        {angoor && <button type="button" onClick={() => openScan(shopId)}><I.IScan /><span>{t('Scan')}</span></button>}
        {QUICK.map((q) => (
          <button key={q.kind} type="button" onClick={() => openEntry(q.kind)}><q.icon /><span>{q.label}</span><kbd>{q.key}</kbd></button>
        ))}
      </div>
      <div className="pro-bar"><PeriodBar value={period} onChange={setPeriod} /></div>
      {error && <p className="error">{error}</p>}
      {!data ? <DashSkeleton /> : (
        <div className={`pro-stack${loading ? ' dim' : ''}`}>
          <Paisa d={data.d} go={go} />
          <Overview books={data} from={from} to={to} />
          <Insights books={data} from={from} to={to} unit={unit} />
          {angoor && <AngoorStrip shopId={shopId} from={from} to={to} />}
          <div className="pro-grid g3">
            <Split slips={slipsOf(data.book)} />
            <Owed title={t('Udhaar (lena)')} due={data.d.receivables} who={t('{n} grahak', { n: count(data.d.receivables.count) })} to={go('outstanding')} tone="due" />
            <Owed title={t('Supplier (dena)')} due={data.d.payables} who={t('{n} supplier', { n: count(data.d.payables.count) })} to={go('suppliers')} />
          </div>
          <div className="pro-grid g2-1">
            <Hours slips={slipsOf(data.book)} />
            <TopGrahak shopId={shopId} slips={slipsOf(data.book)} />
          </div>
          <YaadCard shopId={shopId} />
          <div className="pro-grid g2">
            <Feed shopId={shopId} entries={data.book.slice(0, 9)} more={go('daybook')} />
            <div className="pro-col">
              <Items items={data.d.items} unit={unit} more={go('items')} />
              <StockCard shopId={shopId} unit={unit} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Like a payments console's "ask" bar: one line, an example question turning over. */
function BoloBar({ shopId, angoor }: { shopId: string; angoor: boolean }) {
  const asks = angoor
    ? [t('aaj kitna bika?'), t('Sharma ko 20 box Royal 450 bhav'), t('kiska udhaar sabse zyada hai?'), t('kal kitni gaadi aayi?')]
    : [t('aaj kitna bika?'), t('kiska udhaar sabse zyada hai?'), t('is hafte ki vasooli?'), t('galla mein kitna hai?')]
  const [i, setI] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % asks.length), 3200)
    return () => clearInterval(id)
  }, [asks.length])
  return (
    <a className="pro-bolo" href={href({ page: 'report', shopId, report: 'bolo' })}>
      <span className="pro-bolo-ic"><MicIcon /></span>
      <span className="pro-bolo-lb">{t('Bolo')}</span>
      <span className="pro-bolo-q">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.25 }}>“{asks[i]}”</motion.span>
        </AnimatePresence>
      </span>
      <span className="pro-bolo-go">{t('Poochhein')}</span>
    </a>
  )
}

/** Where the money is right now — a settlement strip: three pots and the total. */
function Paisa({ d, go }: { d: Dash; go: (r: Report) => string }) {
  const total = d.cash.galla + d.cash.office + d.cash.bank
  const pots: { k: string; label: string; v: number; icon: ReactNode }[] = [
    { k: 'galla', label: t('Galla'), v: d.cash.galla, icon: <I.ICash /> },
    { k: 'office', label: t('Office'), v: d.cash.office, icon: <I.IStore /> },
    { k: 'bank', label: t('Bank / UPI'), v: d.cash.bank, icon: <I.IWallet /> },
  ]
  return (
    <motion.a {...rise} className="pro-card pro-paisa" href={go('cashbook')}>
      {pots.map((p) => (
        <div key={p.k} className="pot">
          <span className={`pot-ic ${p.k}`}>{p.icon}</span>
          <span className="lb">{p.label}</span>
          <span className="v"><NumberFlow value={Math.round(p.v / 100)} locales="en-IN" format={INR} /></span>
        </div>
      ))}
      <div className="pot total">
        <span className="lb">{t('Abhi kul')}</span>
        <span className="v big"><NumberFlow value={Math.round(total / 100)} locales="en-IN" format={INR} /></span>
      </div>
    </motion.a>
  )
}

const TABS: { m: Metric; label: string }[] = [
  { m: 'bikri', label: t('Bikri') }, { m: 'vasooli', label: t('Vasooli') }, { m: 'kharid', label: t('Kharid') }, { m: 'parchi', label: t('Parchi') },
]

/** The period's four figures as tabs, each against the last period; the chosen one drawn below. */
function Overview({ books, from, to }: { books: Books; from: string; to: string }) {
  const [m, setM] = useState<Metric>('bikri')
  const { d, prevBook } = books
  const vas = (es: DayEntry[]) => paymentsOf(es).reduce((s, e) => s + e.amountPaise, 0)
  const figs: Record<Metric, [number, number]> = {
    bikri: [d.now.salesPaise, d.before.salesPaise],
    vasooli: [vas(books.book), vas(prevBook)],
    kharid: [d.now.purchasePaise, d.before.purchasePaise],
    parchi: [d.now.slips, d.before.slips],
  }
  const { points, hourly } = useMemo(() => series(m, books, from, to), [m, books, from, to])
  const money = m !== 'parchi'
  const fmt = (v: number) => (money ? rupees(v) : count(v))
  const xLabel = (x: string) => (hourly ? hourLabel(Number(x)) : shortDate(x))
  const empty = points.every((p) => !p.now && !p.before)
  // First, middle and last label only.
  const ends = (xs: string[]) => [...new Set([xs[0], xs[Math.floor((xs.length - 1) / 2)], xs[xs.length - 1]])]

  return (
    <motion.section {...rise} className="pro-card pro-over">
      <div className="tabs-row" role="tablist">
        {TABS.map((tb) => {
          const [now, before] = figs[tb.m]
          return (
            <button key={tb.m} role="tab" aria-selected={m === tb.m} onClick={() => setM(tb.m)}>
              <span className="lb">{tb.label}</span>
              <span className="v">{tb.m === 'parchi' ? <NumberFlow value={now} locales="en-IN" /> : <NumberFlow value={Math.round(now / 100)} locales="en-IN" format={INR} />}</span>
              <Delta now={now} before={before} />
              {m === tb.m && <motion.span layoutId="tab-line" className="line" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
            </button>
          )
        })}
      </div>
      <div className="chart-area">
        {empty ? <p className="empty">{t('Is period mein kuch nahi')}</p> : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={points} margin={{ top: 16, right: 4, left: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="fillNow" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.accent} stopOpacity={0.08} />
                  <stop offset="100%" stopColor={C.accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="x" ticks={ends(points.map((p) => p.x))} tickFormatter={xLabel} tickLine={false} axisLine={false} interval={0} padding={{ left: 24, right: 24 }} tick={{ fontSize: 11.5, fill: '#a3aab5' }} />
              <YAxis hide domain={[0, 'dataMax']} />
              <Tooltip cursor={{ stroke: '#e3e6ea' }} content={({ active, payload, label }) => active && payload?.length ? (
                <div className="pro-tip">
                  <b>{xLabel(String(label))}</b>
                  <span>{fmt(Number(payload.find((p) => p.dataKey === 'now')?.value ?? 0))}</span>
                  {payload.some((p) => p.dataKey === 'before') && <span className="muted">{t('Pichhla')} {fmt(Number(payload.find((p) => p.dataKey === 'before')?.value ?? 0))}</span>}
                </div>
              ) : null} />
              <Line type="monotone" dataKey="before" stroke="#dfe2e7" strokeWidth={1.25} dot={false} activeDot={false} isAnimationActive={false} />
              <Area type="monotone" dataKey="now" stroke={C.accent} strokeWidth={2} fill="url(#fillNow)" activeDot={{ r: 3.5, strokeWidth: 0, fill: C.accent }} animationDuration={600} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </motion.section>
  )
}

function Delta({ now, before }: { now: number; before: number }) {
  if (!before) return <span className="delta flat">—</span>
  const pct = Math.round(((now - before) / before) * 100)
  if (pct === 0) return <span className="delta flat">0%</span>
  return <span className={`delta ${pct > 0 ? 'up' : 'down'}`}>{pct > 0 ? '▲' : '▼'} {Math.abs(pct)}%</span>
}

/** Small figures with their own line, as a payments console's "insights". */
function Insights({ books, from, to, unit }: { books: Books; from: string; to: string; unit: string }) {
  const slips = slipsOf(books.book), pays = paymentsOf(books.book)
  const sales = slips.reduce((s, e) => s + e.amountPaise, 0)
  const nags = slips.reduce((s, e) => s + e.nags, 0)
  const given = slips.reduce((s, e) => s + e.udhaarPaise, 0)
  const got = pays.reduce((s, e) => s + e.amountPaise, 0)
  const net = given - got
  const tiles = [
    { k: 'avg', label: t('Avg parchi'), v: slips.length ? rupees(sales / slips.length) : '—', line: perSlot(slips, from, to, (e) => e.amountPaise) },
    { k: 'nag', label: angoorLabel(unit), v: count(nags), line: perSlot(slips, from, to, (e) => e.nags) },
    { k: 'given', label: t('Naya udhaar'), v: rupees(given), sub: sales ? t('{n}% bikri ka', { n: Math.round((given / sales) * 100) }) : '', line: perSlot(slips, from, to, (e) => e.udhaarPaise), tone: C.udhaar },
    { k: 'net', label: net > 0 ? t('Udhaar badha') : t('Udhaar ghata'), v: rupees(Math.abs(net)), sub: t('vasooli {v}', { v: rupees(got) }), line: perSlot(books.book.filter((e) => !e.voided), from, to, (e) => (e.kind === 'slip' ? e.udhaarPaise : e.kind === 'payment' ? -e.amountPaise : 0)), tone: net > 0 ? '#d92d20' : C.cash },
  ]
  return (
    <div className="pro-grid g4">
      {tiles.map((x, i) => (
        <motion.div key={x.k} {...rise} transition={{ ...rise.transition, delay: 0.04 * i }} className="pro-card pro-tile">
          <span className="lb">{x.label}</span>
          <span className="v">{x.v}</span>
          {x.sub && <span className="sub">{x.sub}</span>}
          <Spark data={x.line} color={x.tone ?? C.accent} />
        </motion.div>
      ))}
    </div>
  )
}
const angoorLabel = (unit: string) => (unit === t('box') ? t('Box bike') : t('Nag bike'))

function Spark({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2 || data.every((v) => !v)) return <div className="spark" />
  const pts = data.map((v, i) => ({ i, v }))
  return (
    <div className="spark">
      <ResponsiveContainer width="100%" height={40}>
        <AreaChart data={pts} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} fill="none" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/** How the period's slips were paid: cash, UPI, udhaar. */
function Split({ slips }: { slips: DayEntry[] }) {
  const parts = [
    { k: 'cash', label: t('Cash'), v: slips.reduce((s, e) => s + e.cashPaise, 0), c: C.cash },
    { k: 'upi', label: 'UPI', v: slips.reduce((s, e) => s + e.upiPaise, 0), c: C.upi },
    { k: 'udhaar', label: t('Udhaar'), v: slips.reduce((s, e) => s + e.udhaarPaise, 0), c: C.udhaar },
  ]
  const total = parts.reduce((s, p) => s + p.v, 0)
  return (
    <motion.div {...rise} className="pro-card pro-split">
      <h3>{t('Payment')}</h3>
      {!total ? <p className="empty">{t('Is period mein bikri nahi')}</p> : (
        <div className="split-body">
          <div className="donut">
            <ResponsiveContainer width="100%" height={150}>
              <PieChart>
                <Pie data={parts.filter((p) => p.v)} dataKey="v" nameKey="label" innerRadius={60} outerRadius={67} paddingAngle={0} cornerRadius={0} stroke="none" startAngle={90} endAngle={-270} animationDuration={700}>
                  {parts.filter((p) => p.v).map((p) => <Cell key={p.k} fill={p.c} />)}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <span className="mid"><b>{Math.round(((parts[0].v + parts[1].v) / total) * 100)}%</b><small>{t('nakad')}</small></span>
          </div>
          <div className="split-list">
            {parts.map((p) => (
              <div key={p.k}>
                <i style={{ background: p.c }} /><span>{p.label}</span>
                <b className="money">{rupees(p.v)}</b>
                <small>{Math.round((p.v / total) * 100)}%</small>
              </div>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  )
}

/** A balance and how old it is, as one bar in three shades. */
function Owed({ title, due, who, to, tone }: { title: string; due: Buckets & { duePaise: number }; who: string; to: string; tone?: 'due' }) {
  const all = due.d0_7 + due.d8_30 + due.d31 || 1
  const segs = [
    { k: 'a0', label: t('0–7 din'), v: due.d0_7 },
    { k: 'a1', label: t('8–30 din'), v: due.d8_30 },
    { k: 'a2', label: t('30+ din'), v: due.d31 },
  ]
  return (
    <motion.a {...rise} className="pro-card pro-owed" href={to}>
      <h3>{title}</h3>
      <span className={`v${tone ? ` ${tone}` : ''}`}><NumberFlow value={Math.round(due.duePaise / 100)} locales="en-IN" format={INR} /></span>
      <span className="sub">{who}</span>
      <div className="age-bar">
        {segs.map((s) => s.v > 0 && <motion.span key={s.k} className={s.k} initial={{ width: 0 }} animate={{ width: `${(s.v / all) * 100}%` }} transition={{ duration: 0.6, ease: 'easeOut' }} />)}
      </div>
      <div className="age-list">
        {segs.map((s) => <div key={s.k}><i className={s.k} /><span>{s.label}</span><b className="money">{compact(s.v)}</b></div>)}
      </div>
    </motion.a>
  )
}

/** When the shop sells: the period's bikri by hour of day, the busiest hour in the accent. */
function Hours({ slips }: { slips: DayEntry[] }) {
  const by = new Array(24).fill(0) as number[]
  for (const e of slips) by[istHour(e.at)] += e.amountPaise
  const used = by.map((v, h) => (v ? h : -1)).filter((h) => h >= 0)
  const lo = Math.min(6, ...used), hi = Math.max(21, ...used)
  const rows = Array.from({ length: hi - lo + 1 }, (_, i) => ({ h: lo + i, v: by[lo + i] }))
  const top = rows.reduce((m, r) => (r.v > m.v ? r : m), rows[0])
  return (
    <motion.div {...rise} className="pro-card pro-hours">
      <div className="hd">
        <h3>{t('Kab bikta hai')}</h3>
        {top?.v > 0 && <span className="pill">{hourLabel(top.h)}</span>}
      </div>
      {!slips.length ? <p className="empty">{t('Is period mein bikri nahi')}</p> : (
        <div className="hours-chart"><ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 18, left: 18, bottom: 0 }} barCategoryGap="22%">
            <XAxis dataKey="h" ticks={rows.filter((r) => r.h % 3 === 0).map((r) => r.h)} interval={0} tickFormatter={(h: number) => hourLabel(h)} tickLine={false} axisLine={false} tick={{ fontSize: 11.5, fill: '#a3aab5' }} />
            <YAxis hide />
            <Tooltip cursor={{ fill: '#f3f4f6' }} content={({ active, payload }) => active && payload?.length ? (
              <div className="pro-tip"><b>{hourLabel(Number(payload[0].payload.h))}</b><span>{rupees(Number(payload[0].value))}</span></div>
            ) : null} />
            <Bar dataKey="v" radius={[4, 4, 0, 0]} animationDuration={600}>
              {rows.map((r) => <Cell key={r.h} fill={r.h === top.h && r.v ? C.accent : '#dfe5e4'} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer></div>
      )}
    </motion.div>
  )
}

/** The period's biggest buyers, with a bar against the first. */
function TopGrahak({ shopId, slips }: { shopId: string; slips: DayEntry[] }) {
  const by = new Map<string, { id: string | null; name: string; v: number; n: number }>()
  for (const e of slips) {
    const k = e.buyerId ?? `cash:${e.party}`
    const r = by.get(k) ?? { id: e.buyerId, name: e.party || t('Cash'), v: 0, n: 0 }
    r.v += e.amountPaise; r.n += 1; by.set(k, r)
  }
  const top = [...by.values()].sort((a, b) => b.v - a.v).slice(0, 6)
  const max = top[0]?.v || 1
  return (
    <motion.div {...rise} className="pro-card pro-rank">
      <div className="hd"><h3>{t('Top grahak')}</h3></div>
      {!top.length ? <p className="empty">{t('Is period mein bikri nahi')}</p> : top.map((r, i) => {
        const body = (
          <>
            <span className="av" data-i={i % 5}>{initials(r.name)}</span>
            <span className="nm"><b>{r.name}</b><small>{t('{n} parchi', { n: count(r.n) })}</small></span>
            <b className="money">{rupees(r.v)}</b>
            <span className="bar"><motion.i initial={{ width: 0 }} animate={{ width: `${(r.v / max) * 100}%` }} transition={{ duration: 0.6, delay: 0.05 * i }} /></span>
          </>
        )
        return r.id ? <a key={r.id} className="rank-row" href={href({ page: 'grahak', shopId, buyerId: r.id })}>{body}</a> : <div key={r.name} className="rank-row">{body}</div>
      })}
    </motion.div>
  )
}

const initials = (s: string) => s.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '₹'

/** What just happened, newest first: parchi, vasooli, kharcha — each opens its voucher. */
function Feed({ shopId, entries, more }: { shopId: string; entries: DayEntry[]; more: string }) {
  return (
    <motion.div {...rise} className="pro-card pro-feed">
      <div className="hd"><h3>{t('Taaza entries')}</h3><a href={more}>{t('Day Book')} →</a></div>
      {!entries.length && <p className="empty">{t('Abhi koi entry nahi')}</p>}
      {entries.map((e) => {
        const open = e.kind === 'slip' ? () => openVoucher(shopId, e.id) : e.kind === 'payment' ? () => openRaseed(shopId, e.id) : undefined
        const mode = e.kind === 'slip'
          ? (e.payMode === 'free' ? 'Free' : [e.cashPaise && 'Cash', e.upiPaise && 'UPI', e.udhaarPaise && 'Udhaar'].filter(Boolean).length > 1 ? 'Mixed' : e.udhaarPaise ? 'Udhaar' : e.upiPaise ? 'UPI' : 'Cash')
          : e.kind === 'payment' ? (e.upiPaise && !e.cashPaise ? 'UPI' : 'Cash') : ''
        const kind = e.kind === 'slip' ? t('Parchi') : e.kind === 'payment' ? t('Vasooli') : e.kind === 'out' ? t('Kharcha') : t('Aaya')
        const name = e.kind === 'slip' || e.kind === 'payment' ? e.party || t('Cash') : HEADS[e.title] ?? (e.title || kind)
        return (
          <button key={`${e.kind}-${e.id}`} type="button" className={`feed-row k-${e.kind}${e.voided ? ' void' : ''}`} onClick={open} disabled={!open}>
            <span className="av">{e.kind === 'slip' ? <I.IRupee /> : e.kind === 'payment' ? <I.IWallet /> : <I.ICash />}</span>
            <span className="nm"><b>{name}</b><small>{time(e.at)} · {kind}{e.kind === 'slip' ? ` ${e.title.replace(/^Parchi /, '')}` : ''}</small></span>
            <span className="amt">
              <b className="money">{e.kind === 'out' ? '−' : e.kind === 'payment' || e.kind === 'in' ? '+' : ''}{rupees(e.amountPaise)}</b>
              {e.voided ? <em className="st void">{e.voided === 'edited' ? t('Badli') : t('Hatayi')}</em> : mode && <em className={`st ${mode.toLowerCase()}`}>{t(mode)}</em>}
            </span>
          </button>
        )
      })}
    </motion.div>
  )
}

function Items({ items, unit, more }: { items: Dash['items']; unit: string; more: string }) {
  const max = items[0]?.amountPaise || 1
  return (
    <motion.div {...rise} className="pro-card pro-rank">
      <div className="hd"><h3>{t('Sabse zyada bika')}</h3><a href={more}>{t('Sab')} →</a></div>
      {!items.length && <p className="empty">{t('Is period mein bikri nahi')}</p>}
      {items.map((it, i) => (
        <div key={it.brand} className="rank-row">
          <span className="av sq" data-i={i % 5}>{i + 1}</span>
          <span className="nm"><b>{it.brand}</b><small>{count(it.nags)} {unit}</small></span>
          <b className="money">{rupees(it.amountPaise)}</b>
          <span className="bar"><motion.i initial={{ width: 0 }} animate={{ width: `${(it.amountPaise / max) * 100}%` }} transition={{ duration: 0.6, delay: 0.05 * i }} /></span>
        </div>
      ))}
    </motion.div>
  )
}

type Reminder = { id: string; what: string; label: string; action: 'note' | 'udhaar_whatsapp' }

/** What Bolo was asked to remember ("kal yaad dilana"), still to go — shown only when there is any. */
function YaadCard({ shopId }: { shopId: string }) {
  const { data, reload } = useLoad(() => api<{ reminders: Reminder[] }>(`/v1/admin/shops/${shopId}/reminders`), [shopId])
  if (!data?.reminders.length) return null
  const cancel = async (id: string) => { await api(`/v1/admin/shops/${shopId}/reminders/${id}`, { method: 'DELETE' }).catch(() => {}); reload() }
  return (
    <div className="pro-card pro-rank">
      <div className="hd"><h3>{t('Yaad (reminders)')}</h3></div>
      {data.reminders.map((r) => (
        <div key={r.id} className="rank-row">
          <span className="nm"><b>{r.what}</b><small>{r.label}{r.action === 'udhaar_whatsapp' ? ` · ${t('grahak ko udhaar WhatsApp')}` : ` · ${t('aapko WhatsApp')}`}</small></span>
          <button type="button" className="btn line" onClick={() => void cancel(r.id)}>{t('Hatayein')}</button>
        </div>
      ))}
    </div>
  )
}

function StockCard({ shopId, unit }: { shopId: string; unit: string }) {
  const { data } = useLoad(() => api<{ totals: { left: number; valuePaise: number; gaadis: number; stale: number } }>(`/v1/admin/shops/${shopId}/stock`), [shopId])
  return (
    <a className="pro-card pro-stock" href={href({ page: 'report', shopId, report: 'stock' })}>
      <h3>{t('Stock')}</h3>
      {!data ? <div className="sk" /> : (
        <div className="stock-row">
          <div><span className="lb">{t('Maal')}</span><b>{count(data.totals.left)} {unit}</b></div>
          <div><span className="lb">{t('Kharid bhav par')}</span><b>{compact(data.totals.valuePaise)}</b></div>
          <div><span className="lb">{t('Khuli gaadi')}</span><b>{count(data.totals.gaadis)}</b></div>
          <div><span className="lb">{t('Purani')}</span><b className={data.totals.stale ? 'due' : ''}>{count(data.totals.stale)}</b></div>
        </div>
      )}
    </a>
  )
}

function DashSkeleton() {
  return (
    <div className="pro-stack">
      <div className="pro-card sk-card" style={{ height: 112 }} />
      <div className="pro-card sk-card" style={{ height: 380 }} />
      <div className="pro-grid g4">{[0, 1, 2, 3].map((i) => <div key={i} className="pro-card sk-card" style={{ height: 120 }} />)}</div>
    </div>
  )
}
