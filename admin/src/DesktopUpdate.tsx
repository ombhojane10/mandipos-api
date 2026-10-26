import { useEffect, useState } from 'react'
import { t } from './i18n'

/**
 * The Windows app (mandipos-api/desktop) updates itself; this is its button. The page asks the
 * shell over window.chrome.webview ("update:status" | "update:check" | "update:apply") and the
 * shell answers {type: 'update', state, version, current}.
 */
type Status = {
  state: 'idle' | 'checking' | 'latest' | 'downloading' | 'ready' | 'error'
  version?: string
  current: string
}

type WebView = {
  postMessage(m: string): void
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void
}
const webview = () => (window as unknown as { chrome?: { webview?: WebView } }).chrome?.webview

/** The Windows app's version ("MandiPlusDesktop/0.1.5" in its user agent), null in a browser. */
const desktopVersion = () => /MandiPlusDesktop\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? null

// Shells before 0.1.5 don't answer.
const answers = (v: string) => {
  const [a = 0, b = 0, c = 0] = v.split('.').map(Number)
  return a * 1e6 + b * 1e3 + c >= 1005
}

let status: Status | null = null
const listeners = new Set<(s: Status) => void>()
let listening = false

function listen(wv: WebView) {
  if (listening) return
  listening = true
  wv.addEventListener('message', (e) => {
    const d = e.data as Status & { type?: string }
    if (d && typeof d === 'object' && d.type === 'update') {
      status = d
      listeners.forEach((fn) => fn(d))
    }
  })
  wv.postMessage('update:status')
}

function useDesktopUpdate() {
  const [s, setS] = useState(status)
  useEffect(() => {
    const v = desktopVersion(), wv = webview()
    if (!v || !wv || !answers(v)) return
    listeners.add(setS)
    listen(wv)
    return () => { listeners.delete(setS) }
  }, [])
  return s
}

const send = (s: Status) => webview()?.postMessage(s.state === 'ready' ? 'update:apply' : 'update:check')

const LABEL: Record<Status['state'], string> = {
  idle: 'Update check karein',
  checking: 'Check ho raha hai…',
  latest: 'Sabse naya version hai',
  downloading: 'Download ho raha hai…',
  ready: 'Update karein',
  error: 'Update nahi hua, phir try karein',
}

/** Sidebar and login page: the version, and one button that checks, downloads, then installs. */
export function UpdateButton({ className }: { className?: string }) {
  const s = useDesktopUpdate()
  if (!s) return null
  const to = s.state === 'downloading' || s.state === 'ready' ? ` → ${s.version}` : ''
  return (
    <button type="button" className={className} data-desktop-update data-state={s.state}
      disabled={s.state === 'checking' || s.state === 'downloading'} onClick={() => send(s)}>
      <span>{t(LABEL[s.state])}</span><small className="inline">v{s.current}{to}</small>
    </button>
  )
}

/** Top bar: only while an update is waiting to go in. */
export function UpdateReady() {
  const s = useDesktopUpdate()
  if (s?.state !== 'ready') return null
  return <button type="button" className="export-btn update-btn" onClick={() => send(s)}>{t('Update karein')}</button>
}
