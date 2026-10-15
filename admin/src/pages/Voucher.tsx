import { useEffect, useState } from 'react'
import { api } from '../api'
import { count, date, rate, rupees, time } from '../format'
import { VOUCHER_EVENT } from '../keys'
import { href } from '../routes'
import { useLoad } from '../useLoad'
import { t } from '../i18n'

type Bill = {
  id: string; number: string; slipNo: number | null; at: string; date: string; buyerId: string | null; buyerName: string; payMode: string
  totalPaise: number; cashPaise: number; upiPaise: number; labourPaise: number; chungiPaise: number; openPaise: number
  packing: string; panniName: string; packs: number; staff: string; upiBank: string; truck: string | null; machine: string
  lines: { brand: string; grade: string; qty: number; ratePaise: number; leak: boolean }[]
  payments: { id: string; at: string; amountPaise: number; receiptNo: number | null; voided: boolean }[]
  voided: { reason: string; at: string } | null
  delivery: { address: string; stand: string } | null
}

const PACKING: Record<string, string> = { loose: t('Loose'), katta10: t('Katta {n}', { n: 10 }), katta15: t('Katta {n}', { n: 15 }), katta20: t('Katta {n}', { n: 20 }), katta25: t('Katta {n}', { n: 25 }), panni: t('Panni') }

/** Listens for Enter on a parchi anywhere and opens it, as Tally opens a voucher. */
export function VoucherHost() {
  const [open, setOpen] = useState<{ shopId: string; billId: string } | null>(null)
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<{ shopId: string; billId: string }>).detail)
    addEventListener(VOUCHER_EVENT, on)
    return () => removeEventListener(VOUCHER_EVENT, on)
  }, [])
  return open ? <Voucher key={open.billId} shopId={open.shopId} billId={open.billId} onClose={() => setOpen(null)} /> : null
}

function Voucher({ shopId, billId, onClose }: { shopId: string; billId: string; onClose: () => void }) {
  const { data: b, error } = useLoad(() => api<Bill>(`/v1/admin/shops/${shopId}/bills/${billId}`), [shopId, billId])
  const qty = b?.lines.reduce((s, l) => s + l.qty, 0) ?? 0
  return (
    <div className="scrim sheet-scrim" onClick={onClose} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div className="sheet" role="dialog" aria-label={t('Parchi')} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-hd">
          <h3>{t('Parchi')} {b ? `#${b.slipNo ?? b.number}` : ''}</h3>
          {b?.voided && <span className="chip red">{b.voided.reason === 'edited' ? t('Badli gayi') : t('Hatayi gayi')}</span>}
          <button type="button" className="icon-btn" autoFocus aria-label={t('Band karein')} onClick={onClose}>✕</button>
        </div>
        <div className="sheet-bd">
          {error && <p className="error">{error}</p>}
          {!b ? <div className="sk" /> : (
            <>
              <div className="voucher-meta">
                <div><span className="fld-lb">{t('Grahak')}</span><b>{b.buyerName}</b></div>
                <div><span className="fld-lb">{t('Tarikh')}</span><span>{date(b.date)} · {time(b.at)}</span></div>
                {b.truck && <div><span className="fld-lb">{t('Gaadi')}</span><span>{b.truck}</span></div>}
                <div><span className="fld-lb">{t('Machine')}</span><span>{b.machine || '—'}{b.staff && !b.machine.endsWith(b.staff) ? ` · ${b.staff}` : ''}</span></div>
                <div><span className="fld-lb">{t('No.')}</span><span className="muted">{b.number}</span></div>
                <div><span className="fld-lb">{t('Packing')}</span><span>{PACKING[b.packing] ?? b.packing}{b.panniName ? ` · ${b.panniName}` : ''}</span></div>
                {b.delivery && <div><span className="fld-lb">{t('Delivery')}</span><span>{[b.delivery.address, b.delivery.stand].filter(Boolean).join(' · ')}</span></div>}
              </div>
              <table className="tbl">
                <thead><tr><th>{t('Maal')}</th><th className="num">{t('Nag')}</th><th className="num">{t('Bhav')}</th><th className="num">{t('Rakam')}</th></tr></thead>
                <tbody>
                  {b.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.brand} · {t('Grade {g}', { g: l.grade })}{l.leak ? ` · ${t('Leak')}` : ''}</td>
                      <td className="num money">{count(l.qty)}</td>
                      <td className="num money">{rate(l.ratePaise)}</td>
                      <td className="num money">{rupees(l.qty * l.ratePaise)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {b.chungiPaise > 0 && <tr><td>{t('Chungi')}</td><td /><td /><td className="num money">{rupees(b.chungiPaise)}</td></tr>}
                  <tr><td>{t('Kul')}</td><td className="num money">{count(qty)}</td><td /><td className="num money">{rupees(b.totalPaise)}</td></tr>
                </tfoot>
              </table>
              <div className="voucher-pay">
                {b.cashPaise > 0 && <div><span>{t('Cash')}</span><span className="money">{rupees(b.cashPaise)}</span></div>}
                {b.upiPaise > 0 && <div><span>UPI{b.upiBank ? ` · ${b.upiBank}` : ''}</span><span className="money">{rupees(b.upiPaise)}</span></div>}
                {b.payments.map((p) => (
                  <div key={p.id} className={p.voided ? 'muted' : undefined} style={p.voided ? { textDecoration: 'line-through' } : undefined}>
                    <span>{t('Vasooli')}{p.receiptNo ? ` · ${t('Raseed {n}', { n: p.receiptNo })}` : ''} · {date(p.at.slice(0, 10))}</span><span className="money">{rupees(p.amountPaise)}</span>
                  </div>
                ))}
                <div className="b"><span>{b.openPaise > 0 ? t('Baaki') : t('Poora mila')}</span><span className={`money${b.openPaise > 0 ? ' due' : ' jama'}`}>{b.openPaise > 0 ? rupees(b.openPaise) : '✓'}</span></div>
                {b.labourPaise > 0 && <div className="muted"><span>{t('Mazdoori ({n} nag)', { n: count(b.packs) })}</span><span className="money">{rupees(b.labourPaise)}</span></div>}
              </div>
            </>
          )}
        </div>
        {b?.buyerId && (
          <div className="sheet-ft">
            <a className="btn ghost" href={href({ page: 'grahak', shopId, buyerId: b.buyerId })} onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center' }}>{t('{name} ka khata', { name: b.buyerName })} ›</a>
          </div>
        )}
      </div>
    </div>
  )
}
