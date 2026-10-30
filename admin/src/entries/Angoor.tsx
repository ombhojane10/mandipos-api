import { useEffect, useState } from 'react'
import { api } from '../api'
import { count, rupees } from '../format'
import { t } from '../i18n'
import { booksChanged } from '../useLoad'
import { BuyerPicker, Field, isWalkInName, Money, Seg, Sheet, Tick, type PickedBuyer } from './fields'
import type { EditBill, EditGaadi, VoiceDraft } from './kinds'

/** What the grapes forms read from entry-options: every quality on every open gaadi, and each supplier's last gaadi. */
export type AngoorOptions = {
  apmcOn?: boolean
  lots?: { truckId: string; number: string; supplier: string; location: string; brandId: string; quality: string; left: number; boxGrams: number }[]
  lastArrivals?: { supplier: string; location: string; lots: { quality: string; boxGrams: number; ratePaise: number }[] }[]
  brands: { id: string; name: string }[]
  suppliers: string[]
  banks: string[]
}

type Pay = 'cash' | 'upi' | 'credit' | 'split' | 'after' | 'free'
type Line = { key: string; qty: number; ratePaise: number }
const keyOf = (truckId: string, brandId: string) => `${truckId}:${brandId}`

const remembered = (k: string, fallback: string) => { try { return localStorage.getItem(k) ?? fallback } catch { return fallback } }
const remember = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private window */ } }

function useSave(onDone: (msg: string) => void) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const save = async (path: string, body: unknown, msg: (r: Record<string, unknown>) => string) => {
    setSaving(true); setError('')
    try {
      const r = await api<Record<string, unknown>>(path, { method: 'POST', body })
      booksChanged()
      onDone(msg(r))
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }
  return { saving, error, setError, save }
}

/**
 * Angoor's Nayi Parchi, as the app writes it: each line one quality off one gaadi (several gaadis
 * on one slip), no count limit, 1% APMC when the shop has it on, and on an udhaar slip the labour
 * at a rate that can be changed.
 */
export function AngoorParchiForm({ shopId, o, editing, draft, onClose, onDone }: {
  shopId: string; o: AngoorOptions; editing?: EditBill; draft?: Extract<VoiceDraft, { kind: 'parchi' }>; onClose: () => void; onDone: (msg: string) => void
}) {
  const { saving, error, setError, save } = useSave(onDone)
  const lots = o.lots ?? []
  const [buyer, setBuyer] = useState<PickedBuyer | null>(() => !editing ? (draft?.buyer as PickedBuyer | null) ?? null
    : editing.buyerId ? { id: editing.buyerId, name: editing.buyerName } : { id: null, name: isWalkInName(editing.buyerName) ? editing.buyerName : 'Cash' })
  const [lines, setLines] = useState<Line[]>(() => editing
    ? editing.lines.filter((l) => !l.leak && l.truckId && l.brandId).map((l) => ({ key: keyOf(l.truckId!, l.brandId!), qty: l.qty, ratePaise: l.ratePaise }))
    : draft?.lots?.length ? draft.lots.map((l) => ({ key: keyOf(l.truckId, l.brandId), qty: l.qty, ratePaise: l.ratePaise }))
    : [{ key: lots[0] ? keyOf(lots[0].truckId, lots[0].brandId) : '', qty: 0, ratePaise: 0 }])
  const [pay, setPay] = useState<Pay>(() => {
    if (!editing) return draft?.pay ?? (draft?.buyer?.id ? 'credit' : 'cash')
    const b = editing
    return b.payMode === 'free' ? 'free' : b.payMode === 'after' ? 'after' : b.paidPaise === 0 ? 'credit'
      : b.cashPaise === b.totalPaise ? 'cash' : b.upiPaise === b.totalPaise ? 'upi' : 'split'
  })
  const [cash, setCash] = useState(editing?.cashPaise ?? draft?.cashPaise ?? 0)
  const [upi, setUpi] = useState(editing?.upiPaise ?? draft?.upiPaise ?? 0)
  const [bank, setBank] = useState(editing?.upiBank || o.banks[0] || '')
  const boxesEdited = editing?.lines.reduce((s, l) => s + l.qty, 0) ?? 0
  const [labour, setLabour] = useState(editing ? editing.labourPaise > 0 : !!draft?.labour)
  const [rate, setRate] = useState(() => editing && editing.labourPaise > 0 && boxesEdited > 0
    ? Math.round(editing.labourPaise / boxesEdited) : Number(remembered('mp.angoorLabourRate', '1000')) || 1000)
  const [delivery, setDelivery] = useState(!!editing?.delivery || !!draft?.delivery)
  const [address, setAddress] = useState(editing?.delivery?.address ?? '')
  const [stand, setStand] = useState(editing?.delivery?.stand ?? '')
  const [staff, setStaff] = useState(() => editing ? (editing.staff === 'Website' ? '' : editing.staff) : remembered('mp.staff', ''))
  const [slipNo, setSlipNo] = useState(editing?.slipNo ? String(editing.slipNo) : '')
  useEffect(() => { if (!bank && o.banks[0]) setBank(o.banks[0]) }, [o]) // eslint-disable-line react-hooks/exhaustive-deps

  // A slip being changed keeps its own gaadis on offer, even closed since.
  const choices = [...lots]
  for (const l of editing?.lines ?? []) {
    if (l.truckId && l.brandId && !choices.some((c) => c.truckId === l.truckId && c.brandId === l.brandId)) {
      choices.push({ truckId: l.truckId, brandId: l.brandId, number: '', supplier: '', location: '', quality: l.brand, left: 0, boxGrams: 0 })
    }
  }
  const lot = (key: string) => choices.find((c) => keyOf(c.truckId, c.brandId) === key)
  const label = (c: (typeof choices)[number]) => [c.quality, c.number, c.supplier].filter(Boolean).join(' · ') + ` · ${t('{n} baaki', { n: count(c.left) })}`

  const free = pay === 'free'
  const credit = pay === 'credit' || pay === 'after'
  const boxes = lines.reduce((s, l) => s + l.qty, 0)
  const goods = free ? 0 : lines.reduce((s, l) => s + l.qty * l.ratePaise, 0)
  const apmc = o.apmcOn ? Math.round(goods * 0.01) : 0
  const labourPaise = !free && credit && labour ? boxes * rate : 0
  const total = goods + apmc + labourPaise
  const walkIn = !buyer || (buyer.id === null && isWalkInName(buyer.name))
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const pickBuyer = (b: PickedBuyer | null) => {
    setBuyer(b)
    if (b?.id === null && b.name === 'Cash') setPay('cash')
    else if (b?.id === null && b.name === 'Bank') setPay('upi')
    else if (b?.id && pay === 'cash') setPay('credit')
    if (b?.id) { setAddress(b.address ?? ''); setStand(b.destination ?? '') }
  }

  // Overbooking: more boxes than a gaadi shows. Taken (orders run ahead of the count), but warned
  // first — each quality with what is left (a slip being changed gets its own boxes back).
  const over = (() => {
    const want = new Map<string, number>()
    for (const l of lines) if (l.qty > 0 && lot(l.key)) want.set(l.key, (want.get(l.key) ?? 0) + l.qty)
    return [...want].flatMap(([key, q]) => {
      const c = lot(key)!
      const own = (editing?.lines ?? []).filter((x) => x.truckId && x.brandId && keyOf(x.truckId, x.brandId) === key).reduce((s, x) => s + x.qty, 0)
      const left = c.left + own
      return q > left && (c.number || own === 0) ? [{ what: [c.quality, c.number].filter(Boolean).join(' · '), left: Math.max(0, left), q }] : []
    })
  })()
  const overSig = over.map((x) => `${x.what}:${x.q}`).join('|')
  const [warned, setWarned] = useState('')
  const warning = !!overSig && warned === overSig

  const title = editing ? t('Parchi #{n} badlein', { n: String(editing.slipNo ?? '') }) : t('Nayi Parchi')
  return (
    <Sheet title={title} onClose={onClose} saving={saving} error={error}
      saveLabel={warning ? `${t('Phir bhi save')} · ${rupees(total)}` : total ? `${t('Save')} · ${rupees(total)}` : t('Save')}
      onSave={() => {
        if (overSig && warned !== overSig) { setError(''); setWarned(overSig); return }
        const filled = lines.filter((l) => l.qty > 0 && lot(l.key))
        if (!filled.length) return setError(t('Quality aur box daalein'))
        if (!free && walkIn && (credit || (pay === 'split' && cash + upi < total))) return setError(t('Udhaar ke liye grahak chunein'))
        if (delivery && !address.trim() && !stand.trim()) return setError(t('Delivery ka pata daalein'))
        remember('mp.angoorLabourRate', String(rate)); remember('mp.staff', staff.trim())
        void save(editing ? `/v1/admin/shops/${shopId}/bills/${editing.id}/edit` : `/v1/admin/shops/${shopId}/entries/parchi`, {
          buyerId: buyer?.id ?? undefined, buyerName: buyer && !buyer.id ? buyer.name : undefined,
          lots: filled.map((l) => { const c = lot(l.key)!; return { truckId: c.truckId, brandId: c.brandId, qty: l.qty, ratePaise: l.ratePaise } }),
          pay, cashPaise: cash, upiPaise: upi, upiBank: bank || undefined,
          labour: credit && labour, labourRatePaise: rate,
          delivery: delivery ? { address, stand } : undefined, staff: staff.trim() || undefined,
          slipNo: !editing && Number(slipNo) > 0 ? Number(slipNo) : undefined,
        }, (r) => (editing ? t('Parchi #{n} badli', { n: String(r.slipNo) })
          : t(!r.printing ? 'Parchi #{n} save hui' : r.printOnline === false ? 'Parchi #{n} save hui · print machine band hai, chalu hote hi chhapegi' : 'Parchi #{n} save hui · machine par chhapegi', { n: String(r.slipNo) })))
      }}>
      {draft?.notes.length ? <p className="muted">{draft.notes.join(' · ')}</p> : null}
      <Field label={t('Grahak')}><BuyerPicker shopId={shopId} value={buyer} onChange={pickBuyer} walkIn autoFocus={!draft} /></Field>

      <div className="fld">
        <span className="fld-lb">{t('Quality')}</span>
        {choices.length === 0 ? <p className="muted">{t('Koi khuli gaadi nahi — pehle Nayi Gaadi jodein')}</p> : (
          <div className="lines-in">
            {lines.map((l, i) => (
              <div key={i} className="line-in wide-pick">
                <select className="field" value={l.key} aria-label={t('Quality')} onChange={(e) => set(i, { key: e.target.value })}>
                  {choices.map((c) => <option key={keyOf(c.truckId, c.brandId)} value={keyOf(c.truckId, c.brandId)}>{label(c)}</option>)}
                </select>
                <input className="field" inputMode="numeric" placeholder={t('Box')} aria-label={t('Box')} value={l.qty || ''}
                  onChange={(e) => set(i, { qty: Number(e.target.value.replace(/\D/g, '') || 0) })} />
                <Money value={free ? 0 : l.ratePaise} onChange={(v) => set(i, { ratePaise: v })} placeholder={t('Bhav')} />
                <span className="money line-amt">{rupees(free ? 0 : l.qty * l.ratePaise)}</span>
                {lines.length > 1 ? <button type="button" className="icon-btn" aria-label={t('Hatayein')} onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button> : <span className="icon-gap" />}
              </div>
            ))}
            {lines.length < 12 && <button type="button" className="btn ghost" style={{ justifySelf: 'start' }}
              onClick={() => setLines([...lines, { key: lines[lines.length - 1]?.key ?? '', qty: 0, ratePaise: 0 }])}>+ {t('Aur quality')}</button>}
          </div>
        )}
      </div>

      <Field label={t('Payment')}>
        <Seg value={pay} onChange={setPay} options={[{ key: 'cash', label: t('Cash') }, { key: 'upi', label: 'UPI' }, { key: 'credit', label: t('Udhaar') }, { key: 'split', label: t('Kuch') }, { key: 'after', label: t('Baad mein') }, { key: 'free', label: t('Free') }]} />
      </Field>
      {credit && (
        <div className="box">
          <Tick label={t('Mazdoori jodein')} on={labour} onChange={setLabour}>
            {labour && (
              <div className="inline-in">
                <span className="muted">{t('{n} box', { n: count(boxes) })} ×</span>
                <span className="short"><Money value={rate} onChange={setRate} /></span>
                <b className="money">= {rupees(boxes * rate)}</b>
              </div>
            )}
          </Tick>
        </div>
      )}
      {pay === 'split' && (
        <div className="row2">
          <Field label={t('Cash')}><Money value={cash} onChange={setCash} /></Field>
          <Field label="UPI"><Money value={upi} onChange={setUpi} /></Field>
        </div>
      )}
      {(pay === 'upi' || (pay === 'split' && upi > 0)) && o.banks.length > 0 && (
        <Field label={t('Kis bank mein')}><select className="field" value={bank} onChange={(e) => setBank(e.target.value)}>{o.banks.map((b) => <option key={b}>{b}</option>)}</select></Field>
      )}
      <div className="box">
        <Tick label={t('Delivery')} on={delivery} onChange={setDelivery} />
        {delivery && (
          <div className="row2">
            <Field label={t('Pata')}><input className="field" value={address} maxLength={200} onChange={(e) => setAddress(e.target.value)} /></Field>
            <Field label={t('Stand')}><input className="field" value={stand} maxLength={120} onChange={(e) => setStand(e.target.value)} /></Field>
          </div>
        )}
      </div>
      <div className="row2">
        <Field label={t('Accountant')}><input className="field" value={staff} maxLength={60} placeholder="Website" onChange={(e) => setStaff(e.target.value)} /></Field>
        <Field label={t('Parchi no.')}><input className="field" inputMode="numeric" value={slipNo} placeholder={t('Agla')} disabled={!!editing} onChange={(e) => setSlipNo(e.target.value.replace(/\D/g, '').slice(0, 7))} /></Field>
      </div>
      {warning && (
        <div className="overbook" role="alert">
          <b>{t('Gaadi mein itne box nahi')}</b>
          {over.map((x) => <div key={x.what}>{t('{what}: {left} box baaki, {q} likhe ({n} zyada)', { what: x.what, left: count(x.left), q: count(x.q), n: count(x.q - x.left) })}</div>)}
          <small>{t('Phir bhi save karna hai to dobara Save dabaiye')}</small>
        </div>
      )}
      {apmc > 0 && <div className="total-line"><span>APMC 1%</span><b className="money">{rupees(apmc)}</b></div>}
      <div className="total-line"><span>{t('{n} box', { n: count(boxes) })}</span><b className="money">{free ? t('Free') : rupees(total)}</b>
        {pay === 'split' && total > cash + upi && <span className="due">{t('Udhaar')} {rupees(total - cash - upi)}</span>}</div>
    </Sheet>
  )
}

type GLot = { quality: string; qty: number; kg: string; ratePaise: number; fixed?: boolean }

/**
 * Angoor's Nayi Gaadi, vehicle first as the shop says it: number, bhada, whose maal, where it
 * stands, then each quality with its boxes, box kg and our own bhav. It opens on the newest
 * arrival's supplier, and picking a known supplier fills his place and qualities.
 */
export function AngoorGaadiForm({ shopId, o, editing, onClose, onDone }: {
  shopId: string; o: AngoorOptions; editing?: EditGaadi; onClose: () => void; onDone: (msg: string) => void
}) {
  const { saving, error, setError, save } = useSave(onDone)
  const from = (sup: string) => o.lastArrivals?.find((a) => a.supplier.trim().toLowerCase() === sup.trim().toLowerCase())
  const fill = (a: NonNullable<AngoorOptions['lastArrivals']>[number] | undefined): GLot[] =>
    a?.lots.length ? a.lots.map((l) => ({ quality: l.quality, qty: 0, kg: l.boxGrams ? String(l.boxGrams / 1000) : '10', ratePaise: l.ratePaise }))
      : [{ quality: '', qty: 0, kg: '10', ratePaise: 0 }]
  const first = editing ? undefined : o.lastArrivals?.[0]
  const [number, setNumber] = useState(editing?.number ?? '')
  const [freight, setFreight] = useState(editing?.freightPaise ?? 0)
  const [supplier, setSupplier] = useState(editing?.supplier ?? first?.supplier ?? '')
  const [location, setLocation] = useState(editing?.location ?? first?.location ?? '')
  // An existing quality keeps its kg and bhav (they are on the lots already sold); only its boxes change.
  const [lots, setLots] = useState<GLot[]>(() => editing
    ? editing.qualities.map((q) => ({ quality: q.name, qty: q.received, kg: String(q.kg || ''), ratePaise: q.ratePaise, fixed: true }))
    : fill(first))
  const set = (i: number, patch: Partial<GLot>) => setLots(lots.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const pickSupplier = (v: string) => {
    setSupplier(v)
    const a = from(v)
    // His last gaadi fills the rest, unless boxes are already typed.
    if (!editing && a && lots.every((l) => !l.qty)) { setLocation(a.location); setLots(fill(a)) }
  }
  const brandId = (name: string) => o.brands.find((b) => b.name.trim().toLowerCase() === name.trim().toLowerCase())?.id
  const boxes = lots.reduce((s, l) => s + l.qty, 0)

  return (
    <Sheet title={editing ? t('Gaadi {n} badlein', { n: editing.number }) : t('Nayi Gaadi')} onClose={onClose} saving={saving} error={error}
      onSave={() => {
        if (!number.trim()) return setError(t('Gaadi number daalein'))
        if (!supplier.trim()) return setError(t('Supplier ka naam daalein'))
        if (editing) {
          if (lots.some((l) => !l.fixed && l.qty > 0 && !l.quality.trim())) return setError(t('Har box ki quality likhein'))
          return void save(`/v1/admin/shops/${shopId}/gaadi/${editing.truckId}`, {
            number, supplier, location, freightPaise: freight,
            lots: lots.filter((l) => l.fixed || l.qty > 0).map((l) => {
              const id = editing.qualities.find((q) => q.name === l.quality && l.fixed)?.brandId ?? brandId(l.quality)
              return { brandId: id ?? undefined, brandName: id ? undefined : l.quality.trim(), grade: '1', qty: l.qty, ratePaise: l.ratePaise,
                boxGrams: Math.max(0, Math.round((Number(l.kg) || 0) * 1000)) }
            }),
          }, () => t('Gaadi {n} badli', { n: number.toUpperCase().replace(/\s+/g, '') }))
        }
        const filled = lots.filter((l) => l.qty > 0)
        if (!filled.length) return setError(t('Quality aur box daalein'))
        if (filled.some((l) => !l.quality.trim())) return setError(t('Har box ki quality likhein'))
        void save(`/v1/admin/shops/${shopId}/entries/gaadi`, {
          number, supplier, location, freightPaise: freight,
          lots: filled.map((l) => {
            const id = brandId(l.quality)
            return { brandId: id, brandName: id ? undefined : l.quality.trim(), grade: '1', qty: l.qty, ratePaise: l.ratePaise,
              boxGrams: Math.max(0, Math.round((Number(l.kg) || 0) * 1000)) }
          }),
        }, () => t('Gaadi {n} jud gayi', { n: number.toUpperCase().replace(/\s+/g, '') }))
      }}>
      <div className="row2">
        <Field label={t('Gaadi number')}><input className="field" value={number} autoFocus onChange={(e) => setNumber(e.target.value.toUpperCase())} /></Field>
        <Field label={t('Bhada')}><Money value={freight} onChange={setFreight} /></Field>
      </div>
      <div className="row2">
        <Field label={t('Supplier')}>
          <input className="field" list="angoor-sup" value={supplier} onChange={(e) => pickSupplier(e.target.value)} />
          <datalist id="angoor-sup">{o.suppliers.map((s) => <option key={s} value={s} />)}</datalist>
        </Field>
        <Field label={t('Address')}><input className="field" value={location} maxLength={80} onChange={(e) => setLocation(e.target.value)} /></Field>
      </div>
      <div className="fld">
        <span className="fld-lb">{t('Quality')}</span>
        <div className="lines-in">
          {lots.map((l, i) => (
            <div key={i} className="line-in wide-pick gaadi-q">
              <input className="field" list="angoor-q" placeholder={t('Quality')} aria-label={t('Quality')} value={l.quality} disabled={l.fixed} onChange={(e) => set(i, { quality: e.target.value })} />
              <input className="field" inputMode="numeric" placeholder={t('Box')} aria-label={t('Box')} value={l.qty || ''} onChange={(e) => set(i, { qty: Number(e.target.value.replace(/\D/g, '') || 0) })} />
              <input className="field short" inputMode="decimal" placeholder="Kg" aria-label="Kg" value={l.kg} disabled={l.fixed} onChange={(e) => set(i, { kg: e.target.value.replace(/[^\d.]/g, '').slice(0, 5) })} />
              {l.fixed ? <span className="money muted">{l.ratePaise ? rupees(l.ratePaise) : ''}</span> : <Money value={l.ratePaise} onChange={(v) => set(i, { ratePaise: v })} placeholder={t('Apna bhav')} />}
              {lots.length > 1 && !l.fixed ? <button type="button" className="icon-btn" aria-label={t('Hatayein')} onClick={() => setLots(lots.filter((_, j) => j !== i))}>✕</button> : <span className="icon-gap" />}
            </div>
          ))}
          <datalist id="angoor-q">{o.brands.map((b) => <option key={b.id} value={b.name} />)}</datalist>
          {lots.length < 12 && <button type="button" className="btn ghost" style={{ justifySelf: 'start' }} onClick={() => setLots([...lots, { quality: '', qty: 0, kg: '10', ratePaise: 0 }])}>+ {t('Aur quality')}</button>}
        </div>
      </div>
      <div className="total-line"><span>{t('{n} box', { n: count(boxes) })}</span><b className="money">{freight ? rupees(freight) : ''}</b></div>
    </Sheet>
  )
}
