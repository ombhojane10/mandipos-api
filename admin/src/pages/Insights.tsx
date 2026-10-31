import { useEffect, useMemo, useState } from 'react'
import { api, type BuyerRow, type Outstanding as Out } from '../api'
import { useSession } from '../App'
import { count, date, phone, rate, rupees, shortDate } from '../format'
import { usePeriod } from '../hooks'
import { t } from '../i18n'
import { hashQuery, href, setHashQuery } from '../routes'
import { booksChanged, useLoad } from '../useLoad'
import { Bal, PeriodBar, Skeleton } from '../ui'
import { openRaseed, openVoucher, openWhatsApp } from '../keys'
import { dayRange, dmy, fileName, rs, useExport } from '../export/doc'
import { HEADS } from './DayBook'

const daysSince = (iso: string | null) => (iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso.length === 10 ? `${iso}T12:00:00+05:30` : iso)) / 86_400_000)) : null)
const MOBILE = /^[6-9]\d{9}$/

// ================================================================ Vasooli desk

/**
 * Who to chase today, as a munim works the udhaar book: the oldest dues and the longest
 * silences first, with a call and a WhatsApp reminder one tap away. Second tab: grahak who
 * used to buy and have stopped — the sale the shop is losing without noticing.
 */
export function Vasooli({ shopId }: { shopId: string }) {
  const { shops } = useSession()
  const shopName = shops?.find((s) => s.id === shopId)?.name ?? ''
  const [tab, setTab] = useState<'lena' | 'band'>(() => (hashQuery().get('v') === 'band' ? 'band' : 'lena'))
  const pick = (v: 'lena' | 'band') => { setTab(v); setHashQuery({ ...Object.fromEntries(hashQuery()), v }) }
  const out = useLoad(() => api<Out>(`/v1/admin/shops/${shopId}/outstanding`), [shopId])
  const all = useLoad(() => api<{ buyers: BuyerRow[] }>(`/v1/admin/shops/${shopId}/buyers?all=1&q=`).then((r) => r.buyers), [shopId])

  // Priority: no payment for longest, then the oldest due, then the biggest.
  const lena = useMemo(() => (out.data?.rows ?? []).map((r) => ({ ...r, quiet: daysSince(r.lastPaidAt ?? r.lastSlipOn) ?? 0 }))
    .sort((a, b) => b.quiet - a.quiet || (b.oldestDays ?? 0) - (a.oldestDays ?? 0) || b.duePaise - a.duePaise), [out.data])
  const band = useMemo(() => (all.data ?? []).filter((b) => !b.hidden && b.boughtPaise > 0 && (daysSince(b.lastSlipOn) ?? 0) >= 10)
    .map((b) => ({ ...b, away: daysSince(b.lastSlipOn) ?? 0 })).sort((a, b) => b.boughtPaise - a.boughtPaise), [all.data])

  const invite = (name: string, mobile: string) =>
    `https://wa.me/91${mobile}?text=${encodeURIComponent(t('Namaste {name} ji, {shop} mein aaj taaza maal aaya hai. Zaroor aaiye.', { name, shop: shopName }))}`

  useExport(tab === 'lena' && out.data ? () => ({
    style: 'book' as const, title: t('Vasooli list'), file: fileName('Vasooli', new Date().toISOString().slice(0, 10)),
    summary: [[t('Kul baaki'), rs(out.data!.totals.duePaise)], [t('Grahak'), count(out.data!.totals.count)]],
    columns: [{ label: t('Code') }, { label: t('Grahak'), wide: true }, { label: t('Mobile') }, { label: t('Baaki'), num: true }, { label: t('30+ din'), num: true }, { label: t('Chup'), num: true }],
    rows: lena.map((r) => ({ cells: [r.code, r.name, r.phone, rs(r.duePaise), r.d31 ? rs(r.d31) : '', t('{n} din', { n: r.quiet })] })),
  }) : tab === 'band' && all.data ? () => ({
    style: 'book' as const, title: t('Band grahak'), file: fileName('Band-grahak'),
    columns: [{ label: t('Code') }, { label: t('Grahak'), wide: true }, { label: t('Mobile') }, { label: t('Kharida'), num: true }, { label: t('Aakhri parchi') }],
    rows: band.map((b) => ({ cells: [b.code, b.name, b.phone, rs(b.boughtPaise), b.lastSlipOn ? dmy(b.lastSlipOn) : ''] })),
  }) : null, [tab, out.data, all.data])

  return (
    <>
      <div className="toolbar">
        <div className="seg" role="group">
          <button aria-pressed={tab === 'lena'} onClick={() => pick('lena')}>{t('Lena hai')} {out.data ? `(${lena.length})` : ''}</button>
          <button aria-pressed={tab === 'band'} onClick={() => pick('band')}>{t('Band grahak')} {all.data ? `(${band.length})` : ''}</button>
        </div>
      </div>
      {tab === 'lena' ? (
        !out.data ? <Skeleton /> : (
          <div className="stack">
            <div className="card sum">
              <div><span className="lb">{t('Kul baaki')}</span><span className="v due">{rupees(out.data.totals.duePaise)}</span></div>
              <div><span className="lb">{t('Grahak')}</span><span className="v">{count(out.data.totals.count)}</span></div>
              <div><span className="lb">{t('Hafte se chup')}</span><span className="v">{count(lena.filter((r) => r.quiet >= 7).length)}</span></div>
              <div><span className="lb">{t('30+ din')}</span><span className={`v${out.data.totals.d31 ? ' due' : ''}`}>{rupees(out.data.totals.d31)}</span></div>
            </div>
            <div className="card wrap-x">
              <table className="tbl fold">
                <thead><tr><th>{t('Code')}</th><th>{t('Grahak')}</th><th className="num">{t('Baaki')}</th><th className="num">{t('30+ din')}</th><th>{t('Aakhri vasooli')}</th><th className="num">{t('Chup')}</th><th>{t('Yaad dilayein')}</th></tr></thead>
                <tbody>
                  {lena.map((r) => {
                    const mobile = MOBILE.test(r.phone)
                    const open = () => { location.hash = href({ page: 'grahak', shopId, buyerId: r.buyerId }) }
                    return (
                      <tr key={r.buyerId} data-row tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open() }}>
                        <td className="code-col">{r.code ? <span className="code">{r.code}</span> : null}</td>
                        <td className="main-col"><b>{r.name}</b><small>{mobile ? phone(r.phone) : ''}<span className="show-sm">{mobile ? ' · ' : ''}{t('{n} din chup', { n: r.quiet })}</span></small></td>
                        <td className="num amt-col money b due">{rupees(r.duePaise)}</td>
                        <td className={`num opt-col money${r.d31 ? ' due' : ''}`}>{r.d31 ? rupees(r.d31) : ''}</td>
                        <td className="opt-col muted">{r.lastPaidAt ? shortDate(r.lastPaidAt.slice(0, 10)) : t('Kabhi nahi')}</td>
                        <td className={`num opt-col${r.quiet >= 15 ? ' due b' : ''}`}>{t('{n} din', { n: r.quiet })}</td>
                        <td className="act-col" onClick={(e) => e.stopPropagation()}>
                          {mobile && <a className="btn ghost act" href={`tel:+91${r.phone}`}>{t('Call')}</a>}
                          {mobile && <button type="button" className="btn ghost act" onClick={() => openWhatsApp(shopId, r.buyerId)}>WhatsApp</button>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {lena.length === 0 && <p className="empty">{t('Kisi par udhaar nahi')}</p>}
            </div>
          </div>
        )
      ) : (
        !all.data ? <Skeleton /> : (
          <div className="card wrap-x">
            <table className="tbl fold">
              <thead><tr><th>{t('Code')}</th><th>{t('Grahak')}</th><th className="num">{t('Kharida')}</th><th>{t('Aakhri parchi')}</th><th className="num">{t('Kitne din se')}</th><th>{t('Bulayein')}</th></tr></thead>
              <tbody>
                {band.map((b) => {
                  const mobile = MOBILE.test(b.phone)
                  const open = () => { location.hash = href({ page: 'grahak', shopId, buyerId: b.id }) }
                  return (
                    <tr key={b.id} data-row tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open() }}>
                      <td className="code-col">{b.code ? <span className="code">{b.code}</span> : null}</td>
                      <td className="main-col"><b>{b.name}</b><small>{mobile ? phone(b.phone) : ''}<span className="show-sm">{mobile ? ' · ' : ''}{t('{n} din se nahi aaye', { n: b.away })}</span></small></td>
                      <td className="num amt-col money">{rupees(b.boughtPaise)}</td>
                      <td className="opt-col muted">{b.lastSlipOn ? shortDate(b.lastSlipOn) : '—'}</td>
                      <td className="num opt-col">{t('{n} din', { n: b.away })}</td>
                      <td className="act-col" onClick={(e) => e.stopPropagation()}>
                        {mobile && <a className="btn ghost act" href={`tel:+91${b.phone}`}>{t('Call')}</a>}
                        {mobile && <a className="btn ghost act" target="_blank" rel="noreferrer" href={invite(b.name, b.phone)}>WhatsApp</a>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {band.length === 0 && <p className="empty">{t('Sab grahak aa rahe hain')}</p>}
          </div>
        )
      )}
    </>
  )
}

// ================================================================ Gaadi hisab

type Gaadi = {
  truckId: string; number: string; supplier: string; brands: string; arrivedOn: string; closedOn: string | null
  received: number; sold: number; spoiled: number; left: number; costPaise: number; buyRatePaise: number; landedRatePaise: number
  sellRatePaise: number; salesPaise: number; spoiledPaise: number; leftValuePaise: number; profitPaise: number
}
type GaadiTotals = { gaadis: number; costPaise: number; salesPaise: number; profitPaise: number; leftValuePaise: number; spoiledPaise: number }

/** Each gaadi's hisab: landed cost, sold for, phoota, left at cost — and its munafa so far. */
export function GaadiHisab({ shopId }: { shopId: string }) {
  const [view, setView] = useState<'active' | 'past'>(() => (hashQuery().get('v') === 'past' ? 'past' : 'active'))
  const pick = (v: 'active' | 'past') => { setView(v); setHashQuery({ ...Object.fromEntries(hashQuery()), v }) }
  const { data, error, loading } = useLoad(() => api<{ rows: Gaadi[]; totals: GaadiTotals }>(`/v1/admin/shops/${shopId}/gaadi-hisab?view=${view}`), [shopId, view])
  const pl = (p: number) => <span className={`money b ${p < 0 ? 'due' : 'jama'}`}>{p < 0 ? '−' : ''}{rupees(Math.abs(p))}</span>

  useExport(data ? () => ({
    style: 'book' as const, title: `${t('Gaadi Hisab')} · ${view === 'past' ? t('Past') : t('Active')}`, file: fileName('Gaadi-hisab', view),
    summary: [[t('Laagat'), rs(data.totals.costPaise)], [t('Bikri'), rs(data.totals.salesPaise)], [t('Munafa'), rs(data.totals.profitPaise)]],
    columns: [{ label: t('Gaadi'), wide: true }, { label: t('Aayi') }, { label: t('Aaya'), num: true }, { label: t('Bika'), num: true }, { label: t('Laagat/nag'), num: true },
      { label: t('Bika/nag'), num: true }, { label: t('Bikri'), num: true }, { label: t('Baaki maal'), num: true }, { label: t('Munafa'), num: true }],
    rows: data.rows.map((r) => ({ cells: [[r.number, r.supplier].filter(Boolean).join(' · '), dmy(r.arrivedOn), count(r.received), count(r.sold),
      (r.landedRatePaise / 100).toFixed(2), (r.sellRatePaise / 100).toFixed(2), rs(r.salesPaise), rs(r.leftValuePaise), rs(r.profitPaise)] })),
    foot: [t('Kul'), '', '', '', '', '', rs(data.totals.salesPaise), rs(data.totals.leftValuePaise), rs(data.totals.profitPaise)],
  }) : null, [data, view])

  return (
    <>
      <div className="toolbar">
        <div className="seg" role="group">
          <button aria-pressed={view === 'active'} onClick={() => pick('active')}>{t('Active')}</button>
          <button aria-pressed={view === 'past'} onClick={() => pick('past')}>{t('Past')}</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`stack${loading ? ' dim' : ''}`}>
          <div className="card sum">
            <div><span className="lb">{t('Gaadi')}</span><span className="v">{count(data.totals.gaadis)}</span></div>
            <div><span className="lb">{t('Laagat')}</span><span className="v">{rupees(data.totals.costPaise)}</span></div>
            <div><span className="lb">{t('Bikri')}</span><span className="v">{rupees(data.totals.salesPaise)}</span></div>
            {view === 'active' && <div><span className="lb">{t('Baaki maal (laagat)')}</span><span className="v">{rupees(data.totals.leftValuePaise)}</span></div>}
            <div><span className="lb">{t('Munafa')}</span><span className="v">{pl(data.totals.profitPaise)}</span></div>
          </div>
          <div className="card wrap-x">
            <table className="tbl fold">
              <thead><tr>
                <th>{t('Gaadi')}</th><th className="num">{t('Aaya')}</th><th className="num">{t('Bika')}</th><th className="num">{t('Phoota')}</th>
                <th className="num">{t('Kharid bhav')}</th><th className="num">{t('Laagat/nag')}</th><th className="num">{t('Bika/nag')}</th>
                <th className="num">{t('Bikri')}</th><th className="num">{t('Baaki maal')}</th><th className="num">{t('Munafa')}</th>
              </tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.truckId}>
                    <td className="main-col"><b>{r.number}</b><small>{[r.supplier, r.brands, shortDate(r.arrivedOn)].filter(Boolean).join(' · ')}<span className="show-sm"> · {t('{a}/{b} bika', { a: count(r.sold), b: count(r.received) })} · {rate(r.landedRatePaise)} → {rate(r.sellRatePaise)}</span></small></td>
                    <td className="num opt-col money">{count(r.received)}</td>
                    <td className="num opt-col money">{count(r.sold)}</td>
                    <td className="num opt-col money muted">{r.spoiled ? count(r.spoiled) : ''}</td>
                    <td className="num opt-col money">{rate(r.buyRatePaise)}</td>
                    <td className="num opt-col money">{rate(r.landedRatePaise)}</td>
                    <td className={`num opt-col money${r.sold && r.sellRatePaise < r.landedRatePaise ? ' due' : ''}`}>{r.sold ? rate(r.sellRatePaise) : '—'}</td>
                    <td className="num opt-col money">{rupees(r.salesPaise)}</td>
                    <td className="num opt-col money muted">{r.left ? rupees(r.leftValuePaise) : ''}</td>
                    <td className="num amt-col">{pl(r.profitPaise)}</td>
                  </tr>
                ))}
              </tbody>
              {data.rows.length > 1 && (
                <tfoot><tr>
                  <td className="main-col">{t('Kul')}</td><td className="opt-col" /><td className="opt-col" /><td className="opt-col" /><td className="opt-col" /><td className="opt-col" /><td className="opt-col" />
                  <td className="num opt-col money">{rupees(data.totals.salesPaise)}</td><td className="num opt-col money">{rupees(data.totals.leftValuePaise)}</td>
                  <td className="num amt-col">{pl(data.totals.profitPaise)}</td>
                </tr></tfoot>
              )}
            </table>
            {data.rows.length === 0 && <p className="empty">{view === 'past' ? t('Koi band gaadi nahi') : t('Koi khuli gaadi nahi')}</p>}
          </div>
          <p className="muted note">{t('Laagat = kharid + bhada + mazdoori + commission, har nag par. Munafa = bikri − bike aur phoote maal ki laagat.')}</p>
        </div>
      )}
    </>
  )
}

// ================================================================ Munafa (P&L)

type PL = {
  from: string; to: string; salesPaise: number; cogsPaise: number; spoiledPaise: number; grossPaise: number
  expenses: { head: string; paise: number }[]; expensePaise: number; otherIncome: { head: string; paise: number }[]; otherPaise: number; netPaise: number
}

/** Tally's Profit & Loss, as a mandi reads it: bikri, the maal's laagat, phoota, kharcha. */
export function Munafa({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('30')
  const { data, error, loading } = useLoad(() => api<PL>(`/v1/admin/shops/${shopId}/munafa?from=${period.from}&to=${period.to}`), [shopId, period.from, period.to])
  const head = (h: string) => HEADS[h] ?? h

  useExport(data ? () => ({
    style: 'book' as const, title: t('Munafa (P&L)'), dateLine: dayRange(period.from, period.to), file: fileName('Munafa', period.from, period.to), sign: true,
    rows: [
      { cells: [t('Bikri'), '', '', rs(data.salesPaise)] },
      { cells: [t('(−) Bike maal ki laagat'), '', '', rs(-data.cogsPaise)] },
      ...(data.spoiledPaise ? [{ cells: [t('(−) Phoota maal'), '', '', rs(-data.spoiledPaise)] }] : []),
      { kind: 'total' as const, cells: [t('Kul munafa'), '', '', rs(data.grossPaise)] },
      { kind: 'heading' as const, cells: [t('KHARCHA')] },
      ...data.expenses.map((e) => ({ cells: [head(e.head), '', '', rs(e.paise)] })),
      { kind: 'total' as const, cells: [t('Kul kharcha'), '', '', rs(data.expensePaise)] },
      ...(data.otherIncome.length ? [{ kind: 'heading' as const, cells: [t('AUR AAMDANI')] }, ...data.otherIncome.map((e) => ({ cells: [head(e.head), '', '', rs(e.paise)] }))] : []),
      { kind: 'final' as const, cells: [t('Shuddh munafa'), '', '', rs(data.netPaise)] },
    ],
  }) : null, [data])

  const line = (label: string, paise: number, cls = '') => <tr className={cls}><td>{label}</td><td className="num money">{paise < 0 ? `(−) ${rupees(-paise)}` : rupees(paise)}</td></tr>
  return (
    <>
      <div className="toolbar"><PeriodBar value={period} onChange={setPeriod} /></div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`stack${loading ? ' dim' : ''}`}>
          <div className="card sum">
            <div><span className="lb">{t('Bikri')}</span><span className="v">{rupees(data.salesPaise)}</span></div>
            <div><span className="lb">{t('Kul munafa')}</span><span className={`v ${data.grossPaise < 0 ? 'due' : 'jama'}`}>{rupees(data.grossPaise)}</span></div>
            <div><span className="lb">{t('Kharcha')}</span><span className="v">{rupees(data.expensePaise)}</span></div>
            <div><span className="lb">{t('Shuddh munafa')}</span><span className={`v ${data.netPaise < 0 ? 'due' : 'jama'}`}>{rupees(data.netPaise)}</span></div>
          </div>
          <div className="pl">
            <div className="card">
              <div className="hd"><h3>{t('Vyapar khata')}</h3></div>
              <table className="tbl pl-tbl"><tbody>
                {line(t('Bikri'), data.salesPaise)}
                {line(t('(−) Bike maal ki laagat'), -data.cogsPaise)}
                {data.spoiledPaise > 0 && line(t('(−) Phoota maal'), -data.spoiledPaise)}
              </tbody><tfoot>{line(t('Kul munafa'), data.grossPaise)}</tfoot></table>
            </div>
            <div className="card">
              <div className="hd"><h3>{t('Kharcha aur aamdani')}</h3></div>
              <table className="tbl pl-tbl"><tbody>
                {line(t('Kul munafa'), data.grossPaise, 'b')}
                {data.expenses.map((e) => <tr key={e.head}><td>(−) {head(e.head)}</td><td className="num money">{rupees(e.paise)}</td></tr>)}
                {data.otherIncome.map((e) => <tr key={e.head}><td>(+) {head(e.head)}</td><td className="num money">{rupees(e.paise)}</td></tr>)}
              </tbody><tfoot>{line(t('Shuddh munafa'), data.netPaise)}</tfoot></table>
            </div>
          </div>
          <p className="muted note">{t('Laagat gaadi ke har nag ki: kharid + bhada + mazdoori + commission. Mazdoori parchi par jitni bani, utni kharcha. Supplier ko diya, malik/bank ka len-den aur udhaar diya kharcha nahi.')}</p>
        </div>
      )}
    </>
  )
}

// ================================================================ Bikri register

type Reg = { from: string; to: string; days: { date: string; slips: number; nags: number; cashPaise: number; upiPaise: number; udhaarPaise: number; totalPaise: number; free: number }[]; totals: { slips: number; nags: number; cashPaise: number; upiPaise: number; udhaarPaise: number; totalPaise: number } }

/** Tally's Sales Register, columnar: a line per day — parchi, nag, cash, UPI, udhaar, kul. */
export function SalesRegister({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('30')
  const { data, error, loading } = useLoad(() => api<Reg>(`/v1/admin/shops/${shopId}/sales-register?from=${period.from}&to=${period.to}`), [shopId, period.from, period.to])
  const best = data ? Math.max(0, ...data.days.map((d) => d.totalPaise)) : 0

  useExport(data ? () => ({
    style: 'book' as const, title: t('Bikri Register'), dateLine: dayRange(period.from, period.to), file: fileName('Bikri-register', period.from, period.to),
    columns: [{ label: t('Tarikh') }, { label: t('Parchi'), num: true }, { label: t('Nag'), num: true }, { label: 'Cash', num: true }, { label: 'UPI', num: true }, { label: t('Udhaar'), num: true }, { label: t('Kul'), num: true }],
    rows: data.days.map((d) => ({ cells: [dmy(d.date), count(d.slips), count(d.nags), rs(d.cashPaise), rs(d.upiPaise), rs(d.udhaarPaise), rs(d.totalPaise)] })),
    foot: [t('Kul'), count(data.totals.slips), count(data.totals.nags), rs(data.totals.cashPaise), rs(data.totals.upiPaise), rs(data.totals.udhaarPaise), rs(data.totals.totalPaise)],
  }) : null, [data])

  return (
    <>
      <div className="toolbar"><PeriodBar value={period} onChange={setPeriod} /></div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th>{t('Tarikh')}</th><th className="num">{t('Parchi')}</th><th className="num">{t('Nag')}</th><th className="num">Cash</th><th className="num">UPI</th><th className="num">{t('Udhaar')}</th><th className="num">{t('Kul')}</th></tr></thead>
            <tbody>
              {data.days.map((d) => {
                const open = () => { location.hash = `${href({ page: 'report', shopId, report: 'daybook' })}?p=custom&from=${d.date}&to=${d.date}` }
                return (
                  <tr key={d.date} data-row tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open() }}>
                    <td className="main-col"><b>{date(d.date)}</b><small className="show-sm">{t('{n} parchi', { n: d.slips })} · {count(d.nags)} {t('nag')}</small></td>
                    <td className="num opt-col money">{count(d.slips)}</td>
                    <td className="num opt-col money">{count(d.nags)}</td>
                    <td className="num opt-col money">{rupees(d.cashPaise)}</td>
                    <td className="num opt-col money">{rupees(d.upiPaise)}</td>
                    <td className="num opt-col money">{d.udhaarPaise ? rupees(d.udhaarPaise) : ''}</td>
                    <td className={`num amt-col money b${d.totalPaise === best && best > 0 ? ' jama' : ''}`}>{rupees(d.totalPaise)}</td>
                  </tr>
                )
              })}
            </tbody>
            {data.days.length > 0 && (
              <tfoot><tr>
                <td className="main-col">{t('Kul')}</td><td className="num opt-col money">{count(data.totals.slips)}</td><td className="num opt-col money">{count(data.totals.nags)}</td>
                <td className="num opt-col money">{rupees(data.totals.cashPaise)}</td><td className="num opt-col money">{rupees(data.totals.upiPaise)}</td>
                <td className="num opt-col money">{rupees(data.totals.udhaarPaise)}</td><td className="num amt-col money">{rupees(data.totals.totalPaise)}</td>
              </tr></tfoot>
            )}
          </table>
          {data.days.length === 0 && <p className="empty">{t('Is period mein bikri nahi')}</p>}
        </div>
      )}
    </>
  )
}

// ================================================================ Nigrani (exceptions)

type Nig = {
  voids: { billId: string; slipNo: number | null; number: string; buyer: string; totalPaise: number; reason: string; at: string; date: string; machine: string; by: string }[]
  receipts: { id: string; receiptNo: number | null; buyer: string; amountPaise: number; reason: string; at: string; by: string }[]
  belowBhav: { billId: string; slipNo: number | null; buyer: string; date: string; brand: string; grade: string; qty: number; ratePaise: number; bhavPaise: number; lossPaise: number; machine: string }[]
  overLimit: { buyerId: string; name: string; phone: string; code: string; balancePaise: number; limitPaise: number }[]
  night: { billId: string; slipNo: number | null; buyer: string; totalPaise: number; at: string; machine: string }[]
  bigKharcha: { id: string; head: string; party: string; note: string; amountPaise: number; mode: string; date: string }[]
}
const REASON: Record<string, string> = { deleted: 'Hatayi', edited: 'Badli', refunded: 'Paisa wapas', advance: 'Advance mein' }
/** Who changed it: the machine that voided it, else (older rows) the one that made it. */
const changedBy = (v: { by?: string; machine?: string }) => v.by || v.machine || ''
const clock = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })

/** Tally's Exception Reports for a mandi: what the owner should look at before trusting the day. */
export function Nigrani({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('7')
  const { data, error, loading } = useLoad(() => api<Nig>(`/v1/admin/shops/${shopId}/nigrani?from=${period.from}&to=${period.to}`), [shopId, period.from, period.to])
  const loss = data?.belowBhav.reduce((s, b) => s + b.lossPaise, 0) ?? 0

  useExport(data ? () => ({
    style: 'book' as const, title: t('Nigrani'), dateLine: dayRange(period.from, period.to), file: fileName('Nigrani', period.from, period.to), sign: true,
    columns: [{ label: t('Kya') }, { label: t('Kaun'), wide: true }, { label: t('Kab') }, { label: t('Machine') }, { label: t('Rakam'), num: true }],
    rows: [
      { kind: 'band' as const, cells: [`${t('Hatayi / badli parchi')} (${data.voids.length})`] },
      ...data.voids.map((v) => ({ cells: [`${t('Parchi')} ${v.slipNo ?? v.number} · ${t(REASON[v.reason] ?? v.reason)}`, v.buyer, clock(v.at), changedBy(v), rs(v.totalPaise)] })),
      { kind: 'band' as const, cells: [`${t('Bhav se kam')} (${data.belowBhav.length})`] },
      ...data.belowBhav.map((b) => ({ cells: [`${t('Parchi')} ${b.slipNo ?? ''} · ${b.qty} × ${(b.ratePaise / 100).toFixed(2)} (${t('bhav')} ${(b.bhavPaise / 100).toFixed(2)})`, b.buyer, dmy(b.date), b.machine, rs(b.lossPaise)] })),
      { kind: 'band' as const, cells: [`${t('Limit se upar udhaar')} (${data.overLimit.length})`] },
      ...data.overLimit.map((o) => ({ cells: [`${t('Limit')} ${rs(o.limitPaise)}`, o.name, '', '', rs(o.balancePaise)] })),
      { kind: 'band' as const, cells: [`${t('Raat ki parchi')} (${data.night.length})`] },
      ...data.night.map((x) => ({ cells: [`${t('Parchi')} ${x.slipNo ?? ''}`, x.buyer, clock(x.at), x.machine, rs(x.totalPaise)] })),
      { kind: 'band' as const, cells: [`${t('Hatayi raseed')} (${data.receipts.length})`] },
      ...data.receipts.map((r) => ({ cells: [`${t('Raseed')} ${r.receiptNo ?? ''} · ${t(REASON[r.reason] ?? r.reason)}`, r.buyer, clock(r.at), changedBy(r), rs(r.amountPaise)] })),
      { kind: 'band' as const, cells: [`${t('Bade kharche')} (${data.bigKharcha.length})`] },
      ...data.bigKharcha.map((k) => ({ cells: [HEADS[k.head] ?? k.head, [k.party, k.note].filter(Boolean).join(' · '), dmy(k.date), k.mode, rs(k.amountPaise)] })),
    ],
  }) : null, [data])

  return (
    <>
      <div className="toolbar"><PeriodBar value={period} onChange={setPeriod} /></div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`stack${loading ? ' dim' : ''}`}>
          <div className="card sum">
            <div><span className="lb">{t('Hatayi / badli parchi')}</span><span className={`v${data.voids.length ? ' due' : ''}`}>{data.voids.length}</span></div>
            <div><span className="lb">{t('Bhav se kam')}</span><span className={`v${loss ? ' due' : ''}`}>{rupees(loss)}</span></div>
            <div><span className="lb">{t('Limit se upar')}</span><span className={`v${data.overLimit.length ? ' due' : ''}`}>{data.overLimit.length}</span></div>
            <div><span className="lb">{t('Raat ki parchi')}</span><span className="v">{data.night.length}</span></div>
          </div>
          <Section title={t('Hatayi / badli parchi')} n={data.voids.length} cols={[t('Parchi'), t('Grahak'), t('Kab'), t('Kisne'), t('Rakam')]}>
            {data.voids.map((v) => (
              <tr key={v.billId} data-row tabIndex={0} onClick={() => openVoucher(shopId, v.billId)} onKeyDown={(e) => { if (e.key === 'Enter') openVoucher(shopId, v.billId) }}>
                <td className="main-col"><b>{v.slipNo ?? v.number}</b> <span className="due">{t(REASON[v.reason] ?? v.reason)}</span><small className="show-sm">{v.buyer} · {clock(v.at)}</small></td>
                <td className="opt-col">{v.buyer}</td><td className="opt-col muted">{clock(v.at)}</td><td className="opt-col muted">{changedBy(v)}</td>
                <td className="num amt-col money">{rupees(v.totalPaise)}</td>
              </tr>
            ))}
          </Section>
          <Section title={t('Bhav se kam bechi')} n={data.belowBhav.length} cols={[t('Parchi'), t('Grahak'), t('Maal'), t('Bechi / bhav'), t('Ghata')]}>
            {data.belowBhav.map((b, i) => (
              <tr key={`${b.billId}-${i}`} data-row tabIndex={0} onClick={() => openVoucher(shopId, b.billId)} onKeyDown={(e) => { if (e.key === 'Enter') openVoucher(shopId, b.billId) }}>
                <td className="main-col"><b>{b.slipNo ?? '—'}</b> <small>{shortDate(b.date)} · {b.machine}</small><small className="show-sm">{b.buyer} · {count(b.qty)} × {rate(b.ratePaise)} / {rate(b.bhavPaise)}</small></td>
                <td className="opt-col">{b.buyer}</td><td className="opt-col muted">{b.brand} · {b.grade} · {count(b.qty)} {t('nag')}</td>
                <td className="opt-col money">{rate(b.ratePaise)} / {rate(b.bhavPaise)}</td>
                <td className="num amt-col money due">{rupees(b.lossPaise)}</td>
              </tr>
            ))}
          </Section>
          <Section title={t('Limit se upar udhaar')} n={data.overLimit.length} cols={[t('Grahak'), t('Mobile'), t('Limit'), '', t('Baaki')]}>
            {data.overLimit.map((o) => (
              <tr key={o.buyerId} data-row tabIndex={0} onClick={() => { location.hash = href({ page: 'grahak', shopId, buyerId: o.buyerId }) }}>
                <td className="main-col"><b>{o.name}</b><small className="show-sm">{t('Limit')} {rupees(o.limitPaise)}</small></td>
                <td className="opt-col muted">{o.phone ? phone(o.phone) : ''}</td><td className="opt-col money">{rupees(o.limitPaise)}</td><td className="opt-col" />
                <td className="num amt-col"><Bal paise={o.balancePaise} /></td>
              </tr>
            ))}
          </Section>
          <Section title={t('Raat ki parchi (10 baje ke baad)')} n={data.night.length} cols={[t('Parchi'), t('Grahak'), t('Kab'), t('Machine'), t('Rakam')]}>
            {data.night.map((x) => (
              <tr key={x.billId} data-row tabIndex={0} onClick={() => openVoucher(shopId, x.billId)} onKeyDown={(e) => { if (e.key === 'Enter') openVoucher(shopId, x.billId) }}>
                <td className="main-col"><b>{x.slipNo ?? '—'}</b><small className="show-sm">{x.buyer} · {clock(x.at)}</small></td>
                <td className="opt-col">{x.buyer}</td><td className="opt-col muted">{clock(x.at)}</td><td className="opt-col muted">{x.machine}</td>
                <td className="num amt-col money">{rupees(x.totalPaise)}</td>
              </tr>
            ))}
          </Section>
          <Section title={t('Hatayi raseed')} n={data.receipts.length} cols={[t('Raseed'), t('Grahak'), t('Kab'), t('Kisne'), t('Rakam')]}>
            {data.receipts.map((r) => (
              <tr key={r.id} data-row tabIndex={0} onClick={() => openRaseed(shopId, r.id)} onKeyDown={(e) => { if (e.key === 'Enter') openRaseed(shopId, r.id) }}>
                <td className="main-col"><b>{r.receiptNo ?? '—'}</b> <span className="due">{t(REASON[r.reason] ?? r.reason)}</span><small className="show-sm">{r.buyer} · {clock(r.at)}</small></td>
                <td className="opt-col">{r.buyer}</td><td className="opt-col muted">{clock(r.at)}</td><td className="opt-col muted">{changedBy(r)}</td>
                <td className="num amt-col money">{rupees(r.amountPaise)}</td>
              </tr>
            ))}
          </Section>
          <Section title={t('Bade kharche (₹5,000+)')} n={data.bigKharcha.length} cols={[t('Kis cheez ka'), t('Kisko'), t('Tarikh'), t('Kahan se'), t('Rakam')]}>
            {data.bigKharcha.map((k) => (
              <tr key={k.id}>
                <td className="main-col"><b>{HEADS[k.head] ?? k.head}</b><small className="show-sm">{[k.party, k.note].filter(Boolean).join(' · ')} · {shortDate(k.date)}</small></td>
                <td className="opt-col">{[k.party, k.note].filter(Boolean).join(' · ')}</td><td className="opt-col muted">{shortDate(k.date)}</td><td className="opt-col muted">{k.mode}</td>
                <td className="num amt-col money">{rupees(k.amountPaise)}</td>
              </tr>
            ))}
          </Section>
        </div>
      )}
    </>
  )
}

function Section({ title, n, cols, children }: { title: string; n: number; cols: string[]; children: React.ReactNode }) {
  return (
    <div className="card wrap-x">
      <div className="hd"><h3>{title}</h3><span className={n ? 'due b' : 'muted'}>{n ? n : t('Sab theek')}</span></div>
      {n > 0 && (
        <table className="tbl fold">
          <thead><tr>{cols.map((c, i) => <th key={i} className={i === cols.length - 1 ? 'num' : undefined}>{c}</th>)}</tr></thead>
          <tbody>{children}</tbody>
        </table>
      )}
    </div>
  )
}

// ================================================================ Aaj ka bhav

type Sheet = { date: string; brands: { id: string; name: string; grades: { grade: '1' | '2' | '3'; ratePaise: number | null; lastPaise: number | null }[] }[] }

/**
 * Aaj ka bhav, set from anywhere: every maal × grade, today's rate beside the last one. Saved
 * as a terminal's rate sheet saves it, so the counters pick it up on their next sync.
 */
export function Bhav({ shopId }: { shopId: string }) {
  const { data, error, reload } = useLoadReload(() => api<Sheet>(`/v1/admin/shops/${shopId}/bhav`), [shopId])
  const [edit, setEdit] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  useEffect(() => { setEdit({}) }, [data])
  const key = (b: string, g: string) => `${b}:${g}`
  const changed = Object.entries(edit).filter(([k, v]) => {
    const [b, g] = k.split(':')
    const cur = data?.brands.find((x) => x.id === b)?.grades.find((x) => x.grade === g)?.ratePaise ?? null
    const next = v.trim() === '' ? null : Math.round(Number(v) * 100)
    return next !== null && next > 0 && next !== cur
  })
  const copyLast = () => {
    if (!data) return
    const next: Record<string, string> = {}
    for (const b of data.brands) for (const g of b.grades) if (g.ratePaise === null && g.lastPaise) next[key(b.id, g.grade)] = String(g.lastPaise / 100)
    setEdit({ ...next, ...edit })
  }
  const save = async () => {
    if (!changed.length) return
    setBusy(true); setMsg('')
    try {
      await api(`/v1/admin/shops/${shopId}/bhav`, { method: 'POST', body: { rates: changed.map(([k, v]) => { const [brandId, grade] = k.split(':'); return { brandId, grade, ratePaise: Math.round(Number(v) * 100) } }) } })
      setMsg(t('{n} bhav save hue', { n: changed.length }))
      booksChanged(); reload()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  useExport(data ? () => ({
    style: 'book' as const, title: t('Aaj ka bhav'), dateLine: dayRange(data.date, data.date), file: fileName('Bhav', data.date),
    columns: [{ label: t('Maal'), wide: true }, { label: '1st', num: true }, { label: '2nd', num: true }, { label: '3rd', num: true }],
    rows: data.brands.map((b) => ({ cells: [b.name, ...b.grades.map((g) => (g.ratePaise ? (g.ratePaise / 100).toFixed(2) : ''))] })),
  }) : null, [data])

  return (
    <div className="stack" onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save() } }}>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <>
          <div className="toolbar" style={{ margin: 0 }}>
            <b>{date(data.date)}</b>
            <span className="grow" />
            <button type="button" className="btn ghost" onClick={copyLast}>{t('Pichhla bhav bharein')}</button>
          </div>
          <div className="card wrap-x">
            <table className="tbl bhav">
              <thead><tr><th>{t('Maal')}</th><th className="num">1st</th><th className="num">2nd</th><th className="num">3rd</th></tr></thead>
              <tbody>
                {data.brands.map((b) => (
                  <tr key={b.id}>
                    <td><b>{b.name}</b></td>
                    {b.grades.map((g) => {
                      const k = key(b.id, g.grade)
                      const shown = edit[k] ?? (g.ratePaise !== null ? String(g.ratePaise / 100) : '')
                      return (
                        <td key={g.grade} className="num">
                          <input className={`field bhav-in${edit[k] !== undefined ? ' dirty' : ''}`} inputMode="decimal" aria-label={`${b.name} ${g.grade}`} value={shown}
                            placeholder={g.lastPaise ? String(g.lastPaise / 100) : '—'}
                            onChange={(e) => setEdit({ ...edit, [k]: e.target.value.replace(/[^\d.]/g, '') })} />
                          {g.lastPaise !== null && <small className="muted">{t('pichhla')} {rate(g.lastPaise)}</small>}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {data.brands.length === 0 && <p className="empty">{t('Koi maal nahi')}</p>}
          </div>
          <div className="set-bar">
            {msg && <span className="muted">{msg}</span>}
            <span className="grow" />
            <button type="button" className="btn primary" disabled={busy || !changed.length} onClick={() => void save()}>
              <kbd>Ctrl+↵: </kbd>{busy ? '…' : changed.length ? t('{n} bhav save karein', { n: changed.length }) : t('Save')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** useLoad with a manual reload, for a page that saves and reads back. */
function useLoadReload<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [n, setN] = useState(0)
  const r = useLoad(fn, [...deps, n])
  return { ...r, reload: () => setN((x) => x + 1) }
}
