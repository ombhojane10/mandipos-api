import { useEffect, useState, type ReactNode } from 'react'
import { api, type BankAccount, type ShopSettings } from '../api'
import { Money, Seg } from '../entries/fields'
import { LANGS, lang, setLang, t } from '../i18n'
import { booksChanged } from '../useLoad'
import { Skeleton } from '../ui'

const DOTS = [{ key: '384', label: t('2 inch') }, { key: '576', label: t('3 inch') }, { key: '832', label: t('4 inch') }] as const
const blankBank: BankAccount = { holder: '', bank: '', ifsc: '', account: '' }

/** What this browser keeps for its own parchis (the app keeps these per machine too). */
const local = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback } catch { return fallback } }
const keep = (key: string, v: string) => { try { localStorage.setItem(key, v) } catch { /* private window */ } }

/**
 * The shop's settings, as the app's Settings screen: dukaan details, what prints on the parchi,
 * the ledger's address and bank accounts, the WhatsApp udhaar message, the printer. Saved to the
 * shop, so every machine picks the change up. Language and the website's own defaults stay here.
 */
export function Settings({ shopId }: { shopId: string }) {
  const [saved, setSaved] = useState<ShopSettings | null>(null)
  const [f, setF] = useState<ShopSettings | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [labour, setLabour] = useState(() => Number(local('mp.labourRate', '30')) || 30)
  const [staff, setStaff] = useState(() => local('mp.staff', ''))

  useEffect(() => {
    api<ShopSettings>(`/v1/admin/shops/${shopId}/settings`).then((s) => { setSaved(s); setF(s) }).catch((e: Error) => setError(e.message))
  }, [shopId])
  if (!f || !saved) return error ? <p className="error">{error}</p> : <Skeleton rows={6} />

  const set = <K extends keyof ShopSettings>(k: K, v: ShopSettings[K]) => { setF({ ...f, [k]: v }); setDone(false) }
  const changed = (Object.keys(f) as (keyof ShopSettings)[]).filter((k) => JSON.stringify(f[k]) !== JSON.stringify(saved[k]))
  const banks = f.bankAccounts.length ? f.bankAccounts : [blankBank]
  const setBank = (i: number, patch: Partial<BankAccount>) => set('bankAccounts', banks.map((b, j) => (j === i ? { ...b, ...patch } : b)))

  async function save() {
    if (!f) return
    setBusy(true); setError('')
    try {
      const patch = Object.fromEntries(changed.filter((k) => k !== 'commodity').map((k) => [k, f[k]]))
      const s = await api<ShopSettings>(`/v1/admin/shops/${shopId}/settings`, { method: 'POST', body: patch })
      setSaved(s); setF(s); setDone(true); booksChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const text = (k: 'name' | 'mandi' | 'shopNo' | 'phad' | 'gstin' | 'address' | 'printerHost', max: number, extra?: { placeholder?: string; upper?: boolean }) => (
    <input className="field" value={f[k]} maxLength={max} placeholder={extra?.placeholder}
      onChange={(e) => set(k, extra?.upper ? e.target.value.toUpperCase() : e.target.value)} />
  )
  const mobile = (k: 'phone' | 'dispatchPhone') => (
    <input className="field" inputMode="tel" value={f[k]} maxLength={10} onChange={(e) => set(k, e.target.value.replace(/\D/g, ''))} />
  )
  const toggle = (k: 'udhaarRates' | 'udhaarAlerts') => (
    <Seg value={f[k] ? 'on' : 'off'} onChange={(v) => set(k, v === 'on')} options={[{ key: 'on', label: t('Haan') }, { key: 'off', label: t('Nahi') }]} />
  )

  return (
    <div className="settings">
      <Section title={t('Bhasha')}>
        <Row label={t('Website ki bhasha')}>
          <Seg value={lang} onChange={(l) => l !== lang && setLang(l)} options={LANGS} />
        </Row>
      </Section>

      <Section title={t('Dukaan')}>
        <Row label={t('Firm ka naam')}>{text('name', 120)}</Row>
        <Row label={t('Mandi')}>{text('mandi', 80)}</Row>
        <>
          <Row label={t('Dukaan no.')}>{text('shopNo', 20)}</Row>
          <Row label={t('Phad')}>{text('phad', 40, { placeholder: 'B-142' })}</Row>
        </>
        <Row label="GSTIN">{text('gstin', 15, { upper: true })}</Row>
        <Row label={t('Maal')}><span className="set-static">{f.commodity === 'amrud' ? t('Amrud') : f.commodity === 'angoor' ? t('Angoor') : t('Nariyal')}</span></Row>
      </Section>

      <Section title={t('Parchi')}>
        <Row label={t('Parchi code')} hint={t('Khaali = naam ke pehle akshar')}>
          <input className="field" value={f.slipCode} maxLength={6} onChange={(e) => set('slipCode', e.target.value.toUpperCase().replace(/[^A-Z0-9&]/g, ''))} />
        </Row>
        <>
          <Row label={t('Parchi par mobile')}>{mobile('phone')}</Row>
          <Row label={t('Dispatch mobile')}>{mobile('dispatchPhone')}</Row>
        </>
        <Row label={t('Parchi limit')} hint={t('Isse badi parchi par malik ki manzoori; 0 = koi limit nahi')}>
          <Money value={f.slipLimitPaise} onChange={(v) => set('slipLimitPaise', v)} />
        </Row>
        <Row label={t('Udhaar parchi par bhav')}>{toggle('udhaarRates')}</Row>
      </Section>

      <Section title={t('Ledger')}>
        <Row label={t('Poora pata')}>{text('address', 200)}</Row>
        {banks.map((b, i) => (
          <div key={i} className="set-bank">
            <span className="fld-lb">{t('Bank khata')} {banks.length > 1 ? i + 1 : ''}</span>
            <div className="set-pair">
              <input className="field" placeholder={t('Khata dhaarak')} value={b.holder} maxLength={80} onChange={(e) => setBank(i, { holder: e.target.value })} />
              <input className="field" placeholder={t('Bank')} value={b.bank} maxLength={80} onChange={(e) => setBank(i, { bank: e.target.value })} />
              <input className="field" placeholder={t('Khata no.')} inputMode="numeric" value={b.account} maxLength={34} onChange={(e) => setBank(i, { account: e.target.value.replace(/\s/g, '') })} />
              <input className="field" placeholder="IFSC" value={b.ifsc} maxLength={11} onChange={(e) => setBank(i, { ifsc: e.target.value.toUpperCase() })} />
            </div>
            {banks.length > 1 && <button type="button" className="btn ghost" onClick={() => set('bankAccounts', banks.filter((_, j) => j !== i))}>{t('Hatayein')}</button>}
          </div>
        ))}
        {banks.length < 4 && <button type="button" className="btn ghost" style={{ justifySelf: 'start' }} onClick={() => set('bankAccounts', [...banks, blankBank])}>+ {t('Aur bank khata')}</button>}
      </Section>

      <Section title="WhatsApp">
        <Row label={t('Subah udhaar ka message')} hint={t('Har grahak ko uska baaki, roz subah')}>{toggle('udhaarAlerts')}</Row>
      </Section>

      <Section title={t('Printer')}>
        <>
          <Row label={t('WiFi printer IP')}>{text('printerHost', 15, { placeholder: '192.168.1.50' })}</Row>
          <Row label={t('Kagaz')}>
            <Seg value={String(f.printerDots) as '384' | '576' | '832'} onChange={(v) => set('printerDots', Number(v))} options={[...DOTS]} />
          </Row>
        </>
      </Section>

      <Section title={t('Is website par')}>
        <>
          <Row label={t('Mazdoori / nag')}><Money value={labour} onChange={(v) => { setLabour(v); keep('mp.labourRate', String(v)) }} /></Row>
          <Row label={t('Accountant ka naam')}><input className="field" value={staff} maxLength={60} placeholder="Website" onChange={(e) => { setStaff(e.target.value); keep('mp.staff', e.target.value.trim()) }} /></Row>
        </>
      </Section>

      {(changed.length > 0 || done || error) && <div className="set-bar">
        {error && <span className="error">{error}</span>}
        {done && !changed.length && <span className="jama">{t('Save ho gaya')}</span>}
        <span className="grow" />
        {changed.length > 0 && <button type="button" className="btn ghost" disabled={busy} onClick={() => setF(saved)}>{t('Rehne dein')}</button>}
        <button type="button" className="btn primary" disabled={busy || !changed.length} onClick={save}>{busy ? '…' : t('Save')}</button>
      </div>}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card set-sec">
      <h3>{title}</h3>
      <div className="set-body">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <span className="set-lb">{label}{hint && <small>{hint}</small>}</span>
      <span className="set-ctl">{children}</span>
    </div>
  )
}
