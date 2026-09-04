import type { SiteListItem } from '../api/types'

// Search-box resolver for TelemetryDriveTestSessionsPage's "search an
// area, enroll only the devices found there" flow (2026-09-02 request:
// "like in dt data manager, explore where can search or select certain
// area displays the plot, here display and list registered device on
// the searched or selected area"). The user picked "Reuse DT Explore's
// search box" via AskUserQuestion, so this deliberately mirrors
// components/DtExploreTab.tsx's resolveQuery() pipeline (coordinates,
// then Site ID/name, then city/district) closely enough to feel
// familiar -- same DMS-aware coordinate parsing, same site match order
// (exact id/name -> id prefix -> loose substring), same city/district
// site-centroid fallback.
//
// It is intentionally a separate, smaller file rather than an import
// from DtExploreTab.tsx or an extraction into a shared module:
// DtExploreTab.tsx is a large, map-heavy component never fully read this
// session, and refactoring it to export its internals would risk a
// regression there for a feature that doesn't need most of what it
// does. This resolver also deliberately DROPS DtExploreTab's real
// district-boundary-polygon tier (NEPAL_DISTRICT_BOUNDARIES) -- that
// tier exists there to draw an accurate irregular search AREA on a map;
// here the "area" is only ever a device-enrollment radius circle around
// a point (there is no polygon-membership device query on the backend
// to match it), so the extra complexity has no payoff. A city/district
// name still resolves via the site-centroid fallback below, same as
// DtExploreTab's last-resort tier.

export interface ResolvedAreaPoint {
  lat: number
  lng: number
  label: string
}

const DMS_PAIR_RE =
  /(\d{1,3}(?:\.\d+)?)\s*[°d]\s*(\d{1,2}(?:\.\d+)?)\s*['’m]\s*(\d{1,2}(?:\.\d+)?)\s*(?:["”″]|s)?\s*([NSns])[,\s]+(\d{1,3}(?:\.\d+)?)\s*[°d]\s*(\d{1,2}(?:\.\d+)?)\s*['’m]\s*(\d{1,2}(?:\.\d+)?)\s*(?:["”″]|s)?\s*([EWew])/

function dmsToDecimal(deg: string, min: string, sec: string, hemi: string): number {
  const value = parseFloat(deg) + parseFloat(min) / 60 + parseFloat(sec) / 3600
  return /[SW]/i.test(hemi) ? -value : value
}

// Same fix as DtExploreTab.tsx's parseLatLngDms/parseLatLng: try a real
// DMS parser BEFORE the plain-decimal path, since `parseFloat` silently
// truncates a DMS string like `26°33'40.7"N` at the `°` character
// instead of failing, which would otherwise mis-resolve to (26, 87)-ish
// instead of the real point.
function parseLatLngDms(text: string): { lat: number; lng: number } | null {
  const m = text.trim().match(DMS_PAIR_RE)
  if (!m) return null
  const lat = dmsToDecimal(m[1], m[2], m[3], m[4])
  const lng = dmsToDecimal(m[5], m[6], m[7], m[8])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

function parseLatLng(text: string): { lat: number; lng: number } | null {
  const trimmed = text.trim()
  const dms = parseLatLngDms(trimmed)
  if (dms) return dms
  const parts = trimmed.split(/[,\s]+/).filter(Boolean)
  if (parts.length !== 2) return null
  const lat = parseFloat(parts[0])
  const lng = parseFloat(parts[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

// Mirrors DtExploreTab.tsx's resolveSiteQuery() match order exactly:
// exact Site ID, exact name, ID prefix, then (loose=true only) a
// substring match against either. `loose` is split out the same way so
// a future city/district tier can be tried in between (not needed here
// since there's no boundary-polygon tier to sequence against).
function resolveSiteQuery(text: string, sites: SiteListItem[], loose: boolean): ResolvedAreaPoint | null {
  const q = text.trim().toLowerCase()
  if (!q) return null
  const withCoords = (s: SiteListItem) => s.lat != null && s.lng != null
  const candidates = sites.filter(withCoords)
  const site =
    candidates.find((s) => (s.id || '').toLowerCase() === q) ??
    candidates.find((s) => (s.name || '').toLowerCase() === q) ??
    candidates.find((s) => (s.id || '').toLowerCase().startsWith(q)) ??
    (loose
      ? candidates.find((s) => (s.id || '').toLowerCase().includes(q) || (s.name || '').toLowerCase().includes(q))
      : undefined)
  if (!site) return null
  return { lat: site.lat as number, lng: site.lng as number, label: `${site.name || site.id} (${site.id})` }
}

// Last-resort tier: average the coordinates of every site whose
// city/district matches (exact first, then substring) -- same fallback
// DtExploreTab.tsx uses for district names it has no real boundary
// polygon for.
function resolveCityDistrictQuery(text: string, sites: SiteListItem[]): ResolvedAreaPoint | null {
  const q = text.trim().toLowerCase()
  if (!q) return null
  const withCoords = (s: SiteListItem) => s.lat != null && s.lng != null
  for (const field of ['city', 'district'] as const) {
    let matches = sites.filter((s) => withCoords(s) && (s[field] || '').toLowerCase().trim() === q)
    if (!matches.length) matches = sites.filter((s) => withCoords(s) && (s[field] || '').toLowerCase().includes(q))
    if (matches.length) {
      const lat = matches.reduce((a, s) => a + (s.lat as number), 0) / matches.length
      const lng = matches.reduce((a, s) => a + (s.lng as number), 0) / matches.length
      const noun = field === 'city' ? matches[0].city : matches[0].district
      const label = `${noun} (${matches.length} site${matches.length > 1 ? 's' : ''})`
      return { lat, lng, label }
    }
  }
  return null
}

// Resolution order, most to least confident -- same shape as
// DtExploreTab.tsx's resolveQuery() with the boundary-polygon tier
// removed: coordinates -> exact/prefix site -> loose site substring ->
// city/district.
export function resolveAreaQuery(text: string, sites: SiteListItem[]): ResolvedAreaPoint | null {
  const coord = parseLatLng(text)
  if (coord) return { ...coord, label: `${coord.lat.toFixed(5)}, ${coord.lng.toFixed(5)}` }
  return (
    resolveSiteQuery(text, sites, false) ??
    resolveSiteQuery(text, sites, true) ??
    resolveCityDistrictQuery(text, sites)
  )
}
