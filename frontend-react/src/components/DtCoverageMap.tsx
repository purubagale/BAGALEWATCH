import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import { useEffect, useMemo, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { DtSample, DtServingCell, DtTech } from '../api/types'
import { bandColor, subsampleForMap, type DtMetric } from '../lib/dtBands'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'
import { useDtMetrics } from '../lib/useDtMetrics'

const DEFAULT_CENTER: [number, number] = [28.3949, 84.124]
const DEFAULT_ZOOM = 7

/** Plots one session's samples as colored dots, imperative-layer pattern
 * (see MapView.tsx's ClusteredMarkers for why: react-leaflet v5 has no
 * working cluster wrapper). No clustering here — this assumed DT
 * sessions run a few thousand points at most, not 4,700+ sites, so plain
 * CircleMarkers via raw Leaflet calls would be fast enough without
 * chunked loading. **That assumption broke for real on 2026-08-14**: a
 * 363,082-sample multi-file .trp session (see DtUploadPage.tsx's .trp
 * upload feature) made the whole app feel slow/frozen while its
 * coverage map tried to draw one real SVG circleMarker per sample. Now
 * subsampled via dtBands.ts's subsampleForMap() before drawing — see
 * that function's own comment for why this is capped here but NOT in
 * DtCompareMap.tsx.
 *
 * Real bug, still being chased as of 2026-07-29: four fix attempts so
 * far (stale container size, the `bounds`/`boundsOptions` MapContainer
 * props, a StrictMode double-mount theory, an invalidateSize
 * ResizeObserver) all failed to change anything. Hard evidence ruled
 * out the network, the tile server, and CSS: tiles load successfully
 * (200s, fast, from disk cache), a tile URL opened directly renders a
 * real image, `.leaflet-container img.leaflet-tile { mix-blend-mode:
 * plus-lighter }` seen in DevTools is stock unmodified Leaflet CSS
 * (present on the working Sites page too — a Chromium tile-seam
 * workaround, not a bug), and it reproduces identically in Brave,
 * Chrome, and Chrome Incognito (rules out extensions and profile-level
 * dark-mode settings).
 *
 * A deferred-TileLayer fix (withholding <TileLayer> until fitBounds had
 * already run) was tried next and ALSO produced zero change — confirmed
 * with a temporary canary banner proving the browser really was running
 * the new code, ruling out a stale-bundle explanation for the string of
 * "nothing changed" reports. With six structurally different mount
 * strategies all failing identically, the bug isn't in *when* the view/
 * tiles get set up — so the remaining real difference from the working
 * Sites page (MapView.tsx) is *what* gets drawn: MapView passes
 * `preferCanvas` too, but its markers come from `leaflet.markercluster`
 * (plain DOM `L.divIcon`/`L.marker` elements) — no vector shape is ever
 * added, so no `<canvas>` renderer pane actually gets created there.
 * This component draws ~85 real `L.circleMarker` vector shapes, which
 * DOES activate a live canvas overlay pane stacked on the tile pane —
 * precisely the scenario Leaflet's own `mix-blend-mode: plus-lighter`
 * CSS hack exists for (Chromium bug 600120, tile/canvas compositing).
 * Removed `preferCanvas` here so circleMarkers fall back to Leaflet's
 * default SVG renderer instead, avoiding that canvas+tile interaction
 * entirely. Acceptable perf-wise: DT sessions are a few thousand points
 * at most, nowhere near MapView's 4,700+ site scale that motivated
 * preferCanvas there in the first place (which, per the above, isn't
 * even doing anything on that page). */
function InvalidateOnResize() {
  useMapInvalidateOnResize()
  return null
}

function FitToBounds({ bounds, onDone }: { bounds: L.LatLngBounds; onDone: () => void }) {
  const map = useMap()

  useEffect(() => {
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16, animate: false })
    onDone()
  }, [map, bounds, onDone])

  return null
}

function CoverageDots({
  samples,
  metric,
  servingCells,
}: {
  samples: DtSample[]
  metric: DtMetric
  servingCells?: DtServingCell[]
}) {
  const map = useMap()

  useEffect(() => {
    const layer = L.layerGroup()
    // Separate group so the serving-site connector can be
    // shown/cleared without rebuilding the ~15k dots.
    const linkLayer = L.layerGroup().addTo(map)
    let pinned = false

    const cellBySite = new Map((servingCells ?? []).map((c) => [c.site_id, c]))

    function clearLink() {
      linkLayer.clearLayers()
      map.closePopup()
      pinned = false
    }
    function showLink(s: DtSample, openPopup: boolean) {
      const cell = s.serving_site_id ? cellBySite.get(s.serving_site_id) : undefined
      if (!cell || cell.site_lat == null || cell.site_lng == null) return
      linkLayer.clearLayers()
      L.polyline(
        [
          [s.lat as number, s.lng as number],
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
          `PCI ${s.pci ?? '—'}`,
          cell.cell_name || cell.site_name,
          cell.sector ? `Sector ${cell.sector}` : null,
          s.serving_dist_km != null ? `${s.serving_dist_km.toFixed(2)} km` : null,
          cell.azimuth != null ? `Az ${cell.azimuth}°` : null,
        ].filter(Boolean)
        L.popup({ offset: [0, -4] })
          .setLatLng([s.lat as number, s.lng as number])
          .setContent(`<b>${cell.site_name}</b><br>${parts.join(' · ')}`)
          .openOn(map)
        pinned = true
      }
    }

    const withGps = samples.filter((s) => s.lat != null && s.lng != null)
    for (const s of withGps) {
      const v = s[metric.key] as number | null
      const color = bandColor(metric.bands, v)
      const dot = L.circleMarker([s.lat as number, s.lng as number], {
        radius: 4,
        color,
        fillColor: color,
        fillOpacity: 0.85,
        weight: 0,
      })
      const valueText = v != null ? `${v}${metric.unit}` : 'No data'
      dot.bindTooltip(`${metric.label}: ${valueText}${s.serving_site_name ? ` — ${s.serving_site_name}` : ''}`)
      if (s.serving_site_id && cellBySite.has(s.serving_site_id)) {
        dot.on('mouseover', () => {
          if (!pinned) showLink(s, false)
        })
        dot.on('mouseout', () => {
          if (!pinned) linkLayer.clearLayers()
        })
        dot.on('click', (e) => {
          L.DomEvent.stopPropagation(e)
          showLink(s, true)
        })
      }
      layer.addLayer(dot)
    }
    layer.addTo(map)
    map.on('click', clearLink)

    return () => {
      map.off('click', clearLink)
      map.removeLayer(layer)
      map.removeLayer(linkLayer)
    }
  }, [samples, metric, map, servingCells])

  return null
}

export default function DtCoverageMap({
  samples,
  tech,
  servingCells,
}: {
  samples: DtSample[]
  tech: DtTech
  servingCells?: DtServingCell[]
}) {
  const { metricsForTech } = useDtMetrics()
  const metrics = useMemo(() => metricsForTech(tech), [metricsForTech, tech])
  const [metricKey, setMetricKey] = useState(metrics[0].key)
  const activeMetric = metrics.find((m) => m.key === metricKey) ?? metrics[0]

  const withGps = useMemo(() => samples.filter((s) => s.lat != null && s.lng != null), [samples])
  // What actually gets drawn — bounds/fitBounds above still uses the FULL
  // withGps (cheap, just a min/max pass) so the map always frames the
  // real full route even when the dots themselves are subsampled.
  const drawnSamples = useMemo(() => subsampleForMap(withGps), [withGps])
  const bounds = useMemo(
    () => (withGps.length ? L.latLngBounds(withGps.map((s) => [s.lat as number, s.lng as number])) : null),
    [withGps],
  )
  // Fingerprint of the current dataset (not just its length — two
  // different sessions could coincidentally have the same point count)
  // so switching to a genuinely different session's samples remounts a
  // fresh Leaflet instance instead of reusing one whose tile cache/state
  // was built for a different route entirely.
  const mapKey = withGps.length
    ? `${withGps.length}-${withGps[0].lat}-${withGps[0].lng}-${withGps[withGps.length - 1].lat}`
    : 'empty'

  // Starts false whenever there's a real bounds to fit — TileLayer only
  // mounts once true, so it never requests tiles for the throwaway
  // zoom-7 default view. See FitToBounds doc comment above for why.
  const [viewReady, setViewReady] = useState(!bounds)
  useEffect(() => {
    setViewReady(!bounds)
  }, [bounds, mapKey])

  return (
    <div className="dt-coverage-map-wrap">
      <div className="dt-metric-tabs">
        {metrics.map((m) => (
          <button
            key={m.key}
            className={`dt-metric-tab${m.key === activeMetric.key ? ' active' : ''}`}
            onClick={() => setMetricKey(m.key)}
            type="button"
          >
            {m.label}
          </button>
        ))}
      </div>
      <MapContainer key={mapKey} center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} className="dt-coverage-map">
        <InvalidateOnResize />
        {bounds && !viewReady && <FitToBounds bounds={bounds} onDone={() => setViewReady(true)} />}
        {viewReady && (
          <>
            <TileLayer
              attribution="&copy; OpenStreetMap contributors"
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <CoverageDots samples={drawnSamples} metric={activeMetric} servingCells={servingCells} />
          </>
        )}
      </MapContainer>
      <div className="dt-legend">
        {activeMetric.bands.map((b) => (
          <span key={b.label} className="dt-legend-item">
            <span className="dt-legend-dot" style={{ background: b.color }} />
            {b.label}
            {activeMetric.unit}
          </span>
        ))}
      </div>
      {drawnSamples.length < withGps.length && (
        <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
          Showing {drawnSamples.length.toLocaleString()} of {withGps.length.toLocaleString()} GPS points on the map
          (subsampled evenly along the route for performance — the summary stats above use every real point).
        </div>
      )}
    </div>
  )
}
