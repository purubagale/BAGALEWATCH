import { lazy, Suspense, useEffect, type ReactElement } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import './App.css'
import { useBranding, useMenuTree } from './api/queries'
import { useAuth } from './auth/AuthContext'
import ProtectedRoute from './auth/ProtectedRoute'
import Layout from './components/Layout'
import MenuSectionGate from './components/MenuSectionGate'
import { DASHBOARD_PATH, OPAQUE_PATHS, SITES_PATH } from './constants/opaqueRoutes'
import DashboardPage from './pages/DashboardPage'
import LoginPage from './pages/LoginPage'
import AboutPage from './pages/AboutPage'
import SsoCallbackPage from './pages/SsoCallbackPage'
import MenuSectionPage from './pages/MenuSectionPage'
import SitesPage from './pages/SitesPage'
import { findNodeByPath } from './utils/menuTree'

// DT-WATCH BTS v2 — React app.
//
// Phase 1: auth + read-only Sites/Sectors (login, sidebar tree, map,
// per-site KPI display). Phase 2 (§6 of the migration plan) adds full
// CRUD: site/sector editing (inline on SiteDetailPage), KPI threshold
// management, tree structure management, and user/permission admin —
// each gated behind ProtectedRoute (must be logged in) at the route
// level, with finer per-menu/per-action gating inside each page itself
// (see api/types.ts's isAllowed()), same split as v1's client + server.
//
// Route-level code-splitting (2026-08-05, perf pass) — everything except
// LoginPage, SitesPage, and (2026-08-08) DashboardPage — the pages
// nearly every session hits immediately, since RootRedirect now sends a
// logged-in user to /dashboard first — is a React.lazy() import instead
// of a static one. Before this, the initial bundle included every admin/
// reporting page up front — most expensively DtDataManagerPage, which
// alone pulls in Leaflet, multiple map components, and the CSV/XLSX/TRP
// parsing code, none of which a user who only ever looks at the Sites
// map was paying to download and parse for any reason. Each page still
// gets its own request only the first time its route is actually
// visited, then it's cached by the browser like any other asset — this
// doesn't change what loads, only when.
const SiteDetailPage = lazy(() => import('./pages/SiteDetailPage'))
const ThresholdsPage = lazy(() => import('./pages/ThresholdsPage'))
const DtBandsPage = lazy(() => import('./pages/DtBandsPage'))
const BackupPage = lazy(() => import('./pages/BackupPage'))
const TreeAdminPage = lazy(() => import('./pages/TreeAdminPage'))
const UsersPage = lazy(() => import('./pages/UsersPage'))
const PermissionsPage = lazy(() => import('./pages/PermissionsPage'))
const MenuAdminPage = lazy(() => import('./pages/MenuAdminPage'))
const BrandingPage = lazy(() => import('./pages/BrandingPage'))
const SlaTrackerPage = lazy(() => import('./pages/SlaTrackerPage'))
const NtaCompliancePage = lazy(() => import('./pages/NtaCompliancePage'))
const MonthlyReportPage = lazy(() => import('./pages/MonthlyReportPage'))
const ScatterPlotPage = lazy(() => import('./pages/ScatterPlotPage'))
const KpiTrendPage = lazy(() => import('./pages/KpiTrendPage'))
const RfAuditPage = lazy(() => import('./pages/RfAuditPage'))
// DtDataManagerPage.tsx (the old single-page, 3-tab version) was split
// into three real routes (2026-08-09 request: "manage upload, manage
// session and explore in different sub menu item... not in different
// tab on same page") — see the three lazy imports below. The parent
// '/dt-data-manager' route no longer renders a page component of its
// own at all; once migration 0020 gives it these three as MenuItem
// children, MenuSectionGate (see withSection() below) shows its
// auto-generated section listing instead, same mechanism every other
// multi-child top-level item already uses.
const DtUploadPage = lazy(() => import('./pages/DtUploadPage'))
const DtSessionHistoryPage = lazy(() => import('./pages/DtSessionHistoryPage'))
const DtExplorePage = lazy(() => import('./pages/DtExplorePage'))
// Fourth DT Data Manager child (2026-08-11) — deep per-file TRP
// diagnostics, ported from v1's "TRP File Analysis" feature. See
// migration 0028_seed_trp_analysis_submenu.py and lib/trpAnalysis.ts.
const TrpAnalysisPage = lazy(() => import('./pages/TrpAnalysisPage'))
// External data-exchange API key management (2026-08-12) — see
// migration 0030_seed_api_access_menuitem.py and core/api_auth.py.
const ApiAccessPage = lazy(() => import('./pages/ApiAccessPage'))

// Reflects customized branding (2026-08-08 follow-up) into the two
// things that live outside React's own render tree — the document
// title and the favicon <link> tags in index.html — since neither can
// be set via normal JSX. Runs at the App root (not inside Layout) so it
// also applies pre-login on LoginPage, matching BrandingSettingsView's
// GET being AllowAny for the same reason. No-ops back to the static
// defaults already in index.html when nothing's been customized, so a
// fresh install's tab keeps showing the real Nepal Telecom favicon
// rather than this effect clobbering it with something blank.
function useBrandingSideEffects() {
  const { data: branding } = useBranding()
  useEffect(() => {
    if (branding?.app_name) {
      document.title = `${branding.app_name} — Nepal Telecom`
    }
  }, [branding?.app_name])
  useEffect(() => {
    if (!branding?.logo_url) return
    const links = document.querySelectorAll<HTMLLinkElement>(
      'link[rel="icon"], link[rel="apple-touch-icon"]',
    )
    links.forEach((link) => { link.href = branding.logo_url as string })
  }, [branding?.logo_url])
}

// Wraps a top-level route's page element with MenuSectionGate (2026-08-08
// request: "for top level item menu if submenu is present then... display
// all the inside submenu items"), so every one of these routes shows an
// auto-generated section listing instead of its own page WHENEVER a
// superadmin has given that menu item children — see MenuSectionGate.tsx.
// `/dashboard` deliberately does NOT use this helper (see that file's
// docstring for why); every other top-level item does.
function withSection(path: string, element: ReactElement) {
  return (
    <ProtectedRoute>
      <MenuSectionGate path={path}>{element}</MenuSectionGate>
    </ProtectedRoute>
  )
}

/** Registers a formerly-descriptive top-level route at its new opaque
 * path (wrapped in the same ProtectedRoute + MenuSectionGate every other
 * top-level route gets) PLUS a redirect from the old descriptive path,
 * so nothing that already links to the old path 404s. */
function withOpaqueSection(oldPath: string, element: ReactElement) {
  const opaquePath = OPAQUE_PATHS[oldPath]
  return (
    <>
      <Route path={opaquePath} element={withSection(opaquePath, element)} />
      <Route path={oldPath} element={<Navigate to={opaquePath} replace />} />
    </>
  )
}

function RootRedirect() {
  const { user } = useAuth()
  // Dashboard is now the default post-login landing page (2026-08-08
  // request, confirmed via AskUserQuestion) — Sites Topology moved into
  // being a regular sidebar item instead of the implicit first screen.
  // Points straight at the opaque path (2026-08-08 follow-up) rather than
  // the old descriptive '/dashboard' — both work (the old one is still a
  // registered redirect, see the Route below), but landing directly on
  // the real path skips a pointless extra redirect hop.
  return <Navigate to={user ? DASHBOARD_PATH : '/login'} replace />
}

/** Catch-all for any path that ISN'T one of the ~18 hardcoded page routes
 * above. Added 2026-08-08 alongside the recursive-lookup fix in
 * MenuSectionGate.tsx: a superadmin can create a brand-new top-level (or
 * nested) menu item purely through Menu Admin — e.g. "Master Data" with
 * route "/master-data" and no dedicated page component anywhere in this
 * file — and until now that path had literally no matching <Route>, so
 * clicking it just fell through to RootRedirect and bounced back to
 * Dashboard. This makes that case work the way the existing hardcoded
 * pages already do: if the clicked path resolves to a menu node that HAS
 * children, show the same auto-generated section listing; a parent-only
 * item never needs App.tsx touched at all. If the path matches a leaf
 * node (no children) or nothing in the tree, there's still no real page
 * to show, so it falls back to Dashboard exactly like before. */
function DynamicMenuFallback() {
  const { user, restoring } = useAuth()
  const { data: menuTree } = useMenuTree(!!user)
  const location = useLocation()
  if (restoring) return null
  if (!user) return <Navigate to="/login" replace />
  const node = findNodeByPath(menuTree ?? [], location.pathname)
  if (node && node.children.length > 0) {
    return <MenuSectionPage node={node} />
  }
  return <Navigate to={DASHBOARD_PATH} replace />
}

function App() {
  useBrandingSideEffects()
  return (
    <Layout>
      <Suspense fallback={<div className="page-status">Loading…</div>}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* SSO landing route (2026-08-23). Public and eagerly imported,
            like LoginPage: it is on the critical sign-in path, so a lazy
            chunk fetch here would add a round trip before the one-time
            code can be exchanged — and that code expires in ~60s. */}
        <Route path="/sso/callback" element={<SsoCallbackPage />} />
        {/* Not in the dynamic menu, so not subject to the per-menu
            permissions matrix — an About page every role can open.
            Still behind ProtectedRoute: it exposes the git SHA and
            build tag, which is more than a stranger needs. */}
        <Route path="/about" element={<ProtectedRoute><AboutPage /></ProtectedRoute>} />
        {/* Dashboard keeps its own opaque alias like every other
            top-level route (2026-08-08 follow-up: "for dashboard, sites
            topology... plain path is displayed, correct them also") but
            deliberately skips MenuSectionGate/withSection, same reasoning
            as always — see MenuSectionGate.tsx's docstring on why
            Dashboard shouldn't ever be overridden by an auto-generated
            section listing. */}
        <Route
          path={DASHBOARD_PATH}
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route path="/dashboard" element={<Navigate to={DASHBOARD_PATH} replace />} />
        {withOpaqueSection('/sites', <SitesPage />)}
        {/* /sites/:id (a specific site's own page) is deliberately NOT
            aliased — see opaqueRoutes.ts's comment: renaming just the
            bare /sites list route above doesn't touch this nested dynamic
            route or any of its ~9 hardcoded `/sites/${id}` references
            elsewhere, so this stays exactly as it was. */}
        <Route
          path="/sites/:id"
          element={
            <ProtectedRoute>
              <SiteDetailPage />
            </ProtectedRoute>
          }
        />
        {withOpaqueSection('/thresholds', <ThresholdsPage />)}
        {withOpaqueSection('/dt-bands', <DtBandsPage />)}
        {withOpaqueSection('/backup', <BackupPage />)}
        {withOpaqueSection('/tree-admin', <TreeAdminPage />)}
        {withOpaqueSection('/users', <UsersPage />)}
        {withOpaqueSection('/permissions', <PermissionsPage />)}
        {withOpaqueSection('/menu-admin', <MenuAdminPage />)}
        {withOpaqueSection('/branding', <BrandingPage />)}
        {withOpaqueSection('/sla', <SlaTrackerPage />)}
        {withOpaqueSection('/nta', <NtaCompliancePage />)}
        {withOpaqueSection('/monthly-report', <MonthlyReportPage />)}
        {withOpaqueSection('/scatter', <ScatterPlotPage />)}
        {withOpaqueSection('/kpi-trend', <KpiTrendPage />)}
        {withOpaqueSection('/rf-audit', <RfAuditPage />)}
        {/* '/dt-data-manager' has no page of its own anymore — once
            migration 0020 gives it Upload/Session History/Explore as
            MenuItem children, MenuSectionGate (inside withOpaqueSection)
            shows those as an auto-generated section listing instead of
            this element. This <Navigate> is only reached if that gate
            ever finds NO children (e.g. a superadmin deletes all three
            via Menu Admin) — sends an old bookmark somewhere real instead
            of a dead end. */}
        {withOpaqueSection('/dt-data-manager', <Navigate to={OPAQUE_PATHS['/dt-upload']} replace />)}
        {withOpaqueSection('/dt-upload', <DtUploadPage />)}
        {withOpaqueSection('/dt-session-history', <DtSessionHistoryPage />)}
        {withOpaqueSection('/dt-explore', <DtExplorePage />)}
        {withOpaqueSection('/trp-analysis', <TrpAnalysisPage />)}
        {withOpaqueSection('/api-access', <ApiAccessPage />)}
        {/* /topology retired 2026-08-05 — its "scope: all/region/district"
            concept was folded directly into the Sites map/tree (see
            SitesPage.tsx/SidebarTree.tsx), so a separate page/route is no
            longer needed. Redirect any old bookmark/link straight to
            Sites rather than 404ing. */}
        <Route path="/topology" element={<Navigate to={SITES_PATH} replace />} />
        <Route path="/" element={<RootRedirect />} />
        <Route path="*" element={<DynamicMenuFallback />} />
      </Routes>
      </Suspense>
    </Layout>
  )
}

export default App
