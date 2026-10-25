import { useEffect, useState } from 'react'
import { api } from '../api'
import type { AngoorOptions } from '../entries/Angoor'

/** The shop's entry options (open gaadis, lots, bhav, banks) — what the pickers and slip cards read. */
export type Options = AngoorOptions & {
  commodity: string
  trucks: { id: string; number: string; supplier: string; arrivedAt: string; left: number; brandId: string | null; brand: string }[]
  rates: { brandId: string; grade: string; ratePaise: number }[]
}

const cache = new Map<string, { at: number; p: Promise<Options> }>()

/** One read a minute per shop, shared by every card and picker on the page. */
export function loadOptions(shopId: string, fresh = false): Promise<Options> {
  const hit = cache.get(shopId)
  if (hit && !fresh && Date.now() - hit.at < 60_000) return hit.p
  const p = api<Options>(`/v1/admin/shops/${shopId}/entry-options`)
  cache.set(shopId, { at: Date.now(), p })
  p.catch(() => cache.delete(shopId))
  return p
}

export function useOptions(shopId: string) {
  const [o, setO] = useState<Options | null>(null)
  useEffect(() => { let live = true; loadOptions(shopId).then((x) => { if (live) setO(x) }).catch(() => {}); return () => { live = false } }, [shopId])
  return o
}
