import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { Circle, CircleMarker, MapContainer, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { apiErrorMessage } from '../api/client'
import {
  useCreateProblemReport, useNotifyProblemReport, useProblemDashboard, useProblemNearbySites, useProblemReport,
  useProblemReports, useUpdateProblemReport,
} from '../api/queries'
import type { ProblemCategory, ProblemCount, ProblemDashboard, ProblemHotspot, ProblemReport } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { DT_SESSION_HISTORY_PATH, OPAQUE_PATHS } from '../constants/opaqueRoutes'

// Problem Dashboard (2026-10-15; Problem Reports since 2026-10-14) --
// problems people report from the mobile app, ones an engineer enters from a
// customer's complaint, and ones another NTC system sends through the
// external API. Overview: totals, causes and trends. Reports: the list and
// each report's check. Map: every report by cause. Hotspots: the sites and
// areas with the most reports. Admin and superadmin. The tab, period and
// filters live in the page address, so coming back keeps them.

const CATEGORIES: { key: ProblemCategory; label: string }[] = [
  { key: 'no_signal', label: 'No signal' },
  { key: 'slow_data', label: 'Slow data' },
  { key: 'call_drop', label: 'Call drops' },
  { key: 'stuck_2g3g', label: 'Stuck on 2G/3G' },
  { key: 'other', label: 'Other' },
]
const CATEGORY_COLOR: Record<string, string> = {
  no_signal: '#ef4444', slow_data: '#f59e0b', call_drop: '#8b5cf6', stuck_2g3g: '#0ea5e9', other: '#64748b',
}
// One colour per likely cause, used by the charts, the map and the hotspots.
const CAUSE_COLOR: Record<string, string> = {
  weak_coverage: '#ef4444',
  interference: '#f97316',
  busy_cell: '#eab308',
  lower_tech: '#0ea5e9',
  lower_tech_weak_4g: '#6366f1',
  worse_than_usual: '#db2777',
  call_drop: '#8b5cf6',
  no_data: '#94a3b8',
  no_fault_found: '#22c55e',
  unchecked: '#cbd5e1',
}
const STATUS_LABEL: Record<string, string> = { new: 'New', checked: 'Checked', closed: 'Closed' }
const NEPAL_CENTER: [number, number] = [28.3949, 84.124]
const PERIODS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 365, label: 'Last 12 months' },
  { days: 3650, label: 'All' },
]
type Tab = 'overview' | 'reports' | 'map' | 'hotspots'
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'reports', label: 'Reports' },
  { key: 'map', label: 'Map' },
  { key: 'hotspots', label: 'Hotspots' },
]

function fmt(v: number | null | undefined, unit = '') {
  return v == null ? '—' : `${v}${unit}`
}

function when(iso: string) {
  return new Date(iso).toLocaleString()
}

function age(iso: string | null) {
  if (!iso) return '—'
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000
  return h < 48 ? `${Math.max(0, Math.round(h))} h` : `${Math.round(h / 24)} days`
}

function hours(h: number | null) {
  if (h == null) return '—'
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`
}

function sourceText(r: ProblemReport) {
  if (r.source === 'app') return `App${r.network_type ? `, ${r.network_type}` : ''}`
  if (r.source === 'external') return `${r.external_system}${r.external_ref ? ` #${r.external_ref}` : ''}`
  return `Staff (${r.entered_by ?? ''})`
}

function ClickToPick({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) })
  return null
}

function FlyTo({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap()
  useEffect(() => {
    map.setView([lat, lng], 14)
  }, [map, lat, lng])
  return null
}

function FitPoints({ points }: { points: [number, number][] }) {
  const map = useMap()
  const key = points.length ? `${points.length}:${points[0][0]}:${points[points.length - 1][1]}` : ''
  useEffect(() => {
    if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [24, 24], maxZoom: 15 })
    else if (points.length === 1) map.setView(points[0], 14)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key])
  return null
}

export default function ProblemReportsPage() {
  const [params, setParams] = useSearchParams()
  // ?status=all (from Subscriber Profile) opens every report, of any age.
  const statusAll = params.get('status') === 'all'
  const tab = (params.get('tab') as Tab) || (params.get('status') ? 'reports' : 'overview')
  const days = Number(params.get('days')) || (statusAll ? 3650 : 30)
  const set = (changes: Record<string, string | number | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, String(v))
    }
    setParams(next, { replace: true })
  }
  const dash = useProblemDashboard(days)

  return (
    <div className="admin-page">
      <h1>Problem Dashboard</h1>
      <p className="muted">
        Network problems reported with the mobile app's "Report a problem" button, entered by staff from a customer's
        complaint, or sent by another NTC system. Each report is checked against what other phones and drive tests
        measured within 500 m and the week before, and given a likely cause from fixed rules on the measurements;
        confirm it before acting.
      </p>

      <div className="pd-bar">
        <div className="feat-tabs">
          {TABS.map((t) => (
            <button key={t.key} type="button" className={`feat-tab${tab === t.key ? ' active' : ''}`}
              onClick={() => set({ tab: t.key })}>
              {t.label}
            </button>
          ))}
        </div>
        <label className="pd-period">
          Period{' '}
          <select value={days} onChange={(e) => set({ days: e.target.value })}>
            {PERIODS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}
          </select>
        </label>
        <button type="button" className="btn-primary btn-small" onClick={() => set({ tab: 'reports', enter: 1, report: null })}>
          Enter a complaint
        </button>
      </div>

      {dash.error && <p className="error">{apiErrorMessage(dash.error)}</p>}
      {dash.data && dash.data.pending > 0 && (
        <p className="pd-pending">
          {dash.data.pending} new report{dash.data.pending === 1 ? ' is' : 's are'} still being checked; they count as
          "Not checked yet" for a few minutes.
        </p>
      )}

      {tab === 'overview' && (dash.data
        ? <Overview d={dash.data} onCause={(c) => set({ tab: 'reports', cause: c, status: 'all', site: null, area: null, days })}
            onHotspot={(h) => openHotspot(h, set, days)} />
        : !dash.error && <p className="muted">Loading…</p>)}
      {tab === 'reports' && <Reports params={params} set={set} days={days} statusAll={statusAll} />}
      {tab === 'map' && (dash.data
        ? <ProblemMap d={dash.data} onOpen={(id) => set({ tab: 'reports', report: id, enter: null })} />
        : !dash.error && <p className="muted">Loading…</p>)}
      {tab === 'hotspots' && (dash.data
        ? <Hotspots d={dash.data} onOpen={(h) => openHotspot(h, set, days)} />
        : !dash.error && <p className="muted">Loading…</p>)}
    </div>
  )
}

function openHotspot(h: ProblemHotspot, set: (c: Record<string, string | number | null>) => void, days: number) {
  set({ tab: 'reports', site: h.site_id, area: h.area ?? null, cause: null, status: 'all', report: null, enter: null, days })
}

// ── Overview ───────────────────────────────────────────────────────────────

function Overview({ d, onCause, onHotspot }: {
  d: ProblemDashboard; onCause: (cause: string) => void; onHotspot: (h: ProblemHotspot) => void
}) {
  const t = d.totals
  return (
    <>
      <div className="pd-kpis">
        <Kpi label="Reports" value={t.all} sub={`${t.app} app · ${t.staff} staff · ${t.external} other systems`} />
        <Kpi label="New" value={t.new} sub={t.overdue ? `${t.overdue} waiting over ${t.overdue_hours} h` : 'none overdue'}
          warn={t.overdue > 0} />
        <Kpi label="Checked" value={t.checked} />
        <Kpi label="Closed" value={t.closed} />
        <Kpi label="Time to check" value={hours(t.median_hours_to_check)} sub="median" />
        <Kpi label="Oldest new" value={age(t.oldest_open_at)} sub={t.oldest_open_at ? 'waiting' : 'nothing waiting'} />
      </div>

      {t.all === 0 ? (
        <p className="pd-empty">No reports in this period.</p>
      ) : (
        <div className="pd-grid">
          <section className="pd-card pd-wide">
            <h3>Reports per day</h3>
            <DayChart d={d} />
          </section>
          <section className="pd-card">
            <h3>Likely cause</h3>
            <Bars rows={d.by_cause} color={(k) => CAUSE_COLOR[k] ?? '#64748b'} onClick={onCause}
              hint="Click a cause to list its reports." />
          </section>
          <section className="pd-card">
            <h3>Most reports</h3>
            {d.hotspots.length ? (
              <ol className="pd-top">
                {d.hotspots.slice(0, 6).map((h) => (
                  <li key={h.key}>
                    <button type="button" className="pd-link" onClick={() => onHotspot(h)}>{h.name}</button>
                    <span className="muted">{h.district}</span>
                    <b>{h.count}</b>
                    <i style={{ background: CAUSE_COLOR[h.top_cause] }} title={h.top_cause_label} />
                  </li>
                ))}
              </ol>
            ) : <p className="muted">None.</p>}
          </section>
          <section className="pd-card">
            <h3>What people reported</h3>
            <Bars rows={d.by_category} color={(k) => CATEGORY_COLOR[k] ?? '#64748b'} />
          </section>
          <section className="pd-card">
            <h3>Where from</h3>
            <Bars rows={d.by_source} color={() => '#0891b2'} />
          </section>
          <section className="pd-card">
            <h3>District</h3>
            <Bars rows={d.by_district} color={() => '#4f46e5'} />
          </section>
          <section className="pd-card">
            <h3>Network and band</h3>
            <Bars rows={d.by_tech} color={() => '#0d9488'} />
            {d.by_band.length > 0 && <Bars rows={d.by_band} color={() => '#14b8a6'} />}
          </section>
        </div>
      )}
    </>
  )
}

function Kpi({ label, value, sub, warn }: { label: string; value: number | string; sub?: string; warn?: boolean }) {
  return (
    <div className={`pd-kpi${warn ? ' pd-kpi-warn' : ''}`}>
      <span>{label}</span>
      <b>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  )
}

function Bars({ rows, color, onClick, hint }: {
  rows: ProblemCount[]; color: (key: string) => string; onClick?: (key: string) => void; hint?: string
}) {
  if (!rows.length) return <p className="muted">None.</p>
  const max = Math.max(...rows.map((r) => r.count))
  return (
    <div className="pd-bars" title={hint}>
      {rows.map((r) => (
        <button key={r.key} type="button" className="pd-bar-row" disabled={!onClick} onClick={() => onClick?.(r.key)}>
          <span className="pd-bar-label">{r.label}</span>
          <span className="pd-bar-track">
            <span style={{ width: `${(100 * r.count) / max}%`, background: color(r.key) }} />
          </span>
          <b>{r.count}</b>
        </button>
      ))}
    </div>
  )
}

function DayChart({ d }: { d: ProblemDashboard }) {
  const W = 760, H = 150, L0 = 26, R = 6, T = 8, B = 20
  const series = d.per_day
  const totals = series.map((s) => d.categories.reduce((n, c) => n + (s[c.key] ?? 0), 0))
  const max = Math.max(1, ...totals)
  const bw = (W - L0 - R) / series.length
  const y = (v: number) => T + (H - T - B) * (1 - v / max)
  const step = Math.max(1, Math.ceil(series.length / 8))
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="pd-chart" role="img" aria-label="Reports per day">
        {[0, max / 2, max].map((v) => (
          <g key={v}>
            <line x1={L0} x2={W - R} y1={y(v)} y2={y(v)} className="pd-grid-line" />
            <text x={L0 - 4} y={y(v) + 3} textAnchor="end" className="pd-axis">{Math.round(v)}</text>
          </g>
        ))}
        {series.map((s, i) => {
          let acc = 0
          return (
            <g key={s.date}>
              {d.categories.map((c) => {
                const v = s[c.key] ?? 0
                if (!v) return null
                const top = y(acc + v), bottom = y(acc)
                acc += v
                return <rect key={c.key} x={L0 + i * bw + 1} width={Math.max(1, bw - 2)} y={top} height={bottom - top}
                  fill={CATEGORY_COLOR[c.key]}><title>{`${s.date}: ${v} ${c.label}`}</title></rect>
              })}
              {i % step === 0 && (
                <text x={L0 + i * bw + bw / 2} y={H - 6} textAnchor="middle" className="pd-axis">{s.date.slice(5)}</text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="pd-legend">
        {d.categories.map((c) => <span key={c.key}><i style={{ background: CATEGORY_COLOR[c.key] }} />{c.label}</span>)}
      </div>
    </>
  )
}

// ── Reports ────────────────────────────────────────────────────────────────

function Reports({ params, set, days, statusAll }: {
  params: URLSearchParams; set: (c: Record<string, string | number | null>) => void; days: number; statusAll: boolean
}) {
  const status = statusAll ? '' : params.get('status') ?? 'new'
  const source = params.get('source') ?? ''
  const cause = params.get('cause') ?? ''
  const site = params.get('site') ?? ''
  const area = params.get('area') ?? ''
  const selected = params.get('report') ? Number(params.get('report')) : null
  const entering = params.get('enter') === '1'
  const q = params.get('q') ?? ''
  const [typed, setTyped] = useState(q)
  useEffect(() => setTyped(q), [q])
  useEffect(() => {
    const t = window.setTimeout(() => { if (typed.trim() !== q) set({ q: typed.trim() || null }) }, 400)
    return () => window.clearTimeout(t)
  }, [typed, q, set])
  const { data, isLoading, error } = useProblemReports({ status, source, cause, site, area, days, q })
  const rows = data?.results ?? []

  return (
    <>
      <div className="problem-toolbar">
        <label>
          Status{' '}
          <select value={status} onChange={(e) => set({ status: e.target.value || 'all' })}>
            <option value="">All</option>
            <option value="new">New</option>
            <option value="checked">Checked</option>
            <option value="closed">Closed</option>
          </select>
        </label>
        <label>
          From{' '}
          <select value={source} onChange={(e) => set({ source: e.target.value })}>
            <option value="">Everywhere</option>
            <option value="app">Mobile app</option>
            <option value="staff">Entered by staff</option>
            <option value="external">Other systems</option>
          </select>
        </label>
        <label className="pd-search">
          <input type="search" value={typed} onChange={(e) => setTyped(e.target.value)}
            placeholder="Search: mobile number, PR-12, ticket or words" aria-label="Search reports" />
        </label>
        {cause && (
          <span className="pd-chip">
            Cause: {rows[0]?.cause_label || cause}
            <button type="button" onClick={() => set({ cause: null })} title="Remove">×</button>
          </span>
        )}
        {(site || area) && (
          <span className="pd-chip">
            {site ? <>Site <Link to={`/sites/${site}`}>{site}</Link></> : `Area ${area}`}
            <button type="button" onClick={() => set({ site: null, area: null })} title="Remove">×</button>
          </span>
        )}
      </div>

      <div className="problem-layout">
        <div className="problem-list">
          {isLoading && <p className="muted">Loading…</p>}
          {error && <p className="error">{apiErrorMessage(error)}</p>}
          {!isLoading && !rows.length && <p className="muted">No reports.</p>}
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`problem-row${selected === r.id ? ' problem-row-active' : ''}`}
              onClick={() => set({ report: r.id, enter: null })}
            >
              <span className="problem-row-title">
                <i className="pd-dot" style={{ background: CAUSE_COLOR[r.cause || 'unchecked'] }} />
                {r.category_label}
              </span>
              <span className="muted">{when(r.happened_at)}</span>
              <span className="muted">{sourceText(r)} · {STATUS_LABEL[r.status]}</span>
              {(r.cause_label || r.site_id) && (
                <span className="muted">{r.cause_label}{r.site_id ? ` · ${r.site_id}` : ''}</span>
              )}
              <span className="muted pd-row-ref">{r.reference ?? `PR-${r.id}`}{r.phone_number ? ` · ${r.phone_number}` : ''}</span>
            </button>
          ))}
        </div>
        <div className="problem-detail">
          {entering && <EnterComplaint onSaved={(id) => set({ enter: null, status: 'all', report: id })} />}
          {!entering && selected != null && <ReportDetail id={selected} />}
          {!entering && selected == null && <p className="muted">Choose a report, or enter a complaint.</p>}
        </div>
      </div>
    </>
  )
}

// ── Map ────────────────────────────────────────────────────────────────────

function ProblemMap({ d, onOpen }: { d: ProblemDashboard; onOpen: (id: number) => void }) {
  const [openOnly, setOpenOnly] = useState(false)
  const points = useMemo(() => d.points.filter((p) => !openOnly || p.status === 'new'), [d.points, openOnly])
  const causeLabel = useMemo(() => Object.fromEntries(d.by_cause.map((c) => [c.key, c.label])), [d.by_cause])
  return (
    <>
      <div className="problem-toolbar">
        <label><input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> New only</label>
        <span className="muted">{points.length} report{points.length === 1 ? '' : 's'}; click a dot to open it.</span>
      </div>
      <div className="pd-map">
        <MapContainer center={NEPAL_CENTER} zoom={7} style={{ height: '100%', width: '100%' }}>
          <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <FitPoints points={points.map((p) => [p.lat, p.lng] as [number, number])} />
          {points.map((p) => (
            <CircleMarker key={p.id} center={[p.lat, p.lng]} radius={p.status === 'new' ? 7 : 5}
              pathOptions={{ color: '#fff', weight: 1.5, fillColor: CAUSE_COLOR[p.cause || 'unchecked'], fillOpacity: 0.9 }}
              eventHandlers={{ click: () => onOpen(p.id) }}>
              <Tooltip>
                {causeLabel[p.cause || 'unchecked'] ?? 'Not checked yet'} · {STATUS_LABEL[p.status]}
                {p.site_id ? ` · ${p.site_id}` : ''} · {when(p.happened_at)}
              </Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>
      <div className="pd-legend">
        {d.by_cause.map((c) => (
          <span key={c.key}><i style={{ background: CAUSE_COLOR[c.key] ?? '#64748b' }} />{c.label} ({c.count})</span>
        ))}
      </div>
    </>
  )
}

// ── Hotspots ───────────────────────────────────────────────────────────────

function Hotspots({ d, onOpen }: { d: ProblemDashboard; onOpen: (h: ProblemHotspot) => void }) {
  if (!d.hotspots.length) return <p className="pd-empty">No reports in this period.</p>
  return (
    <>
      <p className="muted">
        Reports grouped by the site that served the phone (or the nearest site), and by 500 m area where no site is
        within reach. Most reports first.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Site or area</th><th>District</th><th>Reports</th><th>New</th><th>Main cause</th>
              <th>All causes</th><th>Sectors</th><th>Average level</th><th>Latest</th><th />
            </tr>
          </thead>
          <tbody>
            {d.hotspots.map((h) => (
              <tr key={h.key}>
                <td>{h.site_id ? <Link to={`/sites/${h.site_id}`}>{h.name}</Link> : h.name}</td>
                <td>{h.district || '—'}</td>
                <td><b>{h.count}</b></td>
                <td>{h.open || '—'}</td>
                <td><i className="pd-dot" style={{ background: CAUSE_COLOR[h.top_cause] }} />{h.top_cause_label}</td>
                <td className="pd-causes">
                  {h.causes.map((c) => <span key={c.key} title={c.label} style={{ borderColor: CAUSE_COLOR[c.key] }}>{c.label} {c.count}</span>)}
                </td>
                <td>{h.sectors.length ? h.sectors.map((s) => `${s.key} (${s.count})`).join(', ') : '—'}</td>
                <td>{fmt(h.level_mean, ' dBm')}</td>
                <td>{when(h.latest_at)}</td>
                <td><button type="button" className="btn-secondary btn-small" onClick={() => onOpen(h)}>Reports</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ── One report ─────────────────────────────────────────────────────────────

// One complaint as a dashboard (2026-10-19), after NTC's ticketing system:
// details of the complaint, a diagnostics summary that opens the full
// diagnostics (likely cause and measurements, nearest sites, the phone's
// reading, the reply), and status with the engineer's note. The customer's
// number (superadmin only) opens the Subscriber Profile with this report as
// its reference, and the profile leads back here.
type DiagTab = 'cause' | 'sites' | 'phone' | 'reply'

function CopyText({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" className="pd-copy" title={`Copy ${label ?? text}`}
      onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); window.setTimeout(() => setDone(false), 1200) }}>
      {done ? '✓' : '⧉'}
    </button>
  )
}

function ReportDetail({ id }: { id: number }) {
  const { data: r, isLoading, error } = useProblemReport(id)
  const update = useUpdateProblemReport()
  const { user } = useAuth()
  const location = useLocation()
  const [note, setNote] = useState('')
  const [diag, setDiag] = useState<DiagTab | null>(null)
  useEffect(() => {
    setNote(r?.engineer_note ?? '')
    setDiag(null)
  }, [r?.id, r?.engineer_note])
  useEffect(() => {
    if (!diag) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDiag(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [diag])

  if (isLoading) return <p className="muted">Checking the measurements around this spot…</p>
  if (error || !r) return <p className="error">{apiErrorMessage(error)}</p>
  const c = r.check
  const reference = r.reference ?? `PR-${r.id}`
  const isSuper = user?.role === 'superadmin'
  // The profile opens on this number with this report as its reference, and
  // carries the way back to this report (2026-10-19).
  const profileLink = r.phone_number ? `${OPAQUE_PATHS['/subscriber-profile']}?${new URLSearchParams({
    msisdn: r.phone_number, reason: `Complaint ${reference}`, from: `${location.pathname}${location.search}`,
  })}` : null
  const main = c?.findings[0]

  return (
    <div className="pdd">
      <div className="pdd-head">
        <div>
          <h2>{r.category_label} <span className="pdd-ref">{reference}</span></h2>
          <div className="pdd-chips">
            <span className={`pdd-chip pdd-status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
            {r.network_type && <span className="pdd-chip">{r.network_type}</span>}
            {r.cause_label && <span className="pdd-chip" style={{ borderColor: CAUSE_COLOR[r.cause || 'unchecked'] }}>
              <i className="pd-dot" style={{ background: CAUSE_COLOR[r.cause || 'unchecked'] }} />{r.cause_label}</span>}
            <span className="muted">{sourceText(r)} · {when(r.happened_at)}</span>
          </div>
        </div>
        <div className="problem-actions" style={{ marginTop: 0 }}>
          {(['checked', 'closed', 'new'] as const).filter((s) => s !== r.status).map((s) => (
            <button key={s} type="button" className={s === 'checked' ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
              disabled={update.isPending} onClick={() => update.mutate({ id: r.id, status: s, engineer_note: note })}>
              {s === 'checked' ? 'Mark checked' : s === 'closed' ? 'Close' : 'Reopen'}
            </button>
          ))}
        </div>
      </div>

      <div className="pdd-grid">
        <section className="pdd-card">
          <h3>Customer complaint details</h3>
          <dl className="pdd-kv">
            <dt>Mobile</dt>
            <dd>
              {r.phone_number
                ? <><span className="mono">{r.phone_number}</span> <CopyText text={r.phone_number} label="the number" />
                  {profileLink && <Link className="pdd-link" to={profileLink}>Open Subscriber Profile →</Link>}</>
                : r.has_number && !isSuper ? <span className="muted">Held; shown to superadmin only</span>
                  : <span className="muted">Not given</span>}
            </dd>
            <dt>Source</dt>
            <dd>{r.source === 'app' ? 'Mobile app' : r.source === 'external' ? `${r.external_system}, ticket ${r.external_ref}` : `Entered by ${r.entered_by}`}</dd>
            <dt>Problem location</dt>
            <dd><span className="mono">{r.lat.toFixed(6)}, {r.lng.toFixed(6)}</span> <CopyText text={`${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}`} label="the location" />
              {r.located_by === 'site' || r.located_by === 'cell' ? <span className="muted"> · from the {r.located_by}</span> : null}</dd>
            <dt>Issue</dt><dd><b>{r.category_label}</b></dd>
            {r.note && <><dt>Customer's words</dt><dd className="problem-note" style={{ margin: 0 }}>"{r.note}"</dd></>}
            {r.site_id && <><dt>Serving site</dt><dd><Link to={`/sites/${r.site_id}`}>{r.site_id}</Link>{r.sector ? ` · sector ${r.sector}` : ''}</dd></>}
          </dl>
          {(r.located_by === 'site' || r.located_by === 'cell') && (
            <p className="pd-caution">
              The other system gave only the {r.located_by === 'site' ? 'site' : 'cell'}, not the customer's spot, so the
              check looks around the mast. Ask for the customer's location for a closer check.
            </p>
          )}
        </section>

        <section className="pdd-card pdd-diag">
          <h3>Diagnostics</h3>
          {main ? (
            <div className="pdd-main-finding">
              <b>{main.title}</b>
              <p>{main.cause}</p>
              {main.evidence.length > 0 && <p className="muted">Measured: {main.evidence.slice(0, 3).join(' · ')}</p>}
            </div>
          ) : <p className="muted">Not checked yet.</p>}
          <button type="button" className="btn-primary" onClick={() => setDiag('cause')}>⤢ Open full diagnostics</button>
          <p className="muted pdd-small">
            Likely cause and the measurements around the spot, the nearest sites and cells, the phone's own reading, and the
            reply to the customer.
          </p>
          <div className="problem-map pdd-map">
            <MapContainer center={[r.lat, r.lng]} zoom={14} style={{ height: '100%', width: '100%' }}>
              <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <FlyTo lat={r.lat} lng={r.lng} />
              <Circle center={[r.lat, r.lng]} radius={c?.radius_m ?? 500} pathOptions={{ color: '#2563eb', weight: 1, fillOpacity: 0.06 }} />
              <CircleMarker center={[r.lat, r.lng]} radius={7} pathOptions={{ color: '#dc2626', fillColor: '#dc2626', fillOpacity: 0.9 }}>
                <Tooltip>Where the problem was reported</Tooltip>
              </CircleMarker>
            </MapContainer>
          </div>
        </section>

        <section className="pdd-card">
          <h3>Status and engineer's note</h3>
          <p className="muted" style={{ marginTop: 0 }}>Now: <b>{STATUS_LABEL[r.status]}</b>{r.checked_by ? ` (by ${r.checked_by}${r.checked_at ? `, ${when(r.checked_at)}` : ''})` : ''}</p>
          <textarea rows={4} style={{ width: '100%' }} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000}
            placeholder="What was found and done" />
          <div className="problem-actions">
            <button type="button" className="btn-secondary btn-small" disabled={update.isPending || note === (r.engineer_note ?? '')}
              onClick={() => update.mutate({ id: r.id, status: r.status, engineer_note: note })}>Save note</button>
          </div>
          {update.error && <p className="error">{apiErrorMessage(update.error)}</p>}
          {r.notify && <SystemUpdates id={r.id} n={r.notify} />}
        </section>
      </div>

      {diag && (
        <div className="pdd-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setDiag(null) }}>
          <div className="pdd-modal" role="dialog" aria-modal="true" aria-label="Full diagnostics">
            <div className="pdd-modal-head">
              <div>
                <b>Full diagnostics</b>
                <div className="muted pdd-small">{reference} · {r.category_label}{r.phone_number ? ` · ${r.phone_number}` : ''} · {r.lat.toFixed(5)}, {r.lng.toFixed(5)}</div>
              </div>
              <button type="button" className="btn-secondary btn-small" onClick={() => setDiag(null)}>Close</button>
            </div>
            <div className="pdd-modal-body">
              <nav className="pdd-tabs">
                {([['cause', 'Likely cause & measurements'], ['sites', 'Nearest sites/cells'],
                  ...(r.source === 'app' ? [['phone', "Phone's reading"]] : []), ['reply', 'Reply to the customer']] as [DiagTab, string][])
                  .map(([k, label]) => (
                    <button key={k} type="button" className={diag === k ? 'on' : ''} onClick={() => setDiag(k)}>{label}</button>
                  ))}
                {profileLink && <Link className="pdd-tab-link" to={profileLink}>Subscriber Profile →</Link>}
              </nav>
              <div className="pdd-tab-body">
                {diag === 'cause' && (c ? <CauseTab c={c} reportId={r.id} /> : <p className="muted">Not checked yet.</p>)}
                {diag === 'sites' && <NearbySites r={r} />}
                {diag === 'phone' && <PhoneTab r={r} />}
                {diag === 'reply' && (c ? <ReplyTab text={c.customer_reply} /> : <p className="muted">Not checked yet.</p>)}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CauseTab({ c }: { c: NonNullable<ProblemReport['check']>; reportId: number }) {
  return (
    <>
      {c.findings.map((f, i) => (
        <div key={i} className="problem-finding">
          <strong>{f.title}</strong>
          <p>{f.cause}</p>
          <p><em>Suggested action:</em> {f.action}</p>
          {f.evidence.length > 0 && <p className="muted">Measured: {f.evidence.join(' · ')}</p>}
        </div>
      ))}
      <h3>Measurements around the spot ({c.radius_m} m)</h3>
      <table className="problem-facts">
        <tbody>
          <tr><th>Serving site</th><td>
            {c.serving
              ? <><Link to={`/sites/${c.serving.site_id}`}>{c.serving.site_id}</Link> {c.serving.cell_name} · {fmt(c.serving.km, ' km')} (found by {c.serving.matched_by})</>
              : 'Not known from the report'}
          </td></tr>
          <tr><th>Phones at the time</th><td>{areaText(c.phones_at_time)}</td></tr>
          <tr><th>Phones, {c.baseline_days} days before</th><td>{areaText(c.phones_before)}</td></tr>
          <tr><th>Drive tests</th><td>
            {c.drive_tests.readings
              ? <>
                {c.drive_tests.readings} readings; 4G {fmt(c.drive_tests.rsrp_4g_mean, ' dBm')}
                {c.drive_tests.rsrq_4g_mean != null ? `, RSRQ ${c.drive_tests.rsrq_4g_mean} dB` : ''}
                {c.drive_tests.dl_4g_mean != null ? `, download ${c.drive_tests.dl_4g_mean} Mbps` : ''} average.{' '}
                {c.drive_tests.sessions.map((s, i) => (
                  <span key={s.id}>{i > 0 && ', '}<Link to={`${DT_SESSION_HISTORY_PATH}?session=${s.id}`}>{s.name || `Session ${s.id}`}</Link>{s.date ? ` (${s.date})` : ''}</span>
                ))}
              </>
              : 'None here'}
          </td></tr>
        </tbody>
      </table>
    </>
  )
}

function PhoneTab({ r }: { r: ProblemReport }) {
  return (
    <table className="problem-facts">
      <tbody>
        <tr><th>Phone's signal</th><td>
          {r.network_type || '—'}{r.band ? ` ${r.band}` : ''} · level {fmt(r.level_dbm, ' dBm')}
          {r.rsrq_db != null ? ` · RSRQ ${r.rsrq_db} dB` : ''}{r.sinr_db != null ? ` · SINR ${r.sinr_db} dB` : ''}
          {r.pci != null ? ` · PCI ${r.pci}` : ''}{r.cell_id != null ? ` · cell ${r.cell_id}` : ''}
        </td></tr>
        <tr><th>Speed test</th><td>
          download {fmt(r.download_mbps, ' Mbps')} · upload {fmt(r.upload_mbps, ' Mbps')} · ping {fmt(r.ping_ms, ' ms')}
          {' '}· jitter {fmt(r.jitter_ms, ' ms')} · loss {fmt(r.packet_loss_pct, '%')}
        </td></tr>
        <tr><th>Phone</th><td>{r.phone_model || '—'}{r.android_version ? `, Android ${r.android_version}` : ''}{r.app_version ? ` · app ${r.app_version}` : ''}</td></tr>
      </tbody>
    </table>
  )
}

function ReplyTab({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <>
      <p className="problem-reply">{text}</p>
      <button type="button" className="btn-secondary btn-small" onClick={() => { void navigator.clipboard?.writeText(text); setCopied(true) }}>
        {copied ? 'Copied' : 'Copy reply'}
      </button>
    </>
  )
}

const TECH_COLOR: Record<string, string> = { '2G': '#d97706', '3G': '#4f46e5', '4G': '#0891b2', '5G': '#db2777' }

function NearbySites({ r }: { r: ProblemReport }) {
  const [radius, setRadius] = useState(1)
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const { data, isFetching, error } = useProblemNearbySites(r.id, radius)
  const sites = (data?.sites ?? []).filter((s) => !filter || `${s.site_id} ${s.name ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
  const nearest = data?.sites[0]?.site_id
  return (
    <div>
      <div className="pdd-sites-bar">
        <span className="muted">Radius</span>
        {(data?.radii_km ?? [1, 2, 3, 5, 10]).map((k) => (
          <button key={k} type="button" className={`pdd-pill${radius === k ? ' on' : ''}`} onClick={() => setRadius(k)}>{k} km</button>
        ))}
        <span className="muted">{isFetching ? 'Loading…' : `${data?.sites.length ?? 0} sites within ${radius} km`}</span>
        <input className="pdd-filter" placeholder="Filter list…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {error && <p className="error">{apiErrorMessage(error)}</p>}
      <div className="pdd-sites">
        <div className="pdd-sites-map">
          <MapContainer center={[r.lat, r.lng]} zoom={15} style={{ height: '100%', width: '100%' }}>
            <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <FitPoints points={[[r.lat, r.lng], ...sites.map((s) => [s.lat, s.lng] as [number, number])]} />
            <Circle center={[r.lat, r.lng]} radius={radius * 1000} pathOptions={{ color: '#2563eb', weight: 1, fillOpacity: 0.04 }} />
            <CircleMarker center={[r.lat, r.lng]} radius={8} pathOptions={{ color: '#fff', weight: 2, fillColor: '#dc2626', fillOpacity: 1 }}>
              <Tooltip>Problem location</Tooltip>
            </CircleMarker>
            {sites.map((s) => (
              <CircleMarker key={s.site_id} center={[s.lat, s.lng]} radius={s.serving || picked === s.site_id ? 8 : 6}
                eventHandlers={{ click: () => setPicked(s.site_id) }}
                pathOptions={{ color: s.serving ? '#16a34a' : picked === s.site_id ? '#111827' : '#ffffff', weight: 2,
                  fillColor: TECH_COLOR[s.techs[s.techs.length - 1]] ?? '#64748b', fillOpacity: 0.95 }}>
                <Tooltip permanent={sites.length <= 25} direction="right" className="pdd-site-label">{s.site_id}</Tooltip>
              </CircleMarker>
            ))}
          </MapContainer>
        </div>
        <div className="pdd-sites-list">
          {sites.map((s) => (
            <button key={s.site_id} type="button" className={`pdd-site${picked === s.site_id ? ' on' : ''}`} onClick={() => setPicked(s.site_id)}>
              <div className="pdd-site-top">
                <b><Link to={`/sites/${s.site_id}`} onClick={(e) => e.stopPropagation()}>{s.site_id}</Link></b>
                {s.site_id === nearest && <span className="pdd-chip pdd-chip-blue">Nearest</span>}
                {s.serving && <span className="pdd-chip pdd-chip-green">Served the report</span>}
                <span className="pdd-dist">{s.distance_m < 1000 ? `${s.distance_m} m` : `${(s.distance_m / 1000).toFixed(2)} km`}</span>
              </div>
              <div className="muted pdd-small">{s.name ?? ''}{s.district ? ` · ${s.district}` : ''} · {s.bearing_deg}° from the spot</div>
              <div className="pdd-techs">
                {s.techs.map((t) => <span key={t} style={{ borderColor: TECH_COLOR[t], color: TECH_COLOR[t] }}>{t}</span>)}
                <span className="muted pdd-small">{s.sectors} sectors{s.status ? ` · ${s.status}` : ''}</span>
              </div>
            </button>
          ))}
          {!sites.length && !isFetching && <p className="muted">No site within {radius} km.</p>}
        </div>
      </div>
    </div>
  )
}

// Updates to the linked system that sent the report (2026-10-15).
const MODE_TEXT: Record<string, string> = {
  auto: 'sent automatically when the status or likely cause changes',
  manual: 'sent only when you press "Send update"',
  off: 'switched off',
}
const NOTE_STATUS: Record<string, string> = { pending: 'waiting', sent: 'sent', failed: 'failed' }

function SystemUpdates({ id, n }: { id: number; n: NonNullable<ProblemReport['notify']> }) {
  const send = useNotifyProblemReport()
  const canSend = n.has_address && n.mode !== 'off'
  return (
    <>
      <h3>Updates to {n.system}</h3>
      <p className="muted">
        {!n.linked
          ? 'This system has no address for updates yet; a superadmin can add one under API Access, Linked systems.'
          : !n.has_address
            ? 'Updates are paused or have no address.'
            : `Updates are ${MODE_TEXT[n.mode ?? 'off']}.`}{' '}
        It can also ask for the status at any time.
      </p>
      {n.recent.length > 0 && (
        <ul className="pd-updates">
          {n.recent.map((u) => (
            <li key={u.id}>
              {when(u.created_at)} · {u.event} · {NOTE_STATUS[u.status]}
              {u.status === 'sent' && u.sent_at ? ` ${when(u.sent_at)}` : ''}
              {u.last_error ? ` · ${u.last_error}` : ''}
            </li>
          ))}
        </ul>
      )}
      {canSend && (
        <div className="problem-actions">
          <button type="button" className="btn-secondary btn-small" disabled={send.isPending} onClick={() => send.mutate(id)}>
            {send.isPending ? 'Sending…' : `Send update to ${n.system}`}
          </button>
          {send.data && <span className="muted">{send.data.status === 'sent' ? 'Delivered.' : `Not delivered yet: ${send.data.last_error}`}</span>}
        </div>
      )}
      {send.error && <p className="error">{apiErrorMessage(send.error)}</p>}
    </>
  )
}

function areaText(a: { readings: number; share_4g_pct: number | null; rsrp_4g_mean: number | null; rsrq_4g_mean: number | null }) {
  if (!a.readings) return 'None'
  return `${a.readings} readings, ${fmt(a.share_4g_pct, '%')} on 4G; 4G ${fmt(a.rsrp_4g_mean, ' dBm')}` +
    (a.rsrq_4g_mean != null ? `, RSRQ ${a.rsrq_4g_mean} dB` : '') + ' average'
}

function EnterComplaint({ onSaved }: { onSaved: (id: number) => void }) {
  const create = useCreateProblemReport()
  const [category, setCategory] = useState<ProblemCategory>('slow_data')
  const [note, setNote] = useState('')
  const [msisdn, setMsisdn] = useState('')
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null)
  const [time, setTime] = useState(() => {
    const d = new Date()
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
    return d.toISOString().slice(0, 16)
  })

  const save = () => {
    if (!point) return
    create.mutate(
      { category, note, lat: point.lat, lng: point.lng, happened_at: new Date(time).toISOString(), msisdn: msisdn.trim() || undefined },
      { onSuccess: (r: ProblemReport) => onSaved(r.id) },
    )
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Enter a complaint</h2>
      <p className="muted">
        Click the map where the customer has the problem. Put the customer's mobile number in its own box (shown to
        superadmin only, and it links the complaint to the Subscriber Profile); keep names and numbers out of the note.
      </p>
      <div className="problem-form">
        <label>
          Problem{' '}
          <select value={category} onChange={(e) => setCategory(e.target.value as ProblemCategory)}>
            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        <label>
          When <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <label>
          Customer's mobile <input type="tel" value={msisdn} onChange={(e) => setMsisdn(e.target.value)} placeholder="98XXXXXXXX (optional)" maxLength={20} />
        </label>
      </div>
      <textarea rows={2} style={{ width: '100%' }} placeholder="What the customer said" value={note}
        onChange={(e) => setNote(e.target.value)} maxLength={500} />
      <div className="problem-map">
        <MapContainer center={NEPAL_CENTER} zoom={7} style={{ height: '100%', width: '100%' }}>
          <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <ClickToPick onPick={(lat, lng) => setPoint({ lat, lng })} />
          {point && (
            <>
              <Circle center={[point.lat, point.lng]} radius={500} pathOptions={{ color: '#2563eb', weight: 1, fillOpacity: 0.06 }} />
              <CircleMarker center={[point.lat, point.lng]} radius={7} pathOptions={{ color: '#dc2626', fillColor: '#dc2626', fillOpacity: 0.9 }} />
            </>
          )}
        </MapContainer>
      </div>
      <div className="problem-actions">
        <button type="button" className="btn-primary btn-small" disabled={!point || create.isPending} onClick={save}>
          {create.isPending ? 'Checking…' : 'Save and check'}
        </button>
        {!point && <span className="muted">Pick the place on the map first.</span>}
      </div>
      {create.error && <p className="error">{apiErrorMessage(create.error)}</p>}
    </div>
  )
}
