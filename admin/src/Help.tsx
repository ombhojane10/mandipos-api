import { useEffect, useState } from 'react'
import { HELP_EVENT } from './keys'

const GROUPS: { title: string; rows: [string, string][] }[] = [
  { title: 'Report kholein', rows: [['H', 'Dashboard'], ['D', 'Day Book'], ['C', 'Cash / Bank Book'], ['O', 'Outstanding'], ['L', 'Grahak Ledger'], ['P', 'Supplier Khata'], ['S', 'Stock Summary'], ['I', 'Maal-wise Bikri'], ['T', 'Team & Machine']] },
  { title: 'Nayi entry', rows: [['N', 'Entry menu, phir: P Parchi · V Vasooli · K Kharcha · S Supplier · G Gaadi · N Grahak · U Udhaar'], ['F8', 'Nayi Parchi'], ['F9', 'Nayi Gaadi'], ['F6', 'Vasooli'], ['Ctrl + Enter', 'Save'], ['Esc', 'Band karein']] },
  { title: 'Chalna', rows: [['G', 'Go To — grahak, report, dukaan'], ['/', 'Dhoondhein'], ['↑ ↓', 'Line chunein'], ['Enter', 'Kholein (parchi, khata)'], ['Esc', 'Ek level peeche'], ['← →', 'Pichhla / agla din'], ['F2', 'Tarikh badlein'], ['?', 'Yeh list']] },
]

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
      <div className="sheet help" role="dialog" aria-label="Shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-hd"><h3>Shortcuts</h3><button type="button" className="icon-btn" autoFocus aria-label="Band karein" onClick={() => setOpen(false)}>✕</button></div>
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
