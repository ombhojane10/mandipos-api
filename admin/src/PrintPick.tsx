import { useEffect, useState } from 'react'
import { api, printDeviceKey } from './api'
import { t } from './i18n'

type Machine = { deviceId: string; code: string; name: string; main: boolean; online: boolean }

/**
 * Which machine the website's slips print on, picked once on this computer: a shop with Pine
 * machines at several counters sends each counter's slips to its own machine. Shown only when
 * more than one machine is listening; "Office" (the shop's main station) is the default.
 */
export function PrintMachinePick({ shopId }: { shopId: string }) {
  const [machines, setMachines] = useState<Machine[]>([])
  const [picked, setPicked] = useState(() => { try { return localStorage.getItem(printDeviceKey(shopId)) ?? '' } catch { return '' } })
  useEffect(() => {
    try { setPicked(localStorage.getItem(printDeviceKey(shopId)) ?? '') } catch { setPicked('') }
    let gone = false
    const load = () => api<{ machines: Machine[] }>(`/v1/admin/shops/${shopId}/print-machines`)
      .then((r) => { if (!gone) setMachines(r.machines) }).catch(() => {})
    load()
    const id = setInterval(load, 60_000)
    return () => { gone = true; clearInterval(id) }
  }, [shopId])
  if (machines.length < 2) return null
  const label = (m: Machine) => `${m.code || m.name}${m.main ? ` · ${t('Office')}` : ''}${m.online ? '' : ` · ${t('band')}`}`
  const choose = (id: string) => {
    setPicked(id)
    try { if (id) localStorage.setItem(printDeviceKey(shopId), id); else localStorage.removeItem(printDeviceKey(shopId)) } catch { /* private mode */ }
  }
  return (
    <label className="print-pick" title={t('Website ki parchi is machine se chhapegi')}>
      <span aria-hidden>🖨</span>
      <select aria-label={t('Print machine')} value={machines.some((m) => m.deviceId === picked) ? picked : ''} onChange={(e) => choose(e.target.value)}>
        <option value="">{t('Office machine')}</option>
        {machines.filter((m) => !m.main).map((m) => <option key={m.deviceId} value={m.deviceId}>{label(m)}</option>)}
      </select>
    </label>
  )
}
