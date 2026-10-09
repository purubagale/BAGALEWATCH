import { useMemo, useState } from 'react'
import { Circle, CircleMarker, MapContainer, TileLayer, Tooltip, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { apiErrorMessage } from '../api/client'
import { useAreaSampleRequests, useAreaSampleResults, useCreateAreaSampleRequest, useSites } from '../api/queries'
import type { AreaSampleReading } from '../api/types'
import { RSRP_BANDS, RSRQ_BANDS, SINR_BANDS, bandColor, type Band } from '../lib/dtBands'
import { declusterForPlot } from '../lib/declusterPlot'
import { resolveAreaQuery, type ResolvedAreaPoint } from '../lib/resolveDeviceAreaQuery'
import { CQI_COLUMN_HINT, CQI_MODULATION_HINT, cqiLabel, cqiModulationLabel } from '../lib/cqiDisplay'

// On-demand area sample (2026-10-08) -- see core/area_sample.py. An engineer
// picks an area and asks the devices sharing there for one fresh reading
// each, to compare live coverage against a stored drive test. Only devices
// that are opted in are asked, and the readings carry no device id, phone
// number or IMEI: this page shows signal at a place and a count of devices.

interface Metric {
  key: 'rsrp_dbm' | 'rsrq_db' | 'sinr_db'
  label: string
  unit: string
  bands: Band[]
}

const METRICS: Metric[] = [
  { key: 'rsrp_dbm', label: 'RSRP', unit: ' dBm', bands: RSRP_BANDS },
  { key: 'rsrq_db', label: 'RSRQ', unit: ' dB', bands: RSRQ_BANDS },
  { key: 'sinr_db', label: 'SINR', unit: ' dB', bands: SINR_BANDS },
]

const DEFAULT_RADIUS_KM = 2

function ClickToSetPoint({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng)
    },
  })
  return null
}

function average(values: (number | null)[]): string {
  const real = values.filter((v): v is number => v != null)
  if (!real.length) return '—'
  return (real.reduce((a, b) => a + b, 0) / real.length).toFixed(1)
}

export default function AreaSamplePage() {
  const { data: sites } = useSites()
  const { data: requests } = useAreaSampleRequests()
  const create = useCreateAreaSampleRequest()

  const [query, setQuery] = useState('')
  const [radiusKm, setRadiusKm] = useState(DEFAULT_RADIUS_KM)
  const [resolved, setResolved] = useState<ResolvedAreaPoint | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [metricKey, setMetricKey] = useState<Metric['key']>('rsrp_dbm')

  const { data: results } = useAreaSampleResults(selectedId)
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0]

  const points = useMemo(
    () =>
      declusterForPlot<AreaSampleReading>(results?.samples ?? [], (s) => ({
        lat: s.lat,
        lng: s.lng,
        siteKey: `${s.serving_site_id ?? ''}|${s.serving_sector ?? ''}`,
        score: s[metric.key],
      })),
    [results, metric],
  )

  function runSearch() {
    setFormError(null)
    const point = resolveAreaQuery(query, sites ?? [])
    if (!point) {
      setFormError(`Couldn't resolve "${query}" to coordinates, a Site ID/name, or a city/district.`)
      return
    }
    setResolved(point)
  }

  async function handleRequest() {
    if (!resolved) return
    setFormError(null)
    setNotice(null)
    try {
      const created = await create.mutateAsync({
        lat: resolved.lat, lng: resolved.lng, radius_km: radiusKm, label: resolved.label,
      })
      setSelectedId(created.id)
      setNotice(
        `${created.devices_in_area} device(s) seen in this area in the last ${created.lookback_hours}h, ` +
          `${created.devices_sharing ?? 0} sharing now, ${created.pushes_sent} asked. Readings appear below as they arrive.`,
      )
    } catch (err) {
      setFormError(apiErrorMessage(err, 'Could not send the request.'))
    }
  }

  const shown = results?.request

  return (
    <div className="admin-page" style={{ maxWidth: 1200 }}>
      <h1>Area Sample</h1>
      <p className="muted">
        Ask the devices sharing in an area for one fresh signal reading each, to compare live coverage with a stored
        drive test. Only devices with "Share with NTC" turned on are asked. Readings carry no phone number, IMEI or
        device id.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
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
            onChange={(e) => setRadiusKm(Math.max(0.1, Math.min(50, Number(e.target.value) || DEFAULT_RADIUS_KM)))}
            style={{ width: 64 }}
          />
          km
        </label>
        <button className="btn-secondary" onClick={runSearch}>
          Search
        </button>
        <button className="btn-primary" onClick={handleRequest} disabled={!resolved || create.isPending}>
          {create.isPending ? 'Sending…' : 'Request fresh readings'}
        </button>
      </div>

      {formError && <div className="form-error">{formError}</div>}
      {notice && <div className="form-success">{notice}</div>}

      {resolved && (
        <>
          <p className="muted" style={{ fontSize: 11, margin: '4px 0' }}>
            {radiusKm} km around {resolved.label}. Click the map to move the centre.
          </p>
          <div style={{ height: 240, marginBottom: 16 }}>
            <MapContainer
              key={`${resolved.lat},${resolved.lng}`}
              center={[resolved.lat, resolved.lng]}
              zoom={13}
              style={{ height: '100%', width: '100%' }}
            >
              <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <ClickToSetPoint
                onPick={(lat, lng) => setResolved({ lat, lng, label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` })}
              />
              <Circle center={[resolved.lat, resolved.lng]} radius={radiusKm * 1000} pathOptions={{ color: '#2563eb', fillOpacity: 0.08 }} />
            </MapContainer>
          </div>
        </>
      )}

      <h2>Requests</h2>
      {(requests?.results ?? []).length === 0 ? (
        <p className="page-status">No requests yet.</p>
      ) : (
        <table className="admin-table" style={{ marginBottom: 16 }}>
          <thead>
            <tr>
              <th>Requested</th>
              <th>Area</th>
              <th>Radius</th>
              <th>Seen in area</th>
              <th>Asked</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {(requests?.results ?? []).map((r) => (
              <tr
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                style={{ cursor: 'pointer', fontWeight: r.id === selectedId ? 600 : undefined }}
              >
                <td>{new Date(r.created_at).toLocaleString()}</td>
                <td>{r.label || `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`}</td>
                <td>{r.radius_km} km</td>
                <td>{r.devices_in_area}</td>
                <td>{r.pushes_sent}</td>
                <td>{r.requested_by ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {shown && results && (
        <section>
          <h2>
            Readings — {shown.label || `${shown.lat.toFixed(5)}, ${shown.lng.toFixed(5)}`},{' '}
            {new Date(shown.created_at).toLocaleString()}
          </h2>
          <p className="muted">
            {results.samples.length} reading(s) from {results.devices} device(s) of {shown.pushes_sent} asked.{' '}
            {results.open
              ? `Still collecting until ${new Date(results.open_until).toLocaleTimeString()}.`
              : 'Collection window closed.'}{' '}
            Average RSRP {average(results.samples.map((s) => s.rsrp_dbm))} dBm, RSRQ{' '}
            {average(results.samples.map((s) => s.rsrq_db))} dB, SINR {average(results.samples.map((s) => s.sinr_db))} dB.
          </p>

          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            {METRICS.map((m) => (
              <button
                key={m.key}
                className={m.key === metric.key ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
                onClick={() => setMetricKey(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11, margin: '6px 0' }}>
            {metric.bands.map((b) => (
              <span key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: b.color, display: 'inline-block' }} />
                {b.label}
              </span>
            ))}
          </div>

          <div style={{ height: 420, marginBottom: 12 }}>
            <MapContainer key={shown.id} center={[shown.lat, shown.lng]} zoom={14} style={{ height: '100%', width: '100%' }}>
              <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <Circle center={[shown.lat, shown.lng]} radius={shown.radius_km * 1000} pathOptions={{ color: '#2563eb', fillOpacity: 0.04 }} />
              {points.map((p, i) => {
                const v = p.item[metric.key]
                return (
                  <CircleMarker
                    key={i}
                    center={[p.lat, p.lng]}
                    radius={7}
                    pathOptions={{ color: '#ffffff', weight: 1, fillColor: bandColor(metric.bands, v), fillOpacity: 0.95 }}
                  >
                    <Tooltip>
                      {metric.label} {v != null ? `${v}${metric.unit}` : 'no data'} · {p.item.network_type}
                      {p.item.serving_site_id ? ` · ${p.item.serving_site_id}` : ''}
                      {p.collapsedCount > 1 ? ` (${p.role} of ${p.collapsedCount} here)` : ''}
                    </Tooltip>
                  </CircleMarker>
                )
              })}
            </MapContainer>
          </div>

          {results.samples.length === 0 ? (
            <p className="page-status">
              No readings yet. A phone answers only while it is sharing, has a data connection, and is still inside
              the area.
            </p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Network</th>
                  <th>Serving site</th>
                  <th>PCI</th>
                  <th>RSRP</th>
                  <th>RSRQ</th>
                  <th>SINR</th>
                  <th title={CQI_COLUMN_HINT}>CQI</th>
                  <th title={CQI_MODULATION_HINT}>Modulation</th>
                  <th>Lat</th>
                  <th>Lng</th>
                  <th>Accuracy (m)</th>
                </tr>
              </thead>
              <tbody>
                {results.samples.map((s, i) => (
                  <tr key={i}>
                    <td>{new Date(s.ts).toLocaleTimeString()}</td>
                    <td>{s.network_type}</td>
                    <td>{s.serving_site_id ? `${s.serving_site_id}${s.serving_sector ? ` / ${s.serving_sector}` : ''}` : '—'}</td>
                    <td>{s.pci ?? '—'}</td>
                    <td>{s.rsrp_dbm ?? '—'}</td>
                    <td>{s.rsrq_db ?? '—'}</td>
                    <td>{s.sinr_db ?? '—'}</td>
                    <td>{cqiLabel(s)}</td>
                    <td>{cqiModulationLabel(s)}</td>
                    <td>{s.lat.toFixed(5)}</td>
                    <td>{s.lng.toFixed(5)}</td>
                    <td>{s.gps_accuracy_m != null ? Math.round(s.gps_accuracy_m) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  )
}
