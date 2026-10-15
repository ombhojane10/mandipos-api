import { useState } from 'react'
import { api, type DayEntry } from '../api'
import { usePeriod } from '../hooks'
import { count, dayHeader, rupees, time } from '../format'
import { periodLabel } from '../period'
import { hashQuery, href, setHashQuery } from '../routes'
import { useLoad } from '../useLoad'
import { openVoucher } from '../keys'
import { PeriodBar, Skeleton } from '../ui'
import { t } from '../i18n'
import { dayRange, fileName, longDay, rs, type ExportRow, useExport } from '../export/doc'

const FILTERS = [
  { key: 'sab', label: t('Sab') }, { key: 'bikri', label: t('Parchi') }, { key: 'vasooli', label: t('Vasooli') }, { key: 'kharcha', label: t('Kharcha') },
] as const
type Filter = (typeof FILTERS)[number]['key']

/** Money moved between the shop's own books, and mazdoori — not kharcha (as Hisab counts it). */
const NOT_KHARCHA = new Set(['handover', 'float', 'bank_jama', 'bank_nikala', 'mazdoori'])
// eslint-disable-next-line react-refresh/only-export-components
export const HEADS: Record<string, string> = {
  kharcha: t('Kharcha'), mazdoori: t('Mazdoori'), bhada: t('Bhada'), kiraya: t('Kiraya'), tankhwah: t('Tankhwah'), committee_di: t('Committee di'),
  bill: t('Bijli-pani'), udhaar_diya: t('Udhaar diya'), aur_gaya: t('Aur gaya'), supplier: t('Supplier ko diya'), handover: t('Malik ko diya'),
  float: t('Galla ko diya'), bank_jama: t('Bank jama'), bank_nikala: t('Bank se nikala'), udhaar_wapas: t('Udhaar wapas'),
  committee_mili: t('Committee mili'), aur_aaya: t('Aur aaya'),
}

/** Tally's Day Book: every parchi, vasooli and kharcha, newest first; a cancelled parchi struck through. */
export function DayBook({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod()
  const [filter, setFilter] = useState<Filter>(() => FILTERS.find((f) => f.key === hashQuery().get('f'))?.key ?? 'sab')
  const { data, error, loading } = useLoad(
    () => api<{ entries: DayEntry[] }>(`/v1/admin/shops/${shopId}/daybook?from=${period.from}&to=${period.to}`).then((r) => r.entries),
    [shopId, period.from, period.to])
  const pick = (f: Filter) => { setFilter(f); setHashQuery({ ...Object.fromEntries(hashQuery()), f }) }
  const live = (data ?? []).filter((e) => !e.voided)
  const sum = (pred: (e: DayEntry) => boolean) => live.filter(pred).reduce((t, e) => t + e.amountPaise, 0)
  const shown = (data ?? []).filter((e) => filter === 'sab' || (filter === 'bikri' && e.kind === 'slip') || (filter === 'vasooli' && e.kind === 'payment') || (filter === 'kharcha' && (e.kind === 'in' || e.kind === 'out')))

  useExport(data ? () => {
    const rows: ExportRow[] = []
    let day = ''
    for (const e of shown) {
      if (period.from !== period.to && e.date !== day) rows.push({ kind: 'band', cells: [longDay(e.date)] })
      day = e.date
      const v = describe(e)
      rows.push({ strike: !!e.voided, cells: [time(e.at), v.type, v.no, [v.name, v.detail].filter(Boolean).join(' · '), e.nags ? count(e.nags) : '', v.amount, e.voided ? '' : v.pay ?? ''] })
    }
    return {
      style: 'book' as const, title: t('Day Book'), dateLine: dayRange(period.from, period.to), file: fileName(t('Day Book'), period.from, period.to),
      summary: [[t('Parchi'), rs(sum((e) => e.kind === 'slip'))], [t('Vasooli'), rs(sum((e) => e.kind === 'payment'))], [t('Kharcha'), rs(sum((e) => e.kind === 'out' && !NOT_KHARCHA.has(e.title)))]],
      columns: [{ label: t('Samay') }, { label: t('Type') }, { label: t('No.') }, { label: t('Naam'), wide: true }, { label: t('Nag'), num: true }, { label: t('Rakam'), num: true }, { label: t('Payment') }],
      rows,
    }
  } : null, [data, filter, period.from, period.to])

  return (
    <>
      <div className="toolbar">
        <PeriodBar value={period} onChange={setPeriod} />
        <div className="seg" role="group" aria-label={t('Filter')}>
          {FILTERS.map((f) => <button key={f.key} aria-pressed={filter === f.key} onClick={() => pick(f.key)}>{f.label}</button>)}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`stack${loading ? ' dim' : ''}`}>
          <div className="card sum">
            <div><span className="lb">{t('Parchi')}</span><span className="v">{rupees(sum((e) => e.kind === 'slip'))}</span></div>
            <div><span className="lb">{t('Vasooli')}</span><span className="v jama">{rupees(sum((e) => e.kind === 'payment'))}</span></div>
            <div><span className="lb">{t('Kharcha')}</span><span className="v">{rupees(sum((e) => e.kind === 'out' && !NOT_KHARCHA.has(e.title)))}</span></div>
            {sum((e) => e.kind === 'in' && !NOT_KHARCHA.has(e.title)) > 0 && <div><span className="lb">{t('Aaya')}</span><span className="v">{rupees(sum((e) => e.kind === 'in' && !NOT_KHARCHA.has(e.title)))}</span></div>}
          </div>
          <div className="card">
            <EntryTable shopId={shopId} entries={shown} multiDay={period.from !== period.to} />
            {shown.length === 0 && <p className="empty">{t('{p} ko koi entry nahi', { p: periodLabel(period) })}</p>}
          </div>
        </div>
      )}
    </>
  )
}

/** Time · Type · No. · Naam · Nag · Amount · Payment — the Day Book's table, and the dashboard's recent list. */
export function EntryTable({ shopId, entries, multiDay, compact }: { shopId: string; entries: DayEntry[]; multiDay?: boolean; compact?: boolean }) {
  let lastDay = ''
  return (
    <div className="wrap-x">
      <table className="tbl fold">
        <thead>
          <tr>
            <th>{t('Samay')}</th><th>{t('Type')}</th><th className="opt-col">{t('No.')}</th><th>{t('Naam')}</th>
            {!compact && <th className="num">{t('Nag')}</th>}<th className="num">{t('Rakam')}</th><th>{t('Payment')}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const header = multiDay && e.date !== lastDay ? <tr className="day"><td colSpan={compact ? 6 : 7}>{dayHeader(e.date)}</td></tr> : null
            lastDay = e.date
            const v = describe(e)
            // Enter opens what the line is: a parchi as its voucher, a vasooli as the grahak's khata.
            const go = e.kind === 'slip' ? () => openVoucher(shopId, e.id)
              : e.buyerId ? () => { location.hash = href({ page: 'grahak', shopId, buyerId: e.buyerId! }) } : undefined
            return (
              <Rows key={`${e.kind}-${e.id}`}>
                {header}
                <tr data-row tabIndex={0} className={e.voided ? 'void' : undefined}
                  onClick={go} onKeyDown={(ev) => { if (go && ev.key === 'Enter') go() }}>
                  <td className="opt-col muted money">{time(e.at)}</td>
                  <td className="opt-col"><span className={`chip ${v.tone}`}>{v.type}</span></td>
                  <td className="opt-col muted">{v.no}</td>
                  <td className="main-col">
                    <span className="name b">{v.name}</span>
                    <small>
                      <span className="show-sm">{time(e.at)} · {v.type}{v.no ? ` ${v.no}` : ''}{e.voided || v.detail ? ' · ' : ''}</span>
                      {e.voided ? <span className="due">{e.voided === 'edited' ? t('Badli') : t('Hatayi')}</span> : v.detail}
                    </small>
                  </td>
                  {!compact && <td className="num opt-col muted">{e.nags ? count(e.nags) : ''}</td>}
                  <td className={`num amt-col money b${e.voided ? ' muted' : e.kind === 'payment' ? ' jama' : ''}`}>
                    {v.amount}
                    <span className="sm-block">{v.pay && !e.voided && <span className={`chip ${v.payTone}`}>{v.pay}</span>}</span>
                  </td>
                  <td className="opt-col">{v.pay && !e.voided && <span className={`chip ${v.payTone}`}>{v.pay}</span>}</td>
                </tr>
              </Rows>
            )
          })}
        </tbody>
      </table>
      {compact && entries.length === 0 && <p className="empty">{t('Abhi koi entry nahi')}</p>}
    </div>
  )
}

function Rows({ children }: { children: React.ReactNode }) { return <>{children}</> }

function describe(e: DayEntry) {
  if (e.kind === 'slip') {
    const parts = [e.cashPaise && 'Cash', e.upiPaise && 'UPI', e.udhaarPaise && 'Udhaar'].filter(Boolean) as string[]
    const pay = e.payMode === 'free' ? 'Free' : parts.length > 1 ? 'Mixed' : parts[0] ?? 'Udhaar'
    return {
      type: t('Parchi'), tone: 'green', no: e.title.replace(/^Parchi /, ''), name: e.party || t('Cash'),
      detail: [e.nags && t('{n} nag', { n: count(e.nags) }), parts.length > 1 && [e.cashPaise && `${t('Cash')} ${rupees(e.cashPaise)}`, e.upiPaise && `UPI ${rupees(e.upiPaise)}`, e.udhaarPaise && `${t('Udhaar')} ${rupees(e.udhaarPaise)}`].filter(Boolean).join(' + '), e.staff].filter(Boolean).join(' · '),
      amount: rupees(e.amountPaise), pay: t(pay), payTone: pay === 'Udhaar' ? 'amber' : pay === 'UPI' ? 'blue' : pay === 'Mixed' ? 'grey' : 'green',
    }
  }
  if (e.kind === 'payment') {
    const pay = e.cashPaise && e.upiPaise ? 'Mixed' : e.upiPaise ? 'UPI' : 'Cash'
    return {
      type: t('Vasooli'), tone: 'blue', no: e.title.replace(/^Raseed /, '').replace('Vasooli', ''), name: e.party, detail: '',
      amount: rupees(e.amountPaise), pay: t(pay), payTone: pay === 'UPI' ? 'blue' : pay === 'Mixed' ? 'grey' : 'green',
    }
  }
  const book = e.mode === 'upi' || e.mode === 'bank' ? 'Bank' : e.mode === 'office' ? 'Office' : 'Galla'
  return {
    type: e.kind === 'out' ? t('Kharcha') : t('Aaya'), tone: e.kind === 'out' ? 'red' : 'grey', no: '',
    name: HEADS[e.title] ?? (e.title || t('Kharcha')), detail: [e.party, e.note].filter(Boolean).join(' · '),
    amount: `${e.kind === 'out' ? '−' : '+'}${rupees(e.amountPaise)}`, pay: t(book), payTone: 'grey',
  }
}
