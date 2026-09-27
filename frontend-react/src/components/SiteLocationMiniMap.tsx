import { MapContainer, Marker, Polygon, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Sector } from '../api/types'
import { divergentSectorPoints } from '../lib/sectorLocation'
import { buildWedgePolygon } from '../lib/sectorWedge'
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
const SATELLITE_URL = 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'
const MINI_MAP_ZOOM = 16

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

// Re-fits the viewport whenever the actual SET of points changes (not on
// every render) — same keyed-effect pattern as MapView.tsx's FitToScope,
// just keyed on the points' own coordinates since this component has no
// separate "scope" concept of its own.
function FitToPoints({ points }: { points: MapPoint[] }) {
  const map = useMap()
  const key = points.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|')
  useEffect(() => {
    if (points.length < 2) return
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]))
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: MINI_MAP_ZOOM })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map])
  return null
}

// Fullscreen toggling resizes this map's container without Leaflet ever
// being told (same root cause DtExploreTab.tsx's own FullscreenSync
// already documents — a stale internal Leaflet size cache from the
// Fullscreen API's resize, not a tab-reveal). invalidateSize() on the
// next frame plus a re-fit keeps the same site/sectors framed instead of
// leaving the view wherever the pre-toggle 240px-tall box happened to be
// scrolled/zoomed to.
function FullscreenSync({ isFullscreen, points }: { isFullscreen: boolean; points: MapPoint[] }) {
  const map = useMap()

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      map.invalidateSize()
      if (points.length > 1) {
        const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]))
        map.fitBounds(bounds, { padding: [28, 28] })
      } else if (points.length === 1) {
        map.setView([points[0].lat, points[0].lng], MINI_MAP_ZOOM)
      }
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isFullscreen])

  return null
}

export default function SiteLocationMiniMap({
  lat, lng, status, sectors = [],
}: {
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
          <FitToPoints points={points} />
          <FullscreenSync isFullscreen={isFullscreen} points={points} />
          {wedgeSectors.map(({ sector: s, origin }, i) => (
            <Polygon
              key={`wedge-${s.id}`}
              positions={buildWedgePolygon(origin[0], origin[1], s.azimuth as number, s.beamwidth as number, s.radius as number)}
              pathOptions={{ color: wedgeColorForIndex(i), fillColor: wedgeColorForIndex(i), fillOpacity: 0.3, weight: 1 }}
            >
              <Tooltip direction="top">
                {s.cell_name || s.sector} ({s.tech || '4G'}) — Az {s.azimuth}° · BW {s.beamwidth}°
                {s.mech_tilt != null || s.elec_tilt != null
                  ? ` · Tilt ${s.mech_tilt ?? 0}+${s.elec_tilt ?? 0}°`
                  : ''}
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
      </div>
      {hasDivergentSectors && (
        <div className="site-mini-map-note">
          ⚠ {points.length - 1} sector{points.length - 1 === 1 ? '' : 's'} at a different location than the site
        </div>
      )}
    </div>
  )
}
