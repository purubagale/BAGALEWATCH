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
}

export const DASHBOARD_PATH = OPAQUE_PATHS['/dashboard']
export const SITES_PATH = OPAQUE_PATHS['/sites']
// DtUploadPage navigates here (with a `?session=` param) after a
// successful save, so it needs the real path rather than just the
// old descriptive one used as this map's key.
export const DT_SESSION_HISTORY_PATH = OPAQUE_PATHS['/dt-session-history']

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
