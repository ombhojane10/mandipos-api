import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, APP_DOWNLOAD, getToken, inApp, setToken, whenSignedOut, type Me, type Shop } from './api'
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
import { Settings } from './pages/Settings'
import { Bhav, GaadiHisab, Munafa, Nigrani, SalesRegister, Vasooli } from './pages/Insights'
import { AllShops } from './pages/AllShops'
import { Market, Person } from './pages/Market'
import { Requests } from './pages/Requests'
import { NewEntry } from './entries/NewEntry'
import { openEntry } from './entries/kinds'
import { F_KEYS, REPORT_KEYS, lastRow, openHelp, pagePath, periodKey } from './keys'
import { Hot } from './Hot'
import { Help } from './Help'
import { VoucherHost } from './pages/Voucher'
import { ExportHost } from './export/Preview'
import { exportBuilder, openExport, useCanExport } from './export/doc'
import { t } from './i18n'

type Session = { me: Me | null; shops: Shop[] | null; reload: () => void }
const SessionContext = createContext<Session>({ me: null, shops: null, reload: () => {} })
// eslint-disable-next-line react-refresh/only-export-components
export const useSession = () => useContext(SessionContext)

/** The reports, in Tally's order; each one's letter (keys.ts) opens it from anywhere. */
// eslint-disable-next-line react-refresh/only-export-components
export const REPORTS: { group: string; items: { report: Report; label: string; key: string; icon: () => ReactNode }[] }[] = [
  { group: '', items: [{ report: 'dashboard', label: t('Dashboard'), key: 'H', icon: I.IHome }] },
  { group: t('Hisab-Kitab'), items: [
    { report: 'daybook', label: t('Day Book'), key: 'D', icon: I.IBook },
    { report: 'cashbook', label: t('Cash / Bank Book'), key: 'C', icon: I.ICash },
    { report: 'register', label: t('Bikri Register'), key: 'R', icon: I.ILedger },
    { report: 'munafa', label: t('Munafa (P&L)'), key: 'M', icon: I.IRupee },
  ] },
  { group: t('Udhaar'), items: [
    { report: 'outstanding', label: t('Outstanding'), key: 'O', icon: I.IUdhaar },
    { report: 'ledger', label: t('Grahak Ledger'), key: 'L', icon: I.ILedger },
    { report: 'vasooli', label: t('Vasooli'), key: 'V', icon: I.IWallet },
  ] },
  { group: t('Supplier'), items: [{ report: 'suppliers', label: t('Supplier Khata'), key: 'P', icon: I.ITruck }] },
  { group: t('Stock'), items: [
    { report: 'stock', label: t('Stock Summary'), key: 'S', icon: I.IBox },
    { report: 'gaadis', label: t('Gaadi Hisab'), key: 'A', icon: I.ITruck },
    { report: 'items', label: t('Maal-wise Bikri'), key: 'I', icon: I.ITag },
    { report: 'bhav', label: t('Aaj ka Bhav'), key: 'B', icon: I.ITag },
  ] },
  { group: t('Dukaan'), items: [
    { report: 'nigrani', label: t('Nigrani'), key: 'X', icon: I.IInbox },
    { report: 'team', label: t('Team & Machine'), key: 'T', icon: I.ITeam },
  ] },
]

const LAST_SHOP = 'mandipos-shop'

export default function App() {
  const [signedIn, setSignedIn] = useState(() => !!getToken())
  const [route, setRoute] = useState(() => parse(location.hash))
  const [me, setMe] = useState<Me | null>(null)
  const [shops, setShops] = useState<Shop[] | null>(null)
  const [goto, setGoto] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const canExport = useCanExport()

  const reload = useCallback(() => {
    api<{ shops: Shop[] }>('/v1/admin/shops').then((r) => setShops(r.shops)).catch(() => {})
  }, [])

  useEffect(() => {
    whenSignedOut(() => { setSignedIn(false); setMe(null); setShops(null) })
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

  // A home-screen shortcut (manifest "shortcuts") opens /?go=…: go to that screen once, then drop it.
  useEffect(() => {
    const go = new URLSearchParams(location.search).get('go')
    if (!go || !shopId) return
    history.replaceState(null, '', location.pathname + location.hash)
    if (go === 'parchi' || go === 'vasooli' || go === 'kharcha') setTimeout(() => openEntry(go), 300)
    else if ((['daybook', 'bhav', 'outstanding', 'munafa', 'register'] as const).includes(go as never)) location.hash = href({ page: 'report', shopId, report: go as Report })
  }, [shopId])

  // A link or tab left on another login's shop would only be refused; an owner goes to their own.
  useEffect(() => {
    if (me && !me.admin && routeShop && !me.shopIds?.includes(routeShop)) location.replace('#/')
  }, [me, routeShop])

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
      if (goto || document.querySelector('.scrim, .export-root')) return
      if (F_KEYS[e.key] && shopId) { e.preventDefault(); openEntry(F_KEYS[e.key]); return }
      // Tally's Export (E) and Print (Ctrl+P) both open the preview first.
      if ((e.ctrlKey || e.metaKey) && e.key === 'p' && exportBuilder()) { e.preventDefault(); openExport(); return }
      if (e.key === 'F2') { e.preventDefault(); periodKey('open'); return }
      // Tally's F12 is Configure.
      if (e.key === 'F12' && shopId) { e.preventDefault(); go('settings'); return }
      if (typing) {
        if (e.key === 'Escape') el!.blur()
        // ↓ from a search box goes into the list, as in Tally's Go To.
        if (e.key === 'ArrowDown' && el?.dataset.search !== undefined) moveRow(e, el, 1)
        return
      }
      if (!mod && e.key === '?') { e.preventDefault(); openHelp(); return }
      const letter = e.altKey && e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : !mod ? e.key.toLowerCase() : ''
      if (letter === 'n' && shopId) { e.preventDefault(); openEntry(); return }
      if (letter === 'e' && exportBuilder()) { e.preventDefault(); openExport(); return }
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

  // A fresh sign-in starts at home: the address may still hold the last login's shop.
  if (!signedIn) return <Login onDone={(t) => { setToken(t); location.replace('#/'); setSignedIn(true) }} />

  const signOut = () => { setToken(null); setSignedIn(false); setMe(null); setShops(null) }
  const pending = me?.admin ? (shops ?? []).filter((s) => s.status === 'pending').length : 0
  const shop = open.find((s) => s.id === shopId)
  const current = route.page === 'report' ? route.report : null
  const title = titleOf(route)

  return (
    <SessionContext.Provider value={{ me, shops, reload }}>
      <div className="app">
        <aside className={`side${drawer ? ' open' : ''}`} aria-label={t('Menu')}>
          <a className="brand" href="#/"><i>M</i>Mandi<span>Plus</span></a>
          {/* An owner sees their shop by name; a choice only where there is one to make. */}
          {open.length > 0 && !me?.admin && open.length === 1 && shop && (
            <div className="shop-name"><b>{shop.name}</b>{shop.mandi && <small>{shop.mandi}</small>}</div>
          )}
          {open.length > 0 && (me?.admin || open.length > 1) && (
            <div className="shop-pick">
              <select aria-label={t('Dukaan chunein')} value={shopId ?? ''} onChange={(e) => {
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
                <a href="#/shops" aria-current={route.page === 'shops' ? 'page' : undefined}><I.IStore />{t('Sab Dukaan')}</a>
                <a href="#/market" aria-current={route.page === 'market' || route.page === 'person' ? 'page' : undefined}><I.IPeople />{t('Market Grahak')}</a>
                <a href="#/requests" aria-current={route.page === 'requests' ? 'page' : undefined}><I.IInbox />{t('Requests')}{pending > 0 && <span className="badge">{pending}</span>}</a>
              </>
            )}
          </nav>
          <div className="side-ft">
            <button type="button" className="hide-sm" onClick={openHelp}><I.IKeys /><span>{t('Shortcuts')}</span><kbd>?</kbd></button>
            {shopId && (
              <a href={href({ page: 'report', shopId, report: 'settings' })} aria-current={current === 'settings' ? 'page' : undefined}>
                <I.ISettings /><span>{t('Settings')}</span>
              </a>
            )}
            {!inApp() && <a href={APP_DOWNLOAD} className="hide-lg"><span>📱 {t('App download')}</span></a>}
            <button type="button" onClick={signOut}><I.ILogout /><span>{t('Logout')}</span><small className="inline">{me ? phone(me.phone) : ''}</small></button>
          </div>
        </aside>
        <div className={`scrim-side${drawer ? ' open' : ''}`} onClick={() => setDrawer(false)} />

        <header className="top">
          <button className="icon-btn menu-btn" aria-label={t('Menu')} onClick={() => setDrawer(true)}><I.IMenu /></button>
          <div className="title">
            <h1>{title}</h1>
          </div>
          <span className="spacer" />
          <span className="top-date">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).replace(/ (\w{3}) /, '-$1-')}</span>
          {canExport && <button className="export-btn" title={`${t('Export')} (E)`} aria-label={t('Export')} onClick={openExport}><I.IExport /><span>{t('Export')}</span></button>}
          {shopId && <button className="new-btn top-new" onClick={() => openEntry()}>+ {t('Nayi entry')}</button>}
          <button className="goto" onClick={() => setGoto(true)} aria-label={t('Go To')}>
            <I.ISearch /><span className="label">{t('Dhoondhein')}…</span>
          </button>
        </header>

        {shopId && <KeyPanel canExport={canExport} onGoto={() => setGoto(true)} onSettings={() => { location.hash = href({ page: 'report', shopId, report: 'settings' }) }} />}

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
          <nav className="tabs" aria-label={t('Main')}>
            <a href={href({ page: 'report', shopId, report: 'dashboard' })} aria-current={current === 'dashboard' ? 'page' : undefined}><I.IHome />{t('Home')}</a>
            <a href={href({ page: 'report', shopId, report: 'daybook' }) + periodQuery()} aria-current={current === 'daybook' ? 'page' : undefined}><I.IBook />{t('Day Book')}</a>
            <button className="plus" aria-label={t('Nayi entry')} onClick={() => openEntry()}><span>+</span></button>
            <a href={href({ page: 'report', shopId, report: 'outstanding' })} aria-current={current === 'outstanding' || route.page === 'grahak' ? 'page' : undefined}><I.IUdhaar />{t('Udhaar')}</a>
            <button onClick={() => setDrawer(true)}><I.IMenu />{t('Menu')}{pending > 0 && <span className="badge">{pending}</span>}</button>
          </nav>
        )}

        {goto && <GoTo shopId={shopId} onClose={() => setGoto(false)} />}
        {shopId && <NewEntry key={shopId} shopId={shopId} />}
        <VoucherHost />
        <ExportHost shopId={shopId} fallback={shop ?? null} />
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
    case 'settings': return <Settings key={shopId} shopId={shopId} />
    case 'register': return <SalesRegister key={shopId} shopId={shopId} />
    case 'munafa': return <Munafa key={shopId} shopId={shopId} />
    case 'vasooli': return <Vasooli key={shopId} shopId={shopId} />
    case 'gaadis': return <GaadiHisab key={shopId} shopId={shopId} />
    case 'bhav': return <Bhav key={shopId} shopId={shopId} />
    case 'nigrani': return <Nigrani key={shopId} shopId={shopId} />
    default: return <Dashboard key={shopId} shopId={shopId} />
  }
}

function titleOf(r: Route): string {
  switch (r.page) {
    case 'report': return r.report === 'settings' ? t('Settings') : REPORTS.flatMap((g) => g.items).find((i) => i.report === r.report)?.label ?? t('Dashboard')
    case 'grahak': return t('Grahak Khata')
    case 'supplier': return t('Supplier Khata')
    case 'shops': return t('Sab Dukaan')
    case 'market': return t('Market Grahak')
    case 'person': return t('Market Khata')
    case 'requests': return t('Requests')
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

/**
 * Tally's button bar down the right: every action with its key, so the mouse and the keyboard
 * find the same thing. Shown on wide screens; phones keep the bottom tabs.
 */
function KeyPanel({ canExport, onGoto, onSettings }: { canExport: boolean; onGoto: () => void; onSettings: () => void }) {
  const keys: { k: string; label: string; run: () => void; off?: boolean }[] = [
    { k: 'F2', label: t('Period'), run: () => periodKey('open') },
    { k: 'G', label: t('Go To'), run: onGoto },
    { k: 'N', label: t('Nayi entry'), run: () => openEntry() },
    { k: 'F8', label: t('Parchi'), run: () => openEntry('parchi') },
    { k: 'F6', label: t('Vasooli'), run: () => openEntry('vasooli') },
    { k: 'F9', label: t('Gaadi'), run: () => openEntry('gaadi') },
    { k: 'E', label: t('Export'), run: openExport, off: !canExport },
    { k: 'F12', label: t('Configure'), run: onSettings },
    { k: '?', label: t('Shortcuts'), run: openHelp },
  ]
  return (
    <nav className="keypanel" aria-label={t('Shortcuts')}>
      {keys.map((b) => (
        <button key={b.k} type="button" disabled={b.off} onClick={b.run}><kbd>{b.k}</kbd>: {b.label}</button>
      ))}
    </nav>
  )
}
