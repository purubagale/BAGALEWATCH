// Antenna coverage-wedge geometry (2026-09-27, "how can we use its [KML]
// data to show antenna orientation, azimuth, beam power in graphical
// representation"). Computed client-side from Sector.azimuth/beamwidth/
// radius rather than trusting the vendor KML's own frozen coverage
// polygons, so the shape always reflects whatever those three fields
// currently hold in the database — no separate "wedge went stale after
// someone edited azimuth" failure mode. No geodesic/wedge-drawing code
// existed anywhere in this codebase before this file (confirmed via a
// full-tree search) — the haversine destination-point formula below is a
// standard implementation, not ported from anywhere.

const EARTH_RADIUS_M = 6371000

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI
}

/** Given a start point, a bearing (degrees, 0 = true north, clockwise)
 * and a distance in meters, returns the destination [lat, lng]. Real
 * spherical (haversine) formula, not a flat-earth approximation — a flat
 * approximation's east/west distortion at typical Nepal latitudes is
 * large enough to visibly skew a wedge's shape at even a few hundred
 * meters. */
export function destinationPoint(lat: number, lng: number, bearingDeg: number, distanceM: number): [number, number] {
  const angDist = distanceM / EARTH_RADIUS_M
  const bearing = toRad(bearingDeg)
  const lat1 = toRad(lat)
  const lng1 = toRad(lng)

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angDist) + Math.cos(lat1) * Math.sin(angDist) * Math.cos(bearing),
  )
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angDist) * Math.cos(lat1),
    Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2),
  )

  return [toDeg(lat2), toDeg(lng2)]
}

/** Builds a pie-slice polygon for one sector's theoretical antenna
 * coverage — a ring starting at the site point, sweeping an arc from
 * `azimuthDeg - beamwidthDeg/2` to `azimuthDeg + beamwidthDeg/2` at
 * `radiusM`, and back. Leaflet's Polygon (both react-leaflet's <Polygon>
 * and raw L.polygon) auto-closes the ring, so the returned array doesn't
 * need to repeat the first point. `segments` controls arc smoothness —
 * 16 is enough to look like a smooth cone even for a wide (e.g. 90°)
 * beamwidth at typical sector radii (100-300m) without generating an
 * excessive number of points across a page that may render dozens of
 * these at once. */
export function buildWedgePolygon(
  lat: number,
  lng: number,
  azimuthDeg: number,
  beamwidthDeg: number,
  radiusM: number,
  segments = 16,
): [number, number][] {
  const halfBeam = beamwidthDeg / 2
  const startBearing = azimuthDeg - halfBeam
  const points: [number, number][] = [[lat, lng]]
  for (let i = 0; i <= segments; i++) {
    const bearing = startBearing + (beamwidthDeg * i) / segments
    points.push(destinationPoint(lat, lng, bearing, radiusM))
  }
  return points
}
