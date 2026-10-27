import { useEffect, useRef, useState, type FormEvent } from 'react'
import { motion } from 'motion/react'
import { api, APP_DOWNLOAD, inApp } from '../api'
import { UpdateButton } from '../DesktopUpdate'
import { t } from '../i18n'

const RESEND_S = 30

/** Mobile number, then the OTP sent to it. Only numbers on the server's admin list get one. */
export function Login({ onDone }: { onDone: (token: string) => void }) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [wait, setWait] = useState(0)
  const otpRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!wait) return
    const id = setTimeout(() => setWait((w) => w - 1), 1000)
    return () => clearTimeout(id)
  }, [wait])

  async function sendOtp() {
    await api('/v1/admin/auth/otp', { method: 'POST', body: { phone } })
    setSent(true); setWait(RESEND_S)
    setTimeout(() => otpRef.current?.focus(), 50)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      if (!sent) await sendOtp()
      else {
        const r = await api<{ token: string }>('/v1/admin/auth/verify', { method: 'POST', body: { phone, code } })
        onDone(r.token)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    setBusy(true); setError('')
    try { await sendOtp() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="lg">
      <aside className="lg-brand">
        <div className="lg-logo">Mandi<span>Plus</span></div>
        <div className="lg-hero">
          <h2>{t('Mandi ka poora hisaab, ek jagah.')}</h2>
          <Preview />
        </div>
        <div className="lg-ft">© {new Date().getFullYear()} MandiPlus</div>
      </aside>

      <main className="lg-main">
        <div className="lg-logo sm">Mandi<span>Plus</span></div>
        <motion.form className="lg-card" onSubmit={submit} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
          <h1>{t('Login karein')}</h1>

          <label className="lg-lb" htmlFor="lg-phone">{t('Mobile number')}</label>
          <div className={`lg-phone${sent ? ' locked' : ''}`}>
            <span>+91</span>
            <input
              id="lg-phone" inputMode="numeric" autoComplete="tel" placeholder="98765 43210" autoFocus={!sent} readOnly={sent}
              value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
            />
            {sent && <button type="button" onClick={() => { setSent(false); setCode(''); setError(''); setWait(0) }}>{t('Badlein')}</button>}
          </div>

          {sent && (
            <>
              <label className="lg-lb" htmlFor="lg-otp">OTP</label>
              <input
                id="lg-otp" ref={otpRef} className="lg-otp" inputMode="numeric" autoComplete="one-time-code" placeholder="• • • • • •"
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
              />
              <p className="lg-resend">
                {wait ? t('OTP dobara {s} sec mein', { s: wait }) : <button type="button" onClick={() => void resend()} disabled={busy}>{t('OTP dobara bhejein')}</button>}
              </p>
            </>
          )}

          {error && <p className="lg-error" role="alert">{error}</p>}
          <button className="lg-go" disabled={busy || (!sent ? phone.length !== 10 : code.length < 4)}>
            {busy ? <span className="lg-spin" /> : sent ? t('Login') : t('OTP bhejein')}
          </button>
        </motion.form>
        <div className="lg-links">
          {!inApp() && /Android/i.test(navigator.userAgent) && <a href={APP_DOWNLOAD}>{t('Android app download karein')}</a>}
          <UpdateButton className="app-link update-link" />
        </div>
      </main>
    </div>
  )
}

/** A still of the dashboard: what the shop gets after signing in. Illustration only, not data. */
function Preview() {
  return (
    <div className="lg-prev" aria-hidden>
      <div className="lg-prev-card lg-a">
        <span className="lb">{t('Aaj ki bikri')}</span>
        <b>₹2,48,600</b>
        <span className="up">▲ 12%</span>
        <svg viewBox="0 0 280 70" preserveAspectRatio="none">
          <path d="M0 58 C30 54 45 40 70 44 S115 30 140 34 S190 12 215 18 S255 8 280 6" fill="none" stroke="#0f766e" strokeWidth="2.5" />
          <path d="M0 58 C30 54 45 40 70 44 S115 30 140 34 S190 12 215 18 S255 8 280 6 V70 H0 Z" fill="#0f766e" opacity="0.07" />
        </svg>
      </div>
      <div className="lg-prev-card lg-b">
        <div><i className="c" />{t('Cash')}<b>₹1,20,400</b></div>
        <div><i className="u" />UPI<b>₹74,200</b></div>
        <div><i className="d" />{t('Udhaar')}<b>₹54,000</b></div>
      </div>
    </div>
  )
}
