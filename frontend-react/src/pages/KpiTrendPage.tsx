import { useEffect, useRef, useState } from 'react'
import { apiErrorMessage } from '../api/client'
import { useKpiTrend, useSites, useThresholds } from '../api/queries'
import type { TrendCategory, TrendKpi } from '../api/types'
import { KPI_THRESHOLD_KEY, kpiStatus, kpiStatusColor } from '../lib/kpiThresholdStatus'

// Ports v1's KPI Trend (bts_monitor.html ~12184-12391,
// openTrendModal/renderTrendCharts/drawTrendCanvas) with one deliberate,
// user-confirmed (2026-07-28) departure: v1 falls back to
// buildSimulatedHistory() — a Math.random()-driven fake trend line —
// whenever a site has fewer than 3 real IndexedDB snapshots, which in
// practice is almost always (v1's own saveDailySnapshot() is never
// actually called — see KpiSnapshot's docstring in core/models.py).
// This page never fabricates: GET /api/v2/kpi-trend/ reports
// has_enough_data:false below that same 3-snapshot threshold, and this
// page renders a "not enough data yet" message instead of a chart.

const CATEGORY_TABS: { key: TrendCategory; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'accessibility', label: 'Accessibility' },
  { key: 'retainability', label: 'Retainability' },
  { key: 'mobility', label: 'Mobility' },
  { key: 'integrity', label: 'Integrity' },
  { key: 'utilization', label: 'Utilization' },
]

const PERIODS = [7, 30, 90]

function TrendChart({ kpi, series }: { kpi: TrendKpi; series: { date: string; value: number | null }[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { data: thresholds } = useThresholds()
  const t = thresholds?.[KPI_THRESHOLD_KEY[kpi.key] ?? kpi.key]

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const vals = series.map((s) => s.value).filter((v): v is number => v !== null)
    const dates = series.filter((s) => s.value !== null).map((s) => s.date)
    if (!vals.length) return
    const dpr = window.devicePixelRatio || 1
    const W = canvas.offsetWidth || 320
    const H = canvas.offsetHeight || 140
    canvas.width = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    const P = { t: 10, r: 14, b: 22, l: 42 }
    const pw = W - P.l - P.r
    const ph = H - P.t - P.b
    ctx.clearRect(0, 0, W, H)
    const mn = Math.min(...vals), mx = Math.max(...vals), rng = mx - mn || 1
    const pmn = mn - rng * 0.1, pmx = mx + rng * 0.1, prng = pmx - pmn || 1
    const toX = (i: number) => P.l + (i / (vals.length - 1 || 1)) * pw
    const toY = (v: number) => P.t + ph - ((v - pmn) / prng) * ph

    ctx.strokeStyle = '#1e2a40'; ctx.lineWidth = 0.5
    for (let i = 0; i <= 4; i++) {
      const y = P.t + (ph / 4) * i
      ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(P.l + pw, y); ctx.stroke()
      ctx.fillStyle = '#3d4d6a'; ctx.font = '9px monospace'; ctx.textAlign = 'right'
      ctx.fillText((pmx - (prng / 4) * i).toFixed(1), P.l - 3, y + 3)
    }

    // Threshold lines (warn/crit), if configured for this KPI.
    const th = thresholds?.[KPI_THRESHOLD_KEY[kpi.key] ?? kpi.key]
    if (th && th.warn !== null && th.crit !== null) {
      ;[[th.warn, '#eab308'], [th.crit, '#ef4444']].forEach(([v, c]) => {
        const val = v as number
        if (val < pmn || val > pmx) return
        const y = toY(val)
        ctx.setLineDash([4, 3]); ctx.strokeStyle = c as string; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(P.l + pw, y); ctx.stroke()
        ctx.setLineDash([])
      })
    }

    ctx.beginPath()
    vals.forEach((v, i) => { const x = toX(i), y = toY(v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y) })
    ctx.lineTo(toX(vals.length - 1), P.t + ph); ctx.lineTo(P.l, P.t + ph); ctx.closePath()
    ctx.fillStyle = 'rgba(127,119,221,0.1)'; ctx.fill()

    ctx.beginPath()
    vals.forEach((v, i) => { const x = toX(i), y = toY(v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y) })
    ctx.strokeStyle = '#7f77dd'; ctx.lineWidth = 2; ctx.stroke()

    if (vals.length <= 60) {
      vals.forEach((v, i) => {
        const st = kpiStatus(v, kpi.key, thresholds)
        ctx.beginPath(); ctx.arc(toX(i), toY(v), 3, 0, Math.PI * 2)
        ctx.fillStyle = kpiStatusColor(st); ctx.fill()
      })
    }

    ctx.fillStyle = '#3d4d6a'; ctx.font = '9px monospace'; ctx.textAlign = 'center'
    const step = Math.ceil(dates.length / 6)
    dates.forEach((d, i) => { if (i % step === 0 || i === dates.length - 1) ctx.fillText(d.slice(5), toX(i), H - 6) })
  }, [series, kpi, thresholds])

  const lastVal = [...series].reverse().find((s) => s.value !== null)?.value ?? null
  const st = kpiStatus(lastVal, kpi.key, thresholds)

  return (
    <div className="trend-chart-wrap">
      <div className="trend-chart-title">
        <span>{kpi.label}</span>
        <span style={{ color: kpiStatusColor(st) }}>{lastVal !== null ? `${lastVal.toFixed(1)}${t?.unit ?? ''}` : ''}</span>
      </div>
      <canvas ref={canvasRef} className="trend-canvas" />
    </div>
  )
}

export default function KpiTrendPage() {
  const { data: sites } = useSites()
  const [siteId, setSiteId] = useState<string>('')
  const [days, setDays] = useState(30)
  const [tab, setTab] = useState<TrendCategory>('overview')

  useEffect(() => {
    if (!siteId && sites && sites.length) setSiteId(sites[0].id)
  }, [sites, siteId])

  const { data, isLoading, error } = useKpiTrend(siteId, days)

  if (isLoading && !data) return <div className="page-status">Loading KPI trend…</div>
  if (error) return <div className="page-status page-status-error">{apiErrorMessage(error, 'Could not load KPI trend.')}</div>

  const kpis = data?.categories[tab] ?? []

  return (
    <div className="admin-page">
      <h1>KPI Trend</h1>
      <p className="muted">
        Historical KPI charts built from real daily snapshots (see the <code>take_kpi_snapshot</code> scheduled job) —
        never simulated data.
      </p>

      <div className="report-toolbar">
        <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
          {(sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
        </select>
        {PERIODS.map((p) => (
          <button
            key={p}
            className={p === days ? 'tbtn active' : 'tbtn'}
            onClick={() => setDays(p)}
            type="button"
          >
            {p}d
          </button>
        ))}
      </div>

      <div className="feat-tabs" style={{ marginBottom: 14 }}>
        {CATEGORY_TABS.map((c) => (
          <div
            key={c.key}
            className={c.key === tab ? 'feat-tab active' : 'feat-tab'}
            onClick={() => setTab(c.key)}
          >
            {c.label}
          </div>
        ))}
      </div>

      {data && !data.has_enough_data && (
        <div className="page-status">
          Not enough historical data yet for {data.site.name} ({data.snapshot_count}/{data.min_required} daily
          snapshots collected). Run the <code>take_kpi_snapshot</code> job for a few more days to build up trend
          history — this page will never show a simulated/fabricated trend in the meantime.
        </div>
      )}

      {data && data.has_enough_data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {kpis.map((kpi) => (
            <TrendChart
              key={kpi.key}
              kpi={kpi}
              series={data.series.map((row) => ({ date: row.date, value: row[kpi.key] as number | null }))}
            />
          ))}
        </div>
      )}
    </div>
  )
}
