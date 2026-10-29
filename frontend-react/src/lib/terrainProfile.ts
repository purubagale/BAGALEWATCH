// Ground height and beam profiles for the site page's 3D terrain view
// (2026-10-28). Heights come from the public Terrain Tiles on AWS
// ("terrarium" PNGs: height = R*256 + G + B/256 - 32768 metres), the same
// tiles the 3D map drapes. Zoom 13 is about 17 m per pixel in Nepal, fine
// enough for a ridge in front of a sector and small enough to fetch a few
// tiles per site.
import { destinationPoint } from './sectorWedge'

export const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const Z = 13
const SIZE = 256
// Radio horizon with the usual 4/3 earth: the ground drops away by d^2 / 2kR.
const EFFECTIVE_EARTH_M = (4 / 3) * 6_371_000

const tiles = new Map<string, Promise<Float32Array | null>>()

function tileKey(x: number, y: number) {
  return `${x}/${y}`
}

async function loadTile(x: number, y: number): Promise<Float32Array | null> {
  const url = TERRAIN_TILES.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y))
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const bitmap = await createImageBitmap(await res.blob())
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0)
    const px = ctx.getImageData(0, 0, SIZE, SIZE).data
    const out = new Float32Array(SIZE * SIZE)
    for (let i = 0; i < out.length; i++) out[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768
    return out
  } catch {
    return null
  }
}

function tileOf(x: number, y: number) {
  const key = tileKey(x, y)
  let p = tiles.get(key)
  if (!p) tiles.set(key, (p = loadTile(x, y)))
  return p
}

function worldPixel(lat: number, lng: number) {
  const n = 2 ** Z * SIZE
  const x = ((lng + 180) / 360) * n
  const s = Math.sin((lat * Math.PI) / 180)
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n
  return [x, y]
}

/** Ground height in metres at a point, read bilinearly; null when the tile could not be read. */
export async function groundHeight(lat: number, lng: number): Promise<number | null> {
  const [wx, wy] = worldPixel(lat, lng)
  const x0 = Math.floor(wx - 0.5)
  const y0 = Math.floor(wy - 0.5)
  const fx = wx - 0.5 - x0
  const fy = wy - 0.5 - y0
  const at = async (px: number, py: number) => {
    const t = await tileOf(Math.floor(px / SIZE), Math.floor(py / SIZE))
    if (!t) return null
    return t[(((py % SIZE) + SIZE) % SIZE) * SIZE + (((px % SIZE) + SIZE) % SIZE)]
  }
  const [a, b, c, d] = await Promise.all([at(x0, y0), at(x0 + 1, y0), at(x0, y0 + 1), at(x0 + 1, y0 + 1)])
  if (a == null || b == null || c == null || d == null) return null
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
}

/** What the beam does at a stretch of ground (2026-10-28):
 *   strong  the antenna sees the ground there and it is inside the beam
 *   weak    in view, but outside the beam (under or over it)
 *   shadow  a hill between the antenna and the ground hides it */
export type GroundCover = 'strong' | 'weak' | 'shadow'
export interface CoverRun { from: number; to: number; cover: GroundCover }

/** Walks out from the antenna and sorts each stretch of ground into strong,
 * weak or shadow. A point is in view when no ground nearer the antenna rises
 * above the straight line to it; it is in the beam when that line leaves the
 * antenna within half the vertical beamwidth of the tilt. */
export function coverRuns(
  points: { d: number; ground: number }[], antenna: number, tiltDeg: number | null, verticalBeamwidth: number | null,
): CoverRun[] {
  const half = verticalBeamwidth != null && verticalBeamwidth > 0 && tiltDeg != null ? verticalBeamwidth / 2 : null
  const runs: CoverRun[] = []
  let maxAngle = -Infinity
  let prev = 0
  for (const p of points) {
    const ground = p.ground - (p.d * p.d) / (2 * EFFECTIVE_EARTH_M)
    const angle = (Math.atan2(ground - antenna, p.d) * 180) / Math.PI   // above the horizontal
    const seen = angle >= maxAngle
    if (angle > maxAngle) maxAngle = angle
    const down = -angle
    const cover: GroundCover = !seen ? 'shadow'
      : half != null && down >= (tiltDeg as number) - half && down <= (tiltDeg as number) + half ? 'strong' : 'weak'
    const last = runs[runs.length - 1]
    if (last && last.cover === cover) last.to = p.d
    else runs.push({ from: prev, to: p.d, cover })
    prev = p.d
  }
  return runs
}

/** Metres of each kind of ground in a set of runs. */
export function coverTotals(runs: CoverRun[]): Record<GroundCover, number> {
  const out: Record<GroundCover, number> = { strong: 0, weak: 0, shadow: 0 }
  for (const r of runs) out[r.cover] += r.to - r.from
  return out
}

export interface BeamProfile {
  /** Distance (m) and ground height (m) every `step` metres along the azimuth. */
  points: { d: number; ground: number }[]
  siteGround: number
  /** Antenna height above sea level, when the sector has a height. */
  antenna: number | null
  /** Where the centre of the beam meets the ground on this terrain (m), or null if not within the profile. */
  terrainReachM: number | null
  /** The strong part of the beam (2026-10-28): where its lower edge (tilt +
   * half the vertical beamwidth) and upper edge (tilt - half) meet the
   * ground. Null far edge: it does not come down within the profile. */
  nearM: number | null
  farM: number | null
  verticalBeamwidth: number | null
  /** The same on flat ground, from height and tilt alone. */
  flatReachM: number | null
  /** Highest ground along the profile, and where. */
  peak: { d: number; ground: number }
  /** Strong, weak and shadowed stretches along the azimuth (needs an antenna height). */
  runs: CoverRun[]
}

/** The ground along one sector's azimuth, and where its beam centre lands.
 * The beam centre leaves the antenna at the total down-tilt; the ground is
 * lowered by the earth's curve. Null when the heights could not be read. */
export async function beamProfile(
  lat: number, lng: number, azimuthDeg: number, heightM: number | null, tiltDeg: number | null,
  verticalBeamwidth: number | null = null, lengthM = 6000, step = 25,
): Promise<BeamProfile | null> {
  const siteGround = await groundHeight(lat, lng)
  if (siteGround == null) return null
  const ds: number[] = []
  for (let d = step; d <= lengthM; d += step) ds.push(d)
  const heights = await Promise.all(ds.map((d) => {
    const [la, ln] = destinationPoint(lat, lng, azimuthDeg, d)
    return groundHeight(la, ln)
  }))
  const points: { d: number; ground: number }[] = []
  ds.forEach((d, i) => { if (heights[i] != null) points.push({ d, ground: heights[i] as number }) })
  if (!points.length) return null
  const antenna = heightM != null && heightM > 0 ? siteGround + heightM : null
  // First point where a ray leaving the antenna `down` degrees below the
  // horizontal (negative = upwards) meets the ground, earth's curve included.
  const landing = (down: number | null) => {
    if (antenna == null || down == null) return null
    const tan = Math.tan((down * Math.PI) / 180)
    for (const p of points) {
      if (p.ground - (p.d * p.d) / (2 * EFFECTIVE_EARTH_M) >= antenna - p.d * tan) return p.d
    }
    return null
  }
  const terrainReachM = landing(tiltDeg)
  const half = verticalBeamwidth != null && verticalBeamwidth > 0 ? verticalBeamwidth / 2 : null
  const nearM = tiltDeg != null && half != null ? landing(tiltDeg + half) : null
  const farM = tiltDeg != null && half != null ? landing(tiltDeg - half) : null
  const flatReachM = heightM != null && heightM > 0 && tiltDeg != null && tiltDeg > 0 && tiltDeg < 90
    ? heightM / Math.tan((tiltDeg * Math.PI) / 180) : null
  const peak = points.reduce((m, p) => (p.ground > m.ground ? p : m), points[0])
  const runs = antenna != null ? coverRuns(points, antenna, tiltDeg, verticalBeamwidth) : []
  return { points, siteGround, antenna, terrainReachM, nearM, farM, verticalBeamwidth: half != null ? half * 2 : null, flatReachM, peak, runs }
}

export interface FanRadial { bearing: number; runs: CoverRun[] }

/** The same sorting across the whole sector (2026-10-28): radials every
 * `everyDeg` degrees across the horizontal beamwidth, for a lit-and-shadow
 * footprint on the map. Coarser steps than the single profile, as it reads
 * many more heights. */
export async function beamFan(
  lat: number, lng: number, azimuthDeg: number, horizontalBeamwidth: number, heightM: number, tiltDeg: number | null,
  verticalBeamwidth: number | null, lengthM = 6000, step = 50, everyDeg = 5,
): Promise<FanRadial[] | null> {
  const siteGround = await groundHeight(lat, lng)
  if (siteGround == null) return null
  const antenna = siteGround + heightM
  const n = Math.max(1, Math.round(horizontalBeamwidth / everyDeg))
  const bearings = Array.from({ length: n + 1 }, (_, i) => azimuthDeg - horizontalBeamwidth / 2 + (horizontalBeamwidth * i) / n)
  return Promise.all(bearings.map(async (bearing) => {
    const ds: number[] = []
    for (let d = step; d <= lengthM; d += step) ds.push(d)
    const heights = await Promise.all(ds.map((d) => {
      const [la, ln] = destinationPoint(lat, lng, bearing, d)
      return groundHeight(la, ln)
    }))
    const points = ds.flatMap((d, i) => (heights[i] != null ? [{ d, ground: heights[i] as number }] : []))
    return { bearing, runs: coverRuns(points, antenna, tiltDeg, verticalBeamwidth) }
  }))
}

/** Ground heights of a whole area, read without waiting point by point
 * (2026-10-28, for the predicted coverage): the tiles covering the box are
 * loaded once, then `at(lat, lng)` answers at once (bilinear, metres), or
 * null outside the box or where a tile could not be read. */
export async function heightSampler(
  south: number, west: number, north: number, east: number,
): Promise<{ at: (lat: number, lng: number) => number | null; missing: number }> {
  const [x0, y1] = worldPixel(south, west)
  const [x1, y0] = worldPixel(north, east)
  const tx0 = Math.floor(x0 / SIZE), tx1 = Math.floor(x1 / SIZE)
  const ty0 = Math.floor(y0 / SIZE), ty1 = Math.floor(y1 / SIZE)
  const loaded = new Map<string, Float32Array | null>()
  const jobs: Promise<void>[] = []
  for (let tx = tx0; tx <= tx1 + 1; tx++) {
    for (let ty = ty0; ty <= ty1 + 1; ty++) {
      jobs.push(tileOf(tx, ty).then((t) => { loaded.set(tileKey(tx, ty), t) }))
    }
  }
  await Promise.all(jobs)
  const missing = [...loaded.values()].filter((t) => t == null).length
  const px = (x: number, y: number) => {
    const t = loaded.get(tileKey(Math.floor(x / SIZE), Math.floor(y / SIZE)))
    if (!t) return null
    return t[(((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE)]
  }
  const at = (lat: number, lng: number) => {
    const [wx, wy] = worldPixel(lat, lng)
    const ax = Math.floor(wx - 0.5)
    const ay = Math.floor(wy - 0.5)
    const fx = wx - 0.5 - ax
    const fy = wy - 0.5 - ay
    const a = px(ax, ay), b = px(ax + 1, ay), c = px(ax, ay + 1), d = px(ax + 1, ay + 1)
    if (a == null || b == null || c == null || d == null) return null
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
  }
  return { at, missing }
}

export { EFFECTIVE_EARTH_M }
