import { useEffect, useRef, useState } from 'react'
import { api, type BuyerRow, type MarketCustomer } from './api'
import { REPORTS, useSession } from './App'
import { href, periodQuery } from './routes'
import { phone, rupees } from './format'

type Option = { key: string; section: string; title: string; sub?: string; right?: string; to: string }

/**
 * Tally's Go To (Alt+G): one box over the reports, this dukaan's grahak, the owner's dukaans —
 * and for MandiPlus, every grahak in the market. ↑↓ Enter, Esc closes.
 */
export function GoTo({ shopId, onClose }: { shopId: string | null; onClose: () => void }) {
  const { me, shops } = useSession()
  const [q, setQ] = useState('')
  const [people, setPeople] = useState<Option[]>([])
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])

  const query = q.trim().toLowerCase()
  useEffect(() => {
    if (!query) { setPeople([]); return }
    let live = true
    const t = setTimeout(async () => {
      try {
        const found: Option[] = []
        if (shopId) {
          const r = await api<{ buyers: BuyerRow[] }>(`/v1/admin/shops/${shopId}/buyers?q=${encodeURIComponent(query)}`)
          found.push(...r.buyers.slice(0, 6).map((b) => ({ key: `b-${b.id}`, section: 'Grahak', title: b.name, sub: [b.phone && phone(b.phone), b.code && `A/C ${b.code}`].filter(Boolean).join(' · '),
            right: b.balancePaise > 0 ? `${rupees(b.balancePaise)} baaki` : undefined, to: href({ page: 'grahak', shopId, buyerId: b.id }) })))
        }
        if (me?.admin) {
          const r = await api<{ customers: MarketCustomer[] }>(`/v1/admin/customers?q=${encodeURIComponent(query)}`)
          found.push(...r.customers.slice(0, 5).map((c) => ({ key: `m-${c.key}`, section: 'Market', title: c.name, sub: [c.phone && phone(c.phone), c.shops.map((s) => s.shopName).join(', ')].filter(Boolean).join(' · '),
            right: c.balancePaise > 0 ? `${rupees(c.balancePaise)} baaki` : undefined, to: href({ page: 'person', key: c.key }) })))
        }
        if (live) setPeople(found)
      } catch { /* the reports still show */ }
    }, 180)
    return () => { live = false; clearTimeout(t) }
  }, [query, shopId, me?.admin])

  const reports: Option[] = shopId ? REPORTS.flatMap((g) => g.items)
    .filter((i) => !query || i.label.toLowerCase().includes(query))
    .map((i) => ({ key: `r-${i.report}`, section: 'Report', title: i.label, to: href({ page: 'report', shopId, report: i.report }) + periodQuery() })) : []
  const shopOpts: Option[] = (shops ?? []).filter((s) => s.status === 'approved' && (!query || `${s.name} ${s.mandi}`.toLowerCase().includes(query)))
    .slice(0, 6).map((s) => ({ key: `s-${s.id}`, section: 'Dukaan', title: s.name, sub: s.mandi, to: href({ page: 'report', shopId: s.id, report: 'dashboard' }) }))
  const options = query ? [...people, ...reports, ...shopOpts] : [...reports, ...shopOpts]
  const current = Math.min(sel, Math.max(0, options.length - 1))
  const go = (o?: Option) => { if (!o) return; location.hash = o.to; onClose() }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="Go To" onClick={(e) => e.stopPropagation()}>
        <input ref={input} className="field" placeholder="Grahak, report ya dukaan…" value={q}
          role="combobox" aria-expanded aria-controls="goto-results" aria-activedescendant={options[current] ? `goto-${current}` : undefined}
          onChange={(e) => { setQ(e.target.value); setSel(0) }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(options.length - 1, current + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, current - 1)) }
            else if (e.key === 'Enter') { e.preventDefault(); go(options[current]) }
          }} />
        <div className="results" id="goto-results" role="listbox">
          {options.map((o, i) => (
            <div key={o.key}>
              {(i === 0 || options[i - 1].section !== o.section) && <div className="sec">{o.section}</div>}
              <div id={`goto-${i}`} className="opt" role="option" aria-selected={i === current} onMouseEnter={() => setSel(i)} onClick={() => go(o)}>
                <span className="grow"><b>{o.title}</b>{o.sub && <small>{o.sub}</small>}</span>
                {o.right && <span className="money muted">{o.right}</span>}
              </div>
            </div>
          ))}
          {query && options.length === 0 && <p className="empty">“{q.trim()}” nahi mila</p>}
        </div>
      </div>
    </div>
  )
}
