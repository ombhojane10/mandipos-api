import { useEffect, useState, type ReactNode } from 'react'
import { api, type BuyerRow, type DayEntry, type ShopDetail, type Summary } from '../api'
import { hashQuery, href, setHashQuery, type ShopTab } from '../routes'
import { addDays, ago, count, date, dayHeader, phone, rupees, shortDate, spanDays, time } from '../format'
import { useLoad } from '../useLoad'
import { SalesChart } from '../SalesChart'
import { Bal, Crumb, PeriodBar, Rows } from '../ui'
import { preset, periodLabel, type Period } from '../period'

const TABS: { key: ShopTab; label: string }[] = [
  { key: 'hisab', label: 'Hisab' }, { key: 'daybook', label: 'Day Book' }, { key: 'grahak', label: 'Grahak' }, { key: 'team', label: 'Team' },
]

/** The period lives in the URL, so Back, a reload or a shared link keep it. */
function usePeriod(): [Period, (p: Period) => void] {
  const read = (): Period => {
    const q = hashQuery()
    const from = q.get('from'), to = q.get('to')
    return from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) ? { key: q.get('p') ?? 'custom', from, to } : preset('aaj')
  }
  const [p, setP] = useState(read)
  const set = (next: Period) => {
    setP(next)
    const q = Object.fromEntries(hashQuery())
    setHashQuery({ ...q, p: next.key, from: next.from, to: next.to })
  }
  return [p, set]
}

export function ShopPage({ shopId, tab }: { shopId: string; tab: ShopTab }) {
  const { data: shop, error } = useLoad(() => api<ShopDetail>(`/v1/admin/shops/${shopId}`), [shopId])
  const [period, setPeriod] = usePeriod()
  const keep = `?p=${period.key}&from=${period.from}&to=${period.to}`
  if (error) return <><Crumb to="#/shops">Dukaan</Crumb><p className="error">{error}</p></>
  if (!shop) return <><Crumb to="#/shops">Dukaan</Crumb><div className="sk big" /><Rows /></>

  return (
    <>
      <Crumb to="#/shops">Dukaan</Crumb>
      <div className="head">
        <div className="grow">
          <h1>{shop.name}</h1>
          <p>{[shop.mandi, shop.shopNo && `Dukaan ${shop.shopNo}`, shop.owner.name].filter(Boolean).join(' · ')}</p>
        </div>
        <a className="call" href={`tel:+91${shop.owner.phone}`}>☎ {phone(shop.owner.phone)}</a>
      </div>
      {shop.status !== 'approved' ? (
        <p className="summary">Yeh dukaan abhi {shop.status === 'pending' ? 'approval ke intezaar mein' : 'reject'} hai.</p>
      ) : (
        <>
          <nav className="ptabs" aria-label="Dukaan">
            {TABS.map((t) => (
              <a key={t.key} href={`${href({ page: 'shop', shopId, tab: t.key })}${t.key === 'hisab' || t.key === 'daybook' ? keep : ''}`}
                aria-current={t.key === tab ? 'page' : undefined}>{t.label}</a>
            ))}
          </nav>
          {tab === 'hisab' && <Hisab shopId={shopId} period={period} setPeriod={setPeriod} />}
          {tab === 'daybook' && <DayBook shopId={shopId} period={period} setPeriod={setPeriod} />}
          {tab === 'grahak' && <ShopCustomers shopId={shopId} />}
          {tab === 'team' && <Team shop={shop} />}
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------- Hisab

function Hisab({ shopId, period, setPeriod }: { shopId: string; period: Period; setPeriod: (p: Period) => void }) {
  const len = spanDays(period.from, period.to)
  const prev = { from: addDays(period.from, -len), to: addDays(period.to, -len) }
  const { data, error, loading } = useLoad(async () => {
    const [now, before] = await Promise.all([
      api<Summary>(`/v1/admin/shops/${shopId}/summary?from=${period.from}&to=${period.to}`),
      api<Summary>(`/v1/admin/shops/${shopId}/summary?from=${prev.from}&to=${prev.to}`),
    ])
    return { now, before, at: new Date().toISOString() }
  }, [shopId, period.from, period.to])
  const book = (f: string) => `${href({ page: 'shop', shopId, tab: 'daybook' })}?p=${period.key}&from=${period.from}&to=${period.to}&f=${f}`

  return (
    <>
      <PeriodBar value={period} onChange={setPeriod} />
      {error && <p className="error">{error}</p>}
      {!data ? <><div className="summary"><div className="sk big" /></div><Rows n={5} /></> : (
        <div className={loading ? 'dim' : undefined}>
          <div className="summary">
            <span className="label">Bikri · {periodLabel(period)}</span>
            <span className="big">{rupees(data.now.salesPaise)}</span>
            <span className="line">
              <Delta now={data.now.salesPaise} before={data.before.salesPaise} label={len === 1 ? 'pichhle din se' : `pichhle ${len} din se`} />
              {' · '}{count(data.now.slips)} parchi · {count(data.now.nags)} nag
            </span>
            <span className="stamp" style={{ display: 'block', marginTop: 6 }}>{time(data.at)} tak ka hisab</span>
          </div>

          <div className="figs">
            <Fig label="Cash" to={book('bikri')} amt={rupees(data.now.cashPaise)} />
            <Fig label="UPI" to={book('bikri')} amt={rupees(data.now.upiPaise)} />
            <Fig label="Udhaar diya" sub="In parchiyon par abhi baaki" to={book('bikri')} amt={<span className="due">{rupees(data.now.creditLeftPaise)}</span>} />
            <Fig label="Vasooli" sub={`Cash ${rupees(data.now.collectedCashPaise)} · UPI ${rupees(data.now.collectedUpiPaise)}`} to={book('vasooli')}
              amt={<span className="jama">{rupees(data.now.collectedCashPaise + data.now.collectedUpiPaise)}</span>} />
            <Fig label="Kharcha" sub={data.now.daybookInPaise ? `Aaya ${rupees(data.now.daybookInPaise)}` : undefined} to={book('kharcha')} amt={rupees(data.now.daybookOutPaise)} />
            <Fig label="Mazdoori" amt={rupees(data.now.labourPaise)} />
            {data.now.spoiledNags > 0 && <Fig label="Phoota" amt={`${count(data.now.spoiledNags)} nag`} />}
            {data.now.deletedSlips > 0 && <Fig label="Hatayi parchi" sub={rupees(data.now.deletedPaise)} to={book('bikri')} amt={count(data.now.deletedSlips)} />}
          </div>

          <h2>Abhi</h2>
          <div className="figs">
            <Fig label="Kul baaki" sub={`${count(data.now.dueBuyers)} grahak par`} to={href({ page: 'shop', shopId, tab: 'grahak' })}
              amt={<span className="due">{rupees(data.now.duePaise)}</span>} />
            <Fig label="Stock" sub={`${count(data.now.openTrucks)} gaadi khuli`} amt={`${count(data.now.stockNags)} nag`} />
          </div>

          {data.now.series.length > 1 && (<><h2>Roz ki bikri</h2><SalesChart series={data.now.series} /></>)}

          {data.now.topBuyers.length > 0 && (
            <>
              <h2>Sabse bade grahak</h2>
              <div className="list">
                {data.now.topBuyers.map((b) => (
                  <a key={b.id} className="row" data-row href={href({ page: 'customer', shopId, buyerId: b.id })}>
                    <span className="grow"><b>{b.name}</b><small>{count(b.slips)} parchi</small></span>
                    <span className="right amt money">{rupees(b.salesPaise)}</span>
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

function Delta({ now, before, label }: { now: number; before: number; label: string }) {
  const d = now - before
  if (d === 0) return <span className="muted">Pichhle jitni</span>
  return <span className={`delta ${d > 0 ? 'up' : 'down'}`}>{d > 0 ? '▲' : '▼'} {rupees(Math.abs(d))} {label}</span>
}

function Fig({ label, sub, amt, to }: { label: string; sub?: string; amt: ReactNode; to?: string }) {
  const body = (
    <>
      <span className="grow">{label}{sub && <small>{sub}</small>}</span>
      <span className="amt money">{amt}</span>
      {to && <span className="chev">›</span>}
    </>
  )
  return to ? <a className="fig" data-row href={to}>{body}</a> : <div className="fig">{body}</div>
}

// ---------------------------------------------------------------- Day Book

const FILTERS = [
  { key: 'sab', label: 'Sab' }, { key: 'bikri', label: 'Parchi' }, { key: 'vasooli', label: 'Vasooli' }, { key: 'kharcha', label: 'Kharcha' },
] as const
type Filter = (typeof FILTERS)[number]['key']

const NOT_KHARCHA = new Set(['handover', 'float', 'bank_jama', 'bank_nikala', 'mazdoori'])

const HEADS: Record<string, string> = {
  kharcha: 'Kharcha', mazdoori: 'Mazdoori', bhada: 'Bhada', kiraya: 'Kiraya', tankhwah: 'Tankhwah', committee_di: 'Committee di',
  bill: 'Bijli-pani', udhaar_diya: 'Udhaar diya', aur_gaya: 'Aur gaya', supplier: 'Supplier ko diya', handover: 'Malik ko diya',
  float: 'Galla ko diya', bank_jama: 'Bank jama', bank_nikala: 'Bank se nikala', udhaar_wapas: 'Udhaar wapas',
  committee_mili: 'Committee mili', aur_aaya: 'Aur aaya',
}

/** Tally's Day Book: everything that happened, newest first, a cancelled parchi struck through. */
function DayBook({ shopId, period, setPeriod }: { shopId: string; period: Period; setPeriod: (p: Period) => void }) {
  const [filter, setFilter] = useState<Filter>(() => (FILTERS.find((f) => f.key === hashQuery().get('f'))?.key ?? 'sab'))
  const { data, error, loading } = useLoad(
    () => api<{ entries: DayEntry[] }>(`/v1/admin/shops/${shopId}/daybook?from=${period.from}&to=${period.to}`).then((r) => r.entries),
    [shopId, period.from, period.to])
  const pick = (f: Filter) => { setFilter(f); setHashQuery({ ...Object.fromEntries(hashQuery()), f }) }
  const all = data ?? []
  const live = all.filter((e) => !e.voided)
  // Kharcha/Aaya as Hisab counts them: money moved between books, and mazdoori, are not kharcha.
  const sum = (k: DayEntry['kind']) => live.filter((e) => e.kind === k && !(k !== 'slip' && k !== 'payment' && NOT_KHARCHA.has(e.title))).reduce((t, e) => t + e.amountPaise, 0)
  const shown = all.filter((e) => filter === 'sab' || (filter === 'bikri' && e.kind === 'slip') || (filter === 'vasooli' && e.kind === 'payment') || (filter === 'kharcha' && (e.kind === 'in' || e.kind === 'out')))
  const multiDay = period.from !== period.to
  let lastDay = ''

  return (
    <>
      <PeriodBar value={period} onChange={setPeriod} />
      <div className="chips" style={{ marginBottom: 12 }}>
        {FILTERS.map((f) => <button key={f.key} className="chip" aria-pressed={filter === f.key} onClick={() => pick(f.key)}>{f.label}</button>)}
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Rows /> : (
        <div className={loading ? 'dim' : undefined}>
          <p className="muted" style={{ marginBottom: 8, fontSize: 14 }}>
            Parchi {rupees(sum('slip'))} · Vasooli {rupees(sum('payment'))} · Kharcha {rupees(sum('out'))}{sum('in') ? ` · Aaya ${rupees(sum('in'))}` : ''}
          </p>
          <div className="list">
            {shown.map((e) => {
              const head = multiDay && e.date !== lastDay ? <div className="dhead">{dayHeader(e.date)}</div> : null
              lastDay = e.date
              return <div key={`${e.kind}-${e.id}`}>{head}<DayRow e={e} shopId={shopId} /></div>
            })}
            {shown.length === 0 && <p className="empty">{periodLabel(period)} ko koi entry nahi</p>}
          </div>
        </div>
      )}
    </>
  )
}

function DayRow({ e, shopId }: { e: DayEntry; shopId: string }) {
  let title: string, detail: string, amt: ReactNode
  if (e.kind === 'slip') {
    title = `${e.title} · ${e.party || 'Cash'}`
    const paid = [e.cashPaise && `Cash ${rupees(e.cashPaise)}`, e.upiPaise && `UPI ${rupees(e.upiPaise)}`, e.udhaarPaise && `Udhaar ${rupees(e.udhaarPaise)}`].filter(Boolean)
    detail = [e.nags && `${count(e.nags)} nag`, paid.join(' + ') || (e.payMode === 'free' ? 'Free' : ''), e.staff].filter(Boolean).join(' · ')
    amt = rupees(e.amountPaise)
  } else if (e.kind === 'payment') {
    title = `Vasooli · ${e.party}`
    detail = [e.title !== 'Vasooli' && e.title, e.cashPaise && `Cash ${rupees(e.cashPaise)}`, e.upiPaise && `UPI ${rupees(e.upiPaise)}`].filter(Boolean).join(' · ')
    amt = <span className="jama">{rupees(e.amountPaise)}</span>
  } else {
    title = HEADS[e.title] ?? (e.title || (e.kind === 'out' ? 'Kharcha' : 'Aaya'))
    detail = [e.party, e.note, e.mode === 'upi' || e.mode === 'bank' ? 'Bank' : e.mode === 'office' ? 'Office' : 'Galla'].filter(Boolean).join(' · ')
    amt = e.kind === 'out' ? `−${rupees(e.amountPaise)}` : `+${rupees(e.amountPaise)}`
  }
  const voidWord = e.voided === 'edited' ? 'Badli' : e.voided ? 'Hatayi' : ''
  const body = (
    <>
      <span className="muted hide-sm" style={{ width: 64, fontSize: 13 }}>{time(e.at)}</span>
      <span className="grow">
        <b style={voidWord ? { textDecoration: 'line-through' } : undefined}>{title}</b>
        <small>{voidWord && <span className="due">{voidWord} · </span>}<span className="show-sm">{time(e.at)} · </span>{detail}</small>
      </span>
      <span className={`right amt money${voidWord ? ' muted' : ''}`}>{amt}</span>
    </>
  )
  return e.buyerId
    ? <a className={`row${voidWord ? ' void' : ''}`} data-row href={href({ page: 'customer', shopId, buyerId: e.buyerId })}>{body}</a>
    : <div className="row static" data-row tabIndex={0}>{body}</div>
}

// ---------------------------------------------------------------- Grahak, Team

function ShopCustomers({ shopId }: { shopId: string }) {
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
      <input className="field search" type="search" inputMode="search" placeholder="Naam, mobile ya A/C code" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Grahak dhoondhein" />
      {error && <p className="error">{error}</p>}
      {!data ? <Rows /> : (
        <div className={`list${loading ? ' dim' : ''}`}>
          {data.map((b) => (
            <a key={b.id} className="row" data-row href={href({ page: 'customer', shopId, buyerId: b.id })}>
              <span className="grow">
                <b>{b.name}</b>
                <small>{[b.phone && phone(b.phone), b.code && `A/C ${b.code}`, b.hidden && 'Chhupa hua'].filter(Boolean).join(' · ') || 'Mobile nahi'}</small>
              </span>
              <span className="right">
                <span className="amt"><Bal paise={b.balancePaise} /></span>
                <small>{b.lastSlipOn ? shortDate(b.lastSlipOn) : ''}</small>
              </span>
            </a>
          ))}
          {data.length === 0 && <p className="empty">Koi grahak nahi mila</p>}
        </div>
      )}
    </>
  )
}

function Team({ shop }: { shop: ShopDetail }) {
  const seen = (iso: string | null) => (iso ? ago(iso).replace('Just now', 'abhi').replace(' ago', ' pehle') : 'Kabhi nahi')
  return (
    <>
      <h2>Log</h2>
      <div className="list">
        {shop.team.map((m) => (
          <div key={m.phone} className="row static">
            <span className="grow"><b>{m.name || phone(m.phone)}</b><small>{phone(m.phone)} · {date(m.joinedAt)} se</small></span>
            <span className="right muted">{m.role === 'admin' ? 'Admin' : 'Accountant'}</span>
          </div>
        ))}
      </div>
      <h2>Machine</h2>
      <div className="list">
        {shop.devices.map((d) => (
          <div key={`${d.code}-${d.phone}`} className="row static">
            <span className="grow"><b>{d.code ?? '—'} · {d.label || 'Machine'}</b><small>{phone(d.phone)} · v{d.appVersion}</small></span>
            <span className="right muted">{seen(d.lastSeenAt)}</span>
          </div>
        ))}
      </div>
    </>
  )
}
