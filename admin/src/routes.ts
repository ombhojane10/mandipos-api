/** Hash routes, so a reload or a shared link lands on the same page with no server routing. */
export type ShopTab = 'hisab' | 'daybook' | 'grahak' | 'team'
export type Route =
  | { page: 'grahak' }
  | { page: 'person'; key: string }
  | { page: 'shops' }
  | { page: 'requests' }
  | { page: 'shop'; shopId: string; tab: ShopTab }
  | { page: 'customer'; shopId: string; buyerId: string }

const TABS: ShopTab[] = ['hisab', 'daybook', 'grahak', 'team']

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean)
  if (parts[0] === 'c' && parts[1]) return { page: 'person', key: decodeURIComponent(parts[1]) }
  if (parts[0] === 'shops') return { page: 'shops' }
  if (parts[0] === 'requests') return { page: 'requests' }
  if (parts[0] === 'shop' && parts[1]) {
    if (parts[2] === 'customer' && parts[3]) return { page: 'customer', shopId: parts[1], buyerId: parts[3] }
    const tab = TABS.find((t) => t === parts[2]) ?? 'hisab'
    return { page: 'shop', shopId: parts[1], tab }
  }
  return { page: 'grahak' }
}

export function href(r: Route): string {
  switch (r.page) {
    case 'person': return `#/c/${encodeURIComponent(r.key)}`
    case 'shops': return '#/shops'
    case 'requests': return '#/requests'
    case 'shop': return `#/shop/${r.shopId}${r.tab === 'hisab' ? '' : `/${r.tab}`}`
    case 'customer': return `#/shop/${r.shopId}/customer/${r.buyerId}`
    default: return '#/'
  }
}

/** Query-string state inside the hash (#/shop/x/daybook?from=…), so Back restores the period. */
export function hashQuery(): URLSearchParams {
  return new URLSearchParams(location.hash.split('?')[1] ?? '')
}
export function setHashQuery(q: Record<string, string>) {
  const base = location.hash.split('?')[0] || '#/'
  const qs = new URLSearchParams(q).toString()
  history.replaceState(null, '', `${base}${qs ? `?${qs}` : ''}`)
}
