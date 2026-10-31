import { useEffect, useState, type ReactNode } from 'react'
import { api, type Shop } from '../api'
import { phone, rupees } from '../format'
import { useLoad } from '../useLoad'
import './console.css'

/**
 * MandiPlus admin console (#/admin): set a customer up without their phone in hand — make the
 * shop, put the owner, munim and labour numbers on it, fill its details and settings. Each person
 * then just logs in with their number and lands in the shop. Admin numbers only.
 */
type Role = 'admin' | 'accountant' | 'labour'
const ROLES: { v: Role; label: string }[] = [{ v: 'admin', label: 'Malik' }, { v: 'accountant', label: 'Munim' }, { v: 'labour', label: 'Labour' }]
const MAAL: Record<string, string> = { nariyal: 'Nariyal', angoor: 'Angoor', amrud: 'Amrud' }

type Member = { userId: string; phone: string; name: string; role: Role; since: string; devices: number; lastSeenAt: string | null }
type Device = { id: string; code: string; label: string; platform: string; appVersion: string; lastSeenAt: string | null; phone: string; name: string }
type Bank = { holder: string; bank: string; ifsc: string; account: string; branch?: string; phone?: string; pan?: string }
type Settings = {
  name: string; nickname: string; mandi: string; shopNo: string; phad: string; gstin: string; address: string
  phone: string; dispatchPhone: string; slipCode: string; slipPhones: string[]; slipLimitPaise: number; udhaarRates: boolean; udhaarAlerts: boolean
  apmcOn: boolean; slipWhatsapp: boolean; staffBackupCode: string; printerHost: string; printerDots: number; bankAccounts: Bank[]
  licenceNo: string; companyCode: string; contactPerson: string; email: string
}
type Detail = Settings & {
  id: string; commodity: string; joinCode: string; status: 'pending' | 'approved' | 'rejected'; members: Member[]; devices: Device[]
}

export function Console({ shopId, shops, reload, me, onSignOut }: { shopId: string | null; shops: Shop[] | null; reload: () => void; me: string; onSignOut: () => void }) {
  const [creating, setCreating] = useState(false)
  return (
    <div className="ax">
      <header className="ax-bar">
        <a className="ax-brand" href="#/admin">MandiPlus <span>Admin</span></a>
        <nav>
          <a href="#/admin" aria-current={!shopId ? 'page' : undefined}>Dukaanein</a>
          <a href="#/machines">Machines</a>
          <a href="#/market">Market</a>
        </nav>
        <span className="ax-grow" />
        <button type="button" className="ax-link" onClick={onSignOut}><span className="ax-hide-sm">{phone(me)} · </span>Logout</button>
      </header>
      <main className="ax-main">
        {shopId ? <ShopPage key={shopId} id={shopId} reload={reload} /> : <ShopList shops={shops} reload={reload} onNew={() => setCreating(true)} />}
      </main>
      {creating && <NewShop onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); reload(); location.hash = `#/admin/${id}` }} />}
    </div>
  )
}

// ================================================================ every shop

function ShopList({ shops, reload, onNew }: { shops: Shop[] | null; reload: () => void; onNew: () => void }) {
  const [q, setQ] = useState('')
  const requests = (shops ?? []).filter((s) => s.status === 'pending')
  const words = q.trim().toLowerCase()
  const list = (shops ?? []).filter((s) => s.status !== 'pending')
    .filter((s) => !words || [s.name, s.nickname, s.mandi, s.owner.phone, s.owner.name].join(' ').toLowerCase().includes(words))

  return (
    <>
      <div className="ax-head">
        <h1>Dukaanein</h1>
        <button type="button" className="ax-btn" onClick={onNew}>Nayi dukaan</button>
      </div>
      {requests.length > 0 && (
        <section className="ax-sec">
          <h2>Requests</h2>
          <div className="ax-group">{requests.map((s) => <RequestRow key={s.id} s={s} reload={reload} />)}</div>
        </section>
      )}
      <section className="ax-sec">
        <div className="ax-tools">
          <input className="ax-input" type="search" placeholder="Naam, mandi ya number" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!shops ? <div className="ax-group ax-skel" /> : (
          <div className="ax-group">
            {list.map((s) => (
              <a key={s.id} className="ax-row link" href={`#/admin/${s.id}`}>
                <span className="ax-dot" data-on={live(s.lastSeenAt)} aria-label={live(s.lastSeenAt) ? 'Chal rahi hai' : 'Band'} />
                <span className="ax-grow">
                  <b>{s.name}</b>{s.nickname && <span className="ax-muted"> · {s.nickname}</span>}
                  <small>{[MAAL[s.commodity] ?? s.commodity, s.mandi, s.owner.phone && phone(s.owner.phone), s.status === 'rejected' ? 'Reject ki' : ''].filter(Boolean).join(' · ')}</small>
                </span>
                {s.todaySalesPaise > 0 && <span className="ax-num">{rupees(s.todaySalesPaise)}</span>}
                <span className="ax-chev" aria-hidden>›</span>
              </a>
            ))}
            {list.length === 0 && <p className="ax-empty">Koi dukaan nahi mili</p>}
          </div>
        )}
      </section>
    </>
  )
}

function RequestRow({ s, reload }: { s: Shop; reload: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const act = async (path: string, body?: object) => {
    setBusy(true); setError('')
    try { await api(`/v1/admin/shops/${s.id}/${path}`, { method: 'POST', body }); reload() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="ax-row">
      <span className="ax-grow">
        <b>{s.name}</b>
        <small>{[MAAL[s.commodity] ?? s.commodity, s.mandi, s.owner.name, phone(s.owner.phone), ago(s.createdAt)].filter(Boolean).join(' · ')}</small>
        {error && <small className="ax-err">{error}</small>}
      </span>
      <button type="button" className="ax-btn ghost sm" disabled={busy} onClick={() => { const reason = prompt('Reject kyun?'); if (reason !== null) void act('reject', { reason }) }}>Reject</button>
      <button type="button" className="ax-btn sm" disabled={busy} onClick={() => void act('approve')}>Approve</button>
    </div>
  )
}

// ================================================================ one shop

function ShopPage({ id, reload }: { id: string; reload: () => void }) {
  const [tick, setTick] = useState(0)
  const { data, error } = useLoad(() => api<Detail>(`/v1/admin/console/shops/${id}`), [id, tick])
  const refresh = () => { setTick((n) => n + 1); reload() }
  if (error) return <><Back /><p className="ax-err">{error}</p></>
  if (!data) return <><Back /><div className="ax-group ax-skel" /></>
  const d = data
  return (
    <>
      <Back />
      <div className="ax-head">
        <div className="ax-grow">
          <h1>{d.name}</h1>
          <p className="ax-sub">{[d.nickname, MAAL[d.commodity] ?? d.commodity, d.mandi].filter(Boolean).join(' · ')}</p>
        </div>
        {d.status === 'approved'
          ? <a className="ax-btn ghost" href={`#/s/${d.id}`}>Portal kholein</a>
          : <StatusActions id={d.id} status={d.status} done={refresh} />}
      </div>
      <Form d={d} done={refresh} title="Dukaan" fields={['name', 'nickname', 'mandi', 'shopNo', 'phad', 'address', 'gstin']} />
      <Team d={d} done={refresh} />
      <Form d={d} done={refresh} title="Slip" fields={['slipCode', 'phone', 'dispatchPhone', 'slipPhones', 'udhaarRates', 'slipWhatsapp', ...(d.commodity === 'angoor' ? ['apmcOn' as const] : []), 'printerHost', 'printerDots']} />
      <Form d={d} done={refresh} title="Munim" fields={['slipLimitPaise', 'staffBackupCode']} />
      <Form d={d} done={refresh} title="Udhaar" fields={['udhaarAlerts']} />
      <Banks d={d} done={refresh} />
      <Form d={d} done={refresh} title="Company" fields={['licenceNo', 'companyCode', 'contactPerson', 'email']} />
      <Section title="Aur">
        <div className="ax-row ax-field"><span className="lb">Maal</span><span className="ax-grow ax-muted">{MAAL[d.commodity] ?? d.commodity}</span></div>
        <div className="ax-row ax-field"><span className="lb">Join code</span><span className="ax-grow ax-mono">{d.joinCode}</span></div>
      </Section>
      <Logins d={d} />
    </>
  )
}

const Back = () => <a className="ax-back" href="#/admin">‹ Dukaanein</a>

function StatusActions({ id, status, done }: { id: string; status: Detail['status']; done: () => void }) {
  const [error, setError] = useState('')
  const act = async (path: string, body?: object) => {
    setError('')
    try { await api(`/v1/admin/shops/${id}/${path}`, { method: 'POST', body }); done() } catch (e) { setError((e as Error).message) }
  }
  return (
    <div className="ax-actions">
      {error && <small className="ax-err">{error}</small>}
      {status === 'pending' && <button type="button" className="ax-btn ghost" onClick={() => { const reason = prompt('Reject kyun?'); if (reason !== null) void act('reject', { reason }) }}>Reject</button>}
      <button type="button" className="ax-btn" onClick={() => void act('approve')}>Approve</button>
    </div>
  )
}

type Key = keyof Settings
/** How each setting is asked for. Text unless said otherwise. */
const FIELDS: Partial<Record<Key, { label: string; kind?: 'phone' | 'toggle' | 'rupees' | 'phones' | 'dots' | 'code'; placeholder?: string; upper?: boolean }>> = {
  name: { label: 'Naam' }, nickname: { label: 'Nickname', placeholder: 'Jaise Ashish Azadpur' }, mandi: { label: 'Mandi' }, shopNo: { label: 'Shop no.' },
  phad: { label: 'Phad' }, address: { label: 'Pata' }, gstin: { label: 'GSTIN', upper: true },
  slipCode: { label: 'Slip code', kind: 'code', placeholder: 'Jaise AB' }, phone: { label: 'Dukaan ka phone', kind: 'phone' },
  dispatchPhone: { label: 'Dispatch phone', kind: 'phone' }, slipPhones: { label: 'Slip par aur number', kind: 'phones' },
  udhaarRates: { label: 'Udhaar slip par bhav', kind: 'toggle' }, slipWhatsapp: { label: 'Har slip WhatsApp par', kind: 'toggle' },
  apmcOn: { label: 'APMC 1%', kind: 'toggle' }, printerHost: { label: 'Printer IP', placeholder: '192.168.1.50' },
  printerDots: { label: 'Printer', kind: 'dots' },
  slipLimitPaise: { label: 'Slip limit', kind: 'rupees', placeholder: 'Koi limit nahi' },
  staffBackupCode: { label: 'Backup passcode', placeholder: '2 se 8 ank' },
  udhaarAlerts: { label: 'Subah udhaar WhatsApp', kind: 'toggle' },
  licenceNo: { label: 'Licence no.', upper: true }, companyCode: { label: 'Company code', upper: true }, contactPerson: { label: 'Contact person' }, email: { label: 'Email' },
}
const DOTS = [{ v: 384, l: '2 inch' }, { v: 576, l: '3 inch' }, { v: 832, l: '4 inch' }]

/** One group of settings; Save shows once something in it changed. They reach every terminal on its next sync. */
function Form({ d, done, title, fields }: { d: Detail; done: () => void; title: string; fields: Key[] }) {
  const start = Object.fromEntries(fields.map((k) => [k, d[k]])) as Partial<Settings>
  const [f, setF] = useState(start)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const dirty = fields.filter((k) => JSON.stringify(f[k]) !== JSON.stringify(start[k]))
  const set = (k: Key, v: unknown) => { setError(''); setF({ ...f, [k]: v }) }
  const save = async () => {
    setSaving(true); setError('')
    try {
      const { nickname, ...rest } = Object.fromEntries(dirty.map((k) => [k, f[k]])) as Partial<Settings>
      if (Object.keys(rest).length) await api(`/v1/admin/shops/${d.id}/settings`, { method: 'POST', body: rest })
      if (nickname !== undefined) await api(`/v1/admin/console/shops/${d.id}/labels`, { method: 'POST', body: { nickname } })
      done()
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  return (
    <Section title={title} action={dirty.length > 0 && (
      <span className="ax-actions">
        <button type="button" className="ax-link" onClick={() => { setF(start); setError('') }}>Wapas</button>
        <button type="button" className="ax-btn sm" disabled={saving} onClick={() => void save()}>{saving ? 'Save ho raha…' : 'Save'}</button>
      </span>
    )}>
      {fields.map((k) => <Setting key={k} k={k} value={f[k]} set={(v) => set(k, v)} />)}
      {error && <p className="ax-err pad">{error}</p>}
    </Section>
  )
}

function Setting({ k, value, set }: { k: Key; value: unknown; set: (v: unknown) => void }) {
  const m = FIELDS[k]!
  switch (m.kind) {
    case 'toggle': return <Toggle label={m.label} on={!!value} set={set} />
    case 'dots': return (
      <div className="ax-row ax-field"><span className="lb">{m.label}</span>
        <div className="ax-seg">{DOTS.map((x) => <button key={x.v} type="button" aria-pressed={value === x.v} onClick={() => set(x.v)}>{x.l}</button>)}</div>
      </div>
    )
    case 'rupees': return <Text label={m.label} value={value ? String(Number(value) / 100) : ''} placeholder={m.placeholder} inputMode="numeric" prefix="₹"
      onChange={(v) => set(Math.round(Number(v.replace(/\D/g, '') || 0) * 100))} />
    case 'phone': return <Text label={m.label} value={String(value ?? '')} inputMode="tel" onChange={(v) => set(v.replace(/\D/g, '').slice(0, 10))} />
    case 'phones': return <PhoneList label={m.label} phones={(value as string[]) ?? []} set={set} />
    case 'code': return <Text label={m.label} value={String(value ?? '')} placeholder={m.placeholder} onChange={(v) => set(v.toUpperCase().replace(/[^A-Z0-9&]/g, '').slice(0, 6))} />
    default: return <Text label={m.label} value={String(value ?? '')} placeholder={m.placeholder} onChange={(v) => set(m.upper ? v.toUpperCase() : v)} />
  }
}

/** Up to four more numbers printed on every slip. */
function PhoneList({ label, phones, set }: { label: string; phones: string[]; set: (v: string[]) => void }) {
  const [v, setV] = useState('')
  const ok = /^[6-9]\d{9}$/.test(v) && !phones.includes(v)
  return (
    <div className="ax-row ax-field">
      <span className="lb">{label}</span>
      <span className="ax-tags ax-grow">
        {phones.map((x) => <span key={x} className="ax-tag">{phone(x)}<button type="button" aria-label={`${x} hatayein`} onClick={() => set(phones.filter((y) => y !== x))}>×</button></span>)}
        {phones.length < 4 && <input className="ax-input bare" inputMode="tel" placeholder="+ Number" value={v}
          onChange={(e) => { const n = e.target.value.replace(/\D/g, '').slice(0, 10); setV(n); if (/^[6-9]\d{9}$/.test(n) && !phones.includes(n)) { set([...phones, n]); setV('') } }} />}
        {v && !ok && v.length === 10 && <small className="ax-err">Sahi number nahi</small>}
      </span>
    </div>
  )
}

/** The accounts printed at the head of a grahak's khata and on bank jama parchi; up to four. */
function Banks({ d, done }: { d: Detail; done: () => void }) {
  const blank: Bank = { holder: '', bank: '', ifsc: '', account: '', branch: '' }
  const [rows, setRows] = useState<Bank[]>(d.bankAccounts)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const dirty = JSON.stringify(rows) !== JSON.stringify(d.bankAccounts)
  const set = (i: number, p: Partial<Bank>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)))
  const save = async () => {
    setSaving(true); setError('')
    try { await api(`/v1/admin/shops/${d.id}/settings`, { method: 'POST', body: { bankAccounts: rows } }); done() }
    catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  return (
    <Section title="Bank khate" action={dirty && (
      <span className="ax-actions">
        <button type="button" className="ax-link" onClick={() => setRows(d.bankAccounts)}>Wapas</button>
        <button type="button" className="ax-btn sm" disabled={saving} onClick={() => void save()}>Save</button>
      </span>
    )}>
      {rows.map((r, i) => (
        <div key={i} className="ax-row add">
          <input className="ax-input" placeholder="Khate ka naam" value={r.holder} onChange={(e) => set(i, { holder: e.target.value })} />
          <input className="ax-input" placeholder="Bank" value={r.bank} onChange={(e) => set(i, { bank: e.target.value })} />
          <input className="ax-input" placeholder="Account no." inputMode="numeric" value={r.account} onChange={(e) => set(i, { account: e.target.value.replace(/\s/g, '') })} />
          <input className="ax-input" placeholder="IFSC" value={r.ifsc} onChange={(e) => set(i, { ifsc: e.target.value.toUpperCase().replace(/\s/g, '').slice(0, 11) })} />
          <input className="ax-input" placeholder="Branch" value={r.branch ?? ''} onChange={(e) => set(i, { branch: e.target.value })} />
          <button type="button" className="ax-x" aria-label="Khata hatayein" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      {rows.length < 4 && <div className="ax-row"><button type="button" className="ax-link" onClick={() => setRows([...rows, blank])}>+ Bank khata</button></div>}
      {error && <p className="ax-err pad">{error}</p>}
    </Section>
  )
}

/** Owner(s), munim and labour: each number logs in and lands in this shop. */
function Team({ d, done }: { d: Detail; done: () => void }) {
  const [add, setAdd] = useState({ phone: '', name: '', role: 'accountant' as Role })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const call = async (path: string, method: string, body?: object) => {
    setBusy(true); setError('')
    try { await api(`/v1/admin/console/shops/${d.id}/members${path}`, { method, body }); done(); return true } catch (e) { setError((e as Error).message); return false } finally { setBusy(false) }
  }
  const ok = /^[6-9]\d{9}$/.test(add.phone)
  return (
    <Section title="Team">
      {d.members.map((m) => (
        <div key={m.userId} className="ax-row">
          <span className="ax-grow">
            <b>{m.name || '—'}</b>
            <small>{[phone(m.phone), m.lastSeenAt ? `Aakhri baar ${ago(m.lastSeenAt)}` : 'Abhi login nahi kiya'].join(' · ')}</small>
          </span>
          <select className="ax-select" aria-label={`${m.phone} ka role`} value={m.role} disabled={busy} onChange={(e) => void call(`/${m.userId}`, 'POST', { role: e.target.value })}>
            {ROLES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
          </select>
          <button type="button" className="ax-x" aria-label={`${m.phone} ko hatayein`} disabled={busy}
            onClick={() => { if (confirm(`${m.name || phone(m.phone)} ko team se hatayein? Unka login turant band ho jayega.`)) void call(`/${m.userId}`, 'DELETE') }}>×</button>
        </div>
      ))}
      <div className="ax-row add">
        <input className="ax-input" inputMode="tel" placeholder="Mobile number" value={add.phone} onChange={(e) => setAdd({ ...add, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} />
        <input className="ax-input" placeholder="Naam" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} />
        <select className="ax-select" aria-label="Role" value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value as Role })}>
          {ROLES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
        </select>
        <button type="button" className="ax-btn sm" disabled={!ok || busy} onClick={async () => { if (await call('', 'POST', add)) setAdd({ phone: '', name: '', role: add.role }) }}>Jodein</button>
      </div>
      {error && <p className="ax-err pad">{error}</p>}
    </Section>
  )
}

function Logins({ d }: { d: Detail }) {
  if (!d.devices.length) return null
  return (
    <Section title="Machine / phone">
      {d.devices.map((x) => (
        <div key={x.id} className="ax-row">
          <span className="ax-code">{x.code || '—'}</span>
          <span className="ax-grow">
            <b>{x.label || (x.platform === 'web' ? 'Website' : x.platform)}</b>
            <small>{[x.name || phone(x.phone), x.appVersion && `v${x.appVersion}`].filter(Boolean).join(' · ')}</small>
          </span>
          <span className="ax-muted">{x.lastSeenAt ? ago(x.lastSeenAt) : '—'}</span>
        </div>
      ))}
    </Section>
  )
}

// ================================================================ a new shop

function NewShop({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [f, setF] = useState({ name: '', nickname: '', mandi: '', shopNo: '', commodity: 'nariyal', slipCode: '' })
  // The slip code a shop gets when none is set: its initials (Ashish Brothers → AB).
  const initials = f.name.trim().split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().replace(/[^A-Z0-9&]/g, '').slice(0, 6)
  const [people, setPeople] = useState<{ phone: string; name: string; role: Role }[]>([{ phone: '', name: '', role: 'admin' }])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [tried, setTried] = useState(false)
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [onClose])
  const filled = people.filter((p) => p.phone)
  const badPhone = (p: string) => !!p && !/^[6-9]\d{9}$/.test(p)
  const ready = f.name.trim() && filled.some((p) => p.role === 'admin') && !filled.some((p) => badPhone(p.phone))
  const save = async () => {
    setTried(true); setError('')
    if (!ready) return
    setSaving(true)
    try {
      const r = await api<{ id: string }>('/v1/admin/console/shops', { method: 'POST', body: { ...f, name: f.name.trim(), people: filled } })
      onDone(r.id)
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const setP = (i: number, p: Partial<(typeof people)[number]>) => setPeople(people.map((x, j) => (j === i ? { ...x, ...p } : x)))
  return (
    <div className="ax-scrim" onClick={onClose}>
      <div className="ax-sheet" role="dialog" aria-label="Nayi dukaan" onClick={(e) => e.stopPropagation()}>
        <div className="ax-sheet-head">
          <button type="button" className="ax-link" onClick={onClose}>Cancel</button>
          <h2>Nayi dukaan</h2>
          <button type="button" className="ax-link b" disabled={saving} onClick={() => void save()}>{saving ? '…' : 'Banayein'}</button>
        </div>
        <div className="ax-sheet-body">
          <div className="ax-group">
            <Text label="Naam" value={f.name} onChange={(v) => setF({ ...f, name: v })} autoFocus placeholder="Firm ka naam" error={tried && !f.name.trim() ? 'Naam daalein' : ''} />
            <Text label="Nickname" value={f.nickname} onChange={(v) => setF({ ...f, nickname: v })} />
            <div className="ax-row ax-field">
              <label>Maal</label>
              <div className="ax-seg">
                {Object.entries(MAAL).map(([v, l]) => <button key={v} type="button" aria-pressed={f.commodity === v} onClick={() => setF({ ...f, commodity: v })}>{l}</button>)}
              </div>
            </div>
            <Text label="Mandi" value={f.mandi} onChange={(v) => setF({ ...f, mandi: v })} />
            <Text label="Shop no." value={f.shopNo} onChange={(v) => setF({ ...f, shopNo: v })} />
            <Text label="Slip code" value={f.slipCode} placeholder={initials || 'Jaise AB'} onChange={(v) => setF({ ...f, slipCode: v.toUpperCase().replace(/[^A-Z0-9&]/g, '').slice(0, 6) })} />
          </div>
          <h3>Log</h3>
          <div className="ax-group">
            {people.map((p, i) => (
              <div key={i} className="ax-row add">
                <select className="ax-select" aria-label="Role" value={p.role} onChange={(e) => setP(i, { role: e.target.value as Role })}>
                  {ROLES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
                </select>
                <input className={`ax-input${tried && badPhone(p.phone) ? ' bad' : ''}`} inputMode="tel" placeholder="Mobile number" value={p.phone}
                  onChange={(e) => setP(i, { phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} />
                <input className="ax-input" placeholder="Naam" value={p.name} onChange={(e) => setP(i, { name: e.target.value })} />
                {people.length > 1 && <button type="button" className="ax-x" aria-label="Hatayein" onClick={() => setPeople(people.filter((_, j) => j !== i))}>×</button>}
              </div>
            ))}
            <div className="ax-row">
              <button type="button" className="ax-link" onClick={() => setPeople([...people, { phone: '', name: '', role: 'accountant' }])}>+ Munim</button>
              <button type="button" className="ax-link" onClick={() => setPeople([...people, { phone: '', name: '', role: 'labour' }])}>+ Labour</button>
            </div>
          </div>
          {tried && !filled.some((p) => p.role === 'admin') && <p className="ax-err pad">Malik ka number daalein</p>}
          {error && <p className="ax-err pad">{error}</p>}
        </div>
      </div>
    </div>
  )
}

// ================================================================ the kit

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="ax-sec">
      <div className="ax-sec-head"><h2>{title}</h2>{action}</div>
      <div className="ax-group">{children}</div>
    </section>
  )
}

function Text({ label, value, onChange, placeholder, inputMode, autoFocus, error, prefix }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; inputMode?: 'tel' | 'numeric'; autoFocus?: boolean; error?: string; prefix?: string
}) {
  return (
    <label className="ax-row ax-field">
      <span className="lb">{label}</span>
      {prefix && <span className="ax-muted">{prefix}</span>}
      <input className={`ax-input ax-grow${error ? ' bad' : ''}`} value={value} placeholder={placeholder ?? ''} inputMode={inputMode} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />
      {error && <small className="ax-err">{error}</small>}
    </label>
  )
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <div className="ax-row ax-field">
      <span className="lb ax-grow">{label}</span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className="ax-switch" onClick={() => set(!on)}><i /></button>
    </div>
  )
}

const live = (at: string | null) => !!at && Date.now() - Date.parse(at) < 24 * 3600_000

function ago(iso: string) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (m < 2) return 'abhi'
  if (m < 60) return `${m} min pehle`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} ghante pehle`
  const d = Math.round(h / 24)
  return d < 45 ? `${d} din pehle` : new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}
