import { useState } from 'react'
import { api } from '../api'
import { DayBars } from '../Chart'
import { count, rate, rupees, shortDate, time, todayIst } from '../format'
import { usePeriod } from '../hooks'
import { t } from '../i18n'
import { openVoucher } from '../keys'
import { openScan } from '../Scan'
import { hashQuery, href, setHashQuery } from '../routes'
import { booksChanged, useLoad } from '../useLoad'
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
    boxes: number; picked: number; left: number; lastPickAt: string | null; firstPickAt: string | null; gaadis: { truckId: string; number: string; location: string; qty: number }[] }[]
  gaadis: Gaadi[]
  suppliers: { key: string; name: string; gaadis: Consignment[]; boxes: number; salesPaise: number; commissionPaise: number; netPaise: number }[]
  days: { date: string; slips: number; goodsPaise: number; apmcPaise: number; labourPaise: number; labourPaidPaise: number }[]
  labourSlips: { billId: string; slipNo: number | null; buyer: string; date: string; boxes: number; labourPaise: number }[]
  labourPaid: { id: string; date: string; party: string; note: string; mode: string; amountPaise: number }[]
  totals: { slips: number; boxes: number; picked: number; pendingSlips: number; doneSlips: number; openGaadis: number; boxesLeft: number
    salesPaise: number; commissionPaise: number; goodsPaise: number; apmcPaise: number; labourPaise: number; labourPaidPaise: number }
}
type Consignment = { truckId: string; number: string; location: string; arrivedOn: string; closed: boolean; boxes: number; salesPaise: number; commissionPaise: number; netPaise: number }
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
      <BrokenRequests shopId={shopId} />
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
                      <small>{[period.from !== period.to ? shortDate(s.date) : '', t('Bill {at}', { at: time(s.at) }),
                        s.firstPickAt ? t('Dispatch {at}', { at: s.lastPickAt && s.lastPickAt !== s.firstPickAt ? `${time(s.firstPickAt)}–${time(s.lastPickAt)}` : time(s.firstPickAt) }) : ''].filter(Boolean).join(' · ')}
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

// ================================================================ Toote box (broken after dispatch)

type Broken = { id: string; status: string; qty: number; note: string; reportedBy: string; at: string; quality: string; gaadi: string
  bill: { id: string; slipNo: number | null; buyer: string; buyerId: string | null; payMode: string; totalPaise: number; paidPaise: number; apmcPaise: number; lineQty: number; lineRatePaise: number } | null }

/** Boxes the labour reported broken after they left: each settled here (re-priced) or turned down. */
function BrokenRequests({ shopId }: { shopId: string }) {
  const { data, reload } = useLoad(() => api<{ breakages: Broken[] }>(`/v1/admin/shops/${shopId}/breakages`), [shopId])
  const [open, setOpen] = useState<Broken | null>(null)
  if (!data?.breakages.length) return null
  return (
    <>
      <div className="card broken-card">
        <div className="hd"><h3>{t('Toote box · {n} request', { n: String(data.breakages.length) })}</h3></div>
        <table className="tbl">
          <tbody>
            {data.breakages.map((b) => (
              <tr key={b.id} data-row tabIndex={0} onClick={() => setOpen(b)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(b) }}>
                <td className="main-col"><b>{b.bill ? `#${b.bill.slipNo} · ${b.bill.buyer}` : t('Parchi nahi mili')}</b>
                  <small>{[b.quality, b.gaadi, b.reportedBy, time(b.at), b.note].filter(Boolean).join(' · ')}</small></td>
                <td className="num amt-col"><span className="chip red">{t('{n} box toote', { n: count(b.qty) })}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <SettleBroken shopId={shopId} b={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); reload(); booksChanged() }} />}
    </>
  )
}

/**
 * The accountant writes the broken boxes at a new bhav: the slip is rewritten under its own number
 * and printed again; money paid beyond the new total goes back in cash or stays as jama.
 */
function SettleBroken({ shopId, b, onClose, onDone }: { shopId: string; b: Broken; onClose: () => void; onDone: () => void }) {
  const [bhav, setBhav] = useState('')
  const [back, setBack] = useState<'cash' | 'advance'>('cash')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const bill = b.bill
  const r = Math.round(Number(bhav) * 100)
  const typed = bhav.trim() !== '' && Number.isFinite(r) && r >= 0
  // The new total, as the server will work it: the broken boxes off their line at the new bhav (APMC with it).
  const diff = typed && bill ? b.qty * (bill.lineRatePaise - r) : 0
  const apmcOn = !!bill && bill.apmcPaise > 0
  const newTotal = bill ? Math.max(0, bill.totalPaise - diff - (apmcOn ? Math.round(diff * 0.01) : 0)) : 0
  const over = bill ? Math.max(0, bill.paidPaise - newTotal) : 0
  const go = async (path: 'resolve' | 'reject') => {
    if (path === 'resolve' && !typed) return setError(t('Toote box ka bhav likhein'))
    setBusy(true); setError('')
    try {
      await api(`/v1/admin/shops/${shopId}/breakages/${b.id}/${path}`, { method: 'POST', body: path === 'resolve' ? { ratePaise: r, giveBack: over > 0 ? back : undefined } : {} })
      onDone()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="scrim sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={t('Toote box')} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-hd"><h3>{bill ? `#${bill.slipNo} · ${bill.buyer}` : t('Toote box')}</h3><button type="button" className="icon-btn" aria-label={t('Band karein')} onClick={onClose}>✕</button></div>
        <div className="sheet-bd">
          <div className="broken-what"><b>{t('{what}: {n} box toote', { what: [b.quality, b.gaadi].filter(Boolean).join(' · '), n: count(b.qty) })}</b>
            <small>{[b.reportedBy, time(b.at), b.note].filter(Boolean).join(' · ')}</small></div>
          {bill && <div className="total-line"><span>{t('Abhi ka bhav')}</span><b className="money">{rate(bill.lineRatePaise)}</b></div>}
          <label className="fld"><span className="fld-lb">{t('Toote box ka bhav ₹')}</span>
            <input className="field" inputMode="decimal" autoFocus value={bhav} onChange={(e) => setBhav(e.target.value.replace(/[^\d.]/g, ''))} /></label>
          {typed && bill && <div className="total-line"><span>{t('Nayi parchi')}</span><b className="money">{rupees(newTotal)}</b><span className="muted">{t('pehle {x}', { x: rupees(bill.totalPaise) })}</span></div>}
          {over > 0 && (
            <div className="fld"><span className="fld-lb">{t('{x} bache — kya karein?', { x: rupees(over) })}</span>
              <div className="seg" role="group">
                <button type="button" aria-pressed={back === 'cash'} onClick={() => setBack('cash')}>{t('Cash wapas')}</button>
                {bill?.buyerId && <button type="button" aria-pressed={back === 'advance'} onClick={() => setBack('advance')}>{t('Khate mein jama')}</button>}
              </div>
            </div>
          )}
        </div>
        {error && <p className="error" role="alert" style={{ padding: '0 20px' }}>{error}</p>}
        <div className="sheet-ft">
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void go('reject')} style={{ marginRight: 'auto', color: 'var(--due)' }}>{t('Mana karein')}</button>
          <button type="button" className="btn primary" disabled={busy || !bill} onClick={() => void go('resolve')}>{busy ? '…' : t('Nayi parchi banayein')}</button>
        </div>
      </div>
    </div>
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
// The beejak's deductions start where the app's do (Prefs: 6%, ₹7 a box, ₹10 dak) and are then
// remembered on this computer, as the app remembers them on the machine.
const BPS_KEY = (shopId: string) => `mp.angoor.bps.${shopId}`
const LABOUR_KEY = (shopId: string) => `mp.angoor.beejak.labour.${shopId}`
const DAK_KEY = (shopId: string) => `mp.angoor.beejak.dak.${shopId}`

/**
 * Each party's consignments — every open gaadi, and the ones that came or sold in the period —
 * with all each has sold, the shop's commission on it and what goes to the party. Each gaadi
 * opens its beejak.
 */
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
  const rows = (data?.suppliers ?? []).flatMap((s) => s.gaadis.map((g, i) => ({ s, g, first: i === 0 })))

  useExport(data ? () => ({
    style: 'book' as const, title: `${t('Supplier commission')} · ${bps / 100}%`, dateLine: dayRange(period.from, period.to), file: fileName('Commission', period.from, period.to),
    columns: [{ label: t('Supplier'), wide: true }, { label: t('Gaadi'), wide: true }, { label: t('Box'), num: true }, { label: t('Bikri'), num: true }, { label: t('Commission'), num: true }, { label: t('Party ko'), num: true }],
    rows: rows.map(({ s, g, first }) => ({ cells: [first ? s.name : '', g.number, count(g.boxes), rs(g.salesPaise), rs(g.commissionPaise), rs(g.netPaise)] })),
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
              <thead><tr><th>{t('Supplier · Gaadi')}</th><th className="num">{t('Box')}</th><th className="num">{t('Bikri')}</th><th className="num">{t('Party ko')}</th><th className="num">{t('Commission')}</th><th /></tr></thead>
              <tbody>
                {rows.map(({ s, g }) => (
                  <tr key={g.truckId} data-row tabIndex={0} onClick={() => setBeejak(g.truckId)} onKeyDown={(e) => { if (e.key === 'Enter') setBeejak(g.truckId) }}>
                    <td className="main-col"><b>{s.name}</b>
                      <small>{[g.number, g.location, shortDate(g.arrivedOn), g.closed ? t('Band') : ''].filter(Boolean).join(' · ')}
                        <span className="show-sm"> · {box(g.boxes)} · {rupees(g.salesPaise)}</span></small></td>
                    <td className="num opt-col money">{count(g.boxes)}</td>
                    <td className="num opt-col money">{rupees(g.salesPaise)}</td>
                    <td className="num opt-col money">{rupees(g.netPaise)}</td>
                    <td className="num amt-col"><span className="money b jama">{rupees(g.commissionPaise)}</span></td>
                    <td className="row-act"><span className="chip blue">{t('Beejak')} ›</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="empty">{t('Koi gaadi nahi')}</p>}
          </div>
        </div>
      )}
      {beejak && <BeejakSheet shopId={shopId} truckId={beejak} onClose={() => setBeejak(null)} />}
    </>
  )
}

type Saved = { id: string; truckId: string; no: number; party: string; gaadi: string; day: string; boxes: number
  grossPaise: number; expensesPaise: number; netPaise: number; madeAt: string
  lines: { quality: string; qty: number; ratePaise: number; amountPaise: number }[]
  expenses: { key: string; kind: string; rate: number | null; amountPaise: number }[] }
type Beejak = { truckId: string; number: string; party: string; supplierKey: string; location: string; arrivedOn: string; closed: boolean
  received: number; sold: number; off: number; left: number; freightPaise: number; grossPaise: number; from: string | null; to: string | null
  groups: { quality: string; qty: number }[]; saved: Saved | null }

/**
 * The kharcha heads, as on the shop's old "Sale Proceed" screen: a % of the gross, ₹ a box, or a
 * flat ₹. The server works each one out again from the same rate when the beejak is kept.
 */
const HEADS: { key: string; label: string; kind: 'pct' | 'box' | 'flat' }[] = [
  { key: 'commission', label: t('Commission'), kind: 'pct' },
  { key: 'association', label: t('Association'), kind: 'box' },
  { key: 'loading', label: t('Loading/Unloading'), kind: 'box' },
  { key: 'labour', label: t('Labour'), kind: 'box' },
  { key: 'bardana', label: t('Bardana'), kind: 'box' },
  { key: 'freight', label: t('Lorry Freight'), kind: 'flat' },
  { key: 'dak', label: t('Telephone & Postage'), kind: 'flat' },
  { key: 'bank', label: t('Bank Charges'), kind: 'pct' },
  { key: 'crate', label: t('Crate Handling'), kind: 'box' },
  { key: 'store', label: t('Store Expenses'), kind: 'flat' },
  { key: 'custom', label: t('Custom Duty'), kind: 'flat' },
  { key: 'other', label: t('Other Expenses'), kind: 'flat' },
]
const UNIT = { pct: '%', box: '₹/box', flat: '₹' }
// The heads start where the app's do (6%, ₹7 a box, ₹10 dak) and then as this computer last left them.
const HEAD_KEY = (shopId: string, key: string) => `mp.angoor.beejak.head.${key}.${shopId}`
const HEAD_START: Record<string, number> = { commission: 600, labour: 700, dak: 1000 }
const headStart = (shopId: string, key: string) => {
  // The older single settings (commission %, mazdoori, dak) carry over.
  const old = key === 'commission' ? BPS_KEY(shopId) : key === 'labour' ? LABOUR_KEY(shopId) : key === 'dak' ? DAK_KEY(shopId) : ''
  const v = store.get(HEAD_KEY(shopId, key), old ? store.get(old, HEAD_START[key] ?? 0) : HEAD_START[key] ?? 0)
  return v ? String(v / 100) : ''
}
const num = (v: string) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0)
const hundredths = (v: string) => Math.round(num(v) * 100)

/**
 * The party's beejak for one gaadi: each quality with the boxes sold (fixed) and a bhav the shop
 * types itself — never what the boxes actually went for; the gross; the kharcha heads off it; and
 * the shudh bikri the party is paid. Kept on Save (one beejak a gaadi, its number kept when made
 * again), printed or sent as PDF in the app's BEEJAK layout.
 */
export function BeejakSheet({ shopId, truckId, onClose }: { shopId: string; truckId: string; onClose: () => void }) {
  const { data: b, error } = useLoad(() => api<Beejak>(`/v1/admin/shops/${shopId}/beejak/${truckId}`), [shopId, truckId])
  const [bhav, setBhav] = useState<Record<string, string> | null>(null)
  const [heads, setHeads] = useState<Record<string, string> | null>(null)
  const [saved, setSaved] = useState<Saved | null>(null)
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState('')
  const kept = saved ?? b?.saved ?? null

  // What the sheet opens with: the kept beejak's bhav and heads, else empty bhav and this computer's rates.
  const bhavNow = bhav ?? Object.fromEntries((kept?.lines ?? []).map((l) => [l.quality, String(l.ratePaise / 100)]))
  const headsNow = heads ?? Object.fromEntries(HEADS.map((h) => {
    const k = kept?.expenses.find((e) => e.key === h.key)
    if (k) return [h.key, h.kind === 'flat' ? (k.amountPaise ? String(k.amountPaise / 100) : '') : (k.rate ? String(k.rate / 100) : '')]
    if (h.key === 'freight') return [h.key, b?.freightPaise ? String(b.freightPaise / 100) : '']
    return [h.key, headStart(shopId, h.key)]
  }))
  const lines = (b?.groups ?? []).map((g) => { const r = hundredths(bhavNow[g.quality] ?? ''); return { ...g, ratePaise: r, amountPaise: r * g.qty } })
  const boxes = lines.reduce((s, l) => s + l.qty, 0)
  const gross = lines.reduce((s, l) => s + l.amountPaise, 0)
  const amountOf = (h: (typeof HEADS)[number]) => {
    const r = hundredths(headsNow[h.key] ?? '')
    return h.kind === 'pct' ? Math.round((gross * r) / 10_000) : h.kind === 'box' ? r * boxes : r
  }
  const exp = HEADS.map((h) => ({ ...h, amountPaise: amountOf(h) }))
  const expenses = exp.reduce((s, e) => s + e.amountPaise, 0)
  const nett = gross - expenses
  const rateText = (h: (typeof HEADS)[number]) => h.kind === 'pct' ? `${num(headsNow[h.key] ?? '')}%` : h.kind === 'box' ? `${count(boxes)} × ${rate(hundredths(headsNow[h.key] ?? '')).slice(1)}` : ''

  const save = async (andPrint: boolean) => {
    if (!b) return
    if (lines.some((l) => l.ratePaise <= 0)) { setFail(t('Har quality ka bhav likhein')); return }
    setBusy(true); setFail('')
    try {
      const r = await api<Saved>(`/v1/admin/shops/${shopId}/beejak/${truckId}`, { method: 'POST', body: {
        bhav: lines.map((l) => ({ quality: l.quality, ratePaise: l.ratePaise })),
        heads: HEADS.map((h) => h.kind === 'flat' ? { key: h.key, amountPaise: hundredths(headsNow[h.key] ?? '') } : { key: h.key, rate: hundredths(headsNow[h.key] ?? '') }),
      } })
      HEADS.filter((h) => h.key !== 'freight').forEach((h) => store.set(HEAD_KEY(shopId, h.key), hundredths(headsNow[h.key] ?? '')))
      setSaved(r); booksChanged()
      if (andPrint) setTimeout(openExport, 50)
    } catch (e) { setFail(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  useExport(b ? () => ({
    style: 'book' as const, title: kept ? `BEEJAK #${kept.no}` : 'BEEJAK', dateLine: b.from && b.to ? dayRange(b.from, b.to) : undefined,
    file: fileName('Beejak', kept ? String(kept.no) : '', b.party || b.number, b.number),
    summary: [[t('Party'), b.party || '—'], [t('Gaadi'), b.number], [t('Aaya'), shortDate(b.arrivedOn)], [t('Box aaye · bike · baaki'), `${count(b.received)} · ${count(b.sold)} · ${count(b.left)}`]],
    columns: [{ label: t('Mark'), wide: true }, { label: t('Box × Bhav'), num: true }, { label: t('Rakam'), num: true }],
    rows: [
      ...lines.map((g) => ({ cells: [g.quality, `${count(g.qty)} × ${rate(g.ratePaise).slice(1)}`, rs(g.amountPaise)] })),
      { kind: 'total' as const, bold: true, cells: [t('Kul bikri'), '', rs(gross)] },
      { kind: 'heading' as const, bold: true, cells: [t('Kharcha')] },
      ...exp.filter((e) => e.amountPaise > 0).map((e) => ({ cells: [e.label, rateText(e), rs(e.amountPaise)] })),
      { kind: 'total' as const, bold: true, cells: [t('Kul kharcha'), '', rs(expenses)] },
      { kind: 'final' as const, bold: true, cells: [t('Shudh bikri'), '', rs(nett)] },
    ],
    sign: true,
  }) : null, [b, kept, bhavNow, headsNow])

  return (
    <div className="scrim sheet-scrim" onClick={onClose}>
      <div className="sheet beejak" role="dialog" aria-label={t('Beejak')} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <div className="sheet-hd"><h3>{t('Beejak')}{kept ? ` #${kept.no}` : ''}{b ? ` · ${b.party || b.number}` : ''}</h3><button type="button" className="icon-btn" aria-label={t('Band karein')} onClick={onClose}>✕</button></div>
        <div className="sheet-bd">
          {error && <p className="error">{error}</p>}
          {!b ? <Skeleton rows={4} /> : (
            <>
              <div className="beejak-top">
                <b>{b.party || '—'}</b>
                <small>{[[...new Set(b.groups.map((g) => g.quality))].join(', '), b.number, shortDate(b.arrivedOn)].filter(Boolean).join(' · ')}</small>
                <div className="beejak-stats">
                  <div><b>{count(b.received)}</b><span>{t('Box aaye')}</span></div>
                  <div><b>{count(b.sold)}</b><span>{t('Bike')}</span></div>
                  <div><b>{count(b.left)}</b><span>{t('Baaki')}</span></div>
                </div>
              </div>
              <table className="tbl">
                <thead><tr><th>{t('Mark')}</th><th className="num">{t('Box')}</th><th className="num">{t('Bhav ₹')}</th><th className="num">{t('Rakam')}</th></tr></thead>
                <tbody>{lines.map((g, i) => (
                  <tr key={g.quality}>
                    <td><b>{g.quality}</b></td>
                    <td className="num money">{count(g.qty)} ×</td>
                    <td className="num"><input className="field bhav-in" inputMode="decimal" placeholder="0" autoFocus={i === 0} aria-label={`${g.quality} ${t('Bhav')}`}
                      value={bhavNow[g.quality] ?? ''} onChange={(e) => setBhav({ ...bhavNow, [g.quality]: e.target.value.replace(/[^\d.]/g, '').slice(0, 9) })} /></td>
                    <td className="num money">{g.amountPaise ? rupees(g.amountPaise) : '—'}</td>
                  </tr>
                ))}</tbody>
                <tfoot><tr><td>{t('Kul bikri')}</td><td className="num money">{count(boxes)}</td><td /><td className="num money b">{rupees(gross)}</td></tr></tfoot>
              </table>
              {b.groups.length === 0 && <p className="empty">{t('Abhi koi box nahi bika')}</p>}
              <div className="beejak-exp">
                {exp.map((h) => (
                  <label key={h.key}><span>{h.label}</span>
                    <input className="field" inputMode="decimal" placeholder="0" value={headsNow[h.key] ?? ''}
                      onChange={(e) => setHeads({ ...headsNow, [h.key]: e.target.value.replace(/[^\d.]/g, '').slice(0, 9) })} />
                    <span className="unit">{UNIT[h.kind]}</span><b className="money">{h.amountPaise ? rupees(h.amountPaise) : '—'}</b></label>
                ))}
              </div>
              <div className="total-line"><span>{t('Kul kharcha')}</span><b className="money">{rupees(expenses)}</b></div>
              <div className="total-line big net"><span>{t('Shudh bikri')}</span><b className="money">{nett < 0 ? '−' : ''}{rupees(Math.abs(nett))}</b></div>
              {fail && <p className="error">{fail}</p>}
            </>
          )}
        </div>
        <div className="sheet-ft">
          <button type="button" className="btn ghost" disabled={!b || busy} onClick={() => void save(false)}>{t('Save karein')}</button>
          <button type="button" className="btn primary" disabled={!b || busy || !b.groups.length} onClick={() => void save(true)}><I.IExport /> {t('Save + PDF')}</button>
        </div>
      </div>
    </div>
  )
}

/**
 * Every beejak the shop has made, newest first, each opening again to print, send or change; and
 * a new one for any gaadi from Naya beejak.
 */
export function Beejaks({ shopId }: { shopId: string }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [pick, setPick] = useState(false)
  const { data, error, loading } = useLoad(() => api<{ beejaks: Saved[] }>(`/v1/admin/shops/${shopId}/beejaks?q=${encodeURIComponent(q)}`), [shopId, q])
  const list = data?.beejaks ?? []

  useExport(data ? () => ({
    style: 'book' as const, title: t('Beejak'), file: fileName('Beejak list'),
    columns: [{ label: '#' }, { label: t('Party'), wide: true }, { label: t('Gaadi') }, { label: t('Din') }, { label: t('Box'), num: true }, { label: t('Bikri'), num: true }, { label: t('Kharcha'), num: true }, { label: t('Shudh bikri'), num: true }],
    rows: list.map((x) => ({ cells: [String(x.no), x.party, x.gaadi, shortDate(x.day), count(x.boxes), rs(x.grossPaise), rs(x.expensesPaise), rs(x.netPaise)] })),
  }) : null, [data])

  return (
    <>
      <div className="toolbar">
        <input className="field search" data-search placeholder={t('Party, gaadi ya beejak no.')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn primary" onClick={() => setPick(true)}>{t('Naya beejak')}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th>{t('Beejak')}</th><th className="num">{t('Box')}</th><th className="num">{t('Bikri')}</th><th className="num">{t('Kharcha')}</th><th className="num">{t('Shudh bikri')}</th></tr></thead>
            <tbody>
              {list.map((x) => (
                <tr key={x.id} data-row tabIndex={0} onClick={() => setOpen(x.truckId)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(x.truckId) }}>
                  <td className="main-col"><b>#{x.no} · {x.party || '—'}</b><small>{[x.gaadi, shortDate(x.day)].filter(Boolean).join(' · ')}<span className="show-sm"> · {rupees(x.netPaise)}</span></small></td>
                  <td className="num opt-col money">{count(x.boxes)}</td>
                  <td className="num opt-col money">{rupees(x.grossPaise)}</td>
                  <td className="num opt-col money">{rupees(x.expensesPaise)}</td>
                  <td className="num amt-col"><span className="money b">{rupees(x.netPaise)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length === 0 && <p className="empty">{q ? t('Koi beejak nahi mila') : t('Abhi koi beejak nahi bana')}</p>}
        </div>
      )}
      {pick && <GaadiPick shopId={shopId} onPick={(id) => { setPick(false); setOpen(id) }} onClose={() => setPick(false)} />}
      {open && <BeejakSheet shopId={shopId} truckId={open} onClose={() => setOpen(null)} />}
    </>
  )
}

/** Which gaadi the new beejak is for: open ones first, then those of the last 60 days. */
function GaadiPick({ shopId, onPick, onClose }: { shopId: string; onPick: (truckId: string) => void; onClose: () => void }) {
  const today = todayIst()
  const from = new Date(Date.parse(today) - 60 * 86_400_000).toISOString().slice(0, 10)
  const { data, error } = useLoad(() => loadDesk(shopId, from, today), [shopId, from, today])
  const [q, setQ] = useState('')
  const rows = (data?.suppliers ?? []).flatMap((s) => s.gaadis.map((g) => ({ s, g })))
    .filter(({ s, g }) => !q || `${s.name} ${g.number}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(a.g.closed) - Number(b.g.closed) || b.g.arrivedOn.localeCompare(a.g.arrivedOn))
  return (
    <div className="scrim sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={t('Naya beejak')} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <div className="sheet-hd"><h3>{t('Naya beejak')}</h3><button type="button" className="icon-btn" aria-label={t('Band karein')} onClick={onClose}>✕</button></div>
        <div className="sheet-bd">
          <input className="field" autoFocus placeholder={t('Party ya gaadi')} value={q} onChange={(e) => setQ(e.target.value)} />
          {error && <p className="error">{error}</p>}
          {!data ? <Skeleton rows={3} /> : (
            <div className="lines-list pick-list">
              {rows.map(({ s, g }) => (
                <button type="button" key={g.truckId} onClick={() => onPick(g.truckId)}>
                  <span className="grow"><b>{s.name || '—'}</b><small className="muted">{[g.number, g.location, shortDate(g.arrivedOn), g.closed ? t('Band') : ''].filter(Boolean).join(' · ')}</small></span>
                  <span className="money">{box(g.boxes)}</span>
                </button>
              ))}
              {rows.length === 0 && <p className="empty">{t('Koi gaadi nahi')}</p>}
            </div>
          )}
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
