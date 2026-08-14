import type { Sector } from '../api/types'

// Shared by SiteLocationMiniMap.tsx (Site Detail sidebar) and MapView.tsx
// (main Sites map) — one definition of "does this sector actually sit
// somewhere different from its site" so the two maps can't quietly drift
// out of sync on what counts as divergent (2026-08-09, "sometimes same
// sites with multiple sectors may have different lat long location as
// sector expansion. manage this condition also in the system").

// ~11m at Nepal's latitude — small enough that two GPS readings of the
// same physical spot (rounding/drift) still count as "the same
// location," large enough not to fire on floating-point noise. Anything
// genuinely further apart than this is treated as a real second
// location, e.g. a sector expansion cabinet installed some real distance
// from the site's original coordinate.
export const SAME_LOCATION_EPSILON_DEG = 0.0001

export interface SectorLocationPoint {
  lat: number
  lng: number
  label: string
}

/** Every distinct point (beyond the site's own) that at least one sector
 * genuinely occupies — sectors sharing the same overridden coordinate
 * (e.g. a whole expansion cabinet's worth) are merged into one point with
 * a combined label, rather than stacking identical markers. Sectors with
 * no override (`lat`/`lng` both null) or whose override is within
 * `SAME_LOCATION_EPSILON_DEG` of the site itself are excluded entirely —
 * they're at the site, nothing new to plot. */
export function divergentSectorPoints(siteLat: number, siteLng: number, sectors: Sector[]): SectorLocationPoint[] {
  const points: SectorLocationPoint[] = []
  for (const sec of sectors) {
    if (sec.lat == null || sec.lng == null) continue
    const dLat = Math.abs(sec.lat - siteLat)
    const dLng = Math.abs(sec.lng - siteLng)
    if (dLat < SAME_LOCATION_EPSILON_DEG && dLng < SAME_LOCATION_EPSILON_DEG) continue
    const existing = points.find(
      (p) => Math.abs(p.lat - (sec.lat as number)) < SAME_LOCATION_EPSILON_DEG && Math.abs(p.lng - (sec.lng as number)) < SAME_LOCATION_EPSILON_DEG,
    )
    const label = sec.cell_name || sec.sector || `Sector ${sec.id}`
    if (existing) {
      existing.label += `, ${label}`
    } else {
      points.push({ lat: sec.lat, lng: sec.lng, label })
    }
  }
  return points
}
