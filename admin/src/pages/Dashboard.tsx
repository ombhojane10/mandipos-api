import { api, type Dashboard as Dash, type DayEntry } from '../api'
import { TrendChart } from '../Chart'
import { usePeriod } from '../hooks'
import { count, rupees } from '../format'
import { href, periodQuery, type Report } from '../routes'
import { useLoad } from '../useLoad'
import { Ages, Change, Kpi, PeriodBar, Skeleton } from '../ui'
import { EntryTable } from './DayBook'
import * as I from '../icons'
import { openEntry, type EntryKind } from '../entries/kinds'
import { t } from '../i18n'

const QUICK: { kind: EntryKind; label: string; sub: string; tone: string; icon: () => React.ReactNode }[] = [
  { kind: 'parchi', label: t('Nayi Parchi'), sub: t('Bikri'), tone: 'green', icon: I.IRupee },
  { kind: 'vasooli', label: t('Vasooli'), sub: t('Grahak se paisa'), tone: 'blue', icon: I.IWallet },
  { kind: 'kharcha', label: t('Kharcha'), sub: t('Day book'), tone: 'red', icon: I.ICash },
  { kind: 'gaadi', label: t('Nayi Gaadi'), sub: t('Kharid'), tone: 'amber', icon: I.ITruck },
]

/** The shop at a glance, like the first page of Tally: four figures, the trend, and what happened last. */
export function Dashboard({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod()
  const { data, error, loading } = useLoad(async () => {
    const [d, book] = await Promise.all([
      api<Dash>(`/v1/admin/shops/${shopId}/dashboard?from=${period.from}&to=${period.to}`),
      api<{ entries: DayEntry[] }>(`/v1/admin/shops/${shopId}/daybook?from=${period.from}&to=${period.to}`),
    ])
    return { d, recent: book.entries.slice(0, 8) }
  }, [shopId, period.from, period.to])
  const to = (report: Report) => href({ page: 'report', shopId, report }) + periodQuery()

  return (
    <>
      <div className="quick" style={{ marginBottom: 16 }}>
        {QUICK.map((q) => (
          <button key={q.kind} type="button" onClick={() => openEntry(q.kind)}>
            <span className={`ic t-${q.tone}`}><q.icon /></span><span><b>{q.label}</b><small className="muted">{q.sub}</small></span>
          </button>
        ))}
      </div>
      <div className="toolbar"><PeriodBar value={period} onChange={setPeriod} /></div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton rows={8} /> : (
        <div className={`stack${loading ? ' dim' : ''}`}>
          <div className="grid g4">
            <Kpi icon={<I.IRupee />} tone="green" label={t('Bikri')} value={rupees(data.d.now.salesPaise)} to={to('daybook')}
              sub={<><Change now={data.d.now.salesPaise} before={data.d.before.salesPaise} /> · {t('{n} parchi', { n: count(data.d.now.slips) })}</>} />
            <Kpi icon={<I.ICart />} tone="blue" label={t('Kharid')} value={rupees(data.d.now.purchasePaise)} to={to('suppliers')}
              sub={<><Change now={data.d.now.purchasePaise} before={data.d.before.purchasePaise} /> · {t('{n} gaadi', { n: count(data.d.now.gaadis) })}</>} />
            <Kpi icon={<I.IUdhaar />} tone="amber" label={t('Udhaar (lena)')} value={<span className="due">{rupees(data.d.receivables.duePaise)}</span>} to={to('outstanding')}
              sub={t('{n} grahak', { n: count(data.d.receivables.count) })} />
            <Kpi icon={<I.IWallet />} tone="red" label={t('Supplier (dena)')} value={rupees(data.d.payables.duePaise)} to={to('suppliers')}
              sub={t('{n} supplier', { n: count(data.d.payables.count) })} />
          </div>

          <div className="grid g2-1">
            <div className="card">
              <div className="hd"><h3>{t('Bikri aur Kharid')}</h3></div>
              <div className="bd">{data.d.trend.some((t) => t.salesPaise || t.purchasePaise) ? <TrendChart data={data.d.trend} /> : <p className="empty">{t('Is hafte koi bikri ya kharid nahi')}</p>}</div>
            </div>
            <div className="card">
              <div className="hd"><h3>{t('Sabse zyada bika')}</h3><a href={to('items')}>{t('Sab')} ›</a></div>
              <div className="bd lines-list">
                {data.d.items.map((it, i) => (
                  <div key={it.brand}>
                    <span className="rank">{i + 1}</span>
                    <span className="grow"><b>{it.brand}</b><small>{t('{n} nag', { n: count(it.nags) })}</small></span>
                    <span className="money b">{rupees(it.amountPaise)}</span>
                  </div>
                ))}
                {data.d.items.length === 0 && <p className="empty">{t('Is period mein bikri nahi')}</p>}
              </div>
            </div>
          </div>

          <div>
            <div className="card">
              <div className="hd"><h3>{t('Taaza entries')}</h3><a href={to('daybook')}>{t('Day Book')} ›</a></div>
              <EntryTable shopId={shopId} entries={data.recent} compact />
            </div>
          </div>

          <div className="grid g4 stack-sm">
            <a className="card" href={to('cashbook')}>
              <div className="hd"><h3>{t('Cash aur Bank')}</h3></div>
              <div className="bd">
                <div className="big-fig">
                  <span className="lb">{t('Abhi kul')}</span>
                  <span className="v">{rupees(data.d.cash.galla + data.d.cash.office + data.d.cash.bank)}</span>
                </div>
                <div className="ages" style={{ marginTop: 10 }}>
                  <div><span className="dot" style={{ background: '#16a34a' }} /><span>{t('Galla')}</span><span className="money">{rupees(data.d.cash.galla)}</span></div>
                  <div><span className="dot" style={{ background: '#a3a3a3' }} /><span>{t('Office')}</span><span className="money">{rupees(data.d.cash.office)}</span></div>
                  <div><span className="dot" style={{ background: '#2563eb' }} /><span>{t('Bank / UPI')}</span><span className="money">{rupees(data.d.cash.bank)}</span></div>
                </div>
              </div>
            </a>
            <a className="card" href={to('outstanding')}>
              <div className="hd"><h3>{t('Udhaar · kitna purana')}</h3></div>
              <div className="bd">
                <span className="money b due" style={{ fontSize: 18 }}>{rupees(data.d.receivables.duePaise)}</span>
                <Ages b={data.d.receivables} />
              </div>
            </a>
            <a className="card" href={to('suppliers')}>
              <div className="hd"><h3>{t('Supplier · kitna purana')}</h3></div>
              <div className="bd">
                <span className="money b" style={{ fontSize: 18 }}>{rupees(data.d.payables.duePaise)}</span>
                <Ages b={data.d.payables} />
              </div>
            </a>
            <StockCard shopId={shopId} />
          </div>
        </div>
      )}
    </>
  )
}

function StockCard({ shopId }: { shopId: string }) {
  const { data } = useLoad(() => api<{ totals: { left: number; valuePaise: number; gaadis: number; stale: number } }>(`/v1/admin/shops/${shopId}/stock`), [shopId])
  return (
    <a className="card" href={href({ page: 'report', shopId, report: 'stock' })}>
      <div className="hd"><h3>{t('Stock')}</h3></div>
      <div className="bd">
        {!data ? <div className="sk" /> : (
          <>
            <span className="money b" style={{ fontSize: 18 }}>{t('{n} nag', { n: count(data.totals.left) })}</span>
            <div className="ages" style={{ marginTop: 10 }}>
              <div><span /><span>{t('Kharid bhav par')}</span><span className="money">{rupees(data.totals.valuePaise)}</span></div>
              <div><span /><span>{t('Khuli gaadi')}</span><span className="money">{count(data.totals.gaadis)}</span></div>
              <div><span /><span>{t('Purani gaadi')}</span><span className={`money${data.totals.stale ? ' due b' : ''}`}>{count(data.totals.stale)}</span></div>
            </div>
          </>
        )}
      </div>
    </a>
  )
}
