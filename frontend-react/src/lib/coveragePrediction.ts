// Predicted coverage around a site (2026-10-28). For every point of a grid
// round the site and every antenna direction, the level a phone 1.5 m above
// the ground would read:
//
//   level = power + antenna gain - feeder loss
//           - antenna pattern (horizontal and vertical, 3GPP TR 36.814 shape)
//           - path loss (Okumura-Hata up to 1500 MHz, COST-231 Hata above,
//             with the antenna's height over the point's ground, so a hill
//             site over a valley counts as a tall one)
//           - the loss over the highest ridge between (knife-edge diffraction,
//             ITU-R P.526) on the same ground heights as the 3D view
//           + a model offset, set from drive tests (see calibrate below).
//
// The radio values come from core/coverage_prediction.py: typical figures
// until NTC's planning values arrive, changed by an admin on the site map. It
// is an estimate of the kind planning tools make, not a measurement: no
// buildings or trees, ground detail about 30 m.
import type { PredictionSettings, RadioBand, RadioBandKey } from '../api/types'
import { bandGroup, patternLossDb, type BandFields, type BandGroup } from './sectorWedge'
import { EFFECTIVE_EARTH_M, heightSampler } from './terrainProfile'

export type PredictTech = '2G' | '3G' | '4G'

/** Which band's radio values a sector uses. */
export function bandKeyOf(s: BandFields): RadioBandKey {
  const tech = (s.tech || '4G').toUpperCase()
  if (tech === '2G') return /1800|DCS/.test(`${s.site_band || ''} ${s.carrier || ''}`.toUpperCase()) ? 'gsm1800' : 'gsm900'
  if (tech === '3G') return 'wcdma_b1'
  return bandGroup(s) === 'low' ? 'lte_b20' : 'lte_b3'
}

export interface Transmitter {
  key: string
  lat: number
  lng: number
  az: number
  /** Total down-tilt and height as used, and whether they were assumed. */
  tilt: number
  height: number
  assumedTilt: boolean
  assumedHeight: boolean
  /** Horizontal beamwidth; null = omni. */
  hbw: number | null
  vbw: number
  band: RadioBandKey
  tech: PredictTech
  /** The sector's own maximum transmit power (engineering parameters), when known. */
  maxTxDbm: number | null
  /** Cell names, to match measured readings. */
  cells: string[]
}

export function makeTransmitter(
  d: { key: string; az: number; tilt: number | null; height: number | null; origin: [number, number]; band: BandGroup;
    sectors: (BandFields & { cell_name?: string | null; max_tx_power_dbm?: number | null })[] },
  hbw: number | null, vbw: Record<BandGroup, number>, settings: PredictionSettings,
): Transmitter {
  const s0 = d.sectors[0]
  const band = bandKeyOf(s0)
  const powers = d.sectors.map((s) => s.max_tx_power_dbm).filter((v): v is number => v != null)
  return {
    key: d.key, lat: d.origin[0], lng: d.origin[1], az: d.az,
    tilt: d.tilt ?? settings.default_tilt_deg, assumedTilt: d.tilt == null,
    height: d.height != null && d.height > 0 ? d.height : settings.default_height_m, assumedHeight: !(d.height != null && d.height > 0),
    hbw, vbw: vbw[d.band], band, tech: settings.bands[band].tech,
    maxTxDbm: powers.length ? Math.max(...powers) : null,
    cells: d.sectors.map((s) => (s.cell_name || '').trim().toLowerCase()).filter(Boolean),
  }
}

/** The power the level is counted from: the band's value, or the sector's
 * own maximum power turned into it (4G: per resource element, 12 x 5 per MHz;
 * 3G: CPICH at 10%; 2G: the BCCH carrier). */
export function referencePower(tx: Transmitter, band: RadioBand): { dbm: number; from: 'sector' | 'band' } {
  if (tx.maxTxDbm == null) return { dbm: band.power_dbm, from: 'band' }
  if (band.tech === '4G') return { dbm: tx.maxTxDbm - 10 * Math.log10(12 * 5 * (band.bandwidth_mhz || 10)), from: 'sector' }
  if (band.tech === '3G') return { dbm: tx.maxTxDbm - 10, from: 'sector' }
  return { dbm: tx.maxTxDbm, from: 'sector' }
}

/** Hata path loss in dB (median), never below free space. */
export function hataLossDb(fMhz: number, dKm: number, hbM: number, hmM: number, env: PredictionSettings['environment']): number {
  const d = Math.max(dKm, 0.02)
  const hb = Math.min(Math.max(hbM, 10), 300)
  const lf = Math.log10(fMhz)
  const a = (1.1 * lf - 0.7) * hmM - (1.56 * lf - 0.8)
  const slope = (44.9 - 6.55 * Math.log10(hb)) * Math.log10(d)
  let l = fMhz <= 1500
    ? 69.55 + 26.16 * lf - 13.82 * Math.log10(hb) - a + slope
    : 46.3 + 33.9 * lf - 13.82 * Math.log10(hb) - a + slope
  if (env === 'suburban') l -= 2 * Math.log10(fMhz / 28) ** 2 + 5.4
  else if (env === 'rural') l -= 4.78 * lf ** 2 - 18.33 * lf + 40.94
  const free = 32.45 + 20 * lf + 20 * Math.log10(d)
  return Math.max(l, free)
}

/** Knife-edge diffraction loss J(v), ITU-R P.526. */
export function knifeEdgeDb(v: number): number {
  if (v <= -0.78) return 0
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1)
}

const R_EARTH = 6_371_000
function distanceM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = Math.PI / 180
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = Math.PI / 180
  const y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r)
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r)
  return ((Math.atan2(y, x) / r) + 360) % 360
}

export interface PredictionContext {
  settings: PredictionSettings
  at: (lat: number, lng: number) => number | null
  /** Ground at each transmitter, read once. */
  ground: Map<string, number | null>
  /** Profile step (m). */
  step: number
}

/** The level one transmitter gives at one point, or null without ground heights. */
export function levelAt(tx: Transmitter, lat: number, lng: number, ctx: PredictionContext,
  geom?: { d: number; G: number; rxGround: number }): number | null {
  const band = ctx.settings.bands[tx.band]
  const g0 = ctx.ground.get(tx.key)
  if (g0 == null) return null
  const hAnt = g0 + tx.height
  const g = geom ?? profileGeometry(tx.lat, tx.lng, hAnt, lat, lng, ctx)
  if (!g) return null
  const { d, G, rxGround } = g
  const hRx = rxGround + ctx.settings.rx_height_m
  const lambda = 299.792458 / band.freq_mhz
  const diffraction = knifeEdgeDb(G / Math.sqrt(lambda))
  const pathLoss = hataLossDb(band.freq_mhz, d / 1000, hAnt - rxGround, ctx.settings.rx_height_m, ctx.settings.environment)
  let off = Math.abs(bearingDeg(tx.lat, tx.lng, lat, lng) - tx.az) % 360
  if (off > 180) off = 360 - off
  const horizontal = tx.hbw == null ? 0 : patternLossDb(off, tx.hbw)
  const down = (Math.atan2(hAnt - hRx, Math.max(d, 1)) * 180) / Math.PI
  const vertical = Math.min(12 * ((down - tx.tilt) / tx.vbw) ** 2, 20)
  const antenna = Math.min(horizontal + vertical, 25)
  return referencePower(tx, band).dbm + band.gain_dbi - band.loss_db - antenna - pathLoss - diffraction + ctx.settings.offset_db
}

/** Distance, the highest ridge's geometry factor (v times the square root of
 * the wavelength, so one walk serves every band) and the point's ground. */
export function profileGeometry(
  txLat: number, txLng: number, hAnt: number, lat: number, lng: number, ctx: PredictionContext,
): { d: number; G: number; rxGround: number } | null {
  const rxGround = ctx.at(lat, lng)
  if (rxGround == null) return null
  const d = distanceM(txLat, txLng, lat, lng)
  const hRx = rxGround + ctx.settings.rx_height_m
  const n = Math.min(120, Math.ceil(d / ctx.step))
  let G = -Infinity
  for (let i = 1; i < n; i++) {
    const f = i / n
    const ground = ctx.at(txLat + (lat - txLat) * f, txLng + (lng - txLng) * f)
    if (ground == null) continue
    const d1 = d * f
    const d2 = d - d1
    const h = ground + (d1 * d2) / (2 * EFFECTIVE_EARTH_M) - (hAnt + (hRx - hAnt) * f)
    const v = h * Math.sqrt((2 * d) / (d1 * d2))
    if (v > G) G = v
  }
  return { d, G: Number.isFinite(G) ? G : -10, rxGround }
}

export interface PredictionGrid {
  south: number; west: number; north: number; east: number
  n: number
  /** Best level per cell (NaN = no ground height), and which transmitter gives it (-1 none). */
  best: Float32Array
  server: Int16Array
  /** Second best, for the overlap with the next sector. */
  second: Float32Array
  transmitters: Transmitter[]
  ctx: PredictionContext
  missingTiles: number
}

/** Ground heights for a box `radiusM` round a point, ready for levelAt. */
export async function predictionContext(
  lat: number, lng: number, radiusM: number, transmitters: Transmitter[], settings: PredictionSettings, step: number,
): Promise<PredictionContext & { missing: number }> {
  const dLat = (radiusM / R_EARTH) * (180 / Math.PI)
  const dLng = dLat / Math.cos((lat * Math.PI) / 180)
  const sampler = await heightSampler(lat - dLat * 1.05, lng - dLng * 1.05, lat + dLat * 1.05, lng + dLng * 1.05)
  const ground = new Map(transmitters.map((t) => [t.key, sampler.at(t.lat, t.lng)]))
  return { settings, at: sampler.at, ground, step, missing: sampler.missing }
}

/** The whole grid, `n` x `n` cells over a square `radiusM` round the site.
 * Works in slices and yields between them so the page stays responsive;
 * `cancelled()` stops it early. */
export async function predictGrid(
  lat: number, lng: number, radiusM: number, transmitters: Transmitter[], settings: PredictionSettings,
  n = 120, cancelled: () => boolean = () => false,
): Promise<PredictionGrid | null> {
  const step = (2 * radiusM) / n
  const ctx = await predictionContext(lat, lng, radiusM, transmitters, settings, step)
  if (cancelled()) return null
  const dLat = (radiusM / R_EARTH) * (180 / Math.PI)
  const dLng = dLat / Math.cos((lat * Math.PI) / 180)
  const south = lat - dLat, north = lat + dLat, west = lng - dLng, east = lng + dLng
  const best = new Float32Array(n * n).fill(NaN)
  const second = new Float32Array(n * n).fill(NaN)
  const server = new Int16Array(n * n).fill(-1)
  // Transmitters on one mast share the walk over the ground.
  const masts = new Map<string, number[]>()
  transmitters.forEach((t, i) => {
    const k = `${t.lat.toFixed(6)},${t.lng.toFixed(6)},${t.height}`
    masts.set(k, [...(masts.get(k) ?? []), i])
  })
  for (let row = 0; row < n; row++) {
    if (row % 12 === 0) {
      await new Promise((r) => setTimeout(r, 0))
      if (cancelled()) return null
    }
    const pLat = north - (row + 0.5) * (north - south) / n
    for (let col = 0; col < n; col++) {
      const pLng = west + (col + 0.5) * (east - west) / n
      const idx = row * n + col
      for (const members of masts.values()) {
        const t0 = transmitters[members[0]]
        const g0 = ctx.ground.get(t0.key)
        if (g0 == null) continue
        const geom = profileGeometry(t0.lat, t0.lng, g0 + t0.height, pLat, pLng, ctx)
        if (!geom) continue
        for (const i of members) {
          const v = levelAt(transmitters[i], pLat, pLng, ctx, geom)
          if (v == null) continue
          if (Number.isNaN(best[idx]) || v > best[idx]) {
            second[idx] = best[idx]
            best[idx] = v
            server[idx] = i
          } else if (Number.isNaN(second[idx]) || v > second[idx]) {
            second[idx] = v
          }
        }
      }
    }
  }
  return { south, west, north, east, n, best, server, second, transmitters, ctx, missingTiles: ctx.missing }
}

/** Measured against predicted on the same sector (2026-10-28): how far the
 * readings sit from the prediction, on average and spread. A steady
 * difference is what the model offset is for. */
export function calibrate(
  grid: PredictionGrid, squares: { key: string; lat: number; lng: number; level: number | null }[],
): { n: number; mean: number; sd: number } | null {
  const byCell = new Map<string, Transmitter>()
  for (const t of grid.transmitters) for (const c of t.cells) byCell.set(c, t)
  const diffs: number[] = []
  for (const q of squares) {
    if (q.level == null) continue
    const t = byCell.get(q.key.trim().toLowerCase())
    if (!t) continue
    if (q.lat < grid.south || q.lat > grid.north || q.lng < grid.west || q.lng > grid.east) continue
    const p = levelAt(t, q.lat, q.lng, grid.ctx)
    if (p == null) continue
    diffs.push(q.level - p)
  }
  if (diffs.length < 5) return diffs.length ? { n: diffs.length, mean: NaN, sd: NaN } : null
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / diffs.length)
  return { n: diffs.length, mean, sd }
}
