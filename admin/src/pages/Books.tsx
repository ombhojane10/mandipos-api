import { useEffect, useMemo, useState } from 'react'
import { api, apiDownload } from '../api'
import { useSession } from '../App'
import { count, rupees, shortDate, todayIst } from '../format'
import { usePeriod } from '../hooks'
import { t } from '../i18n'
import { openRaseed, openVoucher } from '../keys'
import { hashQuery, href, setHashQuery } from '../routes'
import { useLoad } from '../useLoad'
import { PeriodBar, Skeleton } from '../ui'
import { dayRange, dmy, dmyLong, fileName, rs, useExport } from '../export/doc'
import { download } from '../export/save'
import { Money } from '../entries/fields'
import { HEADS } from './DayBook'
import { BeejakSheet } from './Angoor'
import type { Period } from '../period'

// ================================================================ shared bits

/** "₹1,234 Dr" / "₹1,234 Cr": a ledger balance with its side. */
const drcr = (p: number) => (p === 0 ? rupees(0) : `${rupees(Math.abs(p))} ${p > 0 ? 'Dr' : 'Cr'}`)
const drcrRs = (p: number) => (p === 0 ? '0' : `${rs(Math.abs(p))} ${p > 0 ? 'Dr' : 'Cr'}`)
const fyStart = (day: string) => { const [y, m] = day.split('-').map(Number); return `${m >= 4 ? y : y - 1}-04-01` }
/** "Pintu Gujarat" and "PINTU GUJARAT." are one supplier (the server's nameKey). */
const nameKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
/** A column's total over a list. */
const sum = <T,>(xs: T[], k: { [K in keyof T]: T[K] extends number ? K : never }[keyof T]) => xs.reduce((a, x) => a + (x[k] as number), 0)
const has = (q: string, ...xs: (string | undefined | null)[]) => { const f = q.trim().toLowerCase(); return !f || xs.some((x) => (x ?? '').toLowerCase().includes(f)) }
const dayBookOn = (shopId: string, day: string) => `${href({ page: 'report', shopId, report: 'daybook' })}?p=custom&from=${day}&to=${day}`
/** A grapes supplier's khata in Supplier creditors. */
const creditorHref = (shopId: string, key: string) => `${href({ page: 'report', shopId, report: 'creditors' })}?k=${encodeURIComponent(key)}`
const ledgerHref = (shopId: string, key: string, from: string, to: string) => `${href({ page: 'report', shopId, report: 'gl' })}?a=${encodeURIComponent(key)}&p=custom&from=${from}&to=${to}`

/** This financial year so far: the period most of these reports are read for. */
export function FyButton({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const today = todayIst()
  const on = value.from === fyStart(today) && value.to === today
  return <button type="button" className="btn ghost sm" aria-pressed={on} onClick={() => onChange({ key: 'fy', from: fyStart(today), to: today })}>{t('Is saal')}</button>
}

// ================================================================ General Ledger

type Account = { key: string; name: string; group: string; pl: boolean; hidden: boolean }
type GLine = { id: string; date: string; kind: string; ref: string | null; ref2: string | null; title: string; detail: string; debitPaise: number; creditPaise: number; balancePaise: number; count: number }
type GL = { key: string; name: string; group: string; pl: boolean; from: string; to: string; openingPaise: number; debitPaise: number; creditPaise: number; closingPaise: number; lines: GLine[] }

const GROUP_NAMES: Record<string, string> = {
  capital: 'Capital', creditors: 'Sundry creditors', liabilities: 'Duties aur dena', cash: 'Cash-in-hand', bank: 'Bank', debtors: 'Sundry debtors (grahak)',
  laddan: 'Laddan parties', assets: 'Loans aur advances', sales: 'Sales', purchase: 'Purchase', expense: 'Kharcha', income: 'Aamdani', suspense: 'Difference in opening / suspense',
}
/** Accounts with an entry per slip: shown a line a day unless asked for every entry. */
const BUSY = new Set(['sales', 'apmc', 'chungi', 'mazdoori', 'labour'])
/** A ledger line's name: a day's total ("12 entry"), a Day Book head, or the entry's own title. */
const lineTitle = (l: GLine) => (l.kind === 'day' && !l.title ? t('{n} entry', { n: count(l.count) }) : l.kind === 'daybook' ? (HEADS[l.title] ?? t(l.title)) : t(l.title))

/** Any account — a Day Book head, cash, bank, bikri, kharid, APMC, mazdoori — over a period, entry by entry. */
export function GeneralLedger({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('30')
  const [key, setKey] = useState(() => hashQuery().get('a') ?? 'pot:galla')
  const [every, setEvery] = useState(() => hashQuery().get('e') === '1')
  const [q, setQ] = useState('')
  const [beejak, setBeejak] = useState<string | null>(null)
  const pick = (k: string) => { setKey(k); setHashQuery({ ...Object.fromEntries(hashQuery()), a: k }) }
  const daily = BUSY.has(key) && !every
  const accounts = useLoad(() => api<{ accounts: Account[] }>(`/v1/admin/shops/${shopId}/books/accounts`).then((r) => r.accounts), [shopId])
  const { data, error, loading } = useLoad(() => api<GL>(`/v1/admin/shops/${shopId}/books/ledger?account=${encodeURIComponent(key)}&from=${period.from}&to=${period.to}&daily=${daily ? 1 : 0}`),
    [shopId, key, period.from, period.to, daily])
  const lines = (data?.lines ?? []).filter((l) => has(q, l.title, l.detail))
  const name = data ? t(data.name) : ''

  useExport(data ? () => ({
    style: 'book' as const, title: name, dateLine: dayRange(data.from, data.to), file: fileName(name, data.from, data.to),
    summary: [[t('Opening'), drcrRs(data.openingPaise)], ['Dr', rs(data.debitPaise)], ['Cr', rs(data.creditPaise)], [t('Closing'), drcrRs(data.closingPaise)]],
    columns: [{ label: t('Tarikh') }, { label: t('Vivaran'), wide: true }, { label: 'Dr', num: true }, { label: 'Cr', num: true }, { label: t('Baaki'), num: true }],
    rows: [{ cells: [dmy(data.from), t('Opening'), '', '', drcrRs(data.openingPaise)], bold: true },
      ...lines.map((l) => ({ bold: l.kind === 'fy', cells: [dmy(l.date), [lineTitle(l), l.detail].filter(Boolean).join(' · '), l.debitPaise ? rs(l.debitPaise) : '', l.creditPaise ? rs(l.creditPaise) : '', drcrRs(l.balancePaise)] }))],
    foot: ['', t('Closing'), rs(data.debitPaise), rs(data.creditPaise), drcrRs(data.closingPaise)],
  }) : null, [data, q])

  const open = (l: GLine) => {
    if (l.kind === 'bill' && l.ref) openVoucher(shopId, l.ref)
    else if (l.kind === 'raseed' && l.ref) openRaseed(shopId, l.ref)
    else if (l.kind === 'udhaar' && l.ref2) location.hash = href({ page: 'grahak', shopId, buyerId: l.ref2 })
    else if (l.kind === 'beejak' && l.ref2) setBeejak(l.ref2)
    else if (l.kind === 'gaadi' && l.detail) location.hash = href({ page: 'supplier', shopId, key: nameKey(l.detail) })
    else if (l.kind === 'daybook' || l.kind === 'day') location.hash = dayBookOn(shopId, l.date)
    else if (l.kind === 'jv' || l.kind === 'cn') location.hash = `${href({ page: 'report', shopId, report: l.kind })}?p=custom&from=${l.date}&to=${l.date}`
  }
  const groups = useMemo(() => {
    const m = new Map<string, Account[]>()
    for (const a of accounts.data ?? []) m.set(a.group, [...(m.get(a.group) ?? []), a])
    return [...m]
  }, [accounts.data])

  return (
    <>
      <div className="toolbar">
        <select className="field" aria-label={t('Khata')} style={{ flex: '1 1 220px', maxWidth: 320 }} value={key} onChange={(e) => pick(e.target.value)}>
          {!accounts.data && <option value={key}>{key}</option>}
          {groups.map(([g, list]) => (
            <optgroup key={g} label={t(GROUP_NAMES[g] ?? g)}>
              {list.map((a) => <option key={a.key} value={a.key}>{t(a.name)}{a.hidden ? ` (${t('chhupa')})` : ''}</option>)}
            </optgroup>
          ))}
        </select>
        <PeriodBar value={period} onChange={setPeriod} />
        <FyButton value={period} onChange={setPeriod} />
      </div>
      <div className="toolbar">
        <input className="field grow" data-search type="search" placeholder={t('Vivaran dhoondhein')} value={q} onChange={(e) => setQ(e.target.value)} />
        {BUSY.has(key) && <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={every} onChange={(e) => { setEvery(e.target.checked); setHashQuery({ ...Object.fromEntries(hashQuery()), e: e.target.checked ? '1' : '0' }) }} /> {t('Har entry')}</label>}
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Opening')}</span><span className="v">{drcr(data.openingPaise)}</span></div>
            <div><span className="lb">Dr</span><span className="v">{rupees(data.debitPaise)}</span></div>
            <div><span className="lb">Cr</span><span className="v">{rupees(data.creditPaise)}</span></div>
            <div><span className="lb">{t('Closing')}</span><span className="v">{drcr(data.closingPaise)}</span></div>
          </div>
          <div className={`card wrap-x${loading ? ' dim' : ''}`}>
            <table className="tbl fold">
              <thead><tr><th className="opt-col">{t('Tarikh')}</th><th>{t('Vivaran')}</th><th className="num opt-col">Dr</th><th className="num opt-col">Cr</th><th className="num">{t('Baaki')}</th></tr></thead>
              <tbody>
                <tr><td className="opt-col muted">{shortDate(data.from)}</td><td className="main-col"><b>{t('Opening')}</b><small className="show-sm">{shortDate(data.from)}</small></td><td className="num opt-col" /><td className="num opt-col" /><td className="num amt-col money b">{drcr(data.openingPaise)}</td></tr>
                {lines.map((l) => (
                  l.kind === 'fy' ? (
                    <tr key={l.id}>
                      <td className="opt-col muted">{shortDate(l.date)}</td>
                      <td className="main-col"><b>{l.title}</b><small className="show-sm">{shortDate(l.date)}</small></td>
                      <td className="num opt-col" /><td className="num opt-col" /><td className="num amt-col money b">{drcr(0)}</td>
                    </tr>
                  ) : (
                  <tr key={`${l.id}-${l.date}`} data-row tabIndex={0} onClick={() => open(l)} onKeyDown={(e) => { if (e.key === 'Enter') open(l) }}>
                    <td className="opt-col muted">{shortDate(l.date)}</td>
                    <td className="main-col">
                      <b className="name">{lineTitle(l)}</b>
                      <small><span className="show-sm">{shortDate(l.date)} · </span>{l.detail}</small>
                    </td>
                    <td className="num opt-col money">{l.debitPaise ? rupees(l.debitPaise) : ''}</td>
                    <td className="num opt-col money">{l.creditPaise ? rupees(l.creditPaise) : ''}</td>
                    <td className="num amt-col">
                      <span className="sm-block money b">{l.debitPaise ? `${rupees(l.debitPaise)} Dr` : `${rupees(l.creditPaise)} Cr`}</span>
                      <span className="money">{drcr(l.balancePaise)}</span>
                    </td>
                  </tr>
                  )
                ))}
              </tbody>
              <tfoot><tr><td className="opt-col" /><td className="main-col">{t('Closing')}</td><td className="num opt-col money">{rupees(data.debitPaise)}</td><td className="num opt-col money">{rupees(data.creditPaise)}</td><td className="num amt-col money">{drcr(data.closingPaise)}</td></tr></tfoot>
            </table>
            {lines.length === 0 && <p className="empty">{t('Is period mein koi len-den nahi')}</p>}
          </div>
        </>
      )}
      {beejak && <BeejakSheet shopId={shopId} truckId={beejak} onClose={() => setBeejak(null)} />}
    </>
  )
}

// ================================================================ Trial Balance

type TbRow = { key: string; name: string; dr: number; cr: number; sub?: string; link?: { kind: 'grahak' | 'supplier' | 'ledger'; id: string } }
type TbGroup = { key: string; name: string; dr: number; cr: number; rows: TbRow[] }
type Tb = { on: string; fy: { from: string; label: string }; grapes: boolean; groups: TbGroup[]; totals: { dr: number; cr: number }; differencePaise: number; memo: { cratesQty: number; cratesPaise: number } }

/** Every ledger's closing on a day, Dr or Cr, grouped as Tally does; a group opens to its ledgers. */
export function TrialBalance({ shopId }: { shopId: string }) {
  const [on, setOn] = useState(() => hashQuery().get('on') ?? todayIst())
  const [q, setQ] = useState('')
  const [opened, setOpened] = useState<Set<string> | null>(null)
  const { data, error, loading } = useLoad(() => api<Tb>(`/v1/admin/shops/${shopId}/books/trial-balance?on=${on}`), [shopId, on])
  // Small groups open, the long party lists closed, until the owner says otherwise.
  const isOpen = (g: TbGroup) => !!q.trim() || (opened ? opened.has(g.key) : g.rows.length <= 12)
  const toggle = (g: TbGroup) => {
    const s = new Set(opened ?? (data?.groups ?? []).filter((x) => x.rows.length <= 12).map((x) => x.key))
    if (s.has(g.key)) s.delete(g.key); else s.add(g.key)
    setOpened(s)
  }
  const pickOn = (d: string) => { setOn(d); setHashQuery({ ...Object.fromEntries(hashQuery()), on: d }) }
  const groups = (data?.groups ?? []).map((g) => ({ ...g, shown: g.rows.filter((r) => has(q, r.name, r.sub, g.name)) })).filter((g) => !q.trim() || g.shown.length)
  const go = (r: TbRow) => {
    if (!r.link || !data) return
    if (r.link.kind === 'grahak') location.hash = href({ page: 'grahak', shopId, buyerId: r.link.id })
    else if (r.link.kind === 'supplier') location.hash = data.grapes ? creditorHref(shopId, r.link.id) : href({ page: 'supplier', shopId, key: r.link.id })
    else location.hash = ledgerHref(shopId, r.link.id, data.fy.from, data.on)
  }

  useExport(data ? () => ({
    style: 'book' as const, title: 'TRIAL BALANCE', dateLine: `AS ON ${dmyLong(data.on)}  ·  FY ${data.fy.label}`, file: fileName('Trial Balance', data.on),
    columns: [{ label: t('Particulars'), wide: true }, { label: 'Dr', num: true }, { label: 'Cr', num: true }],
    rows: groups.flatMap((g) => [
      { cells: [t(g.name), g.dr ? rs(g.dr) : '', g.cr ? rs(g.cr) : ''], bold: true },
      ...(isOpen(g) ? g.shown.map((r) => ({ cells: [`    ${t(r.name)}${r.sub ? ` (${r.sub})` : ''}`, r.dr ? rs(r.dr) : '', r.cr ? rs(r.cr) : ''] })) : []),
    ]),
    // A search prints only some ledgers: no grand total under them.
    foot: q.trim() ? undefined : [t('Kul'), rs(data.totals.dr), rs(data.totals.cr)],
  }) : null, [data, q, opened])

  return (
    <>
      <div className="toolbar">
        <label className="fld" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="muted">{t('Tak')}</span>
          <input className="field" type="date" max={todayIst()} value={on} onChange={(e) => e.target.value && pickOn(e.target.value)} /></label>
        <input className="field grow" data-search type="search" placeholder={t('Khata dhoondhein')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn ghost sm" onClick={() => setOpened(new Set(data?.groups.map((g) => g.key)))}>{t('Sab kholein')}</button>
        <button type="button" className="btn ghost sm" onClick={() => setOpened(new Set())}>{t('Band karein')}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">Dr</span><span className="v">{rupees(data.totals.dr)}</span></div>
            <div><span className="lb">Cr</span><span className="v">{rupees(data.totals.cr)}</span></div>
            <div><span className="lb">{t('Farq (opening/suspense)')}</span><span className={`v${data.differencePaise ? ' due' : ''}`}>{drcr(data.differencePaise)}</span></div>
            <div><span className="lb">FY</span><span className="v">{data.fy.label}</span></div>
          </div>
          <div className={`card wrap-x${loading ? ' dim' : ''}`}>
            <table className="tbl">
              <thead><tr><th>{t('Particulars')}</th><th className="num">Dr</th><th className="num">Cr</th></tr></thead>
              <tbody>
                {groups.map((g) => (
                  <GroupRows key={g.key} g={g} open={isOpen(g)} onToggle={() => toggle(g)} onRow={go} />
                ))}
              </tbody>
              <tfoot><tr><td>{t('Kul')}</td><td className="num money">{rupees(data.totals.dr)}</td><td className="num money">{rupees(data.totals.cr)}</td></tr></tfoot>
            </table>
            {groups.length === 0 && <p className="empty">{t('Kuch nahi mila')}</p>}
          </div>
          {data.memo.cratesQty !== 0 && <p className="muted" style={{ marginTop: 10 }}>{t('Crates baaki')}: {count(data.memo.cratesQty)} · {rupees(data.memo.cratesPaise)}</p>}
        </>
      )}
    </>
  )
}

function GroupRows({ g, open, onToggle, onRow }: { g: TbGroup & { shown: TbRow[] }; open: boolean; onToggle: () => void; onRow: (r: TbRow) => void }) {
  return (
    <>
      <tr data-row tabIndex={0} onClick={onToggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}>
        <td><b>{open ? '▾' : '▸'} {t(g.name)}</b> <small className="muted inline">{g.rows.length > 1 ? `(${count(g.rows.length)})` : ''}</small></td>
        <td className="num money b">{g.dr ? rupees(g.dr) : ''}</td>
        <td className="num money b">{g.cr ? rupees(g.cr) : ''}</td>
      </tr>
      {open && g.shown.map((r) => (
        <tr key={r.key} data-row={r.link ? '' : undefined} tabIndex={r.link ? 0 : undefined} onClick={() => onRow(r)} onKeyDown={(e) => { if (e.key === 'Enter') onRow(r) }}>
          <td style={{ paddingLeft: 30 }}>{t(r.name)}{r.sub && <small className="muted inline"> {r.sub}</small>}</td>
          <td className="num money">{r.dr ? rupees(r.dr) : ''}</td>
          <td className="num money">{r.cr ? rupees(r.cr) : ''}</td>
        </tr>
      ))}
    </>
  )
}

// ================================================================ Transactions above ₹X

type BigRow = { type: string; id: string; partyId: string | null; date: string; at: string; party: string; title: string; amountPaise: number; cashPaise: number; upiPaise: number; udhaarPaise: number; officePaise: number }
type BigMonth = { type: string; partyId: string | null; party: string; month: string; entries: number; amountPaise: number; cashPaise: number; upiPaise: number; udhaarPaise: number; officePaise: number }
const TYPES: Record<string, string> = { parchi: 'Parchi', vasooli: 'Vasooli', supplier: 'Supplier', daybook: 'Day Book', bankjama: 'Bank jama' }
const MODES: Record<string, (r: { cashPaise: number; upiPaise: number; udhaarPaise: number; officePaise: number }) => boolean> = {
  cash: (r) => r.cashPaise > 0, upi: (r) => r.upiPaise > 0, udhaar: (r) => r.udhaarPaise > 0, office: (r) => r.officePaise > 0,
}
/** Section 269ST: ₹2 lakh or more in cash from one person, in a day or one transaction. */
const CASH_LIMIT = 2_00_000_00
const month = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const dbTitle = (title: string) => { const [dir, cat] = title.split(':'); return cat ? `${dir === 'in' ? '+' : '−'} ${HEADS[cat] ?? cat}` : title }

/** Every slip, raseed, payment and bank slip over an amount: cash, UPI/bank and udhaar apart. */
export function BigTransactions({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('30')
  const [min, setMin] = useState(() => Number(hashQuery().get('min') ?? CASH_LIMIT))
  const [minAsked, setMinAsked] = useState(min)
  const [type, setType] = useState('')
  const [mode, setMode] = useState('')
  const [view, setView] = useState<'entries' | 'months'>('entries')
  const [q, setQ] = useState('')
  useEffect(() => { const id = setTimeout(() => { setMinAsked(min); setHashQuery({ ...Object.fromEntries(hashQuery()), min: String(min) }) }, 400); return () => clearTimeout(id) }, [min])
  const { data, error, loading } = useLoad(() => api<{ rows: BigRow[]; months: BigMonth[] }>(`/v1/admin/shops/${shopId}/books/big?from=${period.from}&to=${period.to}&min=${minAsked}`),
    [shopId, period.from, period.to, minAsked])
  const keep = <T extends BigRow | BigMonth>(r: T) => (!type || r.type === type) && (!mode || MODES[mode](r)) && has(q, r.party, 'title' in r ? r.title : '')
  const rows = (data?.rows ?? []).filter(keep)
  const months = (data?.months ?? []).filter(keep)
  const label = (r: BigRow) => (r.type === 'daybook' ? dbTitle(r.title) : r.type === 'supplier' ? t('Supplier payment') : r.title)
  const shown: (BigRow | BigMonth)[] = view === 'entries' ? rows : months
  const tot = (k: 'amountPaise' | 'cashPaise' | 'upiPaise' | 'udhaarPaise') => shown.reduce((s, r) => s + r[k], 0)

  useExport(data ? () => ({
    style: 'book' as const, title: `${t('Bade len-den')} ≥ ${rs(minAsked)}`, dateLine: dayRange(period.from, period.to), file: fileName('Bade-len-den', period.from, period.to),
    ...(view === 'entries' ? {
      columns: [{ label: t('Tarikh') }, { label: t('Type') }, { label: t('Party'), wide: true }, { label: t('Vivaran') }, { label: t('Rakam'), num: true }, { label: 'Cash', num: true }, { label: 'UPI/Bank', num: true }, { label: t('Udhaar'), num: true }],
      rows: rows.map((r) => ({ bold: r.cashPaise >= CASH_LIMIT, cells: [dmy(r.date), t(TYPES[r.type]), r.party, label(r), rs(r.amountPaise), r.cashPaise ? rs(r.cashPaise) : '', r.upiPaise ? rs(r.upiPaise) : '', r.udhaarPaise ? rs(r.udhaarPaise) : ''] })),
      foot: ['', '', t('Kul'), count(rows.length), rs(tot('amountPaise')), rs(tot('cashPaise')), rs(tot('upiPaise')), rs(tot('udhaarPaise'))],
    } : {
      columns: [{ label: t('Mahina') }, { label: t('Type') }, { label: t('Party'), wide: true }, { label: t('Entry'), num: true }, { label: t('Rakam'), num: true }, { label: 'Cash', num: true }, { label: 'UPI/Bank', num: true }, { label: t('Udhaar'), num: true }],
      rows: months.map((m) => ({ bold: m.cashPaise >= CASH_LIMIT, cells: [month(m.month), t(TYPES[m.type]), m.party, count(m.entries), rs(m.amountPaise), m.cashPaise ? rs(m.cashPaise) : '', m.upiPaise ? rs(m.upiPaise) : '', m.udhaarPaise ? rs(m.udhaarPaise) : ''] })),
      foot: ['', '', t('Kul'), count(months.reduce((s, m) => s + m.entries, 0)), rs(tot('amountPaise')), rs(tot('cashPaise')), rs(tot('upiPaise')), rs(tot('udhaarPaise'))],
    }),
  }) : null, [data, view, type, mode, q])

  const open = (r: BigRow) => {
    if (r.type === 'parchi') openVoucher(shopId, r.id)
    else if (r.type === 'vasooli') openRaseed(shopId, r.id)
    else if (r.type === 'bankjama') location.hash = `${href({ page: 'report', shopId, report: 'bankjama' })}?p=custom&from=${r.date}&to=${r.date}`
    else location.hash = dayBookOn(shopId, r.date)
  }
  return (
    <>
      <div className="toolbar"><PeriodBar value={period} onChange={setPeriod} /><FyButton value={period} onChange={setPeriod} /></div>
      <div className="toolbar">
        <span style={{ flex: '0 1 170px' }}><Money value={min} onChange={setMin} /></span>
        <select className="field" aria-label={t('Type')} style={{ flex: '0 1 150px' }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">{t('Sab type')}</option>
          {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
        </select>
        <select className="field" aria-label={t('Mode')} style={{ flex: '0 1 140px' }} value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="">{t('Sab mode')}</option><option value="cash">Cash</option><option value="upi">UPI / Bank</option><option value="udhaar">{t('Udhaar')}</option><option value="office">{t('Office')}</option>
        </select>
        <div className="seg" role="group">
          <button aria-pressed={view === 'entries'} onClick={() => setView('entries')}>{t('Entry')}</button>
          <button aria-pressed={view === 'months'} onClick={() => setView('months')}>{t('Mahina-wise')}</button>
        </div>
        <input className="field grow" data-search type="search" placeholder={t('Party')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          {view === 'entries' ? (
            <table className="tbl fold">
              <thead><tr><th className="opt-col">{t('Tarikh')}</th><th>{t('Party')}</th><th className="opt-col">{t('Type')}</th><th className="num">{t('Rakam')}</th><th className="num opt-col">Cash</th><th className="num opt-col">UPI/Bank</th><th className="num opt-col">{t('Udhaar')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.type}-${r.id}`} data-row tabIndex={0} onClick={() => open(r)} onKeyDown={(e) => { if (e.key === 'Enter') open(r) }}>
                    <td className="opt-col muted">{shortDate(r.date)}</td>
                    <td className="main-col"><b className="name">{r.party || '—'}</b><small><span className="show-sm">{shortDate(r.date)} · {t(TYPES[r.type])} · </span>{label(r)}</small></td>
                    <td className="opt-col"><span className="chip grey">{t(TYPES[r.type])}</span></td>
                    <td className="num amt-col money b">{rupees(r.amountPaise)}<small className="show-sm">{r.cashPaise ? `cash ${rupees(r.cashPaise)}` : ''}</small></td>
                    <td className={`num opt-col money${r.cashPaise >= CASH_LIMIT ? ' due b' : ''}`}>{r.cashPaise ? rupees(r.cashPaise) : ''}</td>
                    <td className="num opt-col money">{r.upiPaise ? rupees(r.upiPaise) : ''}</td>
                    <td className="num opt-col money">{r.udhaarPaise ? rupees(r.udhaarPaise) : ''}</td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 1 && <BigFoot gap={1} tot={tot} />}
            </table>
          ) : (
            <table className="tbl fold">
              <thead><tr><th className="opt-col">{t('Mahina')}</th><th>{t('Party')}</th><th className="opt-col">{t('Type')}</th><th className="num opt-col">{t('Entry')}</th><th className="num">{t('Rakam')}</th><th className="num opt-col">Cash</th><th className="num opt-col">UPI/Bank</th><th className="num opt-col">{t('Udhaar')}</th></tr></thead>
              <tbody>
                {months.map((m) => (
                  <tr key={`${m.type}-${m.partyId ?? m.party}-${m.month}`}>
                    <td className="opt-col muted">{month(m.month)}</td>
                    <td className="main-col"><b className="name">{m.party || '—'}</b><small><span className="show-sm">{month(m.month)} · {t(TYPES[m.type])} · </span>{t('{n} entry', { n: count(m.entries) })}</small></td>
                    <td className="opt-col"><span className="chip grey">{t(TYPES[m.type])}</span></td>
                    <td className="num opt-col">{count(m.entries)}</td>
                    <td className="num amt-col money b">{rupees(m.amountPaise)}</td>
                    <td className={`num opt-col money${m.cashPaise >= CASH_LIMIT ? ' due b' : ''}`}>{m.cashPaise ? rupees(m.cashPaise) : ''}</td>
                    <td className="num opt-col money">{m.upiPaise ? rupees(m.upiPaise) : ''}</td>
                    <td className="num opt-col money">{m.udhaarPaise ? rupees(m.udhaarPaise) : ''}</td>
                  </tr>
                ))}
              </tbody>
              {months.length > 1 && <BigFoot gap={2} tot={tot} />}
            </table>
          )}
          {(view === 'entries' ? rows : months).length === 0 && <p className="empty">{t('Kuch nahi mila')}</p>}
        </div>
      )}
    </>
  )
}

/** Bade len-den's total row: date, "Kul" under the party, [gap] empty columns, then the amounts. */
function BigFoot({ gap, tot }: { gap: number; tot: (k: 'amountPaise' | 'cashPaise' | 'upiPaise' | 'udhaarPaise') => number }) {
  return (
    <tfoot><tr>
      <td className="opt-col" /><td className="main-col">{t('Kul')}</td>{Array.from({ length: gap }, (_, i) => <td key={i} className="opt-col" />)}
      <td className="num amt-col money">{rupees(tot('amountPaise'))}</td><td className="num opt-col money">{rupees(tot('cashPaise'))}</td>
      <td className="num opt-col money">{rupees(tot('upiPaise'))}</td><td className="num opt-col money">{rupees(tot('udhaarPaise'))}</td>
    </tr></tfoot>
  )
}

// ================================================================ Sale Purchase Summary

type SpRow = { key: string; kharidPaise: number; beejakPaise: number; salesPaise: number; laagatPaise: number; grossPaise: number; kharchaPaise: number; otherPaise: number; netPaise: number }
type Sp = {
  from: string; to: string; by: 'day' | 'month'; grapes: boolean; rows: SpRow[]; totals: Omit<SpRow, 'key'>
  suppliers: { key: string; name: string; gaadis: number; boxesIn: number; kharidPaise: number; beejaks: number; beejakPaise: number; soldQty: number; salesPaise: number }[]
  qualities: { name: string; inQty: number; inPaise: number; soldQty: number; salesPaise: number }[]
}

/** Per day or month: kharid, bikri, laagat, munafa, kharcha — Munafa's own sums; then by supplier and by quality. */
export function SalePurchase({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('30')
  const [by, setBy] = useState<'day' | 'month'>(() => (hashQuery().get('by') === 'month' ? 'month' : 'day'))
  const [view, setView] = useState<'summary' | 'supplier' | 'quality'>('summary')
  const [q, setQ] = useState('')
  const pickBy = (b: 'day' | 'month') => { setBy(b); setHashQuery({ ...Object.fromEntries(hashQuery()), by: b }) }
  const { data, error, loading } = useLoad(() => api<Sp>(`/v1/admin/shops/${shopId}/books/sale-purchase?from=${period.from}&to=${period.to}&by=${by}`), [shopId, period.from, period.to, by])
  const bj = !!data && (data.grapes || data.totals.beejakPaise > 0)
  const keyLabel = (k: string) => (by === 'day' ? shortDate(k) : month(k))
  const sups = (data?.suppliers ?? []).filter((s) => has(q, s.name))
  const quals = (data?.qualities ?? []).filter((x) => has(q, x.name))
  const drill = (r: SpRow) => {
    if (by === 'month') { const last = new Date(Date.UTC(Number(r.key.slice(0, 4)), Number(r.key.slice(5, 7)), 0)).toISOString().slice(0, 10); setPeriod({ key: 'custom', from: `${r.key}-01`, to: last < todayIst() ? last : todayIst() }); pickBy('day') }
    else location.hash = dayBookOn(shopId, r.key)
  }

  useExport(data ? () => {
    const base = { style: 'book' as const, title: t('Sale Purchase'), dateLine: dayRange(data.from, data.to), file: fileName('Sale-Purchase', data.from, data.to) }
    if (view === 'supplier') return { ...base, columns: [{ label: t('Supplier'), wide: true }, { label: t('Gaadi'), num: true }, { label: t('Box aaye'), num: true }, { label: t('Kharid'), num: true }, ...(bj ? [{ label: t('Beejak'), num: true }] : []), { label: t('Bika'), num: true }, { label: t('Bikri'), num: true }],
      rows: sups.map((s) => ({ cells: [s.name, count(s.gaadis), count(s.boxesIn), rs(s.kharidPaise), ...(bj ? [rs(s.beejakPaise)] : []), count(s.soldQty), rs(s.salesPaise)] })),
      foot: [t('Kul'), count(sum(sups, 'gaadis')), count(sum(sups, 'boxesIn')), rs(sum(sups, 'kharidPaise')), ...(bj ? [rs(sum(sups, 'beejakPaise'))] : []), count(sum(sups, 'soldQty')), rs(sum(sups, 'salesPaise'))] }
    if (view === 'quality') return { ...base, columns: [{ label: t('Maal'), wide: true }, { label: t('Aaya'), num: true }, { label: t('Kharid'), num: true }, { label: t('Bika'), num: true }, { label: t('Bikri'), num: true }, { label: t('Bhav'), num: true }],
      rows: quals.map((x) => ({ cells: [x.name, count(x.inQty), rs(x.inPaise), count(x.soldQty), rs(x.salesPaise), x.soldQty ? rs(Math.round(x.salesPaise / x.soldQty)) : ''] })),
      foot: [t('Kul'), count(sum(quals, 'inQty')), rs(sum(quals, 'inPaise')), count(sum(quals, 'soldQty')), rs(sum(quals, 'salesPaise')), ''] }
    const tt = data.totals
    return { ...base,
      columns: [{ label: by === 'day' ? t('Tarikh') : t('Mahina') }, { label: t('Kharid'), num: true }, ...(bj ? [{ label: t('Beejak'), num: true }] : []), { label: t('Bikri'), num: true }, { label: t('Laagat'), num: true },
        { label: t('Kul munafa'), num: true }, { label: t('Kharcha'), num: true }, { label: t('Aamdani'), num: true }, { label: t('Shuddh'), num: true }],
      rows: data.rows.map((r) => ({ cells: [keyLabel(r.key), rs(r.kharidPaise), ...(bj ? [rs(r.beejakPaise)] : []), rs(r.salesPaise), rs(r.laagatPaise), rs(r.grossPaise), rs(r.kharchaPaise), rs(r.otherPaise), rs(r.netPaise)] })),
      foot: [t('Kul'), rs(tt.kharidPaise), ...(bj ? [rs(tt.beejakPaise)] : []), rs(tt.salesPaise), rs(tt.laagatPaise), rs(tt.grossPaise), rs(tt.kharchaPaise), rs(tt.otherPaise), rs(tt.netPaise)] }
  } : null, [data, view, q])

  return (
    <>
      <div className="toolbar"><PeriodBar value={period} onChange={setPeriod} /><FyButton value={period} onChange={setPeriod} /></div>
      <div className="toolbar">
        <div className="seg" role="group">
          <button aria-pressed={view === 'summary'} onClick={() => setView('summary')}>{t('Summary')}</button>
          <button aria-pressed={view === 'supplier'} onClick={() => setView('supplier')}>{t('Supplier')}</button>
          <button aria-pressed={view === 'quality'} onClick={() => setView('quality')}>{t('Maal')}</button>
        </div>
        {view === 'summary' ? (
          <div className="seg" role="group">
            <button aria-pressed={by === 'day'} onClick={() => pickBy('day')}>{t('Din')}</button>
            <button aria-pressed={by === 'month'} onClick={() => pickBy('month')}>{t('Mahina')}</button>
          </div>
        ) : <input className="field grow" data-search type="search" placeholder={t('Dhoondhein')} value={q} onChange={(e) => setQ(e.target.value)} />}
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Kharid')}</span><span className="v">{rupees(data.totals.kharidPaise)}</span></div>
            {bj && <div><span className="lb">{t('Beejak')}</span><span className="v">{rupees(data.totals.beejakPaise)}</span></div>}
            <div><span className="lb">{t('Bikri')}</span><span className="v">{rupees(data.totals.salesPaise)}</span></div>
            <div><span className="lb">{t('Kul munafa')}</span><span className="v">{rupees(data.totals.grossPaise)}</span></div>
            <div><span className="lb">{t('Shuddh munafa')}</span><span className={`v${data.totals.netPaise < 0 ? ' due' : ''}`}>{rupees(data.totals.netPaise)}</span></div>
          </div>
          <div className={`card wrap-x${loading ? ' dim' : ''}`}>
            {view === 'summary' && (
              <table className="tbl fold">
                <thead><tr><th>{by === 'day' ? t('Tarikh') : t('Mahina')}</th><th className="num opt-col">{t('Kharid')}</th>{bj && <th className="num opt-col">{t('Beejak')}</th>}<th className="num">{t('Bikri')}</th>
                  <th className="num opt-col">{t('Laagat')}</th><th className="num opt-col">{t('Kul munafa')}</th><th className="num opt-col">{t('Kharcha')}</th><th className="num opt-col">{t('Aamdani')}</th><th className="num opt-col">{t('Shuddh')}</th></tr></thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.key} data-row tabIndex={0} onClick={() => drill(r)} onKeyDown={(e) => { if (e.key === 'Enter') drill(r) }}>
                      <td className="main-col"><b style={{ whiteSpace: 'nowrap' }}>{keyLabel(r.key)}</b><small className="show-sm">{t('Kharid')} {rupees(r.kharidPaise)} · {t('Shuddh')} {rupees(r.netPaise)}</small></td>
                      <td className="num opt-col money">{rupees(r.kharidPaise)}</td>
                      {bj && <td className="num opt-col money">{rupees(r.beejakPaise)}</td>}
                      <td className="num amt-col money b">{rupees(r.salesPaise)}</td>
                      <td className="num opt-col money">{rupees(r.laagatPaise)}</td>
                      <td className="num opt-col money">{rupees(r.grossPaise)}</td>
                      <td className="num opt-col money">{rupees(r.kharchaPaise)}</td>
                      <td className="num opt-col money">{rupees(r.otherPaise)}</td>
                      <td className={`num opt-col money b${r.netPaise < 0 ? ' due' : ''}`}>{rupees(r.netPaise)}</td>
                    </tr>
                  ))}
                </tbody>
                {data.rows.length > 1 && (
                  <tfoot><tr><td className="main-col">{t('Kul')}</td><td className="num opt-col money">{rupees(data.totals.kharidPaise)}</td>{bj && <td className="num opt-col money">{rupees(data.totals.beejakPaise)}</td>}
                    <td className="num amt-col money">{rupees(data.totals.salesPaise)}</td><td className="num opt-col money">{rupees(data.totals.laagatPaise)}</td><td className="num opt-col money">{rupees(data.totals.grossPaise)}</td>
                    <td className="num opt-col money">{rupees(data.totals.kharchaPaise)}</td><td className="num opt-col money">{rupees(data.totals.otherPaise)}</td><td className="num opt-col money">{rupees(data.totals.netPaise)}</td></tr></tfoot>
                )}
              </table>
            )}
            {view === 'supplier' && (
              <table className="tbl fold">
                <thead><tr><th>{t('Supplier')}</th><th className="num opt-col">{t('Gaadi')}</th><th className="num opt-col">{t('Box aaye')}</th><th className="num opt-col">{t('Kharid')}</th>{bj && <th className="num opt-col">{t('Beejak')}</th>}<th className="num opt-col">{t('Bika')}</th><th className="num">{t('Bikri')}</th></tr></thead>
                <tbody>
                  {sups.map((s) => {
                    const go = () => { if (!s.key) return; location.hash = data.grapes ? creditorHref(shopId, s.key) : href({ page: 'supplier', shopId, key: s.key }) }
                    return (
                      <tr key={s.key || s.name} data-row tabIndex={0} onClick={go} onKeyDown={(e) => { if (e.key === 'Enter') go() }}>
                        <td className="main-col"><b>{s.name}</b><small className="show-sm">{t('{n} gaadi', { n: s.gaadis })} · {t('Kharid')} {rupees(s.kharidPaise)}</small></td>
                        <td className="num opt-col">{count(s.gaadis)}</td><td className="num opt-col">{count(s.boxesIn)}</td><td className="num opt-col money">{rupees(s.kharidPaise)}</td>
                        {bj && <td className="num opt-col money">{rupees(s.beejakPaise)}</td>}
                        <td className="num opt-col">{count(s.soldQty)}</td><td className="num amt-col money b">{rupees(s.salesPaise)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {view === 'quality' && (
              <table className="tbl fold">
                <thead><tr><th>{t('Maal')}</th><th className="num opt-col">{t('Aaya')}</th><th className="num opt-col">{t('Kharid')}</th><th className="num opt-col">{t('Bika')}</th><th className="num">{t('Bikri')}</th><th className="num opt-col">{t('Bhav')}</th></tr></thead>
                <tbody>
                  {quals.map((x) => (
                    <tr key={x.name}>
                      <td className="main-col"><b>{x.name}</b><small className="show-sm">{t('Aaya')} {count(x.inQty)} · {t('Bika')} {count(x.soldQty)}</small></td>
                      <td className="num opt-col">{count(x.inQty)}</td><td className="num opt-col money">{rupees(x.inPaise)}</td><td className="num opt-col">{count(x.soldQty)}</td>
                      <td className="num amt-col money b">{rupees(x.salesPaise)}</td><td className="num opt-col money">{x.soldQty ? rupees(Math.round(x.salesPaise / x.soldQty)) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {((view === 'summary' && !data.rows.length) || (view === 'supplier' && !sups.length) || (view === 'quality' && !quals.length)) && <p className="empty">{t('Is period mein koi len-den nahi')}</p>}
          </div>
        </>
      )}
    </>
  )
}

// ================================================================ Purcha (purchase report)

type PurchaGaadi = {
  truckId: string; number: string; supplier: string; supplierKey: string; location: string; date: string; closed: boolean; freightPaise: number
  boxes: number; kg: number; kharidPaise: number; totalPaise: number; qualities: { name: string; boxes: number; kg: number; amountPaise: number; ratePaise: number }[]
  beejak: { id: string; no: number; date: string; netPaise: number; grossPaise: number } | null
}
type PurchaData = {
  from: string; to: string; gaadis: PurchaGaadi[]
  suppliers: { key: string; name: string; gaadis: number; boxes: number; kg: number; kharidPaise: number; freightPaise: number; beejakPaise: number; pending: number }[]
  totals: { gaadis: number; boxes: number; kg: number; kharidPaise: number; freightPaise: number; beejakPaise: number; pending: number }
}
const kgText = (kg: number) => (kg ? `${count(Math.round(kg))} kg` : '')

/** Gaadis received in a period: each quality's boxes and kg, kharid, bhada, beejak; and per supplier. */
export function Purcha({ shopId }: { shopId: string }) {
  const { shops } = useSession()
  const grapes = shops?.find((s) => s.id === shopId)?.commodity === 'angoor'
  const [period, setPeriod] = usePeriod('7')
  const [view, setView] = useState<'gaadi' | 'supplier'>('gaadi')
  const [q, setQ] = useState('')
  const [beejak, setBeejak] = useState<string | null>(null)
  const { data, error, loading } = useLoad(() => api<PurchaData>(`/v1/admin/shops/${shopId}/books/purcha?from=${period.from}&to=${period.to}`), [shopId, period.from, period.to])
  const gaadis = (data?.gaadis ?? []).filter((g) => has(q, g.number, g.supplier, g.location, ...g.qualities.map((x) => x.name)))
  const sups = (data?.suppliers ?? []).filter((s) => has(q, s.name))
  const maal = (g: PurchaGaadi) => g.qualities.map((x) => `${x.name} ${count(x.boxes)}`).join(' · ')
  // The total row adds up what is shown (a search narrows it).
  const ft = (view === 'gaadi'
    ? gaadis.map((g) => ({ gaadis: 1, boxes: g.boxes, kg: g.kg, kharidPaise: g.kharidPaise, freightPaise: g.freightPaise, beejakPaise: g.beejak?.netPaise ?? 0, pending: g.beejak ? 0 : 1 }))
    : sups).reduce((a, x) => ({ gaadis: a.gaadis + x.gaadis, boxes: a.boxes + x.boxes, kg: a.kg + x.kg, kharidPaise: a.kharidPaise + x.kharidPaise,
      freightPaise: a.freightPaise + x.freightPaise, beejakPaise: a.beejakPaise + x.beejakPaise, pending: a.pending + x.pending }),
    { gaadis: 0, boxes: 0, kg: 0, kharidPaise: 0, freightPaise: 0, beejakPaise: 0, pending: 0 })
  const open = (g: PurchaGaadi) => { if (grapes) setBeejak(g.truckId); else if (g.supplierKey) location.hash = href({ page: 'supplier', shopId, key: g.supplierKey }) }

  useExport(data ? () => ({
    style: 'book' as const, title: t('Purcha'), dateLine: dayRange(data.from, data.to), file: fileName('Purcha', data.from, data.to),
    ...(view === 'gaadi' ? {
      columns: [{ label: t('Tarikh') }, { label: t('Gaadi') }, { label: t('Supplier') }, { label: t('Maal'), wide: true }, { label: t('Box'), num: true }, { label: 'Kg', num: true }, { label: t('Kharid'), num: true }, { label: t('Bhada'), num: true }, { label: t('Beejak'), num: true }],
      rows: gaadis.map((g) => ({ cells: [dmy(g.date), g.number, g.supplier, maal(g), count(g.boxes), g.kg ? count(Math.round(g.kg)) : '', rs(g.kharidPaise), g.freightPaise ? rs(g.freightPaise) : '', g.beejak ? `#${g.beejak.no} ${rs(g.beejak.netPaise)}` : t('Baaki')] })),
      foot: ['', '', '', t('Kul'), count(ft.boxes), count(Math.round(ft.kg)), rs(ft.kharidPaise), rs(ft.freightPaise), rs(ft.beejakPaise)],
    } : {
      columns: [{ label: t('Supplier'), wide: true }, { label: t('Gaadi'), num: true }, { label: t('Box'), num: true }, { label: 'Kg', num: true }, { label: t('Kharid'), num: true }, { label: t('Bhada'), num: true }, { label: t('Beejak'), num: true }, { label: t('Beejak baaki'), num: true }],
      rows: sups.map((s) => ({ cells: [s.name, count(s.gaadis), count(s.boxes), s.kg ? count(Math.round(s.kg)) : '', rs(s.kharidPaise), rs(s.freightPaise), rs(s.beejakPaise), s.pending ? count(s.pending) : ''] })),
      foot: [t('Kul'), count(ft.gaadis), count(ft.boxes), count(Math.round(ft.kg)), rs(ft.kharidPaise), rs(ft.freightPaise), rs(ft.beejakPaise), count(ft.pending)],
    }),
  }) : null, [data, view, q])

  return (
    <>
      <div className="toolbar"><PeriodBar value={period} onChange={setPeriod} /><FyButton value={period} onChange={setPeriod} /></div>
      <div className="toolbar">
        <div className="seg" role="group">
          <button aria-pressed={view === 'gaadi'} onClick={() => setView('gaadi')}>{t('Gaadi')}</button>
          <button aria-pressed={view === 'supplier'} onClick={() => setView('supplier')}>{t('Supplier')}</button>
        </div>
        <input className="field grow" data-search type="search" placeholder={t('Gaadi, supplier ya maal')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Gaadi')}</span><span className="v">{count(data.totals.gaadis)}</span></div>
            <div><span className="lb">{t('Box')}</span><span className="v">{count(data.totals.boxes)}</span><small className="muted">{kgText(data.totals.kg)}</small></div>
            <div><span className="lb">{t('Kharid')} + {t('Bhada')}</span><span className="v">{rupees(data.totals.kharidPaise + data.totals.freightPaise)}</span></div>
            {(grapes || data.totals.beejakPaise > 0) && <div><span className="lb">{t('Beejak')}</span><span className="v">{rupees(data.totals.beejakPaise)}</span><small className={data.totals.pending ? 'due' : 'muted'}>{data.totals.pending ? t('{n} baaki', { n: data.totals.pending }) : ''}</small></div>}
          </div>
          <div className={`card wrap-x${loading ? ' dim' : ''}`}>
            {view === 'gaadi' ? (
              <table className="tbl fold">
                <thead><tr><th className="opt-col">{t('Tarikh')}</th><th>{t('Gaadi')}</th><th className="opt-col">{t('Maal')}</th><th className="num opt-col">{t('Box')}</th><th className="num opt-col">{t('Kharid')}</th><th className="num opt-col">{t('Bhada')}</th><th className="num">{t('Beejak')}</th></tr></thead>
                <tbody>
                  {gaadis.map((g) => (
                    <tr key={g.truckId} data-row tabIndex={0} onClick={() => open(g)} onKeyDown={(e) => { if (e.key === 'Enter') open(g) }}>
                      <td className="opt-col muted">{shortDate(g.date)}</td>
                      <td className="main-col"><b className="name">{g.number}</b> <span className="muted">{g.supplier}</span>
                        <small><span className="show-sm">{shortDate(g.date)} · {maal(g)}</span>{g.location ? <span className="hide-sm">{g.location}</span> : null}</small></td>
                      <td className="opt-col">{maal(g)}<small className="muted" style={{ display: 'block' }}>{kgText(g.kg)}</small></td>
                      <td className="num opt-col">{count(g.boxes)}</td>
                      <td className="num opt-col money">{rupees(g.kharidPaise)}</td>
                      <td className="num opt-col money">{g.freightPaise ? rupees(g.freightPaise) : ''}</td>
                      <td className="num amt-col">{g.beejak ? <span className="money b">#{g.beejak.no} {rupees(g.beejak.netPaise)}</span> : <span className="chip amber">{t('Baaki')}</span>}</td>
                    </tr>
                  ))}
                </tbody>
                {gaadis.length > 1 && (
                  <tfoot><tr><td className="opt-col" /><td className="main-col">{t('Kul')}</td><td className="opt-col">{kgText(ft.kg)}</td><td className="num opt-col">{count(ft.boxes)}</td>
                    <td className="num opt-col money">{rupees(ft.kharidPaise)}</td><td className="num opt-col money">{rupees(ft.freightPaise)}</td><td className="num amt-col money">{rupees(ft.beejakPaise)}</td></tr></tfoot>
                )}
              </table>
            ) : (
              <table className="tbl fold">
                <thead><tr><th>{t('Supplier')}</th><th className="num opt-col">{t('Gaadi')}</th><th className="num opt-col">{t('Box')}</th><th className="num opt-col">Kg</th><th className="num opt-col">{t('Kharid')}</th><th className="num opt-col">{t('Bhada')}</th><th className="num">{t('Beejak')}</th></tr></thead>
                <tbody>
                  {sups.map((s) => (
                    <tr key={s.key || s.name}>
                      <td className="main-col"><b>{s.name}</b><small className="show-sm">{t('{n} gaadi', { n: s.gaadis })} · {count(s.boxes)} {t('box')}</small></td>
                      <td className="num opt-col">{count(s.gaadis)}</td><td className="num opt-col">{count(s.boxes)}</td><td className="num opt-col">{s.kg ? count(Math.round(s.kg)) : ''}</td>
                      <td className="num opt-col money">{rupees(s.kharidPaise)}</td><td className="num opt-col money">{rupees(s.freightPaise)}</td>
                      <td className="num amt-col money b">{rupees(s.beejakPaise)}{s.pending ? <small className="due inline"> · {t('{n} baaki', { n: s.pending })}</small> : null}</td>
                    </tr>
                  ))}
                </tbody>
                {sups.length > 1 && (
                  <tfoot><tr><td className="main-col">{t('Kul')}</td><td className="num opt-col">{count(ft.gaadis)}</td><td className="num opt-col">{count(ft.boxes)}</td>
                    <td className="num opt-col">{count(Math.round(ft.kg))}</td><td className="num opt-col money">{rupees(ft.kharidPaise)}</td>
                    <td className="num opt-col money">{rupees(ft.freightPaise)}</td><td className="num amt-col money">{rupees(ft.beejakPaise)}</td></tr></tfoot>
                )}
              </table>
            )}
            {(view === 'gaadi' ? gaadis : sups).length === 0 && <p className="empty">{t('Is period mein koi gaadi nahi')}</p>}
          </div>
        </>
      )}
      {beejak && <BeejakSheet shopId={shopId} truckId={beejak} onClose={() => setBeejak(null)} />}
    </>
  )
}

// ================================================================ Backup

/** The shop's complete books as one Excel file, every table a sheet. Read-only. */
export function Backup({ shopId }: { shopId: string }) {
  const { shops } = useSession()
  const shop = shops?.find((s) => s.id === shopId)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const run = async () => {
    setBusy(true); setNote('')
    try {
      const { blob, name } = await apiDownload(`/v1/admin/shops/${shopId}/books/backup`)
      download(blob, name ?? `${fileName(shop?.name ?? 'shop', 'backup', todayIst())}.xlsx`)
      setNote(`${t('Backup save hua')} · ${(blob.size / 1024).toFixed(0)} KB`)
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="card" style={{ padding: 20, display: 'grid', gap: 14, maxWidth: 520 }}>
      <div>
        <b style={{ fontSize: 17 }}>{shop?.name}</b>
        <p className="muted" style={{ margin: '4px 0 0' }}>{t('Poore khate ek Excel file mein: har table ek sheet.')}</p>
      </div>
      <button type="button" className="btn primary" style={{ justifySelf: 'start' }} disabled={busy} onClick={() => void run()}>{busy ? t('Ban raha hai…') : t('Excel download')}</button>
      {note && <p className="muted" role="status" style={{ margin: 0 }}>{note}</p>}
    </div>
  )
}
