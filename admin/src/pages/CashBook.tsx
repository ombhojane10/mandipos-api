import { useState } from 'react'
import { api, type CashBook as Book } from '../api'
import { usePeriod } from '../hooks'
import { dayHeader, rupees, shortDate, time } from '../format'
import { hashQuery, setHashQuery } from '../routes'
import { useLoad } from '../useLoad'
import { PeriodBar, Skeleton } from '../ui'
import { HEADS } from './DayBook'
import { t } from '../i18n'
import { dayRange, dmy, fileName, rs, useExport, type ExportRow } from '../export/doc'

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
  // Printed as the app's DaybookPdf: CREDIT (AAYA), DEBIT (GAYA), BACHA, then MALIK and MUNIM.
  useExport(data ? () => {
    const oneDay = data.from === data.to
    const item = (l: Book['lines'][number], paise: number): ExportRow => ({
      cells: [(oneDay ? '' : `${dmy(l.date).slice(0, 5)}  `) + label(l), [l.party, l.note].filter(Boolean).join(' · '), oneDay && !l.auto ? time(l.at) : '', rs(paise)],
    })
    const credit = data.lines.filter((l) => l.inPaise > 0)
    const debit = data.lines.filter((l) => l.outPaise > 0)
    const none: ExportRow = { cells: ['Kuch nahi', '', '', '0'] }
    return {
      style: 'book' as const, title: `DAYBOOK  ·  ${{ galla: 'GALLA', office: 'OFFICE', bank: 'BANK / UPI' }[pot]}`, dateLine: dayRange(data.from, data.to),
      file: fileName('Daybook', pot, period.from, period.to), sign: true,
      note: pot === 'galla' ? 'Galla = nakad bikri + nakad vasooli + nakad aaya - nakad kharcha.' : undefined,
      rows: [
        { kind: 'heading', cells: ['CREDIT  (AAYA)'] },
        ...(credit.length ? credit.map((l) => item(l, l.inPaise)) : [none]),
        { kind: 'total', cells: ['Total credit', '', '', rs(data.inPaise)] },
        { kind: 'heading', cells: ['DEBIT  (GAYA)'] },
        ...(debit.length ? debit.map((l) => item(l, l.outPaise)) : [none]),
        { kind: 'total', cells: ['Total debit', '', '', rs(data.outPaise)] },
        { kind: 'heading', cells: ['BACHA'] },
        { cells: ['Shuru  (b/f)', '', '', rs(data.openingPaise)] },
        { cells: ['Aaj ka  (credit - debit)', '', '', rs(data.inPaise - data.outPaise)] },
        { kind: 'final', cells: ['Bacha  (c/f)', '', '', rs(data.closingPaise)] },
      ],
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
