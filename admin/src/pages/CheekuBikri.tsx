// Cheeku's own copy of GFA's Bikri Entry (pages/Vouchers.tsx BikriEntry), lot-wise as the grapes one.
// Grapes and cheeku never share this code: edit one, the other stays as it is.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api, type BuyerRow } from '../api'
import { count, phone as fmtPhone, rupees } from '../format'
import { t } from '../i18n'
import { openVoucher } from '../keys'
import { booksChanged, useLoad } from '../useLoad'
import { Money, Tick } from '../entries/fields'
import { isCheeku } from '../commodity'
import { CHEEKU_CAPS_NAMES } from '../cheeku'

const caps = { textTransform: 'uppercase' as const }
/** Cheeku writes names in capitals (its own rule). */
const useCaps = () => CHEEKU_CAPS_NAMES

// ================================================================ Cheeku's Bikri Entry

type Opts = {
  commodity: string; apmcOn?: boolean
  lots?: { truckId: string; number: string; supplier: string; brandId: string; quality: string; left: number }[]
  trucks: { id: string; number: string; supplier: string; left: number; brand: string }[]
}
type Row = { key: number; buyer: { id: string | null; name: string } | null; text: string; brandId: string; grade: '1' | '2' | '3' | 'mix'; qty: number; ratePaise: number; pay: 'credit' | 'cash' | 'upi' }
type Made = { line: number; billId: string; slipNo: number; buyerName: string; totalPaise: number; qty: number }
let rowSeq = 0
const blankRow = (brandId = ''): Row => ({ key: ++rowSeq, buyer: null, text: '', brandId, grade: '1', qty: 0, ratePaise: 0, pay: 'credit' })

/**
 * GFA's Bikri Entry: one gaadi, a grid of grahak — quality (or grade), boxes, bhav, payment —
 * and one Save writes a parchi per row exactly as Nayi Parchi does. Enter moves along the row
 * and down; a new row appears as the last one is filled.
 */
export function CheekuBikriEntry({ shopId }: { shopId: string }) {
  const { data: o } = useLoad(() => api<Opts>(`/v1/admin/shops/${shopId}/entry-options`), [shopId])
  const lotWise = isCheeku(o?.commodity)
  const gaadis = lotWise
    ? [...new Map((o?.lots ?? []).map((l) => [l.truckId, { id: l.truckId, number: l.number, supplier: l.supplier }])).values()]
    : (o?.trucks ?? []).map((t) => ({ id: t.id, number: t.number, supplier: t.supplier }))
  const [truckId, setTruckId] = useState('')
  useEffect(() => { if (!truckId && gaadis[0]) setTruckId(gaadis[0].id) }, [o]) // eslint-disable-line react-hooks/exhaustive-deps
  const lots = (o?.lots ?? []).filter((l) => l.truckId === truckId)
  const truck = (o?.trucks ?? []).find((x) => x.id === truckId)
  const [rows, setRows] = useState<Row[]>(() => [blankRow(), blankRow()])
  useEffect(() => { if (lots[0]) setRows((rs) => rs.map((r) => (r.brandId && lots.some((l) => l.brandId === r.brandId) ? r : { ...r, brandId: lots[0].brandId }))) }, [truckId, o]) // eslint-disable-line react-hooks/exhaustive-deps
  const [labour, setLabour] = useState(false)
  const [labourRate, setLabourRate] = useState(1000)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ made: Made[]; failed: { line: number; error: string }[] } | null>(null)
  const grid = useRef<HTMLTableElement>(null)
  const upper = useCaps()

  const set = (key: number, patch: Partial<Row>) => setRows((rs) => {
    const next = rs.map((r) => (r.key === key ? { ...r, ...patch } : r))
    // A new row appears as soon as the last one is being filled.
    const last = next[next.length - 1]
    // It starts on the quality and grade the row above it took.
    return last && (last.qty > 0 || last.buyer || last.text.trim()) ? [...next, { ...blankRow(last.brandId || lots[0]?.brandId), grade: last.grade }] : next
  })
  const filled = rows.filter((r) => r.qty > 0)
  const apmc = (goods: number) => (lotWise && o?.apmcOn ? Math.round(goods * 0.01) : 0)
  const totalOf = (r: Row) => r.qty * r.ratePaise + apmc(r.qty * r.ratePaise) + (lotWise && labour && r.pay === 'credit' ? r.qty * labourRate : 0)
  const total = filled.reduce((s, r) => s + totalOf(r), 0)
  const boxes = filled.reduce((s, r) => s + r.qty, 0)
  const soldOf = (brandId: string) => filled.filter((r) => r.brandId === brandId).reduce((s, r) => s + r.qty, 0)

  /** Enter: the next box in the row, then the first of the next row. */
  const onEnter = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    const all = [...(grid.current?.querySelectorAll<HTMLElement>('input, select') ?? [])]
    const i = all.indexOf(e.target as HTMLElement)
    const next = all[i + 1]
    if (next) { next.focus(); if (next instanceof HTMLInputElement) next.select() }
  }

  const [badKey, setBadKey] = useState<number | null>(null)
  const save = async () => {
    setError(''); setBadKey(null)
    if (busy) return
    if (!truckId) return setError(t('Gaadi chunein'))
    if (!filled.length) return setError(t('Kam se kam ek grahak aur box daalein'))
    const bad = filled.find((r) => r.pay === 'credit' && !r.buyer?.id && !r.text.trim())
    if (bad) {
      // The row is marked and its name box takes the cursor.
      setBadKey(bad.key)
      grid.current?.querySelector<HTMLInputElement>(`tr[data-key="${bad.key}"] .grahak-cell input`)?.focus()
      return setError(t('Line {n}: udhaar ke liye grahak ka naam', { n: rows.indexOf(bad) + 1 }))
    }
    setBusy(true)
    try {
      const r = await api<{ made: Made[]; failed: { line: number; error: string }[] }>(`/v1/admin/shops/${shopId}/bikri`, { method: 'POST', body: {
        truckId, labour: lotWise ? labour : undefined, labourRatePaise: lotWise ? labourRate : undefined,
        rows: rows.map((r) => ({
          buyerId: r.buyer?.id ?? undefined, buyerName: r.buyer?.id ? undefined : (r.buyer?.name ?? r.text).trim(),
          brandId: lotWise ? r.brandId : undefined, grade: lotWise ? undefined : r.grade, qty: r.qty, ratePaise: r.ratePaise, pay: r.pay,
        })),
      } })
      setResult(r); booksChanged()
      // What saved leaves the grid; what was refused stays to be put right.
      const failed = new Set(r.failed.map((f) => f.line))
      setRows((rs) => { const keep = rs.filter((_, i) => failed.has(i + 1)); return [...keep, blankRow(lots[0]?.brandId)] })
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  // Ctrl+Enter saves the grid, as it saves every form.
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !document.querySelector('.scrim')) { e.preventDefault(); void saveRef.current() }
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [])
  return (
    <>
      <div className="toolbar">
        <select className="field" aria-label={t('Gaadi')} style={{ flex: '1 1 260px' }} value={truckId} onChange={(e) => setTruckId(e.target.value)}>
          {!gaadis.length && <option value="">{t('Koi khuli gaadi nahi')}</option>}
          {gaadis.map((g) => <option key={g.id} value={g.id}>{g.number} · {g.supplier}</option>)}
        </select>
        {lotWise && <Tick label={t('Mazdoori (udhaar)')} on={labour} onChange={setLabour}>{labour && <span style={{ width: 110 }}><Money value={labourRate} onChange={setLabourRate} /></span>}</Tick>}
      </div>
      {lotWise && lots.length > 0 && (
        <div className="chips" style={{ marginBottom: 12 }}>
          {lots.map((l) => {
            const sold = soldOf(l.brandId)
            return <span key={l.brandId} className={`chip${sold > l.left ? ' red' : sold ? ' blue' : ''}`}>{l.quality}: {count(sold)} / {count(l.left)}</span>
          })}
        </div>
      )}
      {!lotWise && truck && <div className="chips" style={{ marginBottom: 12 }}><span className={`chip${boxes > truck.left ? ' red' : boxes ? ' blue' : ''}`}>{truck.brand}: {count(boxes)} / {count(truck.left)}</span></div>}
      <div className="card wrap-x bikri-grid">
        <table className="tbl" ref={grid}>
          <thead><tr>
            <th style={{ width: 28 }}>#</th><th>{t('Grahak')}</th><th>{lotWise ? t('Quality') : t('Grade')}</th><th className="num">{lotWise ? t('Box') : t('Nag')}</th>
            <th className="num">{t('Bhav')}</th><th className="num opt-col">{t('Rakam')}</th><th>{t('Pay')}</th><th style={{ width: 28 }} />
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key} data-key={r.key}>
                <td className="muted">{i + 1}</td>
                <td><GrahakCell shopId={shopId} row={r} upper={upper} bad={badKey === r.key && !r.buyer?.id && !r.text.trim()} onPick={(b, text) => set(r.key, { buyer: b, text })} onEnter={onEnter} /></td>
                <td>{lotWise
                  ? <select className="field" value={r.brandId} onKeyDown={onEnter} onChange={(e) => set(r.key, { brandId: e.target.value })}>
                      {lots.map((l) => <option key={l.brandId} value={l.brandId}>{l.quality}</option>)}
                    </select>
                  : <select className="field" value={r.grade} onKeyDown={onEnter} onChange={(e) => set(r.key, { grade: e.target.value as Row['grade'] })}>
                      <option value="1">1st</option><option value="2">2nd</option><option value="3">3rd</option><option value="mix">{t('Mix')}</option>
                    </select>}
                </td>
                <td className="num"><input className="field num-in" inputMode="numeric" aria-label={t('Box')} value={r.qty || ''} placeholder="0" onKeyDown={onEnter}
                  onChange={(e) => set(r.key, { qty: Number(e.target.value.replace(/\D/g, '').slice(0, 7) || 0) })} /></td>
                <td className="num" onKeyDown={onEnter}><Money value={r.ratePaise} onChange={(v) => set(r.key, { ratePaise: v })} /></td>
                <td className="num opt-col money">{r.qty && r.ratePaise ? rupees(totalOf(r)) : ''}</td>
                <td><select className="field" value={r.pay} onKeyDown={onEnter} onChange={(e) => set(r.key, { pay: e.target.value as Row['pay'] })}>
                  <option value="credit">{t('Udhaar')}</option><option value="cash">{t('Cash')}</option><option value="upi">UPI</option>
                </select></td>
                <td>{rows.length > 1 && <button type="button" className="icon-btn" tabIndex={-1} aria-label={t('Hatayein')} onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="total-line big">
        <span>{t('{n} parchi', { n: filled.length })} · {count(boxes)} {lotWise ? t('box') : t('nag')}{lotWise && o?.apmcOn ? ` · ${t('APMC 1% saath')}` : ''}</span>
        <b className="money">{rupees(total)}</b>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="toolbar" style={{ marginTop: 12 }}>
        <span className="grow" />
        <button type="button" className="btn primary" disabled={busy || !filled.length} onClick={() => void save()}>{busy ? '…' : <><kbd>Ctrl+↵: </kbd>{`${t('Save')} · ${t('{n} parchi', { n: filled.length })} · ${rupees(total)}`}</>}</button>
      </div>
      {result && (
        <div className="card" style={{ padding: 14, display: 'grid', gap: 8 }}>
          <b>{t('{n} parchi bani', { n: result.made.length })} · {rupees(result.made.reduce((s, m) => s + m.totalPaise, 0))}</b>
          <div className="chips">
            {result.made.map((m) => <button key={m.billId} type="button" className="chip blue" onClick={() => openVoucher(shopId, m.billId)}>#{m.slipNo} · {m.buyerName} · {rupees(m.totalPaise)}</button>)}
          </div>
          {result.failed.map((f) => <p key={f.line} className="error" style={{ margin: 0 }}>{t('Line {n}', { n: f.line })}: {f.error}</p>)}
        </div>
      )}
    </>
  )
}

/** A grahak in the grid: type-ahead by name, mobile or code; Enter takes the lit one (or the typed name as a new grahak). */
function GrahakCell({ shopId, row, upper, bad, onPick, onEnter }: {
  shopId: string; row: Row; upper: boolean; bad?: boolean; onPick: (b: Row['buyer'], text: string) => void; onEnter: (e: KeyboardEvent) => void
}) {
  const [list, setList] = useState<BuyerRow[]>([])
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState(0)
  const text = row.buyer?.name ?? row.text
  useEffect(() => {
    if (!open || !row.text.trim()) { setList([]); return }
    let live = true
    const x = setTimeout(() => api<{ buyers: BuyerRow[] }>(`/v1/admin/shops/${shopId}/buyers?q=${encodeURIComponent(row.text.trim())}`)
      .then((r) => { if (live) { setList(r.buyers.filter((b) => !b.hidden).slice(0, 6)); setSel(0) } }).catch(() => {}), 150)
    return () => { live = false; clearTimeout(x) }
  }, [row.text, open, shopId])
  const exact = list.find((b) => b.name.trim().toLowerCase() === row.text.trim().toLowerCase())
  return (
    <div className="combo grahak-cell">
      <input className={`field${bad ? ' bad' : ''}`} style={upper ? caps : undefined} value={text} placeholder={t('Naam')} aria-label={t('Grahak')} aria-invalid={bad || undefined}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { onPick(null, e.target.value); setOpen(true) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(list.length - 1, sel + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, sel - 1)) }
          else if (e.key === 'Enter') {
            const b = open && list[sel] ? list[sel] : exact
            if (b) onPick({ id: b.id, name: b.name }, b.name)
            setOpen(false); onEnter(e)
          }
        }} />
      {row.buyer?.id ? null : row.text.trim() && !exact && !open ? <span className="chip blue cell-tag">{t('Naya')}</span> : null}
      {open && list.length > 0 && (
        <div className="combo-list" role="listbox">
          {list.map((b, i) => (
            <div key={b.id} role="option" aria-selected={i === sel} className="opt" onMouseDown={(e) => { e.preventDefault(); onPick({ id: b.id, name: b.name }, b.name); setOpen(false) }}>
              <span className="grow"><b>{b.name}</b>{b.phone ? <small>{fmtPhone(b.phone)}</small> : null}</span>
              {b.balancePaise ? <span className={`money ${b.balancePaise > 0 ? 'due' : 'jama'}`}>{rupees(Math.abs(b.balancePaise))}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

