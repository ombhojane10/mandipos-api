import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { unlock } from '../voice/player'
import { BoloChat } from './BoloChat'
import { BoloMark } from './Thread'

/**
 * Bolo beside any page: the round button bottom-right opens the same
 * conversation as the Bolo page in a side panel, told which screen it was opened on.
 */
export function BoloDock({ shopId, screen, onBoloPage }: { shopId: string; screen: string; onBoloPage: boolean }) {
  const [open, setOpen] = useState(false)
  useEffect(() => { if (onBoloPage) setOpen(false) }, [onBoloPage])
  useEffect(() => {
    if (!open) return
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    addEventListener('keydown', on)
    // A link or button in the chat went to another page (Khata kholein…): the panel would sit on
    // top of it, so it looked as if nothing happened. Step aside unless the screen has room for both.
    const path = () => location.hash.split('?')[0]
    let at = path()
    const moved = () => { if (path() !== at && innerWidth < 1200) setOpen(false); at = path() }
    addEventListener('hashchange', moved)
    return () => { removeEventListener('keydown', on); removeEventListener('hashchange', moved) }
  }, [open])
  if (onBoloPage) return null
  return (
    <>
      {!open && (
        <button type="button" className="bc-fab" aria-label={t('Bolo')} title={t('Bolo')} onClick={() => { unlock(); setOpen(true) }}>
          <BoloMark />
        </button>
      )}
      {open && (
        <div className="bc-side" role="dialog" aria-label={t('Bolo')}>
          <BoloChat shopId={shopId} mode="panel" screen={screen} onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  )
}
