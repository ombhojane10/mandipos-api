import { useState } from 'react'
import { rupees, shortDate } from './format'

/**
 * Daily sales as bars: one series, one hue, so no legend. Bars are anchored to the baseline with
 * rounded tops and a 2px gap; hovering (or tapping) a day shows its figures.
 */
export function SalesChart({ series }: { series: { date: string; salesPaise: number; slips: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 720, H = 200, TOP = 16, BOTTOM = 24
  const max = Math.max(1, ...series.map((d) => d.salesPaise))
  const step = W / series.length
  const bar = Math.max(2, step - 2)
  const plot = H - TOP - BOTTOM
  const shown = hover ?? series.reduce((best, d, i) => (d.salesPaise > series[best].salesPaise ? i : best), 0)
  const d = series[shown]
  const labelEvery = Math.ceil(series.length / 7)

  return (
    <div className="chart">
      <p className="chart-read">
        <b>{rupees(d.salesPaise)}</b> <span className="muted">{shortDate(d.date)} · {d.slips} parchi{hover === null ? ' · sabse zyada' : ''}</span>
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily sales" onMouseLeave={() => setHover(null)}>
        <line x1="0" x2={W} y1={H - BOTTOM} y2={H - BOTTOM} className="axis" />
        {series.map((p, i) => {
          const h = (p.salesPaise / max) * plot
          const x = i * step + (step - bar) / 2
          const r = Math.min(4, bar / 2, h)
          const y = H - BOTTOM - h
          return (
            <g key={p.date} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
              <rect x={i * step} y={TOP} width={step} height={plot} fill="transparent" />
              {h > 0 && (
                <path
                  className={i === shown ? 'bar on' : 'bar'}
                  d={`M${x},${H - BOTTOM} V${y + r} Q${x},${y} ${x + r},${y} H${x + bar - r} Q${x + bar},${y} ${x + bar},${y + r} V${H - BOTTOM} Z`}
                />
              )}
              {i % labelEvery === 0 && <text x={i * step + step / 2} y={H - 6} className="tick">{shortDate(p.date)}</text>}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
