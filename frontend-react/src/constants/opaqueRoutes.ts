// Opaque URL aliases (2026-08-08, "secure the dynamic path url... so no
// one can see the actual path" follow-up) — cosmetic, NOT real security
// (a URL is always visible to whoever's looking at their own address
// bar; the actual access control is every API call's own server-side
// auth check, unaffected by what the frontend route is named).
//
// Pulled out of App.tsx into its own module (2026-08-08, same-day
// follow-up: "for dashboard, sites topology... plain path is displayed,
// correct them also") so LoginPage.tsx and MenuSectionPage.tsx can reach
// the same mapping without importing from App.tsx itself (which would be
// a page importing the app shell — backwards).
//
// KEEP IN SYNC with the identical mapping in
// core/migrations/0018_obfuscate_builtin_menu_paths.py +
// core/migrations/0019_obfuscate_dashboard_sites_paths.py (which rename
// the seeded MenuItem.path values to match) and this app's
// KNOWN_ROUTES-equivalent in MenuAdminPage.tsx.
//
// `/dashboard` and `/sites` were ORIGINALLY excluded (2026-08-08, first
// pass) alongside `/login` — the comment at the time cited "9 scattered
// hardcoded `/sites/${id}` references elsewhere; renaming it risked
// silently breaking navigation." That turned out to overstate the risk:
// every one of those 9 references is to the `/sites/:id` DETAIL
// sub-route (a site's own page), which this mapping still deliberately
// does NOT touch — only the bare `/sites` list/map route is aliased
// here, so none of those 9 references needed to change. `/login` stays
// excluded on purpose: it's the one URL a signed-out user needs to be
// able to find/guess, obfuscating it would be actively unhelpful.
//
// Each OLD descriptive path stays mounted too, as a plain redirect to
// the new opaque one — an existing bookmark/shared link still works, it
// just immediately redirects. Going forward the sidebar/breadcrumb/
// dashboard only ever generate the new opaque links, since they're built
// straight from MenuItem.path (which the migrations already renamed).
// NOTE: '/about' is deliberately absent from this map (2026-08-23). The
// obfuscation exists so a URL does not advertise what the system does;
// '/about' advertises nothing, it is registered as a static route in
// App.tsx, and its MenuItem is seeded with '/about' directly (see
// 0032_seed_about_menuitem.py). Adding an alias here would create two URLs
// for one page and buy nothing.
export const OPAQUE_PATHS: Record<string, string> = {
  '/dashboard': '/m4h8qz',
  '/sites': '/e6t2pv',
  '/sla': '/p3k7q2',
  '/nta': '/x9f1lz',
  '/monthly-report': '/h4t8vn',
  '/scatter': '/b6r0wc',
  '/kpi-trend': '/q2n5je',
  '/rf-audit': '/z8m3ky',
  // '/dt-data-manager' itself now only ever renders MenuSectionGate's
  // auto-generated section listing (see App.tsx) — the single-page tabbed
  // UI it used to point at was split into three real submenu items below
  // (2026-08-09 request: "manage upload, manage session and explore in
  // different sub menu item... not in different tab on same page"). Kept
  // in this map (rather than deleted) since old bookmarks/links to
  // '/dt-data-manager' or '/w7h1sd' should still land somewhere sane, not
  // 404 — see App.tsx's route for it.
  '/dt-data-manager': '/w7h1sd',
  '/dt-upload': '/n4v8gz',
  '/dt-session-history': '/s2h6mp',
  '/dt-explore': '/e7x3kt',
  // Fourth DT Data Manager child (2026-08-11) — deep per-file TRP
  // diagnostics, ported from v1's "TRP File Analysis" feature. Path
  // seeded server-side by migration 0028_seed_trp_analysis_submenu.py —
  // keep this in sync with that file (same convention as every other
  // entry in this map).
  '/trp-analysis': '/v8k3nq',
  '/thresholds': '/k5c9bf',
  '/tree-admin': '/r2v6mt',
  '/backup': '/f9j4qs',
  '/dt-bands': '/t3n7hy',
  '/users': '/d8k2wr',
  '/permissions': '/y5b1qx',
  '/menu-admin': '/c4h9lt',
  '/branding': '/j6r3fp',
  // External data-exchange API key management (2026-08-12) — seeded
  // server-side by migration 0030_seed_api_access_menuitem.py — keep
  // this in sync with that file, same convention as every other entry.
  '/api-access': '/n8w5qk',
  // Live Site Directory sync status/manual-trigger page (2026-08-26) —
  // seeded server-side by migration 0038_seed_live_site_sync_menuitem.py —
  // keep this in sync with that file, same convention as every other entry.
  '/live-site-sync': '/l9x4rq',
  // Crowdsourced-telemetry pages (2026-08-31) — seeded server-side by
  // migration 0041_seed_telemetry_menuitems.py — keep these in sync with
  // that file, same convention as every other entry.
  '/telemetry-coverage': '/t7m2kq',
  '/telemetry-admin': '/t4v9cx',
  // Live raw-sample dev/pilot-testing tool (added alongside the above) --
  // originally had NO seeded MenuItem at all (only reachable via a plain
  // <a href> button in TelemetryAdminPage.tsx's "Dev tools" section), per
  // explicit request to keep it superadmin-only and off the main menu.
  // 2026-09-30 ("manage live sample page seperately in menu inside
  // telemetry with superadmin permission") reversed that -- now seeded
  // server-side by migration 0072_seed_telemetry_live_samples_menuitem.py
  // as a child of the "Telemetry" group -- keep this in sync with that
  // file, same convention as every other entry below.
  '/telemetry-live-samples': '/z3q8mn',
  // VoLTE/VoNR call-quality dev/pilot list view (2026-10-02) -- see
  // core/volte_quality.py's VolteQualityListView docstring. Seeded
  // server-side by migration 0088_seed_volte_quality_menuitem.py, same
  // superadmin-only posture and same reasoning as '/telemetry-live-samples'
  // just above -- raw per-call data, not a general feature.
  '/telemetry-volte-samples': '/w2k6tr',
  // Scoped drive-test sessions over live telemetry (2026-09-01) — seeded
  // server-side by migration 0044_seed_telemetry_dt_session_menuitem.py —
  // keep this in sync with that file, same convention as every other
  // entry. Unlike '/telemetry-live-samples' above, THIS one was always
  // access='admin', not superadmin-only: it's the consent-scoped,
  // promotable replacement for that dev tool (see
  // TelemetryDriveTestSession's docstring in core/models.py).
  '/telemetry-dt-sessions': '/t6q9lp',
  // Rescue-location lookup pages (2026-09-03) -- seeded server-side by
  // migration 0049_rescue_menu_items.py -- keep these in sync with that
  // file, same convention as every other entry.
  '/rescue-lookup': '/r5t8mq',
  '/rescue-policy': '/r2p6ky',
  // Superadmin-only enrolled-device list (2026-10-07) -- seeded server-side
  // by migration 0106_seed_rescue_enrolled_menuitem.py, same convention.
  '/rescue-enrolled': '/r8x4ml',
  // Site/Sector Issue tracker's global list (2026-09-14) -- seeded
  // server-side by migration 0058_seed_issues_menuitem.py -- keep this
  // in sync with that file, same convention as every other entry.
  '/issues': '/i8s4kw',
  // Vendor RNO report importer (2026-09-15) -- seeded server-side by
  // migration 0062_seed_rf_reports_menuitem.py -- keep this in sync
  // with that file, same convention as every other entry.
  '/rf-reports': '/g3q7nx',
  // DT Plot Catalog (2026-09-23) -- seeded server-side by migration
  // 0067_seed_dt_plot_catalog_menuitem.py -- keep this in sync with that
  // file, same convention as every other entry.
  '/dt-plot-catalog': '/k9d4wr',
  // Originally "Login/access audit trail" (2026-10-01, seeded by
  // migration 0075_seed_access_log_menuitem.py), RELABELED in place to
  // "Audit Log" the same day by migration
  // 0083_relabel_access_log_menuitem.py once AccessLogPage.tsx was
  // replaced by the broader AuditLogPage.tsx (unified access + data-change
  // feed -- see core/audit.py). Same path/MenuItem id throughout -- this
  // dict key is left as '/access-log' on purpose, it's an internal lookup
  // key, not anything user-visible, and renaming it buys nothing.
  '/access-log': '/a3x9lq',
  // Active IP blocking (2026-10-02, Phase E2) -- seeded server-side by
  // migration 0091_seed_blocked_ips_menuitem.py -- keep in sync with that
  // file and MenuAdminPage.tsx's KNOWN_ROUTES list.
  '/blocked-ips': '/b3n7qz',
  // Device-bound tracing operator console (2026-10-04). Seeded server-side by
  // core/migrations/0093_seed_trace_requests_menuitem.py.
  '/trace-requests': '/t7ak2m',
  '/collections': '/c5w8hn',
  // Multi-role RBAC ("full parity" feature, 2026-10-01) -- seeded
  // server-side by migration 0079_seed_rbac_menuitems.py -- keep these in
  // sync with that file, same convention as every other entry.
  '/manage-roles': '/q4m8rz',
  '/assign-roles': '/v6p2nt',
  '/menu-visibility': '/h3k9wq',
  // System Health (2026-10-01, "idea and plan" follow-up to the UTS
  // reference screenshots) -- seeded server-side by migration
  // 0080_seed_system_health_menuitem.py -- keep this in sync with that
  // file, same convention as every other entry.
  '/system-health': '/s7m3kx',
  // In-app Documentation (2026-10-01, same follow-up) -- seeded
  // server-side by migration 0081_seed_documentation_menuitem.py -- keep
  // this in sync with that file, same convention as every other entry.
  '/documentation': '/d9w4nr',
}

export const DASHBOARD_PATH = OPAQUE_PATHS['/dashboard']
export const SITES_PATH = OPAQUE_PATHS['/sites']
// DtUploadPage navigates here (with a `?session=` param) after a
// successful save, so it needs the real path rather than just the
// old descriptive one used as this map's key.
export const DT_SESSION_HISTORY_PATH = OPAQUE_PATHS['/dt-session-history']
// DtPlotCatalogPage.tsx links 'available' rows straight into DT Explore.
export const DT_EXPLORE_PATH = OPAQUE_PATHS['/dt-explore']
// SiteDetailPage.tsx's Antenna Change History section (2026-09-23) links
// each imported change back to its source report.
export const RF_REPORTS_PATH = OPAQUE_PATHS['/rf-reports']
export const DT_PLOT_CATALOG_PATH = OPAQUE_PATHS['/dt-plot-catalog']
// UsersPage.tsx links each row straight into Assign Roles, with a
// `?user=<id>` param that page reads to auto-select that user.
export const ASSIGN_ROLES_PATH = OPAQUE_PATHS['/assign-roles']
export const MANAGE_ROLES_PATH = OPAQUE_PATHS['/manage-roles']
export const MENU_VISIBILITY_PATH = OPAQUE_PATHS['/menu-visibility']
export const SYSTEM_HEALTH_PATH = OPAQUE_PATHS['/system-health']

/** Maps a pathname's top-level segment back to its ORIGINAL descriptive
 * name (e.g. both `/sites` and its alias `/e6t2pv` normalize to
 * `'sites'`), regardless of which form is actually in the URL. Added
 * alongside the dashboard/sites aliasing (2026-08-08): Layout.tsx's
 * reset-on-section-change effect compares "is this the same top-level
 * section as before" using nothing but the raw first path segment. That
 * was harmless for the original 15 aliased pages (each is a single leaf
 * page, so there's only ever one path per section either way), but
 * `/sites` is different — it has a second, DELIBERATELY unaliased
 * sibling route (`/sites/:id`, a site's own page) that must keep
 * comparing equal to it. Without this normalization, navigating from
 * `/sites/CDR0123` (section "sites") to the new `/e6t2pv` (section
 * "e6t2pv") would look like a genuine cross-section jump and wipe the
 * Advanced Search state the very "← Back to search results" flow is
 * trying to preserve — the opposite of the 2026-08-08 fix two requests
 * before this one. */
export function canonicalSection(pathname: string): string {
  const seg = '/' + (pathname.split('/')[1] || '')
  for (const [oldPath, newPath] of Object.entries(OPAQUE_PATHS)) {
    if (seg === newPath) return oldPath.slice(1)
  }
  return seg.slice(1)
}

