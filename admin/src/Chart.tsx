import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { rupees, shortDate } from './format'

type Series = { key: string; label: string; color: string }

/**
 * One or two figures a day as bars, the day's figures on hover or tap; three date labels, no
 * grid or axis, a legend only when there are two series. For the grapes desk's APMC and mazdoori.
 */
export function DayBars<R extends { date: string }>({ data, series }: { data: R[]; series: Series[] }) {
  const xs = data.map((d) => d.date)
  const ticks = [...new Set([xs[0], xs[Math.floor((xs.length - 1) / 2)], xs[xs.length - 1]])].filter(Boolean)
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }} barCategoryGap="25%">
          <XAxis dataKey="date" ticks={ticks} interval={0} tickFormatter={shortDate} tickLine={false} axisLine={false} padding={{ left: 12, right: 12 }} tick={{ fontSize: 11.5, fill: '#a3aab5' }} />
          <YAxis hide />
          <Tooltip cursor={{ fill: '#f3f4f6' }} content={({ active, payload, label }) => active && payload?.length ? (
            <div className="pro-tip">
              <b>{shortDate(String(label))}</b>
              {series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{series.length > 1 ? `${s.label} ` : ''}{rupees(Number(payload.find((p) => p.dataKey === s.key)?.value ?? 0))}</span>)}
            </div>
          ) : null} />
          {series.map((s) => <Bar key={s.key} dataKey={s.key} fill={s.color} radius={[4, 4, 0, 0]} animationDuration={600} />)}
        </BarChart>
      </ResponsiveContainer>
      {series.length > 1 && (
        <div className="legend" style={{ marginTop: 6 }}>
          {series.map((s) => <span key={s.key}><span className="dot" style={{ background: s.color }} />{s.label}</span>)}
        </div>
      )}
    </div>
  )
}
