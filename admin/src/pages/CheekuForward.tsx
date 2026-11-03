// Cheeku's "Aage bhejna" on the Home page, the website's copy of the app's screen: maal that came on a gaadi from a
// supplier goes on to a grahak. A grahak typed once with a mobile is remembered; the slip that goes with the maal
// carries no money and a QR; All Ledger holds the shop's own editable bill for each slip, with its profit or loss.
// Cheeku only — grapes has no copy of this.
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { api, type BuyerRow } from '../api'
import { count, phone as fmtPhone, rupees, shortDate } from '../format'
import { t } from '../i18n'
import { useSession } from '../App'
import { booksChanged, useLoad } from '../useLoad'
import { Field, Money, Sheet } from '../entries/fields'
import type { CheekuOptions } from '../entries/Cheeku'

type FLine = { brandId: string; quality: string; qty: number; slipRatePaise: number; ratePaise: number; costRatePaise: number }
/** A slip sent on, with the shop's own bill for it. */
type FBill = {
  billId: string; slipNo: number | null; date: string; person: string; phone: string; vehicle: string
  /** The grahak's record, when the slip has one (a name typed without a mobile has none). */
  buyerId?: string | null
  slipTotalPaise: number; scannedBoxes: number; lines: FLine[]
  bhadaPaise: number; mazdooriPaise: number; commissionPaise: number; edited: boolean
  goodsPaise: number; chargesPaise: number; netPaise: number; costPaise: number | null; profitPaise: number | null
  /** Where the bill's WhatsApp stands: none (no mobile), notqueued, onscan, pending, sent or failed. */
  whatsapp: { state: 'none' | 'notqueued' | 'onscan' | 'pending' | 'sent' | 'failed'; tries: number; error: string }
}
/** What goes with the maal: no rate, no amount, no supplier — the type has nowhere to put one. */
type PartySlip = {
  billId: string; slipNo: number | null; date: string; vehicle: string; grahak: string
  from: { name: string; mandi: string; phone: string }; lines: { quality: string; qty: number }[]
}
type Lot = NonNullable<CheekuOptions['lots']>[number] & { costPaise?: number }

const box = (n: number) => t('{n} box', { n: count(n) })
/** Does the typed text start the name, or one of its words ("sh" → Pooja Sharma)? */
const belongs = (name: string, typed: string) => { const q = typed.trim().toLowerCase(); const n = name.toLowerCase(); return !!q && (n.startsWith(q) || n.split(/[\s.&-]+/).some((w) => w.startsWith(q))) }
const keyOf = (truckId: string, brandId: string) => `${truckId}:${brandId}`

/** Where a bill's WhatsApp stands, in words. */
const waWords = (s: FBill['whatsapp']['state']) => ({
  none: '', sent: t('WhatsApp par bill gaya'), failed: t('WhatsApp par bill nahi ja paya'), pending: t('WhatsApp par bhejne ki koshish chal rahi hai'),
  onscan: t('Maal gaadi par scan hote hi bill WhatsApp par apne aap jayega'), notqueued: t('Bill abhi server tak nahi pahuncha — app se kholein'),
})[s]

/** The same, in a word or two, for the list. */
const waShort = (s: FBill['whatsapp']['state']) => ({ none: '', sent: t('WA gaya'), failed: t('WA nahi gaya'), pending: t('WA pending'), onscan: t('WA scan par'), notqueued: t('WA taiyari') })[s]

/** The first calculation: the boxes at the rate put on the slip when it was made. */
const slipAmount = (lines: FLine[]) => lines.reduce((s, l) => s + l.qty * l.slipRatePaise, 0)
/** Was the bill worked out a second time (a rate changed, or bhada / mazdoori / commission put on)? */
const recalculated = (b: { edited: boolean; chargesPaise: number; lines: FLine[] }) => b.edited || b.chargesPaise > 0 || b.lines.some((l) => l.ratePaise !== l.slipRatePaise)
/** The second calculation's net against the first: + a profit, − a loss; null until it is worked out again. */
const diffOf = (b: FBill) => (recalculated(b) ? b.netPaise - slipAmount(b.lines) : null)

/** "Munafa ₹X" in green, "Ghata ₹X" in red, then a small "Bikri receive"; nothing until a bill is worked out again. */
function Profit({ paise, plain }: { paise: number | null; plain?: boolean }) {
  if (paise === null) return null
  return <><b className={`money ${paise >= 0 ? 'jama' : 'due'}`}>{paise >= 0 ? t('Munafa') : t('Ghata')} {rupees(Math.abs(paise))}</b>{!plain && <> <small className="jama">{t('Bikri receive')}</small></>}</>
}

export function CheekuForwardCard({ shopId }: { shopId: string; from?: string; to?: string }) {
  const [form, setForm] = useState(false)
  const [ledger, setLedger] = useState(false)
  const [shown, setShown] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState('')
  const { data, error } = useLoad(() => api<{ bills: FBill[]; whatsappOn: boolean }>(`/v1/admin/shops/${shopId}/cheeku/forward-bills`), [shopId, tick])
  const bills = data?.bills ?? []

  const cancel = async (b: FBill) => {
    if (!window.confirm(t('Parchi #{n} radd karein? {b} box gaadi par wapas aa jayenge.', { n: String(b.slipNo ?? ''), b: count(b.lines.reduce((s, l) => s + l.qty, 0)) }))) return
    setBusy(b.billId); setMsg('')
    try {
      await api(`/v1/admin/shops/${shopId}/cheeku/forward/${b.billId}/cancel`, { method: 'POST', body: {} })
      booksChanged(); setTick((n) => n + 1); setMsg(t('Parchi #{n} radd ho gayi', { n: String(b.slipNo ?? '') }))
    } catch (e) { setMsg((e as Error).message) } finally { setBusy('') }
  }

  return (
    <div className="card">
      <div className="hd">
        <h3>{t('Bikri laddan')}</h3>
        <span style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn" onClick={() => setLedger(true)}>{t('All Ledger')}</button>
          <button type="button" className="btn primary" onClick={() => { setMsg(''); setForm(true) }}>+ {t('Bikri laddan')}</button>
        </span>
      </div>
      <div className="bd">
        {error && <p className="error">{error}</p>}
        {msg && <p className="muted" role="status">{msg}</p>}
        {data && bills.length === 0 && <p className="empty">{t('Abhi koi maal aage nahi bheja')}</p>}
        {bills.length > 0 && (
          <table className="tbl fold">
            <thead><tr><th>{t('Parchi')}</th><th>{t('Grahak')}</th><th className="opt-col">{t('Maal')}</th><th className="num">{t('Net')}</th><th className="opt-col" /></tr></thead>
            <tbody>
              {bills.slice(0, 8).map((b) => (
                <tr key={b.billId}>
                  <td>{b.slipNo ? `#${b.slipNo}` : ''}<small>{shortDate(b.date)}</small></td>
                  <td className="main-col"><b>{b.person}</b><small>{b.vehicle}</small></td>
                  <td className="opt-col">{b.lines.map((l, i) => <div key={i}>{l.quality} · {box(l.qty)}</div>)}</td>
                  <td className="num"><span className="money">{rupees(b.netPaise)}</span><small><Profit paise={diffOf(b)} /></small>{b.whatsapp.state !== 'none' && <small className={b.whatsapp.state === 'failed' ? 'due' : 'muted'}>{waShort(b.whatsapp.state)}</small>}</td>
                  <td className="opt-col act-col" style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="btn act" onClick={() => setShown(b.billId)}>{t('Party ki parchi')}</button>{' '}
                    {b.scannedBoxes === 0
                      ? <button type="button" className="btn act" disabled={busy === b.billId} onClick={() => void cancel(b)}>{t('Radd')}</button>
                      : <small className="muted">{t('Maal uth chuka')}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {form && <ForwardForm shopId={shopId} onClose={() => setForm(false)}
        onDone={(billId, slipNo) => { setForm(false); setTick((n) => n + 1); setMsg(t('Parchi #{n} save hui · stock se box ghat gaye', { n: String(slipNo) })); setShown(billId) }} />}
      {shown && <PartySlipView shopId={shopId} billId={shown} onClose={() => setShown(null)} />}
      {ledger && <LedgerSheet shopId={shopId} bills={bills} onClose={() => { setLedger(false); setTick((n) => n + 1) }} />}
    </div>
  )
}

// ================================================================ the form

function ForwardForm({ shopId, initialName = '', onClose, onDone }: { shopId: string; initialName?: string; onClose: () => void; onDone: (billId: string, slipNo: number) => void }) {
  const [o, setO] = useState<CheekuOptions | null>(null)
  // Opened from a party's row: the name comes filled (as picked); the mobile is still asked only if the name is new.
  const [name, setName] = useState(initialName)
  const [mobile, setMobile] = useState('')
  const [picked, setPicked] = useState<string | null>(initialName || null)
  const [people, setPeople] = useState<BuyerRow[]>([])
  const [resolved, setResolved] = useState('')   // the typed name the list above was fetched for
  const [search, setSearch] = useState('')
  const [lotKey, setLotKey] = useState('')
  const [qty, setQty] = useState(0)
  const [rate, setRate] = useState(0)
  const [vehicle, setVehicle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { api<CheekuOptions>(`/v1/admin/shops/${shopId}/entry-options`).then(setO).catch((e: Error) => setError(e.message)) }, [shopId])

  // The grahak the shop already has, offered from the first letters (each with the number it keeps).
  useEffect(() => {
    const q = name.trim()
    if (!q) { setPeople([]); setResolved(''); return }
    let live = true
    const timer = setTimeout(() => {
      api<{ buyers: BuyerRow[] }>(`/v1/admin/shops/${shopId}/buyers?q=${encodeURIComponent(q)}`)
        .then((r) => { if (live) { setPeople(r.buyers.filter((b) => !b.hidden && belongs(b.name, q)).slice(0, 5)); setResolved(q) } }).catch(() => {})
    }, 150)
    return () => { live = false; clearTimeout(timer) }
  }, [name, picked, shopId])

  // The mobile is asked for only when the name is a new one: nothing the shop has matches what was typed.
  const isNew = name.trim() !== '' && resolved === name.trim() && people.length === 0
  const lots = (o?.lots ?? []) as Lot[]
  const label = (l: Lot) => `${l.quality} · ${l.number}${l.supplier ? ` · ${l.supplier}` : ''}`
  const lot = lots.find((l) => keyOf(l.truckId, l.brandId) === lotKey)
  const q = search.trim().toLowerCase()
  // Nothing until letters are typed; then the maal whose name STARTS with them.
  const matches = q && !(lot && search === label(lot)) ? lots.filter((l) => l.quality.toLowerCase().startsWith(q)) : []
  const goods = qty * rate
  const buy = lot?.costPaise ?? 0
  const margin = lot && qty > 0 && rate > 0 && buy > 0 ? (rate - buy) * qty : null

  const save = async () => {
    if (!lot) return setError(t('Maal ka naam likhkar chunein'))
    if (qty <= 0) return setError(t('Kitne box bhejne hain, likhein'))
    if (rate <= 0) return setError(t('Aapka bhav likhein'))
    const mob = isNew ? mobile : ''   // typed before the name changed to a known one: ignored
    if (mob && !/^[6-9]\d{9}$/.test(mob)) return setError(t('10 ank ka sahi mobile number likhein'))
    if (qty > lot.left && !window.confirm(t('{what}: {left} box baaki, {q} likhe. Phir bhi parchi banayein?', { what: label(lot), left: count(Math.max(0, lot.left)), q: count(qty) }))) return
    setSaving(true); setError('')
    try {
      const r = await api<{ billId: string; slipNo: number }>(`/v1/admin/shops/${shopId}/cheeku/forward`, {
        method: 'POST', body: { customer: { name: name.trim(), mobile: mob }, lots: [{ truckId: lot.truckId, brandId: lot.brandId, qty, ratePaise: rate }], vehicle },
      })
      booksChanged(); onDone(r.billId, r.slipNo)
    } catch (e) { setError((e as Error).message); setSaving(false) }
  }

  return (
    <Sheet title={t('Bikri laddan')} onClose={onClose} onSave={() => void save()} saving={saving} error={error}
      saveLabel={goods ? `${t('Save')} · ${rupees(goods)}` : t('Save')}>
      <Field label={t('Naam')}>
        <div className="combo">
          <input className="field" value={name} maxLength={60} autoFocus onChange={(e) => { setName(e.target.value); if (picked) setMobile(''); setPicked(null) }} />
          {people.length > 0 && picked !== name && (
            <div className="combo-list" role="listbox">
              {people.map((b) => (
                <div key={b.id} role="option" aria-selected={false} className="opt"
                  onMouseDown={(e) => { e.preventDefault(); setName(b.name); setPicked(b.name); setMobile((b.phone ?? '').replace(/\D/g, '')) }}>
                  <span className="grow"><b>{b.name}</b></span>
                  <small>{b.phone ? fmtPhone(b.phone) : t('number nahi')}</small>
                </div>
              ))}
            </div>
          )}
        </div>
      </Field>
      {isNew && (
        <Field label={t('Mobile num')}>
          <input className="field" inputMode="tel" value={mobile} maxLength={10} onChange={(e) => setMobile(e.target.value.replace(/\D/g, ''))} />
        </Field>
      )}
      <Field label={t('Quality')}>
        <div className="combo">
          <input className="field" value={search} onChange={(e) => { setSearch(e.target.value); setLotKey('') }} />
          {q && matches.length === 0 && !(lot && search === label(lot)) && o && <small className="muted">{t('Is naam ka maal kisi gaadi mein nahi')}</small>}
          {matches.length > 0 && (
            <div className="combo-list" role="listbox">
              {matches.map((l) => (
                <div key={keyOf(l.truckId, l.brandId)} role="option" aria-selected={false} className="opt"
                  onMouseDown={(e) => { e.preventDefault(); setLotKey(keyOf(l.truckId, l.brandId)); setSearch(label(l)) }}>
                  <span className="grow"><b>{label(l)}</b></span>
                  <small>{t('{n} baaki', { n: count(l.left) })}</small>
                </div>
              ))}
            </div>
          )}
        </div>
      </Field>
      <div className="row2">
        <Field label={t('Box')}><input className="field" inputMode="numeric" value={qty || ''} onChange={(e) => setQty(Number(e.target.value.replace(/\D/g, '') || 0))} /></Field>
        <Field label={t('Aapka bhav ₹ / box')}><Money value={rate} onChange={setRate} /></Field>
      </div>
      {margin !== null && <p><Profit paise={margin} plain /></p>}
      <Field label={t('Gaadi number jis mein ja raha hai')}>
        <input className="field" value={vehicle} maxLength={20} onChange={(e) => setVehicle(e.target.value.toUpperCase())} />
      </Field>
      <div className="total-line"><span>{box(qty)}</span><b className="money">{rupees(goods)}</b></div>
    </Sheet>
  )
}

// ================================================================ the slip that goes with the maal

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Opens a page to print or save as PDF. */
function printPage(title: string, body: string) {
  const w = window.open('', '_blank', 'width=720,height=900')
  if (!w) return
  w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:16px system-ui,sans-serif;margin:32px;color:#111}h1{font-size:20px;margin:0}p{margin:4px 0;color:#444}
table{border-collapse:collapse;width:100%;margin-top:18px}th,td{border-bottom:1px solid #ccc;padding:8px 6px;text-align:left}.n{text-align:right}
.tot td{font-weight:700;border-bottom:2px solid #111}.sign{display:flex;justify-content:space-between;margin-top:56px}.sign div{border-top:1px solid #111;width:40%;text-align:center;padding-top:4px;font-size:13px}
.qr{text-align:center;margin-top:24px}.qr img{width:200px;height:200px}</style>${body}`)
  w.document.close(); w.focus(); setTimeout(() => w.print(), 250)
}

function PartySlipView({ shopId, billId, onClose }: { shopId: string; billId: string; onClose: () => void }) {
  const { data, error } = useLoad(() => api<PartySlip>(`/v1/admin/shops/${shopId}/cheeku/forward/${billId}/slip`), [shopId, billId])
  const [qr, setQr] = useState('')
  useEffect(() => { void QRCode.toDataURL(billId, { margin: 1, width: 240 }).then(setQr).catch(() => setQr('')) }, [billId])
  const print = () => {
    if (!data) return
    const rows = data.lines.map((l) => `<tr><td>${esc(l.quality)}</td><td class="n">${l.qty}</td></tr>`).join('')
    printPage(`${data.from.name} #${data.slipNo ?? ''}`, `
<h1>${esc(data.from.name)}</h1><p>${esc([data.from.mandi, data.from.phone].filter(Boolean).join(' · '))}</p>
<p><b>LADAN PARCHI ${data.slipNo ? '#' + data.slipNo : ''}</b> · ${esc(data.date)}</p>
${data.grahak ? `<p>${esc(t('Grahak'))}: <b>${esc(data.grahak)}</b></p>` : ''}
${data.vehicle ? `<p>${esc(t('Gaadi number'))}: <b>${esc(data.vehicle)}</b></p>` : ''}
<table><thead><tr><th>${esc(t('Quality'))}</th><th class="n">${esc(t('Box'))}</th></tr></thead><tbody>${rows}
<tr class="tot"><td>${esc(t('Kul box'))}</td><td class="n">${data.lines.reduce((s, l) => s + l.qty, 0)}</td></tr></tbody></table>
${qr ? `<div class="qr"><img src="${qr}" alt="QR"><p>${esc(t('Gaadi par scan karein'))}</p></div>` : ''}
<div class="sign"><div>${esc(t('Maal mila'))}</div><div>${esc(t('Accountant'))}</div></div>`)
  }
  return (
    <Sheet title={t('Party ki parchi')} onClose={onClose} onSave={print} saving={!data} error={error ?? ''} saveLabel={t('Print')}>
      {data && (
        <div className="stack">
          {data.grahak && <p><b>{data.grahak}</b></p>}
          <p className="muted">{data.slipNo ? `${t('Parchi')} #${data.slipNo} · ` : ''}{shortDate(data.date)}{data.vehicle ? ` · ${data.vehicle}` : ''}</p>
          <table className="tbl">
            <thead><tr><th>{t('Quality')}</th><th className="num">{t('Box')}</th></tr></thead>
            <tbody>{data.lines.map((l, i) => <tr key={i}><td>{l.quality}</td><td className="num">{count(l.qty)}</td></tr>)}</tbody>
          </table>
          {qr && <div style={{ textAlign: 'center' }}><img src={qr} alt="QR" width={180} height={180} /><p className="muted">{t('Gaadi par scan karein')}</p></div>}
          <p className="muted">{t('Is parchi par bhav ya amount nahi hai')}</p>
        </div>
      )}
    </Sheet>
  )
}

// ================================================================ All Ledger and the shop's own bill

function LedgerSheet({ shopId, bills, onClose }: { shopId: string; bills: FBill[]; onClose: () => void }) {
  const [list, setList] = useState(bills)
  const [open, setOpen] = useState<FBill | null>(null)
  const [party, setParty] = useState<string | null>(null)
  const known = list.map(diffOf).filter((p): p is number => p !== null)
  const people = new Map<string, FBill[]>()
  for (const b of list) people.set(b.person || 'Cash', [...(people.get(b.person || 'Cash') ?? []), b])
  // The bill's own sheet sits beside this one, never inside it: a sheet is a form, and forms cannot nest.
  return (
    <>
    <Sheet wide title={t('All Ledger')} onClose={onClose} onSave={onClose} saving={false} error="" saveLabel={t('Band karein')}>
      <div className="stack">
        <p>{t('{n} parchi · {b} box', { n: String(list.length), b: count(list.reduce((s, b) => s + b.lines.reduce((x, l) => x + l.qty, 0), 0)) })} · <b className="money">{rupees(list.reduce((s, b) => s + b.netPaise, 0))}</b>{known.length > 0 && <> · <Profit paise={known.reduce((s, p) => s + p, 0)} /></>}</p>
        {list.length === 0 && <p className="empty">{t('Abhi koi maal aage nahi bheja')}</p>}
        {[...people].map(([person, mine]) => {
          const mk = mine.map(diffOf).filter((p): p is number => p !== null)
          return (
            <div key={person}>
              <h4 style={{ display: 'flex', justifyContent: 'space-between' }}>
                <button type="button" className="link" style={{ font: 'inherit', fontWeight: 700, cursor: 'pointer', background: 'none', border: 0, padding: 0, color: 'var(--accent, inherit)' }} onClick={() => setParty(person)}>{person} ›</button>
                <span><b className="money">{rupees(mine.reduce((s, b) => s + b.netPaise, 0))}</b>{mk.length > 0 && <> · <Profit paise={mk.reduce((s, p) => s + p, 0)} /></>}</span></h4>
              <table className="tbl">
                <tbody>
                  {mine.map((b) => (
                    <tr key={b.billId} data-row tabIndex={0} onClick={() => setOpen(b)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(b) }} style={{ cursor: 'pointer' }}>
                      <td>#{b.slipNo} · {shortDate(b.date)}{b.edited ? ' ✎' : ''}</td>
                      <td>{b.lines.map((l) => `${l.quality} · ${box(l.qty)}`).join(', ')}</td>
                      <td className="num"><span className="money">{rupees(b.netPaise)}</span></td>
                      <td className="num"><Profit paise={diffOf(b)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        })}
      </div>
    </Sheet>
    {open && <BillSheet shopId={shopId} bill={open} onClose={() => setOpen(null)}
      onSaved={(saved) => { setList((l) => l.map((b) => (b.billId === saved.billId ? saved : b))); setOpen(null); setParty(saved.person || 'Cash') }} />}
    {party && <PartySheet shopId={shopId} person={party} onClose={() => setParty(null)} />}
    </>
  )
}

// ================================================================ one party of Bikri laddan

/** Bills of one party (Cash for no name), oldest first. */
const ofParty = (bills: FBill[], person: string) => bills.filter((b) => (b.person || 'Cash').toLowerCase() === person.toLowerCase())
  .sort((a, b) => a.date.localeCompare(b.date) || (a.slipNo ?? 0) - (b.slipNo ?? 0))

/** The party's LEDGER, the agent's-bill way: every worked-out slip's qualities, the total, less the kharcha, to the net; then bhada / mazdoori / commission. */
function ledgerFigures(done: FBill[]) {
  const rows = done.flatMap((b) => b.lines.map((l) => ({ what: `#${b.slipNo ?? ''} ${l.quality}`, qty: l.qty, rate: l.ratePaise, amount: l.qty * l.ratePaise })))
  const sum = (f: (b: FBill) => number) => done.reduce((s, b) => s + f(b), 0)
  const bhada = sum((b) => b.bhadaPaise), mazdoori = sum((b) => b.mazdooriPaise), commission = sum((b) => b.commissionPaise)
  const goods = rows.reduce((s, r) => s + r.amount, 0)
  const charges = bhada + mazdoori + commission
  return { rows, boxes: rows.reduce((s, r) => s + r.qty, 0), goods, bhada, mazdoori, commission, charges, net: goods - charges }
}

/**
 * One party, as the app's page for them: what all their slips come to, their mobile, their Ledger (the
 * slips worked out again — Bikri receive — as one agent's bill), and every slip with the running total.
 * A worked-out slip opens its bill; the bill's sheet sits beside this one, never inside it.
 */
function PartySheet({ shopId, person, onlyDone, onClose }: { shopId: string; person: string; onlyDone?: boolean; onClose: () => void }) {
  const [tick, setTick] = useState(0)
  const [open, setOpen] = useState<FBill | null>(null)
  const [ledger, setLedger] = useState(false)
  const { data, error } = useLoad(() => api<{ bills: FBill[] }>(`/v1/admin/shops/${shopId}/cheeku/forward-bills`), [shopId, tick])
  const list = ofParty(data?.bills ?? [], person).filter((b) => !onlyDone || diffOf(b) !== null)
  const done = list.filter((b) => diffOf(b) !== null)
  const diff = done.reduce((s, b) => s + (diffOf(b) ?? 0), 0)
  const phone = [...list].reverse().find((b) => b.phone)?.phone ?? ''
  let run = 0
  const running = list.map((b) => { run += b.netPaise; return { b, balance: run } }).reverse()
  const boxes = list.reduce((s, b) => s + b.lines.reduce((x, l) => x + l.qty, 0), 0)
  return (
    <>
    <Sheet wide title={person} onClose={onClose} onSave={onClose} saving={false} error={error ?? ''} saveLabel={t('Band karein')}>
      {!data ? <p className="muted">{t('Khul raha hai…')}</p> : (
        <div className="stack">
          <div className="box">
            <small className="muted">{t('Kul rakam')}</small>
            <div style={{ fontSize: 28, fontWeight: 800 }} className="money">{rupees(list.reduce((s, b) => s + b.netPaise, 0))}</div>
            <small className="muted">{t('{n} parchi · {b} box', { n: String(list.length), b: count(boxes) })}{phone ? ` · ${fmtPhone(phone)}` : ''}</small>
          </div>
          <div className="box" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: done.length ? 'pointer' : 'default' }}
            role="button" tabIndex={0} onClick={() => { if (done.length) setLedger(true) }} onKeyDown={(e) => { if (e.key === 'Enter' && done.length) setLedger(true) }}>
            <b>{t('Ledger')}</b>
            {done.length ? <span style={{ whiteSpace: 'nowrap' }}><Profit paise={diff} /> ›</span> : <small className="muted">{t('Abhi koi bill dobara nahi bana')}</small>}
          </div>
          {list.length === 0 ? <p className="empty">{t('Is naam ki koi parchi nahi')}</p> : (
            <table className="tbl">
              <tbody>
                {running.map(({ b, balance }) => (
                  <tr key={b.billId} data-row tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => setOpen(b)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(b) }}>
                    <td><b>{t('Slip')} #{b.slipNo}</b>
                      <small>{shortDate(b.date)} · {box(b.lines.reduce((x, l) => x + l.qty, 0))} · {b.lines.map((l) => l.quality).join(', ')}</small>
                      {diffOf(b) !== null && <small><Profit paise={diffOf(b)} /></small>}</td>
                    <td className="num"><b className="money">+{rupees(b.netPaise)}</b><small className="muted">{rupees(balance)}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Sheet>
    {ledger && <PartyLedgerSheet shopId={shopId} person={person} done={done} onClose={() => setLedger(false)} />}
    {open && <BillSheet shopId={shopId} bill={open} onClose={() => setOpen(null)}
      onSaved={() => { setOpen(null); setTick((n) => n + 1); booksChanged() }} />}
    </>
  )
}

/** The party's Ledger on screen, laid out like an agent's bill, with Print. */
function PartyLedgerSheet({ shopId, person, done, onClose }: { shopId: string; person: string; done: FBill[]; onClose: () => void }) {
  const shop = useSession().shops?.find((s) => s.id === shopId)
  const f = ledgerFigures(done)
  const dates = done.map((b) => b.date).sort()
  const when = dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} – ${dates[dates.length - 1]}`) : ''
  const print = () => {
    const rows = f.rows.map((r) => `<tr><td>${esc(r.what)}</td><td class="n">${r.qty}</td><td class="n">${rupees(r.rate)}</td><td class="n">${rupees(r.amount)}</td></tr>`).join('')
    const line = (label: string, v: number) => (v > 0 ? `<tr><td colspan="3">${esc(label)}</td><td class="n">${rupees(v)}</td></tr>` : '')
    printPage(`${t('Ledger')} · ${person}`, `
<h1>${esc(shop?.name ?? '')}</h1><p>${esc([shop?.mandi].filter(Boolean).join(' · '))}</p>
<p><b>LEDGER</b> · ${esc(when)}</p>
<p>M/s. <b>${esc(person)}</b></p>
<table><thead><tr><th>PARTICULARS</th><th class="n">QTY</th><th class="n">RATE</th><th class="n">AMOUNT</th></tr></thead><tbody>${rows}
<tr class="tot"><td>${esc(t('Kul'))}</td><td class="n">${f.boxes}</td><td></td><td class="n">${rupees(f.goods)}</td></tr>
${line('Kharcha (−)', f.charges)}
<tr class="tot"><td colspan="3">NET</td><td class="n">${rupees(f.net)}</td></tr></tbody></table>
${f.charges > 0 ? `<table><tbody>${line('Bhada', f.bhada)}${line('Mazdoori', f.mazdoori)}${line('Commission', f.commission)}<tr class="tot"><td colspan="3">Total</td><td class="n">${rupees(f.charges)}</td></tr></tbody></table>` : ''}`)
  }
  return (
    <Sheet wide title={`${t('Ledger')} · ${person}`} onClose={onClose} onSave={print} saving={false} error="" saveLabel={t('Print')}>
      <div className="stack">
        <p className="muted">{shop?.name} · {when}</p>
        <p>M/s. <b>{person}</b></p>
        <table className="tbl">
          <thead><tr><th>{t('Particulars')}</th><th className="num">{t('Box')}</th><th className="num">{t('Rate')}</th><th className="num">{t('Amount')}</th></tr></thead>
          <tbody>
            {f.rows.map((r, i) => <tr key={i}><td>{r.what}</td><td className="num">{count(r.qty)}</td><td className="num money">{rupees(r.rate)}</td><td className="num money">{rupees(r.amount)}</td></tr>)}
            <tr><td><b>{t('Kul')}</b></td><td className="num"><b>{count(f.boxes)}</b></td><td /><td className="num"><b className="money">{rupees(f.goods)}</b></td></tr>
            {f.charges > 0 && <tr><td colSpan={3}>{t('Kharcha')} (−)</td><td className="num money">{rupees(f.charges)}</td></tr>}
          </tbody>
        </table>
        <div className="total-line"><span>{t('Net')}</span><b className="money">{rupees(f.net)}</b></div>
        {f.charges > 0 && (
          <table className="tbl">
            <tbody>
              {f.bhada > 0 && <tr><td>{t('Bhada')}</td><td className="num money">{rupees(f.bhada)}</td></tr>}
              {f.mazdoori > 0 && <tr><td>{t('Mazdoori')}</td><td className="num money">{rupees(f.mazdoori)}</td></tr>}
              {f.commission > 0 && <tr><td>{t('Commission')}</td><td className="num money">{rupees(f.commission)}</td></tr>}
              <tr><td><b>{t('Total')}</b></td><td className="num"><b className="money">{rupees(f.charges)}</b></td></tr>
            </tbody>
          </table>
        )}
      </div>
    </Sheet>
  )
}

/**
 * Laddan page's "Bikri receive": every party maal went on to (Bikri laddan), with their slips, total and
 * munafa / ghata; a party opens as the app's page for them, with their Ledger.
 */
/** The app's Bikri laddan flow for one name: the form (name filled), then the party's QR slip. */
export function CheekuForwardStart({ shopId, name, onClose }: { shopId: string; name: string; onClose: () => void }) {
  const [shown, setShown] = useState<string | null>(null)
  return shown
    ? <PartySlipView shopId={shopId} billId={shown} onClose={onClose} />
    : <ForwardForm shopId={shopId} initialName={name} onClose={onClose} onDone={(billId) => { booksChanged(); setShown(billId) }} />
}

/** A laddan party from the master (the Laddan page's own list). */
export type LaddanMaster = { id: string; name: string; code: string; city: string; area: string; phone: string; contactPerson: string; balancePaise: number; hidden: boolean }

/**
 * The Laddan tab: every party maal went to — the laddan masters and every name in Bikri laddan's All
 * Ledger (the same list the app shows), as one table. A name with slips opens as the app's page for
 * them; a master with none opens its details. [q] narrows by name, code, city or mobile.
 */
export function CheekuLaddanAll({ shopId, masters, q, onMaster }: {
  shopId: string; masters: LaddanMaster[]; q: string; onMaster: (m: LaddanMaster) => void
}) {
  const [party, setParty] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  // Parchi: the app's Bikri laddan flow — the form with the name filled (empty for Cash), then the party's QR slip.
  const [fwdFor, setFwdFor] = useState<string | null>(null)
  const [shown, setShown] = useState<string | null>(null)
  const { data, error } = useLoad(() => api<{ bills: FBill[] }>(`/v1/admin/shops/${shopId}/cheeku/forward-bills`), [shopId, tick])
  const key = (s: string) => s.trim().toUpperCase()
  const people = new Map<string, FBill[]>()
  for (const b of data?.bills ?? []) people.set(key(b.person || 'Cash'), [...(people.get(key(b.person || 'Cash')) ?? []), b])
  const byName = new Map(masters.map((m) => [key(m.name), m]))
  const needle = q.trim().toLowerCase()
  const hit = (name: string, phone: string) => !needle || name.toLowerCase().includes(needle) || phone.includes(needle.replace(/\D/g, '') || '\u0000')
  // Names with slips first (latest slip first, as the server sends them), then masters with none yet.
  const rows = [
    ...[...people].map(([k, mine]) => ({ k, name: mine[0].person || 'Cash', mine, m: byName.get(k), phone: mine.find((b) => b.phone)?.phone ?? byName.get(k)?.phone ?? '' }))
      .filter((r) => r.m || hit(r.name, r.phone)),
    ...masters.filter((m) => !people.has(key(m.name))).map((m) => ({ k: key(m.name), name: m.name, mine: [] as FBill[], m, phone: m.phone })),
  ]
  return (
    <>
      {error && <p className="error">{error}</p>}
      <div className="card wrap-x">
        <table className="tbl fold">
          <thead><tr>
            <th className="opt-col">{t('Code')}</th><th>{t('Naam')}</th><th className="opt-col">{t('City')}</th><th className="opt-col">{t('Contact')}</th>
            <th className="num">{t('Parchi')}</th><th className="num">{t('Kul rakam')}</th><th className="num opt-col">{t('Munafa / Ghata')}</th><th className="num">{t('Baaki')}</th><th className="opt-col" />
          </tr></thead>
          <tbody>
            {rows.map(({ k, name, mine, m, phone }) => {
              const mk = mine.map(diffOf).filter((p): p is number => p !== null)
              const open = () => (mine.length ? setParty(name) : m && onMaster(m))
              return (
                <tr key={k} data-row tabIndex={0} className={m?.hidden ? 'void' : undefined} style={{ cursor: 'pointer' }} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open() }}>
                  <td className="opt-col">{m?.code ?? ''}</td>
                  <td className="main-col"><b>{name}</b><small>{mine.length ? box(mine.reduce((s, b) => s + b.lines.reduce((x, l) => x + l.qty, 0), 0)) : ''}{m?.city || m?.area ? ` · ${[m.city, m.area].filter(Boolean).join(' · ')}` : ''}</small></td>
                  <td className="opt-col">{m?.city ?? ''}</td>
                  <td className="opt-col">{[m?.contactPerson, phone ? fmtPhone(phone) : ''].filter(Boolean).join(' · ')}</td>
                  <td className="num">{mine.length ? count(mine.length) : ''}</td>
                  <td className="num">{mine.length ? <b className="money">{rupees(mine.reduce((s, b) => s + b.netPaise, 0))}</b> : ''}</td>
                  <td className="num opt-col">{mk.length > 0 ? <Profit paise={mk.reduce((s, p) => s + p, 0)} /> : ''}</td>
                  <td className="num amt-col">{m ? <span className={`money b${m.balancePaise > 0 ? ' due' : ''}`}>{rupees(m.balancePaise)}</span> : ''}</td>
                  <td className="opt-col act-col"><button type="button" className="btn act" onClick={(e) => {
                    e.stopPropagation()
                    setFwdFor(name === 'Cash' && !m ? '' : name)
                  }}>{t('Parchi')}</button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {data && rows.length === 0 && <p className="empty">{needle ? t('Koi laddan party nahi mili') : t('Abhi koi laddan party nahi')}</p>}
      </div>
      {rows.length > 0 && <p className="muted" style={{ marginTop: 8 }}>{count(rows.length)} {t('party')}</p>}
      {party && <PartySheet shopId={shopId} person={party} onClose={() => { setParty(null); setTick((n) => n + 1) }} />}
      {fwdFor !== null && <ForwardForm shopId={shopId} initialName={fwdFor} onClose={() => setFwdFor(null)}
        onDone={(billId) => { setFwdFor(null); setTick((n) => n + 1); setShown(billId) }} />}
      {shown && <PartySlipView shopId={shopId} billId={shown} onClose={() => setShown(null)} />}
    </>
  )
}

export function CheekuBikriReceive({ shopId, onlyDone }: { shopId: string; onlyDone?: boolean }) {
  const [party, setParty] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const { data, error } = useLoad(() => api<{ bills: FBill[] }>(`/v1/admin/shops/${shopId}/cheeku/forward-bills`), [shopId, tick])
  const people = new Map<string, FBill[]>()
  // onlyDone: just the slips whose bill is finally worked out (Bikri received).
  for (const b of (data?.bills ?? []).filter((x) => !onlyDone || diffOf(x) !== null)) people.set(b.person || 'Cash', [...(people.get(b.person || 'Cash') ?? []), b])
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="hd"><h3>{onlyDone ? t('Bikri received') : t('Bikri receive')}</h3></div>
      <div className="bd">
        {error && <p className="error">{error}</p>}
        {data && people.size === 0 && <p className="empty">{onlyDone ? t('Abhi kisi ka final bill nahi bana') : t('Abhi koi maal aage nahi bheja')}</p>}
        {people.size > 0 && (
          <table className="tbl fold">
            <thead><tr><th>{t('Naam')}</th><th className="opt-col">{t('Mobile')}</th><th className="num">{t('Parchi')}</th><th className="num">{t('Kul rakam')}</th><th className="num">{t('Munafa / Ghata')}</th></tr></thead>
            <tbody>
              {[...people].map(([person, mine]) => {
                const mk = mine.map(diffOf).filter((p): p is number => p !== null)
                const phone = mine.find((b) => b.phone)?.phone ?? ''
                return (
                  <tr key={person} data-row tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => setParty(person)} onKeyDown={(e) => { if (e.key === 'Enter') setParty(person) }}>
                    <td className="main-col"><b>{person}</b><small>{box(mine.reduce((s, b) => s + b.lines.reduce((x, l) => x + l.qty, 0), 0))}</small></td>
                    <td className="opt-col">{phone ? fmtPhone(phone) : ''}</td>
                    <td className="num">{count(mine.length)}</td>
                    <td className="num"><b className="money">{rupees(mine.reduce((s, b) => s + b.netPaise, 0))}</b></td>
                    <td className="num">{mk.length > 0 ? <Profit paise={mk.reduce((s, p) => s + p, 0)} /> : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      {party && <PartySheet shopId={shopId} person={party} onlyDone={onlyDone} onClose={() => { setParty(null); setTick((n) => n + 1) }} />}
    </div>
  )
}

/** The slip's personal bill, laid out like an agent's bill; the rate and the three charges are typed, the profit or loss is said as they change. */
function BillSheet({ shopId, bill, onClose, onSaved }: { shopId: string; bill: FBill; onClose: () => void; onSaved: (b: FBill) => void }) {
  const shop = useSession().shops?.find((s) => s.id === shopId)
  const [rates, setRates] = useState<Record<string, number>>(() => Object.fromEntries(bill.lines.map((l) => [l.brandId, l.ratePaise])))
  const [bhada, setBhada] = useState(bill.bhadaPaise)
  const [mazdoori, setMazdoori] = useState(bill.mazdooriPaise)
  // Commission is typed as a % of the goods (the boxes at the rates), never of goods plus bhada or mazdoori.
  const [commissionPct, setCommissionPct] = useState(() => {
    const g = bill.lines.reduce((sum, l) => sum + l.qty * l.ratePaise, 0)
    return bill.commissionPaise > 0 && g > 0 ? String(Math.round((bill.commissionPaise * 10000) / g) / 100) : ''
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [waMsg, setWaMsg] = useState('')
  const lines = bill.lines.map((l) => ({ ...l, ratePaise: rates[l.brandId] ?? 0 }))
  const goods = lines.reduce((s, l) => s + l.qty * l.ratePaise, 0)
  const pct = Math.min(100, Math.max(0, Number(commissionPct.replace(',', '.')) || 0))
  const commission = Math.round((goods * pct) / 100)
  const charges = bhada + mazdoori + commission
  const net = goods - charges
  // Against the first calculation (the slip's own amount), once the bill is worked out again.
  const profit = recalculated({ edited: bill.edited, chargesPaise: charges, lines }) ? net - slipAmount(lines) : null
  const boxes = lines.reduce((s, l) => s + l.qty, 0)

  const save = async () => {
    setSaving(true); setError('')
    try {
      const saved = await api<FBill>(`/v1/admin/shops/${shopId}/cheeku/forward-bills/${bill.billId}`, {
        method: 'POST', body: { rates, bhadaPaise: bhada, mazdooriPaise: mazdoori, commissionPaise: commission },
      })
      onSaved(saved)
    } catch (e) { setError((e as Error).message); setSaving(false) }
  }
  const resend = async () => {
    setWaMsg('')
    try { await api(`/v1/admin/shops/${shopId}/cheeku/forward-bills/${bill.billId}/whatsapp/resend`, { method: 'POST', body: {} }); setWaMsg(t('Bill dobara bheja ja raha hai')) }
    catch (e) { setWaMsg((e as Error).message) }
  }
  const print = () => {
    const rows = lines.map((l) => `<tr><td>${esc(l.quality)}</td><td class="n">${l.qty}</td><td class="n">${rupees(l.ratePaise)}</td><td class="n">${rupees(l.qty * l.ratePaise)}</td></tr>`).join('')
    const head = (label: string, v: number) => (v > 0 ? `<tr><td colspan="3">${esc(label)}</td><td class="n">${rupees(v)}</td></tr>` : '')
    printPage(`${t('Bill')} #${bill.slipNo ?? ''}`, `
<h1>${esc(shop?.name ?? '')}</h1><p>${esc([shop?.mandi].filter(Boolean).join(' · '))}</p>
<p><b>BILL ${bill.slipNo ? 'No. ' + bill.slipNo : ''}</b> · ${esc(bill.date)}</p>
<p>M/s. <b>${esc(bill.person || 'Cash')}</b>${bill.vehicle ? ` · ${esc(bill.vehicle)}` : ''}</p>
<table><thead><tr><th>PARTICULARS</th><th class="n">QTY</th><th class="n">RATE</th><th class="n">AMOUNT</th></tr></thead><tbody>${rows}
<tr class="tot"><td>${esc(t('Kul'))}</td><td class="n">${boxes}</td><td></td><td class="n">${rupees(goods)}</td></tr>
${head('Bhada', bhada)}${head('Mazdoori', mazdoori)}${head('Commission', commission)}${charges > 0 ? head('Kul kharcha', charges) : ''}
<tr class="tot"><td colspan="3">NET</td><td class="n">${rupees(net)}</td></tr></tbody></table>`)
  }

  return (
    <Sheet wide title={`${t('Parchi')} #${bill.slipNo ?? ''} · ${bill.person || 'Cash'}`} onClose={onClose} onSave={() => void save()} saving={saving} error={error} saveLabel={t('Save karein')}>
      <div className="stack">
        <p className="muted">{shop?.name} · {shortDate(bill.date)}{bill.vehicle ? ` · ${bill.vehicle}` : ''}</p>
        {bill.whatsapp.state !== 'none' && (
          <div className="box">
            <p className={bill.whatsapp.state === 'failed' ? 'due' : 'muted'}>{waWords(bill.whatsapp.state)}</p>
            {bill.whatsapp.error && bill.whatsapp.state !== 'sent' && <small className="muted">{bill.whatsapp.error}</small>}
            {bill.whatsapp.state !== 'notqueued' && <p><button type="button" className="btn" onClick={() => void resend()}>{t('WhatsApp par dobara bhejein')}</button> {waMsg && <small className="muted">{waMsg}</small>}</p>}
          </div>
        )}
        <table className="tbl">
          <thead><tr><th>{t('Particulars')}</th><th className="num">{t('Box')}</th><th>{t('Party se mila bhav ₹ / box')}</th><th className="num">{t('Amount')}</th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.brandId}>
                <td>{l.quality}</td><td className="num">{count(l.qty)}</td>
                <td><Money value={l.ratePaise} selectOnFocus onChange={(v) => setRates((r) => ({ ...r, [l.brandId]: v }))} /></td>
                <td className="num"><span className="money">{rupees(l.qty * l.ratePaise)}</span></td>
              </tr>
            ))}
            <tr><td><b>{t('Kul')}</b></td><td className="num"><b>{count(boxes)}</b></td><td /><td className="num"><b className="money">{rupees(goods)}</b></td></tr>
          </tbody>
        </table>
        <div className="row2">
          <Field label={t('Bhada ₹')}><Money value={bhada} selectOnFocus onChange={setBhada} /></Field>
          <Field label={t('Mazdoori ₹')}><Money value={mazdoori} selectOnFocus onChange={setMazdoori} /></Field>
        </div>
        <Field label={t('Commission %')}>
          <input type="number" inputMode="decimal" min="0" max="100" step="0.01" value={commissionPct} onFocus={(e) => e.target.select()} onChange={(e) => setCommissionPct(e.target.value)} />
        </Field>
        {commission > 0 && <p className="muted">{t('Commission')} {rupees(commission)} ({t('kul')} {rupees(goods)} {t('ka')})</p>}
        <p className="muted">{t('Kul kharcha')}: <b className="money">{rupees(charges)}</b></p>
        <div className="total-line"><span>{t('Net')}</span><b className="money">{rupees(net)}</b></div>
        {profit !== null && <p><Profit paise={profit} /></p>}
        <div><button type="button" className="btn" onClick={print}>{t('Bill chhapein')}</button></div>
      </div>
    </Sheet>
  )
}
