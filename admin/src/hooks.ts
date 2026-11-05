import { useEffect, useState } from 'react'
import { useSession } from './App'
import { isCheeku } from './commodity'
import { preset, type Period } from './period'
import { hashQuery, parse, setHashQuery } from './routes'

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Sent when a page is opened from the menu (or its key), so a cheeku page already open starts over on Aaj. */
export const MENU_EVENT = 'mp:menu'

/** The shop in the address bar is a cheeku shop. */
function useCheekuRoute(): boolean {
  const route = parse(location.hash)
  const shopId = 'shopId' in route ? route.shopId : undefined
  return isCheeku(useSession().shops?.find((s) => s.id === shopId)?.commodity)
}

/**
 * The report's period, kept in the URL so Back, a reload or a shared link keep it. Default: today.
 * A cheeku shop's pages always open on Aaj (today), whatever period the link carried in from the
 * last page (which could be yesterday's "Aaj" in a tab left open overnight), and start over on Aaj
 * when their menu entry is clicked again.
 */
export function usePeriod(fallback = 'aaj'): [Period, (p: Period) => void] {
  const cheeku = useCheekuRoute()
  const read = (): Period => {
    if (cheeku) return preset('aaj')
    const q = hashQuery()
    const from = q.get('from'), to = q.get('to')
    return from && to && DAY.test(from) && DAY.test(to) && from <= to ? { key: q.get('p') ?? 'custom', from, to } : preset(fallback)
  }
  const [p, setP] = useState(read)
  const set = (next: Period) => {
    setP(next)
    setHashQuery({ ...Object.fromEntries(hashQuery()), p: next.key, from: next.from, to: next.to })
  }
  useEffect(() => {
    if (!cheeku) return
    // Write today over the carried-in period, so the URL (and the next page) match what is shown.
    if (hashQuery().get('from')) set(p)
    const again = () => set(preset('aaj'))
    addEventListener(MENU_EVENT, again)
    return () => removeEventListener(MENU_EVENT, again)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cheeku])
  return [p, set]
}
