import { useState } from 'react'
import { rupees, shortDate } from './format'

type Point = { date: string; salesPaise: number; purchasePaise: number }

const SALES = '#16a34a'
const BUYS = '#2563eb'

/**
 * Bikri and Kharid by day: grouped bars from one baseline, rounded tops, a legend because there
 * are two series, and the day's figures on hover or tap. Y axis in lakh/thousand.
 */
export function TrendChart({ data }: { data: Point[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 640, H = 220, L = 44, B = 24, T = 10
  const max = niceMax(Math.max(1, ...data.flatMap((d) => [d.salesPaise, d.purchasePaise])))
  const plotW = W - L, plotH = H - B - T
  const step = plotW / data.length
  const bar = Math.max(3, Math.min(18, (step - 8) / 2))
  const y = (v: number) => T + plotH - (v / max) * plotH
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max]
  const labelEvery = Math.ceil(data.length / 8)
  const h = hover !== null ? data[hover] : null

  return (
    <div className="chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Bikri aur kharid, roz ki">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'gl'} />
            <text x={L - 8} y={y(t) + 4} className="tick" textAnchor="end">{axis(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = L + i * step + step / 2
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
              <rect x={L + i * step} y={T} width={step} height={plotH} fill={hover === i ? 'rgb(0 0 0 / 0.03)' : 'transparent'} />
              <Bar x={cx - bar - 1} w={bar} top={y(d.salesPaise)} base={y(0)} fill={SALES} />
              <Bar x={cx + 1} w={bar} top={y(d.purchasePaise)} base={y(0)} fill={BUYS} />
              {i % labelEvery === 0 && <text x={cx} y={H - 6} className="tick" textAnchor="middle">{shortDate(d.date)}</text>}
            </g>
          )
        })}
      </svg>
      {h && hover !== null && (
        <div className="tip" style={{ left: `${((L + hover * step + step / 2) / W) * 100}%`, top: `${(Math.min(y(h.salesPaise), y(h.purchasePaise)) / H) * 100}%` }}>
          <b>{shortDate(h.date)}</b>Bikri {rupees(h.salesPaise)} · Kharid {rupees(h.purchasePaise)}
        </div>
      )}
      <div className="legend" style={{ marginTop: 6 }}>
        <span><span className="dot" style={{ background: SALES }} />Bikri</span>
        <span><span className="dot" style={{ background: BUYS }} />Kharid</span>
      </div>
    </div>
  )
}

function Bar({ x, w, top, base, fill }: { x: number; w: number; top: number; base: number; fill: string }) {
  const h = base - top
  if (h <= 0.5) return null
  const r = Math.min(3, w / 2, h)
  return <path fill={fill} d={`M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`} />
}

/** ₹2L, ₹50K: axis labels only — every figure elsewhere is exact. */
function axis(paise: number): string {
  const r = paise / 100
  if (r >= 1e7) return `₹${+(r / 1e7).toFixed(1)}Cr`
  if (r >= 1e5) return `₹${+(r / 1e5).toFixed(1)}L`
  if (r >= 1e3) return `₹${+(r / 1e3).toFixed(0)}K`
  return `₹${Math.round(r)}`
}

function niceMax(v: number): number {
  const mag = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= v) return m * mag
  return 10 * mag
}
