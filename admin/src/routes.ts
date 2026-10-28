/**
 * Hash routes, so a reload or a shared link lands on the same page. A shop's reports live under
 * #/s/<shop>/…, the market (admin only) under #/market, #/requests and #/shops.
 */
export type Report = 'dashboard' | 'daybook' | 'cashbook' | 'outstanding' | 'ledger' | 'suppliers' | 'stock' | 'items' | 'team' | 'settings' | 'register' | 'munafa' | 'vasooli' | 'gaadis' | 'bhav' | 'nigrani'
  | 'dispatch' | 'pata' | 'commission' | 'beejak' | 'creditors' | 'laddan' | 'apmc' | 'mazdoori' | 'bolo'
export type Route =
  | { page: 'home' }
  | { page: 'report'; shopId: string; report: Report }
  | { page: 'grahak'; shopId: string; buyerId: string }
  | { page: 'supplier'; shopId: string; key: string }
  | { page: 'shops' }
  | { page: 'market' }
  | { page: 'person'; key: string }
  | { page: 'requests' }

const REPORTS: Report[] = ['dashboard', 'daybook', 'cashbook', 'outstanding', 'ledger', 'suppliers', 'stock', 'items', 'team', 'settings', 'register', 'munafa', 'vasooli', 'gaadis', 'bhav', 'nigrani', 'dispatch', 'pata', 'commission', 'beejak', 'creditors', 'laddan', 'apmc', 'mazdoori', 'bolo']

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent)
  if (parts[0] === 's' && parts[1]) {
    if (parts[2] === 'g' && parts[3]) return { page: 'grahak', shopId: parts[1], buyerId: parts[3] }
    if (parts[2] === 'sp' && parts[3]) return { page: 'supplier', shopId: parts[1], key: parts[3] }
    return { page: 'report', shopId: parts[1], report: REPORTS.find((r) => r === parts[2]) ?? 'dashboard' }
  }
  if (parts[0] === 'market') return parts[1] ? { page: 'person', key: parts[1] } : { page: 'market' }
  if (parts[0] === 'shops') return { page: 'shops' }
  if (parts[0] === 'requests') return { page: 'requests' }
  return { page: 'home' }
}

export function href(r: Route): string {
  switch (r.page) {
    case 'report': return `#/s/${r.shopId}${r.report === 'dashboard' ? '' : `/${r.report}`}`
    case 'grahak': return `#/s/${r.shopId}/g/${r.buyerId}`
    case 'supplier': return `#/s/${r.shopId}/sp/${encodeURIComponent(r.key)}`
    case 'person': return `#/market/${encodeURIComponent(r.key)}`
    case 'market': return '#/market'
    case 'shops': return '#/shops'
    case 'requests': return '#/requests'
    default: return '#/'
  }
}

/** Query-string state inside the hash (#/s/x/daybook?from=…), so Back restores the period. */
export function hashQuery(): URLSearchParams {
  return new URLSearchParams(location.hash.split('?')[1] ?? '')
}
export function setHashQuery(q: Record<string, string>) {
  const base = location.hash.split('?')[0] || '#/'
  const qs = new URLSearchParams(q).toString()
  history.replaceState(null, '', `${base}${qs ? `?${qs}` : ''}`)
}
/** The current period's part of the query, carried along when moving between reports. */
export function periodQuery(): string {
  const q = hashQuery()
  const keep = ['p', 'from', 'to'].filter((k) => q.get(k)).map((k) => `${k}=${q.get(k)}`).join('&')
  return keep ? `?${keep}` : ''
}
