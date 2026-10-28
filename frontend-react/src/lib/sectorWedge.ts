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

// Where the centre of a sector's main beam meets the ground, from the
// antenna's height and its total downtilt (2026-10-13): height divided by
// the tangent of the tilt. Flat ground is assumed, which is the whole
// limit of it: on a hill the real distance can be far longer or shorter.
// Null when the height is unknown or the tilt is zero or less, since such
// a beam does not come down to flat ground at all.
export const TILT_REACH_DRAW_MAX_M = 5000

export function tiltReachM(
  heightM: number | null | undefined, mechTiltDeg: number | null | undefined, elecTiltDeg: number | null | undefined,
): number | null {
  if (heightM == null || heightM <= 0) return null
  const tilt = (mechTiltDeg ?? 0) + (elecTiltDeg ?? 0)
  if (tilt <= 0 || tilt >= 90) return null
  return heightM / Math.tan(toRad(tilt))
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

// ── Antenna beams (2026-10-28) ────────────────────────────────────────────
// The wedge above uses the site list's beamwidth and radius, which came from
// a KML drawing (40 or 60 degrees, 150 or 200 m): three sectors 120 degrees
// apart then show wide gaps that do not exist on the ground. A beam is drawn
// from the antenna's real horizontal pattern instead, the standard 3GPP shape
// (TR 36.814): attenuation 12 x (angle / beamwidth)^2 dB, at most 25 dB. The
// beam's length at each angle is where that loss is used up by distance,
// with signal falling 35 dB per tenfold distance (path-loss exponent 3.5):
// at 60 degrees off boresight a 65-degree panel is 10 dB down and reaches
// half as far, so neighbouring sectors meet there, as they do in reality.

export const HPBW_DEFAULT = 65
export const BEAM_REACH_MIN_M = 150
export const BEAM_REACH_MAX_M = 1500
export const BEAM_REACH_UNKNOWN_M = 500
const PATTERN_FLOOR_DB = 25
const PATH_LOSS_DB_PER_DECADE = 35

/** Horizontal half-power beamwidth from the site list's antenna model, or
 * null for an omni antenna. CommScope names carry it ("RZVV-65A", "DBXLH-6565");
 * Kathrein 80010865 is NTC's 65-degree multiband panel. */
export function antennaHpbw(model: string | null | undefined): { deg: number | null; known: boolean } {
  const m = (model || '').toUpperCase()
  if (/OMNI/.test(m)) return { deg: null, known: true }
  const named = m.match(/-(\d{2})(?:\d{2})?[A-Z]/)
  if (named) {
    const deg = Number(named[1])
    if (deg >= 20 && deg <= 120) return { deg, known: true }
  }
  if (m.includes('80010865')) return { deg: 65, known: true }
  return { deg: HPBW_DEFAULT, known: false }
}

/** Loss of the horizontal pattern `offDeg` away from boresight, in dB (positive). */
export function patternLossDb(offDeg: number, hpbwDeg: number): number {
  return Math.min(12 * (offDeg / hpbwDeg) ** 2, PATTERN_FLOOR_DB)
}

/** How far the beam is drawn at boresight: to where the upper edge of the
 * vertical beam (tilt minus half the vertical beamwidth) meets flat ground,
 * kept between BEAM_REACH_MIN_M and BEAM_REACH_MAX_M. `basis` says which. */
export function beamReachM(
  heightM: number | null | undefined, tiltDeg: number | null | undefined, verticalBeamwidthDeg: number,
): { m: number; basis: 'tilt' | 'horizon' | 'unknown' } {
  if (heightM == null || heightM <= 0 || tiltDeg == null) return { m: BEAM_REACH_UNKNOWN_M, basis: 'unknown' }
  const upper = tiltDeg - verticalBeamwidthDeg / 2
  if (upper <= 0.3) return { m: BEAM_REACH_MAX_M, basis: 'horizon' }
  const m = heightM / Math.tan(toRad(upper))
  return { m: Math.max(BEAM_REACH_MIN_M, Math.min(BEAM_REACH_MAX_M, m)), basis: 'tilt' }
}

/** The beam's outline: at each angle the boresight reach shortened by the
 * pattern loss. `withinDb` keeps only the angles whose loss is at most that
 * (3 = the half-power main beam); the default draws out to `spanDeg` each side. */
export function buildBeamPolygon(
  lat: number, lng: number, azimuthDeg: number, hpbwDeg: number, reachM: number,
  opts: { withinDb?: number; spanDeg?: number; stepDeg?: number } = {},
): [number, number][] {
  const span = opts.withinDb != null ? hpbwDeg * Math.sqrt(opts.withinDb / 12) : opts.spanDeg ?? 100
  const step = opts.stepDeg ?? 3
  const points: [number, number][] = [[lat, lng]]
  for (let off = -span; off <= span + 1e-6; off += step) {
    const r = reachM * 10 ** (-patternLossDb(off, hpbwDeg) / PATH_LOSS_DB_PER_DECADE)
    points.push(destinationPoint(lat, lng, azimuthDeg + off, r))
  }
  return points
}

/** A circle for an omni antenna. */
export function buildCirclePolygon(lat: number, lng: number, radiusM: number, segments = 48): [number, number][] {
  return Array.from({ length: segments }, (_, i) => destinationPoint(lat, lng, (360 * i) / segments, radiusM))
}

// Vertical beamwidth by band group (2026-10-28). NTC's site list names the
// antenna model but not its beamwidths. The defaults are typical of the
// multi-band panels in the 4G file: CommScope RZVV-65A-R4 lists about
// 14-17 degrees on 700-960 MHz and 5.4-9.4 degrees on 1400-2700 MHz. They
// can be changed on the site map and are kept in this browser, as is a
// changed horizontal beamwidth (empty = from the antenna model).
export type BandGroup = 'low' | 'high'
export const VBW_DEFAULT: Record<BandGroup, number> = { low: 15, high: 7 }
export const VBW_KEY = 'dtwatch_vertical_beamwidth'
export const HBW_KEY = 'dtwatch_horizontal_beamwidth'

export interface BandFields {
  site_band?: string | null
  carrier?: string | null
  tech?: string | null
  sector?: string | null
}

export function bandGroup(s: BandFields): BandGroup {
  // The sector's own band first: a 4G B3 sector's carrier reads "B3+B20" (the site's bands).
  const band = (s.site_band || (s.tech === '3G' ? '2100' : s.carrier) || '').toUpperCase()
  if (/\b(B20|B8|B5|B28|800|850|900|700)\b/.test(band) || /GSM\s*900/.test(band)) return 'low'
  if (!band.trim() && (s.tech || '') === '4G' && /20$/.test(s.sector || '')) return 'low'
  if (!band.trim() && (s.tech || '') === '2G') return 'low'
  return 'high'
}

export function loadHbw(): number | null {
  try {
    const v = Number(localStorage.getItem(HBW_KEY))
    return v >= 10 && v <= 180 ? v : null
  } catch {
    return null
  }
}

export function loadVbw(): Record<BandGroup, number> {
  try {
    const v = JSON.parse(localStorage.getItem(VBW_KEY) || 'null')
    if (v && typeof v.low === 'number' && typeof v.high === 'number') return v
  } catch {
    // storage blocked: the defaults apply
  }
  return VBW_DEFAULT
}
