import { useMemo, useRef, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useTreeStore } from '../store/treeStore'
import { useAuth } from '../auth/AuthContext'
import { isAllowed } from '../api/types'
import type { SiteListItem } from '../api/types'
import { STATUS_COLOR } from '../lib/statusColor'

// Read-only Province -> District -> Site tree, virtualized so the DOM
// node count stays roughly constant regardless of site count — the same
// hard performance constraint v1's virtual-scroll sidebar was built
// around (see CLAUDE.md's "Virtual scroll" decision and §7.3 of the
// migration plan, which calls out React's declarative rendering as an
// easy way to accidentally regress this if it's not treated as a
// first-class requirement). Default COLLAPSED, matching v1's default.

type Row =
  | { kind: 'province'; key: string; name: string; count: number }
  | { kind: 'district'; key: string; provinceKey: string; provinceName: string; name: string; count: number }
  | { kind: 'site'; key: string; site: SiteListItem }

const ROW_HEIGHT = 30

// Tech badge color class (2026-08-10, "in site tree, also display
// available tech type in site") — same `tech-2g`/`tech-3g`/`tech-4g`
// palette + fallback-to-green-for-anything-else rule as SiteDetailPage's
// own `techBadgeClass()` (App.css's `--tech-2g/-3g/-4g` tokens), just a
// second small copy here rather than a shared import — same tradeoff
// already made for `_haversine_km` duplication elsewhere in this app
// (see core/drive_test.py's comment): a 4-line pure function isn't worth
// a new shared module for two call sites.
function techBadgeClass(tech: string): string {
  const t = (tech || '').toUpperCase()
  if (t === '2G') return 'tech-2g'
  if (t === '3G') return 'tech-3g'
  return 'tech-4g'
}

// `forceExpandAll` (2026-08-10, "while searching in side tree it
// displays directly the sites related to search, but need to display in
// which region, district it comes... display updated site count on
// every level") — when a search query is active, `sites` passed in here
// is already pre-filtered to matches only (see `siteMatchesTreeQuery`
// below), so grouping them through this SAME function naturally gives
// correct per-province/per-district MATCH counts (not the region's true
// total) and only surfaces provinces/districts that actually contain a
// match. `forceExpandAll` makes every one of those nodes render open
// regardless of the user's persisted expand/collapse state (useTreeStore)
// — search results should be visible immediately, not require manually
// re-expanding a province that happens to be collapsed right now — while
// leaving that persisted state itself untouched, so clearing the search
// returns the tree to exactly how the user had left it.
function buildRows(
  sites: SiteListItem[],
  expandedProvinces: Set<string>,
  expandedDistricts: Set<string>,
  forceExpandAll = false,
): Row[] {
  const byProvince = new Map<string, Map<string, SiteListItem[]>>()
  for (const site of sites) {
    const province = site.region || 'Unassigned'
    const district = site.district || 'Unassigned'
    if (!byProvince.has(province)) byProvince.set(province, new Map())
    const districts = byProvince.get(province)!
    if (!districts.has(district)) districts.set(district, [])
    districts.get(district)!.push(site)
  }

  const rows: Row[] = []
  for (const province of [...byProvince.keys()].sort()) {
    const districts = byProvince.get(province)!
    const provinceCount = [...districts.values()].reduce((n, arr) => n + arr.length, 0)
    const provinceKey = `prov-${province}`
    rows.push({ kind: 'province', key: provinceKey, name: province, count: provinceCount })
    if (!forceExpandAll && !expandedProvinces.has(provinceKey)) continue

    for (const district of [...districts.keys()].sort()) {
      const districtSites = districts.get(district)!
      const districtKey = `dist-${provinceKey}-${district}`
      rows.push({
        kind: 'district',
        key: districtKey,
        provinceKey,
        provinceName: province,
        name: district,
        count: districtSites.length,
      })
      if (!forceExpandAll && !expandedDistricts.has(districtKey)) continue

      for (const site of [...districtSites].sort((a, b) => a.name.localeCompare(b.name))) {
        rows.push({ kind: 'site', key: `site-${site.id}`, site })
      }
    }
  }
  return rows
}

// Search matching, ported from v1's own `_siteMatchesQ` convention
// (CLAUDE.md: region excluded on purpose, to prevent a query merely
// sharing a word with the wrong province from surfacing an unrelated
// site — id/name/city/district/tech only, never region). Exported so
// SitesPage.tsx can reuse the EXACT same predicate when narrowing the
// map to "only the matching sites" after a province/district click
// during an active search (2026-08-10 follow-up — see the module
// comment on `buildRows` above).
//
// Tech is included too (2026-08-10, "make top search bar of site tree
// searchable according to tech type also") — checks both `techs` (the
// full per-site union computed server-side, see SiteListSerializer) and
// the plain `tech` field as a fallback for older cached data that might
// not have `techs` populated yet. Typing "2g" now surfaces every site
// with a 2G sector even if the site's own `tech` column says "4G".
export function siteMatchesTreeQuery(s: SiteListItem, q: string): boolean {
  return (
    s.id.toLowerCase().includes(q) ||
    (s.name || '').toLowerCase().includes(q) ||
    (s.city || '').toLowerCase().includes(q) ||
    (s.district || '').toLowerCase().includes(q) ||
    (s.techs || []).some((t) => t.toLowerCase().includes(q)) ||
    (s.tech || '').toLowerCase().includes(q)
  )
}

export default function SidebarTree({
  sites,
  query,
  onQueryChange,
  onSelectAll,
  onSelectProvince,
  onSelectDistrict,
  onSelectSite,
}: {
  sites: SiteListItem[]
  // Search query (2026-08-10 follow-up — controlled, lifted up from what
  // used to be local state here) — "while searching in side tree it
  // displays directly the sites related to search, but need to display
  // in which region, district it comes... if i click the region, then
  // display the result sites only in the map and same for district."
  // SitesPage needs the live query value too, to intersect it with
  // whatever province/district gets clicked while a search is active
  // (see its own `scope` useMemo) — a plain local `useState` here
  // couldn't be read from the parent, so it moved up one level, same
  // "lift state so a sibling/parent can use it" pattern already applied
  // to the Advanced Search modal's form/results.
  query: string
  onQueryChange: (q: string) => void
  // Scope-selection callbacks (2026-08-04) — folded in from the now-
  // retired standalone Topology page/tree (TopologyTree.tsx) per explicit
  // user request: "use concept of NTC all sites, region wise, district
  // wise selection of topology in sites map without affecting the
  // display theme of sites map." Deliberately just names/ids, not a
  // row's own `sites` snapshot — SitesPage re-derives the live filtered
  // list itself via useMemo off useSites(), same reasoning as
  // TopologyPage's live-derived scope (a frozen snapshot would go stale
  // the instant a site is added/relocated/deleted through the map).
  onSelectAll: () => void
  onSelectProvince: (province: string) => void
  onSelectDistrict: (province: string, district: string) => void
  // Site-row clicks now go through the parent (instead of calling the
  // tree store's selectSite directly here) so SitesPage can also widen
  // the map scope to include a site clicked from outside it — e.g. a
  // search result in a province that isn't the currently-loaded scope.
  onSelectSite: (site: SiteListItem) => void
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const { user } = useAuth()
  const { expandedProvinces, expandedDistricts, selectedSiteId, toggleProvince, toggleDistrict } = useTreeStore()

  // Per-row Edit / Add Sector shortcut icons (2026-07-30, ported concept
  // from v1's tree, which had both inline) — gated the same way
  // SiteDetailPage gates its own Edit button, so a viewer-role user
  // doesn't see icons that would just 403 if clicked.
  const canUpdate = !!user && isAllowed(user.role, user.permissions.sites, 'update')

  const q = query.trim().toLowerCase()
  // Hierarchical search (2026-08-10 rework, replaces the old flat-list
  // mode) — matched sites are grouped through the SAME buildRows() used
  // for normal browsing, `forceExpandAll: true` so every province/
  // district that contains a match renders open immediately. This gives
  // the counts and grouping "for free": a province/district row's count
  // is exactly the number of ITS matching sites, and only branches that
  // actually contain a match ever appear.
  const matchedSites = useMemo(() => (q ? sites.filter((s) => siteMatchesTreeQuery(s, q)) : sites), [sites, q])
  const rows = useMemo(
    () =>
      q
        ? buildRows(matchedSites, expandedProvinces, expandedDistricts, true)
        : buildRows(sites, expandedProvinces, expandedDistricts),
    [sites, matchedSites, q, expandedProvinces, expandedDistricts],
  )

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  return (
    <div className="sidebar-tree-wrap">
      <div className="sidebar-tree-search">
        <input
          type="text"
          placeholder="Search sites, city, district, tech…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
      </div>
      {/* Pinned scope row (2026-08-04, folded in from the retired
          standalone Topology page) — always visible above search/scroll,
          same convention TopologyTree used for its "NTC — All Sites"
          row. Only sets the MAP's scope; never touches expand state.
          Count reflects the active search (2026-08-10) same as every
          other level, so it doesn't look stuck at the unfiltered total
          while every row underneath it is showing filtered counts. */}
      <div className="tree-row tree-row-province tree-row-all-sites" onClick={onSelectAll}>
        <span className="tree-caret">📍</span>
        <span className="tree-label">NTC — All Sites</span>
        <span className="tree-count">{q ? matchedSites.length : sites.length}</span>
      </div>
      <div ref={parentRef} className="sidebar-tree">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {q && !rows.length && (
            <div className="sidebar-tree-empty">No sites match &ldquo;{query}&rdquo;.</div>
          )}
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index]
            const style: CSSProperties = {
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: vi.size,
              transform: `translateY(${vi.start}px)`,
            }
            if (row.kind === 'province') {
              // Forced open while searching (this row wouldn't even be
              // in `rows` unless it contains a match — see buildRows'
              // `forceExpandAll`), so the caret should read as open too,
              // and clicking shouldn't toggle the PERSISTED expand state
              // (there's nothing meaningful to collapse — every visible
              // node during a search is already forced expanded — and
              // doing so would leave a stale expand/collapse state
              // behind for when the search is cleared).
              const open = q ? true : expandedProvinces.has(row.key)
              return (
                <div
                  key={row.key}
                  style={style}
                  className="tree-row tree-row-province"
                  onClick={() => {
                    if (!q) toggleProvince(row.key)
                    onSelectProvince(row.name)
                  }}
                  title={
                    q
                      ? `Show these ${row.count} matching sites in ${row.name} on the map`
                      : `Show all ${row.count} sites in ${row.name} on the map`
                  }
                >
                  <span className="tree-caret">{open ? '▾' : '▸'}</span>
                  <span className="tree-label">{row.name}</span>
                  <span className="tree-count">{row.count}</span>
                </div>
              )
            }
            if (row.kind === 'district') {
              const open = q ? true : expandedDistricts.has(row.key)
              return (
                <div
                  key={row.key}
                  style={style}
                  className="tree-row tree-row-district"
                  onClick={() => {
                    if (!q) toggleDistrict(row.key)
                    onSelectDistrict(row.provinceName, row.name)
                  }}
                  title={
                    q
                      ? `Show these ${row.count} matching sites in ${row.name} on the map`
                      : `Show all ${row.count} sites in ${row.name} on the map`
                  }
                >
                  <span className="tree-caret">{open ? '▾' : '▸'}</span>
                  <span className="tree-label">{row.name}</span>
                  <span className="tree-count">{row.count}</span>
                </div>
              )
            }
            const { site } = row
            const selected = site.id === selectedSiteId
            return (
              <div
                key={row.key}
                style={style}
                className={`tree-row tree-row-site${selected ? ' tree-row-selected' : ''}`}
                onClick={() => onSelectSite(site)}
              >
                <span
                  className="tree-status-dot"
                  style={{ background: STATUS_COLOR[site.status] ?? STATUS_COLOR.nodata }}
                />
                <span className="tree-label">{site.name || site.id}</span>
                {/* Available tech types (2026-08-10) — from `techs`
                    (server-computed union of Site.tech + every sector's
                    own tech, see SiteListSerializer). Falls back to the
                    plain `tech` field for any cached/older response
                    that hasn't been refetched yet, so nothing goes
                    blank while a stale query result is still showing. */}
                {(site.techs && site.techs.length > 0 ? site.techs : site.tech ? [site.tech] : []).map((t) => (
                  <span key={t} className={`tree-tech-badge ${techBadgeClass(t)}`}>
                    {t}
                  </span>
                ))}
                {canUpdate && (
                  <span className="tree-row-actions">
                    <button
                      type="button"
                      className="tree-row-action-btn"
                      title="Edit site"
                      onClick={(e) => {
                        e.stopPropagation()
                        navigate(`/sites/${site.id}?edit=1`)
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="tree-row-action-btn"
                      title="Add sector"
                      onClick={(e) => {
                        e.stopPropagation()
                        navigate(`/sites/${site.id}?addSector=1`)
                      }}
                    >
                      +
                    </button>
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
