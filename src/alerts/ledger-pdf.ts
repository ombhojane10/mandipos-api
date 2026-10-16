/**
 * A grahak's khata as A4 pages, set the way the POS app prints it (LedgerPdf.kt) and the shop's
 * own accounts do ("CUSTOMER LEDGER"): the firm and address on the left, the bank accounts a
 * grahak pays into on the right, Code · Description · Address, From/To and "Page 1 of 1", then
 * Date · Particulars · Qty · DEBIT · CREDIT · Balance in typewriter figures, opening balance
 * first and TOTAL ruled off. Every page carries the full head, as theirs does.
 *
 * Built on the server so the WhatsApp udhaar can carry it from any trigger (portal, Bolo).
 */
export type LedgerInput = {
  firm: { name: string; address: string; banks: { holder: string; bank: string; ifsc: string; account: string }[] }
  buyer: { name: string; code: string; phone: string; destination: string; address: string }
  /** Oldest first: what each line added (debit) or took off (credit). */
  rows: { date: string; particulars: string; qty: number; debitPaise: number; creditPaise: number }[]
  to: string
}

const W = 595, H = 842, M = 36, ROW = 16.5
/** Column edges: Date | Particulars | Qty | DEBIT | CREDIT | Balance. */
const X = [M, M + 60, M + 212, M + 252, M + 332, M + 412, W - M]

const amount = (p: number) => (p ? (p / 100).toFixed(2) : '')
const balance = (p: number) => `${(Math.abs(p) / 100).toFixed(2)} ${p >= 0 ? 'baaki' : 'jama'}`
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`
const dmyLong = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
/** The app prints initials where the shop keeps no code ("CMAS"). */
const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 6)
/** Helvetica/Courier carry Latin-1 only: anything else (Devanagari, ₹) would print as boxes. */
const latin = (s: string) => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '').replace(/\s+/g, ' ').trim()

export async function ledgerPdf(input: LedgerInput): Promise<Buffer> {
  const { default: PDFDocument } = await import('pdfkit')
  const doc = new PDFDocument({ size: [W, H], margin: 0, autoFirstPage: false, info: { Title: `Ledger ${latin(input.buyer.name)}`, Producer: 'MandiPlus' } })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))))

  type Line = { date: string; text: string; qty: string; debit: string; credit: string; bal: string; strong?: boolean }
  const from = input.rows[0]?.date ?? input.to
  let run = 0
  const lines: Line[] = [{ date: dmy(from), text: 'Opening Balance...', qty: '', debit: '', credit: '', bal: balance(0) }]
  for (const r of input.rows) {
    run += r.debitPaise - r.creditPaise
    lines.push({ date: dmy(r.date), text: latin(r.particulars), qty: r.qty ? String(r.qty) : '', debit: amount(r.debitPaise), credit: amount(r.creditPaise), bal: balance(run) })
  }
  const sum = (k: 'qty' | 'debitPaise' | 'creditPaise') => input.rows.reduce((s, r) => s + r[k], 0)
  lines.push({ date: '', text: 'TOTAL...', qty: sum('qty') ? String(sum('qty')) : '', debit: amount(sum('debitPaise')), credit: amount(sum('creditPaise')), bal: balance(run), strong: true })

  const banks = input.firm.banks.filter((b) => b.holder || b.bank || b.account)
  const text = (s: string, x: number, y: number, font: string, size: number, align: 'left' | 'center' | 'right' = 'left', width = 0) => {
    if (!s) return
    doc.font(font).fontSize(size)
    const w = width || doc.widthOfString(s)
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x
    doc.text(s, left, y, { width: w + 1, align, lineBreak: false })
  }
  const rule = (x1: number, y1: number, x2: number, y2: number, wd = 0.8) => doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(wd).strokeColor('#111111').stroke()
  const fit = (s: string, font: string, size: number, room: number) => {
    doc.font(font).fontSize(size)
    if (doc.widthOfString(s) <= room) return s
    let t = s
    while (t.length > 1 && doc.widthOfString(`${t}…`) > room) t = t.slice(0, -1)
    return `${t}...`
  }

  /** The head of every page; returns where the first row goes. */
  const head = (page: number, pages: number) => {
    const midL = M + 135, midR = W - M - 118
    let yl = M + 28
    text(latin(input.firm.name).toUpperCase(), midL, yl, 'Helvetica-Bold', 15, 'center')
    yl += 20
    text(fit(latin(input.firm.address).toUpperCase(), 'Helvetica-Bold', 8.8, 250), midL, yl, 'Helvetica-Bold', 8.8, 'center')
    yl += 30
    text('CUSTOMER LEDGER', midL, yl, 'Helvetica-Bold', 10, 'center')
    yl += 12
    let yr = M + 10
    banks.forEach((a, i) => {
      if (i > 0) { yr += 4; rule(midR - 100, yr, midR + 100, yr); yr += 8 }
      text(latin(a.holder).toUpperCase(), midR, yr, 'Helvetica-Bold', 11, 'center'); yr += 14
      const bankLine = [a.bank && `${latin(a.bank).toUpperCase()} A/C`, a.ifsc && `IFSC CODE:- ${a.ifsc.toUpperCase()}`].filter(Boolean).join(', ')
      text(bankLine, midR, yr, 'Helvetica-Bold', 9.4, 'center'); yr += 13
      if (a.account) { text(`1. ${a.account}`, midR, yr, 'Helvetica-Bold', 9.4, 'center'); yr += 12 }
    })
    let y = Math.max(yl, yr) + 34
    const b = input.buyer
    for (const [k, v] of [
      ['A/C Code', b.code || initials(latin(b.name))],
      ['Description', [b.name, b.destination, b.phone].filter(Boolean).map(latin).join(' ').toUpperCase()],
      ['Address', latin(b.address).toUpperCase()],
    ] as const) {
      text(k, M + 20, y, 'Helvetica', 9.8); text(':', M + 84, y, 'Helvetica', 9.8); text(v, M + 92, y, 'Helvetica-Bold', 10)
      y += 14
    }
    y += 26
    text(`From : ${dmyLong(from)}`, M + 20, y, 'Helvetica-Bold', 10.5)
    text(`To : ${dmyLong(input.to)}`, M + 190, y, 'Helvetica-Bold', 10.5)
    text(`Page ${page} of ${pages}`, W - M - 10, y - 2, 'Helvetica-Bold', 9.8, 'right')
    y += 18
    const top = y, bottom = y + 16
    rule(M, top, W - M, top); rule(M, bottom, W - M, bottom)
    for (let i = 1; i <= 5; i++) rule(X[i], top, X[i], bottom)
    ;['Date', 'Particulars', 'Qty', 'DEBIT', 'CREDIT', 'Balance'].forEach((h, i) => text(h, (X[i] + X[i + 1]) / 2, top + 4, 'Helvetica-Bold', 9.8, 'center'))
    return bottom + 5
  }

  // The head's height depends on the bank accounts; measure once on a throwaway page size.
  const headH = 76 + Math.max(0, banks.length * 39 - 32) + 34 + 42 + 26 + 18 + 21
  const perPage = Math.max(5, Math.floor((H - M - headH - ROW) / ROW))
  const pages: Line[][] = []
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage))
  pages.forEach((chunk, i) => {
    doc.addPage({ size: [W, H], margin: 0 })
    let y = head(i + 1, pages.length)
    for (const l of chunk) {
      const font = l.strong ? 'Courier-Bold' : 'Courier'
      if (l.strong) rule(M, y - 3, W - M, y - 3)
      text(l.date, X[0] + 2, y, font, 9.6)
      text(fit(l.text, font, 9.6, X[2] - X[1] - 8), X[1] + 4, y, font, 9.6)
      text(l.qty, X[3] - 6, y, font, 9.6, 'right')
      text(l.debit, X[4] - 6, y, font, 9.6, 'right')
      text(l.credit, X[5] - 6, y, font, 9.6, 'right')
      text(l.bal, X[6] - 2, y, font, 9.6, 'right')
      if (l.strong) rule(M, y + 12, W - M, y + 12)
      y += ROW
    }
  })
  doc.end()
  return done
}
