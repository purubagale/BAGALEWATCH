import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useDtSessionsNear, useSites } from '../api/queries'
import type { DtSessionDetail, DtTech, SiteListItem } from '../api/types'
import { ALL_TECHS, bandColor, subsampleForMap, type TaggedMetric } from '../lib/dtBands'
import { useDtMetrics } from '../lib/useDtMetrics'
import { haversineKm } from '../lib/dtTemplateParser'
import { pointInPolygon, polygonAverageCenter, polygonBoundingRadiusKm, type LatLng } from '../lib/geo'
import { NEPAL_DISTRICT_BOUNDARIES } from '../lib/nepalDistrictBoundaries'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'

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
function NearSamplesLayer({ sessions, metric }: { sessions: DtSessionDetail[]; metric: TaggedMetric }) {
  const map = useMap()

  useEffect(() => {
    const layer = L.layerGroup()
    for (const session of sessions) {
      if (session.tech !== metric.tech) continue
      const withVal = session.samples.filter((sample) => sample.lat != null && sample.lng != null && sample[metric.key] != null)
      const drawn = subsampleForMap(withVal)
      for (const sample of drawn) {
        const v = sample[metric.key] as number
        const color = bandColor(metric.bands, v)
        L.circleMarker([sample.lat as number, sample.lng as number], {
          radius: 3,
          color,
          fillColor: color,
          fillOpacity: 0.85,
          weight: 0,
        })
          .bindTooltip(
            `<b>${session.name}</b> (${session.tech})<br>${sample.ts || sample.date || ''}<br>${metric.label}: ${v}${metric.unit}` +
              (sample.serving_site_name ? `<br>${sample.serving_site_name}` : ''),
            { sticky: true, direction: 'top', offset: [0, -4] },
          )
          .addTo(layer)
      }
    }
    layer.addTo(map)
    return () => {
      map.removeLayer(layer)
    }
  }, [map, sessions, metric])

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
  const [inputText, setInputText] = useState('')
  const [radiusKm, setRadiusKm] = useState(2)
  const [techFilter, setTechFilter] = useState<Set<DtTech>>(new Set(ALL_TECHS))
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null)
  const [pointLabel, setPointLabel] = useState('')
  const [shape, setShape] = useState<SearchShape>({ type: 'circle' })
  const [error, setError] = useState<string | null>(null)
  const [sitesExpanded, setSitesExpanded] = useState(false)
  const [sessionsExpanded, setSessionsExpanded] = useState(false)
  // "Open site detail" quickview (2026-08-05) — set by clicking either a
  // site marker on the map (NearSitesLayer's onSelect) or a row in the
  // "Nearby Sites" list below; same `.site-quickview` card SitesPage
  // uses, minus its Delete button (Explore doesn't own site CRUD).
  const [selectedSite, setSelectedSite] = useState<SiteListItem | null>(null)
  const { allMetrics } = useDtMetrics()
  const [metricTag, setMetricTag] = useState(allMetrics[0].tag)
  const [mapLayer, setMapLayer] = useState<'street' | 'satellite'>('street')
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

  const { data: nearSessionsRaw, isLoading: sessionsLoading } = useDtSessionsNear(point, backendRadiusKm, techs)

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
    if (shape.type !== 'polygon') return nearSessionsRaw
    return nearSessionsRaw
      .map((s) => ({ ...s, samples: s.samples.filter((r) => r.lat != null && r.lng != null && pointInPolygon(r.lat as number, r.lng as number, shape.points)) }))
      .filter((s) => s.samples.length > 0)
  }, [nearSessionsRaw, shape])

  // Metric tabs track the tech filter above (RSRP/RSRQ/SINR only while 4G
  // is ticked, RSCP/Ec-Io only while 3G, RxLevel/RxQual only while 2G) —
  // AND are further narrowed to only techs that actually have a nearby
  // session in the current search area, per explicit user request: if the
  // area only has a 2G session, don't show 4G/3G tabs just because those
  // techs are ticked in the filter row. Falls back to the tech-filter-only
  // list while sessions are still loading or none exist yet, so the tab
  // bar isn't empty before a search has even resolved.
  const presentTechs = useMemo(() => new Set(nearSessions.map((s) => s.tech)), [nearSessions])
  // Only fall back to the full tech-filter list while the query is still
  // in flight (avoids a flash of zero tabs before results arrive). Once
  // it's actually resolved, an empty `presentTechs` (genuinely zero nearby
  // sessions, e.g. Chitwan) means zero tabs — no fallback to "show
  // everything" — per explicit user request: don't show tech tabs for
  // techs with no data in the current search area, full stop.
  const visibleMetrics = useMemo(() => {
    const byFilter = allMetrics.filter((m) => techFilter.has(m.tech))
    if (sessionsLoading) return byFilter
    return byFilter.filter((m) => presentTechs.has(m.tech))
  }, [allMetrics, techFilter, presentTechs, sessionsLoading])
  useEffect(() => {
    if (visibleMetrics.length && !visibleMetrics.some((m) => m.tag === metricTag)) {
      setMetricTag(visibleMetrics[0].tag)
    }
  }, [visibleMetrics, metricTag])
  const metric = visibleMetrics.find((m) => m.tag === metricTag) ?? visibleMetrics[0] ?? allMetrics[0]

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
    setSitesExpanded(false)
    setSessionsExpanded(false)
    setSelectedSite(null)
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
            <div className="report-card">
              <div className="report-card-val">{shape.type === 'polygon' ? shape.name : `${radiusKm} km`}</div>
              <div className="report-card-label">{shape.type === 'polygon' ? 'Boundary' : 'Search Radius'}</div>
            </div>
          </div>

          <div className="report-toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
            <div className="feat-tabs" style={{ borderBottom: 'none', flexWrap: 'wrap' }}>
              {visibleMetrics.map((m) => (
                <div key={m.tag} className={m.tag === metric.tag ? 'feat-tab active' : 'feat-tab'} onClick={() => setMetricTag(m.tag)}>
                  {m.tag}
                </div>
              ))}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <span style={{ fontSize: 10, color: '#6b7280', alignSelf: 'center' }}>Export:</span>
              <button type="button" className="btn-secondary btn-small" onClick={() => exportCsv(nearSessions, metric, nearSites, point, shape, radiusKm, pointLabel)}>CSV</button>
              <button type="button" className="btn-secondary btn-small" onClick={() => exportKml(nearSessions, metric, nearSites, point, shape, radiusKm, pointLabel)}>KML</button>
              <button
                type="button"
                className="btn-secondary btn-small"
                onClick={() => setMapLayer((m) => (m === 'street' ? 'satellite' : 'street'))}
              >
                {mapLayer === 'street' ? '🛰 Satellite' : '🗺 Street'}
              </button>
              <button type="button" className="btn-secondary btn-small" onClick={toggleFullscreen}>
                {isFullscreen ? '⤦ Exit Fullscreen' : '⤢ Fullscreen'}
              </button>
            </div>
          </div>

          <div
            ref={wrapRef}
            className={isFullscreen ? 'dt-explore-map-wrap dt-explore-map-fullscreen' : 'dt-explore-map-wrap'}
          >
            <MapContainer
              key={mapLayer}
              center={DEFAULT_CENTER}
              zoom={DEFAULT_ZOOM}
              className="dt-coverage-map"
            >
              <TileLayer
                attribution={mapLayer === 'street' ? '&copy; OpenStreetMap contributors' : '&copy; Google'}
                url={mapLayer === 'street' ? STREET_URL : SATELLITE_URL}
                subdomains={mapLayer === 'street' ? 'abc' : '0123'}
                maxZoom={20}
              />
              <SearchAreaLayer point={pointTuple as LatLng} radiusKm={radiusKm} shape={shape} label={pointLabel} />
              <NearSitesLayer sites={nearSites} onSelect={setSelectedSite} />
              <NearSamplesLayer sessions={nearSessions} metric={metric} />
              <FullscreenSync isFullscreen={isFullscreen} bounds={currentBounds} />
              <InvalidateOnResize />
            </MapContainer>
            {selectedSite && (
              <div className="site-quickview">
                <div className="site-quickview-title">{selectedSite.name || selectedSite.id}</div>
                <div className="site-quickview-meta">
                  {selectedSite.id} · {selectedSite.district}, {selectedSite.region}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => navigate(`/sites/${selectedSite.id}`)}>Open site detail →</button>
                  <button className="btn-secondary btn-small" onClick={() => setSelectedSite(null)}>✕</button>
                </div>
              </div>
            )}
          </div>
          <div className="dt-legend">
            <span className="dt-legend-item"><span className="dt-legend-dot" style={{ background: '#7f77dd' }} />Search point / area</span>
            <span className="dt-legend-item"><span className="dt-legend-dot" style={{ background: '#1e2330', border: '1px solid #e6e9ef' }} />BTS site</span>
            {metric.bands.map((b) => (
              <span key={b.label} className="dt-legend-item">
                <span className="dt-legend-dot" style={{ background: b.color }} />
                {b.label}
                {metric.unit}
              </span>
            ))}
          </div>

          <div className="dt-explore-lists">
            <div className="dt-explore-list-col">
              <div className="dt-explore-list-title">Nearby Sites ({nearSites.length})</div>
              {nearSites.length === 0 && <div className="page-status">No BTS sites in this area.</div>}
              {(sitesExpanded ? nearSites : []).map(({ s, d }) => (
                <div
                  key={s.id}
                  className="dt-dup-card"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelectedSite(s)}
                  title="View on map / open site detail"
                >
                  <div className="dt-dup-card-name">{s.name || s.id}</div>
                  <div className="dt-dup-card-sub">{s.district || '—'} · {d.toFixed(2)} km</div>
                </div>
              ))}
              {nearSites.length > 0 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSitesExpanded((v) => !v)}>
                  {sitesExpanded ? '▲ Show fewer' : `▼ Show all ${nearSites.length} sites`}
                </button>
              )}
            </div>
            <div className="dt-explore-list-col">
              <div className="dt-explore-list-title">Nearby Sessions ({nearSessions.length})</div>
              {!sessionsLoading && nearSessions.length === 0 && <div className="page-status">No saved drive-test coverage in this area.</div>}
              {(sessionsExpanded ? nearSessions : []).map((s) => (
                <div key={s.id} className="dt-dup-card">
                  <div className="dt-dup-card-name">{s.name}</div>
                  <div className="dt-dup-card-sub">{s.tech} · {s.date} · {s.samples.length} pts in area</div>
                </div>
              ))}
              {nearSessions.length > 0 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSessionsExpanded((v) => !v)}>
                  {sessionsExpanded ? '▲ Show fewer' : `▼ Show all ${nearSessions.length} sessions`}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
