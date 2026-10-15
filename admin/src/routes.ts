/** Hash routes, so a reload or a shared link lands on the same page with no server routing. */
export type Route =
  | { page: 'shops' }
  | { page: 'shop'; shopId: string; tab: 'overview' | 'customers' | 'team' }
  | { page: 'customer'; shopId: string; buyerId: string }

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] === 'shop' && parts[1]) {
    if (parts[2] === 'customer' && parts[3]) return { page: 'customer', shopId: parts[1], buyerId: parts[3] }
    const tab = parts[2] === 'customers' || parts[2] === 'team' ? parts[2] : 'overview'
    return { page: 'shop', shopId: parts[1], tab }
  }
  return { page: 'shops' }
}

export function href(r: Route): string {
  if (r.page === 'shop') return `#/shop/${r.shopId}${r.tab === 'overview' ? '' : `/${r.tab}`}`
  if (r.page === 'customer') return `#/shop/${r.shopId}/customer/${r.buyerId}`
  return '#/'
}
