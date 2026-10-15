import { useState } from 'react'
import { preset, type Period } from './period'
import { hashQuery, setHashQuery } from './routes'

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The report's period, kept in the URL so Back, a reload or a shared link keep it. Default: today. */
export function usePeriod(fallback = 'aaj'): [Period, (p: Period) => void] {
  const read = (): Period => {
    const q = hashQuery()
    const from = q.get('from'), to = q.get('to')
    return from && to && DAY.test(from) && DAY.test(to) && from <= to ? { key: q.get('p') ?? 'custom', from, to } : preset(fallback)
  }
  const [p, setP] = useState(read)
  const set = (next: Period) => {
    setP(next)
    setHashQuery({ ...Object.fromEntries(hashQuery()), p: next.key, from: next.from, to: next.to })
  }
  return [p, set]
}
