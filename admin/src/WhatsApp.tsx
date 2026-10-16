import { useEffect, useState } from 'react'
import { api } from './api'
import { ago, phone, rupees } from './format'
import { t } from './i18n'
import { WHATSAPP_EVENT } from './keys'

type Draft = { canSend: boolean; reason: string | null; phone: string; duePaise: number; text: string; last: { at: string; duePaise: number } | null }

/**
 * "Udhaar WhatsApp pe bhejein": the grahak's message as they will read it, sent with one press
 * from the MandiPlus bot's number (the approved udhaar template) — no phone, no copy-paste.
 * Opened from the khata, the Vasooli desk and Bolo.
 */
export function WhatsAppHost() {
  const [open, setOpen] = useState<{ shopId: string; buyerId: string } | null>(null)
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<{ shopId: string; buyerId: string }>).detail)
    addEventListener(WHATSAPP_EVENT, on)
    return () => removeEventListener(WHATSAPP_EVENT, on)
  }, [])
  return open ? <Send key={open.buyerId} {...open} onClose={() => setOpen(null)} /> : null
}

function Send({ shopId, buyerId, onClose }: { shopId: string; buyerId: string; onClose: () => void }) {
  const [d, setD] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  useEffect(() => {
    api<Draft>(`/v1/admin/shops/${shopId}/buyers/${buyerId}/whatsapp`).then(setD).catch((e: Error) => setError(e.message))
  }, [shopId, buyerId])

  const send = async () => {
    if (!d?.canSend || busy || sent) return
    setBusy(true); setError('')
    try {
      await api(`/v1/admin/shops/${shopId}/buyers/${buyerId}/whatsapp`, { method: 'POST', body: {} })
      setSent(true)
      setTimeout(onClose, 1400)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scrim" onClick={() => !busy && onClose()}>
      <div className="sheet wa" role="dialog" aria-label={t('WhatsApp pe udhaar')} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } else if (e.key === 'Enter') { e.preventDefault(); void send() } }}>
        <div className="sheet-hd"><h3>{t('WhatsApp pe udhaar')}</h3><button type="button" className="icon-btn" aria-label={t('Band karein')} onClick={onClose}>✕</button></div>
        <div className="sheet-bd">
          {!d && !error && <div className="sk" />}
          {d && (
            <>
              <div className="wa-to"><b>+91 {phone(d.phone)}</b>{d.duePaise > 0 && <span className="money due b">{rupees(d.duePaise)} {t('baaki')}</span>}</div>
              {d.text && <p className="wa-bubble">{d.text}</p>}
              {d.reason && <p className="error">{t(d.reason)}</p>}
              {d.last && <p className="muted">{t('Pichhli baar bheja')}: {ago(d.last.at)} · {rupees(d.last.duePaise)}</p>}
              <p className="muted wa-from">{t('MandiPlus ke WhatsApp number se jayega')}</p>
            </>
          )}
          {error && <p className="error">{error}</p>}
          {sent && <p className="jama b">✓ {t('WhatsApp bhej diya')}</p>}
        </div>
        <div className="sheet-ft">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}><kbd>Esc: </kbd>{t('Rehne dein')}</button>
          <button type="button" className="btn primary" autoFocus disabled={!d?.canSend || busy || sent} onClick={() => void send()}>
            <kbd>↵: </kbd>{busy ? '…' : sent ? '✓' : t('Bhejein')}
          </button>
        </div>
      </div>
    </div>
  )
}
