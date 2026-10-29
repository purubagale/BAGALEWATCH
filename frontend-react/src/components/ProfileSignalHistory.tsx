import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import BaseMap from './BaseMap'
import { CircleMarker, MapContainer, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { apiErrorMessage } from '../api/client'
import { useSubscriberSignal } from '../api/queries'
import type { SubscriberAnalytics, SubscriberSignalPoint } from '../api/types'
import { CQI_BANDS, RSRP_BANDS, RSRQ_BANDS, RXLEV_BANDS, SINR_BANDS, bandColor, type Band } from '../lib/dtBands'
import { netHex } from '../lib/netColors'
import { telemetryLevel } from '../lib/telemetryLevel'
import FitToPoints from './FitToPoints'
import { ENV_LABEL, environmentText, filterByEnvironment, type EnvFilter } from './EnvironmentTools'

// Signal history on the Subscriber Profile (2026-10-16). Newest 300
// readings by default, or every stored one, or one session, for all
// technologies or one. Dots are coloured by the measure picked (level by
// technology, RSRQ, SINR, CQI or network); hovering shows the whole reading,
// a click picks one reading and a drag picks a stretch, and the map beside
// it shows the picked readings. Positions only while an emergency is
// declared (the server leaves them out otherwise); then the map shows the
// serving sites instead, which are masts, not the customer.

type MetricKey = 'level' | 'rsrq' | 'sinr' | 'cqi' | 'network'

// Plain hex, because the same colour also goes on the map markers.
const netColor = netHex

const METRICS: Record<MetricKey, {
  label: string; unit: string; lo: number; hi: number; grid: number[]
  value: (p: SubscriberSignalPoint) => number | null
  color: (p: SubscriberSignalPoint) => string
  bands?: Band[]
}> = {
  level: {
    label: 'Level', unit: 'dBm', lo: -130, hi: -40, grid: [-110, -90, -70, -50],
    value: (p) => p.level_dbm,
    color: (p) => telemetryLevel({ network_type: p.network_type, rsrp: p.level_dbm, rscp: p.level_dbm, rssi: p.level_dbm }).color,
    bands: RSRP_BANDS,
  },
  rsrq: { label: 'RSRQ', unit: 'dB', lo: -25, hi: 0, grid: [-20, -15, -10, -5], value: (p) => p.rsrq_db, color: (p) => bandColor(RSRQ_BANDS, p.rsrq_db), bands: RSRQ_BANDS },
  sinr: { label: 'SINR', unit: 'dB', lo: -10, hi: 30, grid: [-5, 0, 10, 20], value: (p) => p.sinr_db, color: (p) => bandColor(SINR_BANDS, p.sinr_db), bands: SINR_BANDS },
  cqi: { label: 'CQI', unit: '', lo: 0, hi: 15, grid: [0, 5, 10, 15], value: (p) => p.cqi, color: (p) => bandColor(CQI_BANDS, p.cqi), bands: CQI_BANDS },
  network: { label: 'Network', unit: 'dBm', lo: -130, hi: -40, grid: [-110, -90, -70, -50], value: (p) => p.level_dbm, color: (p) => netColor(p.network_type) },
}

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—')
// 160 high since 2026-10-26 (was 200): the user asked for a shorter card.
const W = 760, H = 160, L = 38, R = 8, T = 8, B = 28

// Time axis (2026-10-19): readings sit at their time, not evenly spaced, and
// the ticks follow the span shown (minutes for one drive, days for a month).
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
const TICK_STEPS = [5 * MIN, 15 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY]

function timeTicks(t0: number, t1: number): { t: number; label: string }[] {
  const span = Math.max(t1 - t0, MIN)
  const step = TICK_STEPS.find((s) => span / s <= 7) ?? 30 * DAY
  // Align to local midnight for day steps, to the step otherwise.
  const offset = new Date().getTimezoneOffset() * MIN
  const start = Math.ceil((t0 - offset) / step) * step + offset
  const out: { t: number; label: string }[] = []
  for (let t = start; t <= t1; t += step) {
    const d = new Date(t)
    const sameDay = span < DAY && new Date(t0).toDateString() === new Date(t1).toDateString()
    out.push({
      t,
      label: step < DAY
        ? (sameDay || d.getHours() + d.getMinutes() > 0
          ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
          : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
        : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    })
  }
  return out
}

/** Index of the time nearest to t in a sorted list. */
function nearest(times: number[], t: number): number {
  let lo = 0, hi = times.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (times[mid] < t) lo = mid
    else hi = mid
  }
  return Math.abs(times[lo] - t) <= Math.abs(times[hi] - t) ? lo : hi
}

const RANGES: { value: string; label: string }[] = [
  { value: 'newest', label: 'Newest 300' },
  { value: 'day', label: 'Last day of readings' },
  { value: 'week', label: 'Last 7 days of readings' },
  { value: 'month', label: 'Last 30 days of readings' },
  { value: 'all', label: 'All stored' },
]
// Dots drawn on the map at once; a long range is thinned evenly.
const MAP_MAX = 2000

function details(p: SubscriberSignalPoint, siteName: string | null, hiddenWhy: string): string[] {
  const level = telemetryLevel({ network_type: p.network_type, rsrp: p.level_dbm, rscp: p.level_dbm, rssi: p.level_dbm })
  const quality = [
    p.rsrq_db != null ? `RSRQ ${p.rsrq_db} dB` : '', p.sinr_db != null ? `SINR ${p.sinr_db} dB` : '',
    p.cqi != null ? `CQI ${p.cqi}${p.cqi_source && p.cqi_source !== 'reported' ? ' (est.)' : ''}` : '',
    p.ecio_db != null ? `Ec/Io ${p.ecio_db} dB` : '', p.rx_qual != null ? `RxQual ${p.rx_qual}` : '',
  ].filter(Boolean).join(' · ')
  const cell = [p.cell_id != null ? `cell ${p.cell_id}` : '', p.pci != null ? `PCI ${p.pci}` : '', p.tac != null ? `TAC ${p.tac}` : ''].filter(Boolean).join(' · ')
  const site = p.serving_site_id ? `Site ${p.serving_site_id}${siteName ? ` ${siteName}` : ''}${p.serving_sector ? ` · sector ${p.serving_sector}` : ''}${p.serving_dist_km != null ? ` · ${p.serving_dist_km.toFixed(2)} km` : ''}` : ''
  const pos = p.lat != null && p.lng != null
    ? `Position ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}${p.gps_accuracy_m != null ? ` ±${Math.round(p.gps_accuracy_m)} m` : ''}` +
      (p.complaint_report_id != null ? ` · shown for problem report #${p.complaint_report_id}` : '')
    : p.has_position ? `Position stored but not shown: ${hiddenWhy}` : 'No GPS position in this reading'
  const measured = !p.status || p.status === 'measured'
  return [
    fmt(p.ts),
    measured
      ? `${p.network_type}${p.band_label ? ` ${p.band_label}` : ''}${p.bandwidth_label ? `, ${p.bandwidth_label}` : ''} · ${level.name} ${p.level_dbm ?? '—'} dBm`
      : `${STATUS_TEXT[p.status as string] ?? 'No network'}${p.status_reason ? ` (${REASON_TEXT[p.status_reason] ?? p.status_reason.replace(/_/g, ' ')})` : ''}`,
    quality, cell, site,
    p.neighbour_count ? `Other cells heard: ${p.neighbour_count}${p.neighbour_best ? `, strongest ${p.neighbour_best}` : ''}` : '',
    pos, environmentText(p), p.trigger_reason ? `Taken: ${p.trigger_reason.replace(/_/g, ' ')}` : '',
    p.delay_s != null && p.delay_s > 600 ? `Reached the server ${delayText(p.delay_s)} later` : '',
  ].filter(Boolean)
}

// What a reading without a network means (2026-10-26, core/telemetry_status.py).
export const STATUS_TEXT: Record<string, string> = {
  not_measured: 'Not measured: the phone did not let the app read the cell',
  no_coverage: 'No coverage: the phone found no network',
  radio_off: 'Flight mode, radio off or no SIM',
}
export const STATUS_SHORT: Record<string, string> = {
  not_measured: 'Not measured', no_coverage: 'No coverage', radio_off: 'Radio off / no SIM',
}
const REASON_TEXT: Record<string, string> = {
  background: 'app in the background', location_off: 'location off', no_permission: 'no location permission',
  empty: 'phone gave no cell', out_of_service: 'out of service', emergency_only: 'emergency calls only',
}
function delayText(s: number) {
  return s >= 86400 ? `${Math.round(s / 86400)} d` : s >= 3600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 60)} min`
}

/** What the signal filter shows, handed to the analysis cards (2026-10-19). */
export interface SignalSelection { analytics: SubscriberAnalytics | null; label: string; loading: boolean }

export default function ProfileSignalHistory({ msisdn, reason, total, emergency, aside, footer, onSelection, pick }: {
  msisdn: string; reason: string; total: number; emergency?: boolean
  // A function gets the readings shown, counted by network, so a side chart
  // follows the session, range, technology and the picked span (2026-10-26).
  aside?: ReactNode | ((countsByNetwork: Record<string, number>) => ReactNode)
  // Extra words for the count line under the chart, e.g. the first reading.
  footer?: ReactNode
  onSelection?: (s: SignalSelection) => void
  // A session chosen elsewhere on the profile; `n` changes on every pick.
  pick?: { session: string; n: number } | null
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState<string>('newest')
  const [session, setSession] = useState('')
  const [tech, setTech] = useState('')
  // Outdoors / indoors / in a vehicle (2026-10-28): the chart and map follow it.
  const [envFilter, setEnvFilter] = useState<EnvFilter>('')
  const [metric, setMetric] = useState<MetricKey>('level')
  const [hover, setHover] = useState<number | null>(null)
  const [sel, setSel] = useState<[number, number] | null>(null)
  const drag = useRef<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const { data, isFetching, error } = useSubscriberSignal(msisdn, reason, range, session, tech, emergency)

  useEffect(() => {
    if (!onSelection) return
    const rangeLabel = range === 'session' ? (data?.session_label ?? 'One session') : (RANGES.find((r) => r.value === range)?.label ?? range)
    onSelection({
      analytics: data?.analytics ?? null,
      label: `${rangeLabel}${tech ? ` · ${tech} only` : ''}${data ? ` · ${data.shown.toLocaleString()} readings` : ''}`,
      loading: isFetching,
    })
  }, [data, range, tech, isFetching, onSelection])

  const fetched = data?.points ?? []
  const envCounts = useMemo(() => {
    const c: Record<string, number> = { outdoor: 0, indoor: 0, vehicle: 0, none: 0 }
    for (const p of fetched) c[p.environment ?? 'none'] = (c[p.environment ?? 'none'] ?? 0) + 1
    return c
  }, [fetched])
  const all = useMemo(() => filterByEnvironment(fetched, envFilter), [fetched, envFilter])
  const m = METRICS[metric]
  const pts = useMemo(() => all.filter((p) => m.value(p) != null), [all, m])
  // Readings with no level (no service, or a measure the phone did not give),
  // marked along the bottom so a gap in the line is explained.
  const noLevel = useMemo(() => (metric === 'level' || metric === 'network' ? all.filter((p) => p.level_dbm == null) : []), [all, metric])
  const n = pts.length
  const times = useMemo(() => pts.map((p) => Date.parse(p.ts)), [pts])
  const allTimes = all.map((p) => Date.parse(p.ts))
  const t0 = allTimes.length ? Math.min(...allTimes) : 0
  const t1 = allTimes.length ? Math.max(...allTimes) : 1
  const xt = (t: number) => (t1 > t0 ? L + ((t - t0) * (W - L - R)) / (t1 - t0) : L + (W - L - R) / 2)
  const x = (i: number) => xt(times[i])
  const y = (v: number) => T + ((m.hi - Math.max(m.lo, Math.min(m.hi, v))) * (H - T - B)) / (m.hi - m.lo)
  const ticks = useMemo(() => timeTicks(t0, t1), [t0, t1])

  // The line breaks where readings stop for a while (longer than 30 minutes
  // and five times the usual spacing), instead of drawing across the gap.
  const segments = useMemo(() => {
    if (n < 2) return [] as number[][]
    const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b)
    const usual = gaps[Math.floor(gaps.length / 2)] || MIN
    const breakAt = Math.max(30 * MIN, 5 * usual)
    const out: number[][] = [[0]]
    for (let i = 1; i < n; i++) {
      if (times[i] - times[i - 1] > breakAt) out.push([i])
      else out[out.length - 1].push(i)
    }
    return out.filter((s) => s.length > 1)
  }, [times, n])

  const indexAt = (e: MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect()
    if (!box || n === 0) return null
    const sx = ((e.clientX - box.left) / box.width) * W
    const t = t0 + ((sx - L) / (W - L - R)) * (t1 - t0)
    return nearest(times, t)
  }
  const choose = (next: { range?: string; session?: string; tech?: string }) => {
    if (next.range !== undefined) setRange(next.range)
    if (next.session !== undefined) setSession(next.session)
    if (next.tech !== undefined) setTech(next.tech)
    setSel(null)
    setHover(null)
  }

  // The session list stays known while one session is shown (each answer
  // carries it); a session picked on the Sessions card arrives as `pick`.
  const [sessionList, setSessionList] = useState<{ key: string; label: string; readings: number | null }[]>([])
  useEffect(() => { if (data?.sessions) setSessionList(data.sessions) }, [data?.sessions])
  useEffect(() => {
    if (!pick) return
    choose({ range: 'session', session: pick.session })
    rootRef.current?.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick])

  const picked = sel ? pts.slice(Math.min(...sel), Math.max(...sel) + 1) : pts
  const sites = data?.sites ?? {}
  const shown = hover != null ? pts[hover] : sel && sel[0] === sel[1] ? pts[sel[0]] : null

  // Map: the picked readings' positions where the server gave them (an
  // emergency, or near the customer's own complaint), else serving sites.
  const windows = data?.complaint_windows ?? []
  const hiddenWhy = windows.length
    ? "outside the time of the customer's problem report"
    : 'no emergency is declared'
  const withPos = picked.filter((p) => p.lat != null && p.lng != null)
  const step = Math.max(1, Math.ceil(withPos.length / MAP_MAX))
  const mapDots = withPos.filter((_, i) => i % step === 0)
  const siteCounts = new Map<string, number>()
  if (!mapDots.length) for (const p of picked) if (p.serving_site_id) siteCounts.set(p.serving_site_id, (siteCounts.get(p.serving_site_id) ?? 0) + 1)
  // Stretches of the chart inside a complaint window, shaded.
  const complaintRuns: [number, number][] = []
  pts.forEach((p, i) => {
    if (p.complaint_report_id == null) return
    const last = complaintRuns[complaintRuns.length - 1]
    if (last && last[1] === i - 1) last[1] = i
    else complaintRuns.push([i, i])
  })
  const siteDots = [...siteCounts.entries()]
    .map(([id, c]) => ({ id, c, s: sites[id] }))
    .filter((d) => d.s && d.s.lat != null && d.s.lng != null)
  const fitPoints: [number, number][] = mapDots.length
    ? mapDots.map((p) => [p.lat as number, p.lng as number])
    : siteDots.map((d) => [d.s.lat as number, d.s.lng as number])
  const fitKey = `${range}|${session}|${tech}|${sel ? sel.join('-') : 'all'}|${fitPoints.length}`

  return (
    <div className="sp-sh" ref={rootRef}>
      <div className="sp-sh-controls">
        <label>Readings{' '}
          <select value={range === 'session' ? '' : range} onChange={(e) => choose({ range: e.target.value, session: '' })}>
            {range === 'session' && <option value="">One session</option>}
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}{r.value === 'all' ? ` (${total.toLocaleString()})` : ''}</option>
            ))}
          </select>
        </label>
        {/* Sessions as a filter of their own (2026-10-19); the Sessions card's
            rows pick one here too. */}
        {/* Always shown (2026-10-19): a number with no sessions says so. */}
        <label>Session{' '}
          <select value={range === 'session' ? session : ''} disabled={sessionList.length === 0 && range !== 'session'}
            onChange={(e) => {
              const v = e.target.value
              choose(v ? { range: 'session', session: v } : { range: 'newest', session: '' })
            }}>
            <option value="">{sessionList.length ? `All sessions (${sessionList.length})` : 'No sessions stored'}</option>
            {sessionList.map((s) => <option key={s.key} value={s.key}>{s.label}{s.readings != null ? ` (${s.readings})` : ''}</option>)}
          </select>
        </label>
        <div className="sp-sh-pills" role="group" aria-label="Technology">
          {['', '4G', '3G', '2G'].map((t) => (
            <button key={t || 'all'} type="button" className={tech === t ? 'on' : ''} onClick={() => choose({ tech: t })}>{t || 'All'}</button>
          ))}
        </div>
        {fetched.some((p) => p.environment) && (
          <div className="sp-sh-pills" role="group" aria-label="Where">
            {(['', 'outdoor', 'indoor', 'vehicle', 'none'] as EnvFilter[]).map((k) => {
              const count = k ? envCounts[k] : fetched.length
              return (
                <button key={k || 'all'} type="button" className={envFilter === k ? 'on' : ''} disabled={!!k && !count}
                  title={k ? `${k === 'none' ? 'Not tagged' : ENV_LABEL[k]}: ${count} readings` : 'Everywhere'}
                  onClick={() => { setEnvFilter(k); setSel(null); setHover(null) }}>
                  {k === '' ? 'Anywhere' : k === 'none' ? 'Not tagged' : k === 'indoor' ? 'Indoors' : k === 'vehicle' ? 'Vehicle' : 'Outdoors'} {count}
                </button>
              )
            })}
          </div>
        )}
        <div className="sp-sh-pills" role="group" aria-label="Colour by">
          {(Object.keys(METRICS) as MetricKey[]).map((k) => (
            <button key={k} type="button" className={metric === k ? 'on' : ''} onClick={() => { setMetric(k); setSel(null) }}>{METRICS[k].label}</button>
          ))}
        </div>
        {isFetching && <span className="sp-muted">Loading…</span>}
      </div>

      {error && <div className="sp-alert err">{apiErrorMessage(error)}</div>}
      {data && n < 1 && <div className="sp-empty">No {m.label === 'Network' || m.label === 'Level' ? '' : `${m.label} `}readings in this choice.</div>}

      {data && n >= 1 && (
        <div className="sp-sh-grid">
          <div className="sp-sh-chart">
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="sp-chart sp-sh-svg" role="img"
              aria-label={`${m.label} over the chosen readings`}
              onMouseMove={(e) => {
                const i = indexAt(e)
                setHover(i)
                if (drag.current != null && i != null) setSel([drag.current, i])
              }}
              onMouseLeave={() => { setHover(null); drag.current = null }}
              onMouseDown={(e) => { const i = indexAt(e); drag.current = i; if (i != null) setSel([i, i]) }}
              onMouseUp={() => { drag.current = null }}>
              {m.grid.map((g) => (
                <g key={g}>
                  <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} className="sp-grid-line" />
                  <text x={L - 6} y={y(g) + 3} className="sp-axis" textAnchor="end">{g}</text>
                </g>
              ))}
              {(metric === 'level' || metric === 'network') && <rect x={L} y={y(-105)} width={W - L - R} height={y(-130) - y(-105)} className="sp-weak-band" />}
              {complaintRuns.map(([a, b]) => (
                <rect key={`c${a}`} x={x(a) - 2} y={T} width={Math.max(4, x(b) - x(a) + 4)} height={H - T - B} className="sp-sh-complaint">
                  <title>Near the customer's problem report: exact positions shown</title>
                </rect>
              ))}
              {sel && sel[0] !== sel[1] && (
                <rect x={x(Math.min(...sel))} y={T} width={Math.max(2, x(Math.max(...sel)) - x(Math.min(...sel)))} height={H - T - B} className="sp-sh-range" />
              )}
              {segments.map((seg) => (
                <polyline key={seg[0]} className="sp-line" points={seg.map((i) => `${x(i)},${y(m.value(pts[i]) as number)}`).join(' ')} />
              ))}
              {pts.map((p, i) => (
                <circle key={i} cx={x(i)} cy={y(m.value(p) as number)} r={n > 1500 ? 1.6 : 2.6} fill={m.color(p)} />
              ))}
              {noLevel.map((p, i) => (
                <line key={`n${i}`} x1={xt(Date.parse(p.ts))} x2={xt(Date.parse(p.ts))} y1={H - B - 7} y2={H - B - 1}
                  className={`sp-sh-noservice sp-sh-st-${p.status ?? 'measured'}`} />
              ))}
              {shown && (() => {
                const i = pts.indexOf(shown)
                return <circle cx={x(i)} cy={y(m.value(shown) as number)} r={5.5} className="sp-sh-focus" />
              })()}
              {hover != null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="sp-sh-cursor" />}
              <line x1={L} x2={W - R} y1={H - B} y2={H - B} className="sp-grid-line" />
              {ticks.map((tk) => (
                <g key={tk.t}>
                  <line x1={xt(tk.t)} x2={xt(tk.t)} y1={H - B} y2={H - B + 4} className="sp-grid-line" />
                  <text x={xt(tk.t)} y={H - B + 15} className="sp-axis" textAnchor="middle">{tk.label}</text>
                </g>
              ))}
              <text x={W - R} y={H - 2} className="sp-axis" textAnchor="end">
                {new Date(t0).toLocaleDateString()}{new Date(t0).toDateString() !== new Date(t1).toDateString() ? ` to ${new Date(t1).toLocaleDateString()}` : ''}
              </text>
            </svg>
            <div className="sp-legend">
              {metric === 'network'
                ? [...new Set(pts.map((p) => p.network_type))].map((k) => <span key={k}><i style={{ background: netColor(k) }} />{k || 'unknown'}</span>)
                : (m.bands ?? []).map((b) => <span key={b.label}><i style={{ background: b.color }} />{b.label}</span>)}
              {(() => {
                // Readings with no level, by what they mean (2026-10-26).
                const by: Record<string, number> = {}
                for (const p of noLevel) { const k = p.status && p.status !== 'measured' ? p.status : 'no_level'; by[k] = (by[k] ?? 0) + 1 }
                return Object.entries(by).map(([k, v]) => (
                  <span key={k} title={STATUS_TEXT[k] ?? 'The phone named its network but gave no level'}>
                    <i className={`sp-sh-noservice-key sp-sh-st-${k}`} />{STATUS_SHORT[k] ?? 'No level'} ({v})
                  </span>
                ))
              })()}
              {metric === 'level' && tech !== '4G' && tech !== '3G' && pts.some((p) => p.network_type === 'GSM') && (
                <span className="sp-muted">2G on the RxLev scale ({RXLEV_BANDS.map((b) => b.label).join(', ')})</span>
              )}
            </div>
            <div className="sp-sh-info">
              {shown
                ? details(shown, shown.serving_site_id ? sites[shown.serving_site_id]?.name ?? null : null, hiddenWhy)
                  .map((line, i) => <div key={i} className={i === 0 ? 'sp-sh-info-head' : ''}>{line}</div>)
                : <div className="sp-muted">Point at a reading for its details. Click one, or drag across a stretch, to see it on the map.</div>}
            </div>
            {/* The counts sit under the chart, not under both columns, so no
                gap opens below the shorter chart column (2026-10-26). */}
            <div className="sp-muted sp-sh-foot">
              {data.range === 'session' ? `${data.session_label}: ` : ''}
              {data.limited ? `newest ${data.shown.toLocaleString()} of ${data.total.toLocaleString()} readings` : `${data.shown.toLocaleString()} readings`}
              {tech ? ` on ${tech}` : ''}
              {n < data.shown ? ` · ${(data.shown - n).toLocaleString()} without ${m.label}` : ''}
              {sel ? ` · ${picked.length.toLocaleString()} picked` : ''}
              {footer ? <> · {footer}</> : null}
            </div>
          </div>

          <div className="sp-sh-side">
            <div className="sp-sh-map">
              <MapContainer center={[27.7, 85.3]} zoom={7} style={{ height: '100%', width: '100%' }} scrollWheelZoom={false} attributionControl={false}>
                <BaseMap />
                <FitToPoints points={fitPoints} fitKey={fitKey} singleZoom={15} />
                {mapDots.map((p) => {
                  const i = pts.indexOf(p)
                  const isShown = shown === p
                  return (
                    <CircleMarker key={`${p.ts}-${i}`} center={[p.lat as number, p.lng as number]} radius={isShown ? 8 : 4}
                      pathOptions={{ color: isShown ? '#0f172a' : m.color(p), weight: isShown ? 3 : 1, fillColor: m.color(p), fillOpacity: 0.9 }}
                      eventHandlers={{ click: () => setSel([i, i]) }}>
                      <Tooltip>{details(p, null, hiddenWhy).slice(0, 3).join(' · ')}</Tooltip>
                    </CircleMarker>
                  )
                })}
                {siteDots.map((d) => (
                  <CircleMarker key={d.id} center={[d.s.lat as number, d.s.lng as number]} radius={Math.min(14, 5 + Math.log2(d.c + 1))}
                    pathOptions={{ color: '#4f46e5', fillColor: shown?.serving_site_id === d.id ? '#f59e0b' : '#818cf8', fillOpacity: 0.85, weight: 2 }}>
                    <Tooltip>{`Site ${d.id}${d.s.name ? ` · ${d.s.name}` : ''} · ${d.c} reading${d.c === 1 ? '' : 's'}`}</Tooltip>
                  </CircleMarker>
                ))}
              </MapContainer>
            </div>
            <div className="sp-muted sp-sh-mapnote">
              {mapDots.length
                ? `Positions of ${sel ? 'the picked' : 'these'} readings${step > 1 ? ` (every ${step}th)` : ''}` +
                  (data.positions_shown ? '.' : ` near the customer's problem report (${withPos.length} of ${picked.length}).`)
                : `Serving sites of ${sel ? 'the picked' : 'these'} readings. Positions show to admins only in an emergency${windows.length ? " or near the customer's problem report (shaded)" : ''}.`}
              {sel && <> {' '}<button type="button" className="sp-linkbtn" onClick={() => setSel(null)}>Show all again</button></>}
            </div>
            {typeof aside === 'function'
              ? aside(picked.reduce<Record<string, number>>((acc, p) => {
                const k = p.status && p.status !== 'measured' ? p.status : (p.network_type || 'UNKNOWN')
                acc[k] = (acc[k] ?? 0) + 1
                return acc
              }, {}))
              : aside}
          </div>
        </div>
      )}
    </div>
  )
}
