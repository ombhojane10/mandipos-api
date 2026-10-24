import { useState } from 'react'
import { api } from '../api'
import { DayBars } from '../Chart'
import { count, rupees, shortDate, time } from '../format'
import { usePeriod } from '../hooks'
import { t } from '../i18n'
import { openVoucher } from '../keys'
import { hashQuery, href, setHashQuery } from '../routes'
import { useLoad } from '../useLoad'
import { Kpi, PeriodBar, Skeleton } from '../ui'
import * as I from '../icons'
import { dayRange, fileName, rs, useExport } from '../export/doc'

// ================================================================ the grapes desk

/**
 * One read of the grapes books (GET /angoor) feeds five pages: dispatch at the gaadi, where each
 * gaadi stands, the party's commission, APMC by day, and mazdoori charged against paid.
 */
export type Desk = {
  from: string; to: string; commissionBps: number
  slips: { billId: string; slipNo: number | null; buyer: string; date: string; at: string; payMode: string; totalPaise: number
    boxes: number; picked: number; left: number; lastPickAt: string | null; gaadis: { truckId: string; number: string; location: string; qty: number }[] }[]
  gaadis: { truckId: string; number: string; supplier: string; supplierKey: string; location: string; arrivedOn: string
    received: number; sold: number; soldNow: number; left: number; waiting: number
    qualities: { name: string; kg: number; ratePaise: number; received: number; sold: number; off: number; left: number }[] }[]
  suppliers: { key: string; name: string; gaadis: string[]; boxes: number; salesPaise: number; commissionPaise: number; netPaise: number }[]
  days: { date: string; slips: number; goodsPaise: number; apmcPaise: number; labourPaise: number; labourPaidPaise: number }[]
  totals: { slips: number; boxes: number; picked: number; pendingSlips: number; doneSlips: number; openGaadis: number; boxesLeft: number
    salesPaise: number; commissionPaise: number; goodsPaise: number; apmcPaise: number; labourPaise: number; labourPaidPaise: number }
}

export const loadDesk = (shopId: string, from: string, to: string, bps = 600) =>
  api<Desk>(`/v1/admin/shops/${shopId}/angoor?from=${from}&to=${to}&commissionBps=${bps}`)

const slipName = (s: { slipNo: number | null }) => (s.slipNo ? `#${s.slipNo}` : t('Parchi'))
const box = (n: number) => t('{n} box', { n: count(n) })

// ================================================================ Dispatch

/** Each slip's boxes against what the labour has handed over at the gaadi (QR scans). */
export function Dispatch({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('aaj')
  const [view, setView] = useState<'baaki' | 'done' | 'sab'>(() => (['done', 'sab'].includes(hashQuery().get('v') ?? '') ? hashQuery().get('v') as 'done' | 'sab' : 'baaki'))
  const pick = (v: typeof view) => { setView(v); setHashQuery({ ...Object.fromEntries(hashQuery()), v }) }
  const { data, error, loading } = useLoad(() => loadDesk(shopId, period.from, period.to), [shopId, period.from, period.to])
  const rows = (data?.slips ?? []).filter((s) => (view === 'sab' ? true : view === 'done' ? s.left === 0 : s.left > 0))

  useExport(data ? () => ({
    style: 'book' as const, title: t('Dispatch'), dateLine: dayRange(period.from, period.to), file: fileName('Dispatch', period.from, period.to),
    columns: [{ label: t('Parchi') }, { label: t('Grahak'), wide: true }, { label: t('Gaadi'), wide: true }, { label: t('Box'), num: true }, { label: t('Diye'), num: true }, { label: t('Baaki'), num: true }],
    rows: data.slips.map((s) => ({ cells: [slipName(s), s.buyer, s.gaadis.map((g) => [g.number, g.location].filter(Boolean).join(' · ')).join(', '), count(s.boxes), count(s.picked), count(s.left)] })),
    foot: [t('Kul'), '', '', count(data.totals.boxes), count(data.totals.picked), count(data.totals.boxes - data.totals.picked)],
  }) : null, [data])

  return (
    <>
      <div className="toolbar">
        <PeriodBar value={period} onChange={setPeriod} />
        <div className="seg" role="group">
          <button aria-pressed={view === 'baaki'} onClick={() => pick('baaki')}>{t('Baaki')}{data ? ` · ${data.totals.pendingSlips}` : ''}</button>
          <button aria-pressed={view === 'done'} onClick={() => pick('done')}>{t('Ho gaya')}{data ? ` · ${data.totals.doneSlips}` : ''}</button>
          <button aria-pressed={view === 'sab'} onClick={() => pick('sab')}>{t('Sab')}</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`stack${loading ? ' dim' : ''}`}>
          <div className="card sum">
            <div><span className="lb">{t('Parchi')}</span><span className="v">{count(data.totals.slips)}</span></div>
            <div><span className="lb">{t('Box')}</span><span className="v">{count(data.totals.boxes)}</span></div>
            <div><span className="lb">{t('Diye')}</span><span className="v jama">{count(data.totals.picked)}</span></div>
            <div><span className="lb">{t('Baaki')}</span><span className={`v${data.totals.boxes > data.totals.picked ? ' due' : ''}`}>{count(data.totals.boxes - data.totals.picked)}</span></div>
          </div>
          <div className="card wrap-x">
            <table className="tbl fold">
              <thead><tr><th>{t('Parchi')}</th><th>{t('Gaadi')}</th><th className="num">{t('Box')}</th><th className="num">{t('Diye')}</th><th className="num">{t('Baaki')}</th></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.billId} data-row tabIndex={0} onClick={() => openVoucher(shopId, s.billId)} onKeyDown={(e) => { if (e.key === 'Enter') openVoucher(shopId, s.billId) }}>
                    <td className="main-col"><b>{slipName(s)} · {s.buyer}</b>
                      <small>{[period.from !== period.to ? shortDate(s.date) : '', time(s.at), s.lastPickAt ? t('diya {at}', { at: time(s.lastPickAt) }) : ''].filter(Boolean).join(' · ')}
                        <span className="show-sm"> · {s.gaadis.map((g) => g.number).join(', ')}</span></small></td>
                    <td className="opt-col">{s.gaadis.map((g) => <div key={g.truckId}><b>{g.number}</b>{g.location && <small className="muted"> · {g.location}</small>}</div>)}</td>
                    <td className="num opt-col money">{count(s.boxes)}</td>
                    <td className="num opt-col money">{s.picked ? count(s.picked) : ''}</td>
                    <td className="num amt-col">{s.left === 0 ? <span className="chip green">{t('Ho gaya')}</span> : <span className="chip amber">{box(s.left)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="empty">{view === 'baaki' ? t('Sab maal de diya') : t('Koi parchi nahi')}</p>}
          </div>
        </div>
      )}
    </>
  )
}

// ================================================================ Gaadi kahan

/** Every open gaadi: where it stands, whose it is, what each quality has left and what waits to be handed over. */
export function GaadiPata({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('aaj')
  const { data, error, loading } = useLoad(() => loadDesk(shopId, period.from, period.to), [shopId, period.from, period.to])

  useExport(data ? () => ({
    style: 'book' as const, title: t('Gaadi kahan'), file: fileName('Gaadi-kahan', period.to),
    columns: [{ label: t('Gaadi'), wide: true }, { label: t('Jagah'), wide: true }, { label: t('Quality'), wide: true }, { label: t('Aaya'), num: true }, { label: t('Bika'), num: true }, { label: t('Baaki'), num: true }],
    rows: data.gaadis.flatMap((g) => g.qualities.map((q, i) => ({ cells: [i ? '' : [g.number, g.supplier].filter(Boolean).join(' · '), i ? '' : g.location, q.name, count(q.received), count(q.sold), count(q.left)] }))),
  }) : null, [data])

  return (
    <>
      <div className="toolbar"><PeriodBar value={period} onChange={setPeriod} /></div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`stack${loading ? ' dim' : ''}`}>
          <div className="card sum">
            <div><span className="lb">{t('Khuli gaadi')}</span><span className="v">{count(data.totals.openGaadis)}</span></div>
            <div><span className="lb">{t('Baaki maal')}</span><span className="v">{box(data.totals.boxesLeft)}</span></div>
            <div><span className="lb">{t('Dena baaki')}</span><span className={`v${data.gaadis.some((g) => g.waiting) ? ' due' : ''}`}>{box(data.gaadis.reduce((s, g) => s + g.waiting, 0))}</span></div>
          </div>
          {data.gaadis.length === 0 && <div className="card"><p className="empty">{t('Koi khuli gaadi nahi')}</p></div>}
          <div className="grid g3 stack-sm">
            {data.gaadis.map((g) => (
              <div key={g.truckId} className="card">
                <div className="hd">
                  <h3>{g.number}</h3>
                  {g.supplierKey ? <a href={href({ page: 'supplier', shopId, key: g.supplierKey })}>{g.supplier} ›</a> : <span className="muted">{g.supplier}</span>}
                </div>
                <div className="bd">
                  <div className="gaadi-at"><b>📍 {g.location || '—'}</b><small className="muted">{shortDate(g.arrivedOn)}</small></div>
                  <table className="tbl gaadi-q-tbl">
                    <thead><tr><th>{t('Quality')}</th><th className="num">{t('Aaya')}</th><th className="num">{t('Bika')}</th><th className="num">{t('Baaki')}</th></tr></thead>
                    <tbody>
                      {g.qualities.map((q) => (
                        <tr key={q.name}>
                          <td><b>{q.name}</b>{q.kg > 0 && <small className="muted kg">{q.kg} kg</small>}</td>
                          <td className="num money">{count(q.received)}</td>
                          <td className="num money">{count(q.sold)}</td>
                          <td className={`num money b${q.left < 0 ? ' due' : ''}`}>{count(q.left)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="gaadi-ft">
                    {g.soldNow > 0 && <span className="chip blue">{t('{n} bika', { n: count(g.soldNow) })}</span>}
                    {g.waiting > 0 ? <span className="chip amber">{t('{n} box dena baaki', { n: count(g.waiting) })}</span> : <span className="chip grey">{t('Kuch dena nahi')}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

// ================================================================ Supplier commission

const BPS_KEY = (shopId: string) => `mp.angoor.bps.${shopId}`
function readBps(shopId: string): number {
  try { const v = Number(localStorage.getItem(BPS_KEY(shopId))); return Number.isFinite(v) && v > 0 ? v : 600 } catch { return 600 }
}

/** Each party's boxes and bikri over the period, and the shop's commission on it, as the beejak takes it. */
export function Commission({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('7')
  const [bps, setBps] = useState(() => readBps(shopId))
  const [pct, setPct] = useState(() => String(bps / 100))
  const { data, error, loading } = useLoad(() => loadDesk(shopId, period.from, period.to, bps), [shopId, period.from, period.to, bps])
  const apply = (v: string) => {
    setPct(v)
    const n = Math.round(Number(v) * 100)
    if (!Number.isFinite(n) || n < 0 || n > 5000) return
    setBps(n)
    try { localStorage.setItem(BPS_KEY(shopId), String(n)) } catch { /* stays for this visit */ }
  }

  useExport(data ? () => ({
    style: 'book' as const, title: `${t('Supplier commission')} · ${bps / 100}%`, dateLine: dayRange(period.from, period.to), file: fileName('Commission', period.from, period.to),
    columns: [{ label: t('Supplier'), wide: true }, { label: t('Gaadi'), wide: true }, { label: t('Box'), num: true }, { label: t('Bikri'), num: true }, { label: t('Commission'), num: true }, { label: t('Party ko'), num: true }],
    rows: data.suppliers.map((s) => ({ cells: [s.name, s.gaadis.join(', '), count(s.boxes), rs(s.salesPaise), rs(s.commissionPaise), rs(s.netPaise)] })),
    foot: [t('Kul'), '', count(data.suppliers.reduce((x, s) => x + s.boxes, 0)), rs(data.totals.salesPaise), rs(data.totals.commissionPaise), rs(data.totals.salesPaise - data.totals.commissionPaise)],
  }) : null, [data, bps])

  return (
    <>
      <div className="toolbar">
        <PeriodBar value={period} onChange={setPeriod} />
        <label className="pct-in"><span>{t('Commission')}</span><input className="field" inputMode="decimal" value={pct} onChange={(e) => apply(e.target.value)} /><span>%</span></label>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`stack${loading ? ' dim' : ''}`}>
          <div className="card sum">
            <div><span className="lb">{t('Bikri')}</span><span className="v">{rupees(data.totals.salesPaise)}</span></div>
            <div><span className="lb">{t('Commission')}</span><span className="v jama">{rupees(data.totals.commissionPaise)}</span></div>
            <div><span className="lb">{t('Party ko')}</span><span className="v">{rupees(data.totals.salesPaise - data.totals.commissionPaise)}</span></div>
          </div>
          <div className="card wrap-x">
            <table className="tbl fold">
              <thead><tr><th>{t('Supplier')}</th><th className="num">{t('Box')}</th><th className="num">{t('Bikri')}</th><th className="num">{t('Party ko')}</th><th className="num">{t('Commission')}</th></tr></thead>
              <tbody>
                {data.suppliers.map((s) => (
                  <tr key={s.key || s.name} data-row={s.key ? true : undefined} tabIndex={s.key ? 0 : -1}
                    onClick={() => { if (s.key) location.hash = href({ page: 'supplier', shopId, key: s.key }) }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && s.key) location.hash = href({ page: 'supplier', shopId, key: s.key }) }}>
                    <td className="main-col"><b>{s.name}</b><small>{s.gaadis.join(', ')}<span className="show-sm"> · {box(s.boxes)} · {rupees(s.salesPaise)}</span></small></td>
                    <td className="num opt-col money">{count(s.boxes)}</td>
                    <td className="num opt-col money">{rupees(s.salesPaise)}</td>
                    <td className="num opt-col money">{rupees(s.netPaise)}</td>
                    <td className="num amt-col"><span className="money b jama">{rupees(s.commissionPaise)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.suppliers.length === 0 && <p className="empty">{t('Is period mein bikri nahi')}</p>}
          </div>
        </div>
      )}
    </>
  )
}

// ================================================================ APMC

const APMC = '#2a6b73'

/** The 1% market fee the slips carried, day by day, against the goods it was charged on. */
export function Apmc({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('30')
  const { data, error, loading } = useLoad(() => loadDesk(shopId, period.from, period.to), [shopId, period.from, period.to])
  const days = (data?.days ?? []).filter((d) => d.slips > 0).reverse()

  useExport(data ? () => ({
    style: 'book' as const, title: t('APMC'), dateLine: dayRange(period.from, period.to), file: fileName('APMC', period.from, period.to),
    columns: [{ label: t('Din'), wide: true }, { label: t('Parchi'), num: true }, { label: t('Bikri'), num: true }, { label: t('APMC'), num: true }],
    rows: days.map((d) => ({ cells: [shortDate(d.date), count(d.slips), rs(d.goodsPaise), rs(d.apmcPaise)] })),
    foot: [t('Kul'), count(data.totals.slips), rs(data.totals.goodsPaise), rs(data.totals.apmcPaise)],
  }) : null, [data])

  return (
    <>
      <div className="toolbar"><PeriodBar value={period} onChange={setPeriod} /></div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`stack${loading ? ' dim' : ''}`}>
          <div className="card sum">
            <div><span className="lb">{t('Bikri')}</span><span className="v">{rupees(data.totals.goodsPaise)}</span></div>
            <div><span className="lb">{t('APMC')}</span><span className="v">{rupees(data.totals.apmcPaise)}</span></div>
            <div><span className="lb">{t('Parchi')}</span><span className="v">{count(data.days.reduce((s, d) => s + d.slips, 0))}</span></div>
          </div>
          {data.days.length > 1 && (
            <div className="card"><div className="bd"><DayBars data={data.days} series={[{ key: 'apmcPaise', label: t('APMC'), color: APMC }]} /></div></div>
          )}
          <div className="card wrap-x">
            <table className="tbl">
              <thead><tr><th>{t('Din')}</th><th className="num">{t('Parchi')}</th><th className="num">{t('Bikri')}</th><th className="num">{t('APMC')}</th></tr></thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.date}><td>{shortDate(d.date)}</td><td className="num money">{count(d.slips)}</td><td className="num money">{rupees(d.goodsPaise)}</td><td className="num money b">{rupees(d.apmcPaise)}</td></tr>
                ))}
              </tbody>
            </table>
            {days.length === 0 && <p className="empty">{t('Is period mein bikri nahi')}</p>}
          </div>
        </div>
      )}
    </>
  )
}

// ================================================================ Mazdoori

const CHARGED = '#2a6b73'
const PAID = '#c9a227'

/** Mazdoori taken on udhaar slips against mazdoori paid to the labour from the day book. */
export function Mazdoori({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('aaj')
  const { data, error, loading } = useLoad(() => loadDesk(shopId, period.from, period.to), [shopId, period.from, period.to])
  const days = (data?.days ?? []).filter((d) => d.labourPaise || d.labourPaidPaise).reverse()
  const diff = data ? data.totals.labourPaise - data.totals.labourPaidPaise : 0

  useExport(data ? () => ({
    style: 'book' as const, title: t('Mazdoori'), dateLine: dayRange(period.from, period.to), file: fileName('Mazdoori', period.from, period.to),
    columns: [{ label: t('Din'), wide: true }, { label: t('Parchi par li'), num: true }, { label: t('Di gayi'), num: true }],
    rows: days.map((d) => ({ cells: [shortDate(d.date), rs(d.labourPaise), rs(d.labourPaidPaise)] })),
    foot: [t('Kul'), rs(data.totals.labourPaise), rs(data.totals.labourPaidPaise)],
  }) : null, [data])

  return (
    <>
      <div className="toolbar"><PeriodBar value={period} onChange={setPeriod} /></div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`stack${loading ? ' dim' : ''}`}>
          <div className="card sum">
            <div><span className="lb">{t('Di gayi')}</span><span className="v">{rupees(data.totals.labourPaidPaise)}</span></div>
            <div><span className="lb">{t('Parchi par li')}</span><span className="v">{rupees(data.totals.labourPaise)}</span></div>
            <div><span className="lb">{t('Farak')}</span><span className={`v ${diff < 0 ? 'due' : 'jama'}`}>{diff < 0 ? '−' : ''}{rupees(Math.abs(diff))}</span></div>
          </div>
          {data.days.length > 1 && (
            <div className="card"><div className="bd"><DayBars data={data.days} series={[{ key: 'labourPaidPaise', label: t('Di gayi'), color: PAID }, { key: 'labourPaise', label: t('Parchi par li'), color: CHARGED }]} /></div></div>
          )}
          <div className="card wrap-x">
            <table className="tbl">
              <thead><tr><th>{t('Din')}</th><th className="num">{t('Di gayi')}</th><th className="num">{t('Parchi par li')}</th></tr></thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.date}><td>{shortDate(d.date)}</td><td className="num money b">{rupees(d.labourPaidPaise)}</td><td className="num money">{rupees(d.labourPaise)}</td></tr>
                ))}
              </tbody>
            </table>
            {days.length === 0 && <p className="empty">{t('Koi mazdoori nahi')}</p>}
          </div>
        </div>
      )}
    </>
  )
}

/** The grapes strip on the dashboard: today's dispatch, gaadis, APMC and mazdoori, each a link to its page. */
export function AngoorStrip({ shopId, from, to }: { shopId: string; from: string; to: string }) {
  const { data } = useLoad(() => loadDesk(shopId, from, to), [shopId, from, to])
  const go = (report: 'dispatch' | 'pata' | 'apmc' | 'mazdoori') => href({ page: 'report', shopId, report }) + `?p=custom&from=${from}&to=${to}`
  const left = data ? data.totals.boxes - data.totals.picked : 0
  return (
    <div className="grid g4">
      <Kpi icon={<I.IScan />} tone="green" label={t('Dispatch')} to={go('dispatch')}
        value={data ? `${count(data.totals.picked)} / ${count(data.totals.boxes)}` : '…'}
        sub={data && (left ? <span className="due">{t('{n} box dena baaki', { n: count(left) })}</span> : t('Sab maal de diya'))} />
      <Kpi icon={<I.IPin />} tone="blue" label={t('Khuli gaadi')} to={go('pata')}
        value={data ? count(data.totals.openGaadis) : '…'} sub={data && `${box(data.totals.boxesLeft)} ${t('baaki')}`} />
      <Kpi icon={<I.IChart />} tone="amber" label={t('APMC')} to={go('apmc')}
        value={data ? rupees(data.totals.apmcPaise) : '…'} sub={data && t('{n} parchi', { n: count(data.totals.slips) })} />
      <Kpi icon={<I.IWallet />} tone="red" label={t('Mazdoori di')} to={go('mazdoori')}
        value={data ? rupees(data.totals.labourPaidPaise) : '…'} sub={data && `${t('Parchi par li')} ${rupees(data.totals.labourPaise)}`} />
    </div>
  )
}
