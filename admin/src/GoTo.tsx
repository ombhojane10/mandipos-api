import { useEffect, useRef, useState } from 'react'
import { api, type MarketCustomer } from './api'
import { useShops } from './App'
import { href } from './routes'
import { phone, rupees } from './format'

type Option = { key: string; section: 'Dukaan' | 'Grahak'; title: string; sub: string; right?: string; to: string }

/** Tally's Go To (Alt+G): one box over every dukaan and every grahak. ↑↓ Enter, Esc closes. */
export function GoTo({ onClose }: { onClose: () => void }) {
  const { shops } = useShops()
  const [q, setQ] = useState('')
  const [people, setPeople] = useState<MarketCustomer[]>([])
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    const query = q.trim()
    if (!query) return
    let live = true
    const t = setTimeout(() => {
      api<{ customers: MarketCustomer[] }>(`/v1/admin/customers?q=${encodeURIComponent(query)}`)
        .then((r) => { if (live) setPeople(r.customers.slice(0, 8)) }).catch(() => {})
    }, 200)
    return () => { live = false; clearTimeout(t) }
  }, [q])

  const query = q.trim().toLowerCase()
  const shopOpts: Option[] = (shops ?? [])
    .filter((s) => s.status === 'approved' && (!query || `${s.name} ${s.mandi} ${s.owner.phone}`.toLowerCase().includes(query)))
    .slice(0, query ? 5 : 8)
    .map((s) => ({ key: s.id, section: 'Dukaan', title: s.name, sub: [s.mandi, phone(s.owner.phone)].filter(Boolean).join(' · '), right: `Aaj ${rupees(s.todaySalesPaise)}`, to: href({ page: 'shop', shopId: s.id, tab: 'hisab' }) }))
  const personOpts: Option[] = query ? people.map((c) => ({
    key: c.key, section: 'Grahak', title: c.name, sub: [c.phone && phone(c.phone), c.shops.map((s) => s.shopName).join(', ')].filter(Boolean).join(' · '),
    right: c.balancePaise > 0 ? `${rupees(c.balancePaise)} baaki` : undefined, to: href({ page: 'person', key: c.key }),
  })) : []
  const options = [...personOpts, ...shopOpts]
  const current = Math.min(sel, Math.max(0, options.length - 1))

  const go = (o?: Option) => { if (!o) return; location.hash = o.to; onClose() }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="Go To" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input} className="field" placeholder="Grahak ka naam, mobile, A/C code — ya dukaan" value={q}
          role="combobox" aria-expanded aria-controls="goto-results" aria-activedescendant={options[current] ? `goto-${current}` : undefined}
          onChange={(e) => { setQ(e.target.value); setSel(0) }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose() }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(options.length - 1, current + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, current - 1)) }
            else if (e.key === 'Enter') { e.preventDefault(); go(options[current]) }
          }}
        />
        <div className="results" id="goto-results" role="listbox">
          {options.map((o, i) => (
            <div key={`${o.section}-${o.key}`}>
              {(i === 0 || options[i - 1].section !== o.section) && <div className="sec">{o.section}</div>}
              <div id={`goto-${i}`} className="opt" role="option" aria-selected={i === current} onMouseEnter={() => setSel(i)} onClick={() => go(o)}>
                <span className="grow"><b>{o.title}</b><small>{o.sub}</small></span>
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
