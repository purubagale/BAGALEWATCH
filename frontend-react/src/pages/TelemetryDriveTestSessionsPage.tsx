import { useEffect, useMemo, useRef, useState } from 'react'
import { Circle, CircleMarker, MapContainer, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
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
import {
  CQI_BANDS, ECIO_BANDS, RSRP_BANDS, RSRQ_BANDS, RXLEV_BANDS, RXQUAL_BANDS, SINR_BANDS,
  bandColor, type Band,
} from '../lib/dtBands'
import { declusterForPlot } from '../lib/declusterPlot'

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

// fitKey (2026-10-02 perf follow-up) -- see TelemetryLiveSamplesPage.tsx's
// identical fix for why: fits bounds once per session selection, not on
// every 10s poll, so the map stops re-centering out from under a user who
// has manually panned/zoomed.
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
    if (s.cqi_derived != null) parts.push(`CQI ${s.cqi_derived} (est.)`)
    return parts.join(', ')
  }
  if (s.rssi_dbm != null) return `${s.rssi_dbm} dBm (RSSI)`
  return '-'
}

// Multi-metric coverage plot (2026-10-07, "details should incorporate
// every collected data with plot as in dt data manager") -- mirrors
// lib/dtBands.ts's metricsForTech()/ALL_METRICS (the uploaded-.trp DT
// Explore/Compare system) closely enough to feel the same, but reads
// straight off TelemetryLiveSample's own field names rather than
// DtSample's -- these are two different pipelines (live crowdsourced
// pipeline vs. post-hoc .trp upload) with different stored field names
// for the same concepts, so metricsForTech() itself can't be reused
// directly without a DtSample shim.
type LiveTech = '2G' | '3G' | '4G/5G'

function techOf(s: TelemetryLiveSample): LiveTech {
  if (s.network_type === 'GSM') return '2G'
  if (s.network_type === 'UMTS') return '3G'
  return '4G/5G'
}

interface LiveMetric {
  key: string
  label: string
  unit: string
  bands: Band[]
  value: (s: TelemetryLiveSample) => number | null | undefined
  // Whether a higher raw value is the better reading (2026-10-07, for
  // declusterForPlot's worst/best pick) -- false only for RxQual, where a
  // LOWER class (0) is the good one, unlike every other metric here.
  higherIsBetter?: boolean
}

function metricsForLiveTech(tech: LiveTech): LiveMetric[] {
  if (tech === '2G') {
    return [
      { key: 'primary', label: 'RxLevel', unit: ' dBm', bands: RXLEV_BANDS, value: (s) => s.rssi_dbm },
      { key: 'rx_qual', label: 'RxQual', unit: '', bands: RXQUAL_BANDS, value: (s) => s.rx_qual, higherIsBetter: false },
    ]
  }
  if (tech === '3G') {
    return [
      { key: 'primary', label: 'RSCP', unit: ' dBm', bands: RSRP_BANDS, value: (s) => s.rscp_dbm ?? s.rssi_dbm },
      { key: 'ecio', label: 'Ec/Io', unit: ' dB', bands: ECIO_BANDS, value: (s) => s.ecio_db },
    ]
  }
  return [
    { key: 'primary', label: 'RSRP', unit: ' dBm', bands: RSRP_BANDS, value: (s) => s.rsrp_dbm },
    { key: 'rsrq', label: 'RSRQ', unit: ' dB', bands: RSRQ_BANDS, value: (s) => s.rsrq_db },
    { key: 'sinr', label: 'SINR', unit: ' dB', bands: SINR_BANDS, value: (s) => s.sinr_db },
    { key: 'cqi', label: 'CQI (est.)', unit: '', bands: CQI_BANDS, value: (s) => s.cqi_derived },
  ]
}

function MetricPoints({ samples, metric }: { samples: TelemetryLiveSample[]; metric: LiveMetric }) {
  const map = useMap()
  useEffect(() => {
    const layer = L.layerGroup().addTo(map)
    // Overlap management (2026-10-07, "manage plot with worst and best
    // data with no overlapping ... manage this in all telemetry sessions")
    // -- see lib/declusterPlot.ts's own header for the full reasoning.
    // Re-grouped on every metric switch, since "worst" only means
    // something relative to whichever metric is on screen.
    const higherIsBetter = metric.higherIsBetter !== false
    const points = declusterForPlot(samples, (s) => {
      const raw = metric.value(s)
      return {
        lat: s.lat ?? NaN,
        lng: s.lng ?? NaN,
        siteKey: `${s.serving_site_id ?? ''}|${s.serving_sector ?? ''}`,
        score: raw == null ? null : higherIsBetter ? raw : -raw,
      }
    })
    for (const p of points) {
      const s = p.item
      const v = metric.value(s)
      const color = bandColor(metric.bands, v)
      const roleText = p.collapsedCount > 1 ? ` (${p.role} of ${p.collapsedCount} here)` : ''
      L.circleMarker([p.lat, p.lng], { radius: 6, color: '#ffffff', weight: 1, fillColor: color, fillOpacity: 0.9 })
        .bindTooltip(
          `${s.device_id.slice(0, 8)}... - ${new Date(s.received_at).toLocaleTimeString()} - ` +
            `${metric.label} ${v != null ? `${v}${metric.unit}` : 'no data'}${roleText}`,
        )
        .addTo(layer)
    }
    return () => {
      map.removeLayer(layer)
    }
  }, [map, samples, metric])
  return null
}

function MetricLegend({ bands }: { bands: Band[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11, margin: '6px 0' }}>
      {bands.map((b) => (
        <span key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: b.color, display: 'inline-block' }} />
          {b.label}
        </span>
      ))}
    </div>
  )
}

// Route line (2026-10-04): one polyline per device through its fixes in time
// order. Uses the server's smoothed coordinates where present, so the line
// reads as a route rather than scattered dots. Points still show on top.
function RouteLines({ samples }: { samples: TelemetryLiveSample[] }) {
  const map = useMap()
  useEffect(() => {
    const layer = L.layerGroup().addTo(map)
    const byDevice = new Map<string, TelemetryLiveSample[]>()
    for (const s of samples) {
      if (s.lat == null || s.lng == null) continue
      const list = byDevice.get(s.device_id) ?? []
      list.push(s)
      byDevice.set(s.device_id, list)
    }
    for (const list of byDevice.values()) {
      list.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
      const pts = list.map((s) => [s.lat_smooth ?? s.lat!, s.lng_smooth ?? s.lng!] as [number, number])
      if (pts.length > 1) {
        L.polyline(pts, { color: '#2563eb', weight: 3, opacity: 0.7 }).addTo(layer)
      }
    }
    return () => {
      map.removeLayer(layer)
    }
  }, [map, samples])
  return null
}

// Click-to-pick a center point (2026-10-07, "so that i can edit the
// range or location as per my requirement") -- the enrollment preview
// map's own interaction: clicking anywhere re-centers the search point
// without having to type coordinates.
function ClickToSetPoint({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng)
    },
  })
  return null
}

const DEFAULT_SEARCH_RADIUS_KM = 2
// "Active now" vs "has a last known position here" windows (2026-10-08) --
// see the NewSessionForm doc comment below. LAST_KNOWN_MINUTES is the
// backend's own hard cap (TelemetryLiveSamplesView's _MAX_LIVE_MINUTES),
// not an arbitrary choice -- asking for more would just get silently
// clamped server-side.
const ACTIVE_MINUTES = 30
const LAST_KNOWN_MINUTES = 24 * 60

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

  // Disabled until an area is actually searched (2026-10-07, "when i just
  // load the telemetry drive test page, active device is shown. it
  // should not") -- previously this fired with no area filter at all
  // while `resolved` was null, showing every device active system-wide
  // before the admin had searched anything.
  //
  // Two windows over the same search point (2026-10-08, "display all the
  // device within that range those whose last lat long along with active
  // devices found in this area... display for active should be in green
  // color"): a short 30-minute one for "active now" (ACTIVE_MINUTES), and
  // the backend's own full 24h cap (LAST_KNOWN_MINUTES -- see
  // TelemetryLiveSamplesView's _MAX_LIVE_MINUTES) for "has a last known
  // position in this area even if not active right now." Both get drawn
  // on the preview map and both are enrollable -- pre-authorizing a
  // device you know works this area, even if it isn't pinging THIS
  // second, is a real use case (see toggleSelectAll below), not just a
  // passive map legend.
  const { data: activeData } = useTelemetryLiveSamples(
    resolved
      ? { minutes: ACTIVE_MINUTES, lat: resolved.lat, lng: resolved.lng, radius_km: radiusKm }
      : { minutes: ACTIVE_MINUTES },
    resolved != null,
  )
  const { data: lastKnownData } = useTelemetryLiveSamples(
    resolved
      ? { minutes: LAST_KNOWN_MINUTES, lat: resolved.lat, lng: resolved.lng, radius_km: radiusKm, limit: 500 }
      : { minutes: LAST_KNOWN_MINUTES },
    resolved != null,
  )
  const activeDeviceIds = useMemo(() => new Set(activeData?.devices ?? []), [activeData])
  // Each enrollable device's latest known fix, for the preview map's
  // markers -- `devices` is just a list of ids; positions come from the
  // same response's own `samples`. Computed over the BROADER 24h window
  // so a device active right now still shows its most recent fix even if
  // that happens to be from a moment ago, not the 24h window's own last
  // entry for it.
  const latestByDevice = useMemo(() => {
    const map = new Map<string, TelemetryLiveSample>()
    for (const s of lastKnownData?.samples ?? []) {
      if (s.lat == null || s.lng == null) continue
      const prev = map.get(s.device_id)
      if (!prev || new Date(s.ts).getTime() > new Date(prev.ts).getTime()) map.set(s.device_id, s)
    }
    return map
  }, [lastKnownData])
  const createSession = useCreateTelemetryDtSession()
  const [name, setName] = useState('')
  const [selectedDevices, setSelectedDevices] = useState<string[]>([])
  const [requireConsent, setRequireConsent] = useState(false)
  // Optional auto-end cap in minutes (2026-10-07) -- blank means unlimited,
  // same meaning as max_duration_minutes: null on the wire.
  const [maxDurationMinutes, setMaxDurationMinutes] = useState('')
  // The full enrollable list is now every device with a LAST KNOWN
  // position in range (lastKnownData?.devices), not just the active-now
  // subset -- activeDeviceIds above just flags which of them are active,
  // for the green/grey map color and the "(active)"/"last seen" checklist
  // label below.
  const recentDevices = lastKnownData?.devices ?? []

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

  // Re-center by clicking the preview map (2026-10-07) -- lets the admin
  // nudge the search point without retyping coordinates. Clears the text
  // query since the point no longer matches whatever was typed.
  const pickPoint = (lat: number, lng: number) => {
    setQuery('')
    setSearchError(null)
    setResolved({ lat, lng, label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` })
  }

  const toggleDevice = (d: string) => {
    setSelectedDevices((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))
  }

  // Select all / clear all (2026-10-07) -- enrolls every device currently
  // listed (already active + area-filtered, with or without drive-test
  // consent: that gate only affects which of them end up counted once
  // require_consent is on, never which ones can be ENROLLED here).
  const allSelected = recentDevices.length > 0 && recentDevices.every((d) => selectedDevices.includes(d))
  const toggleSelectAll = () => {
    setSelectedDevices(allSelected ? [] : [...recentDevices])
  }

  // Suggested session name (2026-10-07, "name with text in session name
  // including date and district") -- a one-click fill, not an
  // auto-overwrite, so a name the admin already typed is never silently
  // replaced. Falls back to the resolved point's own label when it
  // didn't come from a district match (e.g. a coordinate or Site ID).
  const todayStr = new Date().toISOString().slice(0, 10)
  const suggestedName = resolved ? `${resolved.district ?? resolved.label} Drive — ${todayStr}` : ''

  const submit = () => {
    if (!name.trim() || selectedDevices.length === 0) return
    const cap = maxDurationMinutes.trim()
    createSession.mutate(
      {
        name: name.trim(), device_ids: selectedDevices, require_consent: requireConsent,
        max_duration_minutes: cap ? Number(cap) : null,
      },
      {
        onSuccess: (session) => {
          setName('')
          setSelectedDevices([])
          setRequireConsent(false)
          setMaxDurationMinutes('')
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
      {suggestedName && suggestedName !== name && (
        <button
          type="button"
          className="btn-link"
          style={{ width: 'fit-content', fontSize: 11 }}
          onClick={() => setName(suggestedName)}
        >
          Use suggested name: "{suggestedName}"
        </button>
      )}
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
            Green = active in the last {ACTIVE_MINUTES} minutes; grey = a last known position here but not active
            right now. A blue ring marks a device you've selected below. Click the map to re-center, or adjust the
            radius and search again.
          </p>
        )}
      </div>
      {resolved && (
        <div style={{ height: 260 }}>
          <MapContainer center={[resolved.lat, resolved.lng]} zoom={13} style={{ height: '100%', width: '100%' }}>
            <InvalidateOnResize />
            <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <ClickToSetPoint onPick={pickPoint} />
            <Circle center={[resolved.lat, resolved.lng]} radius={radiusKm * 1000} pathOptions={{ color: '#2563eb', fillOpacity: 0.08 }} />
            <CircleMarker center={[resolved.lat, resolved.lng]} radius={6} pathOptions={{ color: '#2563eb', fillColor: '#2563eb', fillOpacity: 1 }} />
            {[...latestByDevice.entries()].map(([d, s]) => {
              const active = activeDeviceIds.has(d)
              const selected = selectedDevices.includes(d)
              return (
                <CircleMarker
                  key={d}
                  center={[s.lat as number, s.lng as number]}
                  radius={selected ? 6 : 5}
                  pathOptions={{
                    color: selected ? '#2563eb' : '#ffffff',
                    weight: selected ? 3 : 1,
                    fillColor: active ? '#16a34a' : '#94a3b8',
                    fillOpacity: 1,
                  }}
                >
                  <Tooltip>
                    {d.slice(0, 12)}... — {active ? 'active now' : `last seen ${new Date(s.ts).toLocaleString()}`}
                  </Tooltip>
                </CircleMarker>
              )
            })}
          </MapContainer>
        </div>
      )}
      <div>
        <div className="muted" style={{ marginBottom: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span>
            {resolved
              ? `Devices with a known position in this area, in the last ${LAST_KNOWN_MINUTES / 60}h`
              : `Search an area above to see devices there (nothing is listed until you search)`}
          </span>
          {recentDevices.length > 0 && (
            <button type="button" className="btn-secondary btn-small" onClick={toggleSelectAll}>
              {allSelected ? 'Clear all' : `Select all (${recentDevices.length})`}
            </button>
          )}
        </div>
        {resolved && recentDevices.length === 0 ? (
          <div className="page-status">
            No devices with a known position in this area. Try a larger radius, or a different search.
          </div>
        ) : !resolved ? null : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {recentDevices.map((d) => {
              const active = activeDeviceIds.has(d)
              const lastSample = latestByDevice.get(d)
              return (
                <label key={d} className="btn-secondary btn-small" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selectedDevices.includes(d)}
                    onChange={() => toggleDevice(d)}
                    style={{ marginRight: 6 }}
                  />
                  {d.slice(0, 12)}...{' '}
                  <span style={{ color: active ? '#16a34a' : '#64748b' }}>
                    {active ? '(active)' : lastSample ? `(last seen ${new Date(lastSample.ts).toLocaleTimeString()})` : ''}
                  </span>
                </label>
              )
            })}
          </div>
        )}
      </div>
      <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={requireConsent}
          onChange={(e) => setRequireConsent(e.target.checked)}
        />
        <span style={{ color: '#b91c1c' }}>Require rider consent before including their data</span>
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
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        Auto-end after
        <input
          type="number"
          min={1}
          max={43200}
          value={maxDurationMinutes}
          onChange={(e) => setMaxDurationMinutes(e.target.value)}
          placeholder="unlimited"
          style={{ width: 90 }}
        />
        minutes (optional)
      </label>
      <p className="muted" style={{ fontSize: 11, margin: 0 }}>
        Leave blank for no cap. Also ends automatically when its one enrolled device stops sharing (a session with
        several enrolled devices needs this cap or a manual End instead, so one teammate's phone stopping doesn't
        cut the others off).
      </p>
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
  // 2026-10-02 perf follow-up: `samples.length` dropped from this key --
  // see TelemetryLiveSamplesPage.tsx's identical fix for why (it forced a
  // full Leaflet map remount on nearly every 10s poll).
  const mapKey = `${selectedId}`

  // Session list filters (2026-10-07) -- client-side over the <=200 rows
  // the list endpoint already caps, same as CollectionsPage's own source
  // filter; no new backend query needed for a list this small.
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'ended'>('')
  const [nameFilter, setNameFilter] = useState('')
  const [consentFilter, setConsentFilter] = useState<'' | 'required' | 'not_required'>('')
  // Started-between filters (2026-10-07) -- plain <input type="date">,
  // compared against each session's own started_at; a bound is ignored
  // while its field is blank.
  const [startFrom, setStartFrom] = useState('')
  const [startTo, setStartTo] = useState('')
  const filteredSessions = useMemo(() => {
    const q = nameFilter.trim().toLowerCase()
    const from = startFrom ? new Date(startFrom + 'T00:00:00').getTime() : null
    const to = startTo ? new Date(startTo + 'T23:59:59.999').getTime() : null
    return (sessions ?? []).filter((s) => {
      if (statusFilter && s.status !== statusFilter) return false
      if (consentFilter === 'required' && !s.require_consent) return false
      if (consentFilter === 'not_required' && s.require_consent) return false
      if (q && !s.name.toLowerCase().includes(q)) return false
      const startedAt = new Date(s.started_at).getTime()
      if (from != null && startedAt < from) return false
      if (to != null && startedAt > to) return false
      return true
    })
  }, [sessions, statusFilter, consentFilter, nameFilter, startFrom, startTo])

  // Per-tech, per-metric coverage plot (see metricsForLiveTech above).
  // Defaults to whichever tech the session's own samples actually use,
  // re-picked whenever the selected session changes.
  const presentTechs = useMemo(() => {
    const set = new Set<LiveTech>()
    for (const s of samples) set.add(techOf(s))
    return (['4G/5G', '3G', '2G'] as LiveTech[]).filter((t) => set.has(t))
  }, [samples])
  const [tech, setTech] = useState<LiveTech>('4G/5G')
  const [metricKey, setMetricKey] = useState('primary')
  useEffect(() => {
    if (presentTechs.length && !presentTechs.includes(tech)) {
      setTech(presentTechs[0])
      setMetricKey('primary')
    }
  }, [presentTechs, tech])
  const metrics = metricsForLiveTech(tech)
  const metric = metrics.find((m) => m.key === metricKey) ?? metrics[0]
  const techSamples = useMemo(() => samples.filter((s) => techOf(s) === tech), [samples, tech])

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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            Status
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | 'active' | 'ended')}>
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="ended">Ended</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            Consent
            <select
              value={consentFilter}
              onChange={(e) => setConsentFilter(e.target.value as '' | 'required' | 'not_required')}
            >
              <option value="">All</option>
              <option value="required">Required</option>
              <option value="not_required">Not required</option>
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
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            placeholder="Filter by name..."
            style={{ flex: '1 1 220px' }}
          />
          <span className="muted" style={{ fontSize: 11 }}>
            {filteredSessions.length} of {(sessions ?? []).length}
          </span>
        </div>
      )}

      {(sessions ?? []).length > 0 && (
        <table className="admin-table" style={{ marginBottom: 16 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Devices</th>
              <th>Consent</th>
              <th>Cap</th>
              <th>Started</th>
              <th>Ended</th>
              <th>Started by</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filteredSessions.map((s) => (
              <tr key={s.id} style={selectedId === s.id ? { fontWeight: 600 } : undefined}>
                <td>
                  <button className="btn-link" onClick={() => setSelectedId(s.id)}>
                    {s.name}
                  </button>
                </td>
                <td>{s.status}</td>
                <td>{s.device_ids.length}</td>
                <td>{s.require_consent ? 'Required' : '-'}</td>
                <td>{s.max_duration_minutes ? `${s.max_duration_minutes} min` : '-'}</td>
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
      {(sessions ?? []).length > 0 && filteredSessions.length === 0 && (
        <div className="page-status">No sessions match these filters.</div>
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
            <>
              {presentTechs.length > 1 && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  {presentTechs.map((t) => (
                    <button
                      key={t}
                      className={t === tech ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
                      onClick={() => {
                        setTech(t)
                        setMetricKey('primary')
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                {metrics.map((m) => (
                  <button
                    key={m.key}
                    className={m.key === metric.key ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
                    onClick={() => setMetricKey(m.key)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <MetricLegend bands={metric.bands} />
              <MapContainer key={mapKey} center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} className="dt-coverage-map">
                <InvalidateOnResize />
                <FitToSamples samples={samples} fitKey={mapKey} />
                <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                <RouteLines samples={samples} />
                <MetricPoints samples={techSamples} metric={metric} />
              </MapContainer>
            </>
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

          <h2 style={{ marginTop: 24 }}>Speed tests</h2>
          {!samplesData?.speed_results?.length ? (
            <div className="page-status">No speed tests from this session's devices yet.</div>
          ) : (
            <table className="admin-table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Time</th>
                  <th>Ping (ms)</th>
                  <th>Jitter (ms)</th>
                  <th>Download (Mbps)</th>
                  <th>Upload (Mbps)</th>
                  <th>Radio</th>
                </tr>
              </thead>
              <tbody>
                {samplesData.speed_results.slice(0, 50).map((r, i) => (
                  <tr key={i}>
                    <td>{r.device_id.slice(0, 12)}...</td>
                    <td>{new Date(r.ts).toLocaleTimeString()}</td>
                    <td>{r.ping_median_ms ?? '-'}</td>
                    <td>{r.jitter_ms ?? '-'}</td>
                    <td>{r.download_mbps ?? '-'}</td>
                    <td>{r.upload_mbps ?? '-'}</td>
                    <td>{[r.network_type, r.rsrp_dbm != null ? `${r.rsrp_dbm} dBm` : ''].filter(Boolean).join(' ') || '-'}</td>
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
