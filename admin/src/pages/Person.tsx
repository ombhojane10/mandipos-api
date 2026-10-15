import { api, type Person } from '../api'
import { href } from '../routes'
import { count, date, phone, rupees, shortDate } from '../format'
import { useLoad } from '../useLoad'
import { Bal, Crumb, Ledger, Rows } from '../ui'

/** One grahak across the market: total baaki, who they owe, and the khata from every dukaan. */
export function PersonPage({ personKey }: { personKey: string }) {
  const { data, error } = useLoad(() => api<Person>(`/v1/admin/customers/${encodeURIComponent(personKey)}`), [personKey])
  if (error) return <><Crumb to="#/">Grahak</Crumb><p className="error">{error}</p></>
  if (!data) return <><Crumb to="#/">Grahak</Crumb><div className="sk big" /><Rows /></>
  const { totals: t, traders, history, profile } = data
  const where = [profile.kind, profile.address, profile.destination && `→ ${profile.destination}`, profile.vehicle].filter(Boolean).join(' · ')
  const last = traders.map((x) => x.lastSlipOn).filter((x): x is string => !!x).sort().at(-1)

  return (
    <>
      <Crumb to="#/">Grahak</Crumb>
      <div className="head">
        <div className="grow">
          <h1>{data.name}</h1>
          {where && <p>{where}</p>}
        </div>
        {data.phone && <a className="call" href={`tel:+91${data.phone}`}>☎ {phone(data.phone)}</a>}
      </div>

      <div className="summary">
        <span className="label">Market mein baaki</span>
        <span className={`big ${t.balancePaise > 0 ? 'due' : t.balancePaise < 0 ? 'jama' : ''}`}>
          {t.balancePaise === 0 ? 'Clear' : rupees(Math.abs(t.balancePaise))}
          {t.balancePaise < 0 && <small className="inline"> jama</small>}
        </span>
        <span className="line">
          {t.owedTo ? `${t.owedTo} dukaan ka udhaar` : 'Kisi ka udhaar nahi'} · Kharida {rupees(t.boughtPaise)} · {count(t.slips)} parchi
          {last && ` · Aakhri parchi ${date(last)}`}
        </span>
      </div>

      <h2>Kis dukaan ka kitna</h2>
      <div className="list">
        {traders.map((x) => (
          <a key={`${x.shopId}-${x.buyerId}`} className="row" data-row href={href({ page: 'customer', shopId: x.shopId, buyerId: x.buyerId })}>
            <span className="grow">
              <b>{x.shopName}</b>
              <small>
                {[x.mandi, x.code && `A/C ${x.code}`, `Kharida ${rupees(x.boughtPaise)}`, x.lastSlipOn && `aakhri ${shortDate(x.lastSlipOn)}`].filter(Boolean).join(' · ')}
              </small>
              {x.marketPaise !== null && <small>Dukaan ke hisaab se market udhaar: {rupees(x.marketPaise)}</small>}
            </span>
            <span className="right amt"><Bal paise={x.balancePaise} /></span>
          </a>
        ))}
      </div>

      <h2>Khata · sab dukaan</h2>
      <Ledger
        withShop closingPaise={t.balancePaise}
        rows={history.map((r) => ({ ...r, shop: r.shopName }))}
      />
    </>
  )
}
