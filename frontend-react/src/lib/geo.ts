// Small geometry helpers for Phase 4d's district-boundary search, ported
// verbatim from bts_monitor.html (~15503-15538): `_convexHull` (standard
// monotone-chain hull, used as a real-data "approximate coverage area"
// polygon when no administrative boundary exists for a district/city)
// and `_pointInPolygon` (ray-casting test, flat-plane math — fine at
// Nepal's scale, nowhere near a pole or the antimeridian). All point
// arrays are [lat, lng] pairs, matching NEPAL_DISTRICT_BOUNDARIES and
// every other coordinate array in this codebase.
import { haversineKm } from './dtTemplateParser'

export type LatLng = [number, number]

export function convexHull(points: LatLng[]): LatLng[] | null {
  const seen = new Set<string>()
  const pts: LatLng[] = []
  for (const p of points) {
    const key = `${p[0]},${p[1]}`
    if (!seen.has(key)) {
      seen.add(key)
      pts.push(p)
    }
  }
  if (pts.length < 3) return null
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: LatLng, a: LatLng, b: LatLng) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: LatLng[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: LatLng[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  const hull = lower.concat(upper)
  return hull.length >= 3 ? hull : null
}

export function pointInPolygon(lat: number, lng: number, poly: LatLng[]): boolean {
  if (!poly || poly.length < 3) return false
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][0]
    const xi = poly[i][1]
    const yj = poly[j][0]
    const xj = poly[j][1]
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

// Plain average of a polygon's vertices — not a true area-weighted
// centroid, but good enough as a "resolved point" to center the map on
// and to size the backend radius query around (see polygonBoundingRadiusKm
// below). v1 never needed this itself (it always had a separate
// NEPAL_PROVINCES centroid per district for the resolved point, kept
// independent of the boundary polygon's own shape); that dataset wasn't
// ported here, so the boundary polygon doubles as the source for both
// the resolved point AND the search shape — see DtExploreTab.tsx.
export function polygonAverageCenter(poly: LatLng[]): LatLng {
  const lat = poly.reduce((a, p) => a + p[0], 0) / poly.length
  const lng = poly.reduce((a, p) => a + p[1], 0) / poly.length
  return [lat, lng]
}

// Max real distance from a center point to any polygon vertex — used to
// size the existing radius-based `/dt-sessions/near/` backend query to a
// superset guaranteed to cover the whole polygon, so results can then be
// trimmed precisely with pointInPolygon() client-side without a second
// backend endpoint.
export function polygonBoundingRadiusKm(center: LatLng, poly: LatLng[]): number {
  let max = 0
  for (const p of poly) {
    const d = haversineKm(center[0], center[1], p[0], p[1])
    if (d > max) max = d
  }
  return max
}
