import { useEffect, useMemo, useState } from 'react'
import BaseMap from './BaseMap'
import { Link } from 'react-router-dom'
import { MapContainer, Polygon, Rectangle, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { apiErrorMessage } from '../api/client'
import { useScheduledReadingsMap } from '../api/queries'
import type { ScheduledMapSector } from '../api/types'

// Readings by time of day on a map (2026-10-29, core/scheduled_readings.py
// ScheduledReadingMapView). Each serving sector is drawn as a small wedge at
// its site, pointing along its azimuth; readings that carried a rough area
// are drawn as their ~500 m square. Colour = share of weak readings.

const HOURS: [string, string][] = [['', 'All hours'], ['0', 'Midnight'], ['10', '10 am'], ['14', '2 pm'], ['19', '7 pm']]
const TECHS = ['4G', '3G', '2G']
const WEDGE_M = 350
const WEDGE_DEG = 60

function weakColor(pct: number) {
  return pct >= 50 ? '#dc2626' : pct >= 30 ? '#f97316' : pct >= 10 ? '#eab308' : '#16a34a'
}

function wedge(lat: number, lng: number, azimuth: number | null): [number, number][] {
  if (azimuth == null) {
    // No direction known: a small circle-like octagon at the site.
    return Array.from({ length: 8 }, (_, i) => offset(lat, lng, i * 45, WEDGE_M / 3))
  }
  const pts: [number, number][] = [[lat, lng]]
  for (let a = azimuth - WEDGE_DEG / 2; a <= azimuth + WEDGE_DEG / 2; a += 10) pts.push(offset(lat, lng, a, WEDGE_M))
  return pts
}

function offset(lat: number, lng: number, bearing: number, metres: number): [number, number] {
  const b = (bearing * Math.PI) / 180
  const dLat = (metres * Math.cos(b)) / 111_320
  const dLng = (metres * Math.sin(b)) / (111_320 * Math.cos((lat * Math.PI) / 180))
  return [lat + dLat, lng + dLng]
}

function FitOnce({ points, deps }: { points: [number, number][]; deps: string }) {
  const map = useMap()
  useEffect(() => {
    if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [20, 20], maxZoom: 13 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps])
  return null
}

function TrackBounds({ onChange }: { onChange: (b: L.LatLngBounds) => void }) {
  const map = useMapEvents({ moveend: () => onChange(map.getBounds()) })
  useEffect(() => { onChange(map.getBounds()) }, [map, onChange])
  return null
}

export default function ScheduledReadingsMap({ days }: { days: number }) {
  const [slot, setSlot] = useState('19')
  const [tech, setTech] = useState('4G')
  const [district, setDistrict] = useState('')
  const [bounds, setBounds] = useState<L.LatLngBounds | null>(null)
  const { data, isLoading, error } = useScheduledReadingsMap(days, slot, tech)

  const districts = useMemo(() => Array.from(new Set((data?.sectors ?? []).map((s) => s.district).filter(Boolean) as string[])).sort(),
    [data])
  const sectors = useMemo(() => (data?.sectors ?? []).filter((s) => !district || s.district === district), [data, district])
  const fitPoints = useMemo<[number, number][]>(() => [
    ...sectors.map((s) => [s.lat, s.lng] as [number, number]),
    ...(district ? [] : (data?.squares ?? []).map((q) => [q.lat, q.lng] as [number, number])),
  ], [sectors, data, district])
  const inView: ScheduledMapSector[] = useMemo(
    () => sectors.filter((s) => !bounds || bounds.contains([s.lat, s.lng])).sort((a, b) => b.weak_pct - a.weak_pct || b.readings - a.readings),
    [sectors, bounds])
  const half = (data?.area_deg ?? 0.005) / 2

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 6 }}>
        <span>{HOURS.map(([v, label]) => (
          <button key={v} type="button" className={slot === v ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
            style={{ marginRight: 4 }} onClick={() => setSlot(v)}>{label}</button>
        ))}</span>
        <span>{TECHS.map((t) => (
          <button key={t} type="button" className={tech === t ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
            style={{ marginRight: 4 }} onClick={() => setTech(t)}>{t}</button>
        ))}</span>
        <label className="muted">District{' '}
          <select value={district} onChange={(e) => setDistrict(e.target.value)}>
            <option value="">All</option>
            {districts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <span className="muted" style={{ fontSize: 12 }}>
          Weak readings: <span style={{ color: '#16a34a' }}>●</span> under 10% <span style={{ color: '#eab308' }}>●</span> 10-30%
          {' '}<span style={{ color: '#f97316' }}>●</span> 30-50% <span style={{ color: '#dc2626' }}>●</span> 50% or more.
          Wedges: by serving sector. Squares: rough area (about 500 m), only from phones that allowed it.
        </span>
      </div>
      {isLoading && <p className="page-status">Loading…</p>}
      {error && <p className="error">{apiErrorMessage(error)}</p>}
      {data && (
        <>
          <div style={{ height: 460 }}>
            <MapContainer center={[28.2, 84.1]} zoom={7} style={{ height: '100%', width: '100%' }}>
              <BaseMap />
              <FitOnce points={fitPoints} deps={`${slot}|${tech}|${district}|${days}|${fitPoints.length}`} />
              <TrackBounds onChange={setBounds} />
              {!district && data.squares.map((q) => (
                <Rectangle key={`${q.lat},${q.lng}`} bounds={[[q.lat - half, q.lng - half], [q.lat + half, q.lng + half]]}
                  pathOptions={{ color: weakColor(q.weak_pct), weight: 1, fillOpacity: 0.35 }}>
                  <Tooltip>{q.readings} readings · {q.weak_pct}% weak{q.level_avg != null ? ` · average ${q.level_avg} dBm` : ''}</Tooltip>
                </Rectangle>
              ))}
              {sectors.map((s) => (
                <Polygon key={`${s.site_id}|${s.sector}`} positions={wedge(s.lat, s.lng, s.azimuth)}
                  pathOptions={{ color: '#1e293b', weight: 1, fillColor: weakColor(s.weak_pct), fillOpacity: 0.75 }}>
                  <Tooltip>{s.site_id}{s.sector ? ` ${s.sector}` : ''} · {s.readings} readings · {s.weak_pct}% weak
                    {s.level_avg != null ? ` · average ${s.level_avg} dBm` : ''}</Tooltip>
                </Polygon>
              ))}
            </MapContainer>
          </div>
          <h3 style={{ marginTop: 12 }}>Sectors in view · {inView.length}</h3>
          {inView.length === 0 ? <p className="muted">No readings for this hour and technology in the area on screen.</p> : (
            <table className="admin-table">
              <thead><tr><th>Site</th><th>Sector</th><th>District</th><th>Readings</th><th>Weak</th><th>Average level</th></tr></thead>
              <tbody>
                {inView.slice(0, 200).map((s) => (
                  <tr key={`${s.site_id}|${s.sector}`}>
                    <td><Link to={`/sites/${encodeURIComponent(s.site_id)}`}>{s.site_id}</Link>{s.name ? <span className="muted"> {s.name}</span> : null}</td>
                    <td>{s.sector || '—'}</td>
                    <td>{s.district ?? '—'}</td>
                    <td className="mono">{s.readings}</td>
                    <td className="mono"><b style={{ color: weakColor(s.weak_pct) }}>{s.weak_pct}%</b></td>
                    <td className="mono">{s.level_avg != null ? `${s.level_avg} dBm` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}
