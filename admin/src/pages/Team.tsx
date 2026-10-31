import { useState } from 'react'
import { api, type Device, type ShopDetail } from '../api'
import { useSession } from '../App'
import { ago, phone } from '../format'
import { t } from '../i18n'
import { useLoad } from '../useLoad'
import { Skeleton } from '../ui'

/** A machine not heard from in this long is folded away under "Purani machine". */
const STALE_DAYS = 14

/** Who is on the team, and which machines are logged in and when they last spoke to the server. */
export function Team({ shopId }: { shopId: string }) {
  const { data, error } = useLoad(() => api<ShopDetail>(`/v1/admin/shops/${shopId}`), [shopId])
  const [showOld, setShowOld] = useState(false)
  if (error) return <p className="error">{error}</p>
  if (!data) return <Skeleton />
  const seen = ago
  const cutoff = Date.now() - STALE_DAYS * 86_400_000
  const fresh = data.devices.filter((d) => d.lastSeenAt && Date.parse(d.lastSeenAt) >= cutoff)
  const old = data.devices.filter((d) => !fresh.includes(d))
  const today = data.devices.filter((d) => d.lastSeenAt && Date.now() - Date.parse(d.lastSeenAt) < 86_400_000).length
  const nameOf = (p: string, name: string) => name || data.team.find((m) => m.phone === p)?.name || ''
  const who = (p: string, name: string) => nameOf(p, name) || phone(p)
  const rows = (list: Device[]) => list.map((d) => (
    <tr key={`${d.code}-${d.phone}-${d.addedAt}`}>
      <td className="code-col"><span className="code">{d.code ?? '—'}</span></td>
      <td className="main-col"><b>{d.web ? t('Website') : d.label || t('Machine')}</b><small className="show-sm">{who(d.phone, d.name)} · {seen(d.lastSeenAt)}</small></td>
      <td className="opt-col">{nameOf(d.phone, d.name) ? <>{nameOf(d.phone, d.name)}<small>{phone(d.phone)}</small></> : phone(d.phone)}</td>
      <td className="opt-col muted">{d.web ? '—' : `v${d.appVersion}`}</td>
      <td className="num opt-col muted">{seen(d.lastSeenAt)}</td>
    </tr>
  ))

  return (
    <div className="stack">
      <div className="card sum">
        <div><span className="lb">{t('Team')}</span><span className="v">{data.team.length}</span></div>
        <div><span className="lb">{t('Machine')}</span><span className="v">{data.devices.length}</span></div>
        <div><span className="lb">{t('Aaj chali')}</span><span className="v">{today}</span></div>
      </div>

      <BranchStaff shopId={shopId} />

      <div className="card wrap-x">
        <div className="hd"><h3>{t('Machine')}</h3><span className="muted">{t('{n} chalu', { n: fresh.length })}</span></div>
        <table className="tbl fold">
          <thead><tr><th style={{ width: 56 }}>{t('Code')}</th><th>{t('Machine')}</th><th>{t('Kiski')}</th><th>{t('App')}</th><th className="num">{t('Aakhri baar')}</th></tr></thead>
          <tbody>
            {rows(fresh)}
            {old.length > 0 && (
              <tr className="fold-row">
                <td colSpan={5}><button type="button" className="btn ghost" onClick={() => setShowOld(!showOld)}>
                  {showOld ? t('Purani machine chhupayein') : t('Purani machine ({n})', { n: old.length })}
                </button></td>
              </tr>
            )}
            {showOld && rows(old)}
          </tbody>
        </table>
        {data.devices.length === 0 && <p className="empty">{t('Koi machine nahi')}</p>}
      </div>
    </div>
  )
}

type Role = 'admin' | 'accountant' | 'labour'
type BranchTeam = {
  branches: { id: string; name: string; nickname: string; mandi: string }[]
  people: { userId: string; phone: string; name: string; roles: Record<string, Role>; lastSeenAt: string | null }[]
}
const ROLES: { v: Role | ''; label: string }[] = [{ v: '', label: '—' }, { v: 'admin', label: 'Malik' }, { v: 'accountant', label: 'Munim' }, { v: 'labour', label: 'Labour' }]

/**
 * Who works at which branch: the owner puts a number on one branch, several, or takes it off.
 * Each number logs in with its own OTP; a phone on two branches switches from Meri dukaanein.
 */
function BranchStaff({ shopId }: { shopId: string }) {
  const { me } = useSession()
  const [tick, setTick] = useState(0)
  const { data, error } = useLoad(() => api<BranchTeam>(`/v1/admin/shops/${shopId}/branch-team`), [shopId, tick])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [add, setAdd] = useState<{ phone: string; name: string; roles: Record<string, Role | ''> }>({ phone: '', name: '', roles: { [shopId]: 'accountant' } })
  const mayEdit = (id: string) => !!me?.admin || !!me?.shopIds?.includes(id)
  const send = async (phoneNo: string, name: string, roles: Record<string, Role | null>) => {
    setBusy(true); setMsg('')
    try { await api(`/v1/admin/shops/${shopId}/branch-team`, { method: 'POST', body: { phone: phoneNo, name, roles } }); setTick((n) => n + 1); return true }
    catch (e) { setMsg((e as Error).message); return false } finally { setBusy(false) }
  }
  if (error) return <p className="error">{error}</p>
  if (!data) return null
  const many = data.branches.length > 1
  const label = (b: BranchTeam['branches'][number]) => b.nickname || (many && data.branches.some((x) => x.id !== b.id && x.name === b.name) ? b.mandi : '') || b.name
  const okPhone = /^[6-9]\d{9}$/.test(add.phone)
  const addRoles = Object.fromEntries(Object.entries(add.roles).filter(([, r]) => r)) as Record<string, Role>
  return (
    <div className="card wrap-x">
      <div className="hd"><h3>{many ? t('Staff aur branch') : t('Staff')}</h3></div>
      <table className="tbl branch-staff">
        <thead><tr><th>{t('Naam')}</th>{data.branches.map((b) => <th key={b.id} className={b.id === shopId ? 'here' : undefined}>{label(b)}</th>)}</tr></thead>
        <tbody>
          {data.people.map((p) => (
            <tr key={p.userId}>
              <td className="main-col"><b>{p.name || phone(p.phone)}</b><small>{phone(p.phone)}{p.lastSeenAt ? ` · ${ago(p.lastSeenAt)}` : ''}</small></td>
              {data.branches.map((b) => (
                <td key={b.id}>
                  <select className="field" aria-label={`${p.name || p.phone} · ${label(b)}`} value={p.roles[b.id] ?? ''} disabled={busy || !mayEdit(b.id)}
                    onChange={(e) => {
                      const v = e.target.value as Role | ''
                      if (!v && !confirm(t('{name} ko {branch} se hatayein? Wahan ka login turant band ho jayega.', { name: p.name || phone(p.phone), branch: label(b) }))) return
                      void send(p.phone, '', { [b.id]: v || null })
                    }}>
                    {ROLES.map((r) => <option key={r.v} value={r.v}>{t(r.label)}</option>)}
                  </select>
                </td>
              ))}
            </tr>
          ))}
          <tr className="add-row">
            <td className="main-col">
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="field" inputMode="tel" placeholder={t('Mobile')} maxLength={10} value={add.phone} onChange={(e) => setAdd({ ...add, phone: e.target.value.replace(/\D/g, '') })} />
                <input className="field" placeholder={t('Naam')} value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} />
              </div>
            </td>
            {data.branches.map((b) => (
              <td key={b.id}>
                <select className="field" aria-label={`${t('Naya')} · ${label(b)}`} value={add.roles[b.id] ?? ''} disabled={!mayEdit(b.id)}
                  onChange={(e) => setAdd({ ...add, roles: { ...add.roles, [b.id]: e.target.value as Role | '' } })}>
                  {ROLES.map((r) => <option key={r.v} value={r.v}>{t(r.label)}</option>)}
                </select>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <div className="hd" style={{ borderTop: '1px solid var(--line)' }}>
        {msg ? <span className="error" style={{ margin: 0 }}>{msg}</span> : <span className="muted">{many ? t('Har number apne OTP se login karta hai; do branch wala Meri dukaanein se badalta hai') : ''}</span>}
        <button type="button" className="btn" disabled={busy || !okPhone || !Object.keys(addRoles).length}
          onClick={async () => { if (await send(add.phone, add.name.trim(), addRoles)) setAdd({ phone: '', name: '', roles: { [shopId]: 'accountant' } }) }}>{t('Jodein')}</button>
      </div>
    </div>
  )
}
