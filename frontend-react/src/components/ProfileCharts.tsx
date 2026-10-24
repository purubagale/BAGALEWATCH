import { useRef, useState, type ReactNode } from 'react'

// Small SVG charts for the Subscriber Profile (2026-10-16). Plain SVG like
// the rest of the profile, no chart library. Each has a hover card; text
// stays in the text colours, colour marks identity only; a legend is
// shown wherever there are two or more series.

export interface Segment { key: string; value: number; color: string; label: string }
export interface Column { key: string; label: string; segments: Segment[]; tip: string[] }

function Tip({ x, lines }: { x: number; lines: string[] }) {
  // Kept inside the chart: flips to the left of the cursor past the middle.
  const right = x > 55
  return (
    <div className="spc-tip" style={right ? { right: `${100 - x}%` } : { left: `${x}%` }}>
      {lines.map((l, i) => <div key={i} className={i === 0 ? 'spc-tip-head' : ''}>{l}</div>)}
    </div>
  )
}

/** Stacked columns on one axis, e.g. readings per day by network. */
export function ColumnChart({ columns, height = 150, every = 1, unit = '', ariaLabel }: {
  columns: Column[]; height?: number; every?: number; unit?: string; ariaLabel: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const ref = useRef<SVGSVGElement>(null)
  const W = 640, H = height, L = 36, R = 6, T = 8, B = 20
  const max = Math.max(1, ...columns.map((c) => c.segments.reduce((a, s) => a + s.value, 0)))
  const nice = niceMax(max)
  const n = columns.length
  const slot = (W - L - R) / Math.max(1, n)
  const bw = Math.max(1.5, Math.min(26, slot - 2))
  const y = (v: number) => T + (H - T - B) * (1 - v / nice)
  return (
    <div className="spc-wrap">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="sp-chart" role="img" aria-label={ariaLabel}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = ref.current?.getBoundingClientRect()
          if (!box) return
          const sx = ((e.clientX - box.left) / box.width) * W
          const i = Math.floor((sx - L) / slot)
          setHover(i >= 0 && i < n ? i : null)
        }}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={y(nice * f)} y2={y(nice * f)} className="sp-grid-line" />
            <text x={L - 6} y={y(nice * f) + 3} className="sp-axis" textAnchor="end">{short(nice * f)}{f === 1 ? unit : ''}</text>
          </g>
        ))}
        {columns.map((c, i) => {
          let acc = 0
          const x0 = L + i * slot + (slot - bw) / 2
          return (
            <g key={c.key} opacity={hover == null || hover === i ? 1 : 0.55}>
              {c.segments.filter((s) => s.value > 0).map((s) => {
                const top = y(acc + s.value), bottom = y(acc)
                acc += s.value
                // 2 px gap between stacked segments.
                const h = Math.max(0.5, bottom - top - (acc === s.value ? 0 : 2))
                return <rect key={s.key} x={x0} y={top} width={bw} height={h} rx={Math.min(3, bw / 3)} style={{ fill: s.color }} />
              })}
            </g>
          )
        })}
        {columns.map((c, i) => (i % every === 0 || i === n - 1) && (
          <text key={c.key} x={L + i * slot + slot / 2} y={H - 5} className="sp-axis" textAnchor="middle">{c.label}</text>
        ))}
      </svg>
      {hover != null && <Tip x={((L + hover * slot + slot / 2) / W) * 100} lines={columns[hover].tip} />}
    </div>
  )
}

/** Horizontal bars with the value written at the end, e.g. readings per site. */
export function HBars({ rows, unit = '' }: {
  rows: { key: string; label: ReactNode; value: number; color: string; note?: string; tip?: string }[]; unit?: string
}) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className="spc-hbars">
      {rows.map((r) => (
        <div key={r.key} className="spc-hbar" title={r.tip}>
          <div className="spc-hbar-label">{r.label}</div>
          <div className="spc-hbar-track">
            <i style={{ width: `${(100 * r.value) / max}%`, background: r.color }} />
          </div>
          <div className="spc-hbar-val sp-mono">{r.value.toLocaleString()}{unit}{r.note ? <span className="sp-muted"> {r.note}</span> : null}</div>
        </div>
      ))}
    </div>
  )
}

/** One 100% bar split into parts, each labelled underneath. */
export function ShareBar({ parts }: { parts: { key: string; label: string; value: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0)
  if (!total) return null
  return (
    <div>
      <div className="spc-share">
        {parts.filter((p) => p.value > 0).map((p) => (
          <i key={p.key} style={{ width: `${(100 * p.value) / total}%`, background: p.color }}
            title={`${p.label}: ${p.value.toLocaleString()} (${Math.round((100 * p.value) / total)}%)`} />
        ))}
      </div>
      <div className="sp-legend">
        {parts.filter((p) => p.value > 0).map((p) => (
          <span key={p.key}><i style={{ background: p.color }} />{p.label} {Math.round((100 * p.value) / total)}%</span>
        ))}
      </div>
    </div>
  )
}

function niceMax(v: number) {
  const p = 10 ** Math.floor(Math.log10(v))
  const m = v / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p
}

function short(v: number) {
  if (v >= 1_000_000) return `${+(v / 1_000_000).toFixed(1)}M`
  if (v >= 1000) return `${+(v / 1000).toFixed(1)}k`
  return `${+v.toFixed(v < 10 ? 1 : 0)}`
}
