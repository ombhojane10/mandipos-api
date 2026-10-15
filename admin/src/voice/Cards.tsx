import { memo } from 'react'
import { count, date, rupees } from '../format'
import { t } from '../i18n'
import { href } from '../routes'

type Summary = {
  from: string; to: string; salesPaise: number; slips: number; nags: number; cashPaise: number; upiPaise: number; creditPaise: number
  collectedCashPaise: number; collectedUpiPaise: number; collections: number; labourPaise: number
}
/** An answer, as the server worked it out from the shop's books (PortalVoiceService.cards). */
export type Card =
  | { view: 'udhaar'; buyerId: string; name: string; balancePaise: number; lastSlipOn: string | null; recent: { date: string; title: string; debitPaise: number; creditPaise: number }[] }
  | { view: 'udhaar_list'; totalPaise: number; count: number; rows: { buyerId: string; name: string; duePaise: number }[] }
  | ({ view: 'bikri' | 'vasooli' | 'mazdoori' } & Summary)
  | { view: 'galla'; from: string; to: string; openingPaise: number; inPaise: number; outPaise: number; closingPaise: number }
  | { view: 'stock'; totalLeft: number; rows: { truckId: string; number: string; supplier: string; left: number }[] }
  | { view: 'supplier'; totalPaise: number; rows: { key: string; name: string; duePaise: number }[] }
  | { view: 'parchi'; from: string; to: string; count: number; rows: { id: string; title: string; party: string; nags: number; amountPaise: number }[] }

const span = (from: string, to: string) => (from === to ? date(from) : `${date(from)} – ${date(to)}`)

function Row({ label, value, tone, to }: { label: string; value: string; tone?: 'due' | 'jama'; to?: string }) {
  const body = <><span>{label}</span><b className={tone}>{value}</b></>
  return to ? <a className="vc-row" href={to}>{body}</a> : <div className="vc-row">{body}</div>
}

function Head({ label, value, tone }: { label: string; value: string; tone?: 'due' | 'jama' }) {
  return <div className="vc-head"><small>{label}</small><strong className={tone}>{value}</strong></div>
}

/** One answer card. Memoised: a card never changes once shown, and the meter must not redraw it. */
export const VoiceCard = memo(function VoiceCard({ c, shopId }: { c: Card; shopId: string }) {
  switch (c.view) {
    case 'udhaar':
      return (
        <div className="vc">
          <Head label={c.name} value={c.balancePaise > 0 ? rupees(c.balancePaise) : c.balancePaise < 0 ? `${t('Jama')} ${rupees(-c.balancePaise)}` : t('Kuch baaki nahi')}
            tone={c.balancePaise > 0 ? 'due' : 'jama'} />
          {c.recent.map((r, i) => <Row key={i} label={`${date(r.date)} · ${r.title}`} value={rupees(r.debitPaise || r.creditPaise)} tone={r.creditPaise ? 'jama' : undefined} />)}
          <a className="vc-link" href={href({ page: 'grahak', shopId, buyerId: c.buyerId })}>{t('Khata kholein')}</a>
        </div>
      )
    case 'udhaar_list':
      return (
        <div className="vc">
          <Head label={t('Kul udhaar · {n} grahak', { n: c.count })} value={rupees(c.totalPaise)} tone="due" />
          {c.rows.map((r) => <Row key={r.buyerId} label={r.name} value={rupees(r.duePaise)} to={href({ page: 'grahak', shopId, buyerId: r.buyerId })} />)}
          <a className="vc-link" href={href({ page: 'report', shopId, report: 'outstanding' })}>{t('Sab dekhein')}</a>
        </div>
      )
    case 'bikri':
      return (
        <div className="vc">
          <Head label={`${t('Bikri')} · ${span(c.from, c.to)}`} value={rupees(c.salesPaise)} />
          <Row label={t('Parchi · dana')} value={`${count(c.slips)} · ${count(c.nags)}`} />
          <Row label={t('Cash')} value={rupees(c.cashPaise)} />
          <Row label="UPI" value={rupees(c.upiPaise)} />
          <Row label={t('Udhaar')} value={rupees(c.creditPaise)} tone="due" />
          <a className="vc-link" href={href({ page: 'report', shopId, report: 'daybook' })}>{t('Day book')}</a>
        </div>
      )
    case 'vasooli':
      return (
        <div className="vc">
          <Head label={`${t('Vasooli')} · ${span(c.from, c.to)}`} value={rupees(c.collectedCashPaise + c.collectedUpiPaise)} tone="jama" />
          <Row label={t('Cash')} value={rupees(c.collectedCashPaise)} />
          <Row label="UPI" value={rupees(c.collectedUpiPaise)} />
          <Row label={t('Raseed')} value={count(c.collections)} />
          <a className="vc-link" href={href({ page: 'report', shopId, report: 'vasooli' })}>{t('Vasooli kholein')}</a>
        </div>
      )
    case 'mazdoori':
      return <div className="vc"><Head label={`${t('Mazdoori')} · ${span(c.from, c.to)}`} value={rupees(c.labourPaise)} /></div>
    case 'galla':
      return (
        <div className="vc">
          <Head label={`${t('Galla')} · ${span(c.from, c.to)}`} value={rupees(c.closingPaise)} />
          <Row label={t('Shuru')} value={rupees(c.openingPaise)} />
          <Row label={t('Aaya')} value={rupees(c.inPaise)} tone="jama" />
          <Row label={t('Gaya')} value={rupees(c.outPaise)} tone="due" />
          <a className="vc-link" href={href({ page: 'report', shopId, report: 'cashbook' })}>{t('Cash book')}</a>
        </div>
      )
    case 'stock':
      return (
        <div className="vc">
          <Head label={t('Maal bacha')} value={`${count(c.totalLeft)} ${t('dana')}`} />
          {c.rows.map((r) => <Row key={r.truckId} label={`${r.number}${r.supplier ? ` · ${r.supplier}` : ''}`} value={count(r.left)} />)}
          <a className="vc-link" href={href({ page: 'report', shopId, report: 'stock' })}>{t('Stock kholein')}</a>
        </div>
      )
    case 'supplier':
      return (
        <div className="vc">
          <Head label={t('Supplier ko dena')} value={rupees(c.totalPaise)} tone="due" />
          {c.rows.map((r) => <Row key={r.key} label={r.name} value={rupees(r.duePaise)} to={href({ page: 'supplier', shopId, key: r.key })} />)}
        </div>
      )
    case 'parchi':
      return (
        <div className="vc">
          <Head label={`${t('Parchi')} · ${span(c.from, c.to)}`} value={count(c.count)} />
          {c.rows.map((r) => <Row key={r.id} label={`${r.title} · ${r.party}`} value={rupees(r.amountPaise)} />)}
        </div>
      )
  }
})

/** A free question's answer: what the books returned, as a small table. */
export type Answer = { title: string; columns: string[]; rows: Record<string, string | number | boolean | null>[]; say: string; speak: string }

/** Columns that hold rupees (by their Hinglish names), shown as ₹. */
const MONEY = /(udhaar|rakam|kharid|baaki|mila|cash|upi|bhav|jama|amount|bikri|vasooli|total)/i

function value(col: string, v: string | number | boolean | null) {
  if (v === null || v === '') return '—'
  if (typeof v === 'boolean') return v ? '✓' : ''
  if (typeof v === 'number') return MONEY.test(col) ? (Number.isInteger(v) ? rupees(v * 100) : `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`) : count(v)
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? date(v) : v
}

const label = (c: string) => c.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase())

export const AnswerTable = memo(function AnswerTable({ a, shopId }: { a: Answer; shopId: string }) {
  if (!a.rows.length) return null
  // One value: no table, just the figure.
  if (a.rows.length === 1 && a.columns.length === 1) return <div className="vc"><Head label={label(a.columns[0])} value={value(a.columns[0], a.rows[0][a.columns[0]])} /></div>
  return (
    <div className="vc vc-scroll">
      <table className="vc-table">
        <thead><tr>{a.columns.map((c) => <th key={c} className={typeof a.rows[0][c] === 'number' ? 'num' : undefined}>{label(c)}</th>)}</tr></thead>
        <tbody>
          {a.rows.slice(0, 20).map((r, i) => {
            const buyer = typeof r.grahak_id === 'string' ? r.grahak_id : null
            return (
              <tr key={i} className={buyer ? 'link' : undefined} onClick={buyer ? () => { location.hash = href({ page: 'grahak', shopId, buyerId: buyer }) } : undefined}>
                {a.columns.map((c) => <td key={c} className={typeof r[c] === 'number' ? 'num' : undefined}>{value(c, r[c])}</td>)}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
})
