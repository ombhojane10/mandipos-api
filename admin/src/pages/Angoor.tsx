import { useState } from 'react'
import { api } from '../api'
import { DayBars } from '../Chart'
import { count, rate, rupees, shortDate, time, todayIst } from '../format'
import { usePeriod } from '../hooks'
import { t } from '../i18n'
import { openVoucher } from '../keys'
import { openScan } from '../Scan'
import { hashQuery, href, setHashQuery } from '../routes'
import { useLoad } from '../useLoad'
import { Kpi, PeriodBar, Skeleton } from '../ui'
import * as I from '../icons'
import { dayRange, fileName, openExport, rs, useExport } from '../export/doc'
import { editEntry, openBolo, openDraft, openEntry } from '../entries/kinds'
import { MicIcon } from '../voice/MicIcon'

// ================================================================ the grapes desk

/**
 * One read of the grapes books (GET /angoor) feeds five pages: dispatch at the gaadi, where each
 * gaadi stands, the party's commission and beejak, APMC by day, and mazdoori charged against
 * paid. Every page also makes things, not only shows them: scan, slips, gaadis, labour paid.
 */
export type Desk = {
  from: string; to: string; commissionBps: number
  slips: { billId: string; slipNo: number | null; buyer: string; date: string; at: string; payMode: string; totalPaise: number
    boxes: number; picked: number; left: number; lastPickAt: string | null; gaadis: { truckId: string; number: string; location: string; qty: number }[] }[]
  gaadis: Gaadi[]
  suppliers: { key: string; name: string; gaadis: { truckId: string; number: string }[]; boxes: number; salesPaise: number; commissionPaise: number; netPaise: number }[]
  days: { date: string; slips: number; goodsPaise: number; apmcPaise: number; labourPaise: number; labourPaidPaise: number }[]
  labourSlips: { billId: string; slipNo: number | null; buyer: string; date: string; boxes: number; labourPaise: number }[]
  labourPaid: { id: string; date: string; party: string; note: string; mode: string; amountPaise: number }[]
  totals: { slips: number; boxes: number; picked: number; pendingSlips: number; doneSlips: number; openGaadis: number; boxesLeft: number
    salesPaise: number; commissionPaise: number; goodsPaise: number; apmcPaise: number; labourPaise: number; labourPaidPaise: number }
}
type Gaadi = { truckId: string; number: string; supplier: string; supplierKey: string; location: string; arrivedOn: string; freightPaise: number
  received: number; sold: number; soldNow: number; left: number; over: number; waiting: number
  qualities: { brandId: string | null; name: string; kg: number; ratePaise: number; received: number; sold: number; off: number; left: number; over: number }[] }

export const loadDesk = (shopId: string, from: string, to: string, bps = 600) =>
  api<Desk>(`/v1/admin/shops/${shopId}/angoor?from=${from}&to=${to}&commissionBps=${bps}`)

const slipName = (s: { slipNo: number | null }) => (s.slipNo ? `#${s.slipNo}` : t('Parchi'))
const box = (n: number) => t('{n} box', { n: count(n) })

/** The make-things row every grapes page opens with. */
function Actions({ shopId, children }: { shopId: string; children?: React.ReactNode }) {
  return (
    <div className="desk-actions">
      <button type="button" className="btn primary" onClick={() => openScan(shopId)}><I.IScan /> {t('Scan')}</button>
      <button type="button" className="btn line" onClick={() => openEntry('parchi')}>+ {t('Nayi Parchi')}</button>
      <button type="button" className="btn line" onClick={openBolo} aria-label={t('Bolo')}><MicIcon /> {t('Bolo')}</button>
      {children}
    </div>
  )
}

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
      <Actions shopId={shopId} />
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

/** Every open gaadi now: where it stands, whose it is, what each quality has left and what waits to be handed over. */
export function GaadiPata({ shopId }: { shopId: string }) {
  const today = todayIst()
  const { data, error, loading } = useLoad(() => loadDesk(shopId, today, today), [shopId, today])
  const [beejak, setBeejak] = useState<string | null>(null)
  const edit = (g: Gaadi) => editEntry({ kind: 'gaadi', gaadi: { truckId: g.truckId, number: g.number, supplier: g.supplier, location: g.location, freightPaise: g.freightPaise,
    qualities: g.qualities.map((q) => ({ brandId: q.brandId, name: q.name, kg: q.kg, ratePaise: q.ratePaise, received: q.received })) } })

  useExport(data ? () => ({
    style: 'book' as const, title: t('Gaadi kahan'), file: fileName('Gaadi-kahan', today),
    columns: [{ label: t('Gaadi'), wide: true }, { label: t('Jagah'), wide: true }, { label: t('Quality'), wide: true }, { label: t('Aaya'), num: true }, { label: t('Bika'), num: true }, { label: t('Baaki'), num: true }],
    rows: data.gaadis.flatMap((g) => g.qualities.map((q, i) => ({ cells: [i ? '' : [g.number, g.supplier].filter(Boolean).join(' · '), i ? '' : g.location, q.name, count(q.received), count(q.sold), q.over ? `-${count(q.over)}` : count(q.left)] }))),
  }) : null, [data])

  return (
    <>
      <Actions shopId={shopId}><button type="button" className="btn line" onClick={() => openEntry('gaadi')}>+ {t('Nayi Gaadi')}</button></Actions>
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
                          <td className="num money b">{count(q.left)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="gaadi-ft">
                    {g.over > 0 && <button type="button" className="chip red" onClick={() => edit(g)}>{t('{n} zyada bika — box jodein', { n: count(g.over) })}</button>}
                    {g.soldNow > 0 && <span className="chip blue">{t('Aaj {n} bika', { n: count(g.soldNow) })}</span>}
                    {g.waiting > 0 ? <span className="chip amber">{t('{n} box dena baaki', { n: count(g.waiting) })}</span> : <span className="chip grey">{t('Kuch dena nahi')}</span>}
                  </div>
                  <div className="gaadi-acts">
                    <button type="button" className="btn line sm" onClick={() => edit(g)}>{t('Badlein')}</button>
                    <button type="button" className="btn line sm" onClick={() => setBeejak(g.truckId)}>{t('Beejak')}</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {beejak && <BeejakSheet shopId={shopId} truckId={beejak} onClose={() => setBeejak(null)} />}
    </>
  )
}

// ================================================================ Supplier commission + beejak

const store = {
  get: (k: string, fallback: number) => { try { const raw = localStorage.getItem(k); const v = Number(raw); return raw !== null && Number.isFinite(v) ? v : fallback } catch { return fallback } },
  set: (k: string, v: number) => { try { localStorage.setItem(k, String(v)) } catch { /* stays for this visit */ } },
}
const BPS_KEY = (shopId: string) => `mp.angoor.bps.${shopId}`
const LABOUR_KEY = (shopId: string) => `mp.angoor.beejakLabour.${shopId}`
const DAK_KEY = (shopId: string) => `mp.angoor.beejakDak.${shopId}`

/** Each party's boxes and bikri over the period, and the shop's commission on it; each gaadi opens its beejak. */
export function Commission({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('7')
  const [bps, setBps] = useState(() => store.get(BPS_KEY(shopId), 600))
  const [pct, setPct] = useState(() => String(bps / 100))
  const [beejak, setBeejak] = useState<string | null>(null)
  const { data, error, loading } = useLoad(() => loadDesk(shopId, period.from, period.to, bps), [shopId, period.from, period.to, bps])
  const apply = (v: string) => {
    setPct(v)
    const n = Math.round(Number(v) * 100)
    if (!Number.isFinite(n) || n < 0 || n > 5000) return
    setBps(n); store.set(BPS_KEY(shopId), n)
  }

  useExport(data ? () => ({
    style: 'book' as const, title: `${t('Supplier commission')} · ${bps / 100}%`, dateLine: dayRange(period.from, period.to), file: fileName('Commission', period.from, period.to),
    columns: [{ label: t('Supplier'), wide: true }, { label: t('Gaadi'), wide: true }, { label: t('Box'), num: true }, { label: t('Bikri'), num: true }, { label: t('Commission'), num: true }, { label: t('Party ko'), num: true }],
    rows: data.suppliers.map((s) => ({ cells: [s.name, s.gaadis.map((g) => g.number).join(', '), count(s.boxes), rs(s.salesPaise), rs(s.commissionPaise), rs(s.netPaise)] })),
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
                  <tr key={s.key || s.name}>
                    <td className="main-col"><b>{s.key ? <a href={href({ page: 'supplier', shopId, key: s.key })}>{s.name}</a> : s.name}</b>
                      <small className="beejak-links">{s.gaadis.map((g) => <button key={g.truckId} type="button" className="chip blue" onClick={() => setBeejak(g.truckId)}>{g.number} · {t('Beejak')}</button>)}
                        <span className="show-sm"> {box(s.boxes)} · {rupees(s.salesPaise)}</span></small></td>
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
      {beejak && <BeejakSheet shopId={shopId} truckId={beejak} onClose={() => setBeejak(null)} />}
    </>
  )
}

type Beejak = { truckId: string; number: string; party: string; supplierKey: string; location: string; arrivedOn: string; closed: boolean
  received: number; sold: number; off: number; left: number; freightPaise: number; grossPaise: number; from: string | null; to: string | null
  groups: { quality: string; qty: number; avgRatePaise: number; amountPaise: number }[] }

/**
 * The party's beejak (sale proceed) for one gaadi, as the shop's old books print it: each quality,
 * boxes, average bhav and amount; the gross; commission, bhada, mazdoori and dak off it; nett sale.
 * The deductions are the counter's to set here and are remembered on this computer.
 */
function BeejakSheet({ shopId, truckId, onClose }: { shopId: string; truckId: string; onClose: () => void }) {
  const { data: b, error } = useLoad(() => api<Beejak>(`/v1/admin/shops/${shopId}/beejak/${truckId}`), [shopId, truckId])
  const [pct, setPct] = useState(() => String(store.get(BPS_KEY(shopId), 600) / 100))
  const [labour, setLabour] = useState(() => String(store.get(LABOUR_KEY(shopId), 600) / 100))
  const [dak, setDak] = useState(() => String(store.get(DAK_KEY(shopId), 2000) / 100))
  const [freight, setFreight] = useState<string | null>(null)
  const num = (v: string) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0)
  const bps = Math.round(num(pct) * 100)
  const gross = b?.grossPaise ?? 0
  const commission = Math.round((gross * bps) / 10_000)
  const freightPaise = freight === null ? b?.freightPaise ?? 0 : Math.round(num(freight) * 100)
  const labourPaise = Math.round(num(labour) * 100) * (b?.sold ?? 0)
  const dakPaise = Math.round(num(dak) * 100)
  const expenses = commission + freightPaise + labourPaise + dakPaise
  const nett = gross - expenses
  const keep = () => { store.set(BPS_KEY(shopId), bps); store.set(LABOUR_KEY(shopId), Math.round(num(labour) * 100)); store.set(DAK_KEY(shopId), dakPaise) }
  const exp: [string, number][] = [[`${t('Commission')} ${num(pct)}%`, commission], [t('Bhada (R/F)'), freightPaise], [`${t('Mazdoori (R/L)')} ${count(b?.sold ?? 0)} × ${rate(Math.round(num(labour) * 100))}`, labourPaise], [t('Dak (Tele & Post)'), dakPaise]]

  useExport(b ? () => ({
    style: 'book' as const, title: t('BEEJAK · SALE PROCEED'), dateLine: b.from && b.to ? dayRange(b.from, b.to) : undefined, file: fileName('Beejak', b.number),
    summary: [[t('Party'), b.party || '—'], [t('Gaadi'), b.number], [t('Box'), count(b.received)]],
    columns: [{ label: t('Quality'), wide: true }, { label: t('Box'), num: true }, { label: t('Avg bhav'), num: true }, { label: t('Rakam'), num: true }],
    rows: [
      ...b.groups.map((g) => ({ cells: [g.quality, count(g.qty), (g.avgRatePaise / 100).toFixed(2), rs(g.amountPaise)] })),
      { kind: 'total' as const, bold: true, cells: [t('Gross amount'), count(b.sold), '', rs(gross)] },
      { kind: 'heading' as const, bold: true, cells: [t('KHARCHA')] },
      ...exp.map(([l, v]) => ({ cells: [l, '', '', rs(v)] })),
      { kind: 'total' as const, bold: true, cells: [t('Kul kharcha'), '', '', rs(expenses)] },
      { kind: 'final' as const, bold: true, cells: [t('Nett sale'), '', '', rs(nett)] },
    ],
    sign: true,
  }) : null, [b, pct, labour, dak, freight])

  return (
    <div className="scrim sheet-scrim" onClick={onClose}>
      <div className="sheet beejak" role="dialog" aria-label={t('Beejak')} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <div className="sheet-hd"><h3>{t('Beejak')}{b ? ` · ${b.number}` : ''}</h3><button type="button" className="icon-btn" aria-label={t('Band karein')} onClick={onClose}>✕</button></div>
        <div className="sheet-bd">
          {error && <p className="error">{error}</p>}
          {!b ? <Skeleton rows={4} /> : (
            <>
              <div className="beejak-hd">
                <div><span className="muted">{t('Party')}</span><b>{b.party || '—'}</b></div>
                <div><span className="muted">{t('Gaadi')}</span><b>{b.number}</b></div>
                <div><span className="muted">{t('Box aaye · bike · baaki')}</span><b>{count(b.received)} · {count(b.sold)} · {count(b.left)}</b></div>
              </div>
              <table className="tbl">
                <thead><tr><th>{t('Quality')}</th><th className="num">{t('Box')}</th><th className="num">{t('Avg bhav')}</th><th className="num">{t('Rakam')}</th></tr></thead>
                <tbody>{b.groups.map((g) => <tr key={g.quality}><td>{g.quality}</td><td className="num money">{count(g.qty)}</td><td className="num money">{rate(g.avgRatePaise)}</td><td className="num money">{rupees(g.amountPaise)}</td></tr>)}</tbody>
                <tfoot><tr><td>{t('Gross amount')}</td><td className="num money">{count(b.sold)}</td><td /><td className="num money b">{rupees(gross)}</td></tr></tfoot>
              </table>
              {b.groups.length === 0 && <p className="empty">{t('Is gaadi se abhi kuch nahi bika')}</p>}
              <div className="beejak-exp">
                <label><span>{t('Commission')}</span><input className="field" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} /><span>%</span><b className="money">{rupees(commission)}</b></label>
                <label><span>{t('Bhada (R/F)')}</span><span>₹</span><input className="field" inputMode="decimal" value={freight ?? String(b.freightPaise / 100)} onChange={(e) => setFreight(e.target.value)} /><b className="money">{rupees(freightPaise)}</b></label>
                <label><span>{t('Mazdoori (R/L)')}</span><span>₹</span><input className="field" inputMode="decimal" value={labour} onChange={(e) => setLabour(e.target.value)} /><span className="muted">× {count(b.sold)}</span><b className="money">{rupees(labourPaise)}</b></label>
                <label><span>{t('Dak (Tele & Post)')}</span><span>₹</span><input className="field" inputMode="decimal" value={dak} onChange={(e) => setDak(e.target.value)} /><b className="money">{rupees(dakPaise)}</b></label>
              </div>
              <div className="total-line"><span>{t('Kul kharcha')}</span><b className="money">{rupees(expenses)}</b></div>
              <div className="total-line big"><span>{t('Nett sale')}</span><b className={`money ${nett < 0 ? 'due' : 'jama'}`}>{nett < 0 ? '−' : ''}{rupees(Math.abs(nett))}</b></div>
            </>
          )}
        </div>
        <div className="sheet-ft">
          <button type="button" className="btn ghost" onClick={onClose}>{t('Band karein')}</button>
          <button type="button" className="btn primary" disabled={!b} onClick={() => { keep(); openExport() }}><I.IExport /> {t('PDF / Print')}</button>
        </div>
      </div>
    </div>
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
          {data.days.length > 1 && data.totals.apmcPaise > 0 && (
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

/**
 * Mazdoori paid to the labour (the day book's mazdoori, paid right here) against mazdoori taken
 * on udhaar slips — every one of those slips listed, each one open to change.
 */
export function Mazdoori({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('aaj')
  const { data, error, loading } = useLoad(() => loadDesk(shopId, period.from, period.to), [shopId, period.from, period.to])
  const diff = data ? data.totals.labourPaise - data.totals.labourPaidPaise : 0
  const pay = () => openDraft({ kind: 'kharcha', dir: 'out', category: 'mazdoori', amountPaise: 0, note: '', notes: [] })
  const multi = period.from !== period.to

  useExport(data ? () => ({
    style: 'book' as const, title: t('Mazdoori'), dateLine: dayRange(period.from, period.to), file: fileName('Mazdoori', period.from, period.to),
    columns: [{ label: t('Din'), wide: true }, { label: t('Kya'), wide: true }, { label: t('Di gayi'), num: true }, { label: t('Parchi par li'), num: true }],
    rows: [
      ...data.labourPaid.map((p) => ({ cells: [shortDate(p.date), [p.party, p.note].filter(Boolean).join(' · ') || t('Mazdoori'), rs(p.amountPaise), ''] })),
      ...data.labourSlips.map((s) => ({ cells: [shortDate(s.date), `${slipName(s)} · ${s.buyer} · ${box(s.boxes)}`, '', rs(s.labourPaise)] })),
    ],
    foot: [t('Kul'), '', rs(data.totals.labourPaidPaise), rs(data.totals.labourPaise)],
  }) : null, [data])

  return (
    <>
      <div className="desk-actions">
        <button type="button" className="btn primary" onClick={pay}>+ {t('Mazdoori di')}</button>
        <button type="button" className="btn line" onClick={() => openEntry('parchi')}>+ {t('Nayi Parchi')}</button>
      </div>
      <div className="toolbar"><PeriodBar value={period} onChange={setPeriod} /></div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`stack${loading ? ' dim' : ''}`}>
          <div className="card sum">
            <div><span className="lb">{t('Di gayi')}</span><span className="v">{rupees(data.totals.labourPaidPaise)}</span></div>
            <div><span className="lb">{t('Parchi par li')}</span><span className="v">{rupees(data.totals.labourPaise)}</span></div>
            <div><span className="lb">{t('Farak')}</span><span className={`v ${diff < 0 ? 'due' : 'jama'}`}>{diff < 0 ? '−' : ''}{rupees(Math.abs(diff))}</span></div>
          </div>
          {data.days.length > 1 && (data.totals.labourPaise > 0 || data.totals.labourPaidPaise > 0) && (
            <div className="card"><div className="bd"><DayBars data={data.days} series={[{ key: 'labourPaidPaise', label: t('Di gayi'), color: PAID }, { key: 'labourPaise', label: t('Parchi par li'), color: CHARGED }]} /></div></div>
          )}
          <div className="grid g2">
            <div className="card wrap-x">
              <div className="hd"><h3>{t('Di gayi')}</h3><button type="button" className="btn line sm" onClick={pay}>+ {t('Mazdoori di')}</button></div>
              <table className="tbl">
                <tbody>
                  {data.labourPaid.map((p) => (
                    <tr key={p.id}><td className="main-col"><b>{[p.party, p.note].filter(Boolean).join(' · ') || t('Mazdoori')}</b><small>{[multi ? shortDate(p.date) : '', p.mode].filter(Boolean).join(' · ')}</small></td>
                      <td className="num money b">{rupees(p.amountPaise)}</td></tr>
                  ))}
                </tbody>
              </table>
              {data.labourPaid.length === 0 && <p className="empty">{t('Abhi koi mazdoori nahi di')}</p>}
            </div>
            <div className="card wrap-x">
              <div className="hd"><h3>{t('Parchi par li')}</h3></div>
              <table className="tbl">
                <tbody>
                  {data.labourSlips.map((s) => (
                    <tr key={s.billId} data-row tabIndex={0} onClick={() => openVoucher(shopId, s.billId)} onKeyDown={(e) => { if (e.key === 'Enter') openVoucher(shopId, s.billId) }}>
                      <td className="main-col"><b>{slipName(s)} · {s.buyer}</b><small>{[multi ? shortDate(s.date) : '', box(s.boxes)].filter(Boolean).join(' · ')}</small></td>
                      <td className="num money">{rupees(s.labourPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.labourSlips.length === 0 && <p className="empty">{t('Kisi parchi par mazdoori nahi')}</p>}
            </div>
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
