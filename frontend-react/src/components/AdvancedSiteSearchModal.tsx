import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiErrorMessage } from '../api/client'
import { useSiteSearch, useSites } from '../api/queries'
import type { SiteSearchParams, SiteSearchResult } from '../api/types'
import { SITES_PATH } from '../constants/opaqueRoutes'
import { useTreeStore } from '../store/treeStore'
import RowLimitSelect from './RowLimitSelect'

// Ports v1's "Advanced Site Search" modal (bts_monitor.html
// openSearchModal()/clearSearch()/runSearch()/exportSearchCsv(),
// ~line 1810-1904 for the HTML and ~8510-8621 for the logic) — a global,
// always-available search reachable from the top nav (see the trigger
// button added to Layout.tsx), not scoped to any one page.
//
// Deliberate deviation from v1, #1: the Region/Tech/Type/Status dropdowns
// are NOT v1's hardcoded option lists. v1 assumed Type had 4 values
// (Macro/Micro/Indoor/Outdoor); the real v2 data has exactly one
// (`Macro-BTS`) for every site. Per the user's explicit "only the
// parameters that are available in the system" request, every dropdown
// here is built from the real distinct values in the already-cached
// `useSites()` list (same `[...new Set(...)].sort()` idiom
// SlaTrackerPage.tsx already uses for its Region filter).
//
// Deliberate deviation from v1, #2 (2026-08-06 follow-up): v1's 5
// KPI-threshold fields (RRC/Drop/Avail/PRB/Thru) are gone. Per "since
// this system mainly focus on site info, sectors info and drive test
// data, so make search option related to them not kpi data", they're
// replaced with Cell Name (sector info) and Has Drive Test Data
// (drive-test info — whether any DT session's coverage passed near this
// site). See core/views.py's SiteSearchView docstring for exact filter
// semantics.
//
// **2026-08-10 rework** — per explicit request ("in advanced search
// option add parameter 'cell actual status' with on-air, planned,
// dismantle and for 'lat/long' with available and not available. in
// tech add 2g and 3g. remove status, status 2g and status 3g, local
// cell id, pci, latitude, longitude"):
// - Status / Status 2G / Status 3G / Local Cell ID / PCI / Latitude /
//   Longitude / Radius (km) inputs are removed outright.
// - Cell Active Status (dropdown: On-Air / Planned / Dismantle — fixed
//   options per the literal request, not derived from real data like
//   Region/Type below, since the whole point is to standardize search
//   against these 3 known values regardless of what's actually in the
//   DB yet) and Lat/Long Available (dropdown: Available / Not available)
//   replace them.
// - Tech's dropdown is unioned with a fixed ['2G', '3G'] on top of
//   whatever distinct values are already in the data — those techs live
//   almost entirely on sector rows (see per-tech Sector Data import),
//   so they wouldn't reliably show up in `sites.map(s => s.tech)` alone.
//
// **2026-08-07 crash fix, later made adjustable.** A broad or empty
// search (e.g. hitting Search with no filters set, or just one loose
// filter like Tech=4G) returns up to all 4,718 sites — and the results
// table below was rendering EVERY row into the DOM with no
// virtualization, inside a scrollable div. That's ~47,000+ DOM nodes
// created synchronously in a modal, which is exactly the same failure
// mode this app already hit and fixed elsewhere (see CLAUDE.md's
// "Decisions Log": the Sites Topology sidebar needed virtual scroll for
// precisely this reason, and the map needed marker clustering). A user
// reported a real browser crash (blank white page) triggered by using
// this search — this was the reproducible cause. Originally fixed with a
// flat 300-row cap; per a same-day follow-up request ("use in default
// with 50-row render cap and allow to choose 100,150 etc"), that's now a
// user-adjustable `rowLimit` (see RowLimitSelect.tsx) defaulting to 50
// instead of a hardcoded constant. CSV export is untouched either way and
// still exports the full result set, since that's a text file write, not
// a DOM render, and was never the expensive part.

// **2026-08-07 back-navigation fix.** `form`/`hasSearched`/`search` (the
// useSiteSearch() mutation) used to be local state here, which meant
// closing the modal to open a site's detail page threw the entire search
// away — clicking "Back to sites" from there landed on Sites Topology
// with no way back to the results without re-entering every filter. Per
// explicit request ("keep source page id and when click on back to site
// ... it redirects to the previous page from where it was opened"), this
// state is now owned by Layout.tsx (which already controls whether this
// modal is even mounted) and passed down as props, so reopening the modal
// via SearchModalContext's `openSearch()` — see SiteDetailPage.tsx's
// "← Back to search results" link — shows the exact same results (and
// the same chosen row limit), not an empty form.
export interface AdvancedSiteSearchModalProps {
  onClose: () => void
  form: SiteSearchParams
  setForm: (updater: SiteSearchParams | ((f: SiteSearchParams) => SiteSearchParams)) => void
  hasSearched: boolean
  setHasSearched: (v: boolean) => void
  search: ReturnType<typeof useSiteSearch>
  rowLimit: number
  setRowLimit: (n: number) => void
}

export default function AdvancedSiteSearchModal({
  onClose,
  form,
  setForm,
  hasSearched,
  setHasSearched,
  search,
  rowLimit,
  setRowLimit,
}: AdvancedSiteSearchModalProps) {
  const navigate = useNavigate()
  const { data: sites } = useSites()
  const { selectSite } = useTreeStore()

  const [error, setError] = useState<string | null>(null)

  const regionOptions = useMemo(() => [...new Set((sites ?? []).map((s) => s.region).filter(Boolean))].sort(), [sites])
  // Unioned with a fixed ['2G', '3G'] — see the module comment above for
  // why those two wouldn't reliably appear from real Site.tech values alone.
  const techOptions = useMemo(
    () => [...new Set([...(sites ?? []).map((s) => s.tech).filter(Boolean), '2G', '3G'])].sort(),
    [sites],
  )
  const typeOptions = useMemo(() => [...new Set((sites ?? []).map((s) => s.type).filter(Boolean))].sort(), [sites])

  function set<K extends keyof SiteSearchParams>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function runSearch() {
    setError(null)
    setHasSearched(true)
    try {
      await search.mutateAsync(form)
    } catch (err) {
      setError(apiErrorMessage(err, 'Search failed — check the filter values and try again.'))
    }
  }

  function clearSearch() {
    setForm({})
    setError(null)
    setHasSearched(false)
  }

  function openSite(id: string) {
    onClose()
    // `?fromSearch=1` (not router location.state) so it survives a page
    // refresh and matches this app's existing convention for one-shot
    // navigation flags (see SiteDetailPage.tsx's own `?edit=1`/
    // `?addSector=1`). SiteDetailPage reads it to decide whether "Back"
    // should reopen this search (via SearchModalContext) instead of
    // going to Sites Topology.
    navigate(`/sites/${id}?fromSearch=1`)
  }

  // Location column's own click target (2026-08-09, "add lat long with
  // reference to map such that when click will open in site topology") —
  // deliberately separate from openSite() above, which goes to the
  // Site Detail page. This instead selects the site (same Zustand store
  // SitesPage.tsx/SidebarTree.tsx already share) and lands on the Sites
  // Topology map, where SelectedHighlight/FlyToSelected pick that
  // selection up and fly the map straight to it — same mechanism a
  // sidebar tree click already uses, just triggered from here instead.
  function openOnMap(id: string) {
    onClose()
    selectSite(id)
    navigate(SITES_PATH)
  }

  // Sector-wise mode (2026-08-09 follow-up: "it is giving summary result
  // with sitename, need sector wise result with cell name") — the server
  // (SiteSearchView.get(), see core/views.py) only returns per-sector rows
  // when `sector_expansion` was set on the LAST EXECUTED search. `form`
  // can drift after that (user tweaking filters before hitting Search
  // again), so this reads `search.variables` — react-query's record of
  // the mutation args actually sent — rather than the live `form` state,
  // to stay in sync with what `search.data.results` really contains.
  const isSectorWise = !!search.variables?.sector_expansion

  function exportCsv() {
    const results = search.data?.results ?? []
    if (results.length === 0) return
    if (isSectorWise) {
      const header = ['Site ID', 'Site Name', 'Region', 'District', 'Cell Name', 'Sector', 'Local Cell ID', 'Tech', 'Latitude', 'Longitude']
      const rows = results.map((r: SiteSearchResult) => [
        r.id,
        r.name,
        r.region,
        r.district,
        r.cell_name ?? '',
        r.sector ?? '',
        r.local_cell_id != null ? String(r.local_cell_id) : '',
        r.tech,
        r.lat != null ? String(r.lat) : '',
        r.lng != null ? String(r.lng) : '',
      ])
      const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
      const blob = new Blob([csv], { type: 'text/csv' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `Sector_Expansion_Results_${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(a.href)
      return
    }
    // 'Status' (plain site-level ok/warn/crit) is dropped — it was never
    // shown in the results table below either, and the filter for it was
    // explicitly removed (2026-08-10). Status 2G/3G stay: they ARE shown
    // as the table's "2G"/"3G" columns — those are display fields, not
    // the removed search filter, and CSV export should match the table.
    const header = ['Site ID', 'Name', 'Region', 'District', 'City', 'Tech', 'Status 2G', 'Status 3G', 'Sectors', 'Has Drive Test Data']
    const rows = results.map((r: SiteSearchResult) => [
      r.id,
      r.name,
      r.region,
      r.district,
      r.city,
      r.tech,
      r.status_2g,
      r.status_3g,
      String(r.sector_count),
      r.has_dt ? 'Yes' : 'No',
    ])
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `Site_Search_Results_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const results = search.data?.results ?? []

  return (
    <div className="modal-overlay show">
      <div className="modal-box" style={{ maxWidth: 900, width: '95%' }}>
        <div className="modal-hdr">
          <h2>Advanced Site Search</h2>
        </div>
        <div className="modal-body">
          {error && <div className="form-error">{error}</div>}

          <div className="edit-grid">
            <label>
              Site ID / Name
              <input
                value={form.q ?? ''}
                onChange={(e) => set('q', e.target.value)}
                placeholder="e.g. CDR0123 or a name fragment"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              />
            </label>
            <label>
              Region
              <select value={form.region ?? ''} onChange={(e) => set('region', e.target.value)}>
                <option value="">Any</option>
                {regionOptions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label>
              City / District
              <input value={form.city ?? ''} onChange={(e) => set('city', e.target.value)} placeholder="e.g. Kathmandu" />
            </label>
            <label>
              Tech
              <select value={form.tech ?? ''} onChange={(e) => set('tech', e.target.value)}>
                <option value="">Any</option>
                {techOptions.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Type
              <select value={form.type ?? ''} onChange={(e) => set('type', e.target.value)}>
                <option value="">Any</option>
                {typeOptions.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Cell Name
              <input value={form.cell_name ?? ''} onChange={(e) => set('cell_name', e.target.value)} placeholder="matches any sector" />
            </label>
            {/* Cell Active Status (2026-08-10, "add parameter 'cell actual
                status' with on-air, planned, dismantle") — matches any
                sector's Sector.cell_active_status, populated by the
                4G/3G/2G Sector Data imports. */}
            <label>
              Cell Active Status
              <select value={form.cell_active_status ?? ''} onChange={(e) => set('cell_active_status', e.target.value)}>
                <option value="">Any</option>
                <option value="On-Air">On-Air</option>
                <option value="Planned">Planned</option>
                <option value="Dismantle">Dismantle</option>
              </select>
            </label>
            {/* Lat/Long Available (2026-08-10, "for 'lat/long' with
                available and not available") — replaces the old lat/lng/
                radius_km proximity search with a simple presence check;
                "Not available" is exactly what drives a site into the
                Sites tree's "Unassigned" bucket (see the district-backfill
                feature on the Backup page). */}
            <label>
              Lat/Long
              <select value={form.has_location ?? ''} onChange={(e) => set('has_location', e.target.value)}>
                <option value="">Any</option>
                <option value="1">Available</option>
                <option value="0">Not available</option>
              </select>
            </label>
            <label>
              Drive Test Data
              <select value={form.has_dt ?? ''} onChange={(e) => set('has_dt', e.target.value)}>
                <option value="">Any</option>
                <option value="1">Has DT data</option>
                <option value="0">No DT data</option>
              </select>
            </label>
            {/* 2026-08-09, "my major concern is to find expanded sector
                list... add search parameter with all sector expansion,
                sector expansion with same latlong and sector expansion
                with different latlong" — see core/sector_expansion.py's
                module docstring for the full classification rule (a real
                Nepal Telecom sector-letter naming convention, confirmed
                with the user before building this, not guessed). */}
            <label>
              Sector Expansion
              <select value={form.sector_expansion ?? ''} onChange={(e) => set('sector_expansion', e.target.value)}>
                <option value="">Any</option>
                <option value="all">Has expansion sector(s)</option>
                <option value="same_latlong">Expansion, same location as site</option>
                <option value="different_latlong">Expansion, different location than site</option>
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn-primary btn-small" onClick={runSearch} disabled={search.isPending}>
              {search.isPending ? 'Searching…' : 'Search'}
            </button>
            <button type="button" className="btn-secondary btn-small" onClick={clearSearch} disabled={search.isPending}>
              Clear
            </button>
            {results.length > 0 && (
              <button type="button" className="btn-secondary btn-small" onClick={exportCsv}>
                Export CSV
              </button>
            )}
            {results.length > 0 && <RowLimitSelect value={rowLimit} onChange={setRowLimit} />}
          </div>

          {hasSearched && !search.isPending && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: '#8b93a3', marginBottom: 6 }}>
                {search.data ? `${search.data.count} of ${search.data.total} sites match` : ''}
                {results.length > rowLimit && (
                  <>
                    {' '}
                    — showing the first {rowLimit}. Choose a higher row limit above, narrow your filters, or use Export
                    CSV for the full list.
                  </>
                )}
              </div>
              {results.length > 0 && isSectorWise && (
                // Sector-wise table (2026-08-09 follow-up) — one row per
                // matching SECTOR, with its own Cell Name/Sector/Local Cell
                // ID/Tech/Location, instead of the site-level summary table
                // below. Row click still opens the parent Site Detail page
                // (a sector has no page of its own); the Location link still
                // opens the Sites Topology map on the parent site, using the
                // sector's own effective coordinate (already resolved
                // server-side — see core/views.py's sector-wise branch).
                <div className="report-table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Site ID</th>
                        <th>Site Name</th>
                        <th>Region</th>
                        <th>District</th>
                        <th>Cell Name</th>
                        <th>Sector</th>
                        <th>Local Cell ID</th>
                        <th>Tech</th>
                        <th>Location</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.slice(0, rowLimit).map((r, i) => (
                        <tr
                          key={`${r.id}-${r.sector ?? ''}-${i}`}
                          className="admin-table-row-clickable"
                          onClick={() => openSite(r.id)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td className="admin-table-key">{r.id}</td>
                          <td>{r.name}</td>
                          <td>{r.region}</td>
                          <td>{r.district || r.city}</td>
                          <td>{r.cell_name || '—'}</td>
                          <td>{r.sector || '—'}</td>
                          <td>{r.local_cell_id ?? '—'}</td>
                          <td>{r.tech}</td>
                          <td>
                            {r.lat != null && r.lng != null ? (
                              <button
                                type="button"
                                className="search-result-location-link"
                                title="Open on the Sites Topology map"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openOnMap(r.id)
                                }}
                              >
                                📍 {r.lat.toFixed(4)}, {r.lng.toFixed(4)}
                              </button>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {results.length > 0 && !isSectorWise && (
                <div className="report-table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Site ID</th>
                        <th>Name</th>
                        <th>Region</th>
                        <th>District</th>
                        <th>Tech</th>
                        <th>2G</th>
                        <th>3G</th>
                        <th>Sectors</th>
                        <th>DT Data</th>
                        <th>Location</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Capped to the user-adjustable `rowLimit`, not the
                          full `results` — see the crash-fix comment above
                          the component: rendering all 4,718 possible
                          matches with no virtualization is a real,
                          reproduced browser-crash cause, not a
                          hypothetical one. */}
                      {results.slice(0, rowLimit).map((r) => (
                        <tr key={r.id} className="admin-table-row-clickable" onClick={() => openSite(r.id)} style={{ cursor: 'pointer' }}>
                          <td className="admin-table-key">{r.id}</td>
                          <td>{r.name}</td>
                          <td>{r.region}</td>
                          <td>{r.district || r.city}</td>
                          <td>{r.tech}</td>
                          <td>{r.status_2g || '—'}</td>
                          <td>{r.status_3g || '—'}</td>
                          <td>{r.sector_count}</td>
                          <td>{r.has_dt ? 'Yes' : 'No'}</td>
                          <td>
                            {r.lat != null && r.lng != null ? (
                              <button
                                type="button"
                                className="search-result-location-link"
                                title="Open on the Sites Topology map"
                                onClick={(e) => {
                                  // Own click target, not the row's — must not
                                  // also trigger openSite() above (row-level
                                  // onClick), which would navigate to Site
                                  // Detail instead of the map.
                                  e.stopPropagation()
                                  openOnMap(r.id)
                                }}
                              >
                                📍 {r.lat.toFixed(4)}, {r.lng.toFixed(4)}
                              </button>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {search.data && results.length === 0 && <div className="page-status">No sites match these filters.</div>}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary btn-small" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
