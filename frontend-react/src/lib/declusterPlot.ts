// Overlap management for map plots (2026-10-07): "there can be huge no. of
// data in same session with same coordinate ... for same coordinate, same
// site, same sector, manage plot with worst and best data with no
// overlapping. and for same coordinate, different site display along the
// plot with little separation. manage this in all telemetry sessions."
//
// A dense drive-test or live crowdsourced session routinely has many
// samples reported at the identical (or near-identical) GPS fix -- a
// stationary device, a slow/parked stretch, or several passes through the
// same spot. Plotting every one as its own dot just stacks them invisibly
// on top of each other, hiding the very thing a coverage plot exists to
// show: the range between the worst and best reading seen there. This is
// display-only -- it never drops, merges, or alters a stored sample; it
// only decides WHERE a point draws and which of several identical-looking
// points get drawn as separate dots for one render pass.
//
// Two distinct situations, handled together since both can apply to the
// same coordinate at once:
//   1. Several samples at one coordinate from the SAME site+sector --
//      collapsed down to at most two drawn points (the worst and the best
//      by whatever metric is currently selected), nudged a hair apart so
//      both stay visible instead of one hiding the other.
//   2. Several DIFFERENT sites measured from the same coordinate (e.g. a
//      comparison stop) -- each site's own point(s) get arranged a short,
//      fixed distance apart around the true coordinate in a small ring, so
//      one site's marker never sits exactly on another's.
//
// Re-run this per rendered batch, with the metric currently on screen --
// switching metric tabs should re-pick a different worst/best pair, since
// "worst" is only meaningful relative to what's being looked at.

export interface DeclusterInput {
  lat: number
  lng: number
  // '' (or any single constant) groups everything with no resolved site
  // together, same as a real site's own key -- still decluttered as one
  // group, just an anonymous one.
  siteKey: string
  // Already oriented so HIGHER is better (e.g. negate RxQual/RSSI-as-loss
  // style metrics before calling in) -- null means "no reading," neither
  // picked as an extreme unless it's the only sample in its group.
  score: number | null
}

export interface DeclusterResult<T> {
  item: T
  lat: number
  lng: number
  role: 'single' | 'worst' | 'best'
  // How many real samples at this exact coordinate + site this one drawn
  // point stands in for -- show it in the tooltip so "1 dot" doesn't read
  // as "1 sample" when it's actually summarizing many.
  collapsedCount: number
}

// ~1.1 m grouping bucket at the equator -- tight enough that two genuinely
// different street-level fixes don't merge, loose enough that repeated GPS
// reads of one stationary phone (which rarely land bit-identical) count as
// "the same coordinate."
const COORD_PRECISION = 5
const GROUP_SEPARATION_M = 4
const MICRO_JITTER_M = 1.5

function metersToDegLat(m: number): number {
  return m / 111_320
}

function metersToDegLng(m: number, atLat: number): number {
  return m / (111_320 * Math.max(0.0001, Math.cos((atLat * Math.PI) / 180)))
}

export function declusterForPlot<T>(items: T[], get: (item: T) => DeclusterInput): DeclusterResult<T>[] {
  interface Entry {
    item: T
    input: DeclusterInput
  }
  interface CoordBucket {
    lat0: number
    lng0: number
    sites: Map<string, Entry[]>
  }
  const coordBuckets = new Map<string, CoordBucket>()

  for (const item of items) {
    const input = get(item)
    if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) continue
    const coordKey = `${input.lat.toFixed(COORD_PRECISION)},${input.lng.toFixed(COORD_PRECISION)}`
    let bucket = coordBuckets.get(coordKey)
    if (!bucket) {
      bucket = { lat0: input.lat, lng0: input.lng, sites: new Map() }
      coordBuckets.set(coordKey, bucket)
    }
    const list = bucket.sites.get(input.siteKey)
    if (list) list.push({ item, input })
    else bucket.sites.set(input.siteKey, [{ item, input }])
  }

  const out: DeclusterResult<T>[] = []
  for (const bucket of coordBuckets.values()) {
    const siteKeys = [...bucket.sites.keys()]
    const n = siteKeys.length
    siteKeys.forEach((siteKey, i) => {
      const group = bucket.sites.get(siteKey)!
      // This site's own cluster centre, relative to the true coordinate --
      // spread evenly around a small ring when more than one site shares
      // this exact spot; dead-centre on the real point when only one does.
      const angle = n > 1 ? (2 * Math.PI * i) / n : 0
      const groupR = n > 1 ? GROUP_SEPARATION_M : 0
      const gLat = bucket.lat0 + metersToDegLat(groupR * Math.sin(angle))
      const gLng = bucket.lng0 + metersToDegLng(groupR * Math.cos(angle), bucket.lat0)

      if (group.length === 1) {
        out.push({ item: group[0].item, lat: gLat, lng: gLng, role: 'single', collapsedCount: 1 })
        return
      }

      let worst = group[0]
      let best = group[0]
      for (const g of group) {
        const s = g.input.score
        if (s != null && (worst.input.score == null || s < worst.input.score)) worst = g
        if (s != null && (best.input.score == null || s > best.input.score)) best = g
      }
      const mLat = metersToDegLat(MICRO_JITTER_M / 2)
      const mLng = metersToDegLng(MICRO_JITTER_M / 2, bucket.lat0)
      out.push({
        item: worst.item, lat: gLat - mLat, lng: gLng - mLng,
        role: 'worst', collapsedCount: group.length,
      })
      if (best !== worst) {
        out.push({
          item: best.item, lat: gLat + mLat, lng: gLng + mLng,
          role: 'best', collapsedCount: group.length,
        })
      }
    })
  }
  return out
}
