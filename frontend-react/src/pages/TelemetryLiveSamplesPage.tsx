import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useTelemetryLiveSamples } from '../api/queries'
import type { TelemetryLiveSample } from '../api/types'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'

// Telemetry Live Samples (dev/pilot-testing tool) -- raw, ungrouped
// points from core/telemetry_admin.py's TelemetryLiveSamplesView
// (/api/v2/telemetry/live-samples/), NOT the production Coverage page.
//
// Deliberately kept out of the seeded MenuItem list (migration
// 0041_seed_telemetry_menuitems.py) -- it exposes individual device_id
// and raw location, which the project brief says never to expose as a
// permanent feature (see TelemetryCoverageView's aggregate-only design).
// Reached only via a direct link from Telemetry Admin, superadmin-gated
// the same way the endpoint itself is. Purely for verifying "did my test
// device's last upload actually land with a real GPS fix" -- not a
// coverage or subscriber-tracking feature.
const DEFAULT_CENTER: [number, number] = [27.7, 85.32]
const DEFAULT_ZOOM = 12

function InvalidateOnResize() {
  useMapInvalidateOnResize()
  return null
}

function FitToSamples({ samples }: { samples: TelemetryLiveSample[] }) {
  const map = useMap()
  useEffect(() => {
    const pts = samples
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => [s.lat as number, s.lng as number] as [number, number])
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [24, 24], maxZoom: 16, animate: false })
  }, [map, samples])
  return null
}

const TRIGGER_COLORS: Record<string, string> = {
  Manual: '#2563eb',
  Periodic: '#16a34a',
  Handover: '#f59e0b',
}

// formatSignal (2026-09-03, "for 2g, rx level and rx qual and for 3g rscp
// and ec/io" + "for 4g/5g, not only RSRP, also RSRQ and SINR") -- each RAT
// gets its own proper set of RAN-standard metrics rather than one
// single-value label: LTE/NR shows RSRP+RSRQ+SINR together, GSM shows
// RxLevel (the rssi_dbm field, relabeled to its proper RAN name) + RxQual,
// WCDMA shows RSCP + Ec/Io (only ever populated on Android 10+ devices --
// see CellSampleCollector.kt -- so an older-device WCDMA reading falls
// back to its RSSI instead of showing nothing).
function formatSignal(s: TelemetryLiveSample): string {
  if (s.network_type === 'GSM') {
    const parts: string[] = []
    if (s.rssi_dbm != null) parts.push(`RxLevel ${s.rssi_dbm} dBm`)
    if (s.rx_qual != null) parts.push(`RxQual ${s.rx_qual}`)
    return parts.length ? parts.join(', ') : '-'
  }
  if (s.network_type === 'UMTS') {
    const parts: string[] = []
    if (s.rscp_dbm != null) parts.push(`RSCP ${s.rscp_dbm} dBm`)
    if (s.ecio_db != null) parts.push(`Ec/Io ${s.ecio_db} dB`)
    if (!parts.length && s.rssi_dbm != null) parts.push(`${s.rssi_dbm} dBm (RSSI)`)
    return parts.length ? parts.join(', ') : '-'
  }
  if (s.rsrp_dbm != null || s.rsrq_db != null || s.sinr_db != null) {
    const parts: string[] = []
    if (s.rsrp_dbm != null) parts.push(`RSRP ${s.rsrp_dbm} dBm`)
    if (s.rsrq_db != null) parts.push(`RSRQ ${s.rsrq_db} dB`)
    if (s.sinr_db != null) parts.push(`SINR ${s.sinr_db} dB`)
    return parts.join(', ')
  }
  if (s.rssi_dbm != null) return `${s.rssi_dbm} dBm (RSSI)`
  return '-'
}

function SamplePoints({ samples }: { samples: TelemetryLiveSample[] }) {
  const map = useMap()
  useEffect(() => {
    const layer = L.layerGroup().addTo(map)
    for (const s of samples) {
      if (s.lat == null || s.lng == null) continue
      const color = TRIGGER_COLORS[s.trigger_reason] ?? '#64748b'
      const signal = formatSignal(s)
      L.circleMarker([s.lat, s.lng], {
        radius: 6,
        color,
        fillColor: color,
        fillOpacity: 0.85,
        weight: 1,
      })
        .bindTooltip(
          `${s.device_id.slice(0, 8)}... - ${new Date(s.received_at).toLocaleTimeString()} - ${s.network_type}` +
            (signal !== '-' ? ` - ${signal}` : '') +
            ` - ${s.trigger_reason}`,
        )
        .addTo(layer)
    }
    return () => {
      map.removeLayer(layer)
    }
  }, [map, samples])
  return null
}

export default function TelemetryLiveSamplesPage() {
  const [minutes, setMinutes] = useState(60)
  const [deviceId, setDeviceId] = useState('')
  const { data, isLoading, error } = useTelemetryLiveSamples({ minutes, device_id: deviceId || undefined })
  const samples = useMemo(() => data?.samples ?? [], [data])
  const mapKey = `${minutes}|${deviceId}|${samples.length}`

  return (
    <div className="admin-page" style={{ maxWidth: 1200 }}>
      <h1>Telemetry Live Samples</h1>
      <p className="muted">
        Raw, ungrouped telemetry points from the last window -- a dev tool for verifying that a test device's
        uploads are actually landing with a real GPS fix. Not the production Coverage map (that only shows
        aggregated cells); this shows individual points and refreshes automatically every 10s.
      </p>
      <div className="edit-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 12 }}>
        <label>
          Window
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            <option value={15}>Last 15 minutes</option>
            <option value={60}>Last hour</option>
            <option value={360}>Last 6 hours</option>
            <option value={1440}>Last 24 hours</option>
          </select>
        </label>
        <label>
          Device
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">All devices</option>
            {(data?.devices ?? []).map((d) => (
              <option key={d} value={d}>
                {d.slice(0, 12)}...
              </option>
            ))}
          </select>
        </label>
      </div>
      {isLoading && <div className="page-status">Loading live samples...</div>}
      {error && <div className="page-status page-status-error">Could not load live samples.</div>}
      {!isLoading && !error && (
        <>
          {samples.length === 0 ? (
            <div className="page-status">No samples with a location in this window yet.</div>
          ) : (
            <MapContainer key={mapKey} center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} className="dt-coverage-map">
              <InvalidateOnResize />
              <FitToSamples samples={samples} />
              <TileLayer
                attribution="&copy; OpenStreetMap contributors"
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <SamplePoints samples={samples} />
            </MapContainer>
          )}
          <table className="admin-table" style={{ marginTop: 16 }}>
            <thead>
              <tr>
                <th>Device</th>
                <th>Sample time (ts)</th>
                <th>Received at</th>
                <th>Network</th>
                <th>Operator (MCC/MNC)</th>
                <th>Signal</th>
                <th>Lat</th>
                <th>Lng</th>
                <th>Trigger</th>
              </tr>
            </thead>
            <tbody>
              {samples.slice(0, 50).map((s, i) => (
                <tr key={i}>
                  <td>{s.device_id.slice(0, 12)}...</td>
                  <td>{new Date(s.ts).toLocaleTimeString()}</td>
                  <td>{new Date(s.received_at).toLocaleTimeString()}</td>
                  <td>{s.network_type}</td>
                  <td>{s.mcc || s.mnc ? `${s.mcc || '-'}/${s.mnc || '-'}` : '-'}</td>
                  {/* formatSignal (see above): RSRP for LTE/NR, RxLevel+RxQual
                      for GSM, RSCP+Ec/Io for WCDMA (falling back to RSSI on
                      pre-Android-10 devices where those aren't available). */}
                  <td>{formatSignal(s)}</td>
                  <td>{s.lat?.toFixed(5)}</td>
                  <td>{s.lng?.toFixed(5)}</td>
                  <td>{s.trigger_reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            {samples.length.toLocaleString()} sample(s) in the last {minutes} minute(s) - auto-refreshes every 10s
          </p>
        </>
      )}
    </div>
  )
}


