import QRCode from 'qrcode'
import heavyUrl from './slip-fonts/slip_sans_heavy.ttf?url'
import condUrl from './slip-fonts/slip_cond_bold.ttf?url'
import sansBoldUrl from './slip-fonts/slip_sans_semibold.ttf?url'
import serifUrl from './slip-fonts/slip_slab_bold.ttf?url'

/**
 * Cheeku's ORDER PARCHI drawn exactly as the Pine Labs terminal prints it, so the website can
 * print the same slip on the office's own printer. A line-for-line port of the app's
 * CheekuSlips.order (what goes on it) and SlipArt's 2-inch "roomy" Pen (how it is drawn): the
 * same bundled faces and sizes, laid out 307 units wide and drawn up to the head's 384 dots,
 * then cut to pure black and white as the heat head burns it. Change it only alongside those two.
 */

// ---------------------------------------------------------------- what the slip says (CheekuSlips.goods)

export type SlipBill = {
  id: string; slipNo: number | null; at: string; buyerName: string; payMode: string
  totalPaise: number; paidPaise: number; cashPaise: number; upiPaise: number; labourPaise: number; chungiPaise: number
  packing: string; panniName: string; packs: number; staff: string; upiBank: string
  lines: { brand: string; qty: number; ratePaise: number; leak: boolean; brandId: string }[]
  pickedQty?: number
  delivery: { address: string; stand: string } | null
  slip?: { gaadis: { number: string; location: string; supplier: string }[]; gramsByBrand: Record<string, number>; buyerAddress: string; buyerStand: string }
}
export type SlipShop = { name: string; mandi: string; shopNo: string; phad: string; gstin: string; phone: string; dispatchPhone: string; slipCode: string; udhaarRates: boolean; slipPhones: string[] }

type Head = { firm: string; band: string; numbers: string[]; gstin: string; code: string }
type Block =
  | { k: 'party'; label: string; name: string }
  | { k: 'field'; label: string; value: string; strong?: boolean; big?: boolean }
  | { k: 'item'; maal: string; grade: string; count: string; amount: string | null }
  | { k: 'money'; label: string; value: string; loud?: boolean }
  | { k: 'count'; label: string; value: string }
  | { k: 'total'; label: string; value: string }
  | { k: 'signs'; receiver: string | null; staff: string }
  | { k: 'banner'; text: string }
  | { k: 'spot'; label: string; text: string }
  | { k: 'qr'; data: string; caption: string }
type Slip = { head: Head; kind: string; serial: string; stamp: string; blocks: Block[]; rule: string }

const UNIT = 'Box'
const GOODS_SLIP = 'Maal sirf is parchi ke badle diya jayega. Bina parchi ke maal nahi milega.'
const PER_PACK: Record<string, number> = { katta10: 10, katta15: 15, katta20: 20, katta25: 25 }

export function groupIndian(n: number): string {
  const neg = n < 0
  const s = String(Math.abs(Math.trunc(n)))
  if (s.length <= 3) return (neg ? '-' : '') + s
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${rest},${s.slice(-3)}`
}
const money = (paise: number) => {
  const r = Math.trunc(paise / 100), p = Math.abs(paise % 100)
  return '₹' + (p === 0 ? groupIndian(r) : `${groupIndian(r)}.${String(p).padStart(2, '0')}`)
}
/** "93128 33350". */
const phone = (p: string) => { const d = p.replace(/\D/g, '').slice(-10); return d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : p }
const kgLabel = (g: number) => (g % 1000 === 0 ? `${g / 1000} kg` : `${(g / 1000).toFixed(1)} kg`)
const upiWay = (bank: string) => { const b = bank.replace(/··/g, ' ').replace(/\s+/g, ' ').trim(); return b ? `UPI - ${b}` : 'UPI' }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "3 Nov 2026  ·  9:49 AM", in the mandi's time. */
function stamp(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000)
  const h = d.getUTCHours(), m = d.getUTCMinutes()
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}  ·  ${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

function head(s: SlipShop, loginPhone: string): Head {
  const mandi = s.mandi.trim() ? (/mandi/i.test(s.mandi) ? s.mandi.trim() : `${s.mandi.trim()} Mandi`) : ''
  const place = [mandi, s.phad.trim() ? `Phad ${s.phad.trim()}` : ''].filter(Boolean)
  const band = [s.shopNo.trim(), ...place].filter(Boolean).join('  ·  ').toUpperCase()
  return { firm: s.name.trim(), band, numbers: [phone(s.phone || loginPhone), ...s.slipPhones.map(phone)].filter(Boolean), gstin: s.gstin.trim(), code: s.slipCode.trim() }
}

/** CheekuSlips.order: the counter's copy, with the CASH / UDHAAR bar, each gaadi and the QR. */
export function orderParchi(b: SlipBill, shop: SlipShop, loginPhone: string): Slip {
  const x = b.slip ?? { gaadis: [], gramsByBrand: {}, buyerAddress: '', buyerStand: '' }
  const qty = b.lines.reduce((s, l) => s + l.qty, 0)
  const baaki = Math.max(0, b.totalPaise - b.paidPaise)
  const going = b.delivery !== null
  const paid = baaki === 0
  const rated = paid || shop.udhaarRates
  const priced = rated && b.totalPaise > 0
  const cashSale = b.payMode === 'cash' && baaki === 0
  // Slips.saleGroups: one block per quality, mark and rate, in the order they were written.
  const groups = new Map<string, SlipBill['lines']>()
  for (const l of b.lines) {
    const key = JSON.stringify([l.brand, l.leak ? 'Leak' : '', l.leak ? 0 : l.ratePaise])
    groups.set(key, [...(groups.get(key) ?? []), l])
  }
  const items: Extract<Block, { k: 'item' }>[] = [...groups.values()].map((ls) => {
    const amount = ls.reduce((s, l) => s + l.qty * l.ratePaise, 0)
    const grams = x.gramsByBrand[ls[0].brandId]
    return { k: 'item', maal: ls[0].brand, grade: grams ? kgLabel(grams) : ls[0].leak ? 'Leak' : '', count: groupIndian(ls.reduce((s, l) => s + l.qty, 0)), amount: rated && amount > 0 ? money(amount) : null }
  })
  const blocks: Block[] = [
    { k: 'banner', text: baaki > 0 || (b.totalPaise === 0 && !['cash', 'upi', 'free'].includes(b.payMode)) ? 'UDHAAR' : b.upiPaise > 0 && b.cashPaise === 0 ? 'UPI' : 'CASH' },
    ...x.gaadis.flatMap((g): Block[] => g.location.trim() ? [{ k: 'spot', label: g.number ? `GAADI ${g.number}` : 'GAADI', text: g.location.toUpperCase() }]
      : g.number ? [{ k: 'field', label: 'Gaadi', value: g.number, big: true }] : []),
    { k: 'party', label: 'Grahak', name: cashSale ? 'Cash' : b.buyerName },
  ]
  if (b.payMode === 'after') blocks.push({ k: 'field', label: 'Dana', value: 'Payment ke baad', big: true })
  for (const it of items) { blocks.push(it); if (it.amount) blocks.push({ k: 'money', label: 'Rakam', value: it.amount }) }
  if (b.packing !== 'loose') {
    const per = PER_PACK[b.packing] ?? 10
    const bags = groupIndian(Math.ceil((b.packs > 0 ? b.packs : qty) / per))
    blocks.push({ k: 'field', label: 'Packing', big: true, value: b.packing === 'panni' ? `${bags} panni`
      : [bags, b.panniName.toLowerCase(), 'katta'].filter(Boolean).join(' ') + ` (${per} ${UNIT})` })
  }
  if (b.packing === 'panni' && b.panniName.trim()) blocks.push({ k: 'field', label: 'Panni', value: b.panniName, big: true })
  if (b.packing === 'loose' && b.panniName.trim()) blocks.push({ k: 'field', label: 'Packing', value: 'Parchune', big: true })
  if (items.length > 1) blocks.push({ k: 'count', label: `Kul ${UNIT}`, value: groupIndian(qty) })
  if (priced && b.chungiPaise > 0) {
    const labour = Math.min(Math.max(b.labourPaise, 0), b.chungiPaise)
    if (b.chungiPaise - labour > 0) blocks.push({ k: 'money', label: 'APMC 1%', value: money(b.chungiPaise - labour) })
    if (labour > 0) blocks.push({ k: 'money', label: `Mazdoori (${groupIndian(qty)} box)`, value: money(labour) })
  }
  if (priced) {
    blocks.push({ k: 'total', label: 'Kul rakam', value: money(b.totalPaise) })
    const parts = [b.cashPaise > 0 ? ['Cash', b.cashPaise] as const : null, b.upiPaise > 0 ? [upiWay(b.upiBank), b.upiPaise] as const : null].filter((p) => p !== null)
    if (parts.length === 1 && paid) blocks.push({ k: 'field', label: 'Payment', value: parts[0][0], strong: true })
    else for (const [way, p] of parts) blocks.push({ k: 'money', label: way, value: money(p) })
    if (!paid) blocks.push({ k: 'money', label: 'Udhaar', value: money(baaki) })
  }
  const picked = b.pickedQty ?? 0
  if (picked > 0) blocks.push({ k: 'field', label: 'Le gaye / baaki', value: `${groupIndian(picked)} / ${groupIndian(Math.max(0, qty - picked))}`, strong: true })
  blocks.push({ k: 'qr', data: b.id, caption: 'Gaadi par scan karein' })
  blocks.push({ k: 'signs', receiver: going ? 'Maal mila' : null, staff: b.staff.trim() || 'Munim' })
  return { head: head(shop, loginPhone), kind: 'ORDER PARCHI', serial: b.slipNo && b.slipNo > 0 ? String(b.slipNo) : '', stamp: stamp(b.at), blocks, rule: GOODS_SLIP }
}

// ---------------------------------------------------------------- how it is drawn (SlipArt.Pen, roomy)

/** The 2-inch roll and the Pine terminal: 384 dots, laid out 1.25× narrower and drawn up to it. */
const HEAD_DOTS = 384
const LAYOUT = Math.trunc(HEAD_DOTS / 1.25)
const SCALE = HEAD_DOTS / LAYOUT

type Face = 'heavy' | 'cond' | 'sansBold' | 'serif'
const FAMILY: Record<Face, string> = { heavy: 'MPSlipHeavy', cond: 'MPSlipCond', sansBold: 'MPSlipSansBold', serif: 'MPSlipSerif' }
const URL_OF: Record<Face, string> = { heavy: heavyUrl, cond: condUrl, sansBold: sansBoldUrl, serif: serifUrl }
let fontsReady: Promise<void> | null = null
function loadFonts() {
  fontsReady ??= Promise.all((Object.keys(FAMILY) as Face[]).map(async (f) => {
    const face = new FontFace(FAMILY[f], `url(${URL_OF[f]})`)
    document.fonts.add(await face.load())
  })).then(() => undefined)
  return fontsReady
}

type Paint = { face: Face; size: number; color: string; spacing: number }
const ink = (face: Face, size: number, color = '#000', spacing = 0): Paint => ({ face, size, color, spacing })
const caps = (size = 20) => ink('cond', size, '#000', 0.12)

class Pen {
  y = 8
  private readonly W = LAYOUT
  private readonly L = 5
  private readonly R = LAYOUT - 5
  private readonly CW = LAYOUT - 10
  constructor(private readonly c: CanvasRenderingContext2D) {}

  private set(p: Paint) {
    this.c.font = `${p.size}px ${FAMILY[p.face]}`
    this.c.letterSpacing = `${p.spacing * p.size}px`
    this.c.fillStyle = p.color
  }
  private measure(s: string, p: Paint) { this.set(p); return this.c.measureText(s).width }
  /** Android's Paint.ascent() (negative) and descent() from the face's own metrics. */
  private ascent(p: Paint) { this.set(p); return -this.c.measureText('Hg').fontBoundingBoxAscent }
  private descent(p: Paint) { this.set(p); return this.c.measureText('Hg').fontBoundingBoxDescent }
  private height(p: Paint) { return this.descent(p) - this.ascent(p) }
  private at(s: string, x: number, base: number, p: Paint, align: CanvasTextAlign = 'left') {
    this.set(p); this.c.textAlign = align; this.c.fillText(s, x, base)
  }
  /** Text with its top at [top]. */
  private text(s: string, x: number, top: number, p: Paint, align: CanvasTextAlign = 'left') { this.at(s, x, top - this.ascent(p), p, align) }
  /** Shrinks [p] until [s] fits, then clips with an ellipsis. Like the app, it changes [p] itself. */
  private fit(s: string, p: Paint, maxW: number, min: number) {
    while (this.measure(s, p) > maxW && p.size > min) p.size -= 1
    if (this.measure(s, p) <= maxW) return s
    let t = s
    while (t.length > 1 && this.measure(`${t}…`, p) > maxW) t = t.slice(0, -1)
    return `${t}…`
  }
  private wrap(s: string, p: Paint, maxW: number) {
    const out: string[] = []; let line = ''
    for (const word of s.split(' ')) {
      const next = line ? `${line} ${word}` : word
      if (this.measure(next, p) <= maxW || !line) line = next; else { out.push(line); line = word }
    }
    if (line) out.push(line)
    return out
  }
  private rule(weight = 2, from = this.L, to = this.R) { this.c.fillStyle = '#000'; this.c.fillRect(from, this.y, to - from, weight) }
  private display(s: string) {
    return s === s.toUpperCase() || s === s.toLowerCase() ? s.toLowerCase().split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : s
  }
  private monogram(h: Head) {
    if (h.code) return h.code
    const words = h.firm.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w))
    return words.length >= 2 ? words.slice(0, 3).map((w) => w.match(/\p{L}/u)![0].toUpperCase()).join('') : this.display(h.firm.trim())
  }

  draw(s: Slip, qr: (data: string) => { size: number; get: (x: number, y: number) => boolean }) {
    this.letterhead(s.head)
    if (s.kind || s.serial || s.stamp) this.title(s)
    let prev: Block | null = null
    for (const b of s.blocks) { this.block(b, prev, qr); prev = b }
    this.note(s.rule)
    this.y += 10
    return Math.trunc(this.y)
  }

  private letterhead(h: Head) {
    const name = ink('heavy', 48)
    this.text(this.fit(this.monogram(h), name, this.CW, 22), this.W / 2, this.y, name, 'center')
    this.y += this.height(name) + 2
    if (h.band) {
      const band = caps(19)
      this.text(this.fit(h.band, band, this.CW, 12), this.W / 2, this.y, band, 'center')
      this.y += this.height(band)
    }
    const contact = [...h.numbers, ...(h.gstin ? [`GSTIN ${h.gstin}`] : [])]
    const p = ink('sansBold', 22)
    const lines = contact.reduce<string[]>((acc, item) => {
      const joined = acc.length ? `${acc[acc.length - 1]}   ${item}` : null
      if (joined !== null && this.measure(joined, p) <= this.CW) acc[acc.length - 1] = joined; else acc.push(item)
      return acc
    }, [])
    for (const line of lines) { this.text(this.fit(line, p, this.CW, 12), this.W / 2, this.y + 2, p, 'center'); this.y += this.height(p) + 2 }
    this.y += 16; this.rule(2); this.y += 18
  }

  private title(s: Slip) {
    const top = this.y
    let bottom = top
    let left = this.CW
    const kind = caps(21)
    let base = top - this.ascent(kind)
    if (s.serial) {
      const num = ink('heavy', 52)
      const shown = this.fit(s.serial, num, this.CW * 0.42, 28)
      this.text(shown, this.R, top - 6, num, 'right')
      const no = caps(17)
      const noRight = this.R - this.measure(shown, num) - 6
      base = top - 6 - this.ascent(num)
      this.at('NO.', noRight, base, no, 'right')
      bottom = top - 6 + this.height(num) - 8
      left = noRight - this.measure('NO.', no) - 10 - this.L
    }
    this.at(this.fit(s.kind, kind, left, 14), this.L, base, kind)
    bottom = Math.max(bottom, base + this.descent(kind))
    if (s.stamp) {
      const st = ink('sansBold', 22)
      this.text(this.fit(s.stamp, st, this.CW, 15), this.L, bottom + 2, st)
      bottom += 2 + this.height(st)
    }
    this.y = bottom + 20
  }

  private block(b: Block, prev: Block | null, qr: (data: string) => { size: number; get: (x: number, y: number) => boolean }) {
    // Close the sale lines with a rule before whatever follows them (the total draws its own).
    if (prev?.k === 'item' && b.k !== 'item' && b.k !== 'total') { this.y += 12; this.rule(2); this.y += 16 }
    switch (b.k) {
      case 'party': {
        this.text(b.label.toUpperCase(), this.L, this.y, caps())
        this.y += this.height(caps())
        const name = ink('heavy', 44)
        const shown = b.name === b.name.toLowerCase() ? this.display(b.name) : b.name
        for (const line of this.wrap(shown, name, this.CW).slice(0, 2)) { this.text(this.fit(line, name, this.CW, 22), this.L, this.y, name); this.y += this.height(name) - 4 }
        this.y += 14
        break
      }
      case 'field': return this.field(b)
      case 'item': return this.item(b, prev?.k === 'item')
      case 'total': return this.total(b)
      case 'money': return this.money(b, prev?.k === 'money')
      case 'signs': return this.signs(b)
      case 'banner': return this.banner(b.text, 52, 76)
      case 'spot': return this.spot(b, 34, 46)
      case 'qr': {
        this.y += 18
        const m = qr(b.data)
        const cell = Math.max(Math.floor(220 / m.size), 3)
        const total = cell * m.size
        const x0 = Math.floor((this.W - total) / 2)
        this.c.fillStyle = '#000'
        for (let yy = 0; yy < m.size; yy++) for (let xx = 0; xx < m.size; xx++) if (m.get(xx, yy)) this.c.fillRect(x0 + xx * cell, this.y + yy * cell, cell, cell)
        this.y += total + 10
        if (b.caption) {
          const p = caps(20)
          const cap = b.caption.toUpperCase()
          this.text(cap, (this.W - this.measure(cap, p)) / 2, this.y, p)
          this.y += this.height(p) + 6
        }
        break
      }
      case 'count': {
        this.y += 6
        const label = caps(20)
        this.text(b.label.toUpperCase(), this.L, this.y, label)
        this.y += this.height(label)
        const num = ink('heavy', 72), unit = ink('heavy', 28)
        const base = this.y - this.ascent(num)
        this.at(b.value, this.L, base, num)
        this.at(UNIT, this.L + this.measure(b.value, num) + 8, base, unit)
        this.y += this.height(num) + 4
        break
      }
    }
  }

  private field(f: Extract<Block, { k: 'field' }>) {
    const label = caps()
    const value = ink('heavy', f.big ? 46 : f.strong ? 31 : 28)
    const l = f.label.toUpperCase()
    const room = this.CW - this.measure(l, label) - 20
    if (this.measure(f.value, value) <= room) {
      const rowH = this.height(value)
      const base = this.y + rowH - this.descent(value)
      this.at(l, this.L, base, label)
      this.at(f.value, this.R, base, value, 'right')
      this.y += rowH + 8
    } else {
      this.text(l, this.L, this.y, label)
      this.y += this.height(label)
      for (const line of this.wrap(f.value, value, this.CW)) { this.text(line, this.L, this.y, value); this.y += this.height(value) }
      this.y += 8
    }
  }

  private item(it: Extract<Block, { k: 'item' }>, following: boolean) {
    if (!following) { this.y += 4; this.rule(3); this.y += 14 } else { this.rule(2); this.y += 14 }
    const maal = ink('heavy', 40)
    const tag = ink('serif', 40)
    const tagW = it.grade ? this.measure(it.grade, tag) + 22 : 0
    const maalShown = this.fit(it.maal, maal, this.CW - tagW - 14, 16)
    const rowH = Math.max(this.height(maal), 54)
    this.text(maalShown, this.L, this.y + (rowH - this.height(maal)) / 2, maal)
    if (tagW > 0) {
      const x0 = this.L + this.measure(maalShown, maal) + 12
      this.c.strokeStyle = '#000'; this.c.lineWidth = 2.5
      this.c.beginPath(); this.c.roundRect(x0, this.y + 1, tagW, rowH - 2, 8); this.c.stroke()
      this.text(it.grade, x0 + tagW / 2, this.y + (rowH - this.height(tag)) / 2, tag, 'center')
    }
    this.y += rowH + 4
    // The count, large; "Box" beside it small. Cheeku never prints a per-box bhav.
    const nag = ink('heavy', 92), unit = ink('heavy', 30)
    const nagTop = this.y
    this.text(it.count, this.L, nagTop, nag)
    this.at(UNIT, this.L + this.measure(it.count, nag) + 8, nagTop - this.ascent(nag), unit)
    this.y += this.height(nag) - 6
  }

  private banner(text: string, size: number, barH: number) {
    this.y += 4
    this.c.fillStyle = '#000'; this.c.fillRect(0, this.y, this.W, barH)
    const p = ink('heavy', size, '#fff')
    const shown = this.fit(text, p, this.CW, 20)
    this.at(shown, this.W / 2, this.y + barH / 2 - (this.ascent(p) + this.descent(p)) / 2, p, 'center')
    this.y += barH + 12
  }

  private spot(b: Extract<Block, { k: 'spot' }>, labelSize: number, size: number) {
    this.y += 2
    const label = ink('heavy', labelSize), body = ink('heavy', size)
    let top = this.y
    this.text(this.fit(b.label, label, this.CW, 18), this.W / 2, top, label, 'center')
    top += this.height(label)
    for (const line of this.wrap(b.text, body, this.CW).slice(0, 3)) { this.text(this.fit(line, body, this.CW, 22), this.W / 2, top, body, 'center'); top += this.height(body) - 4 }
    this.y = top + 10
  }

  private total(t: Extract<Block, { k: 'total' }>) {
    this.y += 10; this.rule(3); this.y += 12
    const label = caps(23), value = ink('heavy', 66)
    const v = this.fit(t.value, value, this.CW - this.measure(t.label.toUpperCase(), label) - 16, 28)
    const rowH = this.height(value) - 10
    const base = this.y + rowH
    this.at(t.label.toUpperCase(), this.L, base - 8, label)
    this.at(v, this.R, base, value, 'right')
    this.y += rowH + 18
  }

  private money(m: Extract<Block, { k: 'money' }>, following: boolean) {
    if (!following) this.y += 4
    const label = ink('heavy', m.loud ? 30 : 26), value = ink('heavy', m.loud ? 42 : 31)
    const v = this.fit(m.value, value, this.CW - this.measure(m.label, label) - 24, 16)
    const rowH = this.height(value)
    const base = this.y + rowH - this.descent(value)
    if (m.loud) { this.rule(2); this.y += 8 }
    const b = m.loud ? base + 8 : base
    this.at(m.label, this.L, b, label)
    this.at(v, this.R, b, value, 'right')
    this.y += rowH + 8
  }

  private signs(s: Extract<Block, { k: 'signs' }>) {
    this.y += 64
    const slot = this.CW * 0.44
    const caption = caps(18), name = ink('heavy', 26)
    this.c.fillStyle = '#000'
    if (s.receiver !== null) {
      this.c.fillRect(this.L, this.y, slot, 2)
      const own = caps(18)
      this.text(this.fit(s.receiver.toUpperCase(), own, slot, 11), this.L, this.y + 8, own)
    }
    const shown = this.fit(this.display(s.staff), name, slot, 14)
    this.text(shown, this.R - slot / 2, this.y - this.height(name) - 2, name, 'center')
    this.c.fillStyle = '#000'; this.c.fillRect(this.R - slot, this.y, slot, 2)
    this.text('ACCOUNTANT', this.R - slot / 2, this.y + 8, caption, 'center')
    this.y += 8 + this.height(caption) + 10
  }

  private note(text: string) {
    this.y += 16; this.rule(2, this.W / 2 - 40, this.W / 2 + 40); this.y += 14
    const p = ink('sansBold', 21)
    for (const line of this.wrap(text, p, this.CW - 20)) { this.text(line, this.W / 2, this.y, p, 'center'); this.y += this.height(p) }
  }
}

/** The slip as the terminal's head burns it: a 384-dot-wide PNG, pure black and white. */
export async function drawSlip(s: Slip): Promise<HTMLCanvasElement> {
  await loadFonts()
  const qr = (data: string) => {
    const m = QRCode.create(data, { errorCorrectionLevel: 'M' }).modules
    return { size: m.size, get: (x: number, y: number) => !!m.get(y, x) }
  }
  // First on a tall page to learn the height, then again on one cut to it.
  const draft = document.createElement('canvas')
  draft.width = HEAD_DOTS; draft.height = Math.ceil(6000 * SCALE)
  const dc = draft.getContext('2d')!
  dc.scale(SCALE, SCALE)
  const height = new Pen(dc).draw(s, qr)
  const out = document.createElement('canvas')
  out.width = Math.round(LAYOUT * SCALE); out.height = Math.max(1, Math.trunc(height * SCALE))
  const c = out.getContext('2d')!
  c.fillStyle = '#fff'; c.fillRect(0, 0, out.width, out.height)
  c.save(); c.scale(SCALE, SCALE); new Pen(c).draw(s, qr); c.restore()
  // Thresholded a little dark, as SlipArt does: the head has no greys.
  const img = c.getImageData(0, 0, out.width, out.height)
  const px = img.data
  for (let i = 0; i < px.length; i += 4) {
    const v = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 < 160 ? 0 : 255
    px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255
  }
  c.putImageData(img, 0, 0)
  return out
}

/**
 * Prints the slip on this computer: a page as wide as the terminal's roll (48 mm printed on
 * 58 mm paper), so a thermal printer gives the same slip and a sheet printer the same picture.
 */
export function printSlip(png: string, title: string) {
  const w = window.open('', '_blank', 'width=460,height=900')
  if (!w) return false
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
  w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>@page{size:58mm auto;margin:0}html,body{margin:0;background:#fff}body{display:flex;justify-content:center}
img{width:48mm;height:auto;image-rendering:pixelated;margin:0 5mm}@media screen{body{padding:16px 0}img{width:384px;margin:0}}</style>
<img src="${png}" alt="${esc(title)}">`)
  w.document.close()
  const go = () => { w.focus(); w.print() }
  const img = w.document.images[0]
  if (img && !img.complete) img.onload = go; else setTimeout(go, 100)
  return true
}
