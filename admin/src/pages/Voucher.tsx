import { useEffect, useState } from 'react'
import { api } from '../api'
import { count, date, rate, rupees, time } from '../format'
import { VOUCHER_EVENT } from '../keys'
import { href } from '../routes'
import { useLoad } from '../useLoad'

type Bill = {
  id: string; number: string; slipNo: number | null; at: string; date: string; buyerId: string | null; buyerName: string; payMode: string
  totalPaise: number; cashPaise: number; upiPaise: number; labourPaise: number; chungiPaise: number; openPaise: number
  packing: string; panniName: string; packs: number; staff: string; upiBank: string; truck: string | null; machine: string
  lines: { brand: string; grade: string; qty: number; ratePaise: number; leak: boolean }[]
  payments: { id: string; at: string; amountPaise: number; receiptNo: number | null; voided: boolean }[]
  voided: { reason: string; at: string } | null
}

const PACKING: Record<string, string> = { loose: 'Loose', katta10: 'Katta 10', katta15: 'Katta 15', katta20: 'Katta 20', katta25: 'Katta 25', panni: 'Panni' }

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
      <div className="sheet" role="dialog" aria-label="Parchi" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-hd">
          <h3>Parchi {b ? `#${b.slipNo ?? b.number}` : ''}</h3>
          {b?.voided && <span className="chip red">{b.voided.reason === 'edited' ? 'Badli gayi' : 'Hatayi gayi'}</span>}
          <button type="button" className="icon-btn" autoFocus aria-label="Band karein" onClick={onClose}>✕</button>
        </div>
        <div className="sheet-bd">
          {error && <p className="error">{error}</p>}
          {!b ? <div className="sk" /> : (
            <>
              <div className="voucher-meta">
                <div><span className="fld-lb">Grahak</span><b>{b.buyerName}</b></div>
                <div><span className="fld-lb">Tarikh</span><span>{date(b.date)} · {time(b.at)}</span></div>
                {b.truck && <div><span className="fld-lb">Gaadi</span><span>{b.truck}</span></div>}
                <div><span className="fld-lb">Machine</span><span>{b.machine || '—'}{b.staff && !b.machine.endsWith(b.staff) ? ` · ${b.staff}` : ''}</span></div>
                <div><span className="fld-lb">No.</span><span className="muted">{b.number}</span></div>
                <div><span className="fld-lb">Packing</span><span>{PACKING[b.packing] ?? b.packing}{b.panniName ? ` · ${b.panniName}` : ''}</span></div>
              </div>
              <table className="tbl">
                <thead><tr><th>Maal</th><th className="num">Nag</th><th className="num">Bhav</th><th className="num">Rakam</th></tr></thead>
                <tbody>
                  {b.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.brand} · Grade {l.grade}{l.leak ? ' · Leak' : ''}</td>
                      <td className="num money">{count(l.qty)}</td>
                      <td className="num money">{rate(l.ratePaise)}</td>
                      <td className="num money">{rupees(l.qty * l.ratePaise)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {b.chungiPaise > 0 && <tr><td>Chungi</td><td /><td /><td className="num money">{rupees(b.chungiPaise)}</td></tr>}
                  <tr><td>Kul</td><td className="num money">{count(qty)}</td><td /><td className="num money">{rupees(b.totalPaise)}</td></tr>
                </tfoot>
              </table>
              <div className="voucher-pay">
                {b.cashPaise > 0 && <div><span>Cash</span><span className="money">{rupees(b.cashPaise)}</span></div>}
                {b.upiPaise > 0 && <div><span>UPI{b.upiBank ? ` · ${b.upiBank}` : ''}</span><span className="money">{rupees(b.upiPaise)}</span></div>}
                {b.payments.map((p) => (
                  <div key={p.id} className={p.voided ? 'muted' : undefined} style={p.voided ? { textDecoration: 'line-through' } : undefined}>
                    <span>Vasooli{p.receiptNo ? ` · Raseed ${p.receiptNo}` : ''} · {date(p.at.slice(0, 10))}</span><span className="money">{rupees(p.amountPaise)}</span>
                  </div>
                ))}
                <div className="b"><span>{b.openPaise > 0 ? 'Baaki' : 'Poora mila'}</span><span className={`money${b.openPaise > 0 ? ' due' : ' jama'}`}>{b.openPaise > 0 ? rupees(b.openPaise) : '✓'}</span></div>
                {b.labourPaise > 0 && <div className="muted"><span>Mazdoori ({count(b.packs)} nag)</span><span className="money">{rupees(b.labourPaise)}</span></div>}
              </div>
            </>
          )}
        </div>
        {b?.buyerId && (
          <div className="sheet-ft">
            <a className="btn ghost" href={href({ page: 'grahak', shopId, buyerId: b.buyerId })} onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center' }}>{b.buyerName} ka khata ›</a>
          </div>
        )}
      </div>
    </div>
  )
}
