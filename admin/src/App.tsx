import { useEffect, useState } from 'react'
import { getToken, setToken, whenSignedOut } from './api'
import { Login } from './pages/Login'
import { Shops } from './pages/Shops'
import { ShopPage } from './pages/Shop'
import { CustomerPage } from './pages/Customer'
import { Customers } from './pages/Customers'
import { PersonPage } from './pages/Person'
import { parse } from './routes'

export default function App() {
  const [signedIn, setSignedIn] = useState(() => !!getToken())
  const [route, setRoute] = useState(() => parse(location.hash))

  useEffect(() => {
    whenSignedOut(() => setSignedIn(false))
    const onHash = () => { setRoute(parse(location.hash)); window.scrollTo(0, 0) }
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])

  if (!signedIn) return <Login onDone={(t) => { setToken(t); setSignedIn(true) }} />

  return (
    <div className="shell">
      <header className="bar">
        <a href="#/" className="brand">MandiPlus <span>POS Admin</span></a>
        <nav className="nav" aria-label="Main">
          <a href="#/" aria-current={route.page === 'customers' || route.page === 'person' ? 'page' : undefined}>Customers</a>
          <a href="#/shops" aria-current={route.page === 'shops' || route.page === 'shop' || route.page === 'customer' ? 'page' : undefined}>Shops</a>
        </nav>
        <button className="ghost" onClick={() => { setToken(null); setSignedIn(false) }}>Sign out</button>
      </header>
      <main className="main">
        {route.page === 'customers' && <Customers />}
        {route.page === 'person' && <PersonPage key={route.key} personKey={route.key} />}
        {route.page === 'shops' && <Shops />}
        {route.page === 'shop' && <ShopPage key={route.shopId} shopId={route.shopId} tab={route.tab} />}
        {route.page === 'customer' && <CustomerPage key={route.buyerId} shopId={route.shopId} buyerId={route.buyerId} />}
      </main>
    </div>
  )
}
