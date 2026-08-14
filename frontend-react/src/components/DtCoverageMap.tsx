import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import { useEffect, useMemo, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { DtSample, DtTech } from '../api/types'
import { bandColor, type DtMetric } from '../lib/dtBands'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'
import { useDtMetrics } from '../lib/useDtMetrics'

const DEFAULT_CENTER: [number, number] = [28.3949, 84.124]
const DEFAULT_ZOOM = 7

/** Plots one session's samples as colored dots, imperative-layer pattern
 * (see MapView.tsx's ClusteredMarkers for why: react-leaflet v5 has no
 * working cluster wrapper). No clustering here — DT sessions run a few
 * thousand points at most, not 4,700+ sites, so plain CircleMarkers via
 * raw Leaflet calls are fast enough without chunked loading.
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

function CoverageDots({ samples, metric }: { samples: DtSample[]; metric: DtMetric }) {
  const map = useMap()

  useEffect(() => {
    const layer = L.layerGroup()
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
      layer.addLayer(dot)
    }
    layer.addTo(map)

    return () => {
      map.removeLayer(layer)
    }
  }, [samples, metric, map])

  return null
}

export default function DtCoverageMap({ samples, tech }: { samples: DtSample[]; tech: DtTech }) {
  const { metricsForTech } = useDtMetrics()
  const metrics = useMemo(() => metricsForTech(tech), [metricsForTech, tech])
  const [metricKey, setMetricKey] = useState(metrics[0].key)
  const activeMetric = metrics.find((m) => m.key === metricKey) ?? metrics[0]

  const withGps = useMemo(() => samples.filter((s) => s.lat != null && s.lng != null), [samples])
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
            <CoverageDots samples={samples} metric={activeMetric} />
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
    </div>
  )
}
