import { useEffect, useState } from 'react'
import { api } from '../api'
import { rupees, count } from '../format'
import { t } from '../i18n'
import { booksChanged } from '../useLoad'
import { BuyerPicker, Chips, Field, isWalkInName, Money, Seg, Sheet, Tick, type PickedBuyer } from './fields'
import type { EditBill, EditRaseed, EntryKind, Editing, VoiceDraft } from './kinds'

type Options = {
  commodity: string
  trucks: { id: string; number: string; supplier: string; arrivedAt: string; left: number; brandId: string | null; brand: string }[]
  rates: { brandId: string; grade: string; ratePaise: number }[]
  brands: { id: string; name: string }[]
  suppliers: string[]
  banks: string[]
}

/** Saves an entry, tells every report to read again, and says what was saved. */
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

function useOptions(shopId: string) {
  const [o, setO] = useState<Options | null>(null)
  useEffect(() => { api<Options>(`/v1/admin/shops/${shopId}/entry-options`).then(setO).catch(() => {}) }, [shopId])
  return o
}

export function EntryForm({ kind, shopId, editing, draft, onClose, onSaved }: {
  kind: EntryKind; shopId: string; editing?: Editing | null; draft?: VoiceDraft | null; onClose: () => void; onSaved: (msg: string) => void
}) {
  const done = (m: string) => { onSaved(m); onClose() }
  switch (kind) {
    case 'parchi': return <ParchiForm shopId={shopId} onClose={onClose} onDone={done} editing={editing?.kind === 'parchi' ? editing.bill : undefined} draft={draft?.kind === 'parchi' ? draft : undefined} />
    case 'vasooli': return <VasooliForm shopId={shopId} onClose={onClose} onDone={done} editing={editing?.kind === 'vasooli' ? editing.raseed : undefined} draft={draft?.kind === 'vasooli' ? draft : undefined} />
    case 'kharcha': return <KharchaForm shopId={shopId} onClose={onClose} onDone={done} draft={draft?.kind === 'kharcha' ? draft : undefined} />
    case 'supplier': return <SupplierForm shopId={shopId} onClose={onClose} onDone={done} />
    case 'gaadi': return <GaadiForm shopId={shopId} onClose={onClose} onDone={done} />
    case 'grahak': return <GrahakForm shopId={shopId} onClose={onClose} onDone={done} />
    default: return <UdhaarForm shopId={shopId} onClose={onClose} onDone={done} />
  }
}

type FormProps = { shopId: string; onClose: () => void; onDone: (msg: string) => void }
type Draft<K extends VoiceDraft['kind']> = Extract<VoiceDraft, { kind: K }>

/** Only when the voice draft needs a look (a grahak not on the list). */
const Notes = ({ notes }: { notes?: string[] }) => (notes?.length ? <p className="muted voice-note">{notes.join(' · ')}</p> : null)

// ---------------------------------------------------------------- Nayi parchi

const GRADES = [{ key: '1', label: '1st' }, { key: '2', label: '2nd' }, { key: '3', label: '3rd' }, { key: 'mix', label: t('Mix') }] as const
type Line = { grade: '1' | '2' | '3' | 'mix'; qty: number; ratePaise: number }
/** As the app's Packing: which katta (kept as its bag name), and what one holds. */
const KATTA_NAMES = ['Green', 'Jaipur', 'White'] as const
const KATTA_SIZES = [{ key: 'katta10', per: 10 }, { key: 'katta15', per: 15 }, { key: 'katta20', per: 20 }] as const
/** katta25 is only ever met on an older slip being altered. */
type KattaSize = (typeof KATTA_SIZES)[number]['key'] | 'katta25'
const perKatta = (size: KattaSize) => Number(size.slice(5))
const PANNI_NAMES = ['Nariyal Pani', 'Jai Ho', 'AB', 'Organic'] as const
type Pay = 'cash' | 'upi' | 'credit' | 'split' | 'after' | 'free'

/** What this browser remembers between parchis: the accountant's name and the mazdoori rate. */
const remembered = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback } catch { return fallback } }
const remember = (key: string, v: string) => { try { localStorage.setItem(key, v) } catch { /* private window */ } }

/** The parchune's word on panni_name, and the one older slips carry. */
const PARCHUNE_TAGS = ['Parchune', 'Panchuri']

/**
 * A slip as ParchiScreen opens it to alter: one line per grade and bhav, the packing taken back
 * apart from panni_name, the payment as it was picked, the mazdoori count and rate.
 */
function fromBill(b: EditBill) {
  const lines: Line[] = []
  for (const l of b.lines.filter((x) => !x.leak)) {
    const same = lines.find((x) => x.grade === l.grade && x.ratePaise === l.ratePaise)
    if (same) same.qty += l.qty
    else lines.push({ grade: l.grade as Line['grade'], qty: l.qty, ratePaise: l.ratePaise })
  }
  const packing = b.packing.startsWith('katta') ? 'katta' as const : b.packing === 'panni' ? 'panni' as const : 'loose' as const
  let panni = packing === 'katta' ? '' : b.panniName
  const tag = PARCHUNE_TAGS.find((x) => panni === x || panni.endsWith(` + ${x}`))
  if (tag) panni = panni.slice(0, -tag.length).replace(/ \+ $/, '').trim()
  const pay: Pay = b.payMode === 'free' ? 'free' : b.payMode === 'after' ? 'after'
    : b.totalPaise === 0 ? (b.payMode === 'credit' ? 'credit' : b.payMode === 'upi' ? 'upi' : 'cash')
    : b.paidPaise === 0 ? 'credit' : b.cashPaise === b.totalPaise ? 'cash' : b.upiPaise === b.totalPaise ? 'upi' : 'split'
  // A walk-in comes back as the counter's Cash or Bank.
  const buyer: PickedBuyer = b.buyerId ? { id: b.buyerId, name: b.buyerName }
    : { id: null, name: isWalkInName(b.buyerName) ? b.buyerName : b.upiPaise > 0 && b.cashPaise === 0 ? 'Bank' : 'Cash' }
  return {
    buyer, lines: lines.length ? lines : [{ grade: '1' as const, qty: 0, ratePaise: 0 }], pay, packing, panni,
    size: (packing === 'katta' ? b.packing : 'katta10') as KattaSize, kattaName: packing === 'katta' ? b.panniName : '', parchune: !!tag,
    // A count that was just the slip's dana follows the dana when it is changed; only a hand-corrected one stays.
    labour: b.labourPaise > 0, labourQty: b.labourPaise > 0 && b.packs > 0 && b.packs !== b.lines.reduce((s, l) => s + l.qty, 0) ? String(b.packs) : '',
    rate: b.labourPaise > 0 && b.packs > 0 ? Math.round(b.labourPaise / b.packs) : null,
  }
}

function ParchiForm({ shopId, onClose, onDone, editing, draft }: FormProps & { editing?: EditBill; draft?: Draft<'parchi'> }) {
  const o = useOptions(shopId)
  const { saving, error, setError, save } = useSave(onDone)
  const [was] = useState(() => (editing ? fromBill(editing) : draft ? fromDraft(draft) : null))
  const [buyer, setBuyer] = useState<PickedBuyer | null>(was?.buyer ?? null)
  const [truckId, setTruckId] = useState(editing?.truckId ?? draft?.truckId ?? '')
  const [lines, setLines] = useState<Line[]>(was?.lines ?? [{ grade: '1', qty: 0, ratePaise: 0 }])
  const [pay, setPay] = useState<Pay>(was?.pay ?? 'cash')
  const [cash, setCash] = useState(editing && was?.pay === 'split' ? editing.cashPaise : draft?.cashPaise ?? 0)
  const [upi, setUpi] = useState(editing && was?.pay === 'split' ? editing.upiPaise : draft?.upiPaise ?? 0)
  const [bank, setBank] = useState(editing?.upiBank ?? '')
  const [pack, setPack] = useState<'loose' | 'katta' | 'panni'>(was?.packing ?? 'loose')
  const [size, setSize] = useState<KattaSize>(was?.size ?? 'katta10')
  const [kattaName, setKattaName] = useState(was?.kattaName ?? '')
  const [kattas, setKattas] = useState(draft?.kattas ? String(draft.kattas) : '')
  const [panniName, setPanniName] = useState(was?.panni ?? '')
  const [parchune, setParchune] = useState(was?.parchune ?? false)
  const [labour, setLabour] = useState(was?.labour ?? false)
  const [labourQty, setLabourQty] = useState(was?.labourQty ?? '')
  const [rate, setRate] = useState(() => was?.rate ?? (Number(remembered('mp.labourRate', '30')) || 30))
  const [delivery, setDelivery] = useState(!!editing?.delivery || !!draft?.delivery)
  const [address, setAddress] = useState(editing?.delivery?.address ?? '')
  const [stand, setStand] = useState(editing?.delivery?.stand ?? '')
  const [staff, setStaff] = useState(() => editing ? (editing.staff === 'Website' ? '' : editing.staff) : remembered('mp.staff', ''))
  const [slipNo, setSlipNo] = useState(editing?.slipNo ? String(editing.slipNo) : '')

  // Altering: the slip's own gaadi stays on offer (even closed or sold out), and the dana it took come back.
  const trucks = !o ? [] : !editing?.truckId ? o.trucks : (() => {
    const own = editing.lines.reduce((s, l) => s + l.qty, 0)
    const listed = o.trucks.some((tr) => tr.id === editing.truckId)
    return listed ? o.trucks.map((tr) => (tr.id === editing.truckId ? { ...tr, left: tr.left + own } : tr))
      : [{ id: editing.truckId, number: editing.truck ?? '—', supplier: '', arrivedAt: '', left: own, brandId: null, brand: '' }, ...o.trucks]
  })()
  const truck = trucks.find((t) => t.id === truckId) ?? trucks[0]
  useEffect(() => { if (trucks[0] && !truckId) setTruckId(trucks[0].id) }, [o, truckId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (o?.banks[0] && !editing?.upiBank) setBank(o.banks[0]) }, [o]) // eslint-disable-line react-hooks/exhaustive-deps
  // Today's bhav for this gaadi's maal fills in a line's rate until it is typed.
  const bhav = (grade: string) => o?.rates.find((r) => r.brandId === truck?.brandId && r.grade === grade)?.ratePaise ?? 0
  // (Not on a slip being altered: a line written without bhav stays as written until typed.)
  useEffect(() => { if (!editing) setLines((ls) => ls.map((l) => (l.ratePaise ? l : { ...l, ratePaise: bhav(l.grade) }))) }, [truck?.id, o]) // eslint-disable-line react-hooks/exhaustive-deps

  const free = pay === 'free'
  const qty = lines.reduce((s, l) => s + l.qty, 0)
  const total = free ? 0 : lines.reduce((s, l) => s + l.qty * l.ratePaise, 0)
  const walkIn = !buyer || (buyer.id === null && isWalkInName(buyer.name))
  const per = perKatta(size)
  const labourNag = labour ? (Number(labourQty) || qty) : 0
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  // "Kitne katta" × what one holds becomes the 1st-line nag, as the app's kattaRow.
  const fillKattas = (count: string, p = per) => {
    setKattas(count)
    const k = Number(count) || 0
    if (k > 0) setLines((ls) => ls.map((l, i) => (i === 0 ? { ...l, qty: k * p } : l)))
  }
  const choosePack = (p: typeof pack) => {
    if (p === pack) return
    setPack(p)
    // Tied goods are charged as a matter of course; a loose parchune carries none.
    setLabour(p !== 'loose'); setLabourQty(''); setKattas('')
    if (p !== 'panni') setPanniName('')
    if (p === 'katta') setParchune(false)
    if (p !== 'katta') setKattaName('')
  }
  const pickBuyer = (b: PickedBuyer | null) => {
    setBuyer(b)
    if (b?.id === null && b.name === 'Cash') setPay('cash')
    else if (b?.id === null && b.name === 'Bank') setPay('upi')
    else if (b?.id && pay === 'cash') setPay('credit')
    if (b?.id) { setAddress(b.address ?? ''); setStand(b.destination ?? '') }
  }

  const title = editing ? t('Parchi #{n} badlein', { n: String(editing.slipNo ?? '') }) : t('Nayi Parchi')
  if (o && o.commodity === 'amrud') return <Sheet title={title} onClose={onClose} onSave={onClose} saving={false} error="" saveLabel={t('Theek hai')}><p className="muted">{t('Amrud ki parchi app se banayein.')}</p></Sheet>
  return (
    <Sheet title={title} onClose={onClose} saving={saving} error={error} saveLabel={total ? `${t('Save')} · ${rupees(total)}` : t('Save')}
      onSave={() => {
        if (!truck) return setError(t('Koi khuli gaadi nahi'))
        if (!qty) return setError(t('Nag daalein'))
        if (!free && walkIn && (pay === 'credit' || pay === 'after' || (pay === 'split' && cash + upi < total))) return setError(t('Udhaar ke liye grahak chunein'))
        if (delivery && !address.trim() && !stand.trim()) return setError(t('Delivery ka pata daalein'))
        remember('mp.labourRate', String(rate)); remember('mp.staff', staff.trim())
        void save(editing ? `/v1/admin/shops/${shopId}/bills/${editing.id}/edit` : `/v1/admin/shops/${shopId}/entries/parchi`, {
          buyerId: buyer?.id ?? undefined, buyerName: buyer && !buyer.id ? buyer.name : undefined, truckId: truck.id,
          lines: lines.filter((l) => l.qty > 0), pay, cashPaise: cash, upiPaise: upi, upiBank: bank || undefined,
          packing: pack === 'katta' ? size : pack, kattaName: pack === 'katta' ? kattaName : undefined,
          panniName: pack === 'panni' ? panniName : undefined, parchune: pack !== 'katta' && parchune,
          labour, labourQty: labour ? labourNag : 0, labourRatePaise: rate,
          delivery: delivery ? { address, stand } : undefined, staff: staff.trim() || undefined,
          slipNo: !editing && Number(slipNo) > 0 ? Number(slipNo) : undefined,
        }, (r) => (editing ? t('Parchi #{n} badli', { n: String(r.slipNo) })
          : t(r.printing ? 'Parchi #{n} save hui · machine par chhapegi' : 'Parchi #{n} save hui', { n: String(r.slipNo) })))
      }}>
      <Notes notes={draft?.notes} />
      <Field label={t('Grahak')}><BuyerPicker shopId={shopId} value={buyer} onChange={pickBuyer} walkIn autoFocus={!draft} /></Field>
      <Field label={t('Gaadi')}>
        {!o ? <div className="sk" /> : trucks.length === 0 ? <p className="muted">{t('Koi khuli gaadi nahi — pehle Nayi Gaadi jodein')}</p> : (
          <select className="field" value={truck?.id} onChange={(e) => setTruckId(e.target.value)}>
            {trucks.map((tr) => <option key={tr.id} value={tr.id}>{tr.number} · {tr.brand} · {t('{n} nag baaki', { n: count(tr.left) })}</option>)}
          </select>
        )}
      </Field>

      <div className="fld">
        <span className="fld-lb">{t('Packing')}</span>
        <div className="box">
          <Seg value={pack} onChange={choosePack} options={[{ key: 'loose', label: t('Loose') }, { key: 'katta', label: t('Katta') }, { key: 'panni', label: t('Panni') }]} />
          {pack === 'katta' && (
            <>
              <span className="fld-lb">{t('Kaunsa katta')}</span>
              <Chips value={kattaName} onChange={setKattaName} clearable options={KATTA_NAMES.map((k) => ({ key: k, label: k }))} />
              <span className="fld-lb">{t('Ek katte mein dana')}</span>
              <Chips value={size} onChange={(v) => { if (!v) return; setSize(v); if (Number(kattas) > 0) fillKattas(kattas, perKatta(v)) }}
                options={KATTA_SIZES.map((k) => ({ key: k.key, label: String(k.per) }))} />
              <div className="inline-in">
                <span className="fld-lb">{t('Kitne katta')}</span>
                <input className="field short" inputMode="numeric" placeholder={qty ? String(Math.ceil(qty / per)) : '0'} value={kattas}
                  onChange={(e) => fillKattas(e.target.value.replace(/\D/g, '').slice(0, 5))} />
                <b className="money">× {per}{Number(kattas) > 0 ? ` = ${t('{n} nag', { n: count(Number(kattas) * per) })}` : ''}</b>
              </div>
            </>
          )}
          {pack === 'panni' && (
            <>
              <span className="fld-lb">{t('Kaunsi panni')}</span>
              <Chips value={panniName} onChange={setPanniName} clearable options={PANNI_NAMES.map((k) => ({ key: k, label: k }))} />
            </>
          )}
          {pack !== 'katta' && <Tick label={t('Parchune')} on={parchune} onChange={(v) => { setParchune(v); if (v && pack === 'loose') setLabour(false) }} />}
        </div>
      </div>

      <div className="fld">
        <span className="fld-lb">{t('Maal')}</span>
        <div className="lines-in">
          {lines.map((l, i) => (
            <div key={i} className="line-in">
              <select className="field" value={l.grade} aria-label={t('Grade')} onChange={(e) => set(i, { grade: e.target.value as Line['grade'], ratePaise: l.ratePaise || bhav(e.target.value) })}>
                {GRADES.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
              </select>
              <input className="field" inputMode="numeric" placeholder={t('Nag')} aria-label={t('Nag')} value={l.qty || ''} onChange={(e) => { if (i === 0) setKattas(''); set(i, { qty: Number(e.target.value.replace(/\D/g, '') || 0) }) }} />
              <Money value={free ? 0 : l.ratePaise} onChange={(v) => set(i, { ratePaise: v })} placeholder={t('Bhav')} />
              <span className="money line-amt">{rupees(free ? 0 : l.qty * l.ratePaise)}</span>
              {lines.length > 1 ? <button type="button" className="icon-btn" aria-label={t('Hatayein')} onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button> : <span className="icon-gap" />}
            </div>
          ))}
          {lines.length < 4 && <button type="button" className="btn ghost" style={{ justifySelf: 'start' }} onClick={() => setLines([...lines, { grade: '2', qty: 0, ratePaise: bhav('2') }])}>+ {t('Aur grade')}</button>}
        </div>
      </div>

      <div className="box">
        <Tick label={t('Mazdoori jodein')} on={labour} onChange={setLabour}>
          {labour && (
            <div className="inline-in">
              <input className="field short" inputMode="numeric" aria-label={t('Kitne dana')} placeholder={String(qty || 0)} value={labourQty}
                onChange={(e) => setLabourQty(e.target.value.replace(/\D/g, '').slice(0, 5))} />
              <span className="muted">{t('dana')} ×</span>
              <span className="short"><Money value={rate} onChange={setRate} /></span>
              <b className="money">= {rupees(labourNag * rate)}</b>
            </div>
          )}
        </Tick>
        <Tick label={t('Delivery')} on={delivery} onChange={setDelivery} />
        {delivery && (
          <div className="row2">
            <Field label={t('Pata')}><input className="field" value={address} maxLength={200} onChange={(e) => setAddress(e.target.value)} /></Field>
            <Field label={t('Stand')}><input className="field" value={stand} maxLength={120} onChange={(e) => setStand(e.target.value)} /></Field>
          </div>
        )}
      </div>

      <Field label={t('Payment')}>
        <Seg value={pay} onChange={setPay} options={[{ key: 'cash', label: t('Cash') }, { key: 'upi', label: 'UPI' }, { key: 'credit', label: t('Udhaar') }, { key: 'split', label: t('Kuch') }, { key: 'after', label: t('Baad mein') }, { key: 'free', label: t('Free') }]} />
      </Field>
      {pay === 'split' && (
        <div className="row2">
          <Field label={t('Cash')}><Money value={cash} onChange={setCash} /></Field>
          <Field label="UPI"><Money value={upi} onChange={setUpi} /></Field>
        </div>
      )}
      {(pay === 'upi' || (pay === 'split' && upi > 0)) && o && o.banks.length > 0 && (
        <Field label={t('Kis bank mein')}><select className="field" value={bank} onChange={(e) => setBank(e.target.value)}>{o.banks.map((b) => <option key={b}>{b}</option>)}</select></Field>
      )}
      <div className="row2">
        <Field label={t('Accountant')}><input className="field" value={staff} maxLength={60} placeholder="Website" onChange={(e) => setStaff(e.target.value)} /></Field>
        <Field label={t('Parchi no.')}><input className="field" inputMode="numeric" value={slipNo} placeholder={t('Agla')} disabled={!!editing} onChange={(e) => setSlipNo(e.target.value.replace(/\D/g, '').slice(0, 7))} /></Field>
      </div>
      <div className="total-line"><span>{t('{n} nag', { n: count(qty) })}{pack === 'katta' && qty ? ` · ${t('{n} katta', { n: count(Math.ceil(qty / per)) })}` : ''}</span><b className="money">{free ? t('Free') : rupees(total)}</b>
        {pay === 'split' && total > cash + upi && <span className="due">{t('Udhaar')} {rupees(total - cash - upi)}</span>}</div>
    </Sheet>
  )
}

// ---------------------------------------------------------------- Vasooli

/** Vasooli; altering a raseed keeps its grahak, number and time — only the money changes (CollectScreen's Badlein). */
function VasooliForm({ shopId, onClose, onDone, editing, draft }: FormProps & { editing?: EditRaseed; draft?: Draft<'vasooli'> }) {
  const o = useOptions(shopId)
  const { saving, error, setError, save } = useSave(onDone)
  const [buyer, setBuyer] = useState<PickedBuyer | null>(editing ? { id: editing.buyerId, name: editing.buyerName } : draft?.buyer?.id ? draft.buyer : null)
  const [cash, setCash] = useState(editing?.cashPaise ?? draft?.cashPaise ?? 0)
  const [upi, setUpi] = useState(editing?.upiPaise ?? draft?.upiPaise ?? 0)
  const [bank, setBank] = useState(editing?.upiBank ?? '')
  const [ref, setRef] = useState(editing?.ref ?? '')
  useEffect(() => { if (o?.banks[0] && !editing?.upiBank) setBank(o.banks[0]) }, [o]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Sheet title={editing ? t('Raseed #{n} badlein', { n: String(editing.receiptNo ?? '') }) : t('Vasooli')} onClose={onClose} saving={saving} error={error} saveLabel={cash + upi ? `${t('Save')} · ${rupees(cash + upi)}` : t('Save')}
      onSave={() => {
        if (!buyer?.id) return setError(t('Grahak chunein'))
        if (cash + upi <= 0) return setError(t('Rakam daalein'))
        if (editing) return void save(`/v1/admin/shops/${shopId}/collections/${editing.id}/edit`, { cashPaise: cash, upiPaise: upi, upiBank: bank || undefined, paymentRef: ref || undefined },
          (r) => t('Raseed #{n} badli', { n: String(r.receiptNo) }))
        void save(`/v1/admin/shops/${shopId}/entries/vasooli`, { buyerId: buyer.id, cashPaise: cash, upiPaise: upi, upiBank: bank || undefined, paymentRef: ref || undefined },
          (r) => t('Raseed #{n} save hui', { n: String(r.receiptNo) }))
      }}>
      <Notes notes={draft?.notes} />
      <Field label={t('Grahak')}>{editing ? <b>{editing.buyerName}</b> : <BuyerPicker shopId={shopId} value={buyer} onChange={setBuyer} autoFocus={!draft} />}</Field>
      <div className="row2">
        <Field label={t('Cash')}><Money value={cash} onChange={setCash} autoFocus={!!editing} /></Field>
        <Field label="UPI"><Money value={upi} onChange={setUpi} /></Field>
      </div>
      {upi > 0 && (
        <div className="row2">
          {o && o.banks.length > 0 && <Field label={t('Kis bank mein')}><select className="field" value={bank} onChange={(e) => setBank(e.target.value)}>{o.banks.map((b) => <option key={b}>{b}</option>)}</select></Field>}
          <Field label={t('UTR (optional)')}><input className="field" value={ref} maxLength={40} onChange={(e) => setRef(e.target.value)} /></Field>
        </div>
      )}
      {!editing && buyer?.balancePaise ? <p className="muted">{t('Abhi baaki {due} · vasooli ke baad {after}', { due: rupees(buyer.balancePaise), after: rupees(buyer.balancePaise - cash - upi) })}</p> : null}
    </Sheet>
  )
}

// ---------------------------------------------------------------- Kharcha / Aaya

const OUT_HEADS = [
  ['kharcha', t('Kharcha')], ['mazdoori', t('Mazdoori')], ['bhada', t('Bhada')], ['kiraya', t('Kiraya')], ['tankhwah', t('Tankhwah')],
  ['committee_di', t('Committee di')], ['bill', t('Bijli-pani')], ['udhaar_diya', t('Udhaar diya')], ['aur_gaya', t('Aur')],
  ['handover', t('Malik ko diya')], ['float', t('Galla ko diya')], ['bank_jama', t('Bank jama')], ['bank_nikala', t('Bank se nikala')],
] as const
const IN_HEADS = [['udhaar_wapas', t('Udhaar wapas')], ['committee_mili', t('Committee mili')], ['aur_aaya', t('Aur aaya')]] as const
const BOOKS = [{ key: 'cash', label: t('Galla') }, { key: 'office', label: t('Office') }, { key: 'upi', label: t('Bank') }] as const
/** Where a transfer leaves from (the app only offers these books for each). */
const FROM: Record<string, string> = { handover: 'cash', float: 'office', bank_nikala: 'upi' }

/** A spoken parchi, in the form's own terms; anything not said keeps the form's default. */
function fromDraft(d: Draft<'parchi'>) {
  const packing = d.packing ?? 'loose'
  return {
    buyer: d.buyer as PickedBuyer | null,
    lines: d.lines.length ? d.lines : [{ grade: '1' as const, qty: 0, ratePaise: 0 }],
    pay: (d.pay ?? 'cash') as Pay, packing, panni: d.panni,
    size: (d.size ?? 'katta10') as KattaSize, kattaName: d.kattaName, parchune: d.parchune,
    // Tied goods carry mazdoori as a matter of course, as when the packing is tapped.
    labour: d.labour || packing !== 'loose', labourQty: '', rate: null,
  }
}

function KharchaForm({ shopId, onClose, onDone, draft }: FormProps & { draft?: Draft<'kharcha'> }) {
  const { saving, error, setError, save } = useSave(onDone)
  const [dir, setDir] = useState<'out' | 'in'>(draft?.dir ?? 'out')
  const [cat, setCat] = useState(draft?.dir === 'in' ? 'aur_aaya' : 'kharcha')
  const [mode, setMode] = useState<'cash' | 'office' | 'upi'>('cash')
  const [amount, setAmount] = useState(draft?.amountPaise ?? 0)
  const [party, setParty] = useState('')
  const [note, setNote] = useState(draft?.note ?? '')
  const heads = dir === 'out' ? OUT_HEADS : IN_HEADS
  const fixed = FROM[cat]
  return (
    <Sheet title={t('Kharcha / Aaya')} onClose={onClose} saving={saving} error={error}
      onSave={() => {
        if (amount <= 0) return setError(t('Rakam daalein'))
        if (cat.startsWith('aur_') && !note.trim()) return setError(t('Wajah likhein'))
        void save(`/v1/admin/shops/${shopId}/entries/daybook`, { direction: dir, category: cat, mode: fixed ?? mode, amountPaise: amount, party, note },
          () => t('{head} {amount} save hua', { head: heads.find((h) => h[0] === cat)?.[1] ?? '', amount: rupees(amount) }))
      }}>
      <Seg value={dir} onChange={(d) => { setDir(d); setCat(d === 'out' ? 'kharcha' : 'udhaar_wapas') }} options={[{ key: 'out', label: t('Gaya (kharcha)') }, { key: 'in', label: t('Aaya') }]} />
      <Field label={t('Kis cheez ka')}>
        <select className="field" value={cat} onChange={(e) => setCat(e.target.value)}>{heads.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </Field>
      <div className="row2">
        <Field label={t('Rakam')}><Money value={amount} onChange={setAmount} autoFocus /></Field>
        <Field label={fixed ? t('Se') : t('Kahan se')}>
          <select className="field" value={fixed ?? mode} disabled={!!fixed} onChange={(e) => setMode(e.target.value as typeof mode)}>
            {BOOKS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
          </select>
        </Field>
      </div>
      <div className="row2">
        <Field label={t('Kisko / kisse (optional)')}><input className="field" value={party} maxLength={120} onChange={(e) => setParty(e.target.value)} /></Field>
        <Field label={cat.startsWith('aur_') ? t('Wajah') : t('Note (optional)')}><input className="field" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------- Supplier payment

function SupplierForm({ shopId, onClose, onDone }: FormProps) {
  const o = useOptions(shopId)
  const { saving, error, setError, save } = useSave(onDone)
  const [supplier, setSupplier] = useState('')
  const [mode, setMode] = useState<'cash' | 'office' | 'upi'>('cash')
  const [amount, setAmount] = useState(0)
  const [note, setNote] = useState('')
  return (
    <Sheet title={t('Supplier ko diya')} onClose={onClose} saving={saving} error={error}
      onSave={() => {
        if (!supplier.trim()) return setError(t('Supplier chunein'))
        if (amount <= 0) return setError(t('Rakam daalein'))
        void save(`/v1/admin/shops/${shopId}/entries/supplier-payment`, { supplier, mode, amountPaise: amount, note }, () => t('{name} ko {amount} save hua', { name: supplier, amount: rupees(amount) }))
      }}>
      <Field label={t('Supplier')}>
        <input className="field" list="sup-list" value={supplier} autoFocus onChange={(e) => setSupplier(e.target.value)} placeholder={t('Naam')} />
        <datalist id="sup-list">{o?.suppliers.map((s) => <option key={s} value={s} />)}</datalist>
      </Field>
      <div className="row2">
        <Field label={t('Rakam')}><Money value={amount} onChange={setAmount} /></Field>
        <Field label={t('Kahan se')}><select className="field" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>{BOOKS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}</select></Field>
      </div>
      <Field label={t('Note (optional)')}><input className="field" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
    </Sheet>
  )
}

// ---------------------------------------------------------------- Nayi gaadi

type Lot = { brandId: string; brandName: string; grade: '1' | '2' | '3'; qty: number; ratePaise: number }

function GaadiForm({ shopId, onClose, onDone }: FormProps) {
  const o = useOptions(shopId)
  const { saving, error, setError, save } = useSave(onDone)
  const [number, setNumber] = useState('')
  const [supplier, setSupplier] = useState('')
  const [freight, setFreight] = useState(0)
  const [lots, setLots] = useState<Lot[]>([{ brandId: '', brandName: '', grade: '1', qty: 0, ratePaise: 0 }])
  useEffect(() => { if (o?.brands[0]) setLots((ls) => ls.map((l) => (l.brandId || l.brandName ? l : { ...l, brandId: o.brands[0].id }))) }, [o])
  const set = (i: number, patch: Partial<Lot>) => setLots(lots.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const total = lots.reduce((s, l) => s + l.qty * l.ratePaise, 0) + freight
  if (o && o.commodity === 'amrud') return <Sheet title={t('Nayi Gaadi')} onClose={onClose} onSave={onClose} saving={false} error="" saveLabel={t('Theek hai')}><p className="muted">{t('Amrud ki party app se jodein.')}</p></Sheet>
  return (
    <Sheet title={t('Nayi Gaadi')} onClose={onClose} saving={saving} error={error}
      onSave={() => {
        if (!number.trim()) return setError(t('Gaadi number daalein'))
        if (!lots.some((l) => l.qty > 0)) return setError(t('Dana daalein'))
        void save(`/v1/admin/shops/${shopId}/entries/gaadi`, {
          number, supplier, freightPaise: freight,
          lots: lots.filter((l) => l.qty > 0).map((l) => ({ brandId: l.brandId || undefined, brandName: l.brandId ? undefined : l.brandName, grade: l.grade, qty: l.qty, ratePaise: l.ratePaise })),
        }, () => t('Gaadi {n} jud gayi', { n: number.toUpperCase().replace(/\s+/g, '') }))
      }}>
      <div className="row2">
        <Field label={t('Gaadi number')}><input className="field" value={number} autoFocus onChange={(e) => setNumber(e.target.value.toUpperCase())} placeholder="RJ14AB1234" /></Field>
        <Field label={t('Supplier')}>
          <input className="field" list="gaadi-sup" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          <datalist id="gaadi-sup">{o?.suppliers.map((s) => <option key={s} value={s} />)}</datalist>
        </Field>
      </div>
      <div className="fld">
        <span className="fld-lb">{t('Maal')}</span>
        <div className="lines-in">
          {lots.map((l, i) => (
            <div key={i} className="line-in">
              <select className="field" value={l.brandId || '__new'} aria-label={t('Maal')} onChange={(e) => set(i, e.target.value === '__new' ? { brandId: '' } : { brandId: e.target.value, brandName: '' })}>
                {o?.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                <option value="__new">+ {t('Naya maal')}</option>
              </select>
              {!l.brandId && <input className="field" placeholder={t('Maal ka naam')} value={l.brandName} onChange={(e) => set(i, { brandName: e.target.value })} />}
              <input className="field" inputMode="numeric" placeholder={t('Dana')} aria-label={t('Dana')} value={l.qty || ''} onChange={(e) => set(i, { qty: Number(e.target.value.replace(/\D/g, '') || 0) })} />
              <Money value={l.ratePaise} onChange={(v) => set(i, { ratePaise: v })} placeholder={t('Kharid bhav')} />
              {lots.length > 1 && <button type="button" className="icon-btn" aria-label={t('Hatayein')} onClick={() => setLots(lots.filter((_, j) => j !== i))}>✕</button>}
            </div>
          ))}
          {lots.length < 6 && <button type="button" className="btn ghost" style={{ justifySelf: 'start' }} onClick={() => setLots([...lots, { brandId: o?.brands[0]?.id ?? '', brandName: '', grade: '1', qty: 0, ratePaise: 0 }])}>+ {t('Aur maal')}</button>}
        </div>
      </div>
      <Field label={t('Bhada (optional)')}><Money value={freight} onChange={setFreight} /></Field>
      <div className="total-line"><span>{t('{n} dana', { n: count(lots.reduce((s, l) => s + l.qty, 0)) })}</span><b className="money">{rupees(total)}</b></div>
    </Sheet>
  )
}

// ---------------------------------------------------------------- Naya grahak, udhaar

function GrahakForm({ shopId, onClose, onDone }: FormProps) {
  const { saving, error, setError, save } = useSave(onDone)
  const [f, setF] = useState({ name: '', phone: '', code: '', address: '', opening: 0 })
  return (
    <Sheet title={t('Naya Grahak')} onClose={onClose} saving={saving} error={error}
      onSave={() => {
        if (!f.name.trim()) return setError(t('Naam daalein'))
        void save(`/v1/admin/shops/${shopId}/entries/grahak`, { name: f.name, phone: f.phone, code: f.code, address: f.address, openingPaise: f.opening || undefined }, () => t('{name} ka khata khul gaya', { name: f.name }))
      }}>
      <Field label={t('Naam')}><input className="field" value={f.name} autoFocus maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <div className="row2">
        <Field label={t('Mobile')}><input className="field" inputMode="tel" value={f.phone} maxLength={10} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label={t('Code')}><input className="field" value={f.code} maxLength={20} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
      </div>
      <Field label={t('Dukaan / pata')}><input className="field" value={f.address} maxLength={200} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
      <Field label={t('Purana udhaar (optional)')}><Money value={f.opening} onChange={(v) => setF({ ...f, opening: v })} /></Field>
    </Sheet>
  )
}

function UdhaarForm({ shopId, onClose, onDone }: FormProps) {
  const { saving, error, setError, save } = useSave(onDone)
  const [buyer, setBuyer] = useState<PickedBuyer | null>(null)
  const [type, setType] = useState<'udhaar' | 'jama'>('udhaar')
  const [amount, setAmount] = useState(0)
  const [note, setNote] = useState('')
  return (
    <Sheet title={t('Udhaar / Jama')} onClose={onClose} saving={saving} error={error}
      onSave={() => {
        if (!buyer?.id) return setError(t('Grahak chunein'))
        if (amount <= 0) return setError(t('Rakam daalein'))
        void save(`/v1/admin/shops/${shopId}/entries/udhaar`, { buyerId: buyer.id, amountPaise: type === 'udhaar' ? amount : -amount, note }, () => t(type === 'udhaar' ? '{name}: {amount} udhaar save hua' : '{name}: {amount} jama save hua', { name: buyer.name, amount: rupees(amount) }))
      }}>
      <Field label={t('Grahak')}><BuyerPicker shopId={shopId} value={buyer} onChange={setBuyer} autoFocus /></Field>
      <Seg value={type} onChange={setType} options={[{ key: 'udhaar', label: t('Udhaar (lena)') }, { key: 'jama', label: t('Jama (unka paisa)') }]} />
      <div className="row2">
        <Field label={t('Rakam')}><Money value={amount} onChange={setAmount} /></Field>
        <Field label={t('Note (optional)')}><input className="field" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={type === 'udhaar' ? t('Purana udhaar') : ''} /></Field>
      </div>
    </Sheet>
  )
}
