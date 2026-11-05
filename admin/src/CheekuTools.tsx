import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { openExport, openWhatsapp } from './export/doc'
import { t } from './i18n'
import * as I from './icons'
import { PrintMachinePick } from './PrintPick'

/**
 * Cheeku: the print machine and "WhatsApp karein" on the page's own first row — at the right end of
 * the Aaj / Kal / 7 din / 30 din boxes — instead of the top bar. Each page draws that row itself
 * (a .toolbar straight under .main), so these are placed into it; a page without one gets a row
 * of their own at the top, right-aligned.
 */
export function CheekuTools({ shopId, canExport, print }: { shopId: string; canExport: boolean; print: boolean }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const main = document.querySelector<HTMLElement>('.main')
    if (!main) return
    const find = () => {
      const row = main.querySelector<HTMLElement>(':scope > .toolbar')
      setHost((h) => (h === row ? h : row))
    }
    find()
    // Pages draw their row once their data is in, and a new page swaps it out.
    const watch = new MutationObserver(find)
    watch.observe(main, { childList: true })
    return () => watch.disconnect()
  }, [])
  const tools = (
    <span className="cheeku-tools">
      <PrintMachinePick shopId={shopId} main={t('Print')} />
      {/* Print, as on grapes (Ctrl+P / Export): the page laid out on A4 in the preview, then its Print.
          Only on Maal-wise Bikri (its maal list and one maal opened from it). */}
      {print && canExport && (
        <button type="button" className="print-btn" onClick={openExport} title={`${t('Print')} (Ctrl+P)`}>
          <I.IPrint /><span>{t('Print')}</span>
        </button>
      )}
      {canExport && (
        <button type="button" className="wa-btn" onClick={openWhatsapp} title={t('Is page ki PDF WhatsApp par bhejein')}>
          <I.IWhatsapp /><span>{t('WhatsApp karein')}</span>
        </button>
      )}
    </span>
  )
  return host && host.isConnected ? createPortal(tools, host) : <div className="cheeku-tools-row">{tools}</div>
}
