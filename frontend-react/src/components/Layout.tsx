import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useSearchParams } from 'react-router-dom'
import { useBranding, useMenuTree, useSiteSearch } from '../api/queries'
import type { MenuTreeNode, SiteSearchParams } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { canonicalSection } from '../constants/opaqueRoutes'
import { SearchModalContext } from '../contexts/SearchModalContext'
import { useTheme } from '../contexts/ThemeContext'
import { useTreeStore } from '../store/treeStore'
import AdvancedSiteSearchModal from './AdvancedSiteSearchModal'
import { DEFAULT_ROW_LIMIT } from './RowLimitSelect'

const SIDEBAR_PIN_KEY = 'dtwatch_sidebar_pinned'

// One rendering path for a single sidebar row's link — used for
// top-level leaves AND indented submenu children (2026-08-08 sidebar
// rewrite). `link_type` decides internal route (NavLink, so it still
// picks up react-router's own "active" class handling) vs external URL
// (plain <a target="_blank">, since an external link can never be
// "active" and shouldn't navigate away from the app in the same tab).
// `expanded` controls whether label/description text renders at all —
// NOT just an opacity toggle, since a 64px collapsed rail has no room
// for wrapped text regardless of visibility.
function SidebarLink({
  node, expanded, onNavigate,
}: {
  node: MenuTreeNode
  expanded: boolean
  onNavigate: () => void
}) {
  const inner = (
    <>
      <span className="app-sidebar-icon">
        {node.icon_image_url ? (
          <img src={node.icon_image_url} alt="" className="app-sidebar-icon-img" />
        ) : (
          node.icon || '🔗'
        )}
      </span>
      {expanded && (
        <span className="app-sidebar-text">
          <span className="app-sidebar-label">{node.label}</span>
          {node.description && <span className="app-sidebar-desc">{node.description}</span>}
        </span>
      )}
    </>
  )
  const title = expanded ? undefined : node.label
  if (node.link_type === 'external') {
    return (
      <a
        href={node.path} target="_blank" rel="noopener noreferrer"
        className="app-sidebar-link" title={title} onClick={onNavigate}
      >
        {inner}
      </a>
    )
  }
  return (
    <NavLink to={node.path} className="app-sidebar-link" title={title} onClick={onNavigate}>
      {inner}
    </NavLink>
  )
}

// Matches the current route against the menu tree to build the top
// bar's breadcrumb (2026-08-08, made recursive the same day for
// arbitrary submenu depth) — e.g. "SLA" alone for a top-level page, or
// "SLA › NTA › Monthly" if that's how deep an admin has nested things.
// A child ROUTE like a site's detail page isn't its own MenuItem, so it
// still resolves to its section's crumb via the `startsWith(path + '/')`
// prefix check. External-link nodes never match (their `path` is a full
// URL, never a router pathname), which is fine — you can't "be on" an
// external page inside this app anyway.
function findBreadcrumbTrail(tree: MenuTreeNode[], pathname: string): MenuTreeNode[] {
  for (const node of tree) {
    if (node.children.length > 0) {
      const deeper = findBreadcrumbTrail(node.children, pathname)
      if (deeper.length > 0) return [node, ...deeper]
    }
    if (pathname === node.path || pathname.startsWith(`${node.path}/`)) return [node]
  }
  return []
}

// Renders one sidebar entry AND (recursively) its children (2026-08-08
// follow-up: "need multilevel submenu", not just one level). `openGroups`
// is a Set of currently-expanded parent ids shared across the whole
// tree — a Set rather than a single id because two ancestors along the
// same path can legitimately both be open at once (e.g. SLA open, and
// NTA open within it). Children only ever render while `expanded`
// (the sidebar itself is hovered/pinned) AND this node's own id is in
// `openGroups` — a collapsed 64px rail has no room for a nested list
// regardless of depth.
function SidebarNode({
  node, expanded, openGroups, toggleGroup, onNavigate,
}: {
  node: MenuTreeNode
  expanded: boolean
  openGroups: Set<number>
  toggleGroup: (id: number) => void
  onNavigate: () => void
}) {
  const hasChildren = node.children.length > 0
  const isOpen = openGroups.has(node.id)
  return (
    <div>
      <div className="app-sidebar-row">
        <SidebarLink node={node} expanded={expanded} onNavigate={onNavigate} />
        {expanded && hasChildren && (
          <button
            type="button"
            className="app-sidebar-caret-btn"
            onClick={() => toggleGroup(node.id)}
            title={isOpen ? 'Collapse' : 'Expand'}
            aria-label={isOpen ? 'Collapse submenu' : 'Expand submenu'}
          >
            {isOpen ? '▾' : '▸'}
          </button>
        )}
      </div>
      {expanded && hasChildren && isOpen && (
        <div className="app-sidebar-children">
          {node.children.map((child) => (
            <SidebarNode
              key={child.id}
              node={child}
              expanded={expanded}
              openGroups={openGroups}
              toggleGroup={toggleGroup}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  const { theme, toggleTheme } = useTheme()

  // Sidebar shell (2026-08-08 rewrite: "left panel for menu and submenu
  // (icon display with detail on hover) with collapse/expand on hover
  // feature"). Collapsed by default (icon rail) — `sidebarHovered` drives
  // the common case (mouse over the rail widens it, leaving un-widens
  // it), `sidebarPinned` is an explicit opt-in to keep it expanded
  // permanently (persisted, like the theme choice), for a user who'd
  // rather not rely on hover. Known limitation: hover has no equivalent
  // on touch devices — a touch user needs the pin toggle to ever see
  // labels, since there's no hover state to fall back on.
  const [sidebarPinned, setSidebarPinned] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(SIDEBAR_PIN_KEY) === '1'
  })
  const [sidebarHovered, setSidebarHovered] = useState(false)
  const sidebarExpanded = sidebarPinned || sidebarHovered
  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_PIN_KEY, sidebarPinned ? '1' : '0')
  }, [sidebarPinned])

  // Advanced Site Search (2026-08-06) — global, reachable from every
  // page via the top bar, mirroring v1's top-nav search icon rather than
  // living on one specific page. No permission gate here on purpose:
  // SiteSearchView requires only IsAuthenticated (matches v1, which
  // never gated its search modal behind CRUD_MENUS either).
  //
  // Form/results state lives HERE, not inside AdvancedSiteSearchModal
  // (2026-08-07 fix) — so closing the modal to view a site's detail page
  // doesn't throw the search away. `searchOpen` just controls whether the
  // modal is currently visible; `searchForm`/`searchHasSearched`/
  // `siteSearch` (the useSiteSearch() mutation, which carries its own
  // `.data` results) persist across that toggle. See
  // SearchModalContext/SiteDetailPage's "← Back to search results" link.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchForm, setSearchForm] = useState<SiteSearchParams>({})
  const [searchHasSearched, setSearchHasSearched] = useState(false)
  // How many result rows to render at once (2026-08-07 follow-up to the
  // crash fix — see RowLimitSelect.tsx) — lifted alongside the rest of
  // the search state for the same reason: reopening via "← Back to search
  // results" should show the same view, not silently reset to the
  // default row limit.
  const [searchRowLimit, setSearchRowLimit] = useState(DEFAULT_ROW_LIMIT)
  const siteSearch = useSiteSearch()
  const { selectSite } = useTreeStore()

  // Dynamic nav (2026-08-08 request: "add feature to add, update, delete
  // top menu with submenu feature also," extended the same day to
  // "need multilevel submenu") — the sidebar below is rendered entirely
  // from useMenuTree(), which already comes back server-filtered to what
  // this user's role/permissions allow (see MenuTreeView's docstring in
  // core/views.py) and nested to WHATEVER depth an admin has actually
  // built via Menu Admin. `openGroupIds` tracks which submenus (plural —
  // more than one ancestor along the same path can be open at once) are
  // currently expanded — only meaningful while `sidebarExpanded`, since a
  // collapsed rail has no room to show a nested list at all.
  // Gated on `user` (2026-08-08 live bug fix) — Layout renders on EVERY
  // route including pre-login /login, and this query requires auth on the
  // backend. See useMenuTree()'s docstring in api/queries.ts for the full
  // reload-loop this caused when it fired unconditionally.
  const { data: menuTree } = useMenuTree(!!user)

  // Customizable branding (2026-08-08 follow-up: "add feature to
  // customize logo and name") — falls back to the stock Nepal Telecom
  // logo/app name whenever no custom branding has been saved yet
  // (BrandingSettings is a lazy-created singleton, so a fresh install's
  // GET comes back `{app_name: '', logo_url: null}`, not an error).
  const { data: branding } = useBranding()
  const brandLogoSrc = branding?.logo_url || '/ntc-logo.jpg'
  const brandName = branding?.app_name || 'DT-WATCH BTS v2'
  const [openGroupIds, setOpenGroupIds] = useState<Set<number>>(new Set())
  function toggleGroup(id: number) {
    setOpenGroupIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  useEffect(() => {
    if (!sidebarExpanded) setOpenGroupIds(new Set())
  }, [sidebarExpanded])

  const location = useLocation()
  const breadcrumb = findBreadcrumbTrail(menuTree ?? [], location.pathname)

  // Reset-on-menu-change (2026-08-07 request: "at every menu change reset
  // previous menu"). Layout is the one thing that stays mounted across
  // every route, so it's the right place to notice a TOP-NAV section
  // change and clean up whatever's meant to be scoped to "the menu you
  // just left" rather than surviving forever.
  //
  // Deliberately scoped to the top-level path segment ("sites", "sla",
  // "nta", ...), not every route change — /sites <-> /sites/:id is a
  // round trip WITHIN the Sites section (same segment), and must keep
  // working exactly like the fix two requests ago: returning from a
  // site's detail page re-shows the site you were just looking at. Only
  // an actual jump to a DIFFERENT section (e.g. Sites -> SLA) should
  // reset anything — confirmed with the user rather than guessed, since
  // a blanket "every navigation resets everything" would have undone
  // that fix.
  //
  // CORRECTED 2026-08-08 (live bug: "search appears but without previous
  // search result"): Advanced Search is reachable from EVERY page (the
  // top-bar icon), not just Sites, so a real user's actual flow is often
  // open search from Dashboard (or anywhere) -> click a result -> land on
  // /sites/:id?fromSearch=1. That IS a top-level section change
  // ('dashboard' -> 'sites'), so the section-scoped rule above wiped the
  // very search state the ?fromSearch=1 flag exists to protect, before
  // the user ever got a chance to click "Back to search results" — the
  // reset fired immediately on arrival, not on the later click. Exempted
  // that one specific transition (landing on a site detail page tagged
  // ?fromSearch=1) from the reset, regardless of which section it came
  // from — every OTHER cross-section jump still resets normally.
  //
  // CORRECTED AGAIN, same day (dashboard/sites opaque-URL follow-up):
  // `/sites` list now has a hidden opaque alias while `/sites/:id`
  // deliberately keeps its literal path (see opaqueRoutes.ts). Comparing
  // raw path segments would then see "sites" (on a site's detail page)
  // and the alias's own segment as two DIFFERENT sections, re-triggering
  // exactly the reset this whole effect exists to avoid the moment "Back
  // to search results" navigates to the aliased list route. Both
  // `section` and `prevSection` now go through `canonicalSection()`,
  // which maps an aliased path back to its original name first.
  //
  // Two things are scoped to "the whole app", not one page, so Layout is
  // the only place that can reset them: the Advanced Search overlay
  // (would otherwise float on top of an unrelated page if left open
  // while switching sections) and the Sites map's remembered selection
  // (lives in useTreeStore, a module-level store that outlives any one
  // page's own component state). Every OTHER page's filters/forms are
  // already local `useState` owned by that page's own component, so
  // React Router unmounting it on a route change already resets them for
  // free — no extra code needed there.
  const prevSectionRef = useRef<string | null>(null)
  const [searchParams] = useSearchParams()
  useEffect(() => {
    const section = canonicalSection(location.pathname)
    const prevSection = prevSectionRef.current
    const landingOnSearchedSite = /^\/sites\/[^/]+$/.test(location.pathname) && searchParams.get('fromSearch') === '1'
    if (prevSection !== null && prevSection !== section && !landingOnSearchedSite) {
      setSearchOpen(false)
      setSearchForm({})
      setSearchHasSearched(false)
      setSearchRowLimit(DEFAULT_ROW_LIMIT)
      siteSearch.reset()
      if (prevSection === 'sites' && section !== 'sites') {
        selectSite(null)
      }
    }
    prevSectionRef.current = section
    // Any navigation (not just a section change) should close all open
    // submenus — covers browser back/forward and any other programmatic
    // navigation that skips the link's own onClick handler.
    setOpenGroupIds(new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, searchParams])

  return (
    <SearchModalContext.Provider value={{ openSearch: () => setSearchOpen(true) }}>
    <div className="app-shell">
      {user && (
        <aside
          className={`app-sidebar${sidebarExpanded ? ' expanded' : ''}`}
          onMouseEnter={() => setSidebarHovered(true)}
          onMouseLeave={() => setSidebarHovered(false)}
        >
          {/* Real Nepal Telecom logo (2026-08-07 branding pass, re-homed
              into the sidebar 2026-08-08), now customizable per the same
              day's follow-up request — falls back to the stock
              public/ntc-logo.jpg + app name when nothing's been
              uploaded via the Branding settings page. */}
          <div className="app-sidebar-brand">
            <img src={brandLogoSrc} alt={brandName} className="app-logo" />
            {sidebarExpanded && <div className="app-sidebar-title">{brandName}</div>}
          </div>

          <nav className="app-sidebar-nav">
            {(menuTree ?? []).map((node) => (
              <SidebarNode
                key={node.id}
                node={node}
                expanded={sidebarExpanded}
                openGroups={openGroupIds}
                toggleGroup={toggleGroup}
                onNavigate={() => setOpenGroupIds(new Set())}
              />
            ))}
          </nav>

          <div className="app-sidebar-footer">
            <button
              type="button"
              className={`app-sidebar-pin-btn${sidebarPinned ? ' pinned' : ''}`}
              onClick={() => setSidebarPinned((v) => !v)}
              title={sidebarPinned ? 'Unpin sidebar' : 'Keep sidebar expanded'}
            >
              <span className="app-sidebar-icon">{sidebarPinned ? '📌' : '📍'}</span>
              {sidebarExpanded && <span>{sidebarPinned ? 'Pinned open' : 'Pin sidebar open'}</span>}
            </button>
          </div>
        </aside>
      )}

      <div className="app-content-col">
        {user && (
          <header className="app-topbar">
            <div className="app-breadcrumb">
              {breadcrumb.length === 0 && <span className="app-breadcrumb-current">{brandName}</span>}
              {breadcrumb.map((node, i) => (
                <span key={node.id}>
                  {i > 0 && <span className="app-breadcrumb-sep"> › </span>}
                  <span className={i === breadcrumb.length - 1 ? 'app-breadcrumb-current' : undefined}>
                    {node.icon_image_url ? (
                      <img src={node.icon_image_url} alt="" className="app-breadcrumb-icon-img" />
                    ) : (
                      node.icon
                    )} {node.label}
                  </span>
                </span>
              ))}
            </div>
            <div className="app-topbar-actions">
              <button type="button" onClick={() => setSearchOpen(true)} title="Advanced Site Search">
                🔍 Search
              </button>
              <button
                type="button"
                className="theme-toggle-btn"
                onClick={toggleTheme}
                title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              >
                {theme === 'dark' ? '☀️' : '🌙'}
              </button>
              <span>{user.name || user.username}</span>
              <span className="app-topbar-role">{user.role}</span>
              <button onClick={logout}>Sign out</button>
            </div>
          </header>
        )}
        <main className="app-main">{children}</main>
      </div>

      {searchOpen && (
        <AdvancedSiteSearchModal
          onClose={() => setSearchOpen(false)}
          form={searchForm}
          setForm={setSearchForm}
          hasSearched={searchHasSearched}
          setHasSearched={setSearchHasSearched}
          search={siteSearch}
          rowLimit={searchRowLimit}
          setRowLimit={setSearchRowLimit}
        />
      )}
    </div>
    </SearchModalContext.Provider>
  )
}
