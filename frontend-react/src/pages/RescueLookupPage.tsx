import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { apiErrorMessage } from '../api/client'
import { useRescueLookup, useRescueBulkLookup } from '../api/queries'
import type { RescueBulkLookupResultRow } from '../api/types'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'

// Same two base layers + same URLs as DtExploreTab.tsx's own street/satellite
// toggle, for consistency across the app rather than introducing a second
// satellite provider.
const STREET_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const SATELLITE_URL = 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'

// Bulk lookup input is capped at 500 numbers per call server-side
// (core/rescue.py's RescueBulkLookupView.MAX_BULK_MSISDNS) -- mirrored here
// so the page can reject an oversized paste immediately instead of making
// the round trip just to get the same 400 back.
const MAX_BULK_MSISDNS = 500

function InvalidateOnResize() {
  useMapInvalidateOnResize()
  return null
}

// Fullscreen toggling resizes the map's wrapper div (reusing
// DtExploreTab.tsx's own .dt-explore-map-wrap/.dt-explore-map-fullscreen
// CSS classes rather than defining new ones) without Leaflet ever being
// told -- same black-tile-on-resize root cause that file's own
// FullscreenSync documents. invalidateSize() on the next frame plus a
// re-center (not a fitBounds, since there's only ever one point here, not
// a variable-sized area) fixes it.
function FullscreenSync({ isFullscreen, lat, lng }: { isFullscreen: boolean; lat: number; lng: number }) {
  const map = useMap()
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      map.invalidateSize()
      map.setView([lat, lng], map.getZoom(), { animate: false })
    })
    return () => cancelAnimationFrame(raf)
  }, [map, isFullscreen, lat, lng])
  return null
}

// The pin -- carries a popup with the same info the report-card row below
// the map shows, OPENED BY DEFAULT (2026-09-03 follow-up: "with the marker
// with by default pop up" -- small map-overlay text was hard to read, so
// the full detail lives below the map in normal-sized text instead; the
// popup on the pin itself stays as a quick on-map reference). A plain
// L.circleMarker rather than react-leaflet's <Marker>, same reasoning as
// every other map in this app (TelemetryLiveSamplesPage.tsx etc.):
// <Marker>'s default icon assets don't resolve through this project's
// bundler setup.
function ResultMarker({
  lat, lng, accuracyM, source, lastSeenTs,
}: {
  lat: number
  lng: number
  accuracyM: number | null | undefined
  source: string | undefined
  lastSeenTs: string | undefined
}) {
  const map = useMap()
  useEffect(() => {
    map.setView([lat, lng], 16, { animate: false })
    const popupHtml = [
      `<strong>${lat.toFixed(5)}, ${lng.toFixed(5)}</strong>`,
      accuracyM != null ? `Accuracy: &plusmn;${accuracyM} m` : null,
      source ? `Source: ${source}` : null,
      lastSeenTs ? `Last seen: ${new Date(lastSeenTs).toLocaleString()}` : null,
    ].filter(Boolean).join('<br/>')
    const marker = L.circleMarker([lat, lng], {
      radius: 9,
      color: '#dc2626',
      fillColor: '#dc2626',
      fillOpacity: 0.85,
      weight: 2,
    })
      .bindPopup(popupHtml, { autoClose: false, closeOnClick: false })
      .addTo(map)
    marker.openPopup()
    return () => {
      map.removeLayer(marker)
    }
  }, [map, lat, lng, accuracyM, source, lastSeenTs])
  return null
}

type BulkPoint = RescueBulkLookupResultRow & { lat: number; lng: number }

// Fits the map to every FOUND point at once (2026-09-04, bulk search) --
// same pattern as TelemetryLiveSamplesPage.tsx's FitToSamples, since a
// bulk result set is a variable-sized area, not a single fixed point like
// the single-lookup map above.
function FitToBulkPoints({ points }: { points: BulkPoint[] }) {
  const map = useMap()
  useEffect(() => {
    if (!points.length) return
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 15, { animate: false })
      return
    }
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]))
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16, animate: false })
  }, [map, points])
  return null
}

// Fullscreen resync for the bulk map -- re-fits to all points instead of
// re-centering on one, since a bulk result is an area, not a single pin.
function BulkFullscreenSync({ isFullscreen, points }: { isFullscreen: boolean; points: BulkPoint[] }) {
  const map = useMap()
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      map.invalidateSize()
      if (points.length === 1) {
        map.setView([points[0].lat, points[0].lng], map.getZoom(), { animate: false })
      } else if (points.length > 1) {
        const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]))
        map.fitBounds(bounds, { padding: [24, 24], animate: false })
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [map, isFullscreen, points])
  return null
}

// One pin per found number -- a hover tooltip rather than an always-open
// popup, same choice TelemetryLiveSamplesPage.tsx's SamplePoints makes for
// the same reason: a bulk result can hold dozens of points, and auto-open
// popups on all of them at once would bury the map. The full per-number
// detail is always available below in the results table regardless.
function BulkResultMarkers({ points }: { points: BulkPoint[] }) {
  const map = useMap()
  useEffect(() => {
    const layer = L.layerGroup().addTo(map)
    for (const p of points) {
      const parts = [
        p.msisdn,
        p.accuracy_m != null ? `±${p.accuracy_m} m` : null,
        p.source ?? null,
        p.last_seen_ts ? new Date(p.last_seen_ts).toLocaleString() : null,
      ].filter(Boolean)
      L.circleMarker([p.lat, p.lng], {
        radius: 8,
        color: '#dc2626',
        fillColor: '#dc2626',
        fillOpacity: 0.85,
        weight: 2,
      })
        .bindTooltip(parts.join(' — '))
        .addTo(layer)
    }
    return () => {
      map.removeLayer(layer)
    }
  }, [map, points])
  return null
}

// Splits a pasted/uploaded number list on newlines, commas, or semicolons
// (an HLR/VLR export could plausibly use any of the three depending on how
// it was extracted), trims each entry, drops blanks, and de-dupes while
// preserving first-seen order -- mirrors core/rescue.py's
// RescueBulkLookupView, which does the same de-dupe server-side with
// dict.fromkeys() over its own cleaned list.
function parseMsisdnList(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[\r\n,;]+/)) {
    const v = raw.trim()
    if (v && !seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

function csvEscape(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadTextFile(filename: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'rescue_bulk'
}

function exportBulkCsv(results: RescueBulkLookupResultRow[], caseReference: string) {
  const rows: (string | number)[][] = [
    ['MSISDN', 'Found', 'Latitude', 'Longitude', 'Accuracy_m', 'Source', 'Last_seen'],
  ]
  for (const r of results) {
    rows.push([
      r.msisdn,
      r.found ? 'Yes' : 'No',
      r.lat ?? '',
      r.lng ?? '',
      r.accuracy_m ?? '',
      r.source ?? '',
      r.last_seen_ts ? new Date(r.last_seen_ts).toLocaleString() : '',
    ])
  }
  const datePart = new Date().toISOString().slice(0, 10)
  downloadTextFile(
    `rescue_bulk_${slugify(caseReference)}_${datePart}.csv`,
    'text/csv',
    rows.map((r) => r.map(csvEscape).join(',')).join('\n'),
  )
}

// Rescue Lookup (2026-09-03, extended 2026-09-04 with bulk search) -- the
// admin-facing half of core/rescue.py's RescueLookupView /
// RescueBulkLookupView, which existed on the backend since 2026-09-01 with
// no page anywhere calling it. Reachable only via the Rescue Lookup
// MenuItem (access='rescue', migration 0049_rescue_menu_items.py -- role in
// (rescue_operator, superadmin), mirroring IsRescueOperator exactly), so
// no separate client-side role check is needed here -- same reasoning
// ApiAccessPage.tsx documents for its own access='superadmin' gating.
//
// IMPORTANT LIMIT, worth restating on the page itself (not just in code
// comments): this can only ever find a phone number that was PREVIOUSLY
// ENROLLED through this same app's own opt-in flow (NetTelemetry.
// enrollForRescue() on a subscriber's device -- see the demo app's
// "Rescue Location Beacon" button). It has no access to a telecom's own
// subscriber database (HLR/VLR) and cannot look up a number that never
// enrolled here, regardless of the emergency policy setting -- see
// RescueConsentPolicy's own docstring ("can never invent" a link that
// doesn't already exist). The bulk mode below is the SAME lookup run over
// a whole list at once -- it does not widen what can be found, only how
// many numbers can be checked in one pass (e.g. against a list of numbers
// an operator's own HLR/VLR reports as last-attached around a site or
// area during an incident).
export default function RescueLookupPage() {
  const [mode, setMode] = useState<'single' | 'bulk'>('single')

  // --- single-number search (2026-09-03, unchanged) ---
  const [msisdn, setMsisdn] = useState('')
  const [caseReference, setCaseReference] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [mapLayer, setMapLayer] = useState<'street' | 'satellite'>('street')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const lookup = useRescueLookup()

  // --- bulk search (2026-09-04) ---
  const [bulkText, setBulkText] = useState('')
  const [bulkCaseReference, setBulkCaseReference] = useState('')
  const [bulkFormError, setBulkFormError] = useState<string | null>(null)
  const [bulkMapLayer, setBulkMapLayer] = useState<'street' | 'satellite'>('street')
  const [bulkFullscreen, setBulkFullscreen] = useState(false)
  const bulkWrapRef = useRef<HTMLDivElement>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const bulkLookup = useRescueBulkLookup()

  function toggleFullscreen() {
    const el = wrapRef.current
    if (!el) return
    if (!document.fullscreenElement) {
      el.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
  }

  function toggleBulkFullscreen() {
    const el = bulkWrapRef.current
    if (!el) return
    if (!document.fullscreenElement) {
      el.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
  }

  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(!!document.fullscreenElement && document.fullscreenElement === wrapRef.current)
      setBulkFullscreen(!!document.fullscreenElement && document.fullscreenElement === bulkWrapRef.current)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!msisdn.trim() || !caseReference.trim()) {
      setFormError('Both phone number and case reference are required.')
      return
    }
    try {
      await lookup.mutateAsync({ msisdn: msisdn.trim(), case_reference: caseReference.trim() })
    } catch {
      // surfaced below via lookup.error
    }
  }

  const bulkParsed = useMemo(() => parseMsisdnList(bulkText), [bulkText])

  function handleBulkFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError(null)
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!/\.(txt|csv)$/i.test(file.name)) {
      setFileError('Please choose a .txt or .csv file.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => setBulkText((prev) => (prev.trim() ? `${prev}\n${reader.result as string}` : (reader.result as string)))
    reader.onerror = () => setFileError('Could not read that file.')
    reader.readAsText(file)
  }

  async function handleBulkSearch(e: React.FormEvent) {
    e.preventDefault()
    setBulkFormError(null)
    if (!bulkParsed.length || !bulkCaseReference.trim()) {
      setBulkFormError('At least one phone number and a case reference are both required.')
      return
    }
    if (bulkParsed.length > MAX_BULK_MSISDNS) {
      setBulkFormError(`Max ${MAX_BULK_MSISDNS} numbers per bulk search -- this list has ${bulkParsed.length}. Split it into batches.`)
      return
    }
    try {
      await bulkLookup.mutateAsync({ msisdns: bulkParsed, case_reference: bulkCaseReference.trim() })
    } catch {
      // surfaced below via bulkLookup.error
    }
  }

  const result = lookup.data
  const point =
    result?.found && result.lat != null && result.lng != null
      ? { lat: result.lat, lng: result.lng, accuracyM: result.accuracy_m, source: result.source, lastSeenTs: result.last_seen_ts }
      : null

  const bulkResult = bulkLookup.data
  const bulkPoints: BulkPoint[] = useMemo(
    () => (bulkResult?.results ?? []).filter((r): r is BulkPoint => r.found && r.lat != null && r.lng != null),
    [bulkResult],
  )
  const bulkNotFoundCount = bulkResult ? bulkResult.results.length - bulkResult.found_count : 0

  return (
    <div className="admin-page" style={{ maxWidth: 1100 }}>
      <h1>Rescue Lookup</h1>
      <p className="muted">
        Finds the last known location of a phone number that previously opted in to the rescue-location beacon
        through this app. It cannot find a number that never enrolled here -- this is not a general subscriber
        directory or telecom-network lookup, only the small set of devices that specifically registered for
        this feature.
      </p>
      <p className="muted">
        Every search, whether or not it finds a match, is permanently logged with your account and the case
        reference you enter below -- there is no anonymous or browse-style lookup. This applies the same way
        to every number in a bulk search, one log entry each.
      </p>

      <div className="report-toolbar" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className={mode === 'single' ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
          onClick={() => setMode('single')}
        >
          Single number
        </button>
        <button
          type="button"
          className={mode === 'bulk' ? 'btn-primary btn-small' : 'btn-secondary btn-small'}
          onClick={() => setMode('bulk')}
          style={{ marginLeft: 6 }}
        >
          Bulk search
        </button>
      </div>

      {mode === 'single' && (
        <>
          <form onSubmit={handleSearch} className="edit-grid" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 12 }}>
            <label>
              Phone number (MSISDN)
              <input
                type="text"
                value={msisdn}
                onChange={(e) => setMsisdn(e.target.value)}
                placeholder="+977..."
              />
            </label>
            <label>
              Case reference
              <input
                type="text"
                value={caseReference}
                onChange={(e) => setCaseReference(e.target.value)}
                placeholder="Incident / ticket ID"
              />
            </label>
            <div style={{ gridColumn: '1 / -1' }}>
              <button type="submit" className="btn-primary" disabled={lookup.isPending}>
                {lookup.isPending ? 'Searching…' : 'Search'}
              </button>
            </div>
          </form>

          {formError && <div className="form-error">{formError}</div>}
          {lookup.isError && <div className="form-error">{apiErrorMessage(lookup.error, 'Could not complete the lookup.')}</div>}

          {result && !result.found && (
            <div className="page-status">
              No matching enrolled number found -- either it was never registered for rescue location, consent was
              withdrawn, or it belongs to an operator outside your account's scope.
            </div>
          )}

          {point && (
            <>
              <div className="report-toolbar" style={{ marginTop: 4, marginBottom: 0 }}>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    onClick={() => setMapLayer((m) => (m === 'street' ? 'satellite' : 'street'))}
                  >
                    {mapLayer === 'street' ? '🛰 Satellite' : '🗺 Street'}
                  </button>
                  <button type="button" className="btn-secondary btn-small" onClick={toggleFullscreen}>
                    {isFullscreen ? '⤦ Exit Fullscreen' : '⤢ Fullscreen'}
                  </button>
                  <a
                    href={`https://www.openstreetmap.org/?mlat=${point.lat}&mlon=${point.lng}#map=17/${point.lat}/${point.lng}`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-secondary btn-small"
                    style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                  >
                    Open in OSM ↗
                  </a>
                </div>
              </div>

              <div
                ref={wrapRef}
                className={isFullscreen ? 'dt-explore-map-wrap dt-explore-map-fullscreen' : 'dt-explore-map-wrap'}
                style={{ height: isFullscreen ? '100vh' : 560 }}
              >
                <MapContainer key={mapLayer} center={[point.lat, point.lng]} zoom={16} className="dt-coverage-map">
                  <TileLayer
                    attribution={mapLayer === 'street' ? '&copy; OpenStreetMap contributors' : '&copy; Google'}
                    url={mapLayer === 'street' ? STREET_URL : SATELLITE_URL}
                    subdomains={mapLayer === 'street' ? 'abc' : '0123'}
                    maxZoom={20}
                  />
                  <ResultMarker
                    lat={point.lat}
                    lng={point.lng}
                    accuracyM={point.accuracyM}
                    source={point.source}
                    lastSeenTs={point.lastSeenTs}
                  />
                  <FullscreenSync isFullscreen={isFullscreen} lat={point.lat} lng={point.lng} />
                  <InvalidateOnResize />
                </MapContainer>
              </div>

              {/* Full detail in normal-sized, readable text below the map
                  (2026-09-03 follow-up: the on-map overlay card was too small
                  to read) -- same report-card component used for summary
                  stats elsewhere (DtExploreTab.tsx's search summary). */}
              <div className="report-summary-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginTop: 12 }}>
                <div className="report-card">
                  <div className="report-card-val">{point.lat.toFixed(5)}</div>
                  <div className="report-card-label">Latitude</div>
                </div>
                <div className="report-card">
                  <div className="report-card-val">{point.lng.toFixed(5)}</div>
                  <div className="report-card-label">Longitude</div>
                </div>
                <div className="report-card">
                  <div className="report-card-val">{point.accuracyM != null ? `±${point.accuracyM} m` : '-'}</div>
                  <div className="report-card-label">Accuracy</div>
                </div>
                <div className="report-card">
                  <div className="report-card-val">{point.source ?? '-'}</div>
                  <div className="report-card-label">Source</div>
                </div>
                <div className="report-card">
                  <div className="report-card-val" style={{ fontSize: 15 }}>
                    {point.lastSeenTs ? new Date(point.lastSeenTs).toLocaleString() : '-'}
                  </div>
                  <div className="report-card-label">Last seen</div>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {mode === 'bulk' && (
        <>
          <p className="muted">
            Checks a whole list of numbers at once -- for example, numbers an operator's own HLR/VLR reports as
            last attached around a site or area during an incident. Paste or upload up to {MAX_BULK_MSISDNS} numbers,
            one per line (commas/semicolons also work). This only checks them against this app's own enrolled
            numbers -- it does not query any operator's core network directly.
          </p>

          <form onSubmit={handleBulkSearch} className="edit-grid" style={{ gridTemplateColumns: '1fr', marginBottom: 12 }}>
            <label>
              Phone numbers (one per line)
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={'+9779841234567\n+9779812345678\n+9779803456789'}
                rows={8}
                style={{ fontFamily: 'monospace', fontSize: 13 }}
              />
            </label>
            <div className="edit-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <label>
                Upload a list instead (.txt / .csv)
                <input type="file" accept=".txt,.csv,text/plain,text/csv" onChange={handleBulkFileChange} />
              </label>
              <label>
                Case reference (applies to the whole batch)
                <input
                  type="text"
                  value={bulkCaseReference}
                  onChange={(e) => setBulkCaseReference(e.target.value)}
                  placeholder="Incident / ticket ID"
                />
              </label>
            </div>
            {fileError && <div className="form-error">{fileError}</div>}
            <div>
              <span className="muted">
                {bulkParsed.length} number{bulkParsed.length === 1 ? '' : 's'} parsed
                {bulkParsed.length > MAX_BULK_MSISDNS ? ` (max ${MAX_BULK_MSISDNS} per search)` : ''}
              </span>
            </div>
            <div>
              <button type="submit" className="btn-primary" disabled={bulkLookup.isPending}>
                {bulkLookup.isPending ? 'Searching…' : `Search all (${bulkParsed.length})`}
              </button>
            </div>
          </form>

          {bulkFormError && <div className="form-error">{bulkFormError}</div>}
          {bulkLookup.isError && (
            <div className="form-error">{apiErrorMessage(bulkLookup.error, 'Could not complete the bulk lookup.')}</div>
          )}

          {bulkResult && (
            <>
              <div className="report-summary-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 12 }}>
                <div className="report-card">
                  <div className="report-card-val">{bulkResult.requested_count}</div>
                  <div className="report-card-label">Numbers submitted</div>
                </div>
                <div className="report-card">
                  <div className="report-card-val">{bulkResult.found_count}</div>
                  <div className="report-card-label">Found</div>
                </div>
                <div className="report-card">
                  <div className="report-card-val">{bulkNotFoundCount}</div>
                  <div className="report-card-label">Not found</div>
                </div>
                <div className="report-card">
                  <div className="report-card-val">{bulkResult.invalid_count}</div>
                  <div className="report-card-label">Invalid / skipped</div>
                </div>
              </div>

              {bulkResult.invalid_count > 0 && (
                <div className="page-status">
                  {bulkResult.invalid_count} entr{bulkResult.invalid_count === 1 ? 'y' : 'ies'} could not be read as a
                  valid phone number and were skipped before searching.
                </div>
              )}

              {bulkPoints.length > 0 && (
                <>
                  <div className="report-toolbar" style={{ marginTop: 4, marginBottom: 0 }}>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        onClick={() => setBulkMapLayer((m) => (m === 'street' ? 'satellite' : 'street'))}
                      >
                        {bulkMapLayer === 'street' ? '🛰 Satellite' : '🗺 Street'}
                      </button>
                      <button type="button" className="btn-secondary btn-small" onClick={toggleBulkFullscreen}>
                        {bulkFullscreen ? '⤦ Exit Fullscreen' : '⤢ Fullscreen'}
                      </button>
                    </div>
                  </div>

                  <div
                    ref={bulkWrapRef}
                    className={bulkFullscreen ? 'dt-explore-map-wrap dt-explore-map-fullscreen' : 'dt-explore-map-wrap'}
                    style={{ height: bulkFullscreen ? '100vh' : 560 }}
                  >
                    <MapContainer key={bulkMapLayer} center={[bulkPoints[0].lat, bulkPoints[0].lng]} zoom={13} className="dt-coverage-map">
                      <TileLayer
                        attribution={bulkMapLayer === 'street' ? '&copy; OpenStreetMap contributors' : '&copy; Google'}
                        url={bulkMapLayer === 'street' ? STREET_URL : SATELLITE_URL}
                        subdomains={bulkMapLayer === 'street' ? 'abc' : '0123'}
                        maxZoom={20}
                      />
                      <BulkResultMarkers points={bulkPoints} />
                      <FitToBulkPoints points={bulkPoints} />
                      <BulkFullscreenSync isFullscreen={bulkFullscreen} points={bulkPoints} />
                      <InvalidateOnResize />
                    </MapContainer>
                  </div>
                </>
              )}

              <div className="report-toolbar" style={{ marginTop: 12 }}>
                <strong>Results</strong>
                <div style={{ marginLeft: 'auto' }}>
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    onClick={() => exportBulkCsv(bulkResult.results, bulkCaseReference)}
                  >
                    Export CSV
                  </button>
                </div>
              </div>
              <table className="admin-table" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>MSISDN</th>
                    <th>Status</th>
                    <th>Latitude</th>
                    <th>Longitude</th>
                    <th>Accuracy</th>
                    <th>Source</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {bulkResult.results.map((r) => (
                    <tr key={r.msisdn}>
                      <td>{r.msisdn}</td>
                      <td>{r.found ? 'Found' : 'Not found'}</td>
                      <td>{r.lat != null ? r.lat.toFixed(5) : '-'}</td>
                      <td>{r.lng != null ? r.lng.toFixed(5) : '-'}</td>
                      <td>{r.accuracy_m != null ? `±${r.accuracy_m} m` : '-'}</td>
                      <td>{r.source ?? '-'}</td>
                      <td>{r.last_seen_ts ? new Date(r.last_seen_ts).toLocaleString() : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  )
}
