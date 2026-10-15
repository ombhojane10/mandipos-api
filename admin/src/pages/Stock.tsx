import { useState } from 'react'
import { api, type Stock as S } from '../api'
import { count, rupees, shortDate } from '../format'
import { hashQuery, setHashQuery } from '../routes'
import { useLoad } from '../useLoad'
import { Skeleton } from '../ui'
import { t } from '../i18n'
import { fileName, useExport } from '../export/doc'

const VIEWS = [{ key: 'active', label: t('Active') }, { key: 'past', label: t('Past') }] as const
type View = (typeof VIEWS)[number]['key']

/**
 * Tally's Stock Summary, gaadi-wise: aaya, gaya, phoota, baaki, and its worth at kharid bhav.
 * Active (the open gaadis) is where a shop looks; Past lists the closed ones.
 */
export function Stock({ shopId }: { shopId: string }) {
  const [view, setView] = useState<View>(() => (hashQuery().get('v') === 'past' ? 'past' : 'active'))
  const { data, error, loading } = useLoad(() => api<S>(`/v1/admin/shops/${shopId}/stock?view=${view}`), [shopId, view])
  const pick = (v: View) => { setView(v); setHashQuery({ ...Object.fromEntries(hashQuery()), v }) }
  const past = view === 'past'
  const sum = (k: 'received' | 'sold' | 'spoiled') => (data?.rows ?? []).reduce((s, r) => s + r[k], 0)

  useExport(data ? () => ({
    title: `${t('Stock Summary')} · ${VIEWS.find((v) => v.key === view)!.label}`, file: fileName(t('Stock Summary'), view, new Date().toISOString().slice(0, 10)),
    summary: past
      ? [[t('Gaadi'), count(data.rows.length)], [t('Aaya'), count(sum('received'))], [t('Gaya'), count(sum('sold'))]]
      : [[t('Baaki maal'), t('{n} nag', { n: count(data.totals.left) })], [t('Kharid bhav par'), rupees(data.totals.valuePaise)], [t('Khuli gaadi'), count(data.totals.gaadis)]],
    columns: [{ label: t('Gaadi'), wide: true }, { label: t('Aayi') }, ...(past ? [{ label: t('Band hui') }] : []), { label: t('Aaya'), num: true }, { label: t('Gaya'), num: true },
      { label: t('Phoota'), num: true }, { label: t('Baaki'), num: true }, ...(past ? [] : [{ label: t('Keemat'), num: true }])],
    rows: data.rows.map((r) => ({ cells: [[r.number, r.supplier, r.brands].filter(Boolean).join(' · '), shortDate(r.arrivedOn), ...(past ? [r.closedOn ? shortDate(r.closedOn) : ''] : []),
      count(r.received), count(r.sold), r.spoiled ? count(r.spoiled) : '', count(r.left), ...(past ? [] : [rupees(r.valuePaise)])] })),
    foot: [t('Kul'), '', ...(past ? [''] : []), count(sum('received')), count(sum('sold')), count(sum('spoiled')), count(data.totals.left), ...(past ? [] : [rupees(data.totals.valuePaise)])],
  }) : null, [data, view])

  const tot = data?.totals
  return (
    <>
      <div className="toolbar">
        <div className="seg" role="group" aria-label={t('Gaadi')}>
          {VIEWS.map((v) => <button key={v.key} aria-pressed={view === v.key} onClick={() => pick(v.key)}>{v.label}</button>)}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!data || !tot ? <Skeleton /> : (
        <div className={`stack${loading ? ' dim' : ''}`}>
          <div className="card sum">
            {past ? (
              <>
                <div><span className="lb">{t('Gaadi')}</span><span className="v">{count(data.rows.length)}</span></div>
                <div><span className="lb">{t('Aaya')}</span><span className="v">{t('{n} nag', { n: count(sum('received')) })}</span></div>
                <div><span className="lb">{t('Gaya')}</span><span className="v">{t('{n} nag', { n: count(sum('sold')) })}</span></div>
                <div><span className="lb">{t('Phoota')}</span><span className="v">{t('{n} nag', { n: count(sum('spoiled')) })}</span></div>
              </>
            ) : (
              <>
                <div><span className="lb">{t('Baaki maal')}</span><span className="v">{t('{n} nag', { n: count(tot.left) })}</span></div>
                <div><span className="lb">{t('Kharid bhav par')}</span><span className="v">{rupees(tot.valuePaise)}</span></div>
                <div><span className="lb">{t('Khuli gaadi')}</span><span className="v">{count(tot.gaadis)}</span></div>
                <div><span className="lb">{t('Purani gaadi')}</span><span className={`v${tot.stale ? ' due' : ''}`}>{count(tot.stale)}</span></div>
              </>
            )}
          </div>
          <div className="card wrap-x">
            <table className="tbl fold">
              <thead><tr>
                <th>{t('Gaadi')}</th><th>{t('Aayi')}</th>{past && <th>{t('Band hui')}</th>}<th className="num">{t('Aaya')}</th><th className="num">{t('Gaya')}</th>
                <th className="num">{t('Phoota')}</th><th className="num">{t('Baaki')}</th>{!past && <th className="num">{t('Keemat')}</th>}
              </tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.truckId}>
                    <td className="main-col">
                      <b>{r.number}</b> {!past && r.stale && r.left > 0 && <span className="chip amber">{t('Purani')}</span>}
                      <small>{[r.supplier, r.brands].filter(Boolean).join(' · ')}<span className="show-sm"> · {past && r.closedOn ? shortDate(r.closedOn) : t('{n} din', { n: r.ageDays })} · {t('{a}/{b} bika', { a: count(r.sold), b: count(r.received) })}</span></small>
                    </td>
                    <td className="opt-col muted">{shortDate(r.arrivedOn)}{!past && <small>{r.ageDays === 0 ? t('aaj') : t('{n} din', { n: r.ageDays })}</small>}</td>
                    {past && <td className="opt-col muted">{r.closedOn ? shortDate(r.closedOn) : '—'}</td>}
                    <td className="num opt-col money">{count(r.received)}</td>
                    <td className="num opt-col money">{count(r.sold)}</td>
                    <td className="num opt-col money muted">{r.spoiled ? count(r.spoiled) : ''}</td>
                    <td className="num amt-col money b">{count(r.left)} <small className="inline">{t('nag')}</small>{!past && <span className="sm-block muted" style={{ fontWeight: 400 }}>{rupees(r.valuePaise)}</span>}</td>
                    {!past && <td className="num opt-col money">{rupees(r.valuePaise)}</td>}
                  </tr>
                ))}
              </tbody>
              {data.rows.length > 1 && (
                <tfoot><tr>
                  <td className="main-col">{t('Kul')}</td><td className="opt-col" />{past && <td className="opt-col" />}
                  <td className="num opt-col money">{count(sum('received'))}</td>
                  <td className="num opt-col money">{count(sum('sold'))}</td>
                  <td className="num opt-col money">{count(sum('spoiled'))}</td>
                  <td className="num amt-col money">{count(tot.left)}</td>
                  {!past && <td className="num opt-col money">{rupees(tot.valuePaise)}</td>}
                </tr></tfoot>
              )}
            </table>
            {data.rows.length === 0 && <p className="empty">{past ? t('Koi band gaadi nahi') : t('Koi khuli gaadi nahi')}</p>}
          </div>
        </div>
      )}
    </>
  )
}
