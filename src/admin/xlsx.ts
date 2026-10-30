import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { constants, deflateRawSync } from 'node:zlib';

/**
 * A real .xlsx written straight to a stream, sheet by sheet and page by page, so a shop's whole
 * books never sit in memory at once (the API has a small heap). An .xlsx is a zip of XML parts;
 * each part here is deflated in pieces (each piece its own raw-deflate run, sync-flushed, which a
 * deflate stream may be made of), its CRC and sizes written after it (a zip data descriptor).
 */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c; }
  return t;
})();
function crc32(buf: Buffer, prev = 0): number {
  let c = ~prev;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  // XML 1.0 has no place for most control characters.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

export type Cell = string | number | boolean | null | undefined;

class Zip {
  private offset = 0;
  private readonly entries: { name: Buffer; crc: number; csize: number; usize: number; at: number }[] = [];
  constructor(private readonly out: Writable) {}

  private async put(b: Buffer) {
    this.offset += b.length;
    if (!this.out.write(b)) await once(this.out, 'drain');
  }

  /** One file in the zip, its text handed over in pieces by [write]. */
  async file(name: string, fill: (write: (text: string) => Promise<void>) => Promise<void>) {
    const nameBuf = Buffer.from(name, 'utf8');
    const at = this.offset;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0808, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(0, 10); head.writeUInt16LE(0x21, 12); // 1980-01-01, no time
    head.writeUInt16LE(nameBuf.length, 26);
    await this.put(Buffer.concat([head, nameBuf]));
    let crc = 0, usize = 0, csize = 0;
    await fill(async (text) => {
      if (!text) return;
      const raw = Buffer.from(text, 'utf8');
      crc = crc32(raw, crc); usize += raw.length;
      const z = deflateRawSync(raw, { finishFlush: constants.Z_SYNC_FLUSH });
      csize += z.length;
      await this.put(z);
    });
    const end = deflateRawSync(Buffer.alloc(0));
    csize += end.length;
    await this.put(end);
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(usize, 12);
    await this.put(dd);
    this.entries.push({ name: nameBuf, crc, csize, usize, at });
  }

  async close() {
    const start = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0808, 8); h.writeUInt16LE(8, 10);
      h.writeUInt16LE(0, 12); h.writeUInt16LE(0x21, 14); h.writeUInt32LE(e.crc, 16); h.writeUInt32LE(e.csize, 20); h.writeUInt32LE(e.usize, 24);
      h.writeUInt16LE(e.name.length, 28); h.writeUInt32LE(e.at, 42);
      await this.put(Buffer.concat([h, e.name]));
    }
    const size = this.offset - start;
    const z = Buffer.alloc(22);
    z.writeUInt32LE(0x06054b50, 0); z.writeUInt16LE(this.entries.length, 8); z.writeUInt16LE(this.entries.length, 10);
    z.writeUInt32LE(size, 12); z.writeUInt32LE(start, 16);
    await this.put(z);
  }
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Sheet names: at most 31 characters, none of []:*?/\, and no two the same. */
const sheetName = (s: string, taken: Set<string>) => {
  const base = s.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';
  let name = base, i = 2;
  while (taken.has(name.toLowerCase())) name = `${base.slice(0, 28)} ${i++}`;
  taken.add(name.toLowerCase());
  return name;
};

const cell = (v: Cell, bold = false) => {
  if (v === null || v === undefined || v === '') return '<c/>';
  if (typeof v === 'number' && Number.isFinite(v)) return `<c${bold ? ' s="1"' : ''}><v>${v}</v></c>`;
  if (typeof v === 'boolean') return `<c t="b"><v>${v ? 1 : 0}</v></c>`;
  // Excel refuses to open a file with a cell over 32,767 characters.
  return `<c t="inlineStr"${bold ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(String(v).slice(0, 32_767))}</t></is></c>`;
};

/**
 * Writes a workbook of [sheets]: each has a header row (bold, frozen) and its rows, which come
 * from [rows] a page at a time until it returns an empty page.
 */
export async function writeXlsx(out: Writable, sheets: { name: string; header: string[]; rows: (page: number) => Promise<Cell[][]> }[]) {
  const zip = new Zip(out);
  const taken = new Set<string>();
  const names = sheets.map((s) => sheetName(s.name, taken));
  const one = (text: string) => async (w: (t: string) => Promise<void>) => { await w(text); };
  await zip.file('[Content_Types].xml', one(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${
    names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`));
  await zip.file('_rels/.rels', one(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`));
  await zip.file('xl/workbook.xml', one(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`));
  await zip.file('xl/_rels/workbook.xml.rels', one(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
  }<Relationship Id="rId${names.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`));
  await zip.file('xl/styles.xml', one(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`));
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i];
    await zip.file(`xl/worksheets/sheet${i + 1}.xml`, async (w) => {
      await w(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData><row>${s.header.map((h) => cell(h, true)).join('')}</row>`);
      for (let page = 0; ; page++) {
        const rows = await s.rows(page);
        if (!rows.length) break;
        await w(rows.map((r) => `<row>${r.map((v) => cell(v)).join('')}</row>`).join(''));
      }
      await w('</sheetData></worksheet>');
    });
  }
  await zip.close();
}
