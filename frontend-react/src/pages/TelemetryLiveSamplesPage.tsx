import { useEffect, useMemo, useRef, useState } from 'react'
import BaseMap from '../components/BaseMap'
import SpeedRatings, { loadedLabel } from '../components/SpeedRatings'
import { MapContainer, useMap } from 'react-leaflet'
import { useSearchParams } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useTelemetryLiveSamples, useTelemetrySpeedResults } from '../api/queries'
import type { TelemetryLiveSample } from '../api/types'
import NeighbourCellsCell from '../components/NeighbourCellsCell'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'
import { CQI_COLUMN_HINT, cqiLabel } from '../lib/cqiDisplay'

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

// `fitKey` (2026-10-02 perf follow-up) -- identifies "which filter
// selection is this," NOT "which samples arrived." Fits bounds once per
// filter change (first time samples are available after that change),
// not on every poll -- previously this ran on every `samples` reference
// change (i.e. every 10s poll that returned anything), which kept
// silently re-centering/re-zooming the map out from under a user who had
// manually panned/zoomed to look at something specific.
function FitToSamples({ samples, fitKey }: { samples: TelemetryLiveSample[]; fitKey: string }) {
  const map = useMap()
  const firstFitDone = useRef<string | null>(null)
  useEffect(() => {
    if (firstFitDone.current === fitKey) return
    const pts = samples
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => [s.lat as number, s.lng as number] as [number, number])
    if (pts.length) {
      map.fitBounds(L.latLngBounds(pts), { padding: [24, 24], maxZoom: 16, animate: false })
      firstFitDone.current = fitKey
    }
  }, [map, samples, fitKey])
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

// Everything the server keeps for one device (raw readings are kept 90 days).
const ALL_STORED_MINUTES = 90 * 24 * 60

export default function TelemetryLiveSamplesPage() {
  // ?minutes= sets the window; with one device it may cover everything stored (2026-10-15).
  const [searchParamsInit] = useSearchParams()
  const [minutes, setMinutes] = useState(() => Number(searchParamsInit.get('minutes')) || 60)
  // ?device= opens the page on one device, e.g. from Subscriber Profile (2026-10-15).
  const [searchParams] = useSearchParams()
  const [deviceId, setDeviceId] = useState(searchParams.get('device') ?? '')
  // One device: up to 5000 readings, so a phone's whole stored history fits (2026-10-15).
  const { data, isLoading, error } = useTelemetryLiveSamples({ minutes, device_id: deviceId || undefined, limit: deviceId ? 5000 : undefined })
  const samples = useMemo(() => data?.samples ?? [], [data])
  // 2026-10-02 perf follow-up: `samples.length` deliberately dropped from
  // this key -- it used to be `${minutes}|${deviceId}|${samples.length}`,
  // which remounted the ENTIRE Leaflet map (tiles, zoom/pan state, event
  // handlers) on every single poll that returned a different sample
  // count, i.e. nearly every 10s tick. The map should only remount on an
  // actual filter change; new data arriving is handled by SamplePoints'
  // own marker redraw and FitToSamples' own once-per-filter-change fit.
  const mapKey = `${minutes}|${deviceId}`

  return (
    <div className="admin-page" style={{ maxWidth: 1200 }}>
      <h1>Telemetry Live Samples</h1>
      <p className="muted">
        Individual signal samples from the selected window, for checking that a test device's uploads are arriving
        with a GPS fix. The Coverage map shows averaged cells; this shows each point and refreshes every 10 seconds.
      </p>
      <div className="edit-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 12 }}>
        <label>
          Window
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            <option value={15}>Last 15 minutes</option>
            <option value={60}>Last hour</option>
            <option value={360}>Last 6 hours</option>
            <option value={1440}>Last 24 hours</option>
            {deviceId && <option value={ALL_STORED_MINUTES}>All stored readings (this device)</option>}
          </select>
        </label>
        <label>
          Device
          <select
            value={deviceId}
            onChange={(e) => {
              setDeviceId(e.target.value)
              // "All stored" is for one device only; all devices go back to 24 hours.
              if (!e.target.value && minutes > 1440) setMinutes(1440)
            }}
          >
            <option value="">All devices</option>
            {deviceId && !(data?.devices ?? []).includes(deviceId) && <option value={deviceId}>{deviceId.slice(0, 12)}...</option>}
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
              <FitToSamples samples={samples} fitKey={mapKey} />
              <BaseMap />
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
                <th title="Operating band the phone was on: band number and MHz. Empty for readings sent by an older app">Band</th>
                <th title="Channel width of the serving cell; with more than one carrier in use, how many and their total. Empty on 2G/3G, older phones and older app versions">Bandwidth</th>
                <th title="Other cells the phone heard with this reading, and the site each was matched to. Click to list them. Empty on older app versions">Neighbours</th>
                <th>Operator (MCC/MNC)</th>
                <th>Signal</th>
                {/* Reported by the phone, else estimated from SINR, else from RSRQ (2026-10-14). */}
                <th title={CQI_COLUMN_HINT}>CQI (4G)</th>
                <th>Lat</th>
                <th>Lng</th>
                <th>Trigger</th>
                <th title="Signed: sent by a registered phone. Shared key: sent with the app's common key. Flagged readings (jump: moved impossibly fast; burst: too frequent) are left out of coverage and complaint checks">Check</th>
              </tr>
            </thead>
            <tbody>
              {samples.slice(0, 50).map((s, i) => (
                <tr key={i}>
                  <td>{s.device_id.slice(0, 12)}...</td>
                  <td>{new Date(s.ts).toLocaleTimeString()}</td>
                  <td>{new Date(s.received_at).toLocaleTimeString()}</td>
                  <td>{s.network_type}</td>
                  <td>{s.band_label || '-'}</td>
                  <td>{s.bandwidth_label || '-'}</td>
                  <td><NeighbourCellsCell cells={s.neighbours} /></td>
                  <td>{s.mcc || s.mnc ? `${s.mcc || '-'}/${s.mnc || '-'}` : '-'}</td>
                  {/* formatSignal (see above): RSRP for LTE/NR, RxLevel+RxQual
                      for GSM, RSCP+Ec/Io for WCDMA (falling back to RSSI on
                      pre-Android-10 devices where those aren't available). */}
                  <td>{formatSignal(s)}</td>
                  <td>{s.network_type === 'LTE' && s.cqi_value != null ? cqiLabel({ cqi_value: s.cqi_value, cqi_source: s.cqi_source ?? null }) : '-'}</td>
                  <td>{s.lat?.toFixed(5)}</td>
                  <td>{s.lng?.toFixed(5)}</td>
                  <td>{s.trigger_reason}</td>
                  <td>{s.flag ? <span className="error" title="Left out of coverage and complaint checks">{s.flag === 'jump' ? 'Jump' : 'Too frequent'}</span>
                    : s.signed ? 'Signed' : s.signed === false ? 'Shared key' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            {samples.length.toLocaleString()} sample(s) in the last {minutes} minute(s) - auto-refreshes every 10s
          </p>
        </>
      )}
      <SpeedResultsSection minutes={minutes} deviceId={deviceId} />
    </div>
  )
}

// Speed tests from the phones in the same window (2026-10-15). Before, they
// showed only inside a Telemetry Drive Test session covering that phone and
// time. Only tests run over mobile data while sharing reach the server.
function SpeedResultsSection({ minutes, deviceId }: { minutes: number; deviceId: string }) {
  const { data, isLoading, error } = useTelemetrySpeedResults(minutes, deviceId || undefined)
  const results = data?.results ?? []
  return (
    <section style={{ marginTop: 24 }}>
      <h2>Speed tests</h2>
      <p className="muted" style={{ fontSize: 12 }}>
        Speed tests the phones ran in the same period while sharing. A Wi-Fi result measures the Wi-Fi, not NTC's mobile network.
      </p>
      {isLoading && <div className="page-status">Loading speed tests...</div>}
      {error && <div className="page-status page-status-error">Could not load speed tests.</div>}
      {data && results.length === 0 && <div className="page-status">No speed tests in this period.</div>}
      {results.length > 0 && (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Time</th>
              <th>Over</th>
              <th>Download (Mbps)</th>
              <th>Upload (Mbps)</th>
              <th>Ping (ms)</th>
              <th>Jitter (ms)</th>
              <th>Loss (%)</th>
              <th title="Ping while the download / the upload runs">Ping under load</th>
              <th title="Browsing, video streaming, gaming, video calls">Good for</th>
              <th>Radio</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={i}>
                <td>{r.device_id.slice(0, 12)}...</td>
                <td>{new Date(r.ts).toLocaleString()}</td>
                <td>{r.bearer === 'wifi' ? 'Wi-Fi' : r.bearer === 'mobile' ? 'Mobile data' : '-'}</td>
                <td>{r.download_mbps ?? '-'}</td>
                <td>{r.upload_mbps ?? '-'}</td>
                <td>{r.ping_median_ms ?? '-'}</td>
                <td>{r.jitter_ms ?? '-'}</td>
                <td>{r.packet_loss_pct ?? '-'}</td>
                <td className="mono">{loadedLabel(r.latency_down_ms, r.latency_up_ms)}</td>
                <td><SpeedRatings ratings={r.ratings} compact /></td>
                <td>{[r.network_type, r.rsrp_dbm != null ? `${r.rsrp_dbm} dBm` : ''].filter(Boolean).join(' ') || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}


