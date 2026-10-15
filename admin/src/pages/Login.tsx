import { useState, type FormEvent } from 'react'
import { api } from '../api'

/** Mobile number, then the OTP sent to it. Only numbers on the server's admin list get one. */
export function Login({ onDone }: { onDone: (token: string) => void }) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      if (!sent) {
        await api('/v1/admin/auth/otp', { method: 'POST', body: { phone } })
        setSent(true)
      } else {
        const r = await api<{ token: string }>('/v1/admin/auth/verify', { method: 'POST', body: { phone, code } })
        onDone(r.token)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <h1>Mandi<span style={{ color: 'var(--accent)' }}>Plus</span> POS</h1>
        <p className="muted">{sent ? `${phone} par aaya OTP daalein` : 'Apne mobile number se login karein'}</p>
        {!sent ? (
          <input
            className="field" inputMode="numeric" autoComplete="tel" placeholder="Mobile number" autoFocus
            value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
          />
        ) : (
          <input
            className="field" inputMode="numeric" autoComplete="one-time-code" placeholder="OTP" autoFocus
            value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
          />
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary" disabled={busy || (!sent ? phone.length !== 10 : code.length < 4)}>
          {busy ? '…' : sent ? 'Login' : 'OTP bhejein'}
        </button>
        {sent && <button type="button" className="btn ghost" onClick={() => { setSent(false); setCode(''); setError('') }}>Number badlein</button>}
      </form>
    </div>
  )
}
