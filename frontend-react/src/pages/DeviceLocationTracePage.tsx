import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { apiErrorMessage } from '../api/client'
import { useDeviceLocationTrace } from '../api/queries'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'

function InvalidateOnResize() {
  useMapInvalidateOnResize()
  return null
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
  networkType: string | undefined
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
// docstring has the full reasoning): no rescue-location consent, no case
// reference -- resolves whatever MSISDN/IMEI a device uploaded as its own
// identity (the crowd/staff identity upload) to that device's latest
// position in the regular anonymous telemetry pipeline. Reachable only
// via its own MenuItem (access='superadmin'), so no separate client-side
// role check is needed here -- same reasoning every other superadmin-only
// page in this app documents.
export default function DeviceLocationTracePage() {
  const trace = useDeviceLocationTrace()
  const [mode, setMode] = useState<'msisdn' | 'imei'>('msisdn')
  const [value, setValue] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  async function handleSearch() {
    setFormError(null)
    const v = value.trim()
    if (!v) {
      setFormError(`Enter a ${mode === 'msisdn' ? 'phone number' : 'IMEI'}.`)
      return
    }
    try {
      await trace.mutateAsync(mode === 'msisdn' ? { msisdn: v } : { imei: v })
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
        Location beacon. This reads whatever a device has already uploaded as its own identity, so it needs no
        case reference -- every search is still permanently logged with your account regardless of whether it
        finds anything.
      </p>

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
        <button className="btn-primary" onClick={handleSearch} disabled={trace.isPending}>
          {trace.isPending ? 'Searching…' : 'Search'}
        </button>
      </div>

      {formError && <div className="form-error">{formError}</div>}

      {result && !result.found && (
        <p className="page-status">
          No position found -- either this device has never uploaded a GPS-tagged sample, or no device has
          uploaded this {mode === 'msisdn' ? 'phone number' : 'IMEI'} as its own identity.
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
          </p>
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
