import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import CurrentLocationMarker from './CurrentLocationMarker'
import SitePhotoLayer from './SitePhotoLayer'
import TelemetryNearLayer from './TelemetryNearLayer'
import ExploreListBox from './ExploreListBox'
import type { Terrain3DData } from './SiteTerrain3D'
import { destinationPoint } from '../lib/sectorWedge'

// 3D terrain view of the search (2026-10-28): the site page's 3D map, loaded only when asked for.
const Terrain3D = lazy(() => import('./SiteTerrain3D'))
import { useAuth } from '../auth/AuthContext'
import { apiErrorMessage } from '../api/client'
import { useDtRecent, useDtServingCellsForSessions, useDtSessionsNear, useSites, useTelemetrySessionsNear } from '../api/queries'
import type { DtRecentEntry, DtRecentSquare, DtSample, DtServingCell, DtSessionDetail, DtTech, SiteListItem, TelemetryNearPoint } from '../api/types'
import { techOf, telemetryMetricValue } from '../lib/telemetryLevel'
import { purposeLabel } from '../lib/dtPurpose'
import { ACTIVITY_ROLE_LABELS } from './AttachActivityModal'
import { clusterDtSessionsByArea, type DtSessionCluster } from '../lib/dtSessionClustering'
import { ALL_TECHS, bandCategoryColor, bandColor, PCI_DISTINCT_COLORS, pciColorMap, pciMod3Color, subsampleForMap, weakestPerSquare, type TaggedMetric } from '../lib/dtBands'
import { declusterForPlot } from '../lib/declusterPlot'
import { useDtMetrics } from '../lib/useDtMetrics'
import { haversineKm } from '../lib/dtTemplateParser'
import { pointInPolygon, polygonAverageCenter, polygonBoundingRadiusKm, type LatLng } from '../lib/geo'
import { NEPAL_DISTRICT_BOUNDARIES } from '../lib/nepalDistrictBoundaries'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'
import { useDtExploreState } from '../contexts/DtExploreStateContext'

// Sentinel metricTag value for the PCI Plot tab (2026-09-23) — never a
// real TaggedMetric.tag (those are always "<Label>:<Tech>", e.g.
// "RSRP:4G"), so it can share the same metricTag state/tab-bar as the
// real metrics without colliding, while still being handled as a special
// case wherever it actually changes behavior (see the PCI_TAG checks
// below).
const PCI_TAG = 'PCI'
// Band Distribution tab (2026-09-23) — same sentinel-tag pattern as
// PCI_TAG above, see its own comment.
const BAND_TAG = 'Band'
// Caps the PCI Plot's/Band Distribution's legend swatch count — see
// distinctPcis'/distinctBands' own comments.
const PCI_LEGEND_CAP = 24

const DEFAULT_CENTER: [number, number] = [28.3949, 84.124]
const DEFAULT_ZOOM = 7
const SATELLITE_URL = 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'
const STREET_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'

/** Phase 4d — Explore-by-coordinate, ported from bts_monitor.html's RSRP
 * Manager "By Coordinates" pane (`rsrpCoordSearch`/`renderCoordCoverageMap`,
 * ~6648-7062, plus `_pointInPolygon`/`_convexHull` at ~15497-15538). The
 * search box resolves four input kinds exactly like v1's does — raw
 * coordinates, a Site ID/name, a city name, or a district name.
 *
 * **District boundaries — added 2026-07-29 after a real bug report**: a
 * first pass here always resolved the search POINT as an average of every
 * matching site's coordinates, even for district names that span a huge,
 * irregularly-shaped area — searching "Kathmandu" (a wide, non-convex
 * district) landed the point near Bajrabarahi, well south of the actual
 * city, because a scattered point cloud's centroid isn't a meaningful
 * "center" for an irregular shape. Fixed by porting v1's real
 * `NEPAL_DISTRICT_BOUNDARIES` (31 of Nepal's 77 districts have one — see
 * lib/nepalDistrictBoundaries.ts) and using each polygon's own vertex
 * average as the resolved point, with the search AREA becoming the real
 * polygon (point-in-polygon membership) instead of a radius circle. For
 * district/city names without real boundary data, falls back to v1's
 * other real fallback: a convex hull of the matching sites' own
 * coordinates (still real data, never fabricated) — a plain radius
 * circle is the last resort, only for raw coordinates and Site ID/name
 * lookups (which v1 also always circles, never hulls/polygons).
 *
 * DT session filtering for a polygon/hull shape reuses the existing
 * `/dt-sessions/near/` radius endpoint rather than adding a second
 * backend endpoint: the request radius is sized to the shape's own
 * bounding radius (`polygonBoundingRadiusKm`, a guaranteed covering
 * superset), then the returned samples are trimmed precisely client-side
 * with `pointInPolygon`. */
// DMS component, e.g. "26°33'40.7"N" -> 26.561306. Accepts a straight or
// curly apostrophe/quote (copy-pasted DMS text, e.g. from Google Maps'
// "Plus code"/coordinate popup, isn't guaranteed to use straight ASCII
// quotes) and either upper- or lower-case hemisphere letter.
const DMS_PAIR_RE =
  /(\d{1,3}(?:\.\d+)?)\s*[°d]\s*(\d{1,2}(?:\.\d+)?)\s*['’m]\s*(\d{1,2}(?:\.\d+)?)\s*(?:["”″]|s)?\s*([NSns])[,\s]+(\d{1,3}(?:\.\d+)?)\s*[°d]\s*(\d{1,2}(?:\.\d+)?)\s*['’m]\s*(\d{1,2}(?:\.\d+)?)\s*(?:["”″]|s)?\s*([EWew])/

function dmsToDecimal(deg: string, min: string, sec: string, hemi: string): number {
  const value = parseFloat(deg) + parseFloat(min) / 60 + parseFloat(sec) / 3600
  return /[SW]/i.test(hemi) ? -value : value
}

// Real bug, found 2026-08-05: a user pasted a DMS coordinate
// (26°33'40.7"N 87°16'44.7"E) into this same search box and got a
// noticeably different location than pasting its exact decimal
// equivalent (26.561306, 87.279083) — both represent the identical
// physical point, confirmed by hand (26 + 33/60 + 40.7/3600 =
// 26.561306...). Root cause: the plain decimal-pair parser below splits
// on whitespace/commas then runs `parseFloat` on each token. `parseFloat`
// stops at the first non-numeric character, so `parseFloat("26°33'40.7"N")`
// silently returns just `26` (truncated at "°") instead of failing —
// same for the longitude token, silently truncating to `87`. The search
// "succeeded" with no error, just landed ~65km away at (26, 87) instead
// of the real point. Fixed by trying a real DMS parser FIRST (before the
// truncation-prone plain-decimal path ever gets a chance to silently
// mis-parse a DMS string as if it were a bare number).
function parseLatLngDms(text: string): { lat: number; lng: number } | null {
  const m = text.trim().match(DMS_PAIR_RE)
  if (!m) return null
  const lat = dmsToDecimal(m[1], m[2], m[3], m[4])
  const lng = dmsToDecimal(m[5], m[6], m[7], m[8])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

function parseLatLng(text: string): { lat: number; lng: number } | null {
  const trimmed = text.trim()
  const dms = parseLatLngDms(trimmed)
  if (dms) return dms
  const parts = trimmed.split(/[,\s]+/).filter(Boolean)
  if (parts.length !== 2) return null
  const lat = parseFloat(parts[0])
  const lng = parseFloat(parts[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

type SearchShape = { type: 'circle' } | { type: 'polygon'; points: LatLng[]; name: string }

interface ResolvedPoint {
  lat: number
  lng: number
  label: string
  shape: SearchShape
}

// Site ID/name lookup — mirrors v1's _resolveSiteIdQuery() match order
// exactly (exact id, exact name, id prefix, then loosest substring).
// Always a circle, matching v1's kind==='site' behavior.
// `loose=false` only matches an exact Site ID/name or an ID prefix —
// unambiguous, safe to let win over everything else. `loose=true` adds the
// substring fallback (site ID/name merely CONTAINS the query) — this tier
// is intentionally NOT tried until after a real district-boundary match
// has had its chance (see resolveQuery below): a site literally named
// "KTM422-Lalitpur_Ward_No_3_Micro" contains "lalitpur" as a substring, so
// without this split, searching "lalitpur" (meaning the district) would
// resolve to that one site's 2km circle instead of the real Lalitpur
// district boundary — exactly the bug the user reported 2026-07-30.
function resolveSiteQuery(text: string, sites: SiteListItem[], loose: boolean): ResolvedPoint | null {
  const q = text.trim().toLowerCase()
  if (!q) return null
  const withCoords = (s: SiteListItem) => s.lat != null && s.lng != null
  const candidates = sites.filter(withCoords)
  const site =
    candidates.find((s) => (s.id || '').toLowerCase() === q) ??
    candidates.find((s) => (s.name || '').toLowerCase() === q) ??
    candidates.find((s) => (s.id || '').toLowerCase().startsWith(q)) ??
    (loose ? candidates.find((s) => (s.id || '').toLowerCase().includes(q) || (s.name || '').toLowerCase().includes(q)) : undefined)
  if (!site) return null
  return { lat: site.lat as number, lng: site.lng as number, label: `${site.name || site.id} (${site.id})`, shape: { type: 'circle' } }
}

function findBoundaryKey(q: string): string | null {
  const keys = Object.keys(NEPAL_DISTRICT_BOUNDARIES)
  const exact = keys.find((k) => k.toLowerCase() === q)
  if (exact) return exact
  return keys.find((k) => k.toLowerCase().includes(q) || q.includes(k.toLowerCase())) ?? null
}

// Real district-boundary lookup only (no site fallback here — see
// resolveQuery for where this sits relative to site-name matching).
function resolveBoundaryQuery(text: string): ResolvedPoint | null {
  const q = text.trim().toLowerCase()
  if (!q) return null
  const boundaryKey = findBoundaryKey(q)
  if (!boundaryKey) return null
  const poly = NEPAL_DISTRICT_BOUNDARIES[boundaryKey]
  const [lat, lng] = polygonAverageCenter(poly)
  return { lat, lng, label: `${boundaryKey} District`, shape: { type: 'polygon', points: poly, name: boundaryKey } }
}

// City/district name lookup via the sites list (site-centroid + plain
// radius circle) — the last-resort tier, tried only once neither a real
// boundary polygon nor any site ID/name match (strict or loose) has
// resolved the query.
//
// This used to have a middle tier — a convex hull of the matching sites —
// for districts without real boundary data. Removed 2026-07-30 per
// explicit user request ("if not possible then only apply the radius
// one"): the hull was real data (never fabricated), but it wasn't what
// v1 did, and a plain circle is simpler and has one fewer geometry code
// path that can misbehave.
function resolveCityDistrictQuery(text: string, sites: SiteListItem[]): ResolvedPoint | null {
  const q = text.trim().toLowerCase()
  if (!q) return null
  const withCoords = (s: SiteListItem) => s.lat != null && s.lng != null
  for (const field of ['city', 'district'] as const) {
    let matches = sites.filter((s) => withCoords(s) && (s[field] || '').toLowerCase().trim() === q)
    if (!matches.length) matches = sites.filter((s) => withCoords(s) && (s[field] || '').toLowerCase().includes(q))
    if (matches.length) {
      const lat = matches.reduce((a, s) => a + (s.lat as number), 0) / matches.length
      const lng = matches.reduce((a, s) => a + (s.lng as number), 0) / matches.length
      const noun = field === 'city' ? matches[0].city : matches[0].district
      const label = `${noun} (${matches.length} site${matches.length > 1 ? 's' : ''})`
      return { lat, lng, label, shape: { type: 'circle' } }
    }
  }
  return null
}

// Resolution order, most to least confident:
//  1. Raw coordinates
//  2. Exact Site ID/name match, or an ID prefix — unambiguous
//  3. Real district-boundary name match
//  4. Loose Site ID/name substring match
//  5. City/district substring match against the sites list
// Steps 3 and 4 are deliberately in this order, not the reverse: a real
// boundary polygon is high-confidence real data and should win over a
// site whose name merely happens to contain the searched word (e.g.
// "lalitpur" should resolve to the Lalitpur DISTRICT, not incidentally to
// a site literally named "KTM422-Lalitpur_Ward_No_3_Micro").
function resolveQuery(text: string, sites: SiteListItem[]): ResolvedPoint | null {
  const coord = parseLatLng(text)
  if (coord) return { ...coord, label: `${coord.lat.toFixed(5)}, ${coord.lng.toFixed(5)}`, shape: { type: 'circle' } }
  return (
    resolveSiteQuery(text, sites, false) ??
    resolveBoundaryQuery(text) ??
    resolveSiteQuery(text, sites, true) ??
    resolveCityDistrictQuery(text, sites)
  )
}

// Fullscreen toggling resizes this map's container (420px → 100vh and
// back) without Leaflet ever being told — same root cause class as the
// earlier black-tile bug (a stale internal size cache), just triggered
// by the Fullscreen API instead of a tab-panel reveal. `invalidateSize()`
// after the browser finishes the resize (a rAF, not a fixed delay —
// fullscreenchange fires right as the transition starts, not after
// layout settles) fixes it; re-centering afterward keeps the same area
// visible instead of leaving it wherever a 420px-tall viewport happened
// to be scrolled to.
function InvalidateOnResize() {
  useMapInvalidateOnResize()
  return null
}

function FullscreenSync({ isFullscreen, bounds }: { isFullscreen: boolean; bounds: L.LatLngBounds | null }) {
  const map = useMap()

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      map.invalidateSize()
      // try/catch: fitBounds can throw on a degenerate/edge-case box (e.g.
      // near-zero area); that must not take down the whole map — worst
      // case is just skipping the re-center, not a blank page.
      try {
        if (bounds) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 })
      } catch {
        // ignore — invalidateSize() above already fixed the actual black-area bug
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [map, isFullscreen, bounds])

  return null
}

// Explore's detail when zoomed in (2026-10-14): a wide search arrives as
// 50 m squares; once the map shows at most DETAIL_MAX_KM across, every
// reading in view is loaded and drawn there instead of the squares.
const DETAIL_MAX_KM = 4

interface ViewBox { s: number; w: number; n: number; e: number }

// Zooms to a site picked in the Nearby sites list (2026-10-28); `n` changes
// on every pick, so picking the same site again flies there again.
function FlyToSite({ target }: { target: { lat: number; lng: number; n: number } | null }) {
  const map = useMap()
  useEffect(() => {
    if (target) map.flyTo([target.lat, target.lng], Math.max(map.getZoom(), 16), { duration: 0.6 })
  }, [map, target])
  return null
}

function ViewWatcher({ onView }: { onView: (box: ViewBox) => void }) {
  const map = useMapEvents({
    moveend: () => {
      const b = map.getBounds()
      onView({ s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() })
    },
  })
  return null
}

// Recent and Change views (2026-10-14): one dot per 50 m square, from the
// sessions' squares. Recent = the most recent value measured there (faded
// when older than RECENT_FADE_MONTHS); Change = latest minus the one before.
type ExploreView = 'sessions' | 'recent' | 'change'
const RECENT_FADE_MONTHS = 24
// A change smaller than this is drawn grey ("about the same").
const CHANGE_STEP: Record<string, number> = { rsrp: 3, rsrq: 2, sinr: 2, cqi: 1, dl: 2, ecno: 2, rx_qual: 1 }

function monthsAgo(isoDate: string) {
  const d = new Date(isoDate)
  const now = new Date()
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth())
}

// Phone readings in the Recent and Change views (2026-10-28): the same
// 50 m squares, built here from the phone points of the ticked telemetry
// sessions. Per square and technology, the average of each measure per
// session; the newest session there is "latest", the one before "previous".
const SQUARE_M = 50

function phoneRecentSquares(points: TelemetryNearPoint[], metricKeys: { tech: DtTech; key: string }[], lat0: number): DtRecentSquare[] {
  const dLat = SQUARE_M / 111320
  const dLng = SQUARE_M / (111320 * Math.cos((lat0 * Math.PI) / 180))
  type Acc = { last: string; n: number; sums: Record<string, [number, number]> }
  const cells = new Map<string, { tech: DtTech; i: number; j: number; bySession: Map<string, Acc> }>()
  for (const p of points) {
    const tech = techOf(p.network_type)
    if (!tech) continue
    const i = Math.floor(p.lat / dLat)
    const j = Math.floor(p.lng / dLng)
    const k = `${tech}|${i}|${j}`
    let cell = cells.get(k)
    if (!cell) cells.set(k, (cell = { tech, i, j, bySession: new Map() }))
    let acc = cell.bySession.get(p.session)
    if (!acc) cell.bySession.set(p.session, (acc = { last: p.ts, n: 0, sums: {} }))
    acc.n += 1
    if (p.ts > acc.last) acc.last = p.ts
    for (const m of metricKeys) {
      if (m.tech !== tech) continue
      const v = telemetryMetricValue(p, tech, m.key)
      if (v == null) continue
      const s = acc.sums[m.key] ?? (acc.sums[m.key] = [0, 0])
      s[0] += v
      s[1] += 1
    }
  }
  const entry = (session: string, a: Acc): DtRecentEntry => {
    const avg = (key: string) => (a.sums[key] ? Math.round((a.sums[key][0] / a.sums[key][1]) * 10) / 10 : null)
    return {
      session_id: session, date: a.last.slice(0, 10), purpose: null, n: a.n, rsrp_min: null,
      rsrp: avg('rsrp'), rsrq: avg('rsrq'), sinr: avg('sinr'), dl: null, cqi: avg('cqi'),
      rscp: avg('rscp'), ecno: avg('ecno'), rx_qual: avg('rx_qual'),
    }
  }
  const out: DtRecentSquare[] = []
  for (const cell of cells.values()) {
    const ranked = [...cell.bySession].sort((a, b) => b[1].last.localeCompare(a[1].last))
    out.push({
      tech: cell.tech, lat: (cell.i + 0.5) * dLat, lng: (cell.j + 0.5) * dLng,
      latest: entry(ranked[0][0], ranked[0][1]),
      previous: ranked[1] ? entry(ranked[1][0], ranked[1][1]) : null,
    })
  }
  return out
}

/** Colour of one Recent / Change square on the chosen measure, or null when
 * it is not drawn (another technology, no value, nothing to compare with). */
function recentSquareStyle(sq: DtRecentSquare, metric: TaggedMetric, view: Exclude<ExploreView, 'sessions'>) {
  if (sq.tech !== metric.tech) return null
  const key = metric.key as keyof DtRecentEntry
  const latest = sq.latest[key] as number | null
  if (latest == null) return null
  if (view === 'recent') {
    return { color: bandColor(metric.bands, latest), opacity: monthsAgo(sq.latest.date) > RECENT_FADE_MONTHS ? 0.3 : 0.85, change: null }
  }
  const before = sq.previous ? (sq.previous[key] as number | null) : null
  if (before == null) return null
  const change = Math.round((latest - before) * 10) / 10
  const better = metric.key === 'rx_qual' ? -change : change
  const step = CHANGE_STEP[metric.key] ?? 2
  return { color: better >= step ? '#16a34a' : better <= -step ? '#dc2626' : '#9ca3af', opacity: 0.85, change }
}

function RecentSquaresLayer({
  squares, metric, view, names, ring = false,
}: {
  squares: DtRecentSquare[]
  metric: TaggedMetric
  view: Exclude<ExploreView, 'sessions'>
  names: Record<string, string>
  // Phone squares carry a white ring, like the phone dots in the Sessions view.
  ring?: boolean
}) {
  const map = useMap()
  useEffect(() => {
    const layer = L.layerGroup()
    const key = metric.key as keyof DtRecentEntry
    const fmt = (e: DtRecentEntry) => {
      const v = e[key] as number | null
      return `${e.date} · ${e.purpose ? purposeLabel(e.purpose) : 'Phone readings'} · ${names[String(e.session_id)] ?? 'Session ' + e.session_id}<br>` +
        `${metric.label}: ${v == null ? '—' : v + metric.unit} (average of ${e.n} readings)`
    }
    for (const sq of squares) {
      const st = recentSquareStyle(sq, metric, view)
      if (!st) continue
      const { color, opacity } = st
      let text = `<b>Latest</b> ${fmt(sq.latest)}`
      if (sq.previous) text += `<br><b>Before</b> ${fmt(sq.previous)}`
      if (st.change != null) text += `<br><b>Change</b> ${st.change > 0 ? '+' : ''}${st.change}${metric.unit}`
      L.circleMarker([sq.lat, sq.lng], ring
        ? { radius: 5, color: '#ffffff', weight: 1.5, opacity, fillColor: color, fillOpacity: opacity }
        : { radius: 4, color, fillColor: color, fillOpacity: opacity, weight: 0 })
        .bindTooltip(text, { sticky: true, direction: 'top', offset: [0, -4] })
        .addTo(layer)
    }
    layer.addTo(map)
    return () => {
      map.removeLayer(layer)
    }
  }, [map, squares, metric, view, names, ring])
  return null
}

function toggled<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

function inBox(box: ViewBox, r: DtSample) {
  return r.lat != null && r.lng != null && r.lat >= box.s && r.lat <= box.n && r.lng >= box.w && r.lng <= box.e
}

function SearchAreaLayer({ point, radiusKm, shape, label }: { point: LatLng; radiusKm: number; shape: SearchShape; label: string }) {
  const map = useMap()

  useEffect(() => {
    const marker = L.circleMarker(point, {
      radius: 7,
      color: '#7f77dd',
      fillColor: '#7f77dd',
      fillOpacity: 1,
      weight: 2,
    }).bindTooltip(`<b>${label}</b><br>Search point`, { sticky: true, direction: 'top', offset: [0, -4] })
    let areaLayer: L.Layer
    if (shape.type === 'polygon') {
      areaLayer = L.polygon(shape.points, { color: '#7f77dd', weight: 2, fillOpacity: 0.06 })
    } else {
      areaLayer = L.circle(point, { radius: radiusKm * 1000, color: '#7f77dd', weight: 1, fillOpacity: 0.05 })
    }
    // Add to the map BEFORE computing bounds — this was the actual crash,
    // not a fullscreen/sizing issue. Polygon.getBounds() is pure lat/lng
    // math (no map needed), so it happened to work even called before
    // addTo(); but Circle.getBounds() projects the circle's pixel radius
    // via `this._map.layerPointToLatLng(...)`, and `this._map` is only set
    // once Leaflet's onAdd() runs — i.e. after addTo(). Calling it first
    // threw "Cannot read properties of undefined (reading
    // 'layerPointToLatLng')", an uncaught error that took the whole map
    // down. Any plain-circle search (raw coordinates, or a city/district
    // name with no real boundary polygon) hit this every time; a real
    // boundary polygon search (e.g. "Kathmandu") never did, which is why
    // it looked district-specific.
    const layer = L.layerGroup([marker, areaLayer]).addTo(map)
    const bounds = areaLayer instanceof L.Polygon ? areaLayer.getBounds() : (areaLayer as L.Circle).getBounds()
    try {
      map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 })
    } catch {
      // still guarded — belt and suspenders, not the actual fix above
    }
    return () => {
      map.removeLayer(layer)
    }
  }, [map, point, radiusKm, shape, label])

  return null
}

// `onSelect` added 2026-08-05 per explicit request: "if site is selected
// then allow to view site detail also" — clicking a site marker here now
// opens the same `.site-quickview` card (with an "Open site detail →"
// link into SiteDetailPage) that clicking a marker on the Sites Topology
// map already shows, just without the Delete button — Explore is a
// read-only lookup view, it doesn't own site CRUD.
function NearSitesLayer({ sites, onSelect }: { sites: { s: SiteListItem; d: number }[]; onSelect: (s: SiteListItem) => void }) {
  const map = useMap()

  useEffect(() => {
    const layer = L.layerGroup()
    for (const { s, d } of sites) {
      if (s.lat == null || s.lng == null) continue
      L.circleMarker([s.lat, s.lng], {
        radius: 5,
        color: '#e6e9ef',
        fillColor: '#1e2330',
        fillOpacity: 1,
        weight: 2,
      })
        .bindTooltip(`<b>${s.name || s.id}</b><br>${s.id}${s.district ? ` — ${s.district}` : ''}<br>${d.toFixed(2)} km from search point`, {
          sticky: true,
          direction: 'top',
          offset: [0, -4],
        })
        .on('click', () => onSelect(s))
        .addTo(layer)
    }
    layer.addTo(map)
    return () => {
      map.removeLayer(layer)
    }
  }, [map, sites, onSelect])

  return null
}

// 2026-08-15 memory audit: same unbounded-circleMarker shape as
// DtCoverageMap.tsx/DtCompareMap.tsx had — the backend `near()` endpoint
// (drive_test.py) has no row cap of its own, only a radius bound (max
// 50km), so a wide-radius search that happens to sweep across a long
// `.trp`-derived session's route can still return a very large sample
// set. Same subsampleForMap() treatment as the other two map components.
//
// Hover/click serving-site connector (2026-09-04, "we have talked
// previously about the plot and serving site connector at hover and
// click in explore... it is missing till now") — ported from
// DtCoverageMap.tsx's CoverageDots, which already has this for the
// single-session coverage map. Same `linkLayer`/`pinned`/`showLink`/
// `clearLink` shape: hovering a dot draws a dashed line + highlighted
// marker to its serving site (cleared on mouseout unless pinned);
// clicking pins it and opens a popup with the cell detail, same as
// Coverage; clicking anywhere else on the map (`map.on('click', ...)`)
// unpins it. `servingCells` is the merged serving-cell list for every
// session currently plotted (see useDtServingCellsForSessions) — Explore
// can show several sessions at once, unlike Coverage's single session,
// so `cellBySite` here is built across all of them. Same simplification
// CoverageDots already has: keyed by site_id alone, so a site served by
// more than one distinct cell across the plotted sessions only ever
// shows the last one encountered — acceptable for a "which site was
// this near" connector, not a precise per-cell diagram.
function NearSamplesLayer({
  sessions, metric, servingCells,
}: {
  sessions: DtSessionDetail[]
  metric: TaggedMetric
  servingCells: DtServingCell[]
}) {
  const map = useMap()

  useEffect(() => {
    const layer = L.layerGroup()
    const linkLayer = L.layerGroup().addTo(map)
    let pinned = false

    const cellBySite = new Map(servingCells.map((c) => [c.site_id, c]))

    function clearLink() {
      linkLayer.clearLayers()
      map.closePopup()
      pinned = false
    }
    // fromLat/fromLng (2026-10-07) -- the DRAWN position (post-decluster),
    // same reasoning as DtCoverageMap.tsx's own showLink() fix.
    function showLink(
      session: DtSessionDetail, sample: DtSample, openPopup: boolean, fromLat: number, fromLng: number,
    ) {
      const cell = sample.serving_site_id ? cellBySite.get(sample.serving_site_id) : undefined
      if (!cell || cell.site_lat == null || cell.site_lng == null) return
      linkLayer.clearLayers()
      L.polyline(
        [
          [fromLat, fromLng],
          [cell.site_lat, cell.site_lng],
        ],
        { color: '#1d4ed8', weight: 2, dashArray: '5,4', opacity: 0.9 },
      ).addTo(linkLayer)
      L.circleMarker([cell.site_lat, cell.site_lng], {
        radius: 7,
        color: '#1d4ed8',
        weight: 2,
        fillColor: '#ffffff',
        fillOpacity: 1,
      })
        .bindTooltip(cell.site_name, { direction: 'top' })
        .addTo(linkLayer)
      if (openPopup) {
        const parts = [
          `${session.name} (${session.tech})`,
          `PCI ${sample.pci ?? '—'}`,
          cell.cell_name || cell.site_name,
          cell.sector ? `Sector ${cell.sector}` : null,
          sample.serving_dist_km != null ? `${sample.serving_dist_km.toFixed(2)} km` : null,
          cell.azimuth != null ? `Az ${cell.azimuth}°` : null,
        ].filter(Boolean)
        L.popup({ offset: [0, -4] })
          .setLatLng([fromLat, fromLng])
          .setContent(`<b>${cell.site_name}</b><br>${parts.join(' · ')}`)
          .openOn(map)
        pinned = true
      }
    }

    // Overlap management (2026-10-07, "manage plot with worst and best
    // data with no overlapping ... manage this in all telemetry sessions")
    // -- see lib/declusterPlot.ts's own header and DtCoverageMap.tsx's
    // CoverageDots for the same treatment on a single session. `sessions`
    // here can span several sessions at once (Explore's own "near" search
    // across everything plotted) -- each session's own index prefixes the
    // site key so two different sessions sharing a coordinate never
    // collapse into one pair.
    const higherIsBetter = metric.key !== 'rx_qual'
    sessions.forEach((session, si) => {
      if (session.tech !== metric.tech) return
      const withVal = session.samples.filter((sample) => sample.lat != null && sample.lng != null && sample[metric.key] != null)
      // Weakest reading per small square, not every Nth (audit 2026-10-23).
      const drawn = weakestPerSquare(
        withVal,
        (sample) => [sample.lat as number, sample.lng as number],
        (sample) => {
          const raw = sample[metric.key] as number
          return higherIsBetter ? raw : -raw
        },
      ).kept.map((k) => k.item)
      const points = declusterForPlot(drawn, (sample) => {
        const raw = sample[metric.key] as number | null
        return {
          lat: sample.lat as number,
          lng: sample.lng as number,
          siteKey: `${si}|${sample.serving_site_id ?? ''}|${sample.serving_sector ?? ''}`,
          score: raw == null ? null : higherIsBetter ? raw : -raw,
        }
      })
      for (const p of points) {
        const sample = p.item
        const v = sample[metric.key] as number
        const color = bandColor(metric.bands, v)
        const roleText = (p.collapsedCount > 1 ? ` (${p.role} of ${p.collapsedCount} here)` : '') +
          (sample.square_n ? `<br>Weakest of ${sample.square_n} readings in this square` : '')
        const dot = L.circleMarker([p.lat, p.lng], {
          radius: 3,
          color,
          fillColor: color,
          fillOpacity: 0.85,
          weight: 0,
        })
          .bindTooltip(
            `<b>${session.name}</b> (${session.tech})<br>${sample.ts || sample.date || ''}<br>${metric.label}: ${v}${metric.unit}${roleText}` +
              (sample.serving_site_name ? `<br>${sample.serving_site_name}` : ''),
            { sticky: true, direction: 'top', offset: [0, -4] },
          )
        if (sample.serving_site_id && cellBySite.has(sample.serving_site_id)) {
          dot.on('mouseover', () => {
            if (!pinned) showLink(session, sample, false, p.lat, p.lng)
          })
          dot.on('mouseout', () => {
            if (!pinned) linkLayer.clearLayers()
          })
          dot.on('click', (e) => {
            L.DomEvent.stopPropagation(e)
            showLink(session, sample, true, p.lat, p.lng)
          })
        }
        dot.addTo(layer)
      }
    })
    layer.addTo(map)
    map.on('click', clearLink)

    return () => {
      map.off('click', clearLink)
      map.removeLayer(layer)
      map.removeLayer(linkLayer)
    }
  }, [map, sessions, metric, servingCells])

  return null
}

// PCI Plot (2026-09-23, "PCI Plot (PS DL-Best server)") — a leaner sibling
// of NearSamplesLayer above: colors each 4G sample by its serving cell's
// PCI (pciColor(), a fixed categorical hash — see that function's own
// docstring for why this is deliberately NOT a TaggedMetric/bandColor()
// threshold table) instead of a graded signal reading. 4G-only — PCI is
// this app's own established 4G-specific cell identity (dtBands.ts's
// signalLabel()/metricsForTech() already treat 3G/2G's own identities,
// Scrambling Code and BCCH+BSIC, as separate concepts, never as "PCI").
// Deliberately skips NearSamplesLayer's hover/click "show link to serving
// site" interactivity — a real but separate enhancement, not needed to
// answer "which cell served this spot."
// 2026-10-14: colours come from `colorOf` (per-search ranking or PCI mod 3,
// see pciColorMap()/pciMod3Color()), and `isolated` fades every other PCI
// so one cell's footprint stands out even when its colour repeats.
function PciSamplesLayer({ sessions, colorOf, isolated }: {
  sessions: DtSessionDetail[]
  colorOf: (pci: number) => string
  isolated: number | null
}) {
  const map = useMap()

  useEffect(() => {
    const layer = L.layerGroup()
    const front: L.CircleMarker[] = []
    sessions.forEach((session, si) => {
      if (session.tech !== '4G') return
      const withVal = session.samples.filter((sample) => sample.lat != null && sample.lng != null && sample.pci != null)
      const drawn = subsampleForMap(withVal)
      // Overlap management (2026-10-07) -- PCI is a cell IDENTITY, not a
      // graded reading (see pciColor()'s own docstring), so there is no
      // "worst/best" here the way there is for a signal metric; the site
      // key is the PCI value itself (so two different PCIs sharing a
      // coordinate still get separated) and every member of a group scores
      // equally, so which two get kept is arbitrary -- only the "stop
      // stacking duplicates invisibly" half of declusterForPlot applies.
      const points = declusterForPlot(drawn, (sample) => ({
        lat: sample.lat as number,
        lng: sample.lng as number,
        siteKey: `${si}|${sample.pci}`,
        score: 0,
      }))
      for (const p of points) {
        const sample = p.item
        const pci = sample.pci as number
        const faded = isolated !== null && pci !== isolated
        const color = faded ? '#9ca3af' : colorOf(pci)
        const roleText = p.collapsedCount > 1 ? ` (2 of ${p.collapsedCount} overlapping fixes shown)` : ''
        const marker = L.circleMarker([p.lat, p.lng], {
          radius: isolated !== null && !faded ? 4 : 3,
          color,
          fillColor: color,
          fillOpacity: faded ? 0.15 : 0.85,
          weight: 0,
        }).bindTooltip(
          `<b>${session.name}</b> (4G)<br>${sample.ts || sample.date || ''}<br>PCI: ${pci} (mod 3 = ${pci % 3})${roleText}` +
            (sample.serving_site_name ? `<br>${sample.serving_site_name}` : ''),
          { sticky: true, direction: 'top', offset: [0, -4] },
        )
        // The isolated PCI is added last so it paints over the faded rest.
        if (isolated !== null && !faded) front.push(marker)
        else marker.addTo(layer)
      }
    })
    for (const marker of front) marker.addTo(layer)
    layer.addTo(map)
    return () => {
      map.removeLayer(layer)
    }
  }, [map, sessions, colorOf, isolated])

  return null
}

// PCI labels (2026-10-14): when the map is 2 km across or less, the PCI
// number is written at the start of each run of readings on one PCI, so no
// colour lookup is needed. Redrawn on every pan or zoom, for the readings in
// view only, at most PCI_LABEL_CAP labels.
const PCI_LABEL_MAX_WIDTH_M = 2000
const PCI_LABEL_CAP = 150
// Readings this far apart start a new run even on the same PCI.
const PCI_RUN_GAP_M = 150

function PciLabelsLayer({ sessions, isolated }: { sessions: DtSessionDetail[]; isolated: number | null }) {
  const map = useMap()

  useEffect(() => {
    const layer = L.layerGroup().addTo(map)
    const draw = () => {
      layer.clearLayers()
      const bounds = map.getBounds()
      const widthM = map.distance(bounds.getSouthWest(), bounds.getSouthEast())
      if (widthM > PCI_LABEL_MAX_WIDTH_M) return
      let count = 0
      for (const session of sessions) {
        if (session.tech !== '4G') continue
        let prevPci: number | null = null
        let prev: L.LatLng | null = null
        for (const sample of session.samples) {
          if (sample.lat == null || sample.lng == null || sample.pci == null) continue
          const here = L.latLng(sample.lat, sample.lng)
          const newRun = sample.pci !== prevPci || prev === null || map.distance(prev, here) > PCI_RUN_GAP_M
          prevPci = sample.pci
          prev = here
          if (!newRun || !bounds.contains(here)) continue
          if (isolated !== null && sample.pci !== isolated) continue
          L.marker(here, {
            interactive: false,
            icon: L.divIcon({ className: 'dt-pci-label', html: String(sample.pci), iconSize: undefined }),
          }).addTo(layer)
          if (++count >= PCI_LABEL_CAP) return
        }
      }
    }
    draw()
    map.on('moveend', draw)
    return () => {
      map.off('moveend', draw)
      map.removeLayer(layer)
    }
  }, [map, sessions, isolated])

  return null
}

// Band Distribution (2026-09-23, "Band (Mode: ... Lock mode)") — mirrors
// PciSamplesLayer exactly, colored by bandCategoryColor(sample.band)
// instead of pciColor(sample.pci). 4G-only for the same reason PCI is:
// `band` is only ever populated by the .trp upload path's
// trpRowToDtSample() today (see DriveTestSample.band's own docstring),
// which only decodes it for 4G.
function BandSamplesLayer({ sessions }: { sessions: DtSessionDetail[] }) {
  const map = useMap()

  useEffect(() => {
    const layer = L.layerGroup()
    sessions.forEach((session, si) => {
      if (session.tech !== '4G') return
      const withVal = session.samples.filter((sample) => sample.lat != null && sample.lng != null && !!sample.band)
      const drawn = subsampleForMap(withVal)
      // Overlap management (2026-10-07) -- same reasoning as
      // PciSamplesLayer above: `band` is an identity, not a graded
      // reading, so the site key is the band value itself and there's no
      // real worst/best to pick between duplicates.
      const points = declusterForPlot(drawn, (sample) => ({
        lat: sample.lat as number,
        lng: sample.lng as number,
        siteKey: `${si}|${sample.band ?? ''}`,
        score: 0,
      }))
      for (const p of points) {
        const sample = p.item
        const color = bandCategoryColor(sample.band)
        const roleText = p.collapsedCount > 1 ? ` (2 of ${p.collapsedCount} overlapping fixes shown)` : ''
        L.circleMarker([p.lat, p.lng], {
          radius: 3,
          color,
          fillColor: color,
          fillOpacity: 0.85,
          weight: 0,
        })
          .bindTooltip(
            `<b>${session.name}</b> (4G)<br>${sample.ts || sample.date || ''}<br>Band: ${sample.band}${roleText}` +
              (sample.serving_site_name ? `<br>${sample.serving_site_name}` : ''),
            { sticky: true, direction: 'top', offset: [0, -4] },
          )
          .addTo(layer)
      }
    })
    layer.addTo(map)
    return () => {
      map.removeLayer(layer)
    }
  }, [map, sessions])

  return null
}

function csvEscape(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadTextFile(filename: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// Turns a search label ("Chitwan District", "27.71720, 85.32400") into a
// safe, meaningful filename fragment — replaces the old fixed
// `explore_<metric>` naming, which gave every export the same generic
// name regardless of what was actually searched.
function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'search'
}

// Approximates the search-area circle as a real polygon ring (36 points)
// for export purposes — a plain radius circle has no native "circle"
// primitive in either CSV rows or KML's <Polygon>, so this is the same
// kind of destination-point approximation already used elsewhere in this
// codebase for radius-based geometry (haversine-scale, not full geodesic
// — fine at Nepal's scale, same tradeoff as polygonBoundingRadiusKm).
function circleRing(center: LatLng, radiusKm: number, steps = 36): LatLng[] {
  const [lat, lng] = center
  const latRad = (lat * Math.PI) / 180
  const ring: LatLng[] = []
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * 2 * Math.PI
    const dLat = (radiusKm / 111) * Math.cos(theta)
    const dLng = (radiusKm / (111 * Math.max(Math.cos(latRad), 0.01))) * Math.sin(theta)
    ring.push([lat + dLat, lng + dLng])
  }
  return ring
}

// Exports the exact same three things the map shows for the current
// search — the search point/area, every nearby BTS site, and every DT
// sample for the selected metric — not just the DT samples on their own.
// A district with real sites but zero DT sessions (e.g. Chitwan) used to
// export an empty file with nothing to open, even though the map clearly
// shows 100+ real sites; this makes the export match what's on screen.
function exportCsv(
  sessions: DtSessionDetail[],
  metric: TaggedMetric,
  nearSites: { s: SiteListItem; d: number }[],
  point: { lat: number; lng: number },
  shape: SearchShape,
  radiusKm: number,
  label: string,
) {
  const rows: (string | number)[][] = [['Type', 'Name', 'Detail', 'Lat', 'Lng', 'Value', 'Extra']]
  rows.push(['Search Point', label, '', String(point.lat), String(point.lng), '', ''])
  const areaRing = shape.type === 'polygon' ? shape.points : circleRing([point.lat, point.lng], radiusKm)
  areaRing.forEach(([lat, lng], i) => rows.push(['Search Area', `${label} vertex ${i + 1}`, '', String(lat), String(lng), '', '']))
  for (const { s, d } of nearSites) {
    if (s.lat == null || s.lng == null) continue
    rows.push(['Site', s.name || s.id, s.id, String(s.lat), String(s.lng), '', `${d.toFixed(2)} km from search point`])
  }
  for (const s of sessions) {
    if (s.tech !== metric.tech) continue
    for (const sample of s.samples) {
      if (sample.lat == null || sample.lng == null) continue
      const v = sample[metric.key] as number | null
      // Skip samples with no value for the selected metric — same "no
      // data means no row" rule as the live map's NearSamplesLayer and
      // the KML export below, so CSV/KML/map all agree on what counts
      // as a real reading (2026-07-30).
      if (v == null) continue
      rows.push([
        'DT Sample',
        s.name,
        s.tech,
        String(sample.lat),
        String(sample.lng),
        String(v),
        `${sample.date || ''} ${sample.ts || ''} — ${sample.serving_site_name || ''}`.trim(),
      ])
    }
  }
  downloadTextFile(`explore_${slugify(label)}_${metric.tag.replace(/[:\s]/g, '_')}.csv`, 'text/csv', rows.map((r) => r.map(csvEscape).join(',')).join('\n'))
}

// Converts a #rrggbb hex color to KML's own "aabbggrr" hex color order
// (alpha, then blue/green/red — reversed from the usual #rrggbb) so the
// band colors already defined in dtBands.ts can be reused directly for
// KML <Style> fills instead of hand-maintaining a second color table.
function hexToKmlColor(hex: string, alpha = 'ff'): string {
  const clean = hex.replace('#', '')
  return `${alpha}${clean.slice(4, 6)}${clean.slice(2, 4)}${clean.slice(0, 2)}`
}

// 2026-07-30 rewrite. User attached v1's own real KML export
// (rsrp_search_KTM401_BishwamitraMarg_KTM401_.kml) as "previously working
// … should load exact same details on google earth" after the first pass
// of this export (samples as default Point placemarks, raw unrounded
// float values as the visible <name>) produced a Google Earth view
// cluttered with a wall of overlapping text labels like
// "2.09999990463257" and "No data" repeated for every null-metric
// sample. v1's real export never has this problem because it (a) never
// emits a placemark for a null-value sample at all, and (b) draws
// samples as small filled <Polygon> "dots" with a <Style> whose
// <LabelStyle><scale>0</scale></LabelStyle> suppresses the on-map text
// label entirely — <name> still exists for the info-window title when a
// dot is actually clicked, it's just not permanently drawn on the map.
// This rewrite matches that pattern instead of guessing at a fix a
// second time.
//
// 2026-08-24: LabelStyle scale reverted from 0 to a small nonzero value,
// per explicit user request. Reason: Google Earth has NO concept of a
// hover-triggered balloon — <description> only ever opens on click, by
// design of the app itself (confirmed against Google's own support docs,
// not fixable from the KML side). The user wanted something closer to a
// hover popup, and the closest KML can get is the short <name> (e.g.
// "Ec/Io: -6.4 dB") rendering as a permanent on-map label instead of only
// on click. This knowingly re-accepts the label-clutter tradeoff the
// 2026-07-30 fix above deliberately avoided — the mitigating factor is
// that <name> here is already short/rounded (unlike the original raw-float
// bug), so it reads more like a compact per-dot readout than a wall of
// digits, but a very dense route will still show many overlapping labels.
function exportKml(
  sessions: DtSessionDetail[],
  metric: TaggedMetric,
  nearSites: { s: SiteListItem; d: number }[],
  point: { lat: number; lng: number },
  shape: SearchShape,
  radiusKm: number,
  label: string,
) {
  const placemarks: string[] = []
  placemarks.push(
    `<Placemark><name>${label}</name><description>Search point</description>` +
      `<Point><coordinates>${point.lng},${point.lat},0</coordinates></Point></Placemark>`,
  )
  const areaRing = shape.type === 'polygon' ? shape.points : circleRing([point.lat, point.lng], radiusKm)
  const ringCoords = areaRing.map(([lat, lng]) => `${lng},${lat},0`).join(' ')
  placemarks.push(
    `<Placemark><name>${label} — search area</name>` +
      `<Style><LineStyle><color>ffdd777f</color><width>2</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>` +
      `<Polygon><outerBoundaryIs><LinearRing><coordinates>${ringCoords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`,
  )

  const sitePlacemarks: string[] = []
  for (const { s, d } of nearSites) {
    if (s.lat == null || s.lng == null) continue
    sitePlacemarks.push(
      `<Placemark><name>${s.name || s.id}</name><description>${s.id} — ${d.toFixed(2)} km from search point</description>` +
        `<Point><coordinates>${s.lng},${s.lat},0</coordinates></Point></Placemark>`,
    )
  }

  // One <Style> per distinct band color actually used (not one per
  // sample) — small, dedicated, matches v1's own KML's Style block.
  const styleIds = new Map<string, string>()
  function styleIdFor(color: string): string {
    const id = `c_${color.replace('#', '')}`
    if (!styleIds.has(color)) styleIds.set(color, id)
    return id
  }

  const samplePlacemarks: string[] = []
  for (const s of sessions) {
    if (s.tech !== metric.tech) continue
    for (const sample of s.samples) {
      if (sample.lat == null || sample.lng == null) continue
      const v = sample[metric.key] as number | null
      // Skip "no data" samples entirely, same rule as the live map's
      // NearSamplesLayer (2026-07-30) — no more "No data" placemark spam.
      if (v == null) continue
      const color = bandColor(metric.bands, v)
      const styleId = styleIdFor(color)
      // ~10m-radius octagon standing in for a "dot" — KML has no native
      // point-radius primitive, same destination-point approximation
      // circleRing already uses for the search-area circle, just much
      // smaller and with fewer sides (a route dot doesn't need to look
      // like a smooth circle at this scale).
      const dotRing = circleRing([sample.lat, sample.lng], 0.01, 8)
      const dotCoords = dotRing.map(([lat, lng]) => `${lng},${lat},0`).join(' ')
      const roundedV = Math.round(v * 10) / 10
      samplePlacemarks.push(
        `<Placemark><name>${metric.label}: ${roundedV}${metric.unit}</name><styleUrl>#${styleId}</styleUrl>` +
          `<description>${s.name} (${s.tech}) — ${sample.date || ''} ${sample.ts || ''}` +
          `${sample.serving_site_name ? ` — ${sample.serving_site_name}` : ''}</description>` +
          `<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${dotCoords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`,
      )
    }
  }

  const styleDefs = [...styleIds.entries()]
    .map(
      ([color, id]) =>
        `<Style id="${id}"><PolyStyle><color>${hexToKmlColor(color)}</color><fill>1</fill><outline>0</outline></PolyStyle>` +
        `<LineStyle><width>0</width></LineStyle><LabelStyle><scale>0.6</scale></LabelStyle></Style>`,
    )
    .join('')

  const kml =
    `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${label}</name>` +
    styleDefs +
    placemarks.join('') +
    (sitePlacemarks.length ? `<Folder><name>BTS Sites</name>${sitePlacemarks.join('')}</Folder>` : '') +
    (samplePlacemarks.length
      ? `<Folder><name>Drive Test Points (${metric.label})</name>${samplePlacemarks.join('')}</Folder>`
      : '') +
    `</Document></kml>`
  downloadTextFile(`explore_${slugify(label)}_${metric.tag.replace(/[:\s]/g, '_')}.kml`, 'application/vnd.google-earth.kml+xml', kml)
}

export default function DtExploreTab() {
  const navigate = useNavigate()
  // Search/selection state lives in Layout (see DtExploreStateContext's
  // own comment) so it survives navigating to a site's detail page and
  // back, instead of resetting every time this component unmounts.
  const {
    inputText, setInputText,
    radiusKm, setRadiusKm,
    techFilter, setTechFilter,
    point, setPoint,
    pointLabel, setPointLabel,
    shape, setShape,
    latestOnly, setLatestOnly,
    selectedSite, setSelectedSite,
    metricTag, setMetricTag,
    mapLayer, setMapLayer,
  } = useDtExploreState()
  const [error, setError] = useState<string | null>(null)
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set())
  const { allMetrics } = useDtMetrics()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const { data: sites } = useSites()
  const techs = useMemo(() => ALL_TECHS.filter((t) => techFilter.has(t)), [techFilter])

  // Stable [lat,lng] tuple for SearchAreaLayer's `point` prop. Passing
  // `[point.lat, point.lng]` inline in the JSX below creates a brand-new
  // array on every render of this component, and since that array sits in
  // SearchAreaLayer's effect dependency list, React treated it as changed
  // on every single render — tearing the marker/area layer down and
  // calling fitBounds() again each time, regardless of whether the actual
  // search changed. This is the real explanation for "first click slightly
  // moves the map" reported 2026-07-30: any re-render (for any reason)
  // re-triggered a fresh fitBounds().
  const pointTuple = useMemo<LatLng | null>(() => (point ? [point.lat, point.lng] : null), [point])

  // For a polygon/hull shape, query the backend with a covering radius
  // (guaranteed superset of the real shape), then trim precisely below —
  // see this file's doc comment for why this avoids a second endpoint.
  const backendRadiusKm = useMemo(() => {
    if (!point) return radiusKm
    return shape.type === 'polygon' ? polygonBoundingRadiusKm([point.lat, point.lng], shape.points) : radiusKm
  }, [point, radiusKm, shape])

  // The outline goes to the server too (2026-10-14), so it loads only the
  // readings inside the district, not the whole covering circle. At most
  // 150 corners; the server adds a margin for the corners left out, and the
  // exact outline still trims below.
  const outlineParam = useMemo(() => {
    if (shape.type !== 'polygon' || shape.points.length < 3) return ''
    const every = Math.ceil(shape.points.length / 150)
    return shape.points
      .filter((_, i) => i % every === 0)
      .map(([la, ln]) => `${la.toFixed(5)},${ln.toFixed(5)}`)
      .join(';')
  }, [shape])

  const { data: nearSessionsRaw, isLoading: sessionsLoading, error: sessionsError } = useDtSessionsNear(point, backendRadiusKm, techs, outlineParam)
  // A wide search arrives as squares (2026-10-14): the square size, 0 = every reading.
  const plotStepM = nearSessionsRaw?.[0]?.plot_step_m ?? 0

  // Sessions, Recent or Change view of the map (2026-10-14).
  const [exploreView, setExploreView] = useState<ExploreView>('sessions')
  // Sessions left off the map (2026-10-28): every session found is ticked
  // until the user unticks it in the lists below; a new search ticks all again.
  const [hiddenDt, setHiddenDt] = useState<Set<number>>(new Set())
  const [hiddenTel, setHiddenTel] = useState<Set<string>>(new Set())
  const [flyTarget, setFlyTarget] = useState<{ lat: number; lng: number; n: number } | null>(null)
  const [show3d, setShow3d] = useState(false)

  // Zoomed in on a search that arrived as squares: every reading in view.
  const [viewBox, setViewBox] = useState<ViewBox | null>(null)
  const detailBox = useMemo(() => {
    if (!plotStepM || !viewBox) return null
    const across = haversineKm(viewBox.s, viewBox.w, viewBox.n, viewBox.e)
    return across <= DETAIL_MAX_KM ? viewBox : null
  }, [plotStepM, viewBox])
  const detailCenter = useMemo(
    () => (detailBox ? { lat: (detailBox.s + detailBox.n) / 2, lng: (detailBox.w + detailBox.e) / 2 } : null),
    [detailBox],
  )
  const { data: detailRaw, isFetching: detailLoading } = useDtSessionsNear(
    detailCenter,
    detailBox ? haversineKm(detailBox.s, detailBox.w, detailBox.n, detailBox.e) / 2 + 0.05 : 0.1,
    techs,
    detailBox
      ? [[detailBox.s, detailBox.w], [detailBox.n, detailBox.w], [detailBox.n, detailBox.e], [detailBox.s, detailBox.e]]
        .map(([la, ln]) => `${la.toFixed(5)},${ln.toFixed(5)}`).join(';')
      : '',
  )
  // Used only when the server sent every reading for the view, not squares again.
  const detail = detailBox && detailRaw && detailRaw.every((s) => !s.plot_step_m) ? detailRaw : null

  // Telemetry sessions (2026-10-12): phone drives and Telemetry Drive Test
  // sessions are stored apart from uploaded drive tests, so this search
  // leaves them out unless the box is ticked. Off by default, and offered
  // to admins and superadmins only, like the pages those sessions live on.
  const { user } = useAuth()
  const canSeeTelemetry = !!user && (user.role === 'admin' || user.role === 'superadmin')
  const [includeTelemetry, setIncludeTelemetry] = useState(false)
  const telemetryNear = useTelemetrySessionsNear(point, backendRadiusKm, canSeeTelemetry && includeTelemetry, techs)
  const telemetryShown = canSeeTelemetry && includeTelemetry
  // A district boundary is searched with a covering circle, so trim the
  // points to the real shape, the same way the drive-test samples are.
  const telemetryPoints = useMemo(() => {
    const all = telemetryShown ? (telemetryNear.data?.points ?? []) : []
    return shape.type === 'polygon' ? all.filter((p) => pointInPolygon(p.lat, p.lng, shape.points)) : all
  }, [telemetryShown, telemetryNear.data, shape])
  const telemetrySessions = useMemo(() => {
    const all = telemetryShown ? (telemetryNear.data?.sessions ?? []) : []
    if (shape.type !== 'polygon') return all
    const kept = new Set(telemetryPoints.map((p) => p.session))
    return all.filter((s) => kept.has(s.key))
  }, [telemetryShown, telemetryNear.data, shape, telemetryPoints])
  const telemetryNames = useMemo(
    () => Object.fromEntries(telemetrySessions.map((s) => [s.key, s.name])),
    [telemetrySessions],
  )
  // Only the ticked telemetry sessions are drawn.
  const telemetryPlotted = useMemo(
    () => (hiddenTel.size ? telemetryPoints.filter((p) => !hiddenTel.has(p.session)) : telemetryPoints),
    [telemetryPoints, hiddenTel],
  )

  // Shared with FullscreenSync so re-fitting after a fullscreen resize
  // keeps the same search area visible, not wherever the pre-resize
  // viewport happened to be centered.
  //
  // For the circle case, this deliberately does NOT do
  // `L.circle(...).getBounds()` — that's the real bug that caused the
  // Lalitpur/black-screen crash in SearchAreaLayer (Circle.getBounds()
  // needs `this._map`, which is only set once the circle has actually
  // been added to a map via addTo(); this computation happens here with
  // no map at all). `LatLng.toBounds(sizeInMeters)` is the map-independent
  // equivalent — pure lat/lng math, exactly what's needed here.
  const currentBounds = useMemo(() => {
    if (!point) return null
    try {
      const b = shape.type === 'polygon' ? L.polygon(shape.points).getBounds() : L.latLng(point.lat, point.lng).toBounds(radiusKm * 1000 * 2)
      return b.isValid() ? b : null
    } catch {
      return null
    }
  }, [point, shape, radiusKm])

  const nearSessions = useMemo(() => {
    if (!nearSessionsRaw) return []
    let sessions = nearSessionsRaw
    if (detail && detailBox) {
      // Inside the view, the readings take the place of the squares.
      const readings = new Map(detail.map((s) => [s.id, s.samples.filter((r) => inBox(detailBox, r))]))
      sessions = sessions.map((s) => ({
        ...s,
        samples: [...s.samples.filter((r) => !inBox(detailBox, r)), ...(readings.get(s.id) ?? [])],
      }))
    }
    if (shape.type !== 'polygon') return sessions
    return sessions
      .map((s) => ({ ...s, samples: s.samples.filter((r) => r.lat != null && r.lng != null && pointInPolygon(r.lat as number, r.lng as number, shape.points)) }))
      .filter((s) => s.samples.length > 0)
  }, [nearSessionsRaw, shape, detail, detailBox])

  // Only the ticked drive tests are drawn (2026-10-28); the tabs and the
  // lists still count every session found.
  const plottedSessions = useMemo(
    () => (hiddenDt.size ? nearSessions.filter((s) => !hiddenDt.has(s.id)) : nearSessions),
    [nearSessions, hiddenDt],
  )
  const recentSessionIds = useMemo(
    () => (hiddenDt.size ? plottedSessions.map((s) => s.id) : null),
    [hiddenDt, plottedSessions],
  )
  const recent = useDtRecent(point, backendRadiusKm, techs, outlineParam, exploreView !== 'sessions', recentSessionIds)
  // Phone readings in Recent and Change, from the ticked telemetry sessions.
  const phoneSquares = useMemo(() => {
    if (exploreView === 'sessions' || !telemetryShown || !point || telemetryPlotted.length === 0) return []
    return phoneRecentSquares(telemetryPlotted, allMetrics.map((m) => ({ tech: m.tech, key: m.key })), point.lat)
  }, [exploreView, telemetryShown, point, telemetryPlotted, allMetrics])
  const phoneChangeSquares = useMemo(() => phoneSquares.filter((q) => q.previous).length, [phoneSquares])

  // "Latest per area" clustering over the currently-shown near-sessions
  // list (see the latestOnly state comment above). Grouped by the same
  // meta.nearby_site_ids union-find as History, computed here over just
  // this search's results rather than every saved session.
  const areaClusters = useMemo(() => clusterDtSessionsByArea(nearSessions, { sameTech: true }), [nearSessions])
  const areaClusterBySessionId = useMemo(() => {
    const map = new Map<number, DtSessionCluster<DtSessionDetail>>()
    for (const c of areaClusters) for (const s of c.sessions) map.set(s.id, c)
    return map
  }, [areaClusters])

  // Same "keep first-seen cluster's latest, everything else stays one
  // click away via its '+N earlier here' chip" logic as
  // DtSessionHistoryPage.tsx's visibleSessions -- see that page for the
  // full explanation. With latestOnly off this is just nearSessions
  // unchanged.
  const displaySessions = useMemo(() => {
    if (!latestOnly) return nearSessions
    const emitted = new Set<string>()
    const result: typeof nearSessions = []
    for (const s of nearSessions) {
      const cluster = areaClusterBySessionId.get(s.id)
      if (!cluster) {
        result.push(s)
        continue
      }
      if (emitted.has(cluster.key)) continue
      emitted.add(cluster.key)
      result.push(cluster.sessions[0])
      if (cluster.sessions.length > 1 && expandedClusters.has(cluster.key)) {
        result.push(...cluster.sessions.slice(1))
      }
    }
    return result
  }, [nearSessions, latestOnly, areaClusterBySessionId, expandedClusters])

  // Metric tabs track the tech filter above (RSRP/RSRQ/SINR only while 4G
  // is ticked, RSCP/Ec-Io only while 3G, RxLevel/RxQual only while 2G) —
  // AND are further narrowed to only techs that actually have a nearby
  // session in the current search area, per explicit user request: if the
  // area only has a 2G session, don't show 4G/3G tabs just because those
  // techs are ticked in the filter row. Falls back to the tech-filter-only
  // list while sessions are still loading or none exist yet, so the tab
  // bar isn't empty before a search has even resolved.
  // Telemetry readings count too (2026-10-14): with "Include telemetry
  // sessions" ticked, a technology seen only on phones still gets its tabs.
  const presentTechs = useMemo(() => {
    const set = new Set<DtTech>(nearSessions.map((s) => s.tech))
    for (const p of telemetryPoints) {
      const tech = techOf(p.network_type)
      if (tech) set.add(tech)
    }
    return set
  }, [nearSessions, telemetryPoints])
  // Only fall back to the full tech-filter list while the query is still
  // in flight (avoids a flash of zero tabs before results arrive). Once
  // it's actually resolved, an empty `presentTechs` (genuinely zero nearby
  // sessions, e.g. Chitwan) means zero tabs — no fallback to "show
  // everything" — per explicit user request: don't show tech tabs for
  // techs with no data in the current search area, full stop.
  // Further narrowed to metrics with actual DATA (2026-10-08, "if there is
  // no data then dont display plot for them"), same reasoning as the band-
  // data gate just below: a tech being present doesn't mean every one of
  // its metrics was ever measured (an Excel-imported session commonly has
  // no DL Throughput column at all) -- showing that tab selectable, mapping
  // to nothing, is worse than not showing it. Narrows only, never empties
  // the whole bar: if NO metric in a present tech has any data (a truly
  // degenerate session), byTech's own full list is still returned so the
  // tab bar isn't blank.
  const visibleMetrics = useMemo(() => {
    const byFilter = allMetrics.filter((m) => techFilter.has(m.tech))
    if (sessionsLoading) return byFilter
    const byTech = byFilter.filter((m) => presentTechs.has(m.tech))
    const withData = byTech.filter((m) =>
      nearSessions.some((s) => s.tech === m.tech && s.samples.some((sample) => sample[m.key] != null)) ||
      telemetryPoints.some((p) => telemetryMetricValue(p, m.tech, m.key) != null))
    return withData.length ? withData : byTech
  }, [allMetrics, techFilter, presentTechs, sessionsLoading, nearSessions, telemetryPoints])
  // PCI Plot tab (2026-09-23) — same tech-filter + presence gating as the
  // real metric tabs above, scoped to 4G (see PciSamplesLayer's docstring
  // for why). Kept out of visibleMetrics/TaggedMetric entirely (see
  // pciColor()'s own docstring) — this is a plain boolean gate on whether
  // the extra tab renders at all.
  const pciTabVisible = techFilter.has('4G') && (sessionsLoading || presentTechs.has('4G'))
  // Band Distribution tab visibility — gated on actual band DATA being
  // present (not just a 4G session existing), unlike PCI's presence check
  // above: `band` is a brand-new field (2026-09-23) only ever populated
  // for a freshly re-uploaded .trp session, so most existing 4G sessions
  // genuinely have none yet — showing an always-empty tab for those would
  // just be confusing rather than "not built yet."
  const hasBandData = useMemo(
    () => nearSessions.some((s) => s.tech === '4G' && s.samples.some((sample) => !!sample.band)),
    [nearSessions],
  )
  const bandTabVisible = techFilter.has('4G') && hasBandData
  useEffect(() => {
    if (metricTag === PCI_TAG) {
      if (!pciTabVisible && visibleMetrics.length) setMetricTag(visibleMetrics[0].tag)
      return
    }
    if (metricTag === BAND_TAG) {
      if (!bandTabVisible && visibleMetrics.length) setMetricTag(visibleMetrics[0].tag)
      return
    }
    if (visibleMetrics.length && !visibleMetrics.some((m) => m.tag === metricTag)) {
      setMetricTag(visibleMetrics[0].tag)
    }
  }, [visibleMetrics, metricTag, pciTabVisible, bandTabVisible])
  const isPciTab = metricTag === PCI_TAG
  const isBandTab = metricTag === BAND_TAG
  const metric = visibleMetrics.find((m) => m.tag === metricTag) ?? visibleMetrics[0] ?? allMetrics[0]

  // Distinct PCIs/Bands actually present, for the PCI Plot's/Band
  // Distribution's legend — capped so a route with many distinct served
  // cells/bands doesn't turn the legend into a wall of swatches; every dot
  // on the map still shows its exact value in its tooltip regardless of
  // this cap.
  // PCI legend and colours (2026-10-14): every PCI in the search with its
  // reading count, most readings first; the ranking also picks its colour
  // (pciColorMap()), so legend and map always agree. Not capped.
  const rankedPcis = useMemo(() => {
    if (!isPciTab) return [] as { pci: number; n: number }[]
    const counts = new Map<number, number>()
    for (const s of plottedSessions) {
      if (s.tech !== '4G') continue
      for (const sample of s.samples) {
        if (sample.pci != null && sample.lat != null && sample.lng != null) {
          counts.set(sample.pci, (counts.get(sample.pci) ?? 0) + 1)
        }
      }
    }
    // 4G phone readings with "Include telemetry sessions" ticked share the legend.
    for (const p of telemetryPlotted) {
      if (p.pci != null && techOf(p.network_type) === '4G') counts.set(p.pci, (counts.get(p.pci) ?? 0) + 1)
    }
    return [...counts].map(([pci, n]) => ({ pci, n })).sort((a, b) => b.n - a.n || a.pci - b.pci)
  }, [isPciTab, plottedSessions, telemetryPlotted])
  const [pciMode, setPciMode] = useState<'pci' | 'mod3'>('pci')
  const [isolatedPci, setIsolatedPci] = useState<number | null>(null)
  const [pciFind, setPciFind] = useState('')
  const pciColors = useMemo(() => pciColorMap(rankedPcis.map((r) => r.pci)), [rankedPcis])
  const pciColorOf = useCallback(
    (pci: number) => (pciMode === 'mod3' ? pciMod3Color(pci) : pciColors.get(pci) ?? '#94a3b8'),
    [pciMode, pciColors],
  )
  // Telemetry dots follow the selected tab (2026-10-14): the tab's measure on
  // its own technology, coloured on the same bands; PCI on the PCI tab (with
  // the same isolate); nothing on the Band tab, whose drive-test band names
  // the phone readings don't share.
  const telemetryColorOf = useCallback(
    (p: TelemetryNearPoint): string | null => {
      if (isBandTab) return null
      if (isPciTab) {
        if (p.pci == null || techOf(p.network_type) !== '4G') return null
        if (isolatedPci !== null && p.pci !== isolatedPci) return null
        return pciColorOf(p.pci)
      }
      const value = telemetryMetricValue(p, metric.tech, metric.key)
      return value == null ? null : bandColor(metric.bands, value)
    },
    [isBandTab, isPciTab, isolatedPci, pciColorOf, metric],
  )
  const mod3Counts = useMemo(() => {
    const out = [0, 0, 0]
    for (const r of rankedPcis) out[r.pci % 3] += r.n
    return out
  }, [rankedPcis])
  // An isolated PCI that is not in the current search (typed, or kept from
  // an earlier search) fades everything; the bar above the map says so and
  // offers Show all.
  const findPci = () => {
    const value = Number(pciFind.trim())
    if (pciFind.trim() === '' || !Number.isInteger(value)) {
      setIsolatedPci(null)
      return
    }
    setIsolatedPci(value)
  }
  const distinctBands = useMemo(() => {
    if (!isBandTab) return []
    const set = new Set<string>()
    for (const s of plottedSessions) {
      if (s.tech !== '4G') continue
      for (const sample of s.samples) if (sample.band) set.add(sample.band)
    }
    return [...set].sort().slice(0, PCI_LEGEND_CAP)
  }, [isBandTab, plottedSessions])


  // Serving-site hover/click connector (2026-09-04) — one /serving-cells/
  // fetch per session currently plotted (see useDtServingCellsForSessions'
  // own comment for why one-per-session rather than a single call), merged
  // into the flat list NearSamplesLayer needs. Fetches for every near
  // session regardless of the active tech tab, not just `metric.tech` —
  // small per-session payloads, and it means switching tech tabs never
  // re-fetches something already cached from a moment ago.
  const nearSessionIds = useMemo(() => plottedSessions.map((s) => s.id), [plottedSessions])
  const servingCellQueries = useDtServingCellsForSessions(nearSessionIds)
  // Not wrapped in useMemo: `servingCellQueries` is a fresh array every
  // render (useQueries' own contract), so memoizing on it would never
  // actually skip work — flattening a dozen small (~8-20 row) arrays is
  // cheap enough to just do plainly.
  const servingCells = servingCellQueries.flatMap((q) => q.data ?? [])

  const nearSites = useMemo(() => {
    if (!point || !sites) return []
    const withCoords = sites.filter((s) => s.lat != null && s.lng != null)
    if (shape.type === 'polygon') {
      return withCoords
        .filter((s) => pointInPolygon(s.lat as number, s.lng as number, shape.points))
        .map((s) => ({ s, d: haversineKm(point.lat, point.lng, s.lat as number, s.lng as number) }))
        .sort((a, b) => a.d - b.d)
    }
    return withCoords
      .map((s) => ({ s, d: haversineKm(point.lat, point.lng, s.lat as number, s.lng as number) }))
      .filter((o) => o.d <= radiusKm)
      .sort((a, b) => a.d - b.d)
  }, [point, sites, radiusKm, shape])

  // What the 3D view draws (2026-10-28): the same dots as the flat map for
  // the chosen view and tab, the search area and the sites in it.
  const terrainData = useMemo<Terrain3DData | null>(() => {
    if (!show3d || !point) return null
    const squares: Terrain3DData['squares'] = []
    const fmt = (v: number | null | undefined, unit = '') => (v == null ? '—' : `${v}${unit}`)
    if (exploreView === 'sessions') {
      for (const session of plottedSessions) {
        const usable = session.samples.filter((x) => x.lat != null && x.lng != null)
        if (isPciTab) {
          if (session.tech !== '4G') continue
          for (const x of subsampleForMap(usable.filter((y) => y.pci != null && (isolatedPci == null || y.pci === isolatedPci)))) {
            squares.push({ lat: x.lat as number, lng: x.lng as number, color: pciColorOf(x.pci as number), hollow: false, ring: false,
              label: `${session.name} · PCI ${x.pci}` })
          }
        } else if (isBandTab) {
          if (session.tech !== '4G') continue
          for (const x of subsampleForMap(usable.filter((y) => !!y.band))) {
            squares.push({ lat: x.lat as number, lng: x.lng as number, color: bandCategoryColor(x.band as string), hollow: false, ring: false,
              label: `${session.name} · band ${x.band}` })
          }
        } else {
          if (session.tech !== metric.tech) continue
          const higherIsBetter = metric.key !== 'rx_qual'
          const kept = weakestPerSquare(usable.filter((y) => y[metric.key] != null),
            (y) => [y.lat as number, y.lng as number],
            (y) => (higherIsBetter ? (y[metric.key] as number) : -(y[metric.key] as number))).kept
          for (const { item: x } of kept) {
            const v = x[metric.key] as number
            squares.push({ lat: x.lat as number, lng: x.lng as number, color: bandColor(metric.bands, v), hollow: false, ring: false,
              label: `${session.name} · ${metric.label} ${fmt(v, metric.unit)}` })
          }
        }
      }
      if (telemetryShown) {
        for (const p of telemetryPlotted) {
          const color = telemetryColorOf(p)
          if (color) squares.push({ lat: p.lat, lng: p.lng, color, hollow: false, ring: true, label: telemetryNames[p.session] ?? 'Phone reading' })
        }
      }
    } else if (!isPciTab && !isBandTab) {
      const add = (list: DtRecentSquare[], ring: boolean, names: Record<string, string>) => {
        for (const sq of list) {
          const st = recentSquareStyle(sq, metric, exploreView)
          if (!st) continue
          const who = names[String(sq.latest.session_id)] ?? (ring ? 'Phone readings' : `Session ${sq.latest.session_id}`)
          squares.push({ lat: sq.lat, lng: sq.lng, color: st.color, hollow: st.opacity < 0.5, ring,
            label: st.change != null ? `${who} · change ${st.change > 0 ? '+' : ''}${st.change}${metric.unit}` : `${who} · ${sq.latest.date}` })
        }
      }
      if (recent.data && recentSessionIds?.length !== 0) add(recent.data.squares, false, recent.data.sessions)
      add(phoneSquares, true, telemetryNames)
    }
    const area: [number, number][] = shape.type === 'polygon'
      ? shape.points
      : Array.from({ length: 64 }, (_, i) => destinationPoint(point.lat, point.lng, (360 * i) / 64, radiusKm * 1000))
    const sitePoints = nearSites.map(({ s, d }) => ({ lat: s.lat as number, lng: s.lng as number, color: '#1e2330',
      label: `${s.name || s.id} · ${d.toFixed(2)} km from the search point` }))
    return {
      sites: [{ lat: point.lat, lng: point.lng, color: '#7f77dd', size: 14, label: pointLabel }],
      wedges: [], lines: [], beams: [], segments: [], cells: [], labels: [], reach: [],
      squares, area, sitePoints, corners: area,
    }
  }, [show3d, point, exploreView, plottedSessions, isPciTab, isBandTab, isolatedPci, pciColorOf, metric, telemetryShown,
    telemetryPlotted, telemetryColorOf, telemetryNames, recent.data, recentSessionIds, phoneSquares, shape, radiusKm, nearSites, pointLabel])

  function handleSearch() {
    if (!inputText.trim()) {
      setError('Enter coordinates ("27.7172, 85.3240"), a city/district name, or a Site ID')
      return
    }
    const resolved = sites ? resolveQuery(inputText, sites) : null
    if (!resolved) {
      setError(`Could not find "${inputText}" — try coordinates, a city/district name, or a Site ID`)
      return
    }
    setError(null)
    setPointLabel(resolved.label)
    setShape(resolved.shape)
    setPoint({ lat: resolved.lat, lng: resolved.lng })
    setExpandedClusters(new Set())
    setHiddenDt(new Set())
    setHiddenTel(new Set())
    setSelectedSite(null)
  }

  // Expand/collapse one area cluster's older sessions (see the
  // "+N earlier here" chip in the Nearby Sessions list below) -- same
  // shape as DtSessionHistoryPage.tsx's toggleClusterExpanded.
  function toggleClusterExpanded(key: string) {
    setExpandedClusters((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleTech(t: DtTech) {
    setTechFilter((prev) => {
      const next = new Set(prev)
      if (next.has(t)) {
        if (next.size > 1) next.delete(t)
      } else {
        next.add(t)
      }
      return next
    })
  }

  function toggleFullscreen() {
    const el = wrapRef.current
    if (!el) return
    if (!document.fullscreenElement) {
      el.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
  }

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  return (
    <div className="dt-explore-tab">
      <div className="dt-explore-search-row">
        <input
          type="text"
          className="dt-explore-coord-input"
          placeholder="Lat, long / city / district / Site ID — e.g. 27.7172, 85.3240 or Kathmandu or KTM382"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <input
          type="number"
          className="dt-explore-radius-input"
          value={radiusKm}
          min={0.5}
          max={50}
          step={0.5}
          onChange={(e) => setRadiusKm(parseFloat(e.target.value) || 2)}
          title="Search radius (km) — used for coordinate/Site ID searches; district/city searches use the real boundary or site-hull shape instead"
        />
        <span className="dt-explore-radius-label">km</span>
        <button type="button" className="btn btn-primary" onClick={handleSearch}>
          Search
        </button>
      </div>
      <div className="dt-explore-tech-row">
        {ALL_TECHS.map((t) => (
          <button
            key={t}
            type="button"
            className={`dt-metric-tab${techFilter.has(t) ? ' active' : ''}`}
            onClick={() => toggleTech(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {error && <div className="page-status" style={{ color: '#dc2626' }}>{error}</div>}

      {!point ? (
        <div className="page-status">Search by coordinates, city, district, or Site ID to explore nearby sites and drive-test coverage.</div>
      ) : (
        <>
          {sessionsError && (
            <div className="page-status" style={{ color: '#dc2626' }}>
              The drive tests for this area could not be loaded. Try a smaller area or try again.
            </div>
          )}
          {plotStepM > 0 && (
            <div className="page-status">
              {detail
                ? 'Zoomed in: every reading in view is shown. Outside the view, each dot is a square.'
                : detailLoading
                  ? 'Loading every reading in view…'
                  : `This area holds many drive-test readings, so each dot is a ${plotStepM} m square of one session, showing the weakest value of the chosen measurement there. Zoom in to about ${DETAIL_MAX_KM} km across to see every reading.`}
            </div>
          )}
          <div className="report-summary-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginTop: 12 }}>
            <div className="report-card">
              <div className="report-card-val" style={{ fontSize: 15 }}>{pointLabel}</div>
              <div className="report-card-label">Search Point</div>
            </div>
            <div className="report-card">
              <div className="report-card-val">{nearSites.length}</div>
              <div className="report-card-label">Nearby Sites</div>
            </div>
            <div className="report-card">
              <div className="report-card-val">{sessionsLoading ? '…' : nearSessions.length}</div>
              <div className="report-card-label">Nearby Sessions</div>
            </div>
            {telemetryShown && (
              <div className="report-card">
                <div className="report-card-val">{telemetryNear.isLoading ? '…' : telemetrySessions.length}</div>
                <div className="report-card-label">Telemetry Sessions</div>
              </div>
            )}
            <div className="report-card">
              <div className="report-card-val">{shape.type === 'polygon' ? shape.name : `${radiusKm} km`}</div>
              <div className="report-card-label">{shape.type === 'polygon' ? 'Boundary' : 'Search Radius'}</div>
            </div>
          </div>

          <div className="report-toolbar" style={{ marginTop: 12, marginBottom: 0, gap: 6 }}>
            {(['sessions', 'recent', 'change'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={exploreView === v ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
                onClick={() => setExploreView(v)}
                title={v === 'sessions' ? 'Every ticked session'
                  : v === 'recent' ? 'The most recent value measured in each 50 m square, from the ticked sessions'
                    : 'Each 50 m square compared with the drive before it'}
              >
                {v === 'sessions' ? 'Sessions' : v === 'recent' ? 'Recent' : 'Change'}
              </button>
            ))}
            {exploreView !== 'sessions' && (
              <span className="muted" style={{ fontSize: 12 }}>
                {recent.isLoading ? 'Loading…'
                  : recent.error ? apiErrorMessage(recent.error)
                    : `${exploreView === 'recent'
                      ? `The most recent value in each 50 m square, from any drive; faded when older than ${RECENT_FADE_MONTHS} months.`
                      : 'Green: better than the drive before; red: worse; grey: about the same. Only squares measured at least twice.'}`
                      + ` Drive tests: ${plottedSessions.length} of ${nearSessions.length} ticked.`
                      + (telemetryShown
                        ? ` Phone sessions (white ring): ${telemetrySessions.filter((t) => !hiddenTel.has(t.key)).length} of ${telemetrySessions.length} ticked`
                          + (exploreView === 'change' ? `, ${phoneChangeSquares} square${phoneChangeSquares === 1 ? '' : 's'} with an earlier phone session to compare.` : '.')
                        : canSeeTelemetry ? ' Tick "Include telemetry sessions" to add phone readings.' : '')
                      + (exploreView === 'change' && plottedSessions.length < 2 && !(telemetryShown && phoneChangeSquares)
                        ? ' Change needs two drives over the same streets.' : '')}
              </span>
            )}
          </div>
          <div className="report-toolbar" style={{ marginTop: 6, marginBottom: 0 }}>
            <div className="feat-tabs" style={{ borderBottom: 'none', flexWrap: 'wrap' }}>
              {visibleMetrics.map((m) => (
                <div key={m.tag} className={!isPciTab && !isBandTab && m.tag === metric.tag ? 'feat-tab active' : 'feat-tab'} onClick={() => setMetricTag(m.tag)}>
                  {m.tag}
                </div>
              ))}
              {pciTabVisible && (
                <div className={isPciTab ? 'feat-tab active' : 'feat-tab'} onClick={() => setMetricTag(PCI_TAG)}>
                  {PCI_TAG}
                </div>
              )}
              {bandTabVisible && (
                <div className={isBandTab ? 'feat-tab active' : 'feat-tab'} onClick={() => setMetricTag(BAND_TAG)}>
                  {BAND_TAG}
                </div>
              )}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {canSeeTelemetry && (
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, marginRight: 8, cursor: 'pointer' }}
                  title="Also show phone drives and Telemetry Drive Test sessions recorded in this area"
                >
                  <input
                    type="checkbox"
                    checked={includeTelemetry}
                    onChange={(e) => setIncludeTelemetry(e.target.checked)}
                  />
                  Include telemetry sessions
                </label>
              )}
              <span style={{ fontSize: 10, color: '#6b7280', alignSelf: 'center' }}>Export:</span>
              <button
                type="button"
                className="btn-secondary btn-small"
                disabled={isPciTab || isBandTab}
                title={isPciTab ? 'CSV export is not yet available for the PCI Plot' : isBandTab ? 'CSV export is not yet available for Band Distribution' : undefined}
                onClick={() => exportCsv(plottedSessions, metric, nearSites, point, shape, radiusKm, pointLabel)}
              >
                CSV
              </button>
              <button
                type="button"
                className="btn-secondary btn-small"
                disabled={isPciTab || isBandTab}
                title={isPciTab ? 'KML export is not yet available for the PCI Plot' : isBandTab ? 'KML export is not yet available for Band Distribution' : undefined}
                onClick={() => exportKml(plottedSessions, metric, nearSites, point, shape, radiusKm, pointLabel)}
              >
                KML
              </button>
              <button
                type="button"
                className="btn-secondary btn-small"
                onClick={() => setMapLayer((m) => (m === 'street' ? 'satellite' : 'street'))}
              >
                {mapLayer === 'street' ? '🛰 Satellite' : '🗺 Street'}
              </button>
              <button
                type="button"
                className={show3d ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
                onClick={() => setShow3d((v) => !v)}
                title="Tilted view on real ground heights; turn and tilt with the buttons on the map"
              >
                {show3d ? '🗺 Flat map' : '⛰ 3D terrain'}
              </button>
              <button type="button" className="btn-secondary btn-small" onClick={toggleFullscreen}>
                {isFullscreen ? '⤦ Exit Fullscreen' : '⤢ Fullscreen'}
              </button>
            </div>
          </div>

          {isPciTab && exploreView === 'sessions' && (
            <div className="report-toolbar" style={{ marginTop: 6, marginBottom: 0, gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className={pciMode === 'pci' ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
                onClick={() => setPciMode('pci')}
                title="One colour per PCI"
              >
                By PCI
              </button>
              <button
                type="button"
                className={pciMode === 'mod3' ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
                onClick={() => setPciMode('mod3')}
                title="Colour by PCI mod 3: neighbouring cells with the same colour can interfere"
              >
                PCI mod 3
              </button>
              <input
                type="text"
                inputMode="numeric"
                placeholder="Find PCI"
                value={pciFind}
                onChange={(e) => setPciFind(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') findPci() }}
                style={{ width: 90, marginLeft: 8 }}
              />
              <button type="button" className="btn-secondary btn-small" onClick={findPci}>Show</button>
              {isolatedPci !== null && (
                <button
                  type="button"
                  className="btn-secondary btn-small"
                  onClick={() => { setIsolatedPci(null); setPciFind('') }}
                >
                  Show all
                </button>
              )}
              <span className="muted" style={{ fontSize: 12 }}>
                {isolatedPci !== null && !rankedPcis.some((r) => r.pci === isolatedPci)
                  ? `PCI ${isolatedPci} is not in this search.`
                  : isolatedPci !== null
                    ? `Showing PCI ${isolatedPci} only.`
                    : pciMode === 'pci' && rankedPcis.length > PCI_DISTINCT_COLORS
                      ? `${rankedPcis.length} PCIs here; colours repeat after ${PCI_DISTINCT_COLORS}. Click a PCI below to show it alone.`
                      : 'Click a PCI below to show it alone. Zoom in to 2 km across to see PCI numbers on the map.'}
              </span>
            </div>
          )}

          <div
            ref={wrapRef}
            className={isFullscreen ? 'dt-explore-map-wrap dt-explore-map-fullscreen' : 'dt-explore-map-wrap'}
          >
            {show3d && terrainData ? (
              <div className="dt-coverage-map dt-explore-3d">
                <Suspense fallback={<div className="page-status">Loading the 3D map…</div>}>
                  <Terrain3D center={[point.lat, point.lng]} data={terrainData} names={mapLayer === 'street'} />
                </Suspense>
              </div>
            ) : (
            <MapContainer
              key={mapLayer}
              center={DEFAULT_CENTER}
              zoom={DEFAULT_ZOOM}
              className="dt-coverage-map"
            >
              <CurrentLocationMarker />
              <SitePhotoLayer />
              <TileLayer
                attribution={mapLayer === 'street' ? '&copy; OpenStreetMap contributors' : '&copy; Google'}
                url={mapLayer === 'street' ? STREET_URL : SATELLITE_URL}
                subdomains={mapLayer === 'street' ? 'abc' : '0123'}
                maxNativeZoom={mapLayer === 'street' ? 19 : 20}
                maxZoom={20}
              />
              <SearchAreaLayer point={pointTuple as LatLng} radiusKm={radiusKm} shape={shape} label={pointLabel} />
              <NearSitesLayer sites={nearSites} onSelect={setSelectedSite} />
              {exploreView !== 'sessions' ? (
                !isPciTab && !isBandTab && (
                  <>
                    {recent.data && recentSessionIds?.length !== 0 && (
                      <RecentSquaresLayer squares={recent.data.squares} metric={metric} view={exploreView} names={recent.data.sessions} />
                    )}
                    {phoneSquares.length > 0 && (
                      <RecentSquaresLayer squares={phoneSquares} metric={metric} view={exploreView} names={telemetryNames} ring />
                    )}
                  </>
                )
              ) : isPciTab ? (
                <>
                  <PciSamplesLayer sessions={plottedSessions} colorOf={pciColorOf} isolated={isolatedPci} />
                  <PciLabelsLayer sessions={plottedSessions} isolated={isolatedPci} />
                </>
              ) : isBandTab ? (
                <BandSamplesLayer sessions={plottedSessions} />
              ) : (
                <NearSamplesLayer sessions={plottedSessions} metric={metric} servingCells={servingCells} />
              )}
              {telemetryShown && exploreView === 'sessions' && <TelemetryNearLayer points={telemetryPlotted} names={telemetryNames} colorOf={telemetryColorOf} />}
              <FlyToSite target={flyTarget} />
              <ViewWatcher onView={setViewBox} />
              <FullscreenSync isFullscreen={isFullscreen} bounds={currentBounds} />
              <InvalidateOnResize />
            </MapContainer>
            )}
            {selectedSite && (
              <div className="site-quickview">
                <div className="site-quickview-title">{selectedSite.name || selectedSite.id}</div>
                <div className="site-quickview-meta">
                  {selectedSite.id} · {selectedSite.district}, {selectedSite.region}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {/* ?from=dt-explore (2026-09-30) -- lets SiteDetailPage's
                      back link return here instead of defaulting to Sites
                      Topology ("back to site redirects to site topology
                      home page, but i need back to where i came from"). */}
                  <button onClick={() => navigate(`/sites/${selectedSite.id}?from=dt-explore`)}>Open site detail →</button>
                  <button className="btn-secondary btn-small" onClick={() => setSelectedSite(null)}>✕</button>
                </div>
              </div>
            )}
          </div>
          <div className="dt-legend">
            <span className="dt-legend-item"><span className="dt-legend-dot" style={{ background: '#7f77dd' }} />Search point / area</span>
            <span className="dt-legend-item"><span className="dt-legend-dot" style={{ background: '#1e2330', border: '1px solid #e6e9ef' }} />BTS site</span>
            {isPciTab ? (
              pciMode === 'mod3' ? (
                [0, 1, 2].map((m) => (
                  <span key={m} className="dt-legend-item">
                    <span className="dt-legend-dot" style={{ background: pciMod3Color(m) }} />
                    PCI mod 3 = {m} · {mod3Counts[m].toLocaleString()}
                  </span>
                ))
              ) : (
                rankedPcis.map(({ pci, n }) => (
                  <button
                    key={pci}
                    type="button"
                    className={isolatedPci === pci ? 'dt-legend-item dt-legend-pick active' : 'dt-legend-item dt-legend-pick'}
                    title={isolatedPci === pci ? 'Show all PCIs again' : `Show only PCI ${pci}`}
                    onClick={() => setIsolatedPci((cur) => (cur === pci ? null : pci))}
                  >
                    <span className="dt-legend-dot" style={{ background: pciColorOf(pci) }} />
                    PCI {pci} · {n.toLocaleString()}
                  </button>
                ))
              )
            ) : isBandTab ? (
              distinctBands.map((band) => (
                <span key={band} className="dt-legend-item">
                  <span className="dt-legend-dot" style={{ background: bandCategoryColor(band) }} />
                  Band {band}
                </span>
              ))
            ) : (
              metric.bands.map((b) => (
                <span key={b.label} className="dt-legend-item">
                  <span className="dt-legend-dot" style={{ background: b.color }} />
                  {b.label}
                  {metric.unit}
                </span>
              ))
            )}
          </div>

          <div className="dt-explore-lists">
            <ExploreListBox
              title="Drive tests"
              count={nearSessions.length}
              rows={displaySessions}
              rowKey={(s) => s.id}
              selectedOf={(s) => !hiddenDt.has(s.id)}
              onToggle={(s) => setHiddenDt((prev) => toggled(prev, s.id))}
              onToggleAll={(on) => setHiddenDt(on ? new Set() : new Set(nearSessions.map((s) => s.id)))}
              rowClass={(s) => {
                const cluster = latestOnly ? areaClusterBySessionId.get(s.id) : undefined
                return cluster && cluster.sessions[0].id !== s.id ? 'dt-cluster-child-row' : undefined
              }}
              empty={sessionsLoading ? 'Loading…' : 'No saved drive-test coverage in this area.'}
              head={nearSessions.length > 0 && (
                // "Latest only" (2026-09-13): same grouping as Session History; list only.
                <label
                  className="sites-active-toggle"
                  style={{ marginLeft: 'auto' }}
                  title="List only the latest session for each drive-test area; older re-tests stay one click away"
                >
                  <input type="checkbox" checked={latestOnly} onChange={(e) => setLatestOnly(e.target.checked)} />
                  <span className="sites-active-toggle-track"><span className="sites-active-toggle-thumb" /></span>
                  Latest only
                </label>
              )}
              columns={[
                {
                  label: 'Session',
                  cell: (s) => {
                    const cluster = latestOnly ? areaClusterBySessionId.get(s.id) : undefined
                    const isHead = !!cluster && cluster.sessions[0].id === s.id
                    return (
                      <>
                        {cluster && !isHead ? '↳ ' : ''}<b>{s.name}</b>
                        {cluster && isHead && cluster.sessions.length > 1 && (
                          <button
                            type="button"
                            className="dt-cluster-chip"
                            onClick={(e) => { e.stopPropagation(); toggleClusterExpanded(cluster.key) }}
                            title="Older sessions saved for this same area"
                          >
                            {expandedClusters.has(cluster.key) ? 'Hide earlier sessions' : `+${cluster.sessions.length - 1} earlier here`}
                          </button>
                        )}
                        {s.activities.length > 0 && (
                          <div className="dt-activity-badges">
                            {s.activities.map((a) => (
                              <span key={`${a.id}-${a.role}`} className="dt-activity-badge" title={`${a.name} · ${ACTIVITY_ROLE_LABELS[a.role]}`}>
                                {a.name} · {ACTIVITY_ROLE_LABELS[a.role]}
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )
                  },
                },
                { label: 'Network', cell: (s) => s.tech },
                { label: 'Date', cell: (s) => s.date || '—', className: 'num' },
                { label: 'Readings here', cell: (s) => s.samples.length.toLocaleString(), className: 'num', title: plotStepM ? 'Dots in this area (squares on a wide search)' : 'Readings in this area' },
              ]}
            />
            {telemetryShown && (
              <ExploreListBox
                title="Telemetry sessions"
                count={telemetrySessions.length}
                rows={telemetrySessions}
                rowKey={(s) => s.key}
                selectedOf={(s) => !hiddenTel.has(s.key)}
                onToggle={(s) => setHiddenTel((prev) => toggled(prev, s.key))}
                onToggleAll={(on) => setHiddenTel(on ? new Set() : new Set(telemetrySessions.map((s) => s.key)))}
                empty={telemetryNear.isLoading ? 'Loading…' : telemetryNear.error ? 'Could not load telemetry sessions.' : 'No telemetry sessions recorded in this area.'}
                columns={[
                  { label: 'Session', cell: (s) => <b>{s.name}</b> },
                  { label: 'Kind', cell: (s) => (s.kind === 'telemetry_dt' ? 'Telemetry Drive Test' : 'Collections') },
                  { label: 'Started', cell: (s) => new Date(s.started_at).toLocaleString(), className: 'num' },
                  { label: 'Readings here', cell: (s) => s.samples_in_area.toLocaleString(), className: 'num' },
                ]}
                foot={
                  <>
                    {telemetryNear.data?.truncated && 'Only the newest readings are drawn. Narrow the radius to see them all. '}
                    White-ringed dots on the map, coloured like the drive tests. The 4G / 3G / 2G buttons apply to these too.
                  </>
                }
              />
            )}
            <ExploreListBox
              title="Nearby sites"
              count={nearSites.length}
              rows={nearSites}
              rowKey={(o) => o.s.id}
              onRowClick={(o) => {
                setSelectedSite(o.s)
                setFlyTarget({ lat: o.s.lat as number, lng: o.s.lng as number, n: Date.now() })
                wrapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }}
              empty="No BTS sites in this area."
              columns={[
                { label: 'Site', cell: (o) => <><b>{o.s.id}</b>{o.s.name && o.s.name !== o.s.id ? <span className="muted"> · {o.s.name}</span> : null}</> },
                { label: 'District', cell: (o) => o.s.district || '—' },
                { label: 'Distance', cell: (o) => `${o.d.toFixed(2)} km`, className: 'num' },
              ]}
              foot="Click a site to go to it on the map."
            />
          </div>
        </>
      )}
    </div>
  )
}
