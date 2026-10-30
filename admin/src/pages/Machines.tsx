import { useState } from 'react'
import { api } from '../api'
import { useSession } from '../App'
import { ago, count, date, phone as fmtPhone, todayIst } from '../format'
import { t } from '../i18n'
import { booksChanged, useLoad } from '../useLoad'
import { Skeleton } from '../ui'
import { fileName, useExport } from '../export/doc'
import { Field, Seg, Sheet } from '../entries/fields'

type Login = { id: string; code: string | null; label: string; appVersion: string; lastSeenAt: string | null; phone: string }
type Machine = {
  id: string; serial: string; model: string; tid: string; status: Status; note: string
  shopId: string | null; shopName: string | null; holderName: string; holderPhone: string; givenOn: string | null
  device: Login | null; updatedAt: string
}
type Device = Login & { shopId: string | null; shopName: string | null; createdAt: string; machineId: string | null }
type Register = { machines: Machine[]; devices: Device[] }
type Status = 'stock' | 'given' | 'repair' | 'lost'
type Event = { id: string; action: string; shopName: string | null; holderName: string; holderPhone: string; onDay: string; note: string; byPhone: string; at: string }

const STATUS: Record<Status, { label: string; tone: string }> = {
  given: { label: 'Diya hua', tone: 'green' }, stock: { label: 'Stock mein', tone: 'grey' }, repair: { label: 'Repair', tone: 'amber' }, lost: { label: 'Kho gayi', tone: 'red' },
}
const ACTION: Record<string, string> = {
  added: 'Register mein aayi', given: 'Di', returned: 'Wapas aayi', repair: 'Repair ko gayi', lost: 'Kho gayi', linked: 'Login joda', edited: 'Details badli',
}
const loginText = (d: Login) => [d.code, d.label, d.appVersion && `v${d.appVersion}`].filter(Boolean).join(' · ')
const whom = (m: { shopName: string | null; holderName: string }) => m.shopName || m.holderName || '—'

/** MandiPlus admin: every POS machine handed out — serial, with whom since when, its app login. */
export function Machines() {
  const [q, setQ] = useState('')
  const [show, setShow] = useState<Status | 'all'>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const { data, error, loading } = useLoad(() => api<Register>('/v1/admin/machines'), [])
  const f = q.trim().toLowerCase()
  const all = data?.machines ?? []
  const rows = all.filter((m) => (show === 'all' || m.status === show) && (!f || [m.serial, m.model, m.tid, m.shopName ?? '', m.holderName, m.holderPhone, m.device?.code ?? '']
    .some((x) => x.toLowerCase().includes(f))))
  const by = (s: Status) => all.filter((m) => m.status === s).length

  useExport(data && !open ? () => ({
    style: 'book' as const, title: t('Machines'), file: fileName('Machines', todayIst()),
    columns: [{ label: t('Serial') }, { label: t('Model') }, { label: t('Kiske paas'), wide: true }, { label: t('Mobile') }, { label: t('Kab se') }, { label: t('App login') }, { label: t('Haal') }],
    rows: rows.map((m) => ({ cells: [m.serial, m.model, [m.shopName, m.holderName].filter(Boolean).join(' · '), m.holderPhone, m.givenOn ? date(m.givenOn) : '', m.device ? loginText(m.device) : '', t(STATUS[m.status].label)] })),
  }) : null, [data, q, show, open])

  const current = open ? all.find((m) => m.id === open) : null
  if (current && data) return <MachinePage m={current} devices={data.devices} onBack={() => setOpen(null)} />

  // Logins on the books that no machine in the register claims: a machine handed out but not written down.
  const loose = (data?.devices ?? []).filter((d) => !d.machineId && d.lastSeenAt && Date.now() - Date.parse(d.lastSeenAt) < 30 * 86_400_000)

  return (
    <>
      <div className="toolbar">
        <input className="field search grow" data-search placeholder={t('Serial, dukaan, naam ya mobile')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>+ {t('Machine')}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <>
          <div className="card sum">
            <div><span className="lb">{t('Kul machine')}</span><span className="v">{count(all.length)}</span></div>
            <div><span className="lb">{t('Diya hua')}</span><span className="v">{count(by('given'))}</span></div>
            <div><span className="lb">{t('Stock mein')}</span><span className="v">{count(by('stock'))}</span></div>
            <div><span className="lb">{t('Repair / kho gayi')}</span><span className="v">{count(by('repair') + by('lost'))}</span></div>
          </div>
          <Seg value={show} onChange={setShow} options={[
            { key: 'all', label: t('Sab') }, { key: 'given', label: t('Diya hua') }, { key: 'stock', label: t('Stock mein') }, { key: 'repair', label: t('Repair') }, { key: 'lost', label: t('Kho gayi') },
          ]} />
          <div className={`card wrap-x${loading ? ' dim' : ''}`}>
            <table className="tbl fold">
              <thead><tr><th>{t('Serial')}</th><th>{t('Kiske paas')}</th><th className="opt-col">{t('Kab se')}</th><th className="opt-col">{t('App login')}</th><th>{t('Haal')}</th></tr></thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} data-row tabIndex={0} onClick={() => setOpen(m.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(m.id) }}>
                    <td><b className="money">{m.serial}</b><small>{[m.model, m.tid && `TID ${m.tid}`].filter(Boolean).join(' · ')}</small></td>
                    <td className="main-col"><b>{whom(m)}</b><small>{[m.shopName && m.holderName, m.holderPhone && fmtPhone(m.holderPhone)].filter(Boolean).join(' · ')}
                      {m.givenOn && <span className="show-sm"> · {date(m.givenOn)}</span>}</small></td>
                    <td className="opt-col muted">{m.givenOn ? date(m.givenOn) : ''}</td>
                    <td className="opt-col">{m.device ? <>{loginText(m.device)}<small>{m.device.lastSeenAt ? ago(m.device.lastSeenAt) : ''}</small></> : <span className="muted">—</span>}</td>
                    <td><span className={`chip ${STATUS[m.status].tone}`}>{t(STATUS[m.status].label)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="empty">{all.length ? t('Koi machine nahi mili') : t('Abhi register mein koi machine nahi')}</p>}
          </div>
          {loose.length > 0 && (
            <details className="card" style={{ padding: '10px 14px' }}>
              <summary><b>{t('Register mein nahi')}</b> · {count(loose.length)} {t('app login, kisi machine se jude nahi')}</summary>
              <table className="tbl" style={{ marginTop: 8 }}>
                <tbody>
                  {loose.map((d) => (
                    <tr key={d.id}><td><b>{d.shopName}</b><small>{loginText(d)}</small></td><td className="num muted">{d.lastSeenAt ? ago(d.lastSeenAt) : ''}</td></tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
      {adding && <MachineSheet m={null} onClose={() => setAdding(false)} onSaved={(id) => { setAdding(false); setOpen(id) }} />}
    </>
  )
}

/** One machine: who has it, its login, and every hand-over since it came. */
function MachinePage({ m, devices, onBack }: { m: Machine; devices: Device[]; onBack: () => void }) {
  const [sheet, setSheet] = useState<'edit' | 'give' | 'back' | null>(null)
  const { data } = useLoad(() => api<{ events: Event[] }>(`/v1/admin/machines/${m.id}/history`), [m.id, m.updatedAt])
  return (
    <>
      <div className="toolbar">
        <button type="button" className="btn ghost" onClick={onBack}>‹ {t('Machines')}</button>
        <span className="grow" />
        <button type="button" className="btn" onClick={() => setSheet('edit')}>{t('Badlein')}</button>
        {m.status === 'given' && <button type="button" className="btn" onClick={() => setSheet('back')}>{t('Wapas lein')}</button>}
        <button type="button" className="btn primary" onClick={() => setSheet('give')}>{m.status === 'given' ? t('Kisi aur ko dein') : t('Machine dein')}</button>
      </div>
      <div className="card sum">
        <div><span className="lb">{t('Serial')}</span><span className="v money">{m.serial}</span><small>{[m.model, m.tid && `TID ${m.tid}`].filter(Boolean).join(' · ')}</small></div>
        <div><span className="lb">{t('Kiske paas')}</span><span className="v">{whom(m)}</span>
          <small>{[m.shopName && m.holderName, m.holderPhone && fmtPhone(m.holderPhone), m.givenOn && `${t('Kab se')} ${date(m.givenOn)}`].filter(Boolean).join(' · ') || t(STATUS[m.status].label)}</small></div>
        <div><span className="lb">{t('App login')}</span><span className="v">{m.device ? loginText(m.device) : '—'}</span>
          <small>{m.device?.lastSeenAt ? `${t('Chalu')} ${ago(m.device.lastSeenAt)}` : ''}</small></div>
      </div>
      {m.note && <p className="muted" style={{ margin: '0 2px' }}>{m.note}</p>}
      <div className="card wrap-x">
        <table className="tbl fold">
          <thead><tr><th className="opt-col">{t('Tarikh')}</th><th>{t('Kya hua')}</th><th className="opt-col">{t('Kisne likha')}</th></tr></thead>
          <tbody>
            {(data?.events ?? []).map((e) => (
              <tr key={e.id}>
                <td className="opt-col muted">{date(e.onDay)}</td>
                <td className="main-col"><b>{t(ACTION[e.action] ?? e.action)}{e.shopName || e.holderName ? ` · ${whom(e)}` : ''}</b>
                  <small><span className="show-sm">{date(e.onDay)} · </span>{[e.shopName && e.holderName, e.holderPhone && fmtPhone(e.holderPhone), e.note].filter(Boolean).join(' · ')}</small></td>
                <td className="opt-col muted">{e.byPhone ? fmtPhone(e.byPhone) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data && <Skeleton rows={3} />}
      </div>
      {sheet === 'edit' && <MachineSheet m={m} onClose={() => setSheet(null)} onSaved={() => setSheet(null)} />}
      {sheet === 'give' && <GiveSheet m={m} devices={devices} onClose={() => setSheet(null)} />}
      {sheet === 'back' && <BackSheet m={m} onClose={() => setSheet(null)} />}
    </>
  )
}

function useSave(run: () => Promise<unknown>, done: (r: unknown) => void) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    setSaving(true); setError('')
    try { const r = await run(); booksChanged(); done(r) } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  return { saving, error, save: () => void save() }
}

function MachineSheet({ m, onClose, onSaved }: { m: Machine | null; onClose: () => void; onSaved: (id: string) => void }) {
  const [serial, setSerial] = useState(m?.serial ?? '')
  const [model, setModel] = useState(m?.model ?? 'Pine P5')
  const [tid, setTid] = useState(m?.tid ?? '')
  const [note, setNote] = useState(m?.note ?? '')
  const s = useSave(() => api<{ id: string }>(m ? `/v1/admin/machines/${m.id}` : '/v1/admin/machines', { method: 'POST', body: { serial, model, tid, note } }),
    (r) => onSaved((r as { id: string }).id))
  return (
    <Sheet title={m ? t('Machine badlein') : t('Nayi machine')} onClose={onClose} onSave={s.save} saving={s.saving} error={s.error}>
      <Field label={t('Serial number')} hint={t('Machine ke peeche likha hota hai')}>
        <input className="field" style={{ textTransform: 'uppercase' }} autoFocus value={serial} onChange={(e) => setSerial(e.target.value)} />
      </Field>
      <div className="grid g2">
        <Field label={t('Model')}><input className="field" list="machine-models" value={model} onChange={(e) => setModel(e.target.value)} /></Field>
        <Field label={t('TID')}><input className="field" value={tid} onChange={(e) => setTid(e.target.value)} /></Field>
      </div>
      <datalist id="machine-models"><option value="Pine P5" /><option value="Pine A910" /><option value="Phone" /><option value="Tablet" /></datalist>
      <Field label={t('Note')}><input className="field" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Sheet>
  )
}

function GiveSheet({ m, devices, onClose }: { m: Machine; devices: Device[]; onClose: () => void }) {
  const { shops } = useSession()
  const open = (shops ?? []).filter((s) => s.status === 'approved')
  const [shopId, setShopId] = useState(m.shopId ?? '')
  const [name, setName] = useState(m.holderName)
  const [mobile, setMobile] = useState(m.holderPhone)
  const [onDay, setOnDay] = useState(todayIst())
  const [deviceId, setDeviceId] = useState(m.device?.id ?? '')
  const [note, setNote] = useState('')
  // A shop picked: its owner is the default holder, and its logins (free ones first) are offered.
  const pickShop = (id: string) => {
    setShopId(id); setDeviceId('')
    const s = open.find((x) => x.id === id)
    if (s) { setName(s.owner.name); setMobile(s.owner.phone) }
  }
  const logins = devices.filter((d) => d.shopId === shopId && (!d.machineId || d.machineId === m.id))
    .sort((a, b) => Date.parse(b.lastSeenAt ?? b.createdAt) - Date.parse(a.lastSeenAt ?? a.createdAt))
  const s = useSave(() => api(`/v1/admin/machines/${m.id}/give`, { method: 'POST', body: { shopId: shopId || null, name, phone: mobile, onDay, deviceId: deviceId || null, note } }), onClose)
  return (
    <Sheet title={`${t('Machine dein')} · ${m.serial}`} onClose={onClose} onSave={s.save} saving={s.saving} error={s.error}>
      <Field label={t('Dukaan')}>
        <select className="field" autoFocus value={shopId} onChange={(e) => pickShop(e.target.value)}>
          <option value="">{t('Dukaan nahi (sirf naam)')}</option>
          {open.map((x) => <option key={x.id} value={x.id}>{x.name}{x.mandi ? ` · ${x.mandi}` : ''}</option>)}
        </select>
      </Field>
      <div className="grid g2">
        <Field label={t('Kisko di (naam)')}><input className="field" style={{ textTransform: 'uppercase' }} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('Mobile')}><input className="field" inputMode="numeric" value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))} /></Field>
      </div>
      <Field label={t('Kab di')}><input className="field" type="date" value={onDay} onChange={(e) => setOnDay(e.target.value)} /></Field>
      {shopId && (
        <Field label={t('Is machine par app login')} hint={logins.length ? t('Machine ki Settings mein dikhta code (jaise B4) milayein') : t('Is dukaan ka koi app login nahi mila')}>
          <select className="field" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">—</option>
            {logins.map((d) => <option key={d.id} value={d.id}>{loginText(d)}{d.lastSeenAt ? ` · ${ago(d.lastSeenAt)}` : ''}</option>)}
          </select>
        </Field>
      )}
      <Field label={t('Note')}><input className="field" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Sheet>
  )
}

function BackSheet({ m, onClose }: { m: Machine; onClose: () => void }) {
  const [status, setStatus] = useState<'stock' | 'repair' | 'lost'>('stock')
  const [onDay, setOnDay] = useState(todayIst())
  const [note, setNote] = useState('')
  const s = useSave(() => api(`/v1/admin/machines/${m.id}/back`, { method: 'POST', body: { status, onDay, note } }), onClose)
  return (
    <Sheet title={`${t('Wapas lein')} · ${whom(m)}`} onClose={onClose} onSave={s.save} saving={s.saving} error={s.error}>
      <Seg value={status} onChange={setStatus} options={[{ key: 'stock', label: t('Stock mein') }, { key: 'repair', label: t('Repair') }, { key: 'lost', label: t('Kho gayi') }]} />
      <Field label={t('Kab')}><input className="field" type="date" value={onDay} onChange={(e) => setOnDay(e.target.value)} /></Field>
      <Field label={t('Note')}><input className="field" autoFocus value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Sheet>
  )
}
