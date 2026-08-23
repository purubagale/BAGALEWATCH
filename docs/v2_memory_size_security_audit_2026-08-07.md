# DT-WATCH BTS v2 — Memory, Size & Security Audit
**Date:** 2026-08-07 · **Scope:** `dt-watch/` (React + Django). v1 (`bts_monitor.html`) not in scope.

Every finding below was verified against the real source and, where practical, against a real running instance (dev DB, live API calls, actual payload sizes) — not guessed. Severity is rated High / Medium / Low based on how directly it could cause a crash, data exposure, or real user impact in this specific app.

---

## 1. Memory — unbounded renders and lifecycle

**Already fixed this session:** Advanced Site Search's results table had no row cap; a no-filter search returned up to 4,718 sites rendered as ~47,000 DOM nodes. Fixed with a 300-row render cap (CSV export still gets the full set).

### ~~High~~ FIXED 2026-08-07 — SLA Tracker and NTA Compliance pages render every KPI site, uncapped, on page load

`SlaTrackerPage.tsx` defaults to `region = 'all'` and `NtaCompliancePage.tsx` defaults to `pane = 'all-sites'` — both fire immediately when the page opens, no user action required (worse than the Advanced Search case, which at least needed a click). Their result tables (`report.sites.map(...)`, `sites.map(...)`) render one `<tr>` per matching site with no cap or virtualization. In the dev DB, 2,242 sites have `kpi_entered=True`; each row has ~16-19 columns. That's the same failure class that just caused a real browser crash, sitting live on two pages that load this way by default.

**Fixed**: both pages now cap rendered rows (same pattern as Advanced Search) with a visible truncation note. Originally a flat 300-row cap; per a same-day follow-up request, all three views (Advanced Search + these two) now share `components/RowLimitSelect.tsx` — a dropdown defaulting to **50** rows with 100/150/250/500 also selectable — instead of a fixed constant. SLA Tracker's CSV export still exports the full set regardless of the chosen limit; NTA Compliance has no CSV export to fall back to, so its note points at "Violations Only" instead. `tsc -b --force` clean.

### ~~Medium~~ FIXED 2026-08-07 — Tree Structure Manager's "Assigned sites" table

`TreeAdminPage.tsx`'s `assignedEntries.map(...)` (line 321) rendered one row per site assigned to any custom folder, uncapped. Low risk at the time only because custom trees are opt-in and likely cover a subset of sites — but nothing stopped it from covering all 4,700+ if an org fully adopted a custom tree.

**Fixed**: now uses the shared `RowLimitSelect` (default 50, `unit="sites"`) with a truncation note, same pattern as SLA/NTA/Advanced Search. `tsc -b --force` clean.

### ~~Medium~~ FIXED 2026-08-07 — DT Compare Sessions "blank/plots only" view

`DtCompareMap.tsx`'s `ScatterPanelPlot` (added 2026-08-05) plotted every raw sample from up to `MAX_COMPARE=4` sessions as an SVG `<circle>`+`<title>` pair, with no downsampling. `DtCoverageMap.tsx`'s own docstring explicitly documents the app's working assumption — "DT sessions run a few thousand points at most" — for a *single* session; comparing 4 real sessions at once can multiply that past the assumption the rendering approach was designed around.

**Fixed**: `ScatterPanelPlot` now takes a `pointLimit` prop (shared `RowLimitSelect`, default 50) and slices before rendering, with an in-SVG truncation note when capped. Only applies to blank/plots-only mode — the real coordinate map (bounded by `MAX_COMPARE` already) is untouched. `tsc -b --force` clean.

### Confirmed safe (verified, not assumed)
- **No raw `L.map()` instances anywhere in v2** — every map uses `react-leaflet`'s `<MapContainer>`, which disposes itself on unmount. The v1 "Leaflet map instance leak" bug class does not exist in v2.
- **Sites sidebar (`SidebarTree.tsx`)** is properly virtualized via `@tanstack/react-virtual`, including in flat search-result mode — DOM node count stays ~constant regardless of the 4,700+ site count.
- **Scatter Plot page** renders all 4,718 sites to a `<canvas>`, not one DOM node per point — confirmed by reading the render code, not by the page name.
- **Tree Admin's site-search autocomplete** is explicitly capped at 20 results (`.slice(0, 20)`).
- **`TopologyMap.tsx`** has an unbalanced `addEventListener`/`removeEventListener` pair (fullscreen listener), but this component is confirmed dead code (no route or import references it — see prior session's retirement of the standalone Topology page) — zero live impact today, worth deleting rather than fixing in place.

---

## 2. Size — bundle, dependencies, payloads

- **Dependencies are lean.** No duplicate charting/date/utility libraries (no moment.js, lodash, or a chart library alongside the app's own hand-rolled canvas/SVG rendering for Scatter Plot and KPI Trend). `leaflet.markercluster` is a real, actively-used dependency (imperative clustering in `MapView.tsx`, since `react-leaflet` v5 has no working cluster wrapper) — not dead weight.
- **Route-level code-splitting is real and broad**: 14 of 15 routed pages are `React.lazy()`-loaded in `App.tsx`. Only `LoginPage` and `SitesPage` are eager, which is the right call — `SitesPage` is what nearly every session opens immediately after login.
- **Minor finding:** `AdvancedSiteSearchModal` is imported eagerly inside `Layout.tsx`, which wraps every route — so its code ships in the main bundle even for sessions that never open search. Worth wrapping in its own `React.lazy()` + `Suspense`, same pattern already used for every routed page, for a small win.
- **Could not get a current, authoritative bundle-size number.** `npm run build` (`vite build`) fails in this sandbox — `node_modules/@rolldown` here only has the Windows native binding, since it was installed on your machine, not this environment. The `dist/` folder already on disk is from **2026-07-31**, before route-level code-splitting and everything built this session — its single 695 KB (210 KB gzip) JS file is not representative of the current source. **Recommend checking the real chunk sizes from your own next `npm run build` output.**
- **Backend payloads are already deliberately lean** where it matters: `SiteListSerializer` (used by `/sites/`) excludes KPI and sector data by design; `SiteSearchView` returns small flat dicts. No pagination exists on `/sites/` (4,718 rows), but it's cached client-side for 60s and was a documented, deliberate tradeoff — fine at current scale, would need real pagination if the site count grew another order of magnitude.

---

## 3. Security

### ~~High~~ FIXED 2026-08-07 — `DEBUG=1` in the real `.env` you're running

Your actual `backend-django/.env` had `DEBUG=1` set — not just the `.env.example` template, the file the running stack actually reads. With Django's `DEBUG=True`, any unhandled server error returns a full debug page: stack trace, local variable values, settings, and SQL queries, to whoever triggers it. `ALLOWED_HOSTS` is still `localhost,127.0.0.1` so exposure was currently limited to whoever can reach that machine — but now that this system holds real site/sector/KPI data, this was worth turning off outside of active local development.

**Fixed**: `.env` now has `DEBUG=0`. **This needs a container restart to take effect** (`docker compose up --build django` or a plain restart) — env vars are read once at process start.

### ~~High~~ FIXED 2026-08-07 — password strength validators are configured but never enforced

`settings.py` configures `AUTH_PASSWORD_VALIDATORS` (minimum length, common-password check, etc.), but `UserWriteSerializer.create()`/`update()` (`core/serializers.py`) called Django's `set_password()` directly without ever calling `validate_password()`. **Verified live**: created a real user through `/api/v2/users/` with the password `"1"` — the API returned `201 Created`. Any admin/superadmin could set any user's password to anything, including a single character.

**Fixed**: `UserWriteSerializer.validate()` now calls `django.contrib.auth.password_validation.validate_password()` whenever a password is being set (create, or an update that includes one — a PUT that leaves the password field out is untouched). Verified live: weak password create → 400 with real validator messages; strong password create → 201; weak password update → 400; update without a password field → 200 unaffected; a password too similar to the username → 400 (`UserAttributeSimilarityValidator` now has a real user instance to compare against). One existing test (`test_superadmin_create_sets_native_password_hash`) used `'hunter2'` as its fixture password — now correctly rejected as a common password — updated to a real strong password; all 59 tests pass.

### Medium — hardcoded `SECRET_KEY` fallback

`settings.py` line 19 falls back to a literal string (`'dev-only-insecure-key-override-in-.env'`, visible in source) if the `SECRET_KEY` env var is ever unset, rather than failing to start. Recommend raising `ImproperlyConfigured` when `DEBUG=False` and no real key is set, so a misconfigured deploy fails loudly instead of silently running with a key anyone can read in this very file.

### Medium — refresh tokens rotate but are never blacklisted

`SIMPLE_JWT['ROTATE_REFRESH_TOKENS'] = True`, but `rest_framework_simplejwt.token_blacklist` isn't in `INSTALLED_APPS`. A refresh token that's been rotated away still works until its own 12-hour expiry — rotation without blacklisting doesn't actually revoke the old token, just issues a new one alongside it. Adding the blacklist app (one migration, one settings line) closes this.

### Low — no HTTPS-enforcement settings

No `SECURE_SSL_REDIRECT`, `SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE`, or HSTS settings. Not urgent for a localhost-only deployment, but should be added the moment this is ever reachable over a real network (a reverse proxy terminating TLS would also need to be introduced at that point — there isn't one today; Django is reached directly on port 8000).

### Low — no request body size limit on JSON endpoints

Verified empirically: Django's `DATA_UPLOAD_MAX_MEMORY_SIZE` (default 2.5 MB) does **not** apply to raw `application/json` bodies — only to form/multipart parsing. Sent a synthetic 4.84 MB JSON payload to `/api/v2/backup/import-sites/` and it was accepted without any size check. Every endpoint that accepts a JSON body is already gated to authenticated (and mostly admin/superadmin) users, so this isn't an open exploit — but there's currently nothing stopping an authenticated account from sending an arbitrarily large body and consuming server memory. Worth a defensive size check on the bulk-write endpoints specifically (`ImportSitesView`, `BackupImportView`).

### Confirmed safe (verified, not assumed)
- **No SQL injection surface** — no raw `.raw()`/`cursor.execute()` with interpolated input anywhere; the one `cursor.execute()` call is a static `'SELECT 1'` health check.
- **No XSS via `dangerouslySetInnerHTML`** — used in 3 places (Monthly Report, RF Audit report + history), all through `lib/markdown.ts`'s `renderMarkdown()`, which HTML-escapes every piece of user-controlled text (`&`, `<`, `>`) before wrapping it in tags. Read the actual escaping code to confirm this rather than assuming.
- **Permission coverage is complete** — every view has either an explicit `permission_classes` or inherits the global `DEFAULT_PERMISSION_CLASSES: [IsAuthenticated]`. The only `AllowAny` uses are the health-check endpoint and login, both of which correctly need to be public.
- **No hardcoded secrets in source**, and `.env` (which does hold real credentials on disk) is excluded via `.gitignore`.
- **Password hashing** uses strong modern algorithms (PBKDF2/Argon2/BCrypt) as the active hashers; the two legacy SHA-based hashers are verify-only for v1-imported accounts with auto-upgrade-on-login, not used for new passwords.

### Process note (not a vulnerability)
**No git repository exists yet** for this project (`git status` reports "not a git repository"). The `.gitignore` file is already correctly written to exclude `.env`, but it isn't protecting anything yet since nothing is under version control. Worth initializing git given the app now holds real data and changes frequently — version control is also the actual mechanism that would make the `.gitignore` secret-protection meaningful.

---

## Suggested priority order

The 3 High items and both Medium memory findings are now fixed (2026-08-07) — see the ~~strikethrough~~ headers above for what changed and how each was verified. **Remember to restart/rebuild both the Django container (for the `.env` change) and the frontend container (for every row-limit fix) for these to take effect** — a live crash report against `/nta` after this session's earlier passes was traced back to a stale, not-yet-rebuilt frontend rather than a residual bug (source already had the fix).

Also from the same follow-up batch: Sites Topology's map now defaults to loading zero site markers (map + sidebar only) until a scope is explicitly selected, cutting the single most expensive thing the app rendered on first load after login. Separately, a garbled/boxed Devanagari place-name label (near Annapurna) was investigated and found to be baked into OpenStreetMap's own raster tile images — not something any app code here renders or can correct; switching tile providers is the only lever, and its effect can't be verified from this environment.

Remaining, lower urgency: SECRET_KEY fallback, JWT refresh-token blacklist, HTTPS settings, JSON body size caps, and initializing git — worth scheduling as normal follow-up work rather than urgent fixes.
