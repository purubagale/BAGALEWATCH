import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useTelemetryCoverage } from '../api/queries'
import type { TelemetryCoverageBin } from '../api/types'
import { RSRP_BANDS, RSRQ_BANDS, SINR_BANDS, bandColor, type Band } from '../lib/dtBands'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'

// Telemetry Coverage (2026-08-31) — geohash-binned crowdsourced-telemetry
// signal on a map. Data from core/telemetry_admin.py's
// TelemetryCoverageView (/api/v2/telemetry/coverage/): it returns the
// already-rolled-up TelemetryCoverageBin rows when they exist, and
// otherwise aggregates recent raw TelemetrySample rows on the fly (so
// this page is useful before prune_telemetry.py has ever run) — the
// `source` field says which.
//
// access='admin' on the MenuItem (migration 0041_seed_telemetry_menuitems
// .py), same tier as Live Site Sync's status view — no separate
// isAllowed() check needed inside the page.

const DEFAULT_CENTER: [number, number] = [28.3949, 84.124]
const DEFAULT_ZOOM = 7

type MetricKey = 'rsrp' | 'rsrq' | 'sinr'

interface Metric {
  key: MetricKey
  label: string
  unit: string
  bands: Band[]
  value: (b: TelemetryCoverageBin) => number | null
}

const METRICS: Metric[] = [
  { key: 'rsrp', label: 'RSRP', unit: ' dBm', bands: RSRP_BANDS, value: (b) => b.rsrp_mean },
  { key: 'rsrq', label: 'RSRQ', unit: ' dB', bands: RSRQ_BANDS, value: (b) => b.rsrq_mean },
  { key: 'sinr', label: 'SINR', unit: ' dB', bands: SINR_BANDS, value: (b) => b.sinr_mean },
]

function InvalidateOnResize() {
  useMapInvalidateOnResize()
  return null
}

function FitToBins({ bins }: { bins: TelemetryCoverageBin[] }) {
  const map = useMap()
  useEffect(() => {
    const pts = bins
      .filter((b) => b.lat != null && b.lng != null)
      .map((b) => [b.lat as number, b.lng as number] as [number, number])
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [24, 24], maxZoom: 15, animate: false })
  }, [map, bins])
  return null
}

function CoverageBins({ bins, metric }: { bins: TelemetryCoverageBin[]; metric: Metric }) {
  const map = useMap()
  useEffect(() => {
    const layer = L.layerGroup().addTo(map)
    for (const b of bins) {
      if (b.lat == null || b.lng == null) continue
      const v = metric.value(b)
      const color = bandColor(metric.bands, v)
      const valueText = v != null ? `${v}${metric.unit}` : 'No data'
      L.circleMarker([b.lat, b.lng], {
        radius: 5,
        color,
        fillColor: color,
        fillOpacity: 0.8,
        weight: 0,
      })
        .bindTooltip(
          `${metric.label}: ${valueText} · ${b.network_type} · ${b.sample_count.toLocaleString()} samples` +
            (b.region ? ` · ${b.region}` : ''),
        )
        .addTo(layer)
    }
    return () => {
      map.removeLayer(layer)
    }
  }, [map, bins, metric])
  return null
}

export default function TelemetryCoveragePage() {
  const [metricKey, setMetricKey] = useState<MetricKey>('rsrp')
  const [network, setNetwork] = useState('')
  const [region, setRegion] = useState('')
  const [days, setDays] = useState(30)

  const { data, isLoading, error } = useTelemetryCoverage({
    network_type: network || undefined,
    region: region || undefined,
    days,
  })

  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0]
  const bins = useMemo(() => data?.bins ?? [], [data])
  // Remount the Leaflet instance when the dataset identity changes so it
  // reframes cleanly instead of reusing a view built for a different set.
  const mapKey = `${network}|${region}|${days}|${bins.length}`

  return (
    <div className="admin-page" style={{ maxWidth: 1200 }}>
      <h1>Telemetry Coverage</h1>
      <p className="muted">
        Crowdsourced-telemetry signal, aggregated into ~150&nbsp;m geohash cells. Each dot is one cell, colored by its
        mean {metric.label} for the selected network.
      </p>

      <div className="edit-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 12 }}>
        <label>
          Network
          <select value={network} onChange={(e) => setNetwork(e.target.value)}>
            <option value="">All networks</option>
            {(data?.networks ?? []).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Region
          <select value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">All regions</option>
            {(data?.regions ?? []).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label>
          Raw-fallback window
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
          </select>
        </label>
      </div>

      <div className="dt-metric-tabs">
        {METRICS.map((m) => (
          <button
            key={m.key}
            type="button"
            className={`dt-metric-tab${m.key === metric.key ? ' active' : ''}`}
            onClick={() => setMetricKey(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {isLoading && <div className="page-status">Loading coverage…</div>}
      {error && <div className="page-status page-status-error">Could not load coverage data.</div>}

      {!isLoading && !error && (
        <>
          {bins.length === 0 ? (
            <div className="page-status">
              No telemetry samples in range yet. Once devices start uploading (see Telemetry Admin for an ingest
              key), cells will appear here.
            </div>
          ) : (
            <MapContainer key={mapKey} center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} className="dt-coverage-map">
              <InvalidateOnResize />
              <FitToBins bins={bins} />
              <TileLayer
                attribution="&copy; OpenStreetMap contributors"
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <CoverageBins bins={bins} metric={metric} />
            </MapContainer>
          )}

          <div className="dt-legend">
            {metric.bands.map((b) => (
              <span key={b.label} className="dt-legend-item">
                <span className="dt-legend-dot" style={{ background: b.color }} />
                {b.label}
                {metric.unit}
              </span>
            ))}
            <span className="dt-legend-item">
              <span className="dt-legend-dot" style={{ background: '#94a3b8' }} />
              No data
            </span>
          </div>

          <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            {bins.length.toLocaleString()} cell(s) shown
            {data?.source === 'samples' && (
              <> · aggregated live from raw samples (retention has not rolled these into coverage bins yet)</>
            )}
            {data?.source === 'bins' && <> · from stored coverage bins</>}
            {data?.truncated && <> · result truncated — narrow the filters for full coverage</>}
          </p>
        </>
      )}
    </div>
  )
}
