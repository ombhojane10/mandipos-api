import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../i18n'
import { EXPORT_EVENT, exportBuilder, type ExportDoc } from './doc'
import { csv, download, pdf, share } from './save'

/** Rows that fit an A4 page under its header (fixed-height rows, so the count is exact). */
const FIRST_PAGE = 30
const NEXT_PAGE = 40
const PAGE_W = 794

const canShareFiles = () => {
  try { return !!navigator.canShare?.({ files: [new File([''], 'x.pdf', { type: 'application/pdf' })] }) } catch { return false }
}

/**
 * Export, as Tally does it: the report laid out as A4 pages first, then Print, Share (PDF to
 * WhatsApp and the like) or Excel. Opened with the top bar's Export or the E key.
 */
export function ExportHost({ shop }: { shop: { name: string; mandi?: string; shopNo?: string } | null }) {
  const [doc, setDoc] = useState<ExportDoc | null>(null)
  useEffect(() => {
    const on = () => setDoc(exportBuilder()?.() ?? null)
    addEventListener(EXPORT_EVENT, on)
    return () => removeEventListener(EXPORT_EVENT, on)
  }, [])
  if (!doc) return null
  return createPortal(<Preview doc={doc} shop={shop} onClose={() => setDoc(null)} />, document.body)
}

function Preview({ doc, shop, onClose }: { doc: ExportDoc; shop: { name: string; mandi?: string; shopNo?: string } | null; onClose: () => void }) {
  const stack = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const sharing = canShareFiles()

  const pages: ExportDoc['rows'][] = []
  pages.push(doc.rows.slice(0, FIRST_PAGE))
  for (let i = FIRST_PAGE; i < doc.rows.length; i += NEXT_PAGE) pages.push(doc.rows.slice(i, i + NEXT_PAGE))
  const printed = new Date().toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })
  const shopLine = shop ? [shop.mandi, shop.shopNo && `${t('Dukaan')} ${shop.shopNo}`].filter(Boolean).join(' · ') : ''

  // A phone shows the pages shrunk to its width; print and PDF always use the full A4 size.
  useLayoutEffect(() => {
    const fit = () => setZoom(Math.min(1, (window.innerWidth - 24) / PAGE_W))
    fit()
    addEventListener('resize', fit)
    return () => removeEventListener('resize', fit)
  }, [])
  useEffect(() => {
    document.body.classList.add('exporting')
    return () => document.body.classList.remove('exporting')
  }, [])

  const paperEls = () => [...(stack.current?.querySelectorAll<HTMLElement>('.paper') ?? [])]
  const run = async (what: 'pdf' | 'excel') => {
    setBusy(what); setNote('')
    try {
      if (what === 'excel') { download(csv(doc), `${doc.file}.csv`); setNote(t('Excel file save hui')); return }
      const blob = await pdf(paperEls())
      const done = await share(blob, `${doc.file}.pdf`, [doc.title, doc.name].filter(Boolean).join(' · '))
      if (done === 'saved') setNote(t('PDF save hui'))
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const print = () => window.print()

  return (
    <div className="export-root" role="dialog" aria-label={t('Export')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose() }
        else if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey) { e.preventDefault(); print() }
        else if (e.key === 's' || e.key === 'S') { e.preventDefault(); void run('pdf') }
        else if (e.key === 'x' || e.key === 'X') { e.preventDefault(); void run('excel') }
      }}>
      <div className="export-bar">
        <button type="button" className="icon-btn" aria-label={t('Band karein')} autoFocus onClick={onClose}>✕</button>
        <b className="grow">{doc.title}{doc.name ? ` · ${doc.name}` : ''}</b>
        {note && <span className="muted hide-sm">{note}</span>}
        <button type="button" className="btn line" disabled={!!busy} onClick={() => void run('excel')}>{busy === 'excel' ? '…' : 'Excel'}</button>
        <button type="button" className="btn line" disabled={!!busy} onClick={() => void run('pdf')}>{busy === 'pdf' ? '…' : sharing ? t('Share') : 'PDF'}</button>
        <button type="button" className="btn primary" disabled={!!busy} onClick={print}>{t('Print')}</button>
      </div>
      <div className="export-scroll">
        <div className="paper-stack" ref={stack} style={{ zoom }}>
          {pages.map((rows, i) => (
            <section key={i} className="paper">
              {i === 0 ? (
                <header className="paper-hd">
                  <div className="paper-shop">
                    <b>{shop?.name ?? 'MandiPlus'}</b>
                    {shopLine && <span>{shopLine}</span>}
                  </div>
                  <div className="paper-title">
                    <b>{doc.title}</b>
                    {doc.period && <span>{doc.period}</span>}
                  </div>
                </header>
              ) : (
                <header className="paper-hd small"><span>{shop?.name} · {doc.title}{doc.name ? ` · ${doc.name}` : ''}</span><span>{doc.period}</span></header>
              )}
              {i === 0 && (doc.name || doc.summary?.length) ? (
                <div className="paper-party">
                  {doc.name && <div><b>{doc.name}</b>{doc.sub && <span>{doc.sub}</span>}</div>}
                  {doc.summary && doc.summary.length > 0 && (
                    <dl>{doc.summary.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
                  )}
                </div>
              ) : null}
              <table className="paper-tbl">
                <thead><tr>{doc.columns.map((c, j) => <th key={j} className={`${c.num ? 'num' : ''}${c.wide ? ' wide' : ''}`}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {rows.map((r, j) => r.band
                    ? <tr key={j} className="band"><td colSpan={doc.columns.length}>{r.cells[0]}</td></tr>
                    : (
                      <tr key={j} className={[r.bold && 'b', r.muted && 'muted', r.strike && 'strike'].filter(Boolean).join(' ') || undefined}>
                        {r.cells.map((c, k) => <td key={k} className={doc.columns[k]?.num ? 'num' : undefined}>{c}</td>)}
                      </tr>
                    ))}
                </tbody>
                {i === pages.length - 1 && doc.foot && (
                  <tfoot><tr>{doc.foot.map((c, k) => <td key={k} className={doc.columns[k]?.num ? 'num' : undefined}>{c}</td>)}</tr></tfoot>
                )}
              </table>
              {rows.length === 0 && <p className="paper-empty">{t('Koi entry nahi')}</p>}
              <footer className="paper-ft"><span>MandiPlus · {printed}</span><span>{t('Page {n} / {of}', { n: i + 1, of: pages.length })}</span></footer>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
