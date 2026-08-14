import { useNavigate } from 'react-router-dom'
import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useDeleteSite, useSite, useSites } from '../api/queries'
import { isAllowed } from '../api/types'
import type { SiteListItem } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { useTreeStore } from '../store/treeStore'
import SidebarTree, { siteMatchesTreeQuery } from '../components/SidebarTree'
import MapView from '../components/MapView'
import AddSiteModal from '../components/AddSiteModal'
import RelocateConfirmModal from '../components/RelocateConfirmModal'

// Map scope selection (2026-08-04) — folded in from the now-retired
// standalone Topology page, per explicit user request: "use concept of
// NTC all sites, region wise, district wise selection of topology in
// sites map without affecting the display theme of sites map. if this is
// done then we do not need topology." The tree still lists every site
// (unfiltered, so search/navigation always works across all of Nepal);
// only what MapView actually PLOTS is narrowed by `scope`. MapView's own
// rendering — clustered plain markers, the gold selected-site ring, drag-
// to-relocate, click-to-add — is untouched; it just receives a smaller
// `sites` array when a province/district is picked instead of the full
// list.
//
// **2026-08-07 memory-optimization change.** Default scope used to be
// 'all' — every session landed on this page immediately after login with
// all 4,729 sites clustered onto the map, the single most expensive thing
// this app renders on its very first screen. Per explicit request
// ("after login, in default only load map and sitebar, after selection
// only display sites"), the default is now 'none': just the base map
// (no markers at all) and the sidebar tree, which was always unfiltered
// anyway and costs nothing extra to show. Clicking the sidebar's pinned
// "NTC — All Sites" row still loads everything on demand exactly as
// before — nothing about that capability was removed, only what happens
// with zero clicks.
//
// **2026-08-07 follow-up fix — site marker vanished after Open site
// detail → back to Sites.** `scopeSelector` is local component state, so
// it reset to 'none' every time this page remounted — including on the
// route round-trip to `/sites/:id` and back. `selectedSiteId` itself
// lives in `useTreeStore` (a module-level Zustand store, not torn down
// by a route change), so it survived the trip and the sidebar row/
// quickview panel still reflected the "selected" site correctly — only
// the MAP's marker depends on `scope`, and that had already reset to
// empty, making the indicator disappear even though the site was still
// technically selected. Fixed by lazily seeding `scopeSelector` from
// whatever `selectedSiteId` already is at mount time (see the `useState`
// initializer below) instead of always starting at 'none' — a fresh
// login (no prior selection) still gets the cheap no-markers default,
// but returning from a site's detail page now re-shows exactly the site
// you were just looking at.
//
// Scope is a SELECTOR, not a frozen sites[] snapshot — re-derived via
// useMemo off the live `sites` query below, same fix already applied to
// TopologyPage.tsx's own scope state: a frozen snapshot would go stale
// the instant a site inside it is added/relocated/deleted through the
// map itself.
type ScopeSelector =
  | { type: 'none' }
  | { type: 'all' }
  | { type: 'province'; province: string }
  | { type: 'district'; province: string; district: string }
  | { type: 'site'; id: string }

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

  const [scopeSelector, setScopeSelector] = useState<ScopeSelector>(() =>
    selectedSiteId ? { type: 'site', id: selectedSiteId } : { type: 'none' },
  )

  // Sidebar tree search query (2026-08-10, "while searching in side
  // tree it displays directly the sites related to search, but need to
  // display in which region, district it comes... if i click the
  // region, then display the result sites only in the map and same for
  // district") — lifted up from what used to be SidebarTree's own local
  // state (see that component's own comment on the `query` prop) so the
  // `scope` useMemo below can intersect it with whatever province/
  // district/all-sites gets clicked while a search is active.
  const [treeQuery, setTreeQuery] = useState('')
  const treeQ = treeQuery.trim().toLowerCase()

  // Drag-to-resize sidebar (2026-07-30 request — same pattern already
  // built for the DT Data Manager's Session History split: plain window
  // mousemove/mouseup listeners, no drag library, state-driven width
  // instead of the old fixed 300px in .sites-sidebar).
  const [sidebarWidth, setSidebarWidth] = useState(300)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  function onResizeMouseDown(e: ReactMouseEvent) {
    dragRef.current = { startX: e.clientX, startWidth: sidebarWidth }
    window.addEventListener('mousemove', onResizeMouseMove)
    window.addEventListener('mouseup', onResizeMouseUp)
  }
  function onResizeMouseMove(e: MouseEvent) {
    if (!dragRef.current) return
    const delta = e.clientX - dragRef.current.startX
    setSidebarWidth(Math.min(640, Math.max(220, dragRef.current.startWidth + delta)))
  }
  function onResizeMouseUp() {
    dragRef.current = null
    window.removeEventListener('mousemove', onResizeMouseMove)
    window.removeEventListener('mouseup', onResizeMouseUp)
  }

  // Map-based site CRUD (2026-07-30 request) — "write" is this app's
  // existing create-verb convention (matches DT Data Manager's canWrite),
  // 'update'/'delete' match SiteDetailPage's own gating exactly so the
  // map never offers an action the detail page itself would reject.
  const canCreate = !!user && isAllowed(user.role, user.permissions.sites, 'write')
  const canUpdate = !!user && isAllowed(user.role, user.permissions.sites, 'update')
  const canDelete = !!user && isAllowed(user.role, user.permissions.sites, 'delete')

  const [addMode, setAddMode] = useState(false)
  // Street/satellite basemap toggle (2026-08-11, "add feature to toggle
  // between satellite view also") — lives here rather than inside
  // MapView.tsx, same "page owns the map toolbar state" convention
  // addMode already uses, so the toggle button can sit in this page's
  // own top-right map overlay stack alongside "+ Add Site".
  const [mapLayer, setMapLayer] = useState<'street' | 'satellite'>('street')
  const [pendingAdd, setPendingAdd] = useState<{ lat: number; lng: number } | null>(null)
  const [pendingRelocate, setPendingRelocate] = useState<{
    site: SiteListItem
    oldLat: number
    oldLng: number
    newLat: number
    newLng: number
  } | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const scope = useMemo(() => {
    if (!sites) return null
    // Active search narrows whatever gets picked (2026-08-10, "if i
    // click the region, then display the result sites only in the map
    // and same for district") — applied to 'all'/'province'/'district'
    // alike, so the map never shows a broader set than what the tree
    // itself is currently displaying under that same node. Deliberately
    // NOT applied to 'site' (a single explicit site click is unambiguous
    // regardless of search text).
    const bySearch = (list: SiteListItem[]) => (treeQ ? list.filter((s) => siteMatchesTreeQuery(s, treeQ)) : list)
    switch (scopeSelector.type) {
      case 'none':
        // Nothing picked yet — see the 2026-08-07 doc comment above
        // ScopeSelector. The map still renders (base tiles + Nepal-wide
        // viewport via FitToScope's empty-sites fallback), it just has
        // zero markers to plot until the user picks something.
        return { sites: [], label: 'Nothing selected', key: 'none' }
      case 'all': {
        const filtered = bySearch(sites)
        return { sites: filtered, label: treeQ ? `All Nepal — search "${treeQuery.trim()}"` : 'All Nepal', key: `all-${treeQ}` }
      }
      case 'province': {
        const filtered = bySearch(sites.filter((s) => (s.region || 'Unassigned') === scopeSelector.province))
        return {
          sites: filtered,
          label: treeQ ? `${scopeSelector.province} — search "${treeQuery.trim()}"` : scopeSelector.province,
          key: `prov-${scopeSelector.province}-${treeQ}`,
        }
      }
      case 'district': {
        const filtered = bySearch(
          sites.filter(
            (s) => (s.region || 'Unassigned') === scopeSelector.province && (s.district || 'Unassigned') === scopeSelector.district,
          ),
        )
        return {
          sites: filtered,
          label: treeQ
            ? `${scopeSelector.district}, ${scopeSelector.province} — search "${treeQuery.trim()}"`
            : `${scopeSelector.district}, ${scopeSelector.province}`,
          key: `dist-${scopeSelector.province}-${scopeSelector.district}-${treeQ}`,
        }
      }
      case 'site': {
        const site = sites.find((s) => s.id === scopeSelector.id)
        return site ? { sites: [site], label: site.name || site.id, key: `site-${site.id}` } : { sites, label: 'All Nepal', key: 'all' }
      }
    }
  }, [scopeSelector, sites, treeQ, treeQuery])

  const scopeSiteIds = useMemo(() => new Set((scope?.sites ?? []).map((s) => s.id)), [scope])

  function selectAllScope() {
    setScopeSelector({ type: 'all' })
  }
  function selectProvinceScope(province: string) {
    setScopeSelector({ type: 'province', province })
  }
  function selectDistrictScope(province: string, district: string) {
    setScopeSelector({ type: 'district', province, district })
  }
  // Tree site-row click: the tree always lists every site regardless of
  // the map's current scope, so a click there can name a site outside
  // whatever's currently plotted. Widen the scope to include it (a
  // single-site scope, same as TopologyPage's own equivalent) instead of
  // just highlighting a site that wouldn't actually be visible.
  function handleTreeSelectSite(site: SiteListItem) {
    if (!scopeSiteIds.has(site.id)) {
      setScopeSelector({ type: 'site', id: site.id })
    }
    selectSite(site.id)
  }

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

  if (isLoading) return <div className="page-status">Loading sites…</div>
  if (error) return <div className="page-status page-status-error">Could not load sites from the API.</div>
  if (!sites || !scope) return null

  const selected = sites.find((s) => s.id === selectedSiteId)

  return (
    <div className="sites-page">
      <aside className="sites-sidebar" style={{ width: sidebarWidth }}>
        <div className="sites-sidebar-header">
          Sites Topology <span className="sites-sidebar-count">{sites.length.toLocaleString()}</span>
        </div>
        <SidebarTree
          sites={sites}
          query={treeQuery}
          onQueryChange={setTreeQuery}
          onSelectAll={selectAllScope}
          onSelectProvince={selectProvinceScope}
          onSelectDistrict={selectDistrictScope}
          onSelectSite={handleTreeSelectSite}
        />
      </aside>
      <div className="sites-sidebar-resize-handle" onMouseDown={onResizeMouseDown} title="Drag to resize" />
      <div className="sites-map-wrap">
        <div className="sites-scope-status">
          {scope.key === 'none' ? (
            <>📍 Select "NTC — All Sites", a region, district, or site from the sidebar to view it on the map.</>
          ) : (
            <>
              📍 Showing: <strong>{scope.label}</strong> — {scope.sites.length.toLocaleString()} site
              {scope.sites.length === 1 ? '' : 's'}
            </>
          )}
        </div>
        {/* Shared top-right overlay toolbar (2026-08-11) — the satellite
            toggle and "+ Add Site" both float over the map, top-right,
            same convention .sites-scope-status (top-left) already uses.
            Wrapped in one flex row instead of two independently
            absolute-positioned buttons so they never overlap regardless
            of whether canCreate hides the Add Site button. */}
        <div className="sites-map-toolbar">
          <button
            type="button"
            className="btn-secondary btn-small"
            onClick={() => setMapLayer((m) => (m === 'street' ? 'satellite' : 'street'))}
            title={mapLayer === 'street' ? 'Switch to satellite view' : 'Switch to street view'}
          >
            {mapLayer === 'street' ? '🛰 Satellite' : '🗺 Street'}
          </button>
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
        <MapView
          sites={scope.sites}
          scopeKey={scope.key}
          selected={selected}
          selectedSectors={selected && selectedSiteDetail?.id === selected.id ? selectedSiteDetail.sectors : undefined}
          onSelect={selectSite}
          addMode={addMode}
          onMapClick={handleMapClick}
          canRelocate={canUpdate}
          onRelocateRequest={handleRelocateRequest}
          mapLayer={mapLayer}
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

      {pendingAdd && (
        <AddSiteModal
          lat={pendingAdd.lat}
          lng={pendingAdd.lng}
          onClose={() => setPendingAdd(null)}
          onCreated={(site) => {
            setPendingAdd(null)
            setScopeSelector({ type: 'site', id: site.id })
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
