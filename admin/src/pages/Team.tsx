import { useState } from 'react'
import { api, type Device, type ShopDetail } from '../api'
import { ago, date, phone } from '../format'
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

      <div className="card wrap-x">
        <div className="hd"><h3>{t('Team')}</h3></div>
        <table className="tbl fold">
          <thead><tr><th>{t('Naam')}</th><th>{t('Mobile')}</th><th>{t('Kab se')}</th><th className="num">{t('Role')}</th></tr></thead>
          <tbody>
            {data.team.map((m) => (
              <tr key={m.phone}>
                <td className="main-col"><b>{m.name || (m.role === 'admin' ? t('Malik') : t('Munim'))}</b><small className="show-sm">{phone(m.phone)}</small></td>
                <td className="opt-col">{phone(m.phone)}</td>
                <td className="opt-col muted">{date(m.joinedAt)}</td>
                <td className="num amt-col"><span className={`chip ${m.role === 'admin' ? 'green' : 'grey'}`}>{m.role === 'admin' ? t('Malik') : t('Accountant')}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
