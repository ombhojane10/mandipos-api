import { useEffect, useState } from 'react'
import { EntryForm } from './Entries'
import { EDIT_ENTRY, ENTRY_TYPES, OPEN_DRAFT, OPEN_ENTRY, openBolo, type EntryKind, type Editing, type VoiceDraft } from './kinds'
import { ENTRY_KEYS, letterOf } from '../keys'
import { Hot } from '../Hot'
import { t } from '../i18n'
import { MicIcon } from '../voice/MicIcon'
import { unlock } from '../voice/player'

/** A fresh key per draft, so a second spoken slip opens a fresh form rather than keeping the first's state. */
const seq = new WeakMap<VoiceDraft, number>()
let next = 0
const draftSeq = (d: VoiceDraft) => { if (!seq.has(d)) seq.set(d, ++next); return seq.get(d)! }


/** The menu of entries, the open form, and the "saved" note after it. */
export function NewEntry({ shopId }: { shopId: string }) {
  const [menu, setMenu] = useState(false)
  const [kind, setKind] = useState<EntryKind | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [toast, setToast] = useState('')
  const [draft, setDraft] = useState<VoiceDraft | null>(null)

  useEffect(() => {
    const on = (e: Event) => { const k = (e as CustomEvent<EntryKind | undefined>).detail; setEditing(null); setDraft(null); if (k) { setKind(k); setMenu(false) } else setMenu(true) }
    const edit = (e: Event) => { const x = (e as CustomEvent<Editing>).detail; setEditing(x); setKind(x.kind); setMenu(false) }
    const filled = (e: Event) => { const d = (e as CustomEvent<VoiceDraft>).detail; setEditing(null); setDraft(d); setKind(d.kind); setMenu(false) }
    addEventListener(OPEN_ENTRY, on)
    addEventListener(EDIT_ENTRY, edit)
    addEventListener(OPEN_DRAFT, filled)
    return () => { removeEventListener(OPEN_ENTRY, on); removeEventListener(EDIT_ENTRY, edit); removeEventListener(OPEN_DRAFT, filled) }
  }, [])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 3500); return () => clearTimeout(t) }, [toast])

  return (
    <>
      {menu && (
        <div className="scrim sheet-scrim" onClick={() => setMenu(false)} onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); return }
          // One letter picks the entry, as in Tally's Create menu.
          const k = ENTRY_KEYS[e.key.toLowerCase()]
          if (k && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); setKind(k); setMenu(false) }
        }}>
          <div className="sheet entry-menu" role="dialog" aria-label={t('Nayi entry')} onClick={(e) => e.stopPropagation()}>
            <div className="sheet-hd"><h3>{t('Nayi entry')}</h3><button type="button" className="icon-btn" aria-label={t('Band karein')} onClick={() => setMenu(false)}>✕</button></div>
            <button type="button" className="bolo-tile" autoFocus onClick={() => { unlock(); setMenu(false); openBolo() }}>
              <MicIcon /><b>{t('Bolo')}</b>
            </button>
            <div className="entry-grid">
              {ENTRY_TYPES.map((it) => (
                <button key={it.kind} type="button" onClick={() => { setDraft(null); setKind(it.kind); setMenu(false) }}>
                  <b><Hot label={it.label} k={letterOf(ENTRY_KEYS, it.kind)} /></b><small>{it.sub}</small>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {kind && <EntryForm key={editing ? `edit-${editing.kind === 'parchi' ? editing.bill.id : editing.kind === 'gaadi' ? editing.gaadi.truckId : editing.raseed.id}` : draft ? `voice-${kind}-${draftSeq(draft)}` : kind} kind={kind} editing={editing?.kind === kind ? editing : null}
        draft={draft?.kind === kind ? draft : null} shopId={shopId}
        onClose={() => { setKind(null); setEditing(null); setDraft(null) }} onSaved={setToast} />}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </>
  )
}
