import { api, type Shop } from '../api'
import { count } from '../format'
import { t } from '../i18n'
import { ScanHost, openScan } from '../Scan'
import { useLoad } from '../useLoad'

type Home = { today: number; reports: { id: string; slipNo: number | null; qty: number; status: string; quality: string; at: string }[] }

/** A labour login's whole website, as in the app: today's boxes, Scan, and the broken boxes they reported. */
export function LabourHome({ shop, onSignOut }: { shop: Shop; onSignOut: () => void }) {
  const { data } = useLoad(() => api<Home>(`/v1/admin/shops/${shop.id}/labour`), [shop.id])
  const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
  return (
    <div className="labour">
      <header className="labour-top">
        <b>{shop.name}</b>
        <button type="button" className="btn ghost" onClick={onSignOut}>{t('Logout')}</button>
      </header>
      <div className="labour-count">
        <strong>{count(data?.today ?? 0)}</strong>
        <span>{t('box aaj diye')}</span>
      </div>
      <button type="button" className="btn primary labour-scan" onClick={() => openScan(shop.id)}>{t('Scan karein')}</button>
      {!!data?.reports.length && (
        <>
          <div className="labour-grp">{t('Toote box')}</div>
          <div className="card labour-list">
            {data.reports.map((r) => (
              <div key={r.id}>
                <span className="grow"><b>{r.slipNo ? `#${r.slipNo}` : t('Parchi')} · {r.quality}</b><small className="muted">{time(r.at)}</small></span>
                <span className={r.status === 'done' ? 'up' : r.status === 'rejected' ? 'due' : 'amber'}>
                  {r.status === 'done' ? t('Nayi parchi bani') : r.status === 'rejected' ? t('Mana hua') : t('{n} box · accountant ke paas', { n: count(r.qty) })}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      <ScanHost />
    </div>
  )
}
