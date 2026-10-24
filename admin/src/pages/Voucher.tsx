import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { api } from '../api'
import { count, date, rate, rupees, time } from '../format'
import { VOUCHER_EVENT, openVoucher, type VoucherRef } from '../keys'
import { href } from '../routes'
import { booksChanged, useLoad } from '../useLoad'
import { editEntry } from '../entries/kinds'
import { t } from '../i18n'

type Bill = {
  id: string; number: string; slipNo: number | null; at: string; date: string; buyerId: string | null; buyerName: string; payMode: string
  totalPaise: number; paidPaise: number; cashPaise: number; upiPaise: number; labourPaise: number; chungiPaise: number; openPaise: number
  packing: string; panniName: string; packs: number; staff: string; upiBank: string; truckId: string | null; truck: string | null; machine: string
  lines: { brand: string; grade: string; qty: number; ratePaise: number; leak: boolean }[]
  payments: { id: string; at: string; amountPaise: number; receiptNo: number | null; voided: boolean }[]
  collected: { cashPaise: number; upiPaise: number }
  pickedQty?: number
  voided: { reason: string; at: string; by: string } | null
  delivery: { address: string; stand: string } | null
}
type Raseed = {
  id: string; receiptNo: number | null; buyerId: string; buyerName: string; at: string; date: string
  cashPaise: number; upiPaise: number; ref: string; upiBank: string; machine: string
  slips: { billId: string; slipNo: number | null; amountPaise: number }[]
  voided: { reason: string; at: string } | null
}

const PACKING: Record<string, string> = { loose: t('Loose'), katta10: t('Katta {n}', { n: 10 }), katta15: t('Katta {n}', { n: 15 }), katta20: t('Katta {n}', { n: 20 }), katta25: t('Katta {n}', { n: 25 }), panni: t('Panni') }
const VOIDED: Record<string, string> = { edited: t('Badli gayi'), deleted: t('Hatayi gayi'), refunded: t('Paisa wapas'), advance: t('Advance mein') }

/** Tally's voucher keys: A alters, D (or Alt+D, Alt+X) deletes. */
const voucherKey = (e: KeyboardEvent): 'alter' | 'delete' | null => {
  if (e.ctrlKey || e.metaKey) return null
  const k = e.altKey ? e.code.replace(/^Key/, '').toLowerCase() : e.key.toLowerCase()
  return k === 'a' ? 'alter' : k === 'd' || (e.altKey && k === 'x') ? 'delete' : null
}

/** Listens for Enter on a parchi or raseed anywhere and opens it, as Tally opens a voucher. */
export function VoucherHost() {
  const [open, setOpen] = useState<VoucherRef | null>(null)
  const [toast, setToast] = useState('')
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<VoucherRef>).detail)
    addEventListener(VOUCHER_EVENT, on)
    return () => removeEventListener(VOUCHER_EVENT, on)
  }, [])
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 3500); return () => clearTimeout(id) }, [toast])
  const close = () => setOpen(null)
  const done = (msg: string) => { booksChanged(); setOpen(null); setToast(msg) }
  return (
    <>
      {open && 'billId' in open && <Voucher key={open.billId} shopId={open.shopId} billId={open.billId} onClose={close} onDone={done} />}
      {open && 'raseedId' in open && <RaseedVoucher key={open.raseedId} shopId={open.shopId} id={open.raseedId} onClose={close} onDone={done} />}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </>
  )
}

type VoucherProps = { shopId: string; onClose: () => void; onDone: (msg: string) => void }

function Voucher({ shopId, billId, onClose, onDone }: VoucherProps & { billId: string }) {
  const { data: b, error } = useLoad(() => api<Bill>(`/v1/admin/shops/${shopId}/bills/${billId}`), [shopId, billId])
  const [deleting, setDeleting] = useState(false)
  const [blocked, setBlocked] = useState('')
  const qty = b?.lines.reduce((s, l) => s + l.qty, 0) ?? 0
  const live = !!b && !b.voided
  // Angoor: boxes handed over at the gaadi against it — the slip stays as it went, as in the app.
  const picked = !!b?.pickedQty
  const paidLater = !!b && b.collected.cashPaise + b.collected.upiPaise > 0
  // As ParchiDoneScreen: once vasooli is taken on a slip it stays as written — it can only be deleted.
  const alter = () => {
    if (!b || !live || picked) return
    if (paidLater) return setBlocked(t('Is parchi par vasooli ho chuki hai — badal nahi sakte, sirf hata sakte hain'))
    if (b.lines.some((l) => l.leak)) return setBlocked(t('Leak wali parchi app se badlein'))
    onClose()
    editEntry({ kind: 'parchi', bill: b })
  }
  const remove = () => { if (live && !picked) setDeleting(true) }
  return (
    <Scrim label={t('Parchi')} onClose={onClose} onKey={(k) => (k === 'alter' ? alter() : remove())}
      title={<>{t('Parchi')} {b ? `#${b.slipNo ?? b.number}` : ''}</>}
      chip={b?.voided ? <span className="chip red">{VOIDED[b.voided.reason] ?? b.voided.reason}</span> : picked ? <span className="chip green">{t('Dispatch: {n} box diye', { n: String(b?.pickedQty) })}</span> : null}
      footer={b && (
        <>
          {b.buyerId && <a className="btn ghost" href={href({ page: 'grahak', shopId, buyerId: b.buyerId })} onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', marginRight: 'auto' }}>{t('{name} ka khata', { name: b.buyerName })} ›</a>}
          {live && picked && <span className="muted">{t('Maal uth chuka hai — yeh parchi ab nahi badlegi')}</span>}
          {live && !picked && <button type="button" className="btn ghost" onClick={alter}><kbd>A: </kbd>{t('Alter')}</button>}
          {live && !picked && <button type="button" className="btn ghost" onClick={remove}><kbd>D: </kbd>{t('Delete')}</button>}
        </>
      )}>
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
            {b.voided && <div><span className="fld-lb">{VOIDED[b.voided.reason] ?? b.voided.reason}</span><span>{date(b.voided.at.slice(0, 10))} · {time(b.voided.at)}{b.voided.by ? ` · ${b.voided.by}` : ''}</span></div>}
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
          {blocked && <p className="error" role="alert">{blocked}</p>}
        </>
      )}
      {deleting && b && <DeleteParchi shopId={shopId} b={b} qty={qty} onClose={() => setDeleting(false)} onDone={onDone} />}
    </Scrim>
  )
}

/**
 * Hatayein, as ParchiDoneScreen asks it. Nothing paid: the slip goes and its dana go back on the
 * gaadi. Money on it: first, what happens to the money — handed back (cash from the galla; UPI
 * stays in the bank) or kept as the grahak's advance. Each choice says exactly that.
 */
function DeleteParchi({ shopId, b, qty, onClose, onDone }: { shopId: string; b: Bill; qty: number; onClose: () => void; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const cash = b.cashPaise + b.collected.cashPaise
  const upi = b.upiPaise + b.collected.upiPaise
  const money = b.paidPaise + b.collected.cashPaise + b.collected.upiPaise
  const no = String(b.slipNo ?? b.number)
  const go = async (reason: 'deleted' | 'refunded' | 'advance') => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const r = await api<{ refundPaise: number; advance: { receiptNo: number; amountPaise: number } | null }>(`/v1/admin/shops/${shopId}/bills/${b.id}/void`, { method: 'POST', body: { reason } })
      onDone(reason === 'refunded' ? t('Parchi hata di · {rs} cash galla se wapas dein', { rs: rupees(r.refundPaise) })
        : r.advance ? t('Raseed {n} · {rs} advance jama', { n: r.advance.receiptNo, rs: rupees(r.advance.amountPaise) })
        : t('Parchi {n} hata di', { n: no }))
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }
  const how = upi === 0 ? t('{rs} cash wapas denge', { rs: rupees(cash) })
    : cash === 0 ? t('UPI ({rs}) bank mein rahega · cash wapas denge', { rs: rupees(upi) })
    : t('{all} cash wapas denge · UPI {upi} bank mein rahega', { all: rupees(money), upi: rupees(upi) })
  const options: { k: string; title: string; sub: string; run: () => void }[] = money === 0 ? [] : [
    { k: 'R', title: t('Paisa wapas (refund)'), sub: how, run: () => void go('refunded') },
    ...(b.buyerId ? [{ k: 'V', title: t('Advance mein rakhein'), sub: t('{rs} khate mein jama rahenge', { rs: rupees(money) }), run: () => void go('advance') }] : []),
  ]
  return (
    <div className="scrim sheet-scrim" onClick={(e) => { e.stopPropagation(); if (!busy) onClose() }} onKeyDown={(e) => {
      e.stopPropagation()
      if (e.key === 'Escape') return onClose()
      const o = options.find((x) => x.k.toLowerCase() === e.key.toLowerCase())
      if (o) { e.preventDefault(); o.run() } else if (!options.length && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); void go('deleted') }
    }}>
      <div className="sheet" role="alertdialog" aria-label={t('Parchi {n} hatayein?', { n: no })} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-hd"><h3>{t('Parchi {n} hatayein?', { n: no })}</h3></div>
        <div className="sheet-bd">
          <p className="muted">{b.buyerName} · {money ? rupees(money) : rupees(b.totalPaise)} · {t('{n} dana gaadi par wapas', { n: count(qty) })}</p>
          {options.length > 0 && (
            <div className="entry-grid one">
              {options.map((o, i) => (
                <button key={o.k} type="button" autoFocus={i === 0} disabled={busy} onClick={o.run}>
                  <b><kbd>{o.k}: </kbd>{o.title}</b><small>{o.sub}</small>
                </button>
              ))}
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <div className="sheet-ft">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}><kbd>Esc: </kbd>{t('Rehne dein')}</button>
          {!options.length && <button type="button" className="btn danger" autoFocus disabled={busy} onClick={() => void go('deleted')}>{busy ? '…' : <><kbd>Y: </kbd>{t('Haan, hatayein')}</>}</button>}
        </div>
      </div>
    </div>
  )
}

/** A vasooli as its raseed: the money, the slips it paid, and Alter / Delete as the app's raseed preview has them. */
function RaseedVoucher({ shopId, id, onClose, onDone }: VoucherProps & { id: string }) {
  const { data: r, error } = useLoad(() => api<Raseed>(`/v1/admin/shops/${shopId}/collections/${id}`), [shopId, id])
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const live = !!r && !r.voided
  const no = String(r?.receiptNo ?? '')
  const alter = () => {
    if (!r || !live) return
    onClose()
    editEntry({ kind: 'vasooli', raseed: r })
  }
  const remove = async () => {
    if (busy) return
    setBusy(true); setFailed('')
    try {
      await api(`/v1/admin/shops/${shopId}/collections/${id}/void`, { method: 'POST' })
      onDone(t('Raseed {n} hata di', { n: no }))
    } catch (e) { setFailed((e as Error).message); setBusy(false) }
  }
  return (
    <Scrim label={t('Raseed')} onClose={onClose} onKey={(k) => (k === 'alter' ? alter() : live && setDeleting(true))}
      title={<>{t('Raseed')} {no ? `#${no}` : ''}</>}
      chip={r?.voided && <span className="chip red">{VOIDED[r.voided.reason] ?? r.voided.reason}</span>}
      footer={r && (
        <>
          <a className="btn ghost" href={href({ page: 'grahak', shopId, buyerId: r.buyerId })} onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', marginRight: 'auto' }}>{t('{name} ka khata', { name: r.buyerName })} ›</a>
          {live && <button type="button" className="btn ghost" onClick={alter}><kbd>A: </kbd>{t('Alter')}</button>}
          {live && <button type="button" className="btn ghost" onClick={() => setDeleting(true)}><kbd>D: </kbd>{t('Delete')}</button>}
        </>
      )}>
      {error && <p className="error">{error}</p>}
      {!r ? <div className="sk" /> : (
        <>
          <div className="voucher-meta">
            <div><span className="fld-lb">{t('Grahak')}</span><b>{r.buyerName}</b></div>
            <div><span className="fld-lb">{t('Tarikh')}</span><span>{date(r.date)} · {time(r.at)}</span></div>
            <div><span className="fld-lb">{t('Machine')}</span><span>{r.machine || '—'}</span></div>
            {r.ref && <div><span className="fld-lb">UTR</span><span className="muted">{r.ref}</span></div>}
          </div>
          <div className="voucher-pay">
            {r.cashPaise > 0 && <div><span>{t('Cash')}</span><span className="money">{rupees(r.cashPaise)}</span></div>}
            {r.upiPaise > 0 && <div><span>UPI{r.upiBank ? ` · ${r.upiBank}` : ''}</span><span className="money">{rupees(r.upiPaise)}</span></div>}
            {r.slips.map((s) => (
              <div key={s.billId}>
                <a href="#" onClick={(e) => { e.preventDefault(); openVoucher(shopId, s.billId) }}>{t('Parchi')} #{s.slipNo ?? '—'}</a><span className="money muted">{rupees(s.amountPaise)}</span>
              </div>
            ))}
            <div className="b"><span>{t('Kul')}</span><span className="money jama">{rupees(r.cashPaise + r.upiPaise)}</span></div>
          </div>
        </>
      )}
      {deleting && r && (
        <div className="scrim sheet-scrim" onClick={(e) => { e.stopPropagation(); if (!busy) setDeleting(false) }} onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') setDeleting(false)
          else if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); void remove() }
        }}>
          <div className="sheet" role="alertdialog" aria-label={t('Raseed {n} hatayein?', { n: no })} onClick={(e) => e.stopPropagation()}>
            <div className="sheet-hd"><h3>{t('Raseed {n} hatayein?', { n: no })}</h3></div>
            <div className="sheet-bd">
              <p className="muted">{r.buyerName} · {rupees(r.cashPaise + r.upiPaise)}</p>
              <p>{t('Yeh paisa wapas baaki mein jud jayega.')}</p>
              {failed && <p className="error" role="alert">{failed}</p>}
            </div>
            <div className="sheet-ft">
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setDeleting(false)}><kbd>Esc: </kbd>{t('Rehne dein')}</button>
              <button type="button" className="btn danger" autoFocus disabled={busy} onClick={() => void remove()}>{busy ? '…' : <><kbd>Y: </kbd>{t('Haan, hatayein')}</>}</button>
            </div>
          </div>
        </div>
      )}
    </Scrim>
  )
}

/** The voucher's frame: Esc closes, A and D reach the voucher, anything inside a dialog stays there. */
function Scrim({ label, title, chip, footer, onClose, onKey, children }: {
  label: string; title: ReactNode; chip?: ReactNode; footer?: ReactNode; onClose: () => void; onKey: (k: 'alter' | 'delete') => void; children: ReactNode
}) {
  return (
    <div className="scrim sheet-scrim" onClick={onClose} onKeyDown={(e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
      const k = voucherKey(e)
      if (k) { e.preventDefault(); e.stopPropagation(); onKey(k) }
    }}>
      <div className="sheet" role="dialog" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-hd">
          <h3>{title}</h3>
          {chip}
          <button type="button" className="icon-btn" autoFocus aria-label={t('Band karein')} onClick={onClose}>✕</button>
        </div>
        <div className="sheet-bd">{children}</div>
        {footer && <div className="sheet-ft">{footer}</div>}
      </div>
    </div>
  )
}
