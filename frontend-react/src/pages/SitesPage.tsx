import { useNavigate } from 'react-router-dom'
import { useMemo, useState } from 'react'
import { useDeleteSite, useSite, useSites, useSitesPage } from '../api/queries'
import { isAllowed } from '../api/types'
import type { SiteListItem, SitesPageParams } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { useTreeStore } from '../store/treeStore'
import { siteMatchesTreeQuery } from '../components/SidebarTree'
import MapView from '../components/MapView'
import SearchableSelect from '../components/SearchableSelect'
import AddSiteModal from '../components/AddSiteModal'
import RelocateConfirmModal from '../components/RelocateConfirmModal'

// ── 2026-09-07 rebuild ──────────────────────────────────────────────────
// Replaces the always-visible left sidebar tree (region -> district ->
// site, browsed by expanding nodes) with a Table/Map toggle plus a
// shared filter bar (region/district cascading dropdowns, technology
// multi-select, status dropdown, free-text search) — explicit request,
// modeled on a reference site-topology page the project owner preferred
// the look of. Two things from that reference were deliberately NOT
// carried over: its "Active Alarms" column (a separate alarm/fault feed
// this app has no equivalent source for — explicitly out of scope), and
// its read-only posture — this app's Map view is also where sites get
// added (click-to-add), relocated (drag-to-relocate, confirm modal),
// and deleted, and an explicit product decision (AskUserQuestion,
// 2026-09-07) was to keep every one of those exactly as they work today,
// just restyled into the new layout, rather than trade them away for
// the reference's plainer read-only look.
//
// The tree's own two jobs are now split across two different filters
// instead of one collapsible list: "browse by administrative area" is
// the Region/District dropdowns (cascading — picking a region narrows
// District's own options, same as the old tree's nesting), and "jump to
// one specific site by name" is the free-text search box, matching
// siteMatchesTreeQuery's own multi-field match (id/name/city/district/
// tech) that the tree's search already used — reused here verbatim
// rather than reimplemented, so a saved search behaves identically to
// before.
//
// Filter state is ONE shared object across Table and Map (unlike the
// reference, which keeps two independent filter objects because its
// Table is a paged, ALWAYS-loaded register while its Map only loads once
// scoped) — this app's Map has always plotted from the SAME full
// useSites() array the tree filtered, so there was never a reason for
// the two views to disagree about what's "currently filtered."

type Filters = {
  region: string
  district: string
  status: string
  technology: string[]
  search: string
}

const EMPTY_FILTERS: Filters = { region: '', district: '', status: '', technology: [], search: '' }

function distinctSorted(values: (string | null | undefined)[]): string[] {
  return Array.from(new Set(values.map((v) => (v || '').trim()).filter(Boolean))).sort()
}

// Windowed page-number list for the Sites table's numbered pagination
// (2026-09-08, "display count and page link in header and footer both of
// the result table") -- always keeps up to 5 consecutive numbers visible
// around the current page (padding toward whichever edge has room when
// the current page is near the start or end, e.g. page 1 of 22 shows
// "1 2 3 4 5" rather than clipping to just "1 2 3"), plus the first and
// last page pinned with an ellipsis when they'd otherwise be skipped --
// matches the reference table's own "1 2 3 4 5 … 22" look exactly.
function paginationPageNumbers(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 1) return [1]
  const radius = 2
  let start = current - radius
  let end = current + radius
  if (start < 1) {
    end += 1 - start
    start = 1
  }
  if (end > total) {
    start -= end - total
    end = total
  }
  start = Math.max(1, start)
  end = Math.min(total, end)

  const pages: (number | 'ellipsis')[] = []
  for (let n = start; n <= end; n++) pages.push(n)
  if (start > 1) {
    if (start > 2) pages.unshift('ellipsis')
    pages.unshift(1)
  }
  if (end < total) {
    if (end < total - 1) pages.push('ellipsis')
    pages.push(total)
  }
  return pages
}

// Reuses this app's existing --tech-2g/-3g/-4g palette (Site Detail's own
// .sector-tech-badge, .tree-tech-badge) so the Table view's technology
// column reads as the same visual language as everywhere else in dtwatch,
// rather than the plain gray pill this page started with (2026-09-07
// GUI-quality pass, matching the reference's colored technology chips).
function techBadgeClass(t: string): string {
  const u = t.toUpperCase()
  if (u.includes('2G')) return 'tech-2g'
  if (u.includes('3G')) return 'tech-3g'
  return 'tech-4g'
}

// Deployment status is free text from the Live Site Directory (NetBox's
// own Site.status label -- "Active", "Planned", etc, see live_sites.py),
// not a fixed enum, so this only recognizes the two values actually seen
// in practice and falls back to a neutral color for anything else rather
// than guessing at a full status vocabulary.
function statusBadgeClass(status: string): string {
  const s = status.toLowerCase()
  if (s === 'active') return 'status-active'
  if (s === 'planned') return 'status-planned'
  return 'status-other'
}

export default function SitesPage() {
  const { data: sites, isLoading, error } = useSites()
  const { selectedSiteId, selectSite } = useTreeStore()
  // Full detail (incl. sectors + their optional GPS override) for
  // whichever ONE site is currently selected — not fetched for all
  // ~4,700 sites, same reasoning SiteListSerializer's docstring gives for
  // keeping the bulk sites/map payload lean. Feeds MapView's
  // SelectedSectorPins (2026-08-09, "sometimes same sites with multiple
  // sectors may have different lat long location as sector expansion").
  const { data: selectedSiteDetail } = useSite(selectedSiteId ?? undefined)
  const { user } = useAuth()
  const navigate = useNavigate()
  const deleteSite = useDeleteSite()

  const [view, setView] = useState<'table' | 'map'>('map')
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [searchInput, setSearchInput] = useState('')

  function setRegion(region: string) {
    // Clearing/changing the region also clears the district — same
    // reasoning the old tree-based scope selector already applied: a
    // district chosen under a different region has no meaning once the
    // region changes, and would silently AND against the wrong province.
    setFilters((f) => ({ ...f, region, district: '' }))
    setTablePage(1)
  }
  function setDistrict(district: string) {
    setFilters((f) => ({ ...f, district }))
    setTablePage(1)
  }
  function setStatus(status: string) {
    setFilters((f) => ({ ...f, status }))
    setTablePage(1)
  }
  function toggleTechnology(t: string) {
    setFilters((f) => ({
      ...f,
      technology: f.technology.includes(t) ? f.technology.filter((x) => x !== t) : [...f.technology, t],
    }))
    setTablePage(1)
  }
  function commitSearch() {
    setFilters((f) => ({ ...f, search: searchInput.trim() }))
    setTablePage(1)
  }
  function clearFilters() {
    setFilters(EMPTY_FILTERS)
    setSearchInput('')
    setTablePage(1)
  }
  const activeFilterCount = [
    filters.region, filters.district, filters.status, filters.search, ...filters.technology,
  ].filter(Boolean).length

  // Dropdown/pill options — derived from the real, currently-loaded
  // site data (same "never drift from what's actually in the database"
  // convention SiteSearchView's own docstring documents for its Region/
  // Tech/Type dropdowns), not a hardcoded list. District options narrow
  // to whatever region is selected, matching the old tree's own nesting.
  const regionOptions = useMemo(() => distinctSorted((sites ?? []).map((s) => s.region)), [sites])
  const districtOptions = useMemo(
    () => distinctSorted((sites ?? []).filter((s) => !filters.region || s.region === filters.region).map((s) => s.district)),
    [sites, filters.region],
  )
  const statusOptions = useMemo(() => distinctSorted((sites ?? []).map((s) => s.deployment_status)), [sites])
  const technologyOptions = useMemo(
    () => distinctSorted((sites ?? []).flatMap((s) => s.techs)),
    [sites],
  )

  // ── Map view: client-side filtering over the full array ────────────
  // Unchanged approach from before this rebuild (MapView has always been
  // handed a pre-filtered slice of the one big useSites() array) — only
  // what narrows it changed, from tree-node selection to these filters.
  const searchQ = filters.search.trim().toLowerCase()
  const mapSites = useMemo(() => {
    if (!sites) return []
    return sites.filter((s) => {
      if (filters.region && (s.region || 'Unassigned') !== filters.region) return false
      if (filters.district && (s.district || 'Unassigned') !== filters.district) return false
      if (filters.status && s.deployment_status !== filters.status) return false
      if (filters.technology.length && !filters.technology.some((t) => s.techs.includes(t))) return false
      if (searchQ && !siteMatchesTreeQuery(s, searchQ)) return false
      return true
    })
  }, [sites, filters, searchQ])

  // Stable identity for the current filter combination — drives
  // MapView's FitToScope so picking a new region/district/tech actually
  // moves the viewport, same "re-fit on a real scope change only" reason
  // this key existed before the rebuild (see MapView.tsx's own comment).
  const mapScopeKey = useMemo(
    () => `${filters.region}|${filters.district}|${filters.status}|${filters.technology.join(',')}|${searchQ}`,
    [filters, searchQ],
  )
  const mapLabel = activeFilterCount > 0 || mapSites.length !== (sites?.length ?? 0)
    ? `${mapSites.length.toLocaleString()} site${mapSites.length === 1 ? '' : 's'} matching filters`
    : `All Nepal — ${mapSites.length.toLocaleString()} sites`

  // ── Table view: real server-side paging/filtering ───────────────────
  const [tablePage, setTablePage] = useState(1)
  const tableParams: SitesPageParams = useMemo(
    () => ({
      page: tablePage,
      page_size: 20,
      region: filters.region || undefined,
      district: filters.district || undefined,
      status: filters.status || undefined,
      technology: filters.technology.length ? filters.technology : undefined,
      q: filters.search || undefined,
    }),
    [tablePage, filters],
  )
  const { data: tablePageData, isLoading: tableLoading } = useSitesPage(tableParams, view === 'table')
  const tableTotalPages = tablePageData ? Math.max(1, Math.ceil(tablePageData.count / 20)) : 1

  // Drag-to-resize sidebar removed with the sidebar itself (2026-09-07) —
  // nothing left in this page owns a resizable width.

  // Map-based site CRUD (2026-07-30 request, all preserved through the
  // 2026-09-07 rebuild per explicit AskUserQuestion decision) — "write"
  // is this app's existing create-verb convention (matches DT Data
  // Manager's canWrite), 'update'/'delete' match SiteDetailPage's own
  // gating exactly so the map never offers an action the detail page
  // itself would reject.
  const canCreate = !!user && isAllowed(user.role, user.permissions.sites, 'write')
  const canUpdate = !!user && isAllowed(user.role, user.permissions.sites, 'update')
  const canDelete = !!user && isAllowed(user.role, user.permissions.sites, 'delete')

  const [addMode, setAddMode] = useState(false)
  const [mapLayer, setMapLayer] = useState<'street' | 'satellite'>('street')
  // "Show name" (2026-09-08, "use show name feature in filter in map as
  // attached") -- permanent site-name labels next to every marker
  // instead of hover-only, matching the reference. Map-view-only, same
  // as mapLayer above (not part of the shared `filters` object -- it
  // doesn't change WHICH sites are plotted, only how they're labeled).
  const [showNames, setShowNames] = useState(false)
  const [pendingAdd, setPendingAdd] = useState<{ lat: number; lng: number } | null>(null)
  const [pendingRelocate, setPendingRelocate] = useState<{
    site: SiteListItem
    oldLat: number
    oldLng: number
    newLat: number
    newLng: number
  } | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  function handleMapClick(lat: number, lng: number) {
    setPendingAdd({ lat, lng })
    setAddMode(false)
  }
  function handleRelocateRequest(site: SiteListItem, oldLat: number, oldLng: number, newLat: number, newLng: number) {
    setPendingRelocate({ site, oldLat, oldLng, newLat, newLng })
  }
  async function handleDelete(site: SiteListItem) {
    setDeleteError(null)
    if (!confirm(`Delete site ${site.id}? This also deletes its sectors. This cannot be undone.`)) return
    try {
      await deleteSite.mutateAsync(site.id)
      if (selectedSiteId === site.id) selectSite(null)
    } catch {
      setDeleteError('Could not delete this site.')
    }
  }
  function selectSiteAndFocusMap(id: string) {
    selectSite(id)
    setView('map')
  }

  // Shared by the header (above <table>) and footer (below <table>) copies
  // of the entries-count + numbered page links (2026-09-08 request) -- one
  // function so the two never drift out of sync with each other.
  function renderTablePagination(position: 'top' | 'bottom') {
    if (!tablePageData || tablePageData.count <= 20) return null
    const rangeStart = (tablePage - 1) * 20 + 1
    const rangeEnd = Math.min(tablePage * 20, tablePageData.count)
    return (
      <div className={`sites-table-pagination sites-table-pagination-${position}`}>
        <span>
          Showing {rangeStart.toLocaleString()} to {rangeEnd.toLocaleString()} of{' '}
          {tablePageData.count.toLocaleString()} entries
        </span>
        <div className="sites-table-pagination-pages">
          <button
            type="button"
            className="btn-secondary btn-small"
            onClick={() => setTablePage((p) => Math.max(1, p - 1))}
            disabled={!tablePageData.previous}
          >
            ← Prev
          </button>
          {paginationPageNumbers(tablePage, tableTotalPages).map((p, idx) =>
            p === 'ellipsis' ? (
              <span key={`${position}-ellipsis-${idx}`} className="sites-table-pagination-ellipsis">…</span>
            ) : (
              <button
                key={`${position}-page-${p}`}
                type="button"
                className={`sites-table-pagination-page${p === tablePage ? ' active' : ''}`}
                onClick={() => setTablePage(p)}
              >
                {p}
              </button>
            ),
          )}
          <button
            type="button"
            className="btn-secondary btn-small"
            onClick={() => setTablePage((p) => p + 1)}
            disabled={!tablePageData.next}
          >
            Next →
          </button>
        </div>
      </div>
    )
  }

  if (isLoading) return <div className="page-status">Loading sites…</div>
  if (error) return <div className="page-status page-status-error">Could not load sites from the API.</div>
  if (!sites) return null

  const selected = sites.find((s) => s.id === selectedSiteId)

  const filterBar = (
    <div className="sites-filter-bar">
      <select value={filters.region} onChange={(e) => setRegion(e.target.value)} aria-label="Region">
        <option value="">All Regions</option>
        {regionOptions.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      <select value={filters.district} onChange={(e) => setDistrict(e.target.value)} aria-label="District">
        <option value="">All Districts</option>
        {districtOptions.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
      <select value={filters.status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
        <option value="">All Statuses</option>
        {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <label className="sites-active-toggle">
        <input
          type="checkbox"
          checked={filters.status === 'Active'}
          onChange={(e) => setStatus(e.target.checked ? 'Active' : '')}
        />
        <span className="sites-active-toggle-track"><span className="sites-active-toggle-thumb" /></span>
        Only active
      </label>
      <div className="sites-tech-pills" role="group" aria-label="Technology">
        {technologyOptions.map((t) => (
          <button
            key={t}
            type="button"
            className={`sites-tech-pill${filters.technology.includes(t) ? ' active' : ''}`}
            onClick={() => toggleTechnology(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <form
        className="sites-search-form"
        onSubmit={(e) => {
          e.preventDefault()
          commitSearch()
        }}
      >
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by site name, ID, district…"
        />
        <button type="submit" className="btn-secondary btn-small">Search</button>
      </form>
      {activeFilterCount > 0 && (
        <button type="button" className="btn-secondary btn-small" onClick={clearFilters}>
          ✕ Clear filters
        </button>
      )}
    </div>
  )

  return (
    <div className="sites-page sites-page-v2">
      <div className="sites-page-header">
        <div className="sites-page-title">
          Sites Topology <span className="sites-sidebar-count">{sites.length.toLocaleString()}</span>
        </div>
        <div className="sites-view-toggle">
          <button
            type="button"
            className={view === 'table' ? 'active' : ''}
            onClick={() => setView('table')}
          >
            ☰ Table
          </button>
          <button
            type="button"
            className={view === 'map' ? 'active' : ''}
            onClick={() => setView('map')}
          >
            🗺 Map
          </button>
        </div>
      </div>

      {view === 'table' && filterBar}

      {view === 'table' ? (
        <div className="sites-table-wrap">
          {tableLoading && !tablePageData ? (
            <div className="page-status">Loading sites…</div>
          ) : (
            <>
              {renderTablePagination('top')}
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>S.N.</th>
                    <th>Site</th>
                    <th>Region</th>
                    <th>District</th>
                    <th>Technology</th>
                    <th>Coordinates</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(tablePageData?.results ?? []).map((s, i) => (
                    <tr key={s.id}>
                      <td className="sites-table-sn">{(tablePage - 1) * 20 + i + 1}</td>
                      <td>
                        <div className="sites-table-name">{s.name || '—'}</div>
                        <div className="sites-table-id">{s.id}</div>
                      </td>
                      <td>{s.region || '—'}</td>
                      <td>{s.district || '—'}</td>
                      <td>
                        {s.techs.length
                          ? s.techs.map((t) => (
                              <span key={t} className={`sites-tech-badge ${techBadgeClass(t)}`}>{t}</span>
                            ))
                          : '—'}
                      </td>
                      <td className="sites-table-coords">
                        {s.lat != null && s.lng != null ? `${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}` : '—'}
                      </td>
                      <td>
                        {s.deployment_status
                          ? (
                              <span className={`sites-status-badge ${statusBadgeClass(s.deployment_status)}`}>
                                {s.deployment_status}
                              </span>
                            )
                          : '—'}
                      </td>
                      <td className="admin-table-actions">
                        <button
                          type="button"
                          className="btn-secondary btn-small"
                          onClick={() => navigate(`/sites/${s.id}`)}
                        >
                          Open →
                        </button>
                        <button
                          type="button"
                          className="btn-secondary btn-small"
                          onClick={() => selectSiteAndFocusMap(s.id)}
                        >
                          On map
                        </button>
                        {canDelete && (
                          <button
                            type="button"
                            className="btn-danger btn-small"
                            onClick={() => handleDelete(s)}
                            disabled={deleteSite.isPending}
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {tablePageData && tablePageData.results.length === 0 && (
                    <tr>
                      <td colSpan={8} className="page-status">
                        No site matches the filters currently applied.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {deleteError && <div className="form-error" style={{ marginTop: 8 }}>{deleteError}</div>}
              {renderTablePagination('bottom')}
            </>
          )}
        </div>
      ) : (
        <div className="sites-map-wrap sites-map-wrap-v2">
          <div className="sites-scope-status">
            📍 Showing: <strong>{mapLabel}</strong>
          </div>

          <div className="sites-map-toolbar">
            {/* Segmented Streets/Satellite control (2026-09-07 GUI-quality
                pass) -- replaces the old single button that relabeled
                itself depending on state, matching the reference's
                always-shows-both-options-with-one-active look instead. */}
            <div className="sites-layer-toggle">
              <button
                type="button"
                className={mapLayer === 'street' ? 'active' : ''}
                onClick={() => setMapLayer('street')}
              >
                Streets
              </button>
              <button
                type="button"
                className={mapLayer === 'satellite' ? 'active' : ''}
                onClick={() => setMapLayer('satellite')}
              >
                Satellite
              </button>
            </div>
            {canCreate && (
              <button
                type="button"
                className={`btn-secondary btn-small map-add-toggle${addMode ? ' active' : ''}`}
                onClick={() => setAddMode((v) => !v)}
                title={addMode ? 'Cancel — click the map to add a site' : 'Click here, then click the map to add a missing site'}
              >
                {addMode ? '✕ Cancel Add' : '+ Add Site'}
              </button>
            )}
          </div>

          {/* Floating filter panel (2026-09-07) — the Map view's own copy
              of the filter bar above, styled to sit over the map rather
              than in the page flow, matching the reference's floating
              "Scope" panel. Same `filters` state as the Table view — see
              this file's own top-of-file comment on why the two views
              deliberately share one filter object instead of each
              keeping its own. */}
          <div className="sites-map-filter-panel">
            <p className="sites-map-filter-panel-title">Scope</p>
            <SearchableSelect
              value={filters.region}
              onChange={setRegion}
              options={regionOptions}
              placeholder="All Regions"
              searchPlaceholder="Search regions…"
              ariaLabel="Region"
            />
            <SearchableSelect
              value={filters.district}
              onChange={setDistrict}
              options={districtOptions}
              placeholder="All Districts"
              searchPlaceholder="Search districts…"
              ariaLabel="District"
            />
            <select value={filters.status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="">All Statuses</option>
              {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <label className="sites-active-toggle">
              <input
                type="checkbox"
                checked={filters.status === 'Active'}
                onChange={(e) => setStatus(e.target.checked ? 'Active' : '')}
              />
              <span className="sites-active-toggle-track"><span className="sites-active-toggle-thumb" /></span>
              Only active
            </label>
            <label className="sites-active-toggle">
              <input type="checkbox" checked={showNames} onChange={(e) => setShowNames(e.target.checked)} />
              <span className="sites-active-toggle-track"><span className="sites-active-toggle-thumb" /></span>
              Show name
            </label>
            <div className="sites-tech-pills" role="group" aria-label="Technology">
              {technologyOptions.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`sites-tech-pill${filters.technology.includes(t) ? ' active' : ''}`}
                  onClick={() => toggleTechnology(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                commitSearch()
              }}
            >
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Site name or ID…"
              />
            </form>
            {activeFilterCount > 0 && (
              <button type="button" className="btn-secondary btn-small" onClick={clearFilters}>
                ✕ Clear filters
              </button>
            )}
            <p className="sites-map-filter-panel-count">
              {mapSites.length.toLocaleString()} plotted of {sites.length.toLocaleString()}
            </p>
          </div>

          <MapView
            sites={mapSites}
            scopeKey={mapScopeKey}
            selected={selected}
            selectedSectors={selected && selectedSiteDetail?.id === selected.id ? selectedSiteDetail.sectors : undefined}
            onSelect={selectSite}
            addMode={addMode}
            onMapClick={handleMapClick}
            canRelocate={canUpdate}
            onRelocateRequest={handleRelocateRequest}
            mapLayer={mapLayer}
            showNames={showNames}
          />
          {selected && (
            <div className="site-quickview">
              <div className="site-quickview-title">{selected.name || selected.id}</div>
              <div className="site-quickview-meta">
                {selected.id} · {selected.district}, {selected.region}
              </div>
              {deleteError && <div className="form-error" style={{ marginBottom: 6 }}>{deleteError}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => navigate(`/sites/${selected.id}`)}>Open site detail →</button>
                {canDelete && (
                  <button
                    className="btn-danger btn-small"
                    onClick={() => handleDelete(selected)}
                    disabled={deleteSite.isPending}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {pendingAdd && (
        <AddSiteModal
          lat={pendingAdd.lat}
          lng={pendingAdd.lng}
          onClose={() => setPendingAdd(null)}
          onCreated={(site) => {
            setPendingAdd(null)
            selectSite(site.id)
          }}
        />
      )}

      {pendingRelocate && (
        <RelocateConfirmModal
          siteId={pendingRelocate.site.id}
          siteName={pendingRelocate.site.name}
          oldLat={pendingRelocate.oldLat}
          oldLng={pendingRelocate.oldLng}
          newLat={pendingRelocate.newLat}
          newLng={pendingRelocate.newLng}
          onCancel={() => setPendingRelocate(null)}
          onConfirmed={() => setPendingRelocate(null)}
        />
      )}
    </div>
  )
}
