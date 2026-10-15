import type { ExportDoc } from './doc'

/** Excel opens a UTF-8 CSV with a BOM as a sheet, Hindi and all. */
export function csv(doc: ExportDoc): Blob {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const line = (cells: string[]) => cells.map(q).join(',')
  const out = [
    line([doc.title, doc.name ?? '', doc.period ?? '']),
    ...(doc.summary ?? []).map(([k, v]) => line([k, v])),
    '',
    line(doc.columns.map((c) => c.label)),
    ...doc.rows.map((r) => line(r.band ? [r.cells[0]] : r.cells)),
    ...(doc.foot ? [line(doc.foot)] : []),
  ]
  return new Blob(['﻿' + out.join('\r\n')], { type: 'text/csv;charset=utf-8' })
}

/**
 * The preview's own pages, photographed into an A4 PDF — so Hindi prints as it shows, and the
 * PDF is exactly what was previewed. The libraries load only when someone exports.
 */
export async function pdf(pages: HTMLElement[]): Promise<Blob> {
  const [{ jsPDF }, { default: html2canvas }] = await Promise.all([import('jspdf'), import('html2canvas-pro')])
  const out = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true })
  for (let i = 0; i < pages.length; i++) {
    const canvas = await html2canvas(pages[i], {
      scale: 2, backgroundColor: '#ffffff', logging: false,
      // The preview may be shrunk to fit a phone; the photograph is always full size.
      onclone: (d) => { d.querySelectorAll<HTMLElement>('.paper-stack').forEach((el) => { el.style.zoom = '1' }) },
    })
    if (i > 0) out.addPage()
    out.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, 210, 297)
  }
  return out.output('blob')
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Share sheet on a phone (WhatsApp etc.), a download where there is none. */
export async function share(blob: Blob, name: string, title: string): Promise<'shared' | 'saved'> {
  const file = new File([blob], name, { type: blob.type })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title })
      return 'shared'
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'shared'
    }
  }
  download(blob, name)
  return 'saved'
}
