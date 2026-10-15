import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api, getToken, setToken, whenSignedOut, type Shop } from './api'
import { Login } from './pages/Login'
import { Shops } from './pages/Shops'
import { Requests } from './pages/Requests'
import { ShopPage } from './pages/Shop'
import { CustomerPage } from './pages/Customer'
import { Customers } from './pages/Customers'
import { PersonPage } from './pages/Person'
import { GoTo } from './GoTo'
import { parse, type Route } from './routes'

/** Every shop, refreshed every 30 s: the Requests badge, Go To and the Dukaan tab all read it. */
type ShopsState = { shops: Shop[] | null; reload: () => void }
const ShopsContext = createContext<ShopsState>({ shops: null, reload: () => {} })
// eslint-disable-next-line react-refresh/only-export-components
export const useShops = () => useContext(ShopsContext)

export default function App() {
  const [signedIn, setSignedIn] = useState(() => !!getToken())
  const [route, setRoute] = useState(() => parse(location.hash))
  const [goto, setGoto] = useState(false)
  const [shops, setShops] = useState<Shop[] | null>(null)

  const reload = useCallback(() => {
    api<{ shops: Shop[] }>('/v1/admin/shops').then((r) => setShops(r.shops)).catch(() => {})
  }, [])

  useEffect(() => {
    whenSignedOut(() => setSignedIn(false))
    let lastPath = location.hash.split('?')[0]
    const onHash = () => {
      setRoute(parse(location.hash))
      // A new page starts at the top; a period change on the same page doesn't jump.
      const path = location.hash.split('?')[0]
      if (path !== lastPath) window.scrollTo(0, 0)
      lastPath = path
    }
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    if (!signedIn) return
    reload()
    const t = setInterval(reload, 30_000)
    return () => clearInterval(t)
  }, [signedIn, reload])

  // Tally's keys: / or Ctrl+K = Go To, Esc = back, ↑↓ = move through rows, F2 = period.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); setGoto(true); return }
      if (goto || document.querySelector('.scrim')) return
      if (e.key === 'F2') { e.preventDefault(); document.querySelector<HTMLElement>('.period .chip')?.focus(); return }
      if (e.key === 'Escape') {
        if (typing) { el!.blur(); return }
        if (location.hash.replace(/^#\/?/, '')) history.back()
        return
      }
      // ↓ from the search box goes into the list, as in Tally's Go To.
      if (((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing) || (e.key === 'ArrowDown' && el?.classList.contains('search'))) {
        const rows = [...document.querySelectorAll<HTMLElement>('[data-row]')]
        if (!rows.length) return
        e.preventDefault()
        const i = rows.indexOf(el as HTMLElement)
        const next = e.key === 'ArrowDown' ? rows[Math.min(rows.length - 1, i + 1)] : rows[Math.max(0, i - 1)]
        next.focus()
        next.scrollIntoView({ block: 'nearest' })
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [goto])

  if (!signedIn) return <Login onDone={(t) => { setToken(t); setSignedIn(true) }} />

  const pending = shops?.filter((s) => s.status === 'pending').length ?? 0
  const section = sectionOf(route)

  return (
    <ShopsContext.Provider value={{ shops, reload }}>
      <header className="bar">
        <a href="#/" className="brand">Mandi<span>Plus</span><em className="hide-sm"> POS</em></a>
        <nav className="topnav" aria-label="Main">
          <a href="#/" aria-current={section === 'grahak' ? 'page' : undefined}>Grahak</a>
          <a href="#/shops" aria-current={section === 'shops' ? 'page' : undefined}>Dukaan</a>
          <a href="#/requests" aria-current={section === 'requests' ? 'page' : undefined}>
            Requests {pending > 0 && <span className="badge">{pending}</span>}
          </a>
        </nav>
        <span className="spacer" />
        <button className="goto-btn" onClick={() => setGoto(true)} aria-label="Go To — grahak ya dukaan dhoondhein">
          <SearchIcon /><span className="label">Go To…</span><kbd>/</kbd>
        </button>
        <button className="btn ghost hide-sm" onClick={() => { setToken(null); setSignedIn(false) }}>Sign out</button>
      </header>

      <main className="main">
        {route.page === 'grahak' && <Customers />}
        {route.page === 'person' && <PersonPage key={route.key} personKey={route.key} />}
        {route.page === 'shops' && <Shops onSignOut={() => { setToken(null); setSignedIn(false) }} />}
        {route.page === 'requests' && <Requests />}
        {route.page === 'shop' && <ShopPage key={route.shopId} shopId={route.shopId} tab={route.tab} />}
        {route.page === 'customer' && <CustomerPage key={route.buyerId} shopId={route.shopId} buyerId={route.buyerId} />}
      </main>

      <nav className="tabbar" aria-label="Main">
        <a href="#/" aria-current={section === 'grahak' ? 'page' : undefined}><PeopleIcon />Grahak</a>
        <a href="#/shops" aria-current={section === 'shops' ? 'page' : undefined}><StoreIcon />Dukaan</a>
        <a href="#/requests" aria-current={section === 'requests' ? 'page' : undefined}>
          <InboxIcon />Requests{pending > 0 && <span className="badge dot">{pending}</span>}
        </a>
      </nav>

      <div className="keybar" aria-hidden>
        <span><kbd>/</kbd> Go To</span><span><kbd>↑</kbd><kbd>↓</kbd> Chunein</span><span><kbd>Enter</kbd> Kholein</span>
        <span><kbd>Esc</kbd> Wapas</span><span><kbd>F2</kbd> Tarikh</span>
      </div>

      {goto && <GoTo onClose={() => setGoto(false)} />}
    </ShopsContext.Provider>
  )
}

function sectionOf(r: Route): 'grahak' | 'shops' | 'requests' {
  if (r.page === 'grahak' || r.page === 'person') return 'grahak'
  if (r.page === 'requests') return 'requests'
  return 'shops'
}

const svg = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
function SearchIcon() { return <svg {...svg} width={18} height={18}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg> }
function PeopleIcon() { return <svg {...svg}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.5a6.5 6.5 0 0 1 3.5 5.5" /></svg> }
function StoreIcon() { return <svg {...svg}><path d="M4 9h16l-1.5-5h-13z" /><path d="M5 9v11h14V9" /><path d="M10 20v-6h4v6" /></svg> }
function InboxIcon() { return <svg {...svg}><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5 5h14l2 8v6H3v-6z" /></svg> }
