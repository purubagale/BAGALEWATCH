import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { DtSessionDetail } from '../api/types'
import { bandColor, type Band, type TaggedMetric } from '../lib/dtBands'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'
import { useDtMetrics } from '../lib/useDtMetrics'

const DEFAULT_CENTER: [number, number] = [28.3949, 84.124]
const DEFAULT_ZOOM = 7

// Per-session label only now (2026-08-05, 2nd revision same day) — kept
// as text/tooltip identification and to color session names in the list
// above the grid, but NO LONGER drives any dot styling on the map
// itself. See this file's main doc comment for why: a colored outline
// ring around a 3-4px dot barely shows any of the real fill color at
// normal zoom (screenshot review after the first grid version showed
// every dot reading as a flat solid hue, not the graduated band colors
// the legend/counts implied), so dots now render EXACTLY like
// DtExploreTab's NearSamplesLayer — solid fill, no stroke, colored only
// by the metric's real band value — per explicit user request: "do not
// use plain dot outline. plot its actual plot value with color in index
// as we display in explore."
export const SESSION_HUES = ['#2563eb', '#dc2626', '#9333ea', '#ea580c']
export const COMPARE_LABELS = ['S1', 'S2', 'S3', 'S4']
export const MAX_COMPARE = 4

function CompareDots({ sessions, metric }: { sessions: DtSessionDetail[]; metric: TaggedMetric }) {
  const map = useMap()

  useEffect(() => {
    const layer = L.layerGroup()
    sessions.forEach((s, si) => {
      if (s.tech !== metric.tech) return
      for (const sample of s.samples) {
        if (sample.lat == null || sample.lng == null) continue
        const v = sample[metric.key] as number | null
        if (v == null) continue
        const color = bandColor(metric.bands, v)
        // Same styling as DtExploreTab's NearSamplesLayer — weight: 0 (no
        // outline stroke at all), fillColor is the only color shown, so
        // the dot always reads as its real band color regardless of
        // which session it came from. Session identity is still in the
        // tooltip on hover.
        L.circleMarker([sample.lat, sample.lng], {
          radius: 3,
          color,
          fillColor: color,
          fillOpacity: 0.85,
          weight: 0,
        })
          .bindTooltip(`${COMPARE_LABELS[si]} ${s.name} — ${metric.label}: ${v}${metric.unit}`)
          .addTo(layer)
      }
    })
    layer.addTo(map)
    return () => {
      map.removeLayer(layer)
    }
  }, [map, sessions, metric])

  return null
}

function InvalidateOnResize() {
  useMapInvalidateOnResize()
  return null
}

// Fits each panel to only the sessions that actually have data for THAT
// panel's metric — unlike a single shared map, a per-metric panel has no
// reason to leave empty space framed for a tech that isn't even plotted
// in it.
function FitToMetricSessions({ sessions, metric }: { sessions: DtSessionDetail[]; metric: TaggedMetric }) {
  const map = useMap()

  useEffect(() => {
    const pts = sessions
      .filter((s) => s.tech === metric.tech)
      .flatMap((s) => s.samples.filter((r) => r.lat != null && r.lng != null).map((r) => [r.lat as number, r.lng as number] as [number, number]))
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [16, 16] })
  }, [map, sessions, metric])

  return null
}

// Per-band point counts for one metric's panel — same information v1's
// own reference legend shows inline next to each swatch (e.g. "[Min,
// -105)  (147)"), so the legend doubles as the stats display instead of
// a separate table. Counts every sample across whichever sessions this
// panel is showing (i.e. the ones matching this metric's tech) combined
// — dots no longer carry a per-session color, so there's no per-session
// breakdown to show here; hovering a dot's tooltip still says which
// session it came from, and the "Sessions" list above the grid says
// which session(s) contributed to a given panel via its tech.
function bandCounts(sessions: DtSessionDetail[], metric: TaggedMetric): Map<string, number> {
  const counts = new Map<string, number>(metric.bands.map((b) => [b.label, 0]))
  for (const s of sessions) {
    if (s.tech !== metric.tech) continue
    for (const sample of s.samples) {
      const v = sample[metric.key] as number | null
      if (v == null) continue
      for (const b of metric.bands) {
        if (v >= b.min && v < b.max) {
          counts.set(b.label, (counts.get(b.label) ?? 0) + 1)
          break
        }
      }
    }
  }
  return counts
}

// Blank/white "plots only" panel (2026-08-05, 3rd revision) — per
// explicit user request: "if tick is selected display all view panel in
// blank white view pane only with the plots and index as i have
// uploaded earlier" (referring to the same v1 reference screenshot that
// drove the original multi-panel grid layout). No basemap tiles, no
// Leaflet instance at all — just each sample plotted as a dot inside a
// plain SVG, positioned by normalizing its lat/lng into the panel's own
// bounding box (min/max of whatever points are actually being shown),
// colored exactly the same way (`bandColor`) as the real-map version.
// This deliberately does NOT try to preserve true geographic aspect
// ratio/scale — it's a relative scatter of "where these points sit
// relative to each other," matching what the uploaded reference showed
// (no basemap, no scale bar), not a substitute for the real map.
//
// **2026-08-07 memory-audit finding, capped — then REVERTED same day per
// explicit follow-up.** A `pointLimit` (shared RowLimitSelect control)
// was added here to cap rendered points after the audit flagged
// uncapped SVG rendering as a Medium risk. User then reported this
// broke their actual comparison workflow ("do not limit to 500, i was
// confused earlier, need full plot there") — a blank/plots-only panel
// is a single cheap SVG with no Leaflet instance or tile requests behind
// it, unlike the real-map mode's per-panel `MapContainer`, so the
// audit's unbounded-DOM-node concern doesn't carry the same weight here.
// Reverted to always plotting every real sample. If this panel type
// becomes a genuine performance problem at higher point counts, prefer
// canvas-based rendering (like the Scatter Plot page) over silently
// dropping points again.
function ScatterPanelPlot({ sessions, metric }: { sessions: DtSessionDetail[]; metric: TaggedMetric }) {
  const points = useMemo(() => {
    const pts: { lat: number; lng: number; color: string; tooltip: string }[] = []
    sessions.forEach((s, si) => {
      if (s.tech !== metric.tech) return
      for (const sample of s.samples) {
        if (sample.lat == null || sample.lng == null) continue
        const v = sample[metric.key] as number | null
        if (v == null) continue
        pts.push({
          lat: sample.lat,
          lng: sample.lng,
          color: bandColor(metric.bands, v),
          tooltip: `${COMPARE_LABELS[si]} ${s.name} — ${metric.label}: ${v}${metric.unit}`,
        })
      }
    })
    return pts
  }, [sessions, metric])

  if (!points.length) {
    return (
      <div className="dt-compare-panel-map dt-compare-panel-blank dt-compare-panel-blank-empty">
        <span className="muted">No data</span>
      </div>
    )
  }

  const lats = points.map((p) => p.lat)
  const lngs = points.map((p) => p.lng)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  const latSpan = maxLat - minLat || 0.001
  const lngSpan = maxLng - minLng || 0.001
  const W = 300
  const H = 220
  const PAD = 14

  return (
    <svg
      className="dt-compare-panel-map dt-compare-panel-blank"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {points.map((p, i) => {
        const x = PAD + ((p.lng - minLng) / lngSpan) * (W - 2 * PAD)
        const y = H - PAD - ((p.lat - minLat) / latSpan) * (H - 2 * PAD)
        return (
          <circle key={i} cx={x} cy={y} r={2.5} fill={p.color}>
            <title>{p.tooltip}</title>
          </circle>
        )
      })}
    </svg>
  )
}

// Per-panel real-map loading (2026-08-07, 5th revision) — previously,
// unchecking "Blank view" instantiated a real Leaflet `MapContainer` (own
// tile requests + a `CompareDots` layer) in EVERY visible panel
// simultaneously; with several sessions split apart this could mean 6+
// live Leaflet instances rendering at once, which is a plausible
// contributor to reported browser memory pressure during Compare
// Sessions. Per explicit request ("allow click in each individual panel
// to load map in panels not for all at once"), every panel now starts as
// the cheap blank SVG scatter and only mounts its own real `MapContainer`
// when its own button is clicked — never all of them together. Clicking
// again switches back to the blank plot, which unmounts (and properly
// disposes, via react-leaflet) that panel's Leaflet instance.
// **6th resize attempt, 2026-08-07 — dropped native CSS `resize` entirely
// in favor of a hand-rolled drag handle.** Every prior attempt (grid `fr`
// tracks not reflowing, `max-width: 100%` leaving no room to grow,
// `flex-grow: 1` doing the same thing under a different name) got fixed,
// yet the user still hit a wall: horizontal drag would work up to some
// point and then only vertical growth continued. Root cause: this page's
// `.app-main` (the whole app's scrollable content area, wraps every
// route) is `overflow: auto`. Browsers do NOT auto-scroll a scrollable
// ancestor while an interactive native `resize` drag is in progress —
// once a panel's right edge reaches the current edge of `.app-main`'s
// visible scroll viewport, further mouse movement to the right has
// nothing to grab onto (the resize handle itself has effectively
// scrolled out of reach), so it looks exactly like resize "stopped
// working" past that width, while vertical growth kept extending the
// page's natural scroll height without hitting the same wall.
// This is a real, documented platform limitation of native `resize`, not
// something fixable with more CSS. The fix: compute the resize ourselves
// with `window`-level `mousemove`/`mouseup` listeners — the exact same
// pattern this app already uses for the sidebar and DT session-history
// divider (`onHistoryResizeMouseDown` in DtDataManagerPage.tsx). Mouse
// coordinates from `window` events aren't bound to any element's visible
// scroll viewport, so dragging keeps working correctly no matter how far
// past `.app-main`'s current scroll position the user drags — exactly
// "expand up to wherever it's dragged, in both directions."
function MetricPanel({
  sessions,
  metric,
  title,
}: {
  sessions: DtSessionDetail[]
  metric: TaggedMetric
  title: string
}) {
  const [showMap, setShowMap] = useState(false)
  const counts = useMemo(() => bandCounts(sessions, metric), [sessions, metric])
  const panelRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; startWidth: number; startHeight: number } | null>(null)

  function onResizeMouseDown(e: ReactMouseEvent) {
    e.preventDefault()
    // Measure the panel's own CURRENT rendered size (whatever the CSS
    // flex-basis/auto-height produced, or whatever a previous drag left
    // it at) rather than assuming a fixed starting number — this is what
    // lets the very first drag feel seamless instead of jumping to some
    // guessed default size.
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = { startX: e.clientX, startY: e.clientY, startWidth: rect.width, startHeight: rect.height }
    window.addEventListener('mousemove', onResizeMouseMove)
    window.addEventListener('mouseup', onResizeMouseUp)
  }
  function onResizeMouseMove(e: MouseEvent) {
    if (!dragRef.current) return
    const { startX, startY, startWidth, startHeight } = dragRef.current
    setSize({
      width: Math.max(280, startWidth + (e.clientX - startX)),
      height: Math.max(220, startHeight + (e.clientY - startY)),
    })
  }
  function onResizeMouseUp() {
    dragRef.current = null
    window.removeEventListener('mousemove', onResizeMouseMove)
    window.removeEventListener('mouseup', onResizeMouseUp)
  }

  return (
    <div
      className="dt-compare-panel"
      ref={panelRef}
      // Only overridden once the user actually drags — before that, the
      // CSS class's `flex: 0 0 360px` + natural content height apply, so
      // nothing looks different until this panel's own handle is used.
      style={size ? { flex: `0 0 ${size.width}px`, width: size.width, height: size.height } : undefined}
    >
      <div className="dt-compare-panel-title-row">
        <div className="dt-compare-panel-title">{title}</div>
        <button
          type="button"
          className="dt-compare-panel-maptoggle"
          onClick={() => setShowMap((v) => !v)}
          title={showMap ? 'Switch back to the plot-only view' : 'Load a real map for this panel'}
        >
          {showMap ? '📊 Plot' : '🗺️ Map'}
        </button>
      </div>
      {/* `.dt-compare-panel-resizable` is just a flex child filling
          whatever space the panel's own drag handle (below) leaves for
          it — see this function's doc comment for the resize handle
          itself. `useMapInvalidateOnResize` (already wired into every
          real map via `InvalidateOnResize`) uses a ResizeObserver, so it
          doesn't care whether the resize came from a browser window
          resize or this drag handle — it just works. */}
      <div className="dt-compare-panel-resizable">
        {showMap ? (
          <MapContainer center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} className="dt-compare-panel-map">
            <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <FitToMetricSessions sessions={sessions} metric={metric} />
            <CompareDots sessions={sessions} metric={metric} />
            <InvalidateOnResize />
          </MapContainer>
        ) : (
          <ScatterPanelPlot sessions={sessions} metric={metric} />
        )}
      </div>
      <div className="dt-compare-panel-legend">
        {metric.bands.map((b: Band) => (
          <div key={b.label} className="dt-compare-panel-legend-row">
            <span className="dt-legend-dot" style={{ background: b.color }} />
            <span>
              {b.label}
              {metric.unit}
            </span>
            <span className="dt-compare-panel-legend-count">({counts.get(b.label) ?? 0})</span>
          </div>
        ))}
      </div>
      <div className="dt-compare-panel-resize-handle" onMouseDown={onResizeMouseDown} title="Drag to resize" />
    </div>
  )
}

/** Session comparison, originally ported from bts_monitor.html's
 * rsrpOpenCompare() (~8280-8344) — checkbox 2+ sessions → one overlaid
 * map, plus a stats table (avg/min/max/% poor).
 *
 * **Rewritten three times on 2026-08-05.** Pass 1 added DtExploreTab-
 * style metric tabs to a single shared map (per feedback: "display as
 * their types and data with selection option as used in other like
 * explore") — fixed the mislabeled-metric problem but still only showed
 * one metric at a time. Pass 2: user attached v1's own real multi-panel
 * small-multiples view (one map per metric, shown simultaneously, each
 * with its own inline per-band count legend) and asked for "multiple
 * view panel for selected sessions" — dropped the tab row for one
 * `<MetricPanel>` per DISTINCT metric tag present across the checked
 * sessions (comparing two 4G sessions shows 3 panels; a 4G + a 3G
 * session shows 5). Pass 3 (this one): pass 2 gave each dot a colored
 * OUTLINE for session identity plus a metric-band FILL — screenshot
 * review showed that at a 3-4px dot radius, a 2px stroke visually
 * dominates and every dot just read as a flat session hue, not the
 * graduated band colors the legend/counts implied. Per explicit user
 * request ("do not use plain dot outline. plot its actual plot value
 * with color in index as we display in explore"), dots now render
 * exactly like `DtExploreTab`'s `NearSamplesLayer` — solid fill, no
 * stroke, colored only by the real metric value. Session identity moved
 * entirely into the tooltip (hover a dot) and the plain session list
 * above the grid (still text-colored via `SESSION_HUES` for quick visual
 * grouping, but no longer implying anything about a dot's own styling).
 *
 * Capped at MAX_COMPARE=4 sessions; v1 didn't hard-enforce this (a 5th
 * session would silently reuse S1's identity via modulo), this caps
 * selection in the UI instead — a deliberate small improvement,
 * documented not silent.
 *
 * **4th revision, same day:** two independent view toggles were added —
 * "Show sessions separately" (one panel per metric+session instead of
 * one combined panel per metric across all sessions) and "Blank view
 * (plots only)" (plain SVG scatter instead of a real Leaflet map),
 * matching the v1 reference screenshot's look.
 *
 * **5th revision, 2026-08-07, per explicit follow-up feedback** ("load
 * directly all the session separately in blank view, do not limit to
 * 500... allow click in each individual panel to load map in panels not
 * for all at once. no need of average plot for now"). Both toggles are
 * gone: sessions are now ALWAYS split one-panel-per-session (the combined
 * "average" panel across sessions was explicitly declined as unneeded
 * for now — re-add `splitBySession` from the 4th-revision history above
 * if that's ever wanted back), and every panel ALWAYS starts as the
 * cheap blank SVG scatter with every real sample plotted, no point cap
 * (see `ScatterPanelPlot`'s docstring for why the earlier `pointLimit`
 * cap was reverted). The real Leaflet map is no longer a global toggle
 * that loads one `MapContainer` per panel simultaneously — each panel now
 * has its own "🗺️ Map" button (see `MetricPanel`) that loads a live map
 * for just that panel on click, so viewing N sessions' worth of real maps
 * costs whatever the user actually clicks, not N-times-metrics upfront. */
export default function DtCompareMap({ sessions }: { sessions: DtSessionDetail[] }) {
  const { allMetrics } = useDtMetrics()
  const presentTechs = useMemo(() => new Set(sessions.map((s) => s.tech)), [sessions])
  const visibleMetrics = useMemo(() => allMetrics.filter((m) => presentTechs.has(m.tech)), [allMetrics, presentTechs])

  // Always one panel per (metric, session) — still filtered through the
  // same `sessions` array MetricPanel/CompareDots already expect (they
  // internally skip any session whose tech !== metric.tech), just
  // narrowed to a single-element array so nothing else overlaps it.
  const panels = useMemo(
    () =>
      visibleMetrics.flatMap((m) =>
        sessions
          .filter((s) => s.tech === m.tech)
          .map((s, si) => ({
            key: `${m.tag}-${s.id}`,
            metric: m,
            sessions: [s],
            title: `${COMPARE_LABELS[sessions.indexOf(s)] ?? `S${si + 1}`} ${s.name} — ${m.label}${m.unit ? ` (${m.unit.trim()})` : ''}`,
          })),
      ),
    [visibleMetrics, sessions],
  )

  return (
    <div className="dt-compare-grid-wrap">
      <div className="dt-legend" style={{ marginBottom: 10 }}>
        <span style={{ fontSize: 10, color: '#6b7280', alignSelf: 'center', marginRight: 2 }}>Sessions:</span>
        {sessions.map((s, si) => (
          <span key={s.id} className="dt-legend-item" style={{ color: SESSION_HUES[si % SESSION_HUES.length] }}>
            {COMPARE_LABELS[si]}: {s.name} ({s.tech})
          </span>
        ))}
      </div>
      <div className="dt-compare-grid">
        {panels.map((p) => (
          <MetricPanel key={p.key} sessions={p.sessions} metric={p.metric} title={p.title} />
        ))}
      </div>
    </div>
  )
}
