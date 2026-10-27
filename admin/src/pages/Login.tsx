import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { api } from '../api'
import { UpdateButton } from '../DesktopUpdate'
import * as I from '../icons'
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
          <h2>{t('Mandi ka poora hisaab,')}<br /><em>{t('ek jagah.')}</em></h2>
          <ul className="lg-feats">
            <li><I.IRupee />{t('Parchi')}</li>
            <li><I.IUdhaar />{t('Udhaar')}</li>
            <li><I.ITruck />{t('Gaadi')}</li>
            <li><I.IChart />{t('Hisaab')}</li>
            <li><I.IMic />{t('Bolo')}</li>
          </ul>
          <Stage />
        </div>
        <div className="lg-ft">© {new Date().getFullYear()} MandiPlus</div>
      </aside>

      <main className="lg-main">
        <motion.form className="lg-card" onSubmit={submit} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
          <span className="lg-badge"><I.IStore /></span>
          <h1>{t('Login karein')}</h1>
          <p className="lg-sub">{t('Apne mobile number se login karein')}</p>

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
            {busy ? <span className="lg-spin" /> : <>{sent ? t('Login') : t('OTP bhejein')}<span aria-hidden>→</span></>}
          </button>
          <p className="lg-safe"><Lock />{t('OTP se surakshit login')}</p>
        </motion.form>
        <UpdateButton className="app-link update-link" />
        <div className="lg-ft sm">© {new Date().getFullYear()} MandiPlus</div>
      </main>
    </div>
  )
}

const Lock = () => (
  <svg viewBox="0 0 24 24" aria-hidden><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
)

/** Floats a card gently up and down; still for anyone who asks for less motion. */
function Float({ className, delay = 0, children }: { className: string; delay?: number; children: ReactNode }) {
  const still = useReducedMotion()
  return (
    <motion.div className={`lg-float ${className}`} initial={{ opacity: 0, y: 16 }}
      animate={still ? { opacity: 1, y: 0 } : { opacity: 1, y: [0, -8, 0] }}
      transition={still ? { duration: 0.4 } : { opacity: { duration: 0.5, delay }, y: { duration: 6, repeat: Infinity, ease: 'easeInOut', delay } }}>
      {children}
    </motion.div>
  )
}

/** The product, drawn: a phone with the day's figures and the things that happen around it. Illustration only. */
function Stage() {
  const bars = [38, 52, 44, 70, 58, 84, 66]
  return (
    <div className="lg-stage" aria-hidden>
      <div className="lg-phone-mock">
        <div className="notch" />
        <div className="scr">
          <div className="scr-hd"><b>Mandi<span>Plus</span></b><i /></div>
          <div className="scr-hero">
            <small>{t('Aaj ki bikri')}</small>
            <b>₹2,48,600</b>
            <em>▲ 12%</em>
          </div>
          <div className="scr-bars">{bars.map((h, i) => <span key={i} style={{ height: `${h}%` }} className={i === 5 ? 'on' : ''} />)}</div>
          <div className="scr-row"><span className="av a">RF</span><span><b>Ramesh Fruits</b><small>Parchi 1024</small></span><span className="amt">₹12,400<em className="upi">UPI</em></span></div>
          <div className="scr-row"><span className="av b">GT</span><span><b>Gupta Traders</b><small>Parchi 1023</small></span><span className="amt">₹9,090<em className="ud">{t('Udhaar')}</em></span></div>
          <div className="scr-row"><span className="av c">SK</span><span><b>Shiv Kumar</b><small>Parchi 1022</small></span><span className="amt">₹4,500<em className="cash">{t('Cash')}</em></span></div>
        </div>
      </div>

      <Float className="f1" delay={0}>
        <span className="ic ok">✓</span>
        <span><small>{t('Payment mila')}</small><b>₹12,400 · UPI</b></span>
      </Float>
      <Float className="f2" delay={0.8}>
        <span className="ic vas"><I.IWallet /></span>
        <span><small>{t('Vasooli')}</small><b>+₹8,000</b></span>
      </Float>
      <Float className="f3" delay={1.6}>
        <span className="ic truck"><I.ITruck /></span>
        <span><small>{t('Nayi gaadi')}</small><b>HR55 · 520 box</b></span>
      </Float>
      <Float className="f4" delay={2.4}>
        <svg viewBox="0 0 42 42" className="ring">
          <circle cx="21" cy="21" r="16" fill="none" stroke="#e8890c" strokeWidth="6" />
          <circle cx="21" cy="21" r="16" fill="none" stroke="#12a150" strokeWidth="6" strokeDasharray="60 100" transform="rotate(-90 21 21)" />
          <circle cx="21" cy="21" r="16" fill="none" stroke="#5b5bd6" strokeWidth="6" strokeDasharray="0 60 12 100" transform="rotate(-90 21 21)" />
        </svg>
        <span><small>{t('Nakad')}</small><b>72%</b></span>
      </Float>
      <Float className="f5" delay={3.2}>
        <span className="ic wa">✓✓</span>
        <span><small>WhatsApp</small><b>{t('Udhaar reminder gaya')}</b></span>
      </Float>
    </div>
  )
}
