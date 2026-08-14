// District/region backfill for sites missing them (2026-08-10, "there
// are 248 unassigned sites displaying. it may be due to the absence of
// district. find the district of the sites and update in district
// field, so that they will not be shown in the unassigned list").
//
// Root cause: SidebarTree.tsx buckets a site under "Unassigned" purely
// via `site.region || 'Unassigned'` / `site.district || 'Unassigned'`.
// The actual source of the 248: a Site auto-created by a sector-only
// upload when its site didn't exist yet (core/site_import.py's
// `_apply_sectors`) only ever gets `id`/`lat`/`lng` set — no district,
// region, or name — since the row that creates it is a SECTOR row, not
// a Site Details row with that information on it.
//
// Resolution reuses this app's own already-trusted district boundary
// data (`NEPAL_DISTRICT_BOUNDARIES` — real polygons for 75 of Nepal's 77
// districts, see nepalDistrictBoundaries.ts's own docstring for the 2
// gaps) and `pointInPolygon` (lib/geo.ts) — the exact same pair
// DtExploreTab.tsx's "Explore by Coordinates" already relies on. This
// stays entirely client-side deliberately (see
// core/site_import.py's BackfillSiteLocationView docstring) rather than
// duplicating ~75 districts' worth of polygon data into the backend a
// second time.
import type { SiteListItem } from '../api/types'
import { pointInPolygon } from './geo'
import { NEPAL_DISTRICT_BOUNDARIES } from './nepalDistrictBoundaries'

export interface DistrictBackfillUpdate {
  id: string
  district: string
  region: string
}

export interface DistrictBackfillResult {
  updates: DistrictBackfillUpdate[]
  // Sites with a blank district that this pass could NOT resolve —
  // either no lat/lng recorded at all (nothing to test), or their point
  // didn't fall inside any of the 75 available polygons (most likely
  // Eastern Rukum or Nawalpur — the 2 districts with no polygon — or a
  // genuinely bad/out-of-Nepal coordinate). Surfaced to the user rather
  // than silently dropped, since these still need a real fix (manual
  // entry, or a future re-survey), just not one this pass can make.
  unmatched: SiteListItem[]
}

/** Resolves district (via point-in-polygon) and region (reused from
 * another real site already in this exact deployment that shares the
 * same district — never a hardcoded province-name guess, since the
 * live data is the ground truth for whatever label format this
 * deployment actually uses) for every site with a blank district. Sites
 * that already have a district are left alone entirely — this function
 * never proposes changing one that's already set. */
export function resolveDistrictBackfill(sites: SiteListItem[]): DistrictBackfillResult {
  const regionByDistrict = new Map<string, string>()
  for (const s of sites) {
    if (s.district && s.region && !regionByDistrict.has(s.district)) {
      regionByDistrict.set(s.district, s.region)
    }
  }

  const districtEntries = Object.entries(NEPAL_DISTRICT_BOUNDARIES)
  const updates: DistrictBackfillUpdate[] = []
  const unmatched: SiteListItem[] = []

  for (const s of sites) {
    if (s.district) continue
    if (s.lat == null || s.lng == null) {
      unmatched.push(s)
      continue
    }
    const hit = districtEntries.find(([, poly]) => pointInPolygon(s.lat as number, s.lng as number, poly))
    if (!hit) {
      unmatched.push(s)
      continue
    }
    const [district] = hit
    updates.push({ id: s.id, district, region: regionByDistrict.get(district) || '' })
  }

  return { updates, unmatched }
}
