import { MapContainer, Marker, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { useEffect, useMemo } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Sector } from '../api/types'
import { divergentSectorPoints } from '../lib/sectorLocation'
import { statusColor } from '../lib/statusColor'
import useMapInvalidateOnResize from '../lib/useMapInvalidateOnResize'

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
  const points = useMemo<MapPoint[]>(() => {
    if (lat == null || lng == null) return []
    const sectorPoints = divergentSectorPoints(lat, lng, sectors)
    return [
      { lat, lng, label: 'Site location', kind: 'site' as const },
      ...sectorPoints.map((p) => ({ ...p, kind: 'sector' as const })),
    ]
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
      <div className="site-mini-map-wrap">
        <MapContainer center={[sitePoint.lat, sitePoint.lng]} zoom={MINI_MAP_ZOOM} scrollWheelZoom={false} attributionControl={false}>
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
