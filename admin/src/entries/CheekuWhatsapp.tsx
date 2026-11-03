import { useEffect, useState } from 'react'
import { api } from '../api'
import { t } from '../i18n'
import { drawSlip, orderParchi, type SlipBill, type SlipShop } from '../export/orderParchi'
import { Field, Sheet } from './fields'

/**
 * Cheeku's "WhatsApp par bhejein" on the website (after a scan, or from the parchi): the order
 * parchi drawn here exactly as the Pine machine prints it, sent to the grahak's number — the one
 * on their khata, which can be changed; a number typed for a grahak who had none is saved to
 * them. Cash / Bank walk-ins have no khata, so the number is asked each time.
 */
export function CheekuWhatsappSheet({ shopId, billId, onClose, onSent }: {
  shopId: string; billId: string; onClose: () => void; onSent: (msg: string) => void
}) {
  const [phone, setPhone] = useState('')
  const [ready, setReady] = useState<{ bill: SlipBill & { buyerId: string | null }; shop: SlipShop; me: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let gone = false
    void (async () => {
      try {
        const [bill, shop, me] = await Promise.all([
          api<SlipBill & { buyerId: string | null }>(`/v1/admin/shops/${shopId}/bills/${billId}`),
          api<SlipShop>(`/v1/admin/shops/${shopId}/settings`),
          api<{ phone: string }>('/v1/admin/me').catch(() => ({ phone: '' })),
        ])
        const known = bill.buyerId
          ? (await api<{ buyer: { phone: string } }>(`/v1/admin/shops/${shopId}/buyers/${bill.buyerId}`).catch(() => null))?.buyer.phone ?? ''
          : ''
        if (gone) return
        setReady({ bill, shop, me: me.phone })
        if (/^[6-9]\d{9}$/.test(known)) setPhone(known)
      } catch (e) { if (!gone) setError((e as Error).message) }
    })()
    return () => { gone = true }
  }, [shopId, billId])

  const send = async () => {
    if (!ready || busy) return
    if (!/^[6-9]\d{9}$/.test(phone)) return setError(t('10 ank ka mobile number'))
    setBusy(true); setError('')
    try {
      const canvas = await drawSlip(orderParchi(ready.bill, ready.shop, ready.me))
      const image = canvas.toDataURL('image/png').split(',')[1]
      await api(`/v1/admin/shops/${shopId}/cheeku/bills/${billId}/whatsapp`, { method: 'POST', body: { phone, image } })
      onSent(t('WhatsApp gaya · +91 {phone}', { phone }))
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const slip = ready?.bill.slipNo ? `#${ready.bill.slipNo}` : t('Parchi')
  return (
    <Sheet title={`${slip} · WhatsApp`} onClose={onClose} onSave={() => void send()} saving={busy || (!ready && !error)} error={error} saveLabel={t('Bhejein')}>
      <Field label={t('WhatsApp number')}>
        <input className="field" inputMode="tel" maxLength={10} autoFocus value={phone} placeholder="98xxxxxxxx"
          onChange={(e) => { setError(''); setPhone(e.target.value.replace(/\D/g, '')) }} />
      </Field>
    </Sheet>
  )
}
