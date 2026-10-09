import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { apiErrorMessage } from '../api/client'
import type { DeviceLocationTraceSource } from '../api/types'
import { useDeviceLocationTrace, useEmergencyStatus } from '../api/queries'
import { EmergencySwitchPanel } from './RescuePolicyPage'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'

function InvalidateOnResize() {
  useMapInvalidateOnResize()
  return null
}

const SOURCE_LABELS: Record<DeviceLocationTraceSource, string> = {
  telemetry: 'Shared signal samples',
  rescue_enrolment: 'Rescue enrolment',
  trace: 'Trace request',
}

const LINK_LABELS: Record<string, string> = {
  identity_upload: 'identity upload',
  registered_phone: 'registered phone',
  rescue_enrolment: 'rescue enrolment',
  trace_request: 'trace request',
}

// Same single-pin, auto-opened-popup pattern as RescueLookupPage.tsx's own
// ResultMarker (and the same reason for a plain L.circleMarker instead of
// react-leaflet's <Marker>: its default icon assets don't resolve through
// this project's bundler setup).
function ResultMarker({
  lat, lng, networkType, ts,
}: {
  lat: number
  lng: number
  networkType: string | null | undefined
  ts: string | undefined
}) {
  const map = useMap()
  useEffect(() => {
    map.setView([lat, lng], 16, { animate: false })
    const popupHtml = [
      `<strong>${lat.toFixed(5)}, ${lng.toFixed(5)}</strong>`,
      networkType ? `Network: ${networkType}` : null,
      ts ? `Fix time: ${new Date(ts).toLocaleString()}` : null,
    ].filter(Boolean).join('<br/>')
    const marker = L.circleMarker([lat, lng], {
      radius: 9,
      color: '#7c3aed',
      fillColor: '#7c3aed',
      fillOpacity: 0.85,
      weight: 2,
    })
      .bindPopup(popupHtml, { autoClose: false, closeOnClick: false })
      .addTo(map)
    marker.openPopup()
    return () => {
      map.removeLayer(marker)
    }
  }, [map, lat, lng, networkType, ts])
  return null
}

// Device Location Trace (2026-10-08) -- superadmin-only, a DELIBERATE,
// separate lane from Rescue Lookup (core/device_lookup.py's own module
// docstring has the full reasoning): no rescue-location consent. Works
// only during a declared emergency, with a case reference (2026-10-08).
// Resolves whatever MSISDN/IMEI a device uploaded as its own
// identity (the crowd/staff identity upload) to that device's latest
// position in the regular anonymous telemetry pipeline. Reachable only
// via its own MenuItem (access='superadmin'), so no separate client-side
// role check is needed here -- same reasoning every other superadmin-only
// page in this app documents.
export default function DeviceLocationTracePage() {
  const trace = useDeviceLocationTrace()
  const emergency = useEmergencyStatus()
  const [mode, setMode] = useState<'msisdn' | 'imei'>('msisdn')
  const [value, setValue] = useState('')
  const [caseReference, setCaseReference] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const emergencyActive = emergency.data?.active === true

  async function handleSearch() {
    setFormError(null)
    const v = value.trim()
    const ref = caseReference.trim()
    if (!v || !ref) {
      setFormError(`Enter a ${mode === 'msisdn' ? 'phone number' : 'IMEI'} and a case reference.`)
      return
    }
    try {
      await trace.mutateAsync(
        mode === 'msisdn' ? { msisdn: v, case_reference: ref } : { imei: v, case_reference: ref },
      )
    } catch (err) {
      setFormError(apiErrorMessage(err, 'Could not run the trace.'))
    }
  }

  const result = trace.data

  return (
    <div className="admin-page">
      <h1>Device Location Trace</h1>
      <p className="muted">
        Resolves a phone number or IMEI to the device's latest position from the regular telemetry pipeline --
        separate from Rescue Lookup, which only ever searches devices that separately opted in to the Rescue
        Location beacon. It works only while an emergency is declared, and every search needs a case reference.
        Every search is permanently logged with your account and the case reference, whether or not it finds
        anything.
      </p>

      <EmergencySwitchPanel />

      {emergency.data && !emergencyActive && (
        <p className="page-status">Search is off until an emergency is declared above.</p>
      )}

      <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="radio" checked={mode === 'msisdn'} onChange={() => setMode('msisdn')} />
          Phone number (MSISDN)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="radio" checked={mode === 'imei'} onChange={() => setMode('imei')} />
          IMEI
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSearch()
          }}
          placeholder={mode === 'msisdn' ? '+977...' : '15-digit IMEI'}
          style={{ flex: '1 1 280px' }}
        />
        <input
          value={caseReference}
          onChange={(e) => setCaseReference(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSearch()
          }}
          placeholder="Case reference"
          maxLength={120}
          style={{ flex: '1 1 200px' }}
        />
        <button className="btn-primary" onClick={handleSearch} disabled={trace.isPending || !emergencyActive}>
          {trace.isPending ? 'Searching…' : 'Search'}
        </button>
      </div>

      {formError && <div className="form-error">{formError}</div>}

      {result && !result.found && (
        <p className="page-status">
          No position found. This {mode === 'msisdn' ? 'phone number' : 'IMEI'} is not tied to any device in
          shared signal samples, rescue enrolment or trace requests, or that device has never sent a GPS
          position.
        </p>
      )}

      {result && result.found && result.lat != null && result.lng != null && (
        <>
          <p>
            <strong>{[result.manufacturer, result.phone_model].filter(Boolean).join(' ') || 'Unknown device'}</strong>
            {' · '}
            {result.network_type ?? '—'}
            {' · '}
            {result.ts ? new Date(result.ts).toLocaleString() : '—'}
            {result.accuracy_m != null && ` · ±${Math.round(result.accuracy_m)} m`}
          </p>
          {/* Every store the app writes to is searched; this says which one
              held the newest position and what the others had. */}
          <p className="muted">
            Device <code>{(result.device_hash ?? '').slice(0, 10) || '—'}</code>
            {result.devices?.[0]?.stale ? ' (no upload in the last 30 days)' : ''}. The number is as typed by the
            user in the app, not verified against the SIM.
            Newest position is from <strong>{result.source ? SOURCE_LABELS[result.source] : '—'}</strong>.
            {(result.sources ?? []).map((s) => (
              <span key={s.source}>
                {' '}{SOURCE_LABELS[s.source]}: {s.ts ? new Date(s.ts).toLocaleString() : 'none'}.
              </span>
            ))}
          </p>
          {(result.devices?.length ?? 0) > 1 && (
            <div className="page-status page-status-error" style={{ marginBottom: 12 }}>
              <strong>This {mode === 'msisdn' ? 'number' : 'IMEI'} is tied to {result.devices!.length} devices.</strong>{' '}
              The map shows only the first one, the device with the newest position. Positions from different
              devices are not combined.
              <table className="admin-table" style={{ marginTop: 8 }}>
                <thead>
                  <tr><th>Device</th><th>Model</th><th>Linked by</th><th>Last upload</th><th>Newest position</th><th>Time</th><th>From</th></tr>
                </thead>
                <tbody>
                  {result.devices!.map((d) => (
                    <tr key={d.device_hash}>
                      <td>
                        <code>{d.device_hash.slice(0, 10)}</code>
                        {(d.device_hashes?.length ?? 1) > 1 && ` (+${d.device_hashes!.length - 1} other id of this phone)`}
                      </td>
                      <td>{[d.manufacturer, d.phone_model].filter(Boolean).join(' ') || 'Unknown'}</td>
                      <td>{d.linked_by.map((l) => LINK_LABELS[l]).join(', ')}</td>
                      <td>{d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : 'never'}{d.stale ? ' (stale)' : ''}</td>
                      <td>{d.lat != null && d.lng != null ? `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}` : 'none'}</td>
                      <td>{d.ts ? new Date(d.ts).toLocaleString() : '—'}</td>
                      <td>{d.source ? SOURCE_LABELS[d.source] : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ height: 420, marginBottom: 12 }}>
            <MapContainer center={[result.lat, result.lng]} zoom={16} style={{ height: '100%', width: '100%' }}>
              <InvalidateOnResize />
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution="&copy; OpenStreetMap contributors"
              />
              <ResultMarker lat={result.lat} lng={result.lng} networkType={result.network_type} ts={result.ts} />
            </MapContainer>
          </div>
        </>
      )}
    </div>
  )
}
