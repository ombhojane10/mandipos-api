import { api, type BuyerDetail } from '../api'
import { useShops } from '../App'
import { href } from '../routes'
import { count, date, phone, rupees } from '../format'
import { useLoad } from '../useLoad'
import { Crumb, Ledger, Rows } from '../ui'

/** One grahak's khata at one dukaan — Tally's Ledger Vouchers for a party. */
export function CustomerPage({ shopId, buyerId }: { shopId: string; buyerId: string }) {
  const { shops } = useShops()
  const shopName = shops?.find((s) => s.id === shopId)?.name ?? 'Dukaan'
  const back = href({ page: 'shop', shopId, tab: 'grahak' })
  const { data, error } = useLoad(() => api<BuyerDetail>(`/v1/admin/shops/${shopId}/buyers/${buyerId}`), [shopId, buyerId])
  if (error) return <><Crumb to={back}>{shopName}</Crumb><p className="error">{error}</p></>
  if (!data) return <><Crumb to={back}>{shopName}</Crumb><div className="sk big" /><Rows /></>
  const { buyer: b, totals: t, history } = data
  const where = [b.code && `A/C ${b.code}`, b.kind, b.address, b.destination && `→ ${b.destination}`, b.vehicle].filter(Boolean).join(' · ')
  const mobile = /^[6-9]\d{9}$/.test(b.phone)

  return (
    <>
      <Crumb to={back}>{shopName}</Crumb>
      <div className="head">
        <div className="grow">
          <h1>{b.name}</h1>
          {where && <p>{where}</p>}
        </div>
        {mobile && <a className="call" href={`tel:+91${b.phone}`}>☎ {phone(b.phone)}</a>}
      </div>

      <div className="summary">
        <span className="label">{shopName} ka baaki</span>
        <span className={`big ${t.balancePaise > 0 ? 'due' : t.balancePaise < 0 ? 'jama' : ''}`}>
          {t.balancePaise === 0 ? 'Clear' : rupees(Math.abs(t.balancePaise))}
          {t.balancePaise < 0 && <small className="inline"> jama</small>}
        </span>
        <span className="line">
          Kharida {rupees(t.boughtPaise)} · {count(t.slips)} parchi · {count(t.nags)} nag
          {t.lastSlipOn && ` · Aakhri parchi ${date(t.lastSlipOn)}`}
          {b.creditLimitPaise > 0 && ` · Limit ${rupees(b.creditLimitPaise)}`}
        </span>
        {mobile && <a className="crumb" style={{ marginTop: 8, marginBottom: 0 }} href={href({ page: 'person', key: b.phone })}>Poore market ka khata ›</a>}
      </div>

      <h2>Khata</h2>
      <Ledger closingPaise={t.balancePaise} rows={history} />
    </>
  )
}
