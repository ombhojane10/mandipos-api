import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type BuyerRow } from '../api'
import { phone, rupees } from '../format'
import { t } from '../i18n'

/** A sheet for one entry: title, the form, Save. Esc or the scrim closes it; Ctrl+Enter saves. */
export function Sheet({ title, onClose, onSave, saving, error, saveLabel = t('Save'), wide, children }: {
  title: string; onClose: () => void; onSave: () => void; saving: boolean; error: string; saveLabel?: string; wide?: boolean; children: ReactNode
}) {
  return (
    <div className="scrim sheet-scrim" onClick={() => !saving && onClose()}>
      <form className={`sheet${wide ? ' wide' : ''}`} role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSave() } }}
        onSubmit={(e) => { e.preventDefault(); onSave() }}>
        <div className="sheet-hd"><h3>{title}</h3><button type="button" className="icon-btn" aria-label={t('Band karein')} onClick={onClose}>✕</button></div>
        <div className="sheet-bd">{children}</div>
        {error && <p className="error" role="alert" style={{ padding: '0 20px' }}>{error}</p>}
        <div className="sheet-ft">
          <button type="button" className="btn ghost" disabled={saving} onClick={onClose}><kbd>Esc: </kbd>{t('Rehne dein')}</button>
          <button type="submit" className="btn primary" disabled={saving}>{saving ? '…' : <><kbd>Ctrl+↵: </kbd>{saveLabel}</>}</button>
        </div>
      </form>
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="fld">
      <span className="fld-lb">{label}</span>
      {children}
      {hint && <span className="fld-hint">{hint}</span>}
    </label>
  )
}

/** Rupees in, paise out. Empty = 0. */
export function Money({ value, onChange, autoFocus, placeholder = '0' }: { value: number; onChange: (paise: number) => void; autoFocus?: boolean; placeholder?: string }) {
  const [text, setText] = useState(value ? String(value / 100) : '')
  useEffect(() => { if (Math.round(Number(text || 0) * 100) !== value) setText(value ? String(value / 100) : '') }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className="money-in">
      <span>₹</span>
      <input className="field" inputMode="decimal" placeholder={placeholder} autoFocus={autoFocus} value={text}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1')
          setText(t); onChange(Math.round(Number(t || 0) * 100))
        }} />
    </span>
  )
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { key: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg wide" role="group">
      {options.map((o) => <button type="button" key={o.key} aria-pressed={value === o.key} onClick={() => onChange(o.key)}>{o.label}</button>)}
    </div>
  )
}

export type PickedBuyer = { id: string | null; name: string; balancePaise?: number; address?: string; destination?: string; sub?: string }

/** The counter's walk-ins, first in the list as on the parchi screen: no khata, paid there and then. */
export const WALK_INS = ['Cash', 'Bank'] as const
export const isWalkInName = (name: string) => WALK_INS.some((w) => w.toLowerCase() === name.trim().toLowerCase())
const walkInLabel = (name: string) => (name === 'Bank' ? t('Bank (UPI)') : t('Cash grahak'))

/**
 * Grahak by name, mobile or code — with the baaki beside each. [walkIn] puts Cash and Bank first
 * and adds "Naya: <name>" for a name the shop hasn't seen, as the parchi screen allows.
 */
export function BuyerPicker({ shopId, value, onChange, walkIn, autoFocus }: {
  shopId: string; value: PickedBuyer | null; onChange: (b: PickedBuyer | null) => void; walkIn?: boolean; autoFocus?: boolean
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<BuyerRow[]>([])
  const [sel, setSel] = useState(0)
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    const t = setTimeout(() => {
      api<{ buyers: BuyerRow[] }>(`/v1/admin/shops/${shopId}/buyers?q=${encodeURIComponent(q.trim())}`)
        .then((r) => { if (live) setList(r.buyers.filter((b) => !b.hidden).slice(0, 8)) }).catch(() => {})
    }, 150)
    return () => { live = false; clearTimeout(t) }
  }, [q, open, shopId])

  const typed = q.trim().toLowerCase()
  const opts: PickedBuyer[] = [
    ...(walkIn ? WALK_INS.filter((w) => !typed || w.toLowerCase().startsWith(typed)).map((w) => ({ id: null, name: w })) : []),
    ...list.map((b) => ({ id: b.id, name: b.name, balancePaise: b.balancePaise, sub: b.phone, address: b.address, destination: b.destination })),
    ...(walkIn && typed && !isWalkInName(typed) && !list.some((b) => b.name.toLowerCase() === typed) ? [{ id: null, name: q.trim() }] : []),
  ]
  const pick = (b: PickedBuyer) => { onChange(b); setOpen(false); setQ('') }

  if (value && !open) {
    return (
      <button type="button" className="picked" onClick={() => { setOpen(true); setTimeout(() => box.current?.focus()) }}>
        <b>{value.id === null && isWalkInName(value.name) ? walkInLabel(value.name) : value.name}</b>
        {value.id === null && !isWalkInName(value.name) && <span className="chip blue">{t('Naya')}</span>}
        {value.balancePaise ? <span className={`money ${value.balancePaise > 0 ? 'due' : 'jama'}`}>{rupees(Math.abs(value.balancePaise))} {value.balancePaise > 0 ? t('baaki') : t('jama')}</span> : null}
        <span className="muted">{t('Badlein')}</span>
      </button>
    )
  }
  return (
    <div className="combo">
      <input ref={box} className="field" placeholder={t('Naam, mobile ya code')} value={q} autoFocus={autoFocus}
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setSel(0); setOpen(true) }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(opts.length - 1, sel + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, sel - 1)) }
          else if (e.key === 'Enter' && opts[sel]) { e.preventDefault(); pick(opts[sel]) }
        }} />
      {open && opts.length > 0 && (
        <div className="combo-list" role="listbox">
          {opts.map((o, i) => (
            <div key={`${o.id ?? 'new'}-${o.name}`} role="option" aria-selected={i === sel} className="opt"
              onMouseDown={(e) => { e.preventDefault(); pick(o) }} onMouseEnter={() => setSel(i)}>
              <span className="grow">
                <b>{o.id === null ? (isWalkInName(o.name) ? walkInLabel(o.name) : t('Naya grahak: {name}', { name: o.name })) : o.name}</b>
                {o.sub ? <small>{phone(o.sub)}</small> : null}
              </span>
              {o.balancePaise ? <span className={`money ${o.balancePaise > 0 ? 'due' : 'jama'}`}>{rupees(Math.abs(o.balancePaise))}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** A row of chips; tapping the lit one again clears it when [clearable]. */
export function Chips<T extends string>({ value, options, onChange, clearable }: { value: T | ''; options: { key: T; label: string }[]; onChange: (v: T | '') => void; clearable?: boolean }) {
  return (
    <div className="chips" role="group">
      {options.map((o) => (
        <button type="button" key={o.key} aria-pressed={value === o.key}
          onClick={() => onChange(value === o.key && clearable ? '' : o.key)}>{o.label}</button>
      ))}
    </div>
  )
}

/** A tick row, as the app's tickRow: the whole line toggles. */
export function Tick({ label, on, onChange, children }: { label: string; on: boolean; onChange: (on: boolean) => void; children?: ReactNode }) {
  return (
    <div className="tick-row">
      <label className="tick"><input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} /><span>{label}</span></label>
      {children}
    </div>
  )
}
