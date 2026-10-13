import { CircleMarker, MapContainer, Marker, Polygon, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useSiteMeasuredCoverage } from '../api/queries'
import type { Sector } from '../api/types'
import { divergentSectorPoints } from '../lib/sectorLocation'
import { TILT_REACH_DRAW_MAX_M, buildWedgePolygon, destinationPoint, tiltReachM } from '../lib/sectorWedge'
import { statusColor } from '../lib/statusColor'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'

// Antenna coverage wedges (2026-09-27, "how can we use its [KML] data to
// show antenna orientation, azimuth, beam power in graphical
// representation"). Originally colored by tech (--tech-4g/-3g/-2g), but
// the common real case is several co-located sectors that are ALL the
// same tech (a typical 3- or 6-sector 4G site) — every wedge rendered
// identically green with no way to tell one sector's cone from another's
// (2026-09-27 follow-up, screenshot showing an all-green cluster: "only
// green color is used... if only color is used then use different color
// for different sectors"). Cycles through a distinct palette by each
// sector's position in the list instead, so overlapping wedges at one
// site are always visually distinguishable regardless of tech. A sector
// only gets a wedge when it has real azimuth/beamwidth/radius — never a
// fabricated default (see Sector.beamwidth/Sector.radius's docstring in
// models.py).
const WEDGE_COLOR_PALETTE = [
  '#3b82f6', '#f97316', '#a855f7', '#ec4899', '#14b8a6', '#eab308', '#ef4444', '#22c55e',
]
function wedgeColorForIndex(i: number): string {
  return WEDGE_COLOR_PALETTE[i % WEDGE_COLOR_PALETTE.length]
}

// Satellite/hybrid tiles (2026-08-09 follow-up: "mini map is not
// informative may be satellite view will be informative") — same Google
// hybrid layer (imagery + roads + labels) every other map in this app
// already uses (TopologyMap.tsx/DtExploreTab.tsx's SATELLITE_URL), swapped
// in here for the plain OSM street layer this started with. A BTS site's
// surroundings (rooftop mount, compound, access road) read far better on
// imagery than on a street-only basemap, especially at this zoom.
// Three things can be drawn for a sector (2026-10-13). They answer
// different questions, so each has its own switch:
//   diagram   the wedge above: direction from the site list, with a width
//             and length that are the same for every sector on a band.
//   tilt      a line to where the centre of the beam meets flat ground,
//             from the antenna's height and tilt.
//   measured  where readings served by the sector were really taken.
const UNKNOWN_SECTOR_COLOR = '#94a3b8'

function distanceText(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`
}

/** Zooms and moves the map so that everything drawn is inside it: the
 * site, sectors at their own location, the wedges, the tilt lines and the
 * measured dots, whichever are switched on. Runs again when that set
 * changes and when the map changes size (fullscreen on or off), which is
 * also when Leaflet has to be told its box changed. */
function FitToDrawn({ corners, fitKey }: { corners: [number, number][]; fitKey: string }) {
  const map = useMap()
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      map.invalidateSize()
      if (corners.length > 1) {
        map.fitBounds(L.latLngBounds(corners), { padding: [22, 22], maxZoom: FIT_MAX_ZOOM })
      } else if (corners.length === 1) {
        map.setView(corners[0], MINI_MAP_ZOOM)
      }
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, map])
  return null
}

const SATELLITE_URL = 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'
const MINI_MAP_ZOOM = 16
// How far in the automatic fit may go; a single small site would otherwise fill the box with one roof.
const FIT_MAX_ZOOM = 18

function InvalidateOnResize() {
  useMapInvalidateOnResize()
  return null
}

function dotIcon(color: string, size: number): L.DivIcon {
  return L.divIcon({
    className: 'site-mini-map-dot-marker',
    html: `<span class="site-mini-map-dot" style="width:${size}px;height:${size}px;background:${color};"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

type MapPoint = { lat: number; lng: number; label: string; kind: 'site' | 'sector' }

export default function SiteLocationMiniMap({
  siteId, lat, lng, status, sectors = [],
}: {
  /** Needed for the measured layer; without it that switch is not offered. */
  siteId?: string
  lat: number | null
  lng: number | null
  status: string
  /** Optional — when sectors carry their own GPS override that genuinely
   * differs from the site's location (2026-08-09, "sometimes same sites
   * with multiple sectors may have different lat long location as sector
   * expansion"), each distinct one gets plotted as its own small pin
   * alongside the site's main pin, instead of the map only ever being
   * able to show one point per site. */
  sectors?: Sector[]
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showDiagram, setShowDiagram] = useState(true)
  const [showTilt, setShowTilt] = useState(false)
  const [showMeasured, setShowMeasured] = useState(false)
  const measured = useSiteMeasuredCoverage(siteId, showMeasured)

  function toggleFullscreen() {
    const el = wrapRef.current
    if (!el) return
    if (!document.fullscreenElement) {
      el.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
  }

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const points = useMemo<MapPoint[]>(() => {
    if (lat == null || lng == null) return []
    const sectorPoints = divergentSectorPoints(lat, lng, sectors)
    return [
      { lat, lng, label: 'Site location', kind: 'site' as const },
      ...sectorPoints.map((p) => ({ ...p, kind: 'sector' as const })),
    ]
  }, [lat, lng, sectors])

  // Wedge origin is the sector's OWN location when it diverges from the
  // site (same per-sector GPS override the markers above already use via
  // divergentSectorPoints), falling back to the site's point otherwise —
  // never a second, separate notion of "where this sector is."
  const wedgeSectors = useMemo(() => {
    if (lat == null || lng == null) return []
    return sectors
      .filter((s) => s.azimuth != null && s.beamwidth != null && s.radius != null)
      .map((s) => ({
        sector: s,
        origin: [s.lat ?? lat, s.lng ?? lng] as [number, number],
      }))
  }, [lat, lng, sectors])

  // One colour per sector, shared by all three layers. Sectors with a wedge
  // keep the colours they always had; the others follow on.
  const colorByKey = useMemo(() => {
    const out = new Map<string, string>()
    const ordered = [...wedgeSectors.map((w) => w.sector), ...sectors.filter((s) => !wedgeSectors.some((w) => w.sector.id === s.id))]
    ordered.forEach((s, i) => {
      const color = wedgeColorForIndex(i)
      if (s.cell_name) out.set(s.cell_name.trim().toLowerCase(), color)
      out.set(`id:${s.id}`, color)
    })
    return out
  }, [sectors, wedgeSectors])

  // Reach from height and tilt: a line, not a wedge, so it needs no beamwidth
  // and works for 2G and 3G sectors too.
  const tiltLines = useMemo(() => {
    if (lat == null || lng == null) return []
    return sectors
      .filter((s) => s.azimuth != null)
      .map((s) => {
        const reach = tiltReachM(s.height, s.mech_tilt, s.elec_tilt)
        if (reach == null) return null
        const origin: [number, number] = [s.lat ?? lat, s.lng ?? lng]
        const drawn = Math.min(reach, TILT_REACH_DRAW_MAX_M)
        return { sector: s, origin, reach, end: destinationPoint(origin[0], origin[1], s.azimuth as number, drawn) }
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
  }, [lat, lng, sectors])
  const sectorsWithoutTiltReach = sectors.filter((s) => s.azimuth != null).length - tiltLines.length

  const squares = showMeasured ? measured.data?.squares ?? [] : []

  // Every corner of everything drawn, so the fit can take it all in.
  const wedgeShapes = useMemo(
    () => wedgeSectors.map(({ sector: s, origin }) => ({
      sector: s,
      positions: buildWedgePolygon(origin[0], origin[1], s.azimuth as number, s.beamwidth as number, s.radius as number),
    })),
    [wedgeSectors],
  )
  const drawnCorners = useMemo<[number, number][]>(() => {
    const out: [number, number][] = points.map((p) => [p.lat, p.lng])
    if (showDiagram) wedgeShapes.forEach((w) => w.positions.forEach((c) => out.push(c)))
    if (showTilt) tiltLines.forEach((t) => out.push(t.end))
    squares.forEach((q) => out.push([q.lat, q.lng]))
    return out
  }, [points, showDiagram, wedgeShapes, showTilt, tiltLines, squares])

  if (!points.length) {
    return <div className="site-mini-map-empty">No GPS coordinates recorded for this site.</div>
  }

  const sitePoint = points[0]
  const hasDivergentSectors = points.length > 1

  return (
    <div className="site-mini-map-container">
      {/* Wrapper div carries the height, not MapContainer's own style prop —
          react-leaflet only applies MapContainer's style/className at first
          mount (see project memory feedback_react_leaflet_mapcontainer_style_once),
          so sizing needs to come from something react-leaflet doesn't own.
          The note below (when present) is a SIBLING of this, not a child —
          .site-mini-map-wrap is a fixed-height overflow:hidden box for the
          map itself, which would clip anything else placed inside it. */}
      <div ref={wrapRef} className={isFullscreen ? 'site-mini-map-wrap site-mini-map-fullscreen' : 'site-mini-map-wrap'}>
        <button
          type="button"
          className="site-mini-map-fullscreen-btn"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
        >
          {isFullscreen ? '⤦' : '⤢'}
        </button>
        <MapContainer center={[sitePoint.lat, sitePoint.lng]} zoom={MINI_MAP_ZOOM} scrollWheelZoom={isFullscreen} attributionControl={false}>
          {/* subdomains="0123" is REQUIRED here, not cosmetic — Leaflet's
              TileLayer defaults to `subdomains="abc"` (OpenStreetMap's own
              convention) whenever the prop is omitted. Google's tile
              servers only exist at mt0-mt3, not mta/mtb/mtc, so without
              this every single tile request 404s and the map renders as a
              blank grey box with just the marker/zoom control showing
              (exactly the bug reported 2026-08-09: "map is not working").
              Confirmed by cross-checking the two other places this app
              already uses SATELLITE_URL successfully — TopologyMap.tsx and
              DtExploreTab.tsx both explicitly pass this same override. */}
          <TileLayer url={SATELLITE_URL} subdomains="0123" />
          <InvalidateOnResize />
          <FitToDrawn
            corners={drawnCorners}
            fitKey={`${isFullscreen}|${showDiagram}|${showTilt}|${squares.length}|${drawnCorners.length}|${lat},${lng}`}
          />
          {squares.map((q, i) => (
            <CircleMarker
              key={`sq-${i}`}
              center={[q.lat, q.lng]}
              radius={q.source === 'phone' ? 4 : 3}
              pathOptions={{
                color: colorByKey.get(q.key.trim().toLowerCase()) ?? UNKNOWN_SECTOR_COLOR,
                fillColor: colorByKey.get(q.key.trim().toLowerCase()) ?? UNKNOWN_SECTOR_COLOR,
                fillOpacity: 0.8, weight: q.source === 'phone' ? 2 : 0,
              }}
            >
              <Tooltip direction="top">
                {q.key} · {q.level != null ? `${q.level} dBm` : 'no level'} · {q.n} {q.n === 1 ? 'reading' : 'readings'} ·{' '}
                {q.source === 'phone' ? 'phones' : 'drive test'}
              </Tooltip>
            </CircleMarker>
          ))}
          {showTilt && tiltLines.map(({ sector: s, origin, reach, end }) => (
            <Polyline
              key={`tilt-${s.id}`}
              positions={[origin, end]}
              pathOptions={{ color: colorByKey.get(`id:${s.id}`) ?? UNKNOWN_SECTOR_COLOR, weight: 3, dashArray: '6 6' }}
            >
              <Tooltip direction="top" sticky>
                {s.cell_name || s.sector} ({s.tech || '4G'}): the centre of the beam meets flat ground about{' '}
                {distanceText(reach)} out ({s.height} m high, {(s.mech_tilt ?? 0) + (s.elec_tilt ?? 0)}° tilt)
                {reach > TILT_REACH_DRAW_MAX_M ? `; drawn to ${distanceText(TILT_REACH_DRAW_MAX_M)}` : ''}
              </Tooltip>
            </Polyline>
          ))}
          {showDiagram && wedgeShapes.map(({ sector: s, positions }, i) => (
            <Polygon
              key={`wedge-${s.id}`}
              positions={positions}
              pathOptions={{ color: wedgeColorForIndex(i), fillColor: wedgeColorForIndex(i), fillOpacity: 0.3, weight: 1 }}
            >
              <Tooltip direction="top">
                {s.cell_name || s.sector} ({s.tech || '4G'}) — Az {s.azimuth}° · BW {s.beamwidth}°
                {s.mech_tilt != null || s.elec_tilt != null
                  ? ` · Tilt ${s.mech_tilt ?? 0}+${s.elec_tilt ?? 0}°`
                  : ''}
                {s.max_tx_power_dbm != null ? ` · ${s.max_tx_power_dbm} dBm` : ''}
              </Tooltip>
            </Polygon>
          ))}
          {points.map((p, i) => (
            <Marker
              key={i}
              position={[p.lat, p.lng]}
              icon={p.kind === 'site' ? dotIcon(statusColor(status), 18) : dotIcon('#a855f7', 13)}
            >
              <Tooltip direction="top" offset={[0, -8]}>{p.label}</Tooltip>
            </Marker>
          ))}
        </MapContainer>
        <div className="site-mini-map-layers">
          <label title="Direction from the site list. Width and length are the same for every sector on a band.">
            <input type="checkbox" checked={showDiagram} onChange={(e) => setShowDiagram(e.target.checked)} /> Diagram
          </label>
          <label title="Where the centre of each beam meets flat ground, from antenna height and tilt. Hills change this.">
            <input type="checkbox" checked={showTilt} onChange={(e) => setShowTilt(e.target.checked)} /> Reach from tilt
          </label>
          {siteId && (
            <label title="Where readings served by each sector were really taken, from drive tests and phones.">
              <input type="checkbox" checked={showMeasured} onChange={(e) => setShowMeasured(e.target.checked)} /> Measured
            </label>
          )}
        </div>
      </div>
      {showTilt && (
        <div className="site-mini-map-legend">
          {tiltLines.length === 0
            ? 'No sector here has both an antenna height and a tilt above zero, so no reach can be worked out.'
            : 'Dashed lines: where the centre of each beam meets the ground if the ground were flat. On a hill the real distance can be much longer or shorter.'}
          {tiltLines.length > 0 && sectorsWithoutTiltReach > 0 &&
            ` ${sectorsWithoutTiltReach} sector${sectorsWithoutTiltReach === 1 ? ' has' : 's have'} no line (no height, or no tilt).`}
        </div>
      )}
      {showMeasured && (
        <div className="site-mini-map-legend">
          {measured.isLoading && 'Loading the readings…'}
          {measured.isError && 'Could not load the readings.'}
          {measured.data && measured.data.sectors.length === 0 &&
            'No stored reading is matched to this site. That means no drive test or phone reading named one of its cells, not that it has no coverage.'}
          {measured.data && measured.data.sectors.length > 0 && (
            <>
              <div>
                Dots: where a reading served by the sector was taken, one per {measured.data.square_m} m square.
                {measured.data.phone_readings_included ? ' Ringed dots are phone readings.' : ''}
                {measured.data.truncated ? ' Only the busiest squares are drawn.' : ''}
              </div>
              {measured.data.sectors.map((s) => {
                const total = s.drive_test_readings + s.phone_readings
                return (
                  <div key={s.key} className="site-mini-map-legend-row">
                    <span
                      className="site-mini-map-legend-chip"
                      style={{ background: colorByKey.get(s.key.trim().toLowerCase()) ?? UNKNOWN_SECTOR_COLOR }}
                    />
                    <b>{s.sector || s.key}</b>
                    {s.tech ? ` (${s.tech})` : ''}: {total.toLocaleString()} {total === 1 ? 'reading' : 'readings'}
                    {s.p50_km != null && s.p90_km != null &&
                      `, half within ${s.p50_km} km, nine in ten within ${s.p90_km} km`}
                    {s.max_km != null && `, farthest ${s.max_km} km`}
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
      {hasDivergentSectors && (
        <div className="site-mini-map-note">
          ⚠ {points.length - 1} sector{points.length - 1 === 1 ? '' : 's'} at a different location than the site
        </div>
      )}
    </div>
  )
}
