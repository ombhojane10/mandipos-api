import { useCallback, useEffect, useState } from 'react'

/** Fired after an entry is saved, so every report on screen reads the books again. */
export const CHANGED = 'mandipos:changed'
export const booksChanged = () => dispatchEvent(new Event(CHANGED))

/** Loads [fn] whenever [deps] change, and again whenever an entry is saved; reload() fetches on demand. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fn, deps)

  const reload = useCallback(() => {
    let live = true
    setLoading(true)
    load()
      .then((d) => { if (live) { setData(d); setError('') } })
      .catch((e: Error) => { if (live) setError(e.message) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [load])

  useEffect(() => reload(), [reload])
  useEffect(() => {
    const on = () => { reload() }
    addEventListener(CHANGED, on)
    return () => removeEventListener(CHANGED, on)
  }, [reload])
  return { data, error, loading, reload }
}
