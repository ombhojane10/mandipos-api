import { useEffect, useState } from 'react'
import { HELP_EVENT } from './keys'
import { t } from './i18n'

const GROUPS: { title: string; rows: [string, string][] }[] = [
  { title: 'Report kholein', rows: [['H', 'Dashboard'], ['D', 'Day Book'], ['C', 'Cash / Bank Book'], ['O', 'Outstanding'], ['L', 'Grahak Ledger'], ['P', 'Supplier Khata'], ['S', 'Stock Summary'], ['I', 'Maal-wise Bikri'], ['T', 'Team & Machine'], ['R', 'Bikri Register'], ['M', 'Munafa (P&L)'], ['V', 'Vasooli'], ['A', 'Gaadi Hisab'], ['B', 'Aaj ka Bhav'], ['X', 'Nigrani']] },
  { title: 'Nayi entry', rows: [['N', 'Entry menu, phir: P Parchi · V Vasooli · K Kharcha · S Supplier · G Gaadi · N Grahak · U Udhaar'], ['F8', 'Nayi Parchi'], ['F9', 'Nayi Gaadi'], ['F6', 'Vasooli'], ['Ctrl + Enter', 'Save'], ['Esc', 'Band karein']] },
  { title: 'Parchi / raseed khuli ho', rows: [['A', 'Alter — badlein'], ['D', 'Delete — hatayein'], ['Alt + X', 'Delete — hatayein'], ['Y', 'Haan, hatayein'], ['R', 'Paisa wapas (refund)'], ['V', 'Advance mein rakhein']] },
  { title: 'Chalna', rows: [['G', 'Go To — grahak, report, dukaan'], ['/', 'Dhoondhein'], ['↑ ↓', 'Line chunein'], ['Enter', 'Kholein (parchi, raseed, khata)'], ['Esc', 'Ek level peeche'], ['← →', 'Pichhla / agla din'], ['F2', 'Tarikh badlein'], ['E', 'Export — dekhein, phir Print / Share / Excel'], ['Ctrl + P', 'Print'], ['F12', 'Settings'], ['?', 'Yeh list']] },
].map((g) => ({ title: t(g.title), rows: g.rows.map(([k, l]) => [k, t(l)] as [string, string]) }))

/** Every key on one page, as Tally lists them — opened with ?. */
export function Help() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const on = () => setOpen(true)
    addEventListener(HELP_EVENT, on)
    return () => removeEventListener(HELP_EVENT, on)
  }, [])
  if (!open) return null
  return (
    <div className="scrim" onClick={() => setOpen(false)} onKeyDown={(e) => { if (e.key === 'Escape' || e.key === '?') { e.stopPropagation(); setOpen(false) } }}>
      <div className="sheet help" role="dialog" aria-label={t('Shortcuts')} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-hd"><h3>{t('Shortcuts')}</h3><button type="button" className="icon-btn" autoFocus aria-label={t('Band karein')} onClick={() => setOpen(false)}>✕</button></div>
        <div className="help-grid">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="fld-lb" style={{ marginBottom: 6 }}>{g.title}</div>
              {g.rows.map(([k, l]) => <div key={k + l} className="help-row"><kbd>{k}</kbd><span>{l}</span></div>)}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
