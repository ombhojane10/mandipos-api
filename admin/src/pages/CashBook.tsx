import { useState } from 'react'
import { api, type CashBook as Book } from '../api'
import { usePeriod } from '../hooks'
import { dayHeader, rupees, shortDate, time } from '../format'
import { hashQuery, setHashQuery } from '../routes'
import { useLoad } from '../useLoad'
import { PeriodBar, Skeleton } from '../ui'
import { HEADS } from './DayBook'
import { t } from '../i18n'
import { fileName, useExport } from '../export/doc'
import { periodLabel } from '../period'

const POTS = [{ key: 'galla', label: t('Galla (Cash)') }, { key: 'office', label: t('Office') }, { key: 'bank', label: t('Bank / UPI') }] as const
type Pot = (typeof POTS)[number]['key']

/** Tally's Cash / Bank Book: opening (b/f), every line in and out with a running balance, closing (c/f). */
export function CashBook({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod()
  const [pot, setPot] = useState<Pot>(() => POTS.find((p) => p.key === hashQuery().get('pot'))?.key ?? 'galla')
  const { data, error, loading } = useLoad(
    () => api<Book>(`/v1/admin/shops/${shopId}/cashbook?pot=${pot}&from=${period.from}&to=${period.to}`), [shopId, pot, period.from, period.to])
  const pick = (p: Pot) => { setPot(p); setHashQuery({ ...Object.fromEntries(hashQuery()), pot: p }) }
  let lastDay = ''
  const label = (l: Book['lines'][number]) => l.kind === 'bikri' || l.kind === 'vasooli' ? l.title : HEADS[l.title] ?? (l.title || (l.kind === 'out' ? t('Kharcha') : t('Aaya')))
  useExport(data ? () => {
    const potName = POTS.find((p) => p.key === pot)!.label
    return {
      title: `${t('Cash / Bank Book')} · ${potName}`, period: periodLabel(period), file: fileName(t('Cash / Bank Book'), potName, period.from, period.to),
      summary: [[t('Shuru (b/f)'), rupees(data.openingPaise)], [t('Aaya'), rupees(data.inPaise)], [t('Gaya'), rupees(data.outPaise)], [t('Bacha (c/f)'), rupees(data.closingPaise)]],
      columns: [{ label: t('Tarikh') }, { label: t('Vivaran'), wide: true }, { label: t('Aaya (Dr)'), num: true }, { label: t('Gaya (Cr)'), num: true }, { label: t('Balance'), num: true }],
      rows: [
        { bold: true, cells: [shortDate(data.from), t('Shuru ka balance'), '', '', rupees(data.openingPaise)] },
        ...data.lines.map((l) => ({ cells: [shortDate(l.date), [label(l), l.party, l.note].filter(Boolean).join(' · '), l.inPaise ? rupees(l.inPaise) : '', l.outPaise ? rupees(l.outPaise) : '', rupees(l.balancePaise)] })),
      ],
      foot: ['', t('Bacha (c/f)'), rupees(data.inPaise), rupees(data.outPaise), rupees(data.closingPaise)],
    }
  } : null, [data, pot])

  return (
    <>
      <div className="toolbar">
        <div className="seg" role="group" aria-label={t('Book')}>
          {POTS.map((p) => <button key={p.key} aria-pressed={pot === p.key} onClick={() => pick(p.key)}>{p.label}</button>)}
        </div>
        <PeriodBar value={period} onChange={setPeriod} />
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`stack${loading ? ' dim' : ''}`}>
          <div className="card sum">
            <div><span className="lb">{t('Shuru (b/f)')}</span><span className="v">{rupees(data.openingPaise)}</span></div>
            <div><span className="lb">{t('Aaya')}</span><span className="v jama">+{rupees(data.inPaise)}</span></div>
            <div><span className="lb">{t('Gaya')}</span><span className="v due">−{rupees(data.outPaise)}</span></div>
            <div><span className="lb">{t('Bacha (c/f)')}</span><span className="v">{rupees(data.closingPaise)}</span></div>
          </div>
          <div className="card wrap-x">
            <table className="tbl fold">
              <thead><tr><th>{t('Tarikh')}</th><th>{t('Vivaran')}</th><th className="num">{t('Aaya (Dr)')}</th><th className="num">{t('Gaya (Cr)')}</th><th className="num">{t('Balance')}</th></tr></thead>
              <tbody>
                <tr>
                  <td className="opt-col muted">{shortDate(data.from)}</td><td className="main-col"><b>{t('Shuru ka balance')}</b></td>
                  <td className="opt-col" /><td className="opt-col" /><td className="num amt-col money b">{rupees(data.openingPaise)}</td>
                </tr>
                {data.lines.map((l) => {
                  const header = l.date !== lastDay ? <tr className="day show-day"><td colSpan={5}>{dayHeader(l.date)}</td></tr> : null
                  lastDay = l.date
                  const title = label(l)
                  const detail = [l.party, l.note, !l.auto && time(l.at)].filter(Boolean).join(' · ')
                  return (
                    <Rows key={l.id}>
                      {header}
                      <tr>
                        <td className="opt-col muted">{shortDate(l.date)}</td>
                        <td className="main-col"><b>{title}</b><small>{detail}</small></td>
                        <td className="num opt-col money">{l.inPaise ? rupees(l.inPaise) : ''}</td>
                        <td className="num opt-col money">{l.outPaise ? rupees(l.outPaise) : ''}</td>
                        <td className="num amt-col">
                          <span className={`sm-block money b ${l.inPaise ? 'jama' : 'due'}`}>{l.inPaise ? `+${rupees(l.inPaise)}` : `−${rupees(l.outPaise)}`}</span>
                          <span className="money">{rupees(l.balancePaise)}</span>
                        </td>
                      </tr>
                    </Rows>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className="opt-col" /><td className="main-col">{t('Bacha (c/f)')}</td>
                  <td className="num opt-col money">{rupees(data.inPaise)}</td><td className="num opt-col money">{rupees(data.outPaise)}</td>
                  <td className="num amt-col money">{rupees(data.closingPaise)}</td>
                </tr>
              </tfoot>
            </table>
            {data.lines.length === 0 && <p className="empty">{t('Is period mein koi len-den nahi')}</p>}
          </div>
        </div>
      )}
    </>
  )
}

function Rows({ children }: { children: React.ReactNode }) { return <>{children}</> }
