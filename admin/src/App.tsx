import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, getToken, setToken, whenSignedOut, type Me, type Shop } from './api'
import { Login } from './pages/Login'
import { GoTo } from './GoTo'
import { href, parse, periodQuery, type Report, type Route } from './routes'
import { phone } from './format'
import * as I from './icons'
import { Dashboard } from './pages/Dashboard'
import { DayBook } from './pages/DayBook'
import { CashBook } from './pages/CashBook'
import { Outstanding } from './pages/Outstanding'
import { GrahakList, GrahakKhata } from './pages/Grahak'
import { Suppliers, SupplierKhata } from './pages/Suppliers'
import { Stock } from './pages/Stock'
import { Items } from './pages/Items'
import { Team } from './pages/Team'
import { AllShops } from './pages/AllShops'
import { Market, Person } from './pages/Market'
import { Requests } from './pages/Requests'
import { NewEntry } from './entries/NewEntry'
import { openEntry } from './entries/kinds'
import { F_KEYS, REPORT_KEYS, lastRow, openHelp, pagePath, periodKey } from './keys'
import { Hot } from './Hot'
import { Help } from './Help'
import { VoucherHost } from './pages/Voucher'

type Session = { me: Me | null; shops: Shop[] | null; reload: () => void }
const SessionContext = createContext<Session>({ me: null, shops: null, reload: () => {} })
// eslint-disable-next-line react-refresh/only-export-components
export const useSession = () => useContext(SessionContext)

/** The reports, in Tally's order; each one's letter (keys.ts) opens it from anywhere. */
// eslint-disable-next-line react-refresh/only-export-components
export const REPORTS: { group: string; items: { report: Report; label: string; key: string; icon: () => ReactNode }[] }[] = [
  { group: '', items: [{ report: 'dashboard', label: 'Dashboard', key: 'H', icon: I.IHome }] },
  { group: 'Hisab-Kitab', items: [
    { report: 'daybook', label: 'Day Book', key: 'D', icon: I.IBook },
    { report: 'cashbook', label: 'Cash / Bank Book', key: 'C', icon: I.ICash },
  ] },
  { group: 'Udhaar', items: [
    { report: 'outstanding', label: 'Outstanding', key: 'O', icon: I.IUdhaar },
    { report: 'ledger', label: 'Grahak Ledger', key: 'L', icon: I.ILedger },
  ] },
  { group: 'Supplier', items: [{ report: 'suppliers', label: 'Supplier Khata', key: 'P', icon: I.ITruck }] },
  { group: 'Stock', items: [
    { report: 'stock', label: 'Stock Summary', key: 'S', icon: I.IBox },
    { report: 'items', label: 'Maal-wise Bikri', key: 'I', icon: I.ITag },
  ] },
  { group: 'Dukaan', items: [{ report: 'team', label: 'Team & Machine', key: 'T', icon: I.ITeam }] },
]

const LAST_SHOP = 'mandipos-shop'

export default function App() {
  const [signedIn, setSignedIn] = useState(() => !!getToken())
  const [route, setRoute] = useState(() => parse(location.hash))
  const [me, setMe] = useState<Me | null>(null)
  const [shops, setShops] = useState<Shop[] | null>(null)
  const [goto, setGoto] = useState(false)
  const [drawer, setDrawer] = useState(false)

  const reload = useCallback(() => {
    api<{ shops: Shop[] }>('/v1/admin/shops').then((r) => setShops(r.shops)).catch(() => {})
  }, [])

  useEffect(() => {
    whenSignedOut(() => setSignedIn(false))
    let lastPath = location.hash.split('?')[0]
    const onHash = () => {
      setRoute(parse(location.hash)); setDrawer(false)
      const path = location.hash.split('?')[0]
      if (path !== lastPath) window.scrollTo(0, 0)
      lastPath = path
    }
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    if (!signedIn) return
    api<Me>('/v1/admin/me').then(setMe).catch(() => {})
    reload()
    const t = setInterval(reload, 60_000)
    return () => clearInterval(t)
  }, [signedIn, reload])

  const open = (shops ?? []).filter((s) => s.status === 'approved')
  const routeShop = route.page === 'report' || route.page === 'grahak' || route.page === 'supplier' ? route.shopId : null
  const remembered = (() => { try { return localStorage.getItem(LAST_SHOP) } catch { return null } })()
  const shopId = routeShop ?? (open.find((s) => s.id === remembered)?.id ?? open[0]?.id ?? null)
  useEffect(() => { if (routeShop) try { localStorage.setItem(LAST_SHOP, routeShop) } catch { /* private mode */ } }, [routeShop])

  // An owner's home is their shop; an admin's is every shop.
  useEffect(() => {
    if (route.page === 'home' && me && shops) location.replace(me.admin ? '#/shops' : shopId ? href({ page: 'report', shopId, report: 'dashboard' }) : '#/shops')
  }, [route.page, me, shops, shopId])

  // Tally's keys, letter by letter: H D C O L P S I T open a report, N a new entry (F8 parchi,
  // F9 gaadi, F6 vasooli), G or / Go To, ? all of them. ↑↓ pick a line, Enter opens it, Esc goes up
  // a level, ← → step the period, F2 changes it. Letters only count when no box is being typed in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      const mod = e.ctrlKey || e.metaKey || e.altKey
      const go = (report: Report) => { if (shopId) location.hash = href({ page: 'report', shopId, report }) + periodQuery() }
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (!typing && !mod && (e.key === '/' || e.key === 'g' || e.key === 'G')) || (e.altKey && e.code === 'KeyG')) {
        e.preventDefault(); setGoto(true); return
      }
      if (goto || document.querySelector('.scrim')) return
      if (F_KEYS[e.key] && shopId) { e.preventDefault(); openEntry(F_KEYS[e.key]); return }
      if (e.key === 'F2') { e.preventDefault(); periodKey('open'); return }
      if (typing) {
        if (e.key === 'Escape') el!.blur()
        // ↓ from a search box goes into the list, as in Tally's Go To.
        if (e.key === 'ArrowDown' && el?.dataset.search !== undefined) moveRow(e, el, 1)
        return
      }
      if (!mod && e.key === '?') { e.preventDefault(); openHelp(); return }
      const letter = e.altKey && e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : !mod ? e.key.toLowerCase() : ''
      if (letter === 'n' && shopId) { e.preventDefault(); openEntry(); return }
      if (letter && REPORT_KEYS[letter] && shopId) { e.preventDefault(); go(REPORT_KEYS[letter]); return }
      if (!mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && document.querySelector('.stepper')) {
        e.preventDefault(); periodKey(e.key === 'ArrowLeft' ? 'prev' : 'next'); return
      }
      if (e.key === 'Escape') {
        if (drawer) { setDrawer(false); return }
        // Up one level: a khata goes back to its list, a report to the dashboard.
        if (route.page === 'grahak' || route.page === 'supplier' || route.page === 'person') history.back()
        else if (route.page === 'report' && route.report !== 'dashboard') go('dashboard')
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') moveRow(e, el, e.key === 'ArrowDown' ? 1 : -1)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [goto, shopId, drawer, route])

  // The row you opened is remembered per page; coming back (Esc) puts you on it again.
  useEffect(() => {
    const remember = (e: Event) => {
      const row = (e.target as HTMLElement | null)?.closest?.('[data-row]') as HTMLElement | null
      if (!row) return
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Enter') return
      lastRow.set(pagePath(), [...document.querySelectorAll('[data-row]')].indexOf(row))
    }
    addEventListener('click', remember, true)
    addEventListener('keydown', remember, true)
    return () => { removeEventListener('click', remember, true); removeEventListener('keydown', remember, true) }
  }, [])
  useEffect(() => {
    const want = lastRow.get(pagePath())
    if (want === undefined || want < 0) return
    let tries = 0
    const t = setInterval(() => {
      const rows = document.querySelectorAll<HTMLElement>('[data-row]')
      if (rows.length > want && document.activeElement === document.body) { rows[want].focus(); rows[want].scrollIntoView({ block: 'center' }); clearInterval(t) }
      if (++tries > 40) clearInterval(t)
    }, 50)
    return () => clearInterval(t)
  }, [route])

  if (!signedIn) return <Login onDone={(t) => { setToken(t); setSignedIn(true) }} />

  const signOut = () => { setToken(null); setSignedIn(false); setMe(null); setShops(null) }
  const pending = me?.admin ? (shops ?? []).filter((s) => s.status === 'pending').length : 0
  const shop = open.find((s) => s.id === shopId)
  const current = route.page === 'report' ? route.report : null
  const title = titleOf(route)

  return (
    <SessionContext.Provider value={{ me, shops, reload }}>
      <div className="app">
        <aside className={`side${drawer ? ' open' : ''}`} aria-label="Menu">
          <a className="brand" href="#/"><i>M</i>Mandi<span>Plus</span></a>
          {open.length > 0 && (
            <div className="shop-pick">
              <select aria-label="Dukaan chunein" value={shopId ?? ''} onChange={(e) => {
                const report = route.page === 'report' ? route.report : 'dashboard'
                location.hash = href({ page: 'report', shopId: e.target.value, report }) + periodQuery()
              }}>
                {open.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          <nav className="nav">
            {shopId && REPORTS.map((g) => (
              <div key={g.group || 'home'}>
                {g.group && <div className="grp">{g.group}</div>}
                {g.items.map((it) => (
                  <a key={it.report} href={href({ page: 'report', shopId, report: it.report }) + periodQuery()}
                    aria-current={current === it.report || (route.page === 'grahak' && it.report === 'ledger') || (route.page === 'supplier' && it.report === 'suppliers') ? 'page' : undefined}>
                    <it.icon /><span><Hot label={it.label} k={it.key.toLowerCase()} /></span>
                  </a>
                ))}
              </div>
            ))}
            {me?.admin && (
              <>
                <div className="grp">MandiPlus</div>
                <a href="#/shops" aria-current={route.page === 'shops' ? 'page' : undefined}><I.IStore />Sab Dukaan</a>
                <a href="#/market" aria-current={route.page === 'market' || route.page === 'person' ? 'page' : undefined}><I.IPeople />Market Grahak</a>
                <a href="#/requests" aria-current={route.page === 'requests' ? 'page' : undefined}><I.IInbox />Requests{pending > 0 && <span className="badge">{pending}</span>}</a>
              </>
            )}
          </nav>
          <div className="who">
            {me ? phone(me.phone) : ''}
            <button className="icon-btn hide-sm keys-btn" title="Shortcuts (?)" aria-label="Shortcuts" onClick={openHelp}>⌨</button>
            <button className="btn ghost" onClick={signOut}>Logout</button>
          </div>
        </aside>
        <div className={`scrim-side${drawer ? ' open' : ''}`} onClick={() => setDrawer(false)} />

        <header className="top">
          <button className="icon-btn menu-btn" aria-label="Menu" onClick={() => setDrawer(true)}><I.IMenu /></button>
          <div className="title">
            <h1>{title}</h1>
            {shop && route.page !== 'shops' && route.page !== 'market' && route.page !== 'person' && route.page !== 'requests' && <small>{[shop.name, shop.mandi].filter(Boolean).join(' · ')}</small>}
          </div>
          <span className="spacer" />
          {shopId && <button className="new-btn top-new" onClick={() => openEntry()}>+ Nayi entry</button>}
          <button className="goto" onClick={() => setGoto(true)} aria-label="Go To">
            <I.ISearch /><span className="label">Dhoondhein…</span>
          </button>
        </header>

        <main className="main">
          {route.page === 'report' && <ReportPage shopId={route.shopId} report={route.report} />}
          {route.page === 'grahak' && <GrahakKhata key={route.buyerId} shopId={route.shopId} buyerId={route.buyerId} />}
          {route.page === 'supplier' && <SupplierKhata key={route.key} shopId={route.shopId} supplierKey={route.key} />}
          {route.page === 'shops' && <AllShops />}
          {route.page === 'market' && <Market />}
          {route.page === 'person' && <Person key={route.key} personKey={route.key} />}
          {route.page === 'requests' && <Requests />}
        </main>

        {shopId && (
          <nav className="tabs" aria-label="Main">
            <a href={href({ page: 'report', shopId, report: 'dashboard' })} aria-current={current === 'dashboard' ? 'page' : undefined}><I.IHome />Home</a>
            <a href={href({ page: 'report', shopId, report: 'daybook' }) + periodQuery()} aria-current={current === 'daybook' ? 'page' : undefined}><I.IBook />Day Book</a>
            <button className="plus" aria-label="Nayi entry" onClick={() => openEntry()}><span>+</span></button>
            <a href={href({ page: 'report', shopId, report: 'outstanding' })} aria-current={current === 'outstanding' || route.page === 'grahak' ? 'page' : undefined}><I.IUdhaar />Udhaar</a>
            <button onClick={() => setDrawer(true)}><I.IMenu />Menu{pending > 0 && <span className="badge">{pending}</span>}</button>
          </nav>
        )}

        {goto && <GoTo shopId={shopId} onClose={() => setGoto(false)} />}
        {shopId && <NewEntry key={shopId} shopId={shopId} />}
        <VoucherHost />
        <Help />
      </div>
    </SessionContext.Provider>
  )
}

function ReportPage({ shopId, report }: { shopId: string; report: Report }) {
  switch (report) {
    case 'daybook': return <DayBook key={shopId} shopId={shopId} />
    case 'cashbook': return <CashBook key={shopId} shopId={shopId} />
    case 'outstanding': return <Outstanding key={shopId} shopId={shopId} />
    case 'ledger': return <GrahakList key={shopId} shopId={shopId} />
    case 'suppliers': return <Suppliers key={shopId} shopId={shopId} />
    case 'stock': return <Stock key={shopId} shopId={shopId} />
    case 'items': return <Items key={shopId} shopId={shopId} />
    case 'team': return <Team key={shopId} shopId={shopId} />
    default: return <Dashboard key={shopId} shopId={shopId} />
  }
}

function titleOf(r: Route): string {
  switch (r.page) {
    case 'report': return REPORTS.flatMap((g) => g.items).find((i) => i.report === r.report)?.label ?? 'Dashboard'
    case 'grahak': return 'Grahak Khata'
    case 'supplier': return 'Supplier Khata'
    case 'shops': return 'Sab Dukaan'
    case 'market': return 'Market Grahak'
    case 'person': return 'Market Khata'
    case 'requests': return 'Requests'
    default: return 'MandiPlus'
  }
}

/** Moves the selection one line, like Tally's highlight bar. */
function moveRow(e: KeyboardEvent, el: HTMLElement | null, dir: 1 | -1) {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-row]')]
  if (!rows.length) return
  e.preventDefault()
  const i = rows.indexOf(el as HTMLElement)
  const next = i < 0 ? rows[dir === 1 ? Math.max(0, lastRow.get(pagePath()) ?? 0) : rows.length - 1] : rows[Math.min(rows.length - 1, Math.max(0, i + dir))]
  next.focus(); next.scrollIntoView({ block: 'nearest' })
}
