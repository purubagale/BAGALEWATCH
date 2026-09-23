import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { apiErrorMessage } from '../api/client'
import { useDtSessionCompare } from '../api/queries'
import type { DtCompareCell, DtSessionListItem } from '../api/types'
import { metricsForTech } from '../lib/dtBands'
import { DT_COMPARE_ORDER_REASON_LABELS, type DtCompareOrderReason } from '../lib/dtCompareAssignment'
import { deadbandFor, deltaColor, deltaStatus, directionFor } from '../lib/dtDelta'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'

const DEFAULT_CENTER: [number, number] = [28.3949, 84.124]
const DEFAULT_ZOOM = 7

function InvalidateOnResize() {
  useMapInvalidateOnResize()
  return null
}

function FitToCells({ cells }: { cells: DtCompareCell[] }) {
  const map = useMap()
  useEffect(() => {
    if (!cells.length) return
    map.fitBounds(L.latLngBounds(cells.map((c) => [c.lat, c.lng] as [number, number])), { padding: [16, 16] })
  }, [map, cells])
  return null
}

// One colored circle marker per matched grid cell — same solid-fill/
// no-stroke dot styling DtCompareMap.tsx's CompareDots already settled
// on (a stroke ring visually dominates a 5-6px dot and hides the real
// fill color at normal zoom), just colored by DIVERGING delta instead of
// an absolute band value.
function DeltaDots({
  cells,
  metricKey,
  metricLabel,
  metricUnit,
  deadband,
  direction,
}: {
  cells: DtCompareCell[]
  metricKey: string
  metricLabel: string
  metricUnit: string
  deadband: number
  direction: 1 | -1
}) {
  const map = useMap()
  useEffect(() => {
    const layer = L.layerGroup()
    for (const cell of cells) {
      const d = cell.delta[metricKey] ?? null
      const va = cell.a[metricKey] ?? null
      const vb = cell.b[metricKey] ?? null
      const color = deltaColor(d, deadband, direction)
      const status = deltaStatus(d, deadband, direction)
      const deltaText = d != null ? `${d > 0 ? '+' : ''}${d}${metricUnit}` : 'n/a'
      L.circleMarker([cell.lat, cell.lng], {
        radius: 5,
        color,
        fillColor: color,
        fillOpacity: 0.85,
        weight: 0,
      })
        .bindTooltip(
          `${metricLabel}: ${va ?? '—'}${metricUnit} → ${vb ?? '—'}${metricUnit} (Δ ${deltaText}, ${status}) — ${cell.sample_count_a}/${cell.sample_count_b} samples`,
        )
        .addTo(layer)
    }
    layer.addTo(map)
    return () => {
      map.removeLayer(layer)
    }
  }, [map, cells, metricKey, metricLabel, metricUnit, deadband, direction])

  return null
}

function reasonLabel(reason: DtCompareOrderReason): string {
  return DT_COMPARE_ORDER_REASON_LABELS[reason]
}

/** Delta (before/after) compare view (2026-09-12) — ADDITIVE to
 * DtCompareMap.tsx's existing "Overlay" mode, not a replacement. Given
 * exactly two sessions (already ordered before/after by
 * lib/dtCompareAssignment.ts, with a swap button here to flip them if
 * that auto-guess is wrong), fetches the real numeric compare from
 * `GET /api/v2/dt-sessions/compare/` (backend-django/core/drive_test.py's
 * `compare()` action) and renders one colored dot per matched grid cell
 * — colored by DIVERGING delta (green=improved, red=degraded,
 * grey=unchanged within the deadband), never by an absolute band value
 * the way Overlay's dots are. A small metric-tab row (mirroring
 * DtExploreTab.tsx's `feat-tab` metric switcher) lets the user flip
 * between a multi-metric tech's metrics (e.g. 4G's RSRP/RSRQ/SINR); the
 * summary stat row below the map always reflects whichever metric tab is
 * active, matching the per-metric shape of compare()'s own `summary`. */
export default function DtCompareDeltaMap({
  before,
  after,
  reason,
  onSwap,
}: {
  before: DtSessionListItem
  after: DtSessionListItem
  reason: DtCompareOrderReason
  onSwap: () => void
}) {
  const { data, isLoading, error } = useDtSessionCompare(before.id, after.id)
  const metrics = useMemo(() => {
    if (!data) return []
    const all = metricsForTech(before.tech)
    return all.filter((m) => data.metrics.includes(m.key))
  }, [data, before.tech])
  const [metricKey, setMetricKey] = useState<string | null>(null)

  useEffect(() => {
    if (metrics.length && (metricKey == null || !metrics.some((m) => m.key === metricKey))) {
      setMetricKey(metrics[0].key)
    }
  }, [metrics, metricKey])

  const activeMetric = metrics.find((m) => m.key === metricKey) ?? metrics[0]
  const deadband = activeMetric ? deadbandFor(activeMetric.key) : 2
  const direction = activeMetric ? directionFor(activeMetric.key) : 1

  return (
    <div>
      <div className="dt-compare-delta-header" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span>
          <strong style={{ color: '#2563eb' }}>Before:</strong> {before.name} {before.date ? `(${before.date})` : ''}
        </span>
        <span style={{ color: '#9ca3af' }}>→</span>
        <span>
          <strong style={{ color: '#dc2626' }}>After:</strong> {after.name} {after.date ? `(${after.date})` : ''}
        </span>
        <button type="button" className="btn-secondary btn-small" onClick={onSwap} title="Swap which session is Before / After">
          ⇄ Swap
        </button>
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: -6, marginBottom: 10 }}>
        Assigned automatically {reasonLabel(reason)} — use Swap if this is backwards.
      </p>

      {isLoading && <div className="page-status">Comparing sessions…</div>}
      {error && <div className="page-status page-status-error">{apiErrorMessage(error, 'Could not compare these sessions.')}</div>}

      {data && (
        <>
          {metrics.length > 1 && (
            <div className="feat-tabs" style={{ borderBottom: 'none', marginBottom: 8 }}>
              {metrics.map((m) => (
                <div key={m.key} className={m.key === metricKey ? 'feat-tab active' : 'feat-tab'} onClick={() => setMetricKey(m.key)}>
                  {m.label}
                </div>
              ))}
            </div>
          )}

          {!data.cells.length ? (
            <div className="page-status">
              No overlapping grid cells between these two sessions — their routes don't cover the same area closely enough to compare.
            </div>
          ) : (
            <>
              <MapContainer center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} className="dt-coverage-map">
                <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                <FitToCells cells={data.cells} />
                {activeMetric && (
                  <DeltaDots
                    cells={data.cells}
                    metricKey={activeMetric.key}
                    metricLabel={activeMetric.label}
                    metricUnit={activeMetric.unit}
                    deadband={deadband}
                    direction={direction}
                  />
                )}
                <InvalidateOnResize />
              </MapContainer>
              <div className="dt-legend" style={{ marginTop: 8 }}>
                <span className="dt-legend-item">
                  <span className="dt-legend-dot" style={{ background: '#16a34a' }} /> Improved (beyond {deadband}{activeMetric?.unit})
                </span>
                <span className="dt-legend-item">
                  <span className="dt-legend-dot" style={{ background: '#94a3b8' }} /> Unchanged (within {deadband}{activeMetric?.unit})
                </span>
                <span className="dt-legend-item">
                  <span className="dt-legend-dot" style={{ background: '#dc2626' }} /> Degraded (beyond {deadband}{activeMetric?.unit})
                </span>
                <span className="dt-legend-item">
                  <span className="dt-legend-dot" style={{ background: '#e2e8f0' }} /> No data one side
                </span>
              </div>
            </>
          )}

          {activeMetric && (
            <div className="report-summary-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', marginTop: 14, marginBottom: 0 }}>
              <div className="report-card">
                <div className="report-card-val">{data.summary.matched_cells}</div>
                <div className="report-card-label">Matched Cells</div>
              </div>
              <div className="report-card">
                <div className="report-card-val">
                  {data.summary.avg_delta[activeMetric.key] ?? '—'}
                  {activeMetric.unit}
                </div>
                <div className="report-card-label">Avg Δ {activeMetric.label}</div>
              </div>
              <div className="report-card">
                <div className="report-card-val" style={{ color: '#16a34a' }}>
                  {data.summary.improved_pct[activeMetric.key] ?? '—'}%
                </div>
                <div className="report-card-label">Improved</div>
              </div>
              <div className="report-card">
                <div className="report-card-val" style={{ color: '#dc2626' }}>
                  {data.summary.degraded_pct[activeMetric.key] ?? '—'}%
                </div>
                <div className="report-card-label">Degraded</div>
              </div>
              <div className="report-card">
                <div className="report-card-val">{data.summary.unchanged_pct[activeMetric.key] ?? '—'}%</div>
                <div className="report-card-label">Unchanged</div>
              </div>
              <div className="report-card">
                <div className="report-card-val">
                  {data.summary.unmatched_cells_a} / {data.summary.unmatched_cells_b}
                </div>
                <div className="report-card-label">Unmatched (Before/After)</div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
