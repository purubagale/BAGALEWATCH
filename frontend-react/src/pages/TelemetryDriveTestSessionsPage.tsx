import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  useCreateTelemetryDtSession,
  useDeleteTelemetryDtSession,
  useEndTelemetryDtSession,
  useSites,
  useTelemetryDtSessionSamples,
  useTelemetryDtSessions,
  useTelemetryLiveSamples,
} from '../api/queries'
import type { TelemetryLiveSample } from '../api/types'
import { resolveAreaQuery, type ResolvedAreaPoint } from '../lib/resolveDeviceAreaQuery'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'

// Scoped drive-test sessions over the crowdsourced telemetry pipeline
// (2026-09-01) -- the promotable, consent-scoped replacement for the
// old dev-only "Live Samples" tool (still at /telemetry-live-samples,
// superadmin-only). A session locks in a name plus a specific set of
// enrolled devices (and optionally an area box) before it starts, so
// what gets plotted here is always "the phones this engineer is
// actually driving with," not "whatever anyone nearby happened to
// upload." See core/models.py's TelemetryDriveTestSession docstring.
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
  manual: '#2563eb',
  periodic: '#16a34a',
  handover: '#f59e0b',
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
      L.circleMarker([s.lat, s.lng], { radius: 6, color, fillColor: color, fillOpacity: 0.85, weight: 1 })
        .bindTooltip(
          `${s.device_id.slice(0, 8)}... - ${new Date(s.received_at).toLocaleTimeString()} - ${s.network_type}` +
            (signal !== '-' ? ` - ${signal}` : ''),
        )
        .addTo(layer)
    }
    return () => {
      map.removeLayer(layer)
    }
  }, [map, samples])
  return null
}

const DEFAULT_SEARCH_RADIUS_KM = 2

// Search-an-area device enrollment (2026-09-02 request: "like in dt data
// manager, explore where can search or select certain area displays the
// plot, here display and list registered device on the searched or
// selected area... only fetch data from those selected devices only").
// Reuses DT Explore's search-box interaction (approved via
// AskUserQuestion) -- a text query (coordinates, Site ID/name, or
// city/district) plus a radius in km -- to narrow the enrollable-device
// checklist down to devices with a recent sample near that resolved
// point, instead of always listing every device active anywhere in the
// last 30 minutes.
function NewSessionForm({ onCreated }: { onCreated: (id: number) => void }) {
  const { data: sites } = useSites()
  const [query, setQuery] = useState('')
  const [radiusKm, setRadiusKm] = useState(DEFAULT_SEARCH_RADIUS_KM)
  const [resolved, setResolved] = useState<ResolvedAreaPoint | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)

  const { data: liveData } = useTelemetryLiveSamples(
    resolved
      ? { minutes: 30, lat: resolved.lat, lng: resolved.lng, radius_km: radiusKm }
      : { minutes: 30 },
  )
  const createSession = useCreateTelemetryDtSession()
  const [name, setName] = useState('')
  const [selectedDevices, setSelectedDevices] = useState<string[]>([])
  const [requireConsent, setRequireConsent] = useState(false)
  const recentDevices = liveData?.devices ?? []

  const runSearch = () => {
    if (!query.trim()) {
      setResolved(null)
      setSearchError(null)
      return
    }
    const point = resolveAreaQuery(query, sites ?? [])
    if (!point) {
      setSearchError(`Couldn't resolve "${query}" to coordinates, a Site ID/name, or a city/district.`)
      return
    }
    setSearchError(null)
    setResolved(point)
  }

  const clearSearch = () => {
    setQuery('')
    setResolved(null)
    setSearchError(null)
  }

  const toggleDevice = (d: string) => {
    setSelectedDevices((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))
  }

  const submit = () => {
    if (!name.trim() || selectedDevices.length === 0) return
    createSession.mutate(
      { name: name.trim(), device_ids: selectedDevices, require_consent: requireConsent },
      {
        onSuccess: (session) => {
          setName('')
          setSelectedDevices([])
          setRequireConsent(false)
          onCreated(session.id)
        },
      },
    )
  }

  return (
    <div className="edit-grid" style={{ gridTemplateColumns: '1fr', gap: 10, marginBottom: 16 }}>
      <label>
        Session name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kathmandu ring-road pass 1" />
      </label>
      <div>
        <div className="muted" style={{ marginBottom: 4 }}>
          Search an area to narrow enrollable devices (optional -- leave blank to see every device active in the last
          30 minutes)
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch()
            }}
            placeholder="Coordinates, Site ID/name, or city/district (e.g. 27.7172, 85.3240)"
            style={{ flex: '1 1 320px' }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            radius
            <input
              type="number"
              min={0.1}
              max={50}
              step={0.5}
              value={radiusKm}
              onChange={(e) => setRadiusKm(Math.max(0.1, Math.min(50, Number(e.target.value) || DEFAULT_SEARCH_RADIUS_KM)))}
              style={{ width: 64 }}
            />
            km
          </label>
          <button className="btn-secondary btn-small" onClick={runSearch}>
            Search
          </button>
          {resolved && (
            <button className="btn-secondary btn-small" onClick={clearSearch}>
              Clear
            </button>
          )}
        </div>
        {searchError && (
          <p className="muted" style={{ fontSize: 11, margin: '4px 0 0', color: '#b91c1c' }}>
            {searchError}
          </p>
        )}
        {resolved && (
          <p className="muted" style={{ fontSize: 11, margin: '4px 0 0' }}>
            Showing devices within {radiusKm}km of {resolved.label}
          </p>
        )}
      </div>
      <div>
        <div className="muted" style={{ marginBottom: 4 }}>
          {resolved
            ? `Devices found in this area (active in the last 30 minutes)`
            : `Enrolled devices (active in the last 30 minutes -- have the test phone(s) send at least one sample first)`}
        </div>
        {recentDevices.length === 0 ? (
          <div className="page-status">
            {resolved
              ? 'No active devices found in this area. Try a larger radius, or a different search.'
              : 'No active devices seen recently. Send a sample from the test phone, then reload.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {recentDevices.map((d) => (
              <label key={d} className="btn-secondary btn-small" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={selectedDevices.includes(d)}
                  onChange={() => toggleDevice(d)}
                  style={{ marginRight: 6 }}
                />
                {d.slice(0, 12)}...
              </label>
            ))}
          </div>
        )}
      </div>
      <label style={{ cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={requireConsent}
          onChange={(e) => setRequireConsent(e.target.checked)}
          style={{ marginRight: 6 }}
        />
        Require rider consent before including their data
      </label>
      {requireConsent && (
        <p className="muted" style={{ fontSize: 11, margin: 0 }}>
          Only devices that have separately accepted (via the app's own consent prompt, wired to
          NetTelemetry.setDriveTestConsent()) will appear in this session's results -- an enrolled device that hasn't
          accepted yet, or that later withdraws, is simply left out, not shown as an error. Consent is asked on the
          device itself, not pushed from here -- enrolling a device here means "include it if/when it consents," the
          same as leaving consent off just without the gate.
        </p>
      )}
      <button
        className="btn-primary"
        disabled={!name.trim() || selectedDevices.length === 0 || createSession.isPending}
        onClick={submit}
        style={{ width: 'fit-content' }}
      >
        {createSession.isPending
          ? 'Starting...'
          : selectedDevices.length > 0
            ? `Start session with ${selectedDevices.length} selected`
            : 'Start session'}
      </button>
    </div>
  )
}

export default function TelemetryDriveTestSessionsPage() {
  const { data: sessions, isLoading } = useTelemetryDtSessions()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const { data: samplesData } = useTelemetryDtSessionSamples(selectedId)
  const endSession = useEndTelemetryDtSession()
  const deleteSession = useDeleteTelemetryDtSession()
  const samples = useMemo(() => samplesData?.samples ?? [], [samplesData])
  const mapKey = `${selectedId}|${samples.length}`

  return (
    <div className="admin-page" style={{ maxWidth: 1200 }}>
      <h1>Telemetry Drive Test</h1>
      <p className="muted">
        Live, scoped drive-test sessions over the crowdsourced telemetry pipeline. Enroll specific test devices, start
        a session, and watch their points land in real time -- unlike the raw Live Samples dev tool, this only ever
        shows devices you explicitly enrolled for this run.
      </p>

      <NewSessionForm onCreated={setSelectedId} />

      {isLoading && <div className="page-status">Loading sessions...</div>}
      {!isLoading && (sessions ?? []).length === 0 && <div className="page-status">No sessions yet -- start one above.</div>}

      {(sessions ?? []).length > 0 && (
        <table className="admin-table" style={{ marginBottom: 16 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Devices</th>
              <th>Consent</th>
              <th>Started</th>
              <th>Ended</th>
              <th>Started by</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(sessions ?? []).map((s) => (
              <tr key={s.id} style={selectedId === s.id ? { fontWeight: 600 } : undefined}>
                <td>
                  <button className="btn-link" onClick={() => setSelectedId(s.id)}>
                    {s.name}
                  </button>
                </td>
                <td>{s.status}</td>
                <td>{s.device_ids.length}</td>
                <td>{s.require_consent ? 'Required' : '-'}</td>
                <td>{new Date(s.started_at).toLocaleString()}</td>
                <td>{s.ended_at ? new Date(s.ended_at).toLocaleString() : '-'}</td>
                <td>{s.created_by_name ?? '-'}</td>
                <td>
                  {s.status === 'active' && (
                    <>
                      <button
                        className="btn-secondary btn-small"
                        onClick={() => endSession.mutate({ id: s.id })}
                      >
                        End
                      </button>{' '}
                      <button
                        className="btn-secondary btn-small"
                        title="Ends the session AND requests every enrolled device opt itself out of telemetry entirely -- applied on each device's next upload, not immediately."
                        onClick={() => {
                          if (
                            window.confirm(
                              `End "${s.name}" and request opt-out for all ${s.device_ids.length} enrolled device(s)? Each device will stop collecting telemetry once it next checks in.`,
                            )
                          ) {
                            endSession.mutate({ id: s.id, requestOptOut: true })
                          }
                        }}
                      >
                        End &amp; opt out
                      </button>
                    </>
                  )}{' '}
                  <button
                    className="btn-secondary btn-small"
                    onClick={() => {
                      deleteSession.mutate(s.id)
                      if (selectedId === s.id) setSelectedId(null)
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedId != null && (
        <>
          {samplesData?.require_consent && samplesData.consent_summary && (
            <p className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
              Consent required for this session -- {samplesData.consent_summary.consented} of{' '}
              {samplesData.consent_summary.consented + samplesData.consent_summary.pending} enrolled device(s) have
              accepted; the rest are excluded until they do.
            </p>
          )}
          {samples.length === 0 ? (
            <div className="page-status">No samples for this session yet.</div>
          ) : (
            <MapContainer key={mapKey} center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} className="dt-coverage-map">
              <InvalidateOnResize />
              <FitToSamples samples={samples} />
              <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <SamplePoints samples={samples} />
            </MapContainer>
          )}
          <table className="admin-table" style={{ marginTop: 16 }}>
            <thead>
              <tr>
                <th>Device</th>
                <th>Sample time (ts)</th>
                <th>Network</th>
                <th>Operator (MCC/MNC)</th>
                <th>Signal</th>
                <th>Lat</th>
                <th>Lng</th>
              </tr>
            </thead>
            <tbody>
              {samples.slice(0, 50).map((s, i) => (
                <tr key={i}>
                  <td>{s.device_id.slice(0, 12)}...</td>
                  <td>{new Date(s.ts).toLocaleTimeString()}</td>
                  <td>{s.network_type}</td>
                  <td>{s.mcc || s.mnc ? `${s.mcc || '-'}/${s.mnc || '-'}` : '-'}</td>
                  {/* formatSignal (see above): RSRP for LTE/NR, RxLevel+RxQual
                      for GSM, RSCP+Ec/Io for WCDMA (falling back to RSSI on
                      pre-Android-10 devices where those aren't available). */}
                  <td>{formatSignal(s)}</td>
                  <td>{s.lat?.toFixed(5)}</td>
                  <td>{s.lng?.toFixed(5)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            {samples.length.toLocaleString()} sample(s) for this session -- auto-refreshes every 10s
          </p>
        </>
      )}
    </div>
  )
}
