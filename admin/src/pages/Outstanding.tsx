import { useState } from 'react'
import { api, type Outstanding as Out } from '../api'
import { count, phone, rupees, shortDate } from '../format'
import { hashQuery, href, setHashQuery } from '../routes'
import { useLoad } from '../useLoad'
import { Skeleton } from '../ui'
import { t } from '../i18n'
import { fileName, useExport } from '../export/doc'

const VIEWS = [{ key: 'sab', label: t('Sab') }, { key: '30', label: t('30+ din') }, { key: '8', label: t('8+ din') }] as const
type View = (typeof VIEWS)[number]['key']

/** Tally's Outstanding: who owes, how much, how old — biggest first. */
export function Outstanding({ shopId }: { shopId: string }) {
  const [view, setView] = useState<View>(() => VIEWS.find((v) => v.key === hashQuery().get('v'))?.key ?? 'sab')
  const [q, setQ] = useState('')
  const { data, error } = useLoad(() => api<Out>(`/v1/admin/shops/${shopId}/outstanding`), [shopId])
  const pick = (v: View) => { setView(v); setHashQuery({ ...Object.fromEntries(hashQuery()), v }) }
  const query = q.trim().toLowerCase()
  const rows = (data?.rows ?? [])
    .filter((r) => view === 'sab' || (view === '30' ? r.d31 > 0 : r.d8_30 + r.d31 > 0))
    .filter((r) => !query || `${r.name} ${r.phone} ${r.code}`.toLowerCase().includes(query))

  useExport(data ? () => ({
    title: t('Outstanding'), period: VIEWS.find((v) => v.key === view)!.label, file: fileName(t('Outstanding'), view),
    summary: [[t('Kul udhaar (lena)'), rupees(data.totals.duePaise)], [t('Grahak'), count(data.totals.count)]],
    columns: [{ label: t('Code') }, { label: t('Grahak'), wide: true }, { label: t('0–7 din'), num: true }, { label: t('8–30 din'), num: true }, { label: t('30+ din'), num: true }, { label: t('Kul baaki'), num: true }, { label: t('Aakhri parchi') }],
    rows: rows.map((r) => ({ cells: [r.code, [r.name, r.phone && phone(r.phone)].filter(Boolean).join(' · '), r.d0_7 ? rupees(r.d0_7) : '', r.d8_30 ? rupees(r.d8_30) : '', r.d31 ? rupees(r.d31) : '', rupees(r.duePaise), r.lastSlipOn ? shortDate(r.lastSlipOn) : '—'] })),
    foot: ['', t('Kul'), rupees(rows.reduce((s, r) => s + r.d0_7, 0)), rupees(rows.reduce((s, r) => s + r.d8_30, 0)), rupees(rows.reduce((s, r) => s + r.d31, 0)), rupees(rows.reduce((s, r) => s + r.duePaise, 0)), ''],
  }) : null, [data, view, query])

  return (
    <>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className="stack">
          <div className="card sum">
            <div><span className="lb">{t('Kul udhaar (lena)')}</span><span className="v due">{rupees(data.totals.duePaise)}</span></div>
            <div><span className="lb">{t('Grahak')}</span><span className="v">{count(data.totals.count)}</span></div>
            <div><span className="lb">{t('30+ din')}</span><span className={`v${data.totals.d31 ? ' due' : ''}`}>{rupees(data.totals.d31)}</span></div>
          </div>
          <div className="toolbar" style={{ margin: 0 }}>
            <input className="field grow" data-search type="search" placeholder={t('Naam, mobile ya code')} value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="seg" role="group">
              {VIEWS.map((v) => <button key={v.key} aria-pressed={view === v.key} onClick={() => pick(v.key)}>{v.label}</button>)}
            </div>
          </div>
          <div className="card wrap-x">
            <table className="tbl fold">
              <thead><tr><th>{t('Code')}</th><th>{t('Grahak')}</th><th className="num">{t('0–7 din')}</th><th className="num">{t('8–30 din')}</th><th className="num">{t('30+ din')}</th><th className="num">{t('Kul baaki')}</th><th>{t('Aakhri parchi')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.buyerId} data-row tabIndex={0} onClick={() => { location.hash = href({ page: 'grahak', shopId, buyerId: r.buyerId }) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') location.hash = href({ page: 'grahak', shopId, buyerId: r.buyerId }) }}>
                    <td className="code-col">{r.code ? <span className="code">{r.code}</span> : null}</td>
                    <td className="main-col">
                      <b>{r.name}</b>
                      <small>{r.phone ? phone(r.phone) : ''}
                        {r.d31 > 0 && <span className="show-sm due"> · {t('30+ din')} {rupees(r.d31)}</span>}</small>
                    </td>
                    <td className="num opt-col money">{r.d0_7 ? rupees(r.d0_7) : ''}</td>
                    <td className="num opt-col money">{r.d8_30 ? rupees(r.d8_30) : ''}</td>
                    <td className={`num opt-col money${r.d31 ? ' due b' : ''}`}>{r.d31 ? rupees(r.d31) : ''}</td>
                    <td className="num amt-col money b due">{rupees(r.duePaise)}</td>
                    <td className="opt-col muted">{r.lastSlipOn ? shortDate(r.lastSlipOn) : '—'}{r.oldestDays !== null && r.oldestDays > 7 ? <small>{t('{n} din purana', { n: r.oldestDays })}</small> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="empty">{data.rows.length ? t('Is filter mein koi nahi') : t('Kisi par udhaar nahi')}</p>}
          </div>
        </div>
      )}
    </>
  )
}
