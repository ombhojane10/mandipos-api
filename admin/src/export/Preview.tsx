import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type ShopSettings } from '../api'
import { t } from '../i18n'
import { EXPORT_EVENT, dmyLong, exportBuilder, longDay, type AutoSave, type ExportDoc, type ExportRow } from './doc'
import { todayIst } from '../format'
import { csv, download, pdf, share } from './save'

/** One A4 sheet at 96 dpi, and its margins — the app prints on 595 × 842 pt. */
const PAGE_W = 794
const PAGE_H = 1123
const PAD = 48
/** Fixed heights (index.css .paper …) so a page's rows can be counted before it is drawn. */
const ROW_H: Record<NonNullable<ExportRow['kind']> | 'row', number> = { row: 22, band: 26, heading: 40, total: 34, final: 40 }
const FOOT_H = 26
const SIGN_H = 120

type Firm = { name: string; place: string; address: string; banks: ShopSettings['bankAccounts'] }

const canShareFiles = () => {
  try { return !!navigator.canShare?.({ files: [new File([''], 'x.pdf', { type: 'application/pdf' })] }) } catch { return false }
}

/**
 * Export, as Tally does it: the report laid out as the app prints it first, then Print, Share
 * (PDF to WhatsApp and the like) or Excel. Opened with the top bar's Export or the E key.
 */
export function ExportHost({ shopId, fallback }: { shopId: string | null; fallback: { name: string; mandi?: string; shopNo?: string } | null }) {
  const [doc, setDoc] = useState<ExportDoc | null>(null)
  const [auto, setAuto] = useState<AutoSave | null>(null)
  const [firm, setFirm] = useState<Firm | null>(null)
  useEffect(() => {
    const on = (e: Event) => { setAuto((e as CustomEvent<{ auto?: AutoSave } | null>).detail?.auto ?? null); setDoc(exportBuilder()?.() ?? null) }
    const off = () => setDoc(null)
    addEventListener(EXPORT_EVENT, on)
    addEventListener('hashchange', off)
    return () => { removeEventListener(EXPORT_EVENT, on); removeEventListener('hashchange', off) }
  }, [])
  // The head prints the firm as the shop has set it up: its address, phad and bank accounts.
  useEffect(() => {
    if (!doc || !shopId) return
    const basic: Firm = { name: fallback?.name ?? '', place: [fallback?.shopNo, fallback?.mandi].filter(Boolean).join(', '), address: '', banks: [] }
    setFirm(basic)
    api<ShopSettings>(`/v1/admin/shops/${shopId}/settings`).then((s) => {
      const mandi = s.mandi && !/mandi/i.test(s.mandi) ? `${s.mandi} Mandi` : s.mandi
      setFirm({ name: s.name, place: [s.shopNo, mandi].filter(Boolean).join(', ') + (s.phad ? `  ·  Phad ${s.phad}` : ''), address: s.address, banks: s.bankAccounts })
    }).catch(() => {})
  }, [doc, shopId]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!doc) return null
  const head = doc.firm ? { name: doc.firm, place: '', address: '', banks: [] } : firm ?? { name: fallback?.name ?? 'MandiPlus', place: '', address: '', banks: [] }
  return createPortal(<Preview doc={doc} firm={head} auto={auto} onClose={() => setDoc(null)} />, document.body)
}

/** Rows split into pages by their printed height; the last page keeps room for the total and signatures. */
function paginate(doc: ExportDoc, budget: number): ExportRow[][] {
  const pages: ExportRow[][] = [[]]
  let used = 0
  for (const r of doc.rows) {
    const h = ROW_H[r.kind ?? 'row']
    if (used + h > budget && pages[pages.length - 1].length) { pages.push([]); used = 0 }
    pages[pages.length - 1].push(r)
    used += h
  }
  const tail = (doc.foot ? 34 : 0) + (doc.note ? 30 : 0) + (doc.sign ? SIGN_H : 0)
  if (used + tail > budget) pages.push([])
  return pages
}

function Preview({ doc, firm, auto, onClose }: { doc: ExportDoc; firm: Firm; auto: AutoSave | null; onClose: () => void }) {
  const stack = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  // What one page can hold under its head; measured once the head is drawn (it varies with the
  // shop's bank accounts), estimated until then.
  const [budget, setBudget] = useState(doc.style === 'ledger' ? 560 : 780)
  const sharing = canShareFiles()
  const pages = paginate(doc, budget)
  const printed = new Date().toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })

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
  useLayoutEffect(() => {
    const first = stack.current?.querySelector<HTMLElement>('.paper')
    if (!first) return
    const head = first.querySelector<HTMLElement>('.ph')?.offsetHeight ?? 0
    const thead = first.querySelector<HTMLElement>('.pt thead')?.offsetHeight ?? 0
    const next = PAGE_H - 2 * PAD - head - thead - FOOT_H - 8
    if (Math.abs(next - budget) > 2) setBudget(next)
  }, [firm, doc]) // eslint-disable-line react-hooks/exhaustive-deps

  const paperEls = () => [...(stack.current?.querySelectorAll<HTMLElement>('.paper') ?? [])]
  const run = async (what: 'pdf' | 'excel', direct = false) => {
    setBusy(what); setNote('')
    try {
      if (what === 'excel') { download(csv(doc), `${doc.file}.csv`); setNote(t('Excel file save hui')); return }
      const blob = await pdf(paperEls())
      if (direct) { download(blob, `${doc.file}.pdf`); setNote(t('PDF save hui')); return }
      const done = await share(blob, `${doc.file}.pdf`, [doc.title, doc.party?.description].filter(Boolean).join(' · '))
      if (done === 'saved') setNote(t('PDF save hui'))
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  // Bolo asked for the file: save it once the pages have their real size and the firm's head.
  useEffect(() => {
    if (!auto) return
    const id = setTimeout(() => void run(auto, true), 700)
    return () => clearTimeout(id)
  }, [auto]) // eslint-disable-line react-hooks/exhaustive-deps
  const print = () => window.print()
  const cols = doc.columns

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
        <b className="grow">{doc.title}{doc.party ? ` · ${doc.party.description}` : ''}</b>
        {note && <span className="muted hide-sm">{note}</span>}
        <button type="button" className="btn line" disabled={!!busy} onClick={() => void run('excel')}>{busy === 'excel' ? '…' : 'Excel'}</button>
        <button type="button" className="btn line" disabled={!!busy} onClick={() => void run('pdf')}>{busy === 'pdf' ? '…' : sharing ? t('Share') : 'PDF'}</button>
        <button type="button" className="btn primary" disabled={!!busy} onClick={print}>{t('Print')}</button>
      </div>
      <div className="export-scroll">
        <div className="paper-stack" ref={stack} style={{ zoom }}>
          {pages.map((rows, i) => {
            const last = i === pages.length - 1
            return (
              <section key={i} className={`paper ${doc.style}`}>
                {doc.style === 'ledger'
                  ? <LedgerHead doc={doc} firm={firm} page={i + 1} pages={pages.length} />
                  : <BookHead doc={doc} firm={firm} page={i + 1} pages={pages.length} />}
                {cols ? (
                  <table className="pt">
                    <thead><tr>{cols.map((c, j) => <th key={j} className={c.wide ? 'wide' : undefined}>{c.label}</th>)}</tr></thead>
                    <tbody>
                      {rows.map((r, j) => r.kind === 'band'
                        ? <tr key={j} className="band"><td colSpan={cols.length}>{r.cells[0]}</td></tr>
                        : (
                          <tr key={j} className={[r.bold && 'b', r.strike && 'strike'].filter(Boolean).join(' ') || undefined}>
                            {r.cells.map((c, k) => <td key={k} className={cols[k]?.num ? 'num' : undefined}>{c}</td>)}
                          </tr>
                        ))}
                    </tbody>
                    {last && doc.foot && (
                      <tfoot><tr>{doc.foot.map((c, k) => <td key={k} className={cols[k]?.num ? 'num' : undefined}>{c}</td>)}</tr></tfoot>
                    )}
                  </table>
                ) : (
                  <div className="ps">
                    {rows.map((r, j) => (
                      <div key={j} className={`ps-${r.kind ?? 'row'}`}>
                        <span className="l">{r.cells[0]}</span>
                        {r.kind !== 'heading' && <><span className="s">{r.cells[1] ?? ''}</span><span className="tm">{r.cells[2] ?? ''}</span><span className="a">{r.cells[3] ?? ''}</span></>}
                      </div>
                    ))}
                  </div>
                )}
                {doc.rows.length === 0 && i === 0 && <p className="paper-empty">{t('Koi entry nahi')}</p>}
                {last && doc.note && <p className="pnote">{doc.note}</p>}
                {last && doc.sign && (
                  <div className="psign"><span>MALIK</span><span>MUNIM</span></div>
                )}
                <footer className="pf"><span>{t('Print')}: {printed}</span><span>MandiPlus</span></footer>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** LedgerPdf's head: the firm left, its bank accounts right, the party, From/To and the page. */
function LedgerHead({ doc, firm, page, pages }: { doc: ExportDoc; firm: Firm; page: number; pages: number }) {
  const banks = doc.banks ? firm.banks.filter((b) => b.holder || b.bank || b.account) : []
  return (
    <header className="ph">
      <div className="lh">
        <div className="lh-firm">
          <b>{firm.name.toUpperCase()}</b>
          <span>{(firm.address || firm.place).toUpperCase()}</span>
          <em>{doc.title}</em>
        </div>
        {banks.length > 0 && (
          <div className="lh-banks">
            {banks.map((a, i) => (
              <div key={i}>
                <b>{a.holder.toUpperCase()}</b>
                <span>{[a.bank && `${a.bank.toUpperCase()} A/C`, a.ifsc && `IFSC CODE:- ${a.ifsc.toUpperCase()}`].filter(Boolean).join(', ')}</span>
                {a.account && <span>1. {a.account}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      {doc.party && (
        <div className="lh-party">
          {([['Code', doc.party.code], ['Description', doc.party.description], ['Address', doc.party.address]] as const)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => <div key={k}><span>{k}</span><span>:</span><b>{(v || '').toUpperCase()}</b></div>)}
        </div>
      )}
      <div className="lh-period">
        {doc.from && <b>From : {dmyLong(doc.from)}</b>}
        {doc.to && <b>To : {dmyLong(doc.to)}</b>}
        <span>Page {page} of {pages}</span>
      </div>
    </header>
  )
}

/** DaybookPdf's head: the firm and its place centred, the book and the day on one line, ruled off. */
function BookHead({ doc, firm, page, pages }: { doc: ExportDoc; firm: Firm; page: number; pages: number }) {
  return (
    <header className="ph">
      <div className="bh-firm">
        <b>{firm.name.toUpperCase()}</b>
        {(firm.address || firm.place) && <span>{(firm.address || firm.place).toUpperCase()}</span>}
      </div>
      <div className="bh-line">
        <b>{doc.title}{pages > 1 ? `  ·  PAGE ${page}/${pages}` : ''}</b>
        <b>{doc.dateLine ?? longDay(todayIst())}</b>
      </div>
      {page === 1 && doc.summary && doc.summary.length > 0 && (
        <dl className="bh-sum">{doc.summary.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      )}
    </header>
  )
}
