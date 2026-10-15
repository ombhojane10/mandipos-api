import { useEffect, useState } from 'react'
import { api } from '../api'
import { rupees, count } from '../format'
import { booksChanged } from '../useLoad'
import { BuyerPicker, Field, Money, Seg, Sheet, type PickedBuyer } from './fields'
import type { EntryKind } from './kinds'

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

export function EntryForm({ kind, shopId, onClose, onSaved }: { kind: EntryKind; shopId: string; onClose: () => void; onSaved: (msg: string) => void }) {
  const done = (m: string) => { onSaved(m); onClose() }
  switch (kind) {
    case 'parchi': return <ParchiForm shopId={shopId} onClose={onClose} onDone={done} />
    case 'vasooli': return <VasooliForm shopId={shopId} onClose={onClose} onDone={done} />
    case 'kharcha': return <KharchaForm shopId={shopId} onClose={onClose} onDone={done} />
    case 'supplier': return <SupplierForm shopId={shopId} onClose={onClose} onDone={done} />
    case 'gaadi': return <GaadiForm shopId={shopId} onClose={onClose} onDone={done} />
    case 'grahak': return <GrahakForm shopId={shopId} onClose={onClose} onDone={done} />
    default: return <UdhaarForm shopId={shopId} onClose={onClose} onDone={done} />
  }
}

type FormProps = { shopId: string; onClose: () => void; onDone: (msg: string) => void }

// ---------------------------------------------------------------- Nayi parchi

const GRADES = [{ key: '1', label: '1st' }, { key: '2', label: '2nd' }, { key: '3', label: '3rd' }, { key: 'mix', label: 'Mix' }] as const
type Line = { grade: '1' | '2' | '3' | 'mix'; qty: number; ratePaise: number }

function ParchiForm({ shopId, onClose, onDone }: FormProps) {
  const o = useOptions(shopId)
  const { saving, error, setError, save } = useSave(onDone)
  const [buyer, setBuyer] = useState<PickedBuyer | null>(null)
  const [truckId, setTruckId] = useState('')
  const [lines, setLines] = useState<Line[]>([{ grade: '1', qty: 0, ratePaise: 0 }])
  const [pay, setPay] = useState<'cash' | 'upi' | 'credit' | 'split' | 'after'>('cash')
  const [cash, setCash] = useState(0)
  const [upi, setUpi] = useState(0)
  const [bank, setBank] = useState('')
  const [packing, setPacking] = useState<'loose' | 'katta10' | 'panni'>('loose')

  const truck = o?.trucks.find((t) => t.id === truckId) ?? o?.trucks[0]
  useEffect(() => { if (o?.trucks[0] && !truckId) setTruckId(o.trucks[0].id) }, [o, truckId])
  useEffect(() => { if (o?.banks[0]) setBank(o.banks[0]) }, [o])
  // Today's bhav for this gaadi's maal fills in a line's rate until it is typed.
  const bhav = (grade: string) => o?.rates.find((r) => r.brandId === truck?.brandId && r.grade === grade)?.ratePaise ?? 0
  useEffect(() => { setLines((ls) => ls.map((l) => (l.ratePaise ? l : { ...l, ratePaise: bhav(l.grade) }))) }, [truck?.id, o]) // eslint-disable-line react-hooks/exhaustive-deps

  const qty = lines.reduce((s, l) => s + l.qty, 0)
  const total = lines.reduce((s, l) => s + l.qty * l.ratePaise, 0)
  const walkIn = !buyer || (buyer.id === null && buyer.name === 'Cash')
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  if (o && o.commodity === 'amrud') return <Sheet title="Nayi Parchi" onClose={onClose} onSave={onClose} saving={false} error="" saveLabel="Theek hai"><p className="muted">Amrud ki parchi app se banayein.</p></Sheet>
  return (
    <Sheet title="Nayi Parchi" onClose={onClose} saving={saving} error={error} saveLabel={total ? `Save · ${rupees(total)}` : 'Save'}
      onSave={() => {
        if (!truck) return setError('Koi khuli gaadi nahi')
        if (!qty) return setError('Nag daalein')
        if (walkIn && (pay === 'credit' || pay === 'after' || (pay === 'split' && cash + upi < total))) return setError('Udhaar ke liye grahak chunein')
        void save(`/v1/admin/shops/${shopId}/entries/parchi`, {
          buyerId: buyer?.id ?? undefined, buyerName: buyer && !buyer.id ? buyer.name : undefined, truckId: truck.id,
          lines: lines.filter((l) => l.qty > 0), pay, cashPaise: cash, upiPaise: upi, upiBank: bank || undefined, packing,
        }, (r) => `Parchi #${r.slipNo} save hui`)
      }}>
      <Field label="Grahak"><BuyerPicker shopId={shopId} value={buyer} onChange={setBuyer} walkIn autoFocus /></Field>
      <Field label="Gaadi">
        {!o ? <div className="sk" /> : o.trucks.length === 0 ? <p className="muted">Koi khuli gaadi nahi — pehle Nayi Gaadi jodein</p> : (
          <select className="field" value={truck?.id} onChange={(e) => setTruckId(e.target.value)}>
            {o.trucks.map((t) => <option key={t.id} value={t.id}>{t.number} · {t.brand} · {count(t.left)} nag baaki</option>)}
          </select>
        )}
      </Field>
      <div className="fld">
        <span className="fld-lb">Maal</span>
        <div className="lines-in">
          {lines.map((l, i) => (
            <div key={i} className="line-in">
              <select className="field" value={l.grade} aria-label="Grade" onChange={(e) => set(i, { grade: e.target.value as Line['grade'], ratePaise: l.ratePaise || bhav(e.target.value) })}>
                {GRADES.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
              </select>
              <input className="field" inputMode="numeric" placeholder="Nag" aria-label="Nag" value={l.qty || ''} onChange={(e) => set(i, { qty: Number(e.target.value.replace(/\D/g, '') || 0) })} />
              <Money value={l.ratePaise} onChange={(v) => set(i, { ratePaise: v })} placeholder="Bhav" />
              <span className="money line-amt">{rupees(l.qty * l.ratePaise)}</span>
              {lines.length > 1 && <button type="button" className="icon-btn" aria-label="Hatayein" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>}
            </div>
          ))}
          {lines.length < 4 && <button type="button" className="btn ghost" style={{ justifySelf: 'start' }} onClick={() => setLines([...lines, { grade: '2', qty: 0, ratePaise: bhav('2') }])}>+ Aur grade</button>}
        </div>
      </div>
      <Field label="Packing"><Seg value={packing} onChange={setPacking} options={[{ key: 'loose', label: 'Loose' }, { key: 'katta10', label: 'Katta' }, { key: 'panni', label: 'Panni' }]} /></Field>
      <Field label="Payment">
        <Seg value={pay} onChange={setPay} options={[{ key: 'cash', label: 'Cash' }, { key: 'upi', label: 'UPI' }, { key: 'credit', label: 'Udhaar' }, { key: 'split', label: 'Kuch' }, { key: 'after', label: 'Baad mein' }]} />
      </Field>
      {pay === 'split' && (
        <div className="row2">
          <Field label="Cash"><Money value={cash} onChange={setCash} /></Field>
          <Field label="UPI"><Money value={upi} onChange={setUpi} /></Field>
        </div>
      )}
      {(pay === 'upi' || (pay === 'split' && upi > 0)) && o && o.banks.length > 0 && (
        <Field label="Kis bank mein"><select className="field" value={bank} onChange={(e) => setBank(e.target.value)}>{o.banks.map((b) => <option key={b}>{b}</option>)}</select></Field>
      )}
      <div className="total-line"><span>{count(qty)} nag</span><b className="money">{rupees(total)}</b>
        {pay === 'split' && total > cash + upi && <span className="due">Udhaar {rupees(total - cash - upi)}</span>}</div>
    </Sheet>
  )
}

// ---------------------------------------------------------------- Vasooli

function VasooliForm({ shopId, onClose, onDone }: FormProps) {
  const o = useOptions(shopId)
  const { saving, error, setError, save } = useSave(onDone)
  const [buyer, setBuyer] = useState<PickedBuyer | null>(null)
  const [cash, setCash] = useState(0)
  const [upi, setUpi] = useState(0)
  const [bank, setBank] = useState('')
  const [ref, setRef] = useState('')
  useEffect(() => { if (o?.banks[0]) setBank(o.banks[0]) }, [o])
  return (
    <Sheet title="Vasooli" onClose={onClose} saving={saving} error={error} saveLabel={cash + upi ? `Save · ${rupees(cash + upi)}` : 'Save'}
      onSave={() => {
        if (!buyer?.id) return setError('Grahak chunein')
        if (cash + upi <= 0) return setError('Rakam daalein')
        void save(`/v1/admin/shops/${shopId}/entries/vasooli`, { buyerId: buyer.id, cashPaise: cash, upiPaise: upi, upiBank: bank || undefined, paymentRef: ref || undefined },
          (r) => `Raseed #${r.receiptNo} save hui`)
      }}>
      <Field label="Grahak"><BuyerPicker shopId={shopId} value={buyer} onChange={setBuyer} autoFocus /></Field>
      <div className="row2">
        <Field label="Cash"><Money value={cash} onChange={setCash} /></Field>
        <Field label="UPI"><Money value={upi} onChange={setUpi} /></Field>
      </div>
      {upi > 0 && (
        <div className="row2">
          {o && o.banks.length > 0 && <Field label="Kis bank mein"><select className="field" value={bank} onChange={(e) => setBank(e.target.value)}>{o.banks.map((b) => <option key={b}>{b}</option>)}</select></Field>}
          <Field label="UTR (optional)"><input className="field" value={ref} maxLength={40} onChange={(e) => setRef(e.target.value)} /></Field>
        </div>
      )}
      {buyer?.balancePaise ? <p className="muted">Abhi baaki {rupees(buyer.balancePaise)} · vasooli ke baad {rupees(buyer.balancePaise - cash - upi)}</p> : null}
    </Sheet>
  )
}

// ---------------------------------------------------------------- Kharcha / Aaya

const OUT_HEADS = [
  ['kharcha', 'Kharcha'], ['mazdoori', 'Mazdoori'], ['bhada', 'Bhada'], ['kiraya', 'Kiraya'], ['tankhwah', 'Tankhwah'],
  ['committee_di', 'Committee di'], ['bill', 'Bijli-pani'], ['udhaar_diya', 'Udhaar diya'], ['aur_gaya', 'Aur'],
  ['handover', 'Malik ko diya'], ['float', 'Galla ko diya'], ['bank_jama', 'Bank jama'], ['bank_nikala', 'Bank se nikala'],
] as const
const IN_HEADS = [['udhaar_wapas', 'Udhaar wapas'], ['committee_mili', 'Committee mili'], ['aur_aaya', 'Aur aaya']] as const
const BOOKS = [{ key: 'cash', label: 'Galla' }, { key: 'office', label: 'Office' }, { key: 'upi', label: 'Bank' }] as const
/** Where a transfer leaves from (the app only offers these books for each). */
const FROM: Record<string, string> = { handover: 'cash', float: 'office', bank_nikala: 'upi' }

function KharchaForm({ shopId, onClose, onDone }: FormProps) {
  const { saving, error, setError, save } = useSave(onDone)
  const [dir, setDir] = useState<'out' | 'in'>('out')
  const [cat, setCat] = useState('kharcha')
  const [mode, setMode] = useState<'cash' | 'office' | 'upi'>('cash')
  const [amount, setAmount] = useState(0)
  const [party, setParty] = useState('')
  const [note, setNote] = useState('')
  const heads = dir === 'out' ? OUT_HEADS : IN_HEADS
  const fixed = FROM[cat]
  return (
    <Sheet title="Kharcha / Aaya" onClose={onClose} saving={saving} error={error}
      onSave={() => {
        if (amount <= 0) return setError('Rakam daalein')
        if (cat.startsWith('aur_') && !note.trim()) return setError('Wajah likhein')
        void save(`/v1/admin/shops/${shopId}/entries/daybook`, { direction: dir, category: cat, mode: fixed ?? mode, amountPaise: amount, party, note },
          () => `${heads.find((h) => h[0] === cat)?.[1]} ${rupees(amount)} save hua`)
      }}>
      <Seg value={dir} onChange={(d) => { setDir(d); setCat(d === 'out' ? 'kharcha' : 'udhaar_wapas') }} options={[{ key: 'out', label: 'Gaya (kharcha)' }, { key: 'in', label: 'Aaya' }]} />
      <Field label="Kis cheez ka">
        <select className="field" value={cat} onChange={(e) => setCat(e.target.value)}>{heads.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </Field>
      <div className="row2">
        <Field label="Rakam"><Money value={amount} onChange={setAmount} autoFocus /></Field>
        <Field label={fixed ? 'Se' : 'Kahan se'}>
          <select className="field" value={fixed ?? mode} disabled={!!fixed} onChange={(e) => setMode(e.target.value as typeof mode)}>
            {BOOKS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
          </select>
        </Field>
      </div>
      <div className="row2">
        <Field label="Kisko / kisse (optional)"><input className="field" value={party} maxLength={120} onChange={(e) => setParty(e.target.value)} /></Field>
        <Field label={cat.startsWith('aur_') ? 'Wajah' : 'Note (optional)'}><input className="field" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
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
    <Sheet title="Supplier ko diya" onClose={onClose} saving={saving} error={error}
      onSave={() => {
        if (!supplier.trim()) return setError('Supplier chunein')
        if (amount <= 0) return setError('Rakam daalein')
        void save(`/v1/admin/shops/${shopId}/entries/supplier-payment`, { supplier, mode, amountPaise: amount, note }, () => `${supplier} ko ${rupees(amount)} save hua`)
      }}>
      <Field label="Supplier">
        <input className="field" list="sup-list" value={supplier} autoFocus onChange={(e) => setSupplier(e.target.value)} placeholder="Naam" />
        <datalist id="sup-list">{o?.suppliers.map((s) => <option key={s} value={s} />)}</datalist>
      </Field>
      <div className="row2">
        <Field label="Rakam"><Money value={amount} onChange={setAmount} /></Field>
        <Field label="Kahan se"><select className="field" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>{BOOKS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}</select></Field>
      </div>
      <Field label="Note (optional)"><input className="field" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
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
  if (o && o.commodity === 'amrud') return <Sheet title="Nayi Gaadi" onClose={onClose} onSave={onClose} saving={false} error="" saveLabel="Theek hai"><p className="muted">Amrud ki party app se jodein.</p></Sheet>
  return (
    <Sheet title="Nayi Gaadi" onClose={onClose} saving={saving} error={error}
      onSave={() => {
        if (!number.trim()) return setError('Gaadi number daalein')
        if (!lots.some((l) => l.qty > 0)) return setError('Dana daalein')
        void save(`/v1/admin/shops/${shopId}/entries/gaadi`, {
          number, supplier, freightPaise: freight,
          lots: lots.filter((l) => l.qty > 0).map((l) => ({ brandId: l.brandId || undefined, brandName: l.brandId ? undefined : l.brandName, grade: l.grade, qty: l.qty, ratePaise: l.ratePaise })),
        }, () => `Gaadi ${number.toUpperCase().replace(/\s+/g, '')} jud gayi`)
      }}>
      <div className="row2">
        <Field label="Gaadi number"><input className="field" value={number} autoFocus onChange={(e) => setNumber(e.target.value.toUpperCase())} placeholder="RJ14AB1234" /></Field>
        <Field label="Supplier">
          <input className="field" list="gaadi-sup" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          <datalist id="gaadi-sup">{o?.suppliers.map((s) => <option key={s} value={s} />)}</datalist>
        </Field>
      </div>
      <div className="fld">
        <span className="fld-lb">Maal</span>
        <div className="lines-in">
          {lots.map((l, i) => (
            <div key={i} className="line-in">
              <select className="field" value={l.brandId || '__new'} aria-label="Maal" onChange={(e) => set(i, e.target.value === '__new' ? { brandId: '' } : { brandId: e.target.value, brandName: '' })}>
                {o?.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                <option value="__new">+ Naya maal</option>
              </select>
              {!l.brandId && <input className="field" placeholder="Maal ka naam" value={l.brandName} onChange={(e) => set(i, { brandName: e.target.value })} />}
              <input className="field" inputMode="numeric" placeholder="Dana" aria-label="Dana" value={l.qty || ''} onChange={(e) => set(i, { qty: Number(e.target.value.replace(/\D/g, '') || 0) })} />
              <Money value={l.ratePaise} onChange={(v) => set(i, { ratePaise: v })} placeholder="Kharid bhav" />
              {lots.length > 1 && <button type="button" className="icon-btn" aria-label="Hatayein" onClick={() => setLots(lots.filter((_, j) => j !== i))}>✕</button>}
            </div>
          ))}
          {lots.length < 6 && <button type="button" className="btn ghost" style={{ justifySelf: 'start' }} onClick={() => setLots([...lots, { brandId: o?.brands[0]?.id ?? '', brandName: '', grade: '1', qty: 0, ratePaise: 0 }])}>+ Aur maal</button>}
        </div>
      </div>
      <Field label="Bhada (optional)"><Money value={freight} onChange={setFreight} /></Field>
      <div className="total-line"><span>{count(lots.reduce((s, l) => s + l.qty, 0))} dana</span><b className="money">{rupees(total)}</b></div>
    </Sheet>
  )
}

// ---------------------------------------------------------------- Naya grahak, udhaar

function GrahakForm({ shopId, onClose, onDone }: FormProps) {
  const { saving, error, setError, save } = useSave(onDone)
  const [f, setF] = useState({ name: '', phone: '', code: '', address: '', opening: 0 })
  return (
    <Sheet title="Naya Grahak" onClose={onClose} saving={saving} error={error}
      onSave={() => {
        if (!f.name.trim()) return setError('Naam daalein')
        void save(`/v1/admin/shops/${shopId}/entries/grahak`, { name: f.name, phone: f.phone, code: f.code, address: f.address, openingPaise: f.opening || undefined }, () => `${f.name} ka khata khul gaya`)
      }}>
      <Field label="Naam"><input className="field" value={f.name} autoFocus maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <div className="row2">
        <Field label="Mobile"><input className="field" inputMode="tel" value={f.phone} maxLength={10} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="A/C code"><input className="field" value={f.code} maxLength={20} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
      </div>
      <Field label="Dukaan / pata"><input className="field" value={f.address} maxLength={200} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
      <Field label="Purana udhaar (optional)"><Money value={f.opening} onChange={(v) => setF({ ...f, opening: v })} /></Field>
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
    <Sheet title="Udhaar / Jama" onClose={onClose} saving={saving} error={error}
      onSave={() => {
        if (!buyer?.id) return setError('Grahak chunein')
        if (amount <= 0) return setError('Rakam daalein')
        void save(`/v1/admin/shops/${shopId}/entries/udhaar`, { buyerId: buyer.id, amountPaise: type === 'udhaar' ? amount : -amount, note }, () => `${buyer.name}: ${rupees(amount)} ${type} save hua`)
      }}>
      <Field label="Grahak"><BuyerPicker shopId={shopId} value={buyer} onChange={setBuyer} autoFocus /></Field>
      <Seg value={type} onChange={setType} options={[{ key: 'udhaar', label: 'Udhaar (lena)' }, { key: 'jama', label: 'Jama (unka paisa)' }]} />
      <div className="row2">
        <Field label="Rakam"><Money value={amount} onChange={setAmount} /></Field>
        <Field label="Note (optional)"><input className="field" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={type === 'udhaar' ? 'Purana udhaar' : ''} /></Field>
      </div>
    </Sheet>
  )
}
