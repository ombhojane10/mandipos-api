import { useEffect, useState } from 'react'
import { EntryForm } from './Entries'
import { ENTRY_TYPES, OPEN_ENTRY, type EntryKind } from './kinds'

/** The menu of entries, the open form, and the "saved" note after it. */
export function NewEntry({ shopId }: { shopId: string }) {
  const [menu, setMenu] = useState(false)
  const [kind, setKind] = useState<EntryKind | null>(null)
  const [toast, setToast] = useState('')

  useEffect(() => {
    const on = (e: Event) => { const k = (e as CustomEvent<EntryKind | undefined>).detail; if (k) { setKind(k); setMenu(false) } else setMenu(true) }
    addEventListener(OPEN_ENTRY, on)
    return () => removeEventListener(OPEN_ENTRY, on)
  }, [])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 3500); return () => clearTimeout(t) }, [toast])

  return (
    <>
      {menu && (
        <div className="scrim sheet-scrim" onClick={() => setMenu(false)} onKeyDown={(e) => { if (e.key === 'Escape') setMenu(false) }}>
          <div className="sheet entry-menu" role="dialog" aria-label="Nayi entry" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-hd"><h3>Nayi entry</h3><button type="button" className="icon-btn" aria-label="Band karein" onClick={() => setMenu(false)}>✕</button></div>
            <div className="entry-grid">
              {ENTRY_TYPES.map((t, i) => (
                <button key={t.kind} type="button" autoFocus={i === 0} onClick={() => { setKind(t.kind); setMenu(false) }}>
                  <b>{t.label}</b><small>{t.sub}</small>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {kind && <EntryForm kind={kind} shopId={shopId} onClose={() => setKind(null)} onSaved={setToast} />}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </>
  )
}
