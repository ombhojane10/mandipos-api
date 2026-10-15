import { useEffect, useState } from 'react'
import { api, type BuyerDetail, type BuyerRow } from '../api'
import { useSession } from '../App'
import { count, phone, rupees, shortDate } from '../format'
import { href } from '../routes'
import { useLoad } from '../useLoad'
import { Bal, balText, Crumb, Ledger, Skeleton } from '../ui'
import { t } from '../i18n'
import { fileName, useExport } from '../export/doc'

/** Every grahak of the shop, searchable; biggest baaki first. Enter opens the khata. */
export function GrahakList({ shopId }: { shopId: string }) {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 250); return () => clearTimeout(t) }, [q])
  const { data, error, loading } = useLoad(
    () => api<{ buyers: BuyerRow[] }>(`/v1/admin/shops/${shopId}/buyers?q=${encodeURIComponent(query)}`).then((r) => r.buyers), [shopId, query])

  useExport(data ? () => ({
    title: t('Grahak Ledger'), file: fileName(t('Grahak Ledger')),
    columns: [{ label: t('Grahak'), wide: true }, { label: t('Mobile') }, { label: t('Kharida'), num: true }, { label: t('Aakhri parchi') }, { label: t('Baaki'), num: true }],
    rows: data.map((b) => ({ cells: [[b.name, b.code && `A/C ${b.code}`].filter(Boolean).join(' · '), b.phone ? phone(b.phone) : '', rupees(b.boughtPaise), b.lastSlipOn ? shortDate(b.lastSlipOn) : '—', balText(b.balancePaise)] })),
    foot: [t('Kul'), '', rupees(data.reduce((s, b) => s + b.boughtPaise, 0)), '', balText(data.reduce((s, b) => s + b.balancePaise, 0))],
  }) : null, [data])

  return (
    <>
      <div className="toolbar"><input className="field grow" data-search type="search" placeholder={t('Naam, mobile ya A/C code')} value={q} autoFocus onChange={(e) => setQ(e.target.value)} /></div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`card wrap-x${loading ? ' dim' : ''}`}>
          <table className="tbl fold">
            <thead><tr><th>{t('Grahak')}</th><th>{t('Mobile')}</th><th className="num">{t('Kharida')}</th><th>{t('Aakhri parchi')}</th><th className="num">{t('Baaki')}</th></tr></thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id} data-row tabIndex={0} onClick={() => { location.hash = href({ page: 'grahak', shopId, buyerId: b.id }) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') location.hash = href({ page: 'grahak', shopId, buyerId: b.id }) }}>
                  <td className="main-col"><b>{b.name}</b><small>{[b.code && `A/C ${b.code}`, b.hidden && t('Chhupa hua')].filter(Boolean).join(' · ')}<span className="show-sm">{b.phone ? ` ${phone(b.phone)}` : ''}</span></small></td>
                  <td className="opt-col muted">{b.phone ? phone(b.phone) : '—'}</td>
                  <td className="num opt-col money">{rupees(b.boughtPaise)}</td>
                  <td className="opt-col muted">{b.lastSlipOn ? shortDate(b.lastSlipOn) : '—'}</td>
                  <td className="num amt-col"><Bal paise={b.balancePaise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.length === 0 && <p className="empty">{t('Koi grahak nahi mila')}</p>}
        </div>
      )}
    </>
  )
}

/** One grahak's khata at this shop — Tally's Ledger Vouchers for a party. */
export function GrahakKhata({ shopId, buyerId }: { shopId: string; buyerId: string }) {
  const { me } = useSession()
  const back = href({ page: 'report', shopId, report: 'ledger' })
  const { data, error } = useLoad(() => api<BuyerDetail>(`/v1/admin/shops/${shopId}/buyers/${buyerId}`), [shopId, buyerId])
  if (error) return <><Crumb to={back}>{t('Grahak Ledger')}</Crumb><p className="error">{error}</p></>
  if (!data) return <><Crumb to={back}>{t('Grahak Ledger')}</Crumb><Skeleton /></>
  const { buyer: b, totals: tot, history } = data
  const mobile = /^[6-9]\d{9}$/.test(b.phone)

  return (
    <div className="stack">
      <div>
        <Crumb to={back}>{t('Grahak Ledger')}</Crumb>
        <div className="head" style={{ marginBottom: 0 }}>
          <div className="grow">
            <h1>{b.name}</h1>
            <p>{[b.code && `A/C ${b.code}`, b.kind, b.address, b.destination && `→ ${b.destination}`, b.vehicle].filter(Boolean).join(' · ')}</p>
          </div>
          {mobile && <a className="call" href={`tel:+91${b.phone}`}>☎ {phone(b.phone)}</a>}
        </div>
      </div>
      <div className="card sum">
        <div><span className="lb">{t('Baaki')}</span><span className="v"><Bal paise={tot.balancePaise} /></span></div>
        <div><span className="lb">{t('Kharida')}</span><span className="v">{rupees(tot.boughtPaise)}</span></div>
        <div><span className="lb">{t('Diya')}</span><span className="v">{rupees(tot.paidPaise)}</span></div>
        <div><span className="lb">{t('Parchi')}</span><span className="v">{count(tot.slips)} · {t('{n} nag', { n: count(tot.nags) })}</span></div>
        {b.creditLimitPaise > 0 && <div><span className="lb">{t('Limit')}</span><span className="v">{rupees(b.creditLimitPaise)}</span></div>}
        {me?.admin && mobile && <div><span className="lb">{t('Poora market')}</span><a className="v call" href={href({ page: 'person', key: b.phone })}>{t('Dekhein')} ›</a></div>}
      </div>
      <Ledger closingPaise={tot.balancePaise} rows={history} shopId={shopId} exportAs={{
        title: t('Grahak Khata'), name: b.name, sub: [b.code && `A/C ${b.code}`, mobile && phone(b.phone), b.address].filter(Boolean).join(' · '),
        summary: [[t('Kharida'), rupees(tot.boughtPaise)], [t('Diya'), rupees(tot.paidPaise)], [t('Baaki'), balText(tot.balancePaise)]],
      }} />
    </div>
  )
}
