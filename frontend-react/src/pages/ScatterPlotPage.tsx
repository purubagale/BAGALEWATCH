import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiErrorMessage } from '../api/client'
import { useScatterData, useThresholds } from '../api/queries'
import type { ScatterKpiKey, ScatterSite } from '../api/types'
import { kpiStatus, kpiStatusColor as statusColor } from '../lib/kpiThresholdStatus'

// Ports v1's Scatter Plot exactly (bts_monitor.html ~12785-12921,
// openScatterModal/renderScatterPlot/SCATTER_KPIS/REGION_COLORS) — v1
// does no server-side aggregation for this report at all, it draws
// straight to a <canvas> from the in-memory site list, so the chart math
// (axis scaling, linear regression, Pearson correlation, hover, legend)
// is ported here rather than into core/reports.py. The server
// (GET /api/v2/scatter/) only hands over the raw per-site KPI values.
// Status-coloring's snake_case->camelCase threshold-key lookup lives in
// lib/kpiThresholdStatus.ts, shared with KpiTrendPage.

type ColorBy = 'status' | 'region' | 'none'

type Pt = { x: number; y: number; site: ScatterSite; color: string }

export default function ScatterPlotPage() {
  const { data, isLoading, error } = useScatterData()
  const { data: thresholds } = useThresholds()
  const navigate = useNavigate()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const [xKey, setXKey] = useState<ScatterKpiKey>('rssi')
  const [yKey, setYKey] = useState<ScatterKpiKey>('ip_thru')
  const [colorBy, setColorBy] = useState<ColorBy>('status')
  const [tooltip, setTooltip] = useState<{ left: number; top: number; site: ScatterSite; x: number; y: number } | null>(null)
  const [correlation, setCorrelation] = useState<{ r: number; label: string; color: string } | null>(null)

  const xDef = data?.kpis.find((k) => k.key === xKey)
  const yDef = data?.kpis.find((k) => k.key === yKey)

  // Points with both axes present — matches v1's
  // `.filter(p=>p.x!==undefined&&p.y!==undefined)`.
  const pts: Pt[] = useMemo(() => {
    if (!data) return []
    return data.sites
      .map((s) => ({ x: s[xKey], y: s[yKey], site: s }))
      .filter((p): p is { x: number; y: number; site: ScatterSite } => p.x !== null && p.y !== null)
      .map((p) => ({
        x: p.x,
        y: p.y,
        site: p.site,
        color:
          colorBy === 'status'
            ? statusColor(kpiStatus(p.x, xKey, thresholds))
            : colorBy === 'region'
              ? data.region_colors[p.site.region] || '#888888'
              : '#7f77dd',
      }))
  }, [data, xKey, yKey, colorBy, thresholds])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || !xDef || !yDef) return
    const dpr = window.devicePixelRatio || 1
    const W = wrap.offsetWidth - 24 || 680
    const H = 360
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`
    canvas.width = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)

    if (!pts.length) {
      setCorrelation(null)
      return
    }

    const P = { t: 16, r: 16, b: 40, l: 56 }
    const pw = W - P.l - P.r
    const ph = H - P.t - P.b
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const mnX = Math.min(...xs), mxX = Math.max(...xs), rngX = mxX - mnX || 1
    const mnY = Math.min(...ys), mxY = Math.max(...ys), rngY = mxY - mnY || 1
    const pX = rngX * 0.08, pY = rngY * 0.08
    const toX = (v: number) => P.l + ((v - (mnX - pX)) / ((mxX + pX) - (mnX - pX))) * pw
    const toY = (v: number) => P.t + ph - ((v - (mnY - pY)) / ((mxY + pY) - (mnY - pY))) * ph

    // Grid + axis labels.
    ctx.strokeStyle = '#1e2a40'
    ctx.lineWidth = 0.5
    for (let i = 0; i <= 4; i++) {
      const y = P.t + (ph / 4) * i
      ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(P.l + pw, y); ctx.stroke()
      ctx.fillStyle = '#3d4d6a'; ctx.font = '9px monospace'; ctx.textAlign = 'right'
      ctx.fillText((mxY - (rngY / 4) * i).toFixed(1), P.l - 6, y + 3)
      const x = P.l + (pw / 4) * i
      ctx.beginPath(); ctx.moveTo(x, P.t); ctx.lineTo(x, P.t + ph); ctx.stroke()
      ctx.textAlign = 'center'
      ctx.fillText((mnX + (rngX / 4) * i).toFixed(1), x, H - 6)
    }

    // Linear regression + Pearson correlation.
    const n = pts.length
    const sX = xs.reduce((a, b) => a + b, 0), sY = ys.reduce((a, b) => a + b, 0)
    const sXY = pts.reduce((a, p) => a + p.x * p.y, 0), sX2 = xs.reduce((a, x) => a + x * x, 0)
    const slope = (n * sXY - sX * sY) / (n * sX2 - sX * sX) || 0
    const icept = (sY - slope * sX) / n
    const mX = sX / n, mY = sY / n
    const num = pts.reduce((a, p) => a + (p.x - mX) * (p.y - mY), 0)
    const den = Math.sqrt(pts.reduce((a, p) => a + (p.x - mX) ** 2, 0) * pts.reduce((a, p) => a + (p.y - mY) ** 2, 0))
    const r = den > 0 ? num / den : 0
    if (Math.abs(slope) > 0.001) {
      ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(127,119,221,0.5)'; ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(toX(mnX - pX), toY(slope * (mnX - pX) + icept))
      ctx.lineTo(toX(mxX + pX), toY(slope * (mxX + pX) + icept))
      ctx.stroke(); ctx.setLineDash([])
    }
    const strength = Math.abs(r) > 0.7 ? 'Strong' : Math.abs(r) > 0.4 ? 'Moderate' : 'Weak'
    const dir = r > 0 ? 'positive' : 'negative'
    setCorrelation({
      r,
      label: `r = ${r.toFixed(3)} (${strength} ${dir} correlation)`,
      color: Math.abs(r) > 0.7 ? '#22c55e' : Math.abs(r) > 0.4 ? '#eab308' : '#6b7a99',
    })

    // Axis titles.
    ctx.fillStyle = '#6b7a99'; ctx.font = '10px monospace'; ctx.textAlign = 'center'
    ctx.fillText(xDef.label, P.l + pw / 2, H - 1)
    ctx.save(); ctx.translate(14, P.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(yDef.label, 0, 0); ctx.restore()

    // Points.
    const ptCoords: { px: number; py: number; p: Pt }[] = []
    pts.forEach((p) => {
      const px = toX(p.x), py = toY(p.y)
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2)
      ctx.fillStyle = `${p.color}cc`; ctx.fill()
      ctx.strokeStyle = p.color; ctx.lineWidth = 1.5; ctx.stroke()
      ptCoords.push({ px, py, p })
    })

    // Site labels for critical sites (matches v1's status==='crit' filter).
    pts.filter((p) => p.site.status === 'crit').forEach((p) => {
      ctx.fillStyle = '#6b7a99'; ctx.font = '8px monospace'; ctx.textAlign = 'center'
      ctx.fillText(p.site.name.split('-').slice(0, 2).join('-'), toX(p.x), toY(p.y) - 10)
    })

    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      let nearest: { px: number; py: number; p: Pt } | null = null
      let minD = 20
      ptCoords.forEach(({ px, py, p }) => {
        const d = Math.sqrt((mx - px) ** 2 + (my - py) ** 2)
        if (d < minD) { minD = d; nearest = { px, py, p } }
      })
      if (nearest) {
        const nn = nearest as { px: number; py: number; p: Pt }
        setTooltip({ left: nn.px + 16, top: nn.py - 20, site: nn.p.site, x: nn.p.x, y: nn.p.y })
      } else {
        setTooltip(null)
      }
    }
    canvas.onmouseleave = () => setTooltip(null)
    canvas.onclick = (e) => {
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      let nearest: Pt | null = null
      let minD = 16
      ptCoords.forEach(({ px, py, p }) => {
        const d = Math.sqrt((mx - px) ** 2 + (my - py) ** 2)
        if (d < minD) { minD = d; nearest = p }
      })
      if (nearest) navigate(`/sites/${(nearest as Pt).site.id}`)
    }
  }, [pts, xDef, yDef, navigate])

  if (isLoading) return <div className="page-status">Loading scatter data…</div>
  if (error) return <div className="page-status page-status-error">{apiErrorMessage(error, 'Could not load scatter data.')}</div>
  if (!data) return null

  return (
    <div className="admin-page">
      <h1>Scatter Plot</h1>
      <p className="muted">Correlate any two KPIs across all sites. Click a point to open that site.</p>

      <div className="report-toolbar">
        <label>
          X:{' '}
          <select value={xKey} onChange={(e) => setXKey(e.target.value as ScatterKpiKey)}>
            {data.kpis.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
        <label>
          Y:{' '}
          <select value={yKey} onChange={(e) => setYKey(e.target.value as ScatterKpiKey)}>
            {data.kpis.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
        <label>
          Color by:{' '}
          <select value={colorBy} onChange={(e) => setColorBy(e.target.value as ColorBy)}>
            <option value="status">Status</option>
            <option value="region">Region</option>
            <option value="none">None</option>
          </select>
        </label>
      </div>

      {correlation && <p className="muted" style={{ color: correlation.color }}>{correlation.label}</p>}

      <div ref={wrapRef} style={{ position: 'relative' }}>
        <canvas ref={canvasRef} />
        {tooltip && (
          <div
            className="scatter-tooltip"
            style={{ position: 'absolute', left: tooltip.left, top: tooltip.top, pointerEvents: 'none' }}
          >
            <strong>{tooltip.site.name}</strong><br />
            {xDef?.label}: <strong>{tooltip.x.toFixed(2)}</strong><br />
            {yDef?.label}: <strong>{tooltip.y.toFixed(2)}</strong><br />
            <span className="muted">{tooltip.site.region} · {tooltip.site.status.toUpperCase()}</span>
          </div>
        )}
      </div>

      <p className="muted">{pts.length} sites plotted · Hover for details · Click to open a site</p>

      {colorBy === 'status' && (
        <div className="report-toolbar">
          {(['ok', 'warn', 'crit'] as const).map((st) => (
            <div key={st} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: statusColor(st), display: 'inline-block' }} />
              {st.toUpperCase()}
            </div>
          ))}
        </div>
      )}
      {colorBy === 'region' && (
        <div className="report-toolbar">
          {Object.entries(data.region_colors).map(([r, c]) => (
            <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: c, display: 'inline-block' }} />
              {r}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
