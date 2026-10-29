import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import CurrentLocationMarker from '../components/CurrentLocationMarker'
import FitToPoints from '../components/FitToPoints'
import SitePhotoLayer from '../components/SitePhotoLayer'
import { telemetryLevel } from '../lib/telemetryLevel'
import { declusterForPlot } from '../lib/declusterPlot'
import { useCollectionSectors, useCollectionSessionSamples, useCollectionSessions } from '../api/queries'
import SectorBreakdown from '../components/SectorBreakdown'
import NeighbourCellsCell from '../components/NeighbourCellsCell'
import EnvironmentTools, { environmentText, filterByEnvironment, type EnvFilter } from '../components/EnvironmentTools'
import RouteEnds, { StackedNote } from '../components/RouteEnds'
import { useScrollToSelection } from '../lib/useScrollToSelection'
import { useAuth } from '../auth/AuthContext'
import { CQI_COLUMN_HINT, CQI_MODULATION_HINT, cqiLabel, cqiModulationLabel } from '../lib/cqiDisplay'

// Collections (2026-10-06, detail+plot added 2026-10-07): every drive and
// trace the phones have sent, by source. Device identity appears only for
// users with device.view_identity; the server leaves device_hash out of
// the response for everyone else. Clicking a row loads its route from
// core/collection.py's CollectionSessionSamplesView -- one shape covering
// both drive-sourced (crowd_drive/staff_drive) and trace-sourced
// (operator_investigation/operator_case) rows, same map/table either way,
// mirroring TraceRequestsPage.tsx's own fixes map.

const SOURCE_LABEL: Record<string, string> = {
  crowd_drive: 'Crowd drive',
  staff_drive: 'Staff drive',
  operator_investigation: 'Operator investigation',
  operator_case: 'Operator case',
  drive_test: 'Drive test (team)',
}

// One level column for a drive that moves between technologies: the number
// with its name when it is not RSRP, so "-85 RSCP" is not read as RSRP.
function levelText(s: { network_type: string; rsrp_dbm: number | null; rscp_dbm?: number | null; rssi_dbm?: number | null }) {
  const level = telemetryLevel({ network_type: s.network_type, rsrp: s.rsrp_dbm, rscp: s.rscp_dbm, rssi: s.rssi_dbm })
  if (level.value == null) return '—'
  return level.name === 'RSRP' ? String(level.value) : `${level.value} ${level.name}`
}

export default function CollectionsPage() {
  const [source, setSource] = useState('')
  // Search by session name, district or (superadmin) the phone's number (2026-10-19).
  const [typed, setTyped] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = window.setTimeout(() => setQ(typed.trim()), 400)
    return () => window.clearTimeout(t)
  }, [typed])
  const { data, isLoading, error } = useCollectionSessions(source, q)
  const allRows = data?.results ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const samples = useCollectionSessionSamples(selectedId)
  const sectors = useCollectionSectors(selectedId)
  // Clicking a session brings its route map into view (2026-10-27), instead
  // of leaving it below the whole list.
  // The section is at least a screen tall, so its heading can reach the top
  // even before the route has loaded; once it has, the heading is put there
  // again in case the page moved meanwhile.
  // Kept in view by the shared hook (lib/useScrollToSelection.ts).
  const routeRef = useScrollToSelection<HTMLElement>(selectedId, !!samples.data)

  // Filters beyond source (2026-10-07) -- client-side over the <=200 rows
  // the list endpoint already caps, same reasoning as the Telemetry Drive
  // Test page's own filter bar.
  const [statusFilter, setStatusFilter] = useState<'' | 'open' | 'ended'>('')
  const [userTypeFilter, setUserTypeFilter] = useState('')
  // ?device= opens the list on one phone, e.g. from Subscriber Profile (2026-10-15).
  const [searchParams] = useSearchParams()
  const [deviceFilter, setDeviceFilter] = useState(searchParams.get('device') ?? '')
  const [startFrom, setStartFrom] = useState('')
  const [startTo, setStartTo] = useState('')
  const rows = useMemo(() => {
    const dq = deviceFilter.trim().toLowerCase()
    const from = startFrom ? new Date(startFrom + 'T00:00:00').getTime() : null
    const to = startTo ? new Date(startTo + 'T23:59:59.999').getTime() : null
    return allRows.filter((r) => {
      if (statusFilter === 'open' && r.ended_at) return false
      if (statusFilter === 'ended' && !r.ended_at) return false
      if (userTypeFilter && r.user_type !== userTypeFilter) return false
      if (dq && !(r.device_hash ?? '').toLowerCase().includes(dq)) return false
      const startedAt = new Date(r.started_at).getTime()
      if (from != null && startedAt < from) return false
      if (to != null && startedAt > to) return false
      return true
    })
  }, [allRows, statusFilter, userTypeFilter, deviceFilter, startFrom, startTo])
  const userTypes = useMemo(() => [...new Set(allRows.map((r) => r.user_type).filter(Boolean))], [allRows])
  const selected = rows.find((r) => r.id === selectedId) ?? null

  // Overlap management (2026-10-07, "manage plot with worst and best data
  // with no overlapping ... manage this in all telemetry sessions") -- see
  // lib/declusterPlot.ts's own header. `pci` is the fallback site key for
  // trace rows, which have no serving_site_id resolution of their own.
  // Outdoors / indoors / in a vehicle (2026-10-26): the dots follow the filter.
  const [envFilter, setEnvFilter] = useState<EnvFilter>('')
  const { user } = useAuth()
  const plotPoints = useMemo(
    () =>
      declusterForPlot(filterByEnvironment(samples.data?.results ?? [], envFilter), (s) => ({
        lat: s.lat,
        lng: s.lng,
        siteKey: s.serving_site_id ? `${s.serving_site_id}|${s.serving_sector ?? ''}` : `pci:${s.pci ?? ''}`,
        // The level of whatever technology the phone was on at this fix.
        score: telemetryLevel({ network_type: s.network_type, rsrp: s.rsrp_dbm, rscp: s.rscp_dbm, rssi: s.rssi_dbm }).value,
      })),
    [samples.data, envFilter],
  )

  return (
    <div className="admin-page">
      <h1>Collections</h1>
      <p className="muted">
        Drives and traces sent from phones. A session is open while data is still arriving, and ended once it
        completes, is cancelled, or expires. Click a row to plot its route.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <input type="search" value={typed} onChange={(e) => setTyped(e.target.value)}
          placeholder="Search: district, session name or mobile number" style={{ flex: '1 1 260px' }} aria-label="Search sessions" />
        <label>
          Source{' '}
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">All sources</option>
            {Object.entries(SOURCE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status{' '}
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | 'open' | 'ended')}>
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="ended">Ended</option>
          </select>
        </label>
        <label>
          User type{' '}
          <select value={userTypeFilter} onChange={(e) => setUserTypeFilter(e.target.value)}>
            <option value="">All</option>
            {userTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          Started from
          <input type="date" value={startFrom} onChange={(e) => setStartFrom(e.target.value)} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          to
          <input type="date" value={startTo} onChange={(e) => setStartTo(e.target.value)} />
        </label>
        <input
          value={deviceFilter}
          onChange={(e) => setDeviceFilter(e.target.value)}
          placeholder="Filter by device hash..."
          style={{ flex: '1 1 200px' }}
        />
        {allRows.length > 0 && (
          <span className="muted" style={{ fontSize: 11 }}>
            {rows.length} of {allRows.length}
          </span>
        )}
      </div>

      {isLoading && <p className="page-status">Loading…</p>}
      {error && <p className="page-status">Could not load collections.</p>}

      {data && allRows.length === 0 && <p className="page-status">No collections yet.</p>}
      {data && allRows.length > 0 && rows.length === 0 && <p className="page-status">No collections match these filters.</p>}

      {data && rows.length > 0 && (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Session</th>
              <th>Started</th>
              <th>Source</th>
              <th>User type</th>
              <th>Fixes</th>
              <th>Last fix</th>
              <th>Status</th>
              <th>Device</th>
              <th>Trace</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => setSelectedId(row.id === selectedId ? null : row.id)}
                style={{ cursor: 'pointer', background: row.id === selectedId ? 'var(--row-selected-bg, #eef4fc)' : undefined }}
              >
                <td>
                  <b>{row.name ?? '—'}</b>
                  {row.msisdn && <div className="muted mono" style={{ fontSize: 11.5 }}>{row.msisdn}</div>}
                </td>
                <td>{new Date(row.started_at).toLocaleString()}</td>
                <td>{SOURCE_LABEL[row.source] ?? row.source}</td>
                <td>{row.user_type}</td>
                <td>{row.sample_count}</td>
                <td>{row.last_sample_at ? new Date(row.last_sample_at).toLocaleString() : '—'}</td>
                <td>{row.ended_at ? `Ended ${new Date(row.ended_at).toLocaleString()}` : 'Open'}</td>
                <td>{row.device_hash ? row.device_hash.slice(0, 10) : 'Restricted'}</td>
                <td>{row.trace_id ? row.trace_id.slice(0, 8) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && rows.length > 0 && (
        <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          Fixes = GPS-tagged samples recorded so far. Status = Open while data is still arriving, or Ended at the
          time shown. Device = the anonymized device hash (truncated), or "Restricted" without device.view_identity
          permission. Trace = the operator trace request this session came from, for operator rows only.
        </p>
      )}

      {selected && (
        <section ref={routeRef} style={{ marginTop: 20, scrollMarginTop: 8, minHeight: 'calc(100vh - 80px)' }}>
          <h2>
            Route —{SOURCE_LABEL[selected.source] ?? selected.source}, started{' '}
            {new Date(selected.started_at).toLocaleString()}
          </h2>
          {samples.isLoading && <p className="page-status">Loading route…</p>}
          {samples.error && <p className="page-status">Could not load this session's samples.</p>}
          {samples.data && samples.data.results.length === 0 && (
            <p className="muted">No GPS-tagged fixes for this session.</p>
          )}
          {samples.data && samples.data.results.length > 0 && (
            <>
              <EnvironmentTools items={samples.data.results} filter={envFilter} onFilter={setEnvFilter}
                session={{ collection_session: selected.id }} canEdit={user?.role === 'admin' || user?.role === 'superadmin'} />
              <div style={{ height: 360, marginBottom: 12 }}>
                <MapContainer
                  center={[samples.data.results[0].lat, samples.data.results[0].lng]}
                  zoom={14}
                  style={{ height: '100%', width: '100%' }}
                >
                  {/* Whole route in view when it opens (2026-10-15). */}
                  <FitToPoints
                    points={samples.data.results.map((s) => [s.lat, s.lng] as [number, number])}
                    fitKey={selected.id}
                  />
                  <CurrentLocationMarker />
                  {/* A phone drive shows the photos taken during it; any other
                      session shows the photos in the area on screen. */}
                  <SitePhotoLayer driveSessionId={selected.drive_session_id} />
                  <TileLayer
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    attribution="&copy; OpenStreetMap contributors"
                  />
                  <Polyline
                    positions={samples.data.results.map((s) => [s.lat, s.lng] as [number, number])}
                    pathOptions={{ color: '#0153A5', weight: 3 }}
                  />
                  <RouteEnds points={samples.data.results} name={selected.name || undefined} />
                  <StackedNote points={samples.data.results} />
                  {plotPoints.map((p, i) => {
                    const level = telemetryLevel({
                      network_type: p.item.network_type, rsrp: p.item.rsrp_dbm, rscp: p.item.rscp_dbm, rssi: p.item.rssi_dbm,
                    })
                    return (
                      <CircleMarker
                        key={i}
                        center={[p.lat, p.lng]}
                        radius={5}
                        pathOptions={{ color: '#ffffff', weight: 1, fillColor: level.color, fillOpacity: 1 }}
                      >
                        <Tooltip>
                          {new Date(p.item.ts).toLocaleTimeString()} · {level.tech ?? p.item.network_type} ·{' '}
                          {level.value != null ? `${level.name} ${level.value} dBm` : 'no data'}
                          {p.collapsedCount > 1 ? ` (${p.role} of ${p.collapsedCount} here)` : ''}
                          {p.item.environment ? ` · ${environmentText(p.item)}` : ''}
                        </Tooltip>
                      </CircleMarker>
                    )
                  })}
                </MapContainer>
              </div>
              {/* Readings per serving sector of this drive (2026-10-19). */}
              {sectors.data && sectors.data.total > 0 && (
                <div className="report-card" style={{ marginBottom: 12 }}>
                  <SectorBreakdown data={sectors.data} siteLink={(id) => `/sites/${encodeURIComponent(id)}`} />
                </div>
              )}
              {/* Newest reading first (2026-10-29); the map keeps time order for its route. */}
              <p className="muted" style={{ margin: '4px 0' }}>
                Newest reading first.{' '}
                {(samples.data.total ?? 0) > samples.data.results.length
                  ? `Showing the latest ${samples.data.results.length.toLocaleString()} of ${(samples.data.total ?? 0).toLocaleString()} readings with a position.`
                  : `${samples.data.results.length.toLocaleString()} readings with a position.`}
              </p>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Lat</th>
                    <th>Lng</th>
                    <th>Accuracy (m)</th>
                    <th>Network</th>
                    <th title="Operating band the phone was on: band number and MHz. Empty for readings sent by an older app">Band</th>
                    <th title="Channel width of the serving cell; with more than one carrier in use, how many and their total. Empty on 2G/3G, older phones and older app versions">Bandwidth</th>
                    <th title="Other cells the phone heard with this reading, and the site each was matched to. Click to list them. Empty on older app versions">Neighbours</th>
                    <th title="Signal level: RSRP on 4G, RSCP on 3G, RxLev on 2G">Level (dBm)</th>
                    <th>RSRQ</th>
                    <th>SINR</th>
                    <th title={CQI_COLUMN_HINT}>CQI</th>
                    <th title={CQI_MODULATION_HINT}>Modulation</th>
                  </tr>
                </thead>
                <tbody>
                  {[...samples.data.results].reverse().map((s, i) => (
                    <tr key={i}>
                      <td>{new Date(s.ts).toLocaleString()}</td>
                      <td>{s.lat.toFixed(5)}</td>
                      <td>{s.lng.toFixed(5)}</td>
                      <td>{s.accuracy_m != null ? Math.round(s.accuracy_m) : '—'}</td>
                      <td>{s.network_type || '—'}</td>
                      <td>{s.band_label || '—'}</td>
                      <td>{s.bandwidth_label || '—'}</td>
                      <td><NeighbourCellsCell cells={s.neighbours} /></td>
                      <td>{levelText(s)}</td>
                      <td>{s.rsrq_db ?? '—'}</td>
                      <td>{s.sinr_db ?? '—'}</td>
                      <td>{cqiLabel(s)}</td>
                      <td>{cqiModulationLabel(s)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}
    </div>
  )
}
