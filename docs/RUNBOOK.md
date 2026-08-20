# BAGALEWATCH BTS v2 — Runbook

## What this is

The new Django + Node + Go + React stack, per `BAGALEWATCH_v2_Migration_Plan.md`
(in the v1 project folder). **Phase 0** (infra skeleton, all 4 services +
Postgres + Redis healthchecked) and **Phase 1** (Auth, Users, Permissions,
Sites/Sectors — read-only) are both built. See "Phase 1" section below for
what's new and, importantly, what's NOT yet verified on real hardware.

## Isolation guarantee — verified, not just planned

This stack never touches the v1 system. Concretely, as of Phase 0:

- **Different folder.** This whole tree lives at `bagalewatch-v2/` inside the
  v1 project folder, as a clearly separate subtree — not mixed into any v1
  file. (The migration plan describes a true sibling folder next to the v1
  project folder; that wasn't reachable from the tooling used to build this,
  so it's a subfolder instead. Functionally identical for the isolation
  guarantee: no v1 file is ever opened for writing, and every new file lives
  under this one directory.)
- **Different ports**, chosen to never collide with v1's 8080 (dashboard) /
  8081 (AI proxy):
  | Service | Port |
  |---|---|
  | Django API | 8000 |
  | Node real-time gateway | 8090 |
  | Go worker | 8070 |
  | React (nginx) | 5180 |
  | Postgres | 5432 |
  | Redis | 6379 |
- **Different database, always.** Postgres, entirely separate from
  `bagalewatch.db` (SQLite). Nothing in this stack ever opens that file
  directly at runtime.
- **The one script that touches v1 data is read-only, by construction.**
  `scripts/copy_and_inspect_legacy_db.py` takes a path to `bagalewatch.db`,
  makes a byte-for-byte copy (`shutil.copy2`, a plain filesystem read), and
  does everything else against the COPY, opened in SQLite's own read-only/
  immutable mode as a second layer of protection. **This was verified against
  the real production database on 2026-07-27**: source file SHA-256 checksum
  was identical before and after running the script. Output confirmed real
  data volume: 4,718 sites, 11,932 sectors, 118,162 drive-test records, 7
  drive-test sessions, 5 users, 74 role-permission rows, 20 KPI thresholds.

## Prerequisites — installing Docker and Go on Windows

Neither was available in the sandbox this was built in, so install both on
your own machine before running the verification steps below.

**Docker Desktop:**
1. Confirm hardware virtualization is enabled in BIOS/UEFI (Intel VT-x or
   AMD-V) and you're on Windows 10 21H2+ or Windows 11.
2. Open PowerShell **as Administrator** and run `wsl --install`, then
   restart Windows. This installs WSL2, which Docker Desktop uses as its
   backend (faster than the old Hyper-V backend, and works on Windows Home).
3. Download Docker Desktop from
   [docs.docker.com/desktop/setup/install/windows-install](https://docs.docker.com/desktop/setup/install/windows-install/)
   and run the installer — make sure "Use WSL 2 instead of Hyper-V" is
   selected.
4. Restart again if prompted, then launch Docker Desktop from the Start
   menu and let it finish starting (whale icon in the system tray turns
   steady, not animated).
5. Verify in a terminal: `docker --version` and `docker compose version`
   should both print a version number.

**Go:**
1. Download the Windows installer (`.msi`) from
   [go.dev/dl](https://go.dev/dl/) — get the latest `go1.2x.x.windows-amd64.msi`.
2. Run it and follow the prompts; the installer adds `go` to your PATH
   automatically.
3. Open a **new** terminal (PATH changes need a fresh shell) and verify:
   `go version`.

## Running it

Once both are installed, this is the "Action item before Phase 1" from
below — do this once, end to end, before Phase 1 work starts:

```powershell
cd bagalewatch-v2\backend-go
go build ./...          # first real compile check for the Go worker
```

```bash
cd bagalewatch-v2
cp .env.example .env                                   # fill in POSTGRES_PASSWORD
cp backend-django/.env.example backend-django/.env      # fill in SECRET_KEY, POSTGRES_PASSWORD (match .env)
cp backend-node/.env.example backend-node/.env
cp frontend-react/.env.example frontend-react/.env
docker compose up --build
```

Then (updated 2026-08-10 — see "Port-hiding / reverse-proxy architecture"
below: django/node-gateway/go-worker no longer publish host ports, so
`localhost:8000` etc. are NOT reachable from the host machine anymore):
- Django health (proxied): `curl http://localhost:5180/api/v2/health/`
- Django health (direct, container-internal): `docker compose exec django curl http://localhost:8000/api/v2/health/`
- Node gateway health (direct, container-internal): `docker compose exec node-gateway wget -qO- http://localhost:8090/health`
- Go worker health (direct, container-internal): `docker compose exec go-worker wget -qO- http://localhost:8070/health`
- React shell: open `http://localhost:5180` — it calls the health endpoints
  through the same nginx proxy and shows green/red status dots for each.

To stop: `docker compose down` (add `-v` only if you intentionally want to
wipe the v2 Postgres volume — this never affects v1's `bagalewatch.db`
regardless).

## What's verified vs. not (be honest about this)

The sandbox this was built in has no Docker, no Go toolchain, and no root
access — network access was also restricted to a small allowlist (npm
registry, PyPI, github.com all worked; go.dev and raw.githubusercontent.com
did not). Given that:

| Component | Verified how |
|---|---|
| Django app | **Fully run**: `pip install`, `manage.py check`, `manage.py migrate`, `runserver`, and a live `curl` against `/api/v2/health/` all succeeded (using a throwaway local SQLite DB for this smoke test only — production always uses Postgres per `settings.py`). |
| Node gateway | **Fully run**: `npm install`, started the server, hit `/health` over HTTP, and opened a real WebSocket connection to `/ws` and got the expected `welcome` + `echo` messages back. |
| React app | **Fully run**: `npm install`, `npm run build` succeeded, `npm run preview` served the built app and returned valid HTML on port 5180. |
| Go worker | **Compiled successfully** — `go build ./...` run on the user's real Windows machine on 2026-07-27, zero errors, zero output. (Needed `$env:GOFLAGS="-p=1"` to avoid a Windows "paging file too small" / out-of-memory error from the compiler's default per-core parallelism — a host memory-pressure issue, not a code issue.) **Also confirmed healthy as a running container** — see below. |
| docker-compose.yml | **Fully run end-to-end** — `docker compose up --build` on the user's real machine, 2026-07-27. All 6 containers (db, redis, django, node-gateway, go-worker, frontend) report `Up ... (healthy)`. Hit two real snags along the way, both fixed: (1) a corrupted `docker-desktop` WSL distro (`componentsVersion.json` missing) — fixed by unregistering `docker-desktop`/`docker-desktop-data` via `wsl --unregister` and letting Docker Desktop reprovision them; (2) Postgres credential/DB-name mismatch between the root `.env` and `backend-django/.env` (a typo — `bagalewatch` vs. the correct `bagalewatch_v2`) — fixed by aligning both files and `docker compose down -v` to force Postgres to reinitialize its named volume with the correct name. |
| Seed/inspect script | **Fully run against the real production `bagalewatch.db`**, see above — this is the most important one to have verified, since it's the one script allowed near v1 data. |

**Phase 0 is now fully verified end-to-end on the user's real machine, including the browser UI itself — no open action items.** `curl http://localhost:8000/api/v2/health/` returns `{"status":"ok","database":"ok"}`; node-gateway (8090) and go-worker (8070) health endpoints and `docker compose ps` all confirmed healthy; and opening `http://localhost:5180` shows the actual React shell with both live status checks green, on 2026-07-27. (Historical record — as of the 2026-08-10 port-hiding pass, ports 8000/8090/8070 are no longer published to the host; see the updated health-check commands above.)

Two more real bugs surfaced and fixed getting to that final green state:
- **Frontend served a 200 with an empty body** (`Content-Length: 0`, blank white page). Root cause: the `frontend` image had been built once during one of the earlier failed `docker compose up --build` attempts (BuildKit crash / WSL corruption) and Docker had cached a broken layer from that interrupted build. Fixed with `docker compose build --no-cache frontend`.
- **Node gateway showed "Failed to fetch" in the browser** despite `docker compose ps` correctly reporting it healthy — the container-internal healthcheck doesn't go through a browser, so it never hit CORS. The gateway had no `Access-Control-Allow-Origin` header at all, which browsers silently block. Fixed by adding a small CORS middleware to `backend-node/src/server.js` (no new dependency — just header-setting) and a new `CORS_ALLOWED_ORIGIN` env var (defaults to `http://localhost:5180`).

## Directory structure

```
bagalewatch-v2/
├── backend-django/     Django + DRF — API/auth/admin, owns the Postgres schema
├── backend-node/       Node.js — WebSocket real-time gateway
├── backend-go/         Go — TRP parsing + heavy processing (Phase 4/5)
├── frontend-react/     Vite + React + TS — the SPA
├── scripts/            Standalone tools, e.g. the read-only v1-data snapshot script
├── docker-compose.yml  Wires all six containers together
└── docs/
    └── RUNBOOK.md       this file
```

## Phase 1 — Auth, Users, Permissions, Sites (read-only)

Built 2026-07-27. Written blind (the sandbox's shell was down all session —
a genuine outage, not a network-allowlist limit) then verified step by step
on the user's real machine, same day. **Backend is now fully verified
end-to-end:**
- `manage.py check` / `makemigrations` / `migrate` / `test core` — 10/10
  tests pass, including the legacy-password-hasher upgrade-on-login test
  and the permission-shape serializer test.
- `seed_legacy_data` run against the real production `bagalewatch.db` —
  imported 5 users, 4,718 sites, 11,932 sectors, 74 permission rows,
  matching Phase 0's inspect-script counts exactly. Along the way, fixed
  two real data-quality bugs the sandbox review missed: (1) some numeric
  columns (e.g. `sectors.local_cell_id`) hold `''` instead of `NULL` in
  the real SQLite data — added a `_num()` coercion helper; (2)
  `django.utils.timezone.utc` doesn't exist in Django 5.x — switched to
  `timezone.make_aware(dt)`'s default (already UTC per settings).
- Live login over the real API: `puru`/superadmin logged in successfully
  with real production credentials, received valid JWT access/refresh
  tokens, and the legacy hash was confirmed upgraded — proving the
  upgrade-on-login mechanic works against real data, not just the
  synthetic unit test.
- `GET /api/v2/sites/` returns all 4,718 real sites with correct fields
  (confirmed against a real site, `KTM422` in Lalitpur).
- Confirmed (and expected, not a bug): a real superadmin's `/auth/me/`
  response has `permissions: {}` — v1 never stores explicit
  role_permissions rows for superadmin, it's an implicit-full-access
  bypass role. Found this would have been a landmine for Phase 2's UI
  gating (empty map read as "deny all"), so `isAllowed()` in
  `frontend-react/src/api/types.ts` now takes `role` and special-cases
  superadmin — fixed before it could bite, not after.

**React build is now confirmed too**: `npx tsc -b` (zero errors) and
`npx vite build` (139 modules, valid `dist/` output) both succeeded on the
user's real machine, 2026-07-27. Real, non-code issues hit and fixed along
the way (Windows-specific, worth knowing for next time):
- Node.js's optional "Tools for Native Modules" installer step launched
  Visual Studio Installer, which failed on network connectivity —
  unnecessary for this project (no native npm deps), safe to skip/cancel.
- `npm`/`venv\Scripts\activate` both failed with `PSSecurityException` —
  Windows PowerShell's default execution policy blocks local `.ps1`
  scripts. Fixed once for the whole account: `Set-ExecutionPolicy -Scope
  CurrentUser -ExecutionPolicy RemoteSigned`.
- `npm install` failed with `ERESOLVE` — `react-leaflet-cluster@2.1.0`
  declares a peer dep on `react@^18`, this project is on `react@19`.
  Fixed with a `frontend-react/.npmrc` containing `legacy-peer-deps=true`
  (applies to every future `npm install`, local or in the Docker build,
  not just a one-off flag to remember).
- `npm run build` failed two different ways because the project folder's
  name contains `O&M` — `cmd.exe` (npm's default Windows script shell)
  splits unquoted `&` as a command separator, breaking the whole command
  line. Switching npm's script-shell to `powershell.exe` fixed that but
  broke `&&` chaining (Windows PowerShell 5.1 doesn't support it — that's
  a PowerShell 7+ feature). Net fix: just run `npx tsc -b` then
  `npx vite build` as two separate commands instead of via `npm run
  build`'s `&&`-chained script.

**Not yet confirmed:** the full `docker compose up --build` with the
Phase 1 code included (Phase 0 verified the skeleton container-by-container;
Phase 1 added real routes/migrations/npm deps since then, so worth one
more full-stack run before calling Phase 1 completely done).

**What's new:**
- **Custom Django `User` model** (`core/models.py`) — adds `role`
  (superadmin/admin/viewer), `name`, `dept` on top of Django's built-in
  auth.
- **Legacy password compatibility** (`core/hashers.py`) — v1's hand-rolled
  PBKDF2 format (`pbkdf2_sha256$iter$salt-hex$digest-hex`) looks like
  Django's own format but isn't (Django uses base64, v1 uses hex) and both
  use the same `pbkdf2_sha256` algorithm tag, which would collide. The fix:
  the seed script rewrites the tag to `bagalewatch_legacy_pbkdf2` on
  import, routing Django's hasher lookup to a custom verifier class that
  is NOT the preferred hasher — so a successful legacy login triggers
  Django's own built-in upgrade-on-login mechanism for free (no custom
  code needed beyond the hasher itself). A second hasher covers the older
  `sha256:<hex>` format for completeness.
- **`Site`, `Sector`, `MenuPermission` models** — field-for-field close to
  v1's real schema (confirmed against production `bagalewatch.db` in
  Phase 0: 4,718 sites / 11,932 sectors / 74 permission rows). Deeper
  normalization of the per-tech KPI JSON blobs into a real `SectorKpi`
  table is deferred to Phase 3 (the reporting suite), per the migration
  plan — Phase 1 only needs to read and display these values.
- **JWT auth**, not session cookies — the decision the migration plan (§9)
  flagged as "make at the start of Phase 1." Chosen because the React app
  and Django API are different origins (ports 5180/8000): a bearer token
  avoids the CSRF + `SameSite` cookie complexity a cross-origin SPA would
  otherwise need for local http dev. Access tokens are short-lived (15
  min) with silent refresh; true idle-timeout (mirroring v1's 5-minute
  inactivity logout) is enforced client-side in `AuthContext.tsx`.
  Tokens live in memory only (not localStorage), so a hard page refresh
  logs the user out — an accepted trade-off, not a bug.
- **`seed_legacy_data` management command** — same copy-first,
  read-only-immutable-mode pattern as `copy_and_inspect_legacy_db.py`,
  now actually importing users/sites/sectors/permissions into the v2
  schema via the Django ORM (`bulk_create`, batched).
- **React**: login page, JWT-aware API client with auto-refresh, a
  virtualized (TanStack Virtual) read-only Province → District → Site
  sidebar tree, a clustered Leaflet map (`react-leaflet` +
  `react-leaflet-cluster`), and a site detail page (KPIs + sectors table).
  TanStack Query for server state, Zustand for the tree's open/closed UI
  state — per §5 of the migration plan.

**What to actually run, in order, on your real machine — this is the
verification Phase 0 got and Phase 1 still needs:**

1. **Django checks + migrations (SQLite smoke test, same pattern as Phase 0):**
   ```powershell
   cd bagalewatch-v2\backend-django
   python -m venv venv
   venv\Scripts\activate
   pip install -r requirements.txt
   $env:DJANGO_DB_ENGINE="sqlite"
   $env:SECRET_KEY="dev-only"
   python manage.py check
   python manage.py makemigrations core
   python manage.py migrate
   python manage.py test core
   ```
   The `test core` run is the one that matters most here — it exercises the
   legacy-hasher upgrade-on-login logic and the permission-shape serializer
   against a real (throwaway SQLite) database, not just static review.

2. **Seed real data and smoke-test the API:**
   ```powershell
   python manage.py seed_legacy_data "..\..\..\bagalewatch.db"
   python manage.py runserver
   ```
   In another terminal:
   ```powershell
   curl -X POST http://localhost:8000/api/v2/auth/login/ -H "Content-Type: application/json" -d '{\"username\":\"superadmin\",\"password\":\"<real password>\"}'
   # copy the "access" token from the response, then:
   curl http://localhost:8000/api/v2/sites/ -H "Authorization: Bearer <access token>"
   curl http://localhost:8000/api/v2/auth/me/ -H "Authorization: Bearer <access token>"
   ```
   Confirm the site count matches the real number (4,718) and `permissions`
   in the `/auth/me/` response has the expected shape (booleans for simple
   menus, `{read,write,update,delete}` dicts for CRUD menus).

3. **React build:**
   ```powershell
   cd bagalewatch-v2\frontend-react
   npm install
   npm run build
   ```
   This is the step most likely to surface a real problem — `react-leaflet`
   v5 + `react-leaflet-cluster` version compatibility and the strict
   `verbatimModuleSyntax` TypeScript setting were both hand-reviewed but
   never compiled. If `npm run build` fails, paste the error — most likely
   fixes are a version pin adjustment or a missed `import type`.

4. **Full stack**, once 1–3 pass individually:
   ```powershell
   cd bagalewatch-v2
   docker compose up --build
   ```
   Then log in at `http://localhost:5180` with a real account and confirm
   the sidebar tree, map markers, and a site detail page all show real data.

Report back whatever happens at each step (success or the actual error
text) — same iterative loop that got Phase 0's Docker/Go verification to
fully green.

### Bug found + fixed: sidebar tree grouped under stale legacy region names

Found 2026-07-27, right after the first successful full-stack login: the
React sidebar tree showed hundreds of sites grouped under legacy region
names ("Central", "Mid-West > Western") instead of grouping cleanly by
region, while v1's tree groups correctly for the same sites.

**Root cause:** v1's `sites.region` DB column is stale/inconsistent for a
meaningful fraction of rows, and `seed_legacy_data.py` copied it as-is.

**First fix attempt (wrong target, reverted):** initially ported v1's
`_SITE_REGION_MAP` (a site_id → one of the 7 modern federal provinces
lookup, 4,702 entries, embedded as a single ~145KB line in
`bts_monitor.html`) into the seed script. Extraction worked correctly
(confirmed live: 7 distinct provinces, counts matching the source data —
Bagmati 1223, Gandaki 821, Karnali 255, Lumbini 588, Koshi 754, Madhesh
565, Sudurpashchim 496), but the user clarified this is the wrong
scheme entirely: **v1's sidebar tree does not group by the 7 modern
provinces at all.** It groups by NTC's 5 traditional operational regions
— Central / Eastern / Western / Mid-West / Far-West — determined purely
by site ID prefix, with `KTM`-prefixed sites (Kathmandu/Lalitpur/
Bhaktapur) folded into Central despite not sharing the `CDR` prefix.
District-level grouping underneath each region is unaffected — v1 already
derives `district` from GPS coordinates and that value was never wrong.

**Actual fix:** `seed_legacy_data.py` now has `_region_from_site_id()` —
a small deterministic prefix table (`CDR`→Central, `EDR`→Eastern,
`WDR`→Western, `MWDR`→Mid-West, `FWDR`→Far-West, `KTM`→Central), all 6
prefixes confirmed present in the real `bts_monitor.html` data via
targeted `Grep` before writing the rule. `Site(...)`'s `region` field is
now `_region_from_site_id(r['id']) or r['region'] or ''` — falls back to
the raw column value only for an unrecognized prefix (never worse than
before this fix), and the command prints a warning listing any site IDs
that fell through, so a future data-quality surprise won't be silent.

The earlier `_SITE_REGION_MAP` extraction script
(`bagalewatch-v2/scripts/extract_site_region_map.py`) is left in the repo
but is **not** wired into the seed command anymore — its docstring now
says so explicitly, in case a future feature genuinely needs the
site_id → current-province mapping it produces.

**Confirmed live, 2026-07-27:** rebuilt the django image (the container
doesn't volume-mount `backend-django`'s source, so the first re-seed
attempt after this fix silently ran stale pre-fix code — worth
remembering for any future Docker-side code change), re-seeded via
`docker compose exec django python manage.py seed_legacy_data
/host-data/bagalewatch.db --wipe` (5 users / 4,718 sites / 11,932 sectors
/ 74 permissions, no "unrecognized prefix" warning — all site IDs matched
one of the six known prefixes cleanly), hard-refreshed the browser, and
the sidebar tree now correctly shows only Central / Eastern / Western /
Mid-West / Far-West at the top level. User confirmed WDR005 and the
CDR/Bara sites now group correctly. Some sites show under "Unassigned"
(district-level, not region) — a separate, smaller, deferred item, not
part of this bug.

---

## Phase 2 — Full CRUD parity (backend + frontend build-verified; live click-through in progress)

Built 2026-07-27, same session as the region-mapping fix. Scope per the
migration plan's §6: site/sector editing, KPI threshold management, tree
structure management, user/permission admin. Sandbox shell was
unavailable the entire session this was written in (same "Workspace
unavailable" failure as earlier sessions), so it was all self-reviewed
by re-reading rather than compiled at the time — same caveat as every
"written blind" phase in this project. Backend and frontend build steps
have since both been confirmed on the real machine (see below); live
UI click-through is what caught the sequence-reset bug documented below.

**Design approach:** every new write endpoint mirrors v1's actual
contract shape exactly (confirmed by reading `bagalewatch_api.py`'s real
route handlers line by line before writing any Django code), not a
"cleaner" generic REST redesign:
- `/sites/` (POST/PUT/DELETE) — site update always fully replaces the
  site's sector list from the payload (delete all, recreate), matching
  `_upsert_site`. POST accepts a single object or a list. The URL's site
  ID is authoritative on PUT even if the body sends a different one (a
  model instance's pk can't be safely "renamed" via `setattr` + `save()`
  in Django — it silently touches the wrong row instead of raising —
  so `SiteWriteSerializer.update()` explicitly drops any `id` in the
  body and the view forces the URL's ID into the data before validation).
- `/thresholds/` (GET/PUT) — flat `{kpi_key: {warn,crit,hi,max,unit}}`
  dict. PUT **upserts only the keys present in the body** — not a full
  delete-and-replace, matching v1's `ON CONFLICT DO UPDATE` exactly.
- `/tree/` (GET/PUT) — `{folders, assignments, active}`. PUT **is** a
  full delete-and-rebuild (folders/subfolders/assignments/settings all
  cleared and recreated from the payload every time), matching
  `_set_tree_state` exactly. Assignments referencing an unknown site ID
  are silently skipped, not rejected — same as v1.
- `/users/` (full CRUD) — read: superadmin or admin; write: superadmin
  only, matching v1's role checks precisely (Phase 1 had read as
  superadmin-only, which was actually *stricter* than v1 — loosened to
  match here). New accounts get Django's native password hasher via
  `set_password()`; the Legacy* hashers stay reserved for imported v1
  accounts only.
- `/permissions-matrix/` (new, GET/PUT) — nested `{role: {menu_key: bool
  | {read,write,update,delete}}}`, excluding `superadmin` (v1 never
  stores permission rows for it — implicit full access). PUT is a
  per-key upsert, matching `_write_role_perm` exactly. The existing flat
  `/permissions/` ViewSet from Phase 1 is untouched, kept for
  inspection/debugging — the React permission editor should use the new
  matrix endpoint instead, since it's the one that actually matches v1's
  UI data flow.

**New models** (`core/models.py`): `KpiThreshold`, `TreeFolder`,
`TreeSubfolder`, `SiteAssignment`, `TreeSettings` — schema confirmed
field-for-field against `bagalewatch_api.py`'s `SCHEMA_SQL` (thresholds /
tree_folders / tree_subfolders / site_assignments / tree_settings
tables). `SiteAssignment.folder_id`/`subfolder_id` are deliberately plain
`CharField`s, not `ForeignKey`s — v1's own schema doesn't declare them as
`REFERENCES` either, and modeling them as real FKs here would reject data
v1 itself tolerates (a dangling folder_id), which would be a parity
regression dressed up as a data-integrity improvement.

**Seed script extended** (`seed_legacy_data.py`) to also import
thresholds/tree_folders/tree_subfolders/site_assignments/tree_settings,
with the same defensive skip-and-warn behavior as the existing
site/sector import (dangling subfolder→folder or assignment→site
references are skipped and counted, not fatal).

**Tests added** (`core/tests.py`, `SiteWriteEndpointTests` /
`ThresholdsEndpointTests` / `TreeEndpointTests` / `UserAdminEndpointTests`
/ `PermissionsMatrixEndpointTests`) — using DRF's `APIClient` +
`force_authenticate()`, covering: role-gate enforcement on every write
endpoint (a viewer must get 403, not silently succeed), the "full
replace, not merge" contract for site-sectors and tree, the "upsert only
provided keys" contract for thresholds and permissions, the PUT-body-`id`
safety fix, and that new-user passwords land in Django's native hasher
format (not a Legacy* one). **Not yet run** — same caveat as everything
else this phase.

**To verify (same pattern as every prior phase — run on the real
machine, report back the actual output):**
```powershell
cd bagalewatch-v2\backend-django
python manage.py makemigrations core
python manage.py migrate
python manage.py test core
```
`makemigrations` is the one genuinely new step here (Phase 1's models
were already migrated) — review the generated migration file before
`migrate` if anything looks unexpected (e.g. an unwanted column drop).

Then re-seed to get real threshold/tree data to test the new endpoints
against:
```powershell
python manage.py seed_legacy_data <path to bagalewatch.db> --wipe
```
Watch for the new "KPI thresholds: N imported" / "Tree folders: N
imported" / "Tree subfolders: N imported" / "Site tree assignments: N
imported" lines, and any "skipped" warnings.

If running the full Docker stack, remember the container-rebuild lesson
from the region-mapping fix: `docker compose build django` before
re-seeding, or the container will run stale pre-Phase-2 code.

React work (site/sector edit forms, threshold management UI, tree
editor, user/permission admin UI) starts only after this backend is
confirmed working — same "verify before building on top" discipline as
every prior phase.

**Backend confirmed working, 2026-07-27** — `makemigrations core` /
`migrate` / `test core` / `seed_legacy_data --wipe` all ran clean on the
real machine.

**React frontend built and build-verified, 2026-07-27** — `SiteDetailPage`
edit mode, `ThresholdsPage`, `TreeAdminPage` (standalone, not wired into
the read-only `SidebarTree`), `UsersPage`, `PermissionsPage`, plus nav
links gated by `isAllowed()`. `npx tsc -b` and `npx vite build` (run as
two separate commands — this project's folder name contains `O&M`, which
breaks npm's `&&` chaining on Windows) both came back clean: 140 modules,
no type errors.

**Bug found + fixed: `POST /api/v2/users/` returned HTTP 500** — live
click-through caught this (editing/deleting the 5 real seeded users
worked fine; creating a brand-new user failed). Root cause:
`seed_legacy_data.py` imports `User` and `Sector` rows with explicit
`id=r['id']` values copied from v1's SQLite database, and both `User.id`
and `Sector.id` are standard Django `AutoField`s. On Postgres, an
explicit-PK `INSERT` does not advance the table's backing sequence, so
the next row created *without* an explicit id (a brand-new user via the
admin UI, or eventually a new sector) collides with an already-used low
id and fails with an uncaught `IntegrityError` → opaque 500. This is the
same SQLite-vs-Postgres discrepancy class as the password-hash
`max_length` bug above — sqlite has no persistent sequence counter, so
`test core` never could have caught it. Fixed by resetting both
sequences at the end of the seed command via Django's own
`connection.ops.sequence_reset_sql(no_style(), [User, Sector])`, which is
a documented no-op on SQLite (safe for the existing test suite). Also
fixed, while investigating: every write page (`UsersPage`,
`SiteDetailPage`, `ThresholdsPage`, `TreeAdminPage`, `PermissionsPage`)
had a generic hardcoded catch-block message that hid the real API error
— replaced with a shared `apiErrorMessage()` helper (`api/client.ts`)
that surfaces the actual DRF error body, which is what revealed this bug
in the first place instead of the misleading "username may already be
taken."

**To apply the sequence fix:** `docker compose build django` (source
isn't volume-mounted), then re-seed with `--wipe`, then retry creating a
user from the Users page. Rebuild the frontend (`tsc -b` + `vite build`)
to pick up the improved error messages.

**Two beyond-v1-parity additions, 2026-07-27 (both explicitly confirmed
with the user during live click-through, not built silently):**

1. **KPI threshold delete.** v1's `/thresholds` PUT is upsert-only — there
   was never a way to remove a key at all. Added `ThresholdDetailView`
   (`DELETE /api/v2/thresholds/<kpi_key>/`, gated the same as PUT:
   superadmin or admin) plus a Delete button per row in `ThresholdsPage.tsx`
   (`useDeleteThreshold` in `api/queries.ts`).

2. **Arbitrary-depth folder nesting.** v1's tree is a fixed 2-level
   hierarchy (`tree_folders` → `tree_subfolders`). `TreeFolder` now
   self-references via `parent` (any depth), absorbing `lat`/`lng` from
   the retired `TreeSubfolder` model. `SiteAssignment` collapsed its
   `folder_id`+`subfolder_id` pair into a single `folder_id` (still a
   plain `CharField`, not a hard FK — preserves the original "tolerate
   dangling refs" decision). `TreeFolderSerializer` is now recursive
   (`children` via `SerializerMethodField`). `TreeView`'s GET/PUT rebuilt
   for the recursive shape; PUT creates nodes depth-first so a child's
   `parent` is always already saved. `seed_legacy_data.py`'s tree import
   flattens v1's 2-level source data into the new single recursive table
   (top-level folders get `parent=None`, subfolders become
   `TreeFolder` rows whose `parent` is the folder they belonged to — same
   ids preserved, so no id-translation table needed; an assignment's
   effective folder is `subfolder_id or folder_id` from the source row).
   `TreeAdminPage.tsx` rewritten with a recursive `FolderNode` renderer,
   "+ Subfolder" at any depth, and a single depth-indented dropdown for
   site assignment (replacing the old two-dropdown folder+subfolder
   picker). **This is a genuine schema change** — needs a fresh
   `makemigrations core` + `migrate` on top of the sequence-fix rebuild,
   then `--wipe` re-seed (existing tree data doesn't carry over; sites,
   users, thresholds etc. are unaffected).

Fix/verify this on the real machine: `docker compose build django` (if
not already done for the sequence fix) → `makemigrations core` →
`migrate` → `test core` (the `TreeEndpointTests` regression test now
exercises 3 levels of nesting specifically) → re-seed `--wipe` → rebuild
frontend (`tsc -b` + `vite build`) → retry the tree/threshold flows.

**Sequence-reset fix confirmed live, 2026-07-27** — after rebuilding
`django` and re-seeding with `--wipe` (seed output showed "Reset
Postgres auto-increment sequences for User/Sector"), creating and
deleting a test user from the Users page both succeeded. (Getting to
this point also required an unrelated Docker Hub connectivity fix — the
user's regular network was blocking outbound HTTPS to
`registry-1.docker.io`/`auth.docker.io` entirely; building over a mobile
hotspot worked immediately, confirming it was a network/firewall issue,
not Docker or the code.)

Still open on the live click-through list: site/sector edit (add/remove
a sector — this exercises `_replace_sectors()`, the other place Sector
rows get created without an explicit id, so worth specifically confirming
the sequence fix covers it), KPI threshold edit, tree folder + site
assignment management, permission matrix edit.

---

## Phase 3 — Reporting suite (all six built: SLA, NTA, Monthly, Scatter, KPI Trend, RF Audit)

Started 2026-07-27 after explicit user go-ahead ("Start Phase 3: reporting
suite"). Scope split from the migration plan's §6: SLA Tracker, NTA
Compliance, and Monthly Report need no new data model (`core/reports.py`,
pure query + aggregation over the existing `Site` table). Scatter Plot is
blocked on a pre-existing schema gap (`rssi`/`load` missing from `Site` —
task #38). KPI Trend and RF Audit both need new models
(`KpiSnapshot`/`AuditHistory`) and are scoped for their own modules, not
`reports.py`.

**SLA Tracker** (`GET /api/v2/sla/?region=`) — ported from v1's
`siteSlaScore()`/`SLA_TARGETS` (bts_monitor.html ~8355). Per-site weighted
score across 7 KPIs; a site missing some KPI values is scored only on
what it has (not penalized for absent data). Confirmed live by the user
for All-Nepal/Central/Mid-West; Eastern showed 0 sites, which reflects
that region's real seeded KPI data (`kpi_entered=True` filter), not a
bug — no site in that region currently has KPIs entered.

**NTA Compliance** (`GET /api/v2/nta/?pane=all-sites|violations`) — ported
from v1's `renderNtaReport()`/`ntaCheck()`/`NTA_THRESHOLDS`
(bts_monitor.html ~12399). **Corrected after initial build, before user
re-verification**: v1's `ntaCheck()` has a `v===undefined → pass` branch
that looks like "missing data auto-passes," but v1's site objects always
carry every KPI key (`null`, never absent — confirmed by tracing
`_site_row_to_dict()`'s `dict(row)` and `sitesResp.sites.forEach(...)` in
bts_monitor.html), so that branch never actually fires against real data.
What actually governs missing-data sites is JS's `null → 0` numeric
coercion: a `hi:true` KPI (needs to be ≥ a minimum) reads missing data as
**FAIL**, a `hi:false` KPI (needs to be ≤ a maximum) reads it as
**PASS**. `core/reports.py`'s `nta_check()` now replicates that real
behavior (`v = value if value is not None else 0`), not the misleading
dead branch. **Practical effect the user should know before re-checking
NTA**: any site with incomplete KPI data will now show more "hi:true"
violations (e.g. missing RRC/E-RAB/HO/throughput data now correctly
fails those checks) than it did in the version confirmed live on
2026-07-27 — this is a bug fix, not a regression, but it changes the
violation counts.

**Monthly Report** (`GET /api/v2/monthly-report/?month=&style=&region=`)
— ported from v1's `generateMonthlyReport()` (bts_monitor.html
~12664-12738), returns a markdown document (not a data table), rendered
client-side via a new minimal `lib/markdown.ts` (headers, tables, lists,
bold, hr — v1's own `markdownToHtmlSimple()` never rendered `|...|`
tables at all despite the report being full of them; this is a real,
harmless display improvement, not a data change). `style` is
executive/board/technical (board omits worst/best-5 sections, technical
adds a regional breakdown section) — same as v1. `month` is a label only:
v1 has no time-series storage, so every month picked produces an
identical report from the current snapshot; this is a faithful port of
v1's actual (limited) behavior, not wired up to the future `KpiSnapshot`
model. One deliberate deviation from a literal port: v1's worst/best-site
tables call `.toFixed(1)` directly on KPI fields with no null check,
which throws in the browser for a site with no KPI data landing in the
top/bottom-5; `_fmt1()` renders `—` instead of crashing the request.

**Confirmed live, 2026-07-28** — SLA, NTA, and Monthly Report all
verified on the real machine. The `nta_check()` correction above was
explicitly communicated to the user and re-confirmed ("nta looks right").
Monthly Report initially 404'd — same recurring "django has no source
volume mount" gotcha (the route was added after the last `docker compose
build django`) — fixed by rebuilding, not a code issue.

### Fix: `rssi`/`load` missing from the `Site` model (task #38)

Found during Phase 3 research: v1's real `sites` table has `rssi REAL,
load REAL` columns (`bagalewatch_api.py`'s `SCHEMA_SQL`), needed for
Scatter Plot's `SCATTER_KPIS` list (bts_monitor.html ~12785), but they
never made it into v2's Django `Site` model during Phase 1 despite that
model's docstring claiming a field-for-field port. Fixed 2026-07-28:
`Site.rssi`/`Site.load` (nullable `FloatField`s) added to
`core/models.py`, `seed_legacy_data.py`'s Site import now copies both
columns, `SiteDetail`/`SiteWrite` in the frontend `types.ts` gained both
fields (picked up automatically server-side via `SiteDetailSerializer`'s
`fields = '__all__'`). Deliberately **not** added to `SiteListSerializer`
(stays lightweight for the ~4,700-row sidebar) or to
`SiteDetailPage.tsx`'s manual-entry `KPI_FIELDS` list — v1 has no manual
rssi/load entry field either (they come from CSV/data import, not the
site edit form), so leaving them out of the edit UI is parity, not an
omission. New regression test
`SiteWriteEndpointTests.test_rssi_and_load_persist_and_appear_in_detail`.
**This is a genuine schema change** — needs a fresh `makemigrations core`
+ `migrate` and a `--wipe` re-seed to pick up real rssi/load values from
production data.

**Not yet handed off for verification** — needs, on the real machine:
```powershell
docker compose build django
docker compose exec django python manage.py makemigrations core   # expect one new migration, adding rssi/load to Site
docker compose exec django python manage.py migrate
docker compose exec django python manage.py test core
docker compose exec django python manage.py seed_legacy_data <path to bagalewatch.db> --wipe
```
then frontend: `npx tsc -b` && `npx vite build` (as two separate
commands, per the `O&M`-folder-name npm caveat above).

### Scatter Plot (task #35)

Built 2026-07-28, right after the rssi/load fix it was blocked on. Unlike
SLA/NTA/Monthly Report, v1's Scatter Plot does **no server-side
aggregation at all** — `renderScatterPlot()` (bts_monitor.html
~12809-12921) draws straight to a `<canvas>` from the client's in-memory
site list (axis scaling, linear regression, Pearson correlation, hover
tooltip, click-to-select all computed in the browser). So the port splits
the same way: `GET /api/v2/scatter/` (`core/reports.py`'s
`build_scatter_data()`/`ScatterDataView`) only hands over the 12
`SCATTER_KPIS` values per site via a new `SiteScatterSerializer` (deliberately separate from the
lightweight `SiteListSerializer` used by the ~4,700-row sidebar, so that
endpoint doesn't get heavier) plus the
`REGION_COLORS` palette (ported as-is — v2's `Site.region` already holds
the same 5 traditional NTC regions the palette is keyed by, per the
Phase 1 region-mapping fix). All the chart math — regression, r,
tooltip, click nav — lives client-side in the new
`frontend-react/src/pages/ScatterPlotPage.tsx`, a faithful line-for-line
port of v1's canvas code. Status-based point coloring reuses the same
`/api/v2/thresholds/` data `ThresholdsPage` already edits, via a small
snake_case→camelCase key map (`rrc`→`rrc`, `call_drop`→`callDrop`, etc.)
since v1's threshold keys are camelCase but v2's `Site` fields are
snake_case. One deliberate adaptation, not a v1 feature gap: clicking a
point navigates to `/sites/:id` instead of v1's sidebar-tree-select,
since v2's admin-style UI has no equivalent sidebar-select concept on
this page. New test `ScatterDataEndpointTests` confirms the endpoint is
reachable and returns all 12 KPIs including rssi/load. Route `/scatter`,
nav link gated by `user.permissions.scatter` (confirmed a real menu key
in v1's `DEFAULT_PERMS` during Phase 3 research). **Not yet verified** —
needs the same rssi/load migration above, then `tsc -b` + `vite build`,
then click through `/scatter` (try a few KPI pairs, both color modes,
hover, and click-to-navigate).

### KPI Trend (task #36) — real history only, never fabricated

Built 2026-07-28, right after Scatter Plot. This is the item flagged
during Phase 3 research as needing its own new model: v1's KPI Trend
(bts_monitor.html ~12184-12391) has an IndexedDB store
(`netwatch_trend_db`) for real daily snapshots, but the function that
would populate it, `saveDailySnapshot()`, is never actually called — its
own code comment says "Daily snapshot interval removed (no live feed)".
So `renderTrendCharts()` almost always finds fewer than 3 real snapshots
and falls back to `buildSimulatedHistory()`, a `Math.random()`-driven
fake trend line. Per this project's "never fabricate data" rule, the
user explicitly chose (2026-07-28, via AskUserQuestion) to build real
history instead and show "not enough data yet" when it's thin.

**New model** `KpiSnapshot` (`core/models.py`) — one row per site per
day, all 16 of v1's `DAILY_KPI_KEYS` as snake_case fields, unique
constraint on `(site, date)`. **New management command**
`take_kpi_snapshot` — copies every site's current KPI values into
today's snapshot row, `update_or_create` so re-running the same day is
safe. **This stack has no scheduler container yet** (that's Phase 6
real-time infra) — schedule it externally for now:

```powershell
# Windows Task Scheduler, daily trigger, action:
docker compose exec django python manage.py take_kpi_snapshot
```

or via cron on a Linux host running the stack:
```
0 1 * * * cd /path/to/bagalewatch-v2 && docker compose exec -T django python manage.py take_kpi_snapshot
```

**New module `core/kpi_trend.py`** (deliberately not `reports.py` — see
that file's own docstring on the "no new model" split) —
`build_kpi_trend(site_id, days)` / `KpiTrendView`
(`GET /api/v2/kpi-trend/?site=&days=7|30|90`). Below
`MIN_SNAPSHOTS_FOR_TREND` (3, matching v1's own `snaps.length<3`
fallback threshold — reused as the "not enough data" cutoff, just
without the fabrication fallback on the wrong side of it) it returns
`has_enough_data: false` and an empty `series` — never a synthesized
trend. Six category tabs (overview/accessibility/retainability/
mobility/integrity/utilization) ported from v1's `catMap` exactly.

**New frontend** `KpiTrendPage.tsx` — site selector, 7/30/90-day period
buttons, category tabs, one mini canvas chart per KPI (line + fill +
warn/crit threshold dashes + status-colored dots + date labels), a
faithful port of v1's `drawTrendCanvas()`. Renders a "not enough
historical data yet (N/3 snapshots)" message instead of a chart when
`has_enough_data` is false. Status-coloring's snake_case→camelCase
threshold-key lookup was factored into a new shared
`lib/kpiThresholdStatus.ts` (`KPI_THRESHOLD_KEY`/`kpiStatus`/
`kpiStatusColor`) — **ScatterPlotPage.tsx was refactored to use this
shared helper too**, replacing its own local copy of the same mapping,
so the two reports can't drift apart on how they read `/api/v2/thresholds/`.
Route `/kpi-trend`, nav link gated by `user.permissions.kpitrend`
(confirmed real menu key during Phase 3 research). New tests
`TakeKpiSnapshotCommandTests` (idempotent re-run) and
`KpiTrendEndpointTests` (missing/unknown site, below/at-threshold data,
days filter).

**Not yet verified** — needs, on top of the rssi/load migration:
```powershell
docker compose exec django python manage.py test core
```
A single `take_kpi_snapshot` run only produces 1 snapshot per site, and
`/kpi-trend` needs 3 before it'll show a chart instead of "not enough
data yet". For a fast manual check without waiting 3 real days, backfill
using `--date` (records real current KPI values, just filed under an
earlier date — never fabricates the numbers themselves):
```powershell
docker compose exec django python manage.py take_kpi_snapshot --date=2026-07-26
docker compose exec django python manage.py take_kpi_snapshot --date=2026-07-27
docker compose exec django python manage.py take_kpi_snapshot   # today, no --date
```
Then `tsc -b` + `vite build`, click through `/kpi-trend` (should now show
real charts for at least one site — pick one that has KPI data entered).

### Two real bugs found during this verification pass, both fixed, 2026-07-28

1. **`seed_legacy_data --wipe` crashed with `NameError: name 'TreeSubfolder' is not defined`.**
   Leftover from the arbitrary-depth tree redesign (Phase 2) — the
   `TreeSubfolder` model was deleted, but a
   `TreeSubfolder.objects.all().delete()` call in the `--wipe` block was
   never cleaned up, and `--wipe` apparently had never actually been run
   end-to-end since that redesign landed (it kept failing earlier for
   unrelated reasons — path issues, stale images — before ever reaching
   this line). Fixed: removed the dead call; `TreeFolder.objects.all().delete()`
   alone already clears every folder at every depth via its
   self-referencing `on_delete=CASCADE`.

2. **Two `NtaReportEndpointTests` failed** (`test_warn_band_is_percentage_of_limit`,
   `test_violations_pane_excludes_passing_sites`) — **not a regression in
   `reports.py`**, confirmed by reading both the test fixtures and the
   current `nta_check()` logic side by side. Both tests predate the
   `nta_check()` null-coercion correction (documented above) and only set
   *one* NTA KPI field on their test sites (e.g. just `rrc`). Under the
   corrected logic, every other unset `hi:true` field now correctly
   fails too (that's the whole point of the fix), so a site meant to
   represent "only rrc is in the warn band" or "this site passes
   everything" was actually failing on its other unset hi:true fields
   (`erab`, `call_setup`, `intra_ho`, `inter_ho`, `ip_thru`,
   `cell_avail`) — the tests just hadn't been updated to account for
   that. Fixed by setting all seven hi:true fields to comfortably-passing
   values on these fixture sites, isolating the one field each test
   actually means to exercise.

**Re-run after both fixes:**
```powershell
docker compose build django
docker compose exec django python manage.py migrate
docker compose exec django python manage.py test core
docker compose exec django python manage.py seed_legacy_data /host-data/bagalewatch.db --wipe
```

### The real root cause behind this whole verification saga: migrations made inside the container never persisted

Found 2026-07-28, after the two fixes above still didn't resolve `migrate` alternating between "no migrations to apply" and failing to apply a migration that live-schema evidence showed had never actually run. Root cause: **the `django` service has no source bind mount** (by design — see docker-compose.yml, only the read-only `bagalewatch.db` mount exists). So `docker compose exec django python manage.py makemigrations core` writes the new migration file *only into that specific container's ephemeral writable layer* — it is invisible to the host filesystem and to every future `docker compose build`, and is silently lost the moment that container is recreated (which happened repeatedly during this troubleshooting session, each time via a different fix attempt). Confirmed directly: after `makemigrations` reported generating `0004_remove_siteassignment_subfolder_id_site_load_and_more.py`, `Glob`-ing the actual host `core/migrations/` folder showed only `0001`–`0003` — `0004` genuinely did not exist outside that container.

**Fix:** the migration was hand-written directly to the host source tree (matching the exact operation list `makemigrations` itself had reported, so it's identical to what the autodetector would produce), making it a real, durable file that's part of the image on every future build. **General rule going forward for this project: never rely on running `makemigrations` via `docker compose exec` as the source of truth for a new migration file — always confirm the resulting file actually exists on the host (`Glob`/`ls` the real `core/migrations/` folder) before telling the user to `migrate`, and if it's missing, write it by hand.** This also explains why the very first migration 0004 attempt (the plain tree-redesign one, before rssi/load) never actually got applied either, despite reportedly being generated — same failure mode, just not diagnosed at the time.

### Third real bug found completing --wipe for the first time ever

Once the migration was properly persisted, `seed_legacy_data --wipe` ran further than ever before in this project's history (every prior attempt crashed before reaching the end, for the unrelated reasons documented above) — real rows written cleanly (5 users, 4,718 sites, 11,932 sectors, 74 permissions, 20 thresholds) — but crashed on its own trailing summary log line: `NameError: name 'subfolders' is not defined` — a stray variable name left over from an earlier version of that line (correct name is derived from `all_folders_by_id`/`folders_by_id`).

**Important correction to an earlier claim**: `_import()` is wrapped in `@transaction.atomic`, so that crash rolled back the *entire* transaction — none of the rows above actually committed, despite their success messages printing before the crash. This was confirmed the hard way: `take_kpi_snapshot` run immediately afterward reported "0 created, 0 updated" for all three backfill dates, meaning zero sites actually existed in the database at that point. Fixed the stray variable, rebuilt + recreated the `django` container (same "container never picks up a source change without a rebuild+recreate" lesson as every other fix this session), and re-ran `--wipe`.

**Confirmed live, 2026-07-28**: `seed_legacy_data --wipe` completed end-to-end for the first time ever, printing the real final "Done." line. `take_kpi_snapshot` then backfilled 3 real days (`--date=2026-07-26`, `--date=2026-07-27`, today) × 4,718 sites = 14,154 snapshot rows, each run correctly reporting "4718 created, 0 updated." Backend verification for all of Phase 3 built so far (SLA, NTA, Monthly Report, Scatter Plot, KPI Trend) plus the rssi/load fields and the Phase 2 tree-redesign migration is now fully complete against real production data.

**Frontend re-verified live after all backend fixes, 2026-07-28** — user
confirmed `/sla` `/nta` `/monthly-report` `/scatter` `/kpi-trend` all look
right post-rebuild, with real 3-day KPI Trend charts now rendering (not
"not enough data").

### RF Audit (task #37) — the last Phase 3 item

Built 2026-07-28, right after the frontend re-verification above. Ports
v1's RF Site Audit tool (`openAuditModal()` and friends, bts_monitor.html
~1182-1328 / ~11655-12167) as a full page (`/rf-audit`) instead of a
modal — same "modal → page" move KPI Trend made.

**One deliberate, load-bearing departure from a literal port: the Sector
Analysis pane.** v1's `renderAuditSectors()` (~11897) invents three
sectors' worth of RSRP/RSRQ/SINR/PRB/HO/DL/UL by taking a site-level KPI
and adding an arbitrary per-sector offset, with RSRQ additionally
jittered by `Math.random()` on *every render* — so the same real site's
audit shows different numbers each time it's reopened. Investigated
during this build: this system has **no real per-sector RSRP/RSRQ/SINR
anywhere** — that data only ever exists in Drive Test session point data
(`netwatch_dt_db`), never attached to a `Sector` row — so v1 wasn't
approximating real data with a placeholder, it was inventing numbers for
a metric this system doesn't measure at that granularity at all. Per this
project's "never fabricate data" rule, this is fixed rather than ported
literally: `core/rf_audit.py`'s `build_audit_sectors()` reports each
sector's **real** `kpi_json` values (the same field names as `Site` —
`rrc`, `call_drop`, `intra_ho`, `ip_thru`, `prb`, `cell_avail` — see
bts_monitor.html ~13698's `sec.kpi[k] = r[k]`, and `seed_legacy_data.py`'s
straight copy of that JSON blob) where a sector actually has its own
entry, falling back to the site's own real aggregate value — labeled
`(site)` in the UI — where it doesn't. No randomness, no invented metric.

**New model** `AuditHistory` (`core/models.py`) — mirrors v1's own
already-real server-side persistence (`bagalewatch_api.py`'s
`audit_history` table, `saveAuditReport()`) almost exactly: `site`
(nullable FK, `SET_NULL` so a saved report survives the site being
deleted later), `site_name` (point-in-time snapshot, same reasoning),
`content` (the generated markdown report), `score`, `created_by`,
`created_at`. What's deliberately **not** persisted, matching v1: the raw
checklist state, measurement inputs, and antenna/feeder config — v1 never
saves those either (`auditState` is in-memory JS, reset on modal close),
only the final generated report text survives. Migration
`0005_audithistory.py` hand-written directly to the host tree per this
project's standing rule (see the migration-persistence section above) —
**not cross-checked against a live `makemigrations` run** this time (no
docker access this session), so treat the `AddIndex` name as a plausible
guess, not a verified one; if the user's real `makemigrations` wants to
tweak it, that's fine, Postgres doesn't care what an index is named.

**One backend consolidation, not a v1 bug port**: v1 has two
slightly-drifted KPI check lists — `generateFindings()`'s 9-item
`kpiChecks` and `generateAuditReport()`'s separate 7-item inline
`kpiProblems`, covering almost-but-not-quite the same KPIs at
almost-but-not-quite the same thresholds. `core/rf_audit.py`'s
`KPI_CHECKS` is one canonical 9-item list (a strict superset of both v1
lists — nothing a v1 user could see disappears, `erab`/`inter_ho` gain
findings coverage they lacked in v1's own report-scorer) used for both
findings and score, so the two can't drift from each other.

**New endpoints**: `GET /api/v2/rf-audit/data/?site=` (real KPI
findings/score/sector comparison — `IsAuthenticated`, any role, matching
v1: only *saving* history is gated tighter) and
`GET/POST /api/v2/rf-audit/history/` +
`GET/DELETE /api/v2/rf-audit/history/<id>/` (**admin+ only for both read
and write**, matching v1's `_require_auth(roles=('superadmin','admin'))`
on both GET and POST of `/audit-history` — a viewer never sees saved
audit reports at all, same as v1). DELETE has no v1 equivalent (v1 only
client-side-caps saved audits at 10 via `if(auditSaved.length>10)pop()`)
— a real Postgres table needs a real way to prune it.

**Everything else stays client-side, matching v1 exactly**: the 48-item
checklist (`AUDIT_CHECKLIST`), the 8-field measurement RAG grid
(`MEAS_FIELDS`), VSWR/PIM evaluators, and antenna/feeder config fields
are fixed reference data / pure arithmetic over real user-entered
measurements — v1 keeps these client-side with no DB dependency too, so
`RfAuditPage.tsx` ports them as-is rather than adding a server round trip
that wasn't there before. The report generator (`buildReportMarkdown()`)
is a near-literal port of `generateAuditReport()`, rendered through the
same shared `lib/markdown.ts` Monthly Report uses.

Route `/rf-audit`, nav link gated by `user.permissions.rfaudit`
(confirmed a real menu key in v1's `DEFAULT_PERMS`, admin+ by default,
same source used for scatter/kpitrend during Phase 3 research). New
tests: `RfAuditDataEndpointTests` (missing/unknown site, critical/warning
KPI band detection, missing-KPI-produces-no-finding, sector kpi_json vs
site-fallback), `AuditHistoryEndpointTests` (viewer 403 on both read and
write, admin save+list+filter-by-site+delete, site_name survives site
deletion).

**One real bug caught and fixed during this build, before ever reaching
the user**: the Report tab's "Live KPI Status" table originally matched
each row to `kpi_problems` by comparing display label strings (e.g. `"PRB
Util"`). The backend's canonical `KPI_CHECKS` labels don't all match that
table's shorter display labels (`"PRB Utilisation"` vs `"PRB Util"`,
`"Cell Availability"` vs `"Cell Avail"`, etc.), so several real
critical/warning findings would have silently rendered as `🟢 OK` in the
generated report. Fixed by adding a `key` field to `kpi_problems` (both
`core/rf_audit.py` and the `RfAuditKpiProblem` TS type) and matching on
that instead of the free-text label.

**Not yet verified** — no docker access this session, so unlike every
other Phase 3 item this one hasn't been through a real `docker compose
build/up/migrate/test` cycle yet. Needs, on the real machine:
```powershell
docker compose build django
docker compose up -d django
docker compose exec django python manage.py makemigrations core   # expect "No changes detected" — 0005 already covers the AuditHistory model
docker compose exec django python manage.py migrate
docker compose exec django python manage.py test core
```
Then frontend: `npx tsc -b` && `npx vite build` (two separate commands,
per the `O&M`-folder-name npm caveat above), then click through
`/rf-audit`: pick a site, fill in a few checklist items and antenna/VSWR
values, check the Sector Analysis tab shows real per-sector values with
`(site)` fallback labels where expected, check Findings picks up both the
checklist fails and any real KPI issues, generate the Report, and (as an
admin/superadmin user) Save it and confirm it reappears in the Saved
Audit History table below the report.

**Confirmed live, 2026-07-28** — user ran the verification steps above and confirmed RF Audit works correctly. **Phase 3 (the entire reporting suite: SLA, NTA, Monthly Report, Scatter Plot, KPI Trend, RF Audit) is now complete.**

---

## Phase 4 — Drive-Test Data Manager (in progress)

Started 2026-07-28, immediately after Phase 3's completion was confirmed ("all good. go ahead"). Scoped against the migration plan's §6 Phase 4 description plus a real research pass over v1's actual Drive-Test Data Manager (`bts_monitor.html`'s `openRsrpManagerModal()`/`saveDtSession()`/`renderRsrpMap()` and friends) and its already-live multi-user server contract (`bagalewatch_api.py`'s `dt-sessions`/`dt_records` tables and REST resource).

**Scope decision, confirmed via AskUserQuestion before any code was written**: the migration plan's literal Phase 4 description is "Upload flow (React → Django → Go job)" — TRP/GPX parsing moved server-side to a new Go worker, reached via a Redis job queue, with progress pushed back over Node's WebSocket gateway. All three of those pieces (Go worker, Redis queue, Node gateway) have existed only as empty Phase 0 skeletons and have never processed a single real job. Wiring all three at once, alongside a brand-new high-volume table (§7 flags 121,000+ rows in one real production batch), was judged higher risk than necessary for a first slice. **User chose: ship the Django/React CRUD + storage layer first, with TRP/GPX parsing staying client-side (a React/TS port of v1's already-proven browser-side decoder) exactly like v1 does today. The Go/Redis/Node pipeline becomes a dedicated follow-up once this is verified live**, not abandoned — tracked as its own task (Phase 4e).

### Phase 4a — DriveTestSession/DriveTestSample models + CRUD endpoint (code-complete, not yet verified)

**Schema note, same pattern as every other phase**: the migration plan's own sketch for this table (`DriveTestSession(id, name, date, tech, uploaded_by, point_count, file metadata)` / `DriveTestSample(session FK, ts, lat, lng, rsrp, rsrq, sinr, dl_throughput, pci)`) is a planning-stage approximation, written before real research. v1's `bagalewatch_api.py` already has a **live, working multi-user server implementation** of this exact feature (`dt_sessions` + `dt_records` tables, `GET/POST/DELETE /dt-sessions`) — ported field-for-field from there instead, same "the real v1 server schema is the source of truth" approach already used for Site/Sector/User in Phase 1. This surfaced 14 more real fields the plan's sketch was missing entirely: serving-cell labeling (`serving_site_id/name/sector/cell_name/local_cell_id/dist_km`, populated only for TRP-sourced records run through v1's `_rsrpMatchServingCell`), `cell_role` (serving vs. neighbor — a phone measures nearby cells for handover at the same location/time as its serving cell, and v1 stores both), and 2G/3G-specific fields (`rx_qual`, `bcch`, `bsic`, `rscp`, `ecno`, `scrambling_code`) alongside the 4G ones.

**New models** (`core/models.py`): `DriveTestSession` (name, tech, date, uploaded_date, saved_at, uploaded_by FK, `meta` JSONField — kept as an unnormalized blob matching v1's own `meta_json`, since the auto-naming/district-resolution logic it holds is still evolving client-side per project memory — and `size_bytes`, now computed server-side from the actual stored payload rather than trusted from the client, since v1's version was only ever a browser-side IndexedDB-quota estimate that means nothing once storage is real Postgres) and `DriveTestSample` (23 fields matching `dt_records` exactly, FK CASCADE to session).

**Partitioning — deliberately deferred, documented, not silently dropped.** §3 of the migration plan calls for `DriveTestSample` partitioning "from day one" given real data volume. This first migration does not set up native Postgres declarative partitioning — a single `(session)` index is correct and sufficient at the scale this phase ships at; partitioning needs a real production upload-volume number to size sensibly, which doesn't exist yet. Flagged as a concrete follow-up once real usage data exists, not forgotten.

**Migration** `0006_drivetestsession_drivetestsample.py` hand-written directly to the host tree per the standing rule (no docker access this session, so — same caveat as 0005 — not cross-checked against a live `makemigrations` run; index names are plausible guesses).

**New endpoints** (`core/drive_test.py`'s `DriveTestSessionViewSet`, registered at `/api/v2/dt-sessions/`): list (metadata only — via a new `DriveTestSessionListSerializer` with an annotated `sample_count`, matching v1's "History tab list never downloads full traces" design, since a single session can be tens of thousands of rows), retrieve (includes nested samples, matching v1's GET-detail), create, destroy. **No update/PUT** — v1's PUT is an upsert-by-client-generated-id (delete-all-records-then-reinsert for an existing session id); v2's session ids are server-assigned on create instead, so there's no equivalent need — the duplicate-upload dialog's "Replace Old" action becomes a plain client-side DELETE-old + POST-new, not a special server upsert contract. Simpler than v1, same end-user behavior. Read: any authenticated role. Write (create/destroy): admin+ only — matches v1's `_require_auth(roles=('superadmin','admin'))` on POST/DELETE of `/dt-sessions` exactly (GET has no role restriction in v1 either).

Menu permission key: `rsrpmgr` (v1's actual key — "DT Data Manager" is just the display label after a 2026-07-22 rename) — already a recognized CRUD-shape menu key in v2's `CRUD_MENUS` set (`core/serializers.py`), so no new permission-seeding work was needed; the real seeded `role_permissions` data already has correct per-role read/write/update/delete rows for it.

New tests (`DriveTestSessionEndpointTests`): viewer can list/retrieve but gets 403 on create/delete; admin create persists both the session and every sample row correctly (including a `neighbor`-role sample and 2G/3G-only fields); list response has no `samples` key (metadata-only contract) and a correct `sample_count`; retrieve includes full samples; delete cascades to samples; creating with zero samples doesn't 500 (mirrors v1's "no valid GPS records" case, which stays a client-side check per the model's docstring).

### Real bug found + fixed while handing off verification: hand-guessed index names broke `migrate`

The first `makemigrations core` run on the real machine (2026-07-28) didn't say "No changes detected" as expected — it produced a new migration renaming all three indexes added in 0005/0006, because those files' `AddIndex` names were guessed (no docker access when they were first written) and didn't match Django's real deterministic hash. That alone would just be cosmetic — except applying the rename failed outright: `psycopg2.errors.UndefinedTable: relation "v2_audit_h_site_id_1e5f8a_idx" does not exist`. The guessed name never actually matched what Postgres really has.

**Fixed properly, not just patched around**: the `makemigrations` output itself already printed Django's real computed names (`~ Rename index v2_audit_h_site_id_1e5f8a_idx ... to v2_audit_hi_site_id_7d6232_idx`, and two more for the DT indexes) — those target names were copied straight into the original 0005/0006 files, replacing the guesses. The now-orphaned rename migration (`0007_rename_...`) never persisted to host disk anyway (same "container has no source mount" root cause as always) and isn't needed — with the real names baked directly into 0005/0006, there's nothing left to rename. See `feedback_hand_guessed_index_names_break_migrate` memory for the general lesson (don't hand-guess `models.Index` names — even a "harmless" rename-migration risk turned into a real apply failure here).

**Re-run to pick up the corrected files:**
```powershell
docker compose build django
docker compose up -d django
docker compose exec django python manage.py makemigrations core   # expect "No changes detected" now
docker compose exec django python manage.py migrate
docker compose exec django python manage.py test core
```
If `migrate` still complains about the index (e.g. if 0005/0006 partially applied earlier under the old guessed names and Postgres now has a real index under some other name entirely), this is disposable dev data — `docker compose down -v && docker compose up -d` wipes the volume cleanly, then `migrate` applies everything fresh from 0001, followed by the usual `seed_legacy_data <path> --wipe` re-seed.

**Confirmed live, 2026-07-28** — after the index-name fix above, `makemigrations core` reports "No changes detected", `migrate` applies cleanly, and all 59 tests pass (up from RF Audit's count, confirming `DriveTestSessionEndpointTests` ran for real against Postgres). Phase 4a (the storage/CRUD layer) is done.

No frontend to click through yet — Phase 4a is backend-only. The React upload UI, session history list, coverage map, and the client-side TRP/GPX parser port are the next slices (Phase 4b/4c), not built in this pass.

**Still to do for Phase 4** (at the time Phase 4a shipped): 4b (coverage map rendering), 4c (session history UI + duplicate-upload detection, port of v1's filename+date+point-count match with the Cancel/Keep Both/Replace Old dialog), 4d (Explore-by-coordinate + session comparison), 4e (Go/Redis/Node job-queue wiring, once the above is verified live). The TRP binary parser itself (ZIP → `declarations.cdf` protobuf-style field dictionary → `data.cdf` raw-deflate sample records → GPX correlation) is the single highest-risk piece of this entire migration per §7 of the plan and has real unresolved edge cases even in v1 today (per project memory: unverified 3G paths, an unresolved "sessions lost after upload" bug never root-caused) — it gets its own dedicated, carefully-scoped pass, not rushed alongside the CRUD layer.

### Phase 4b/4c — CSV template upload UI + coverage map + session history + duplicate detection (code-complete, not yet verified)

Built directly on top of Phase 4a's CRUD layer, no backend changes needed. Scope stays exactly what the Phase 4 AskUserQuestion decided: the **CSV/TXT template upload path only** (v1's `_rsrpCsvTextToRows`/`_rsrpParseTemplateRows`) — the `.trp`/`.nmf` binary decoder and PCI-based serving-cell auto-matching are not in this pass; they're the dedicated high-risk follow-up flagged above.

**New library files** (`frontend-react/src/lib/`):
- `dtBands.ts` — the coverage-band color tables (`RSRP_BANDS`/`RXLEV_BANDS`/`RSRQ_BANDS`/`SINR_BANDS`/`ECIO_BANDS`/`RXQUAL_BANDS`) and `metricsForTech()`, copied byte-for-byte (breakpoints and hex colors both checked against `bts_monitor.html` lines 6144-6272, not re-derived from memory) from v1's `rsrpDotColor`/`_bandColor`/`_dtMetricsForTech`.
- `dtTemplateParser.ts` — `csvTextToRows()` and `parseTemplateRows()`, a straight TypeScript port of v1's `_rsrpCsvTextToRows`/`_rsrpParseTemplateRows` (same flexible normalized-header column matching, same per-tech column set, same fail-fast "columns not found" error). Output shape maps to `DtSample`'s snake_case backend fields rather than v1's camelCase in-browser shape — most fields carry over 1:1, but `bcch`/`bsic`/`scrambling_code` are parsed as integers here (`DriveTestSample.bcch/bsic/scrambling_code` are `IntegerField`s in v2, vs. v1's IndexedDB, which just stored whatever string came out of the CSV cell). Also adds `computeSessionMeta()` (GPS point count, haversine route distance, avg signal, start/end timestamp) — v1 computes the same numbers inline inside `saveDtSession()`; this is a small new pure function rather than a reason to duplicate that whole function.

**New component** (`frontend-react/src/components/DtCoverageMap.tsx`) — same imperative-Leaflet-layer pattern as `MapView.tsx`'s `ClusteredMarkers` (`useMap()` + raw `L.circleMarker`/`L.layerGroup` calls, no `react-leaflet-cluster`), plain `CircleMarker`s with no clustering since a DT session tops out at a few thousand points, not 4,700+ sites. Per-tech metric tabs (RSRP/RSRQ/SINR for 4G, RxLevel/RxQual for 2G, RSCP/Ec-Io for 3G) switch which band table colors the dots, with a matching legend underneath — mirrors v1's `renderRsrpMap()` metric-switcher.

**New page** (`frontend-react/src/pages/DtDataManagerPage.tsx`), route `/dt-data-manager`, nav-gated on `rsrpmgr` read permission (same key Phase 4a already confirmed is correctly seeded):
- **Upload tab** — tech selector (4G/3G/2G), session name field, drag-drop/click CSV upload, live preview (summary cards + coverage map) before saving, Save/Discard. Gated on `rsrpmgr` write permission; a read-only user sees a "read-only access" notice instead of the upload form.
- **Duplicate detection** — ported from v1's `_dtDuplicateDialog`/`saveDtSession` logic exactly: before saving, the new upload's file name + drive-test date + point count are compared against every existing session's same three fields (all three must match — file name alone or point count alone isn't enough, same reasoning as v1's code comment). A match shows a modal with the same three choices v1 has — **Cancel Upload**, **Keep Both** (saves as a separate session), and **Replace Old** (client does DELETE-old then POST-new, since v2's session ids are server-assigned rather than upserted like v1's — see Phase 4a's note on why there's no update/PUT). "Replace Old" is gated on `rsrpmgr` update permission, matching v1's `userCan('rsrpmgr','update')` gate on the same button.
- **Session History tab** — table of saved sessions (name/tech/date/point count) with a Delete action gated on `rsrpmgr` delete permission; clicking a session name loads its full detail (nested samples) and renders the same coverage map + summary cards used in the upload preview.
- New shared CSS: a generic `.modal-overlay`/`.modal-box`/`.modal-hdr`/`.modal-body`/`.modal-footer` chrome (v1's duplicate dialog is a raw `innerHTML` string with inline styles; this is the first place v2 needed a lightweight modal, so it got real CSS classes instead of importing v1's dialog markup wholesale) plus `.dt-drop-zone`/`.dt-coverage-map`/`.dt-metric-tab`/`.dt-legend`/`.dt-dup-card` for the page-specific pieces.

**Not built in this pass** (unchanged from Phase 4a's list): the `.trp`/`.nmf` binary parser, PCI-based serving-cell auto-labeling, Explore-by-coordinate, and session comparison (Phase 4d) — see the "highest-risk piece" note above for why the binary parser specifically is being deferred rather than folded in here.

**Real gap found during handoff, fixed 2026-07-28**: the user's first live test hit "Could not find Lat/Long/RSRP columns" on both a 4G and a 2G upload attempt — not a parser bug (traced the real v1 template header `Time,Date,Lat,Long,Serving Cell RSRP (dBm)` through `parseTemplateRows` by hand and it matches correctly), but this first pass genuinely shipped without any way to know what header format is expected, unlike v1 which has a "⬇ Download Template" button right next to its upload zone (`rsrpDownloadTemplate()`, bts_monitor.html ~7637-7667). Added the same button (per-tech, exact header+sample copied from v1's function) plus an inline "Expected header: ..." hint on the empty drop zone itself, so a user without an existing v1-format file isn't stuck guessing.

**Second real gap found + fixed same day: XLSX upload + real vendor header format.** The user's actual file that triggered the first error turned out to be their real drive-test export, not a test file — and it revealed two things this pass was genuinely missing:
1. **XLSX upload wasn't implemented at all** (only `.csv`/`.txt`, deliberately deferred earlier in the phase to avoid a new npm dependency), even though v1 supports XLSX right alongside CSV (confirmed via a screenshot of v1's own upload UI: "Upload 4G Template (CSV / XLSX)"). Fixed by porting v1's *own* minimal hand-rolled XLSX reader (`_xlsxSheetToRows`/`_trpZipListEntries`/`_trpZipReadEntry`, bts_monitor.html ~9161-9293 — an .xlsx file is a ZIP of XML parts, and v1 already had a ZIP+raw-deflate reader for `.trp` files for the same reason) into `frontend-react/src/lib/xlsxReader.ts`. Deliberately NOT the SheetJS npm package — no new dependency needed, and it's the same "read one flat worksheet, no formulas/merged cells" scope v1's own reader has. One real extension beyond v1: the user's actual reference template (`template_2G_3G_4G.xlsx`) bundles per-tech example columns into **three separate sheets** ("2G"/"3G"/"4G" tabs), so `readXlsxRowsForTech()` reads `xl/workbook.xml` + `xl/_rels/workbook.xml.rels` to resolve sheet names and picks whichever sheet name matches the selected tech, falling back to the first sheet if none match (so a plain single-sheet file, whatever it's named, still works like v1's always-first-sheet behavior did).
2. **The real header format uses a combined "DateTime" column**, not separate Time/Date columns (e.g. `2026-07-12 15:33:23.500`) — confirmed from screenshots of all three real sheets. `parseTemplateRows` (`lib/dtTemplateParser.ts`) previously only handled separate Time/Date columns; worse, since "datetime" contains both "time" and "date" as substrings, the old flexible column matching would have matched the SAME column for both and fed it a duplicated, unparseable string. Fixed: checks for a `datetime`-named column first, and only falls back to separate Time/Date columns if none exists. Also handles the case where a genuine Excel date cell comes back as a raw numeric day-serial (e.g. `46215.648...`) instead of literal text — converted via the standard 1900-date-system epoch offset (25569 days from Excel's epoch to Unix epoch).
3. The real header names themselves are also quite different from v1's simple template (e.g. `Serving RSRP_4G`, `RSCP for 1st Best in Active Set_3G`, `RxLev Sub_2G`, and `Longitude` listed *before* `Latitude`) — traced each one through the existing flexible substring matcher by hand and all matched correctly already (column order was never assumed; the substring search for e.g. `rsrp` matches `servingrsrp4g` fine). The Download Template button and drop-zone hint were updated to show this real format (with the user's own real example values) instead of v1's simpler placeholder, since that's what the user will actually use going forward.

`package.json` unchanged — no new dependency added for XLSX support.

**Fifth and sixth real gaps, found after the first successful live upload (2G_sample, 85 points, saved and rendered on the map)**:
1. **Coverage map rendered mostly black** in the Session History panel — this took seven fix attempts across two days (2026-07-28/29) to actually resolve, so the full chain is worth keeping for next time a Leaflet map on this project misbehaves:
   1. `invalidateSize()` on a container-resize theory — no change.
   2. Switched `MapContainer` to init directly at the samples' bounds via react-leaflet's `bounds`/`boundsOptions` props instead of zoom-7-then-jump — no change.
   3. StrictMode double-mount theory, tested via `vite preview` (production build, no StrictMode) — no change.
   4. `ResizeObserver`-driven `invalidateSize()` + refit — no change.
   5. Rewrote to mirror `MapView.tsx`'s exact proven pattern (plain `center`/`zoom` + `fitBounds()` in a `useEffect` via `useMap()`, no `bounds` prop) — no change. This is when DevTools Network evidence (tiles loading successfully, 200s, fast, from disk cache) first showed it was never a network/tile-server problem, confirmed further by opening a tile URL directly (rendered a real valid image) and by the Sites page — same tile URL, same `leaflet.css` — rendering perfectly.
   6. Withheld `<TileLayer>` entirely until after `fitBounds()` had already run once, so tiles are only ever requested for the correct final view (eliminates the zoom-7-then-instant-jump-to-16 scenario). Verified via a temporary canary banner that the browser really was running the new code each time (ruling out a stale-bundle explanation for the run of "nothing changed" reports) — still no change even with fresh code confirmed running.
   7. **Actual root cause**: `MapContainer` had `preferCanvas` set (copied from `MapView.tsx`). On `MapView.tsx` this is a no-op — its markers come from `leaflet.markercluster`, which uses plain DOM `L.divIcon`/`L.marker` elements, never a vector shape, so no `<canvas>` renderer pane is ever created there despite the prop being present. `DtCoverageMap.tsx` draws real `L.circleMarker` vector shapes for the route dots, which — with `preferCanvas` on — DOES activate a live canvas overlay pane stacked on top of the tile pane. That interacts badly with Leaflet's own `mix-blend-mode: plus-lighter` CSS (stock, unmodified `leaflet.css`, a documented Chromium tile-seam-compositing workaround, bug 600120) in this Chromium build, blacking out the tile pane entirely. **Fix: removed `preferCanvas` from `DtCoverageMap.tsx`'s `MapContainer`** — circleMarkers now render via Leaflet's default SVG renderer instead, which sidesteps the canvas+tile interaction. No real perf cost: DT sessions run a few thousand points at most, nowhere near the 4,700+ site scale that motivated `preferCanvas` on `MapView.tsx` (which, per the above, isn't even doing anything there).
   
   **Confirmed live 2026-07-29** — real OSM street tiles (Araniko Highway/Koteshwar, Kathmandu) rendering correctly under the route dots.
   
   Lesson for next time a Leaflet tile-rendering bug shows up on this project: check `preferCanvas` first if the map draws real vector shapes (circleMarkers, polylines, polygons) — it's the kind of bug where every layer-mounting/timing fix looks plausible and changes nothing, because the actual cause is a rendering-mode interaction, not a mount-order one.
2. **Session naming didn't match v1** — the "Session name" field defaulted to the raw uploaded filename (e.g. "2G_sample"), but v1's real `saveDtSession()` auto-generates `DT_Excel_%dtDate%_%districtname%_%techtype%` for CSV/XLSX template uploads and has no manual-name field at all for that path. Ported the real naming scheme into `handleFile()` in `DtDataManagerPage.tsx`, including a `resolveDistrict()` helper — a partial port of v1's `_resolveDtDistrict()` (bts_monitor.html ~7581-7611): only its tier-2 fallback (nearest real `Site`'s `district` field by haversine distance from the upload's GPS centroid), not its tier-1 point-in-polygon check against `NEPAL_DISTRICT_BOUNDARIES` (a large embedded dataset covering only 30/77 districts, never ported into v2 — that's Phase 4d/Explore-by-coordinate territory). Flagged clearly in code comments as a deliberate approximation using real data, not fabrication — just coarser than a real boundary check near a district border. The name field stays editable after auto-fill, unlike v1, as a deliberate small UX improvement (documented, not silently different).
3. **Duplicate-detection concern** — the user hadn't yet re-uploaded the same file to see the dialog trigger; re-checked the implementation and it's independent of the session *name* (keys off the real uploaded filename + drive-test date + point count, same as before this naming fix), so it should be unaffected — but genuinely unverified live as of this edit. Needs the user to actually re-upload the same file twice to confirm.

**Third and fourth real corrections, same day**: after switching the downloadable template to separate Time/Date columns (fix #2 above), the user re-downloaded and reopened it in Excel and found the Time column STILL displayed wrong (`12:59:07.500` showing as `59:07.5`, silently dropping the hour) — a known Excel CSV-open quirk where a time-looking cell gets auto-detected and reformatted, independent of the DateTime-vs-separate-columns question. Fixed with the standard trick: `downloadTemplate()` now prefixes Time/Date cell values with a leading apostrophe in the generated CSV text, which tells Excel "treat this as literal text" and stops the auto-conversion; `parseTemplateRows` strips a leading apostrophe before parsing so the template still round-trips if re-uploaded unmodified. Separately, the user shared their actual preferred 2G/3G column-naming convention ("Agg. Active RSCP (dBm)"/"Agg. Active Ec/Io (dB)" for 3G, "RxLevSub (dBm) - .Server"/"RxQual Sub" for 2G, no Scrambling Code/BCCH/BSIC columns) — traced both through the existing flexible substring matcher by hand and confirmed both already match with zero parser changes needed; only `TEMPLATES` in `DtDataManagerPage.tsx` was updated to reflect the real names (BCCH/BSIC/Scrambling Code stay supported by the parser if present in a real file, just aren't shown in the template anymore since this user's format doesn't have them).

**Build verified live, 2026-07-28** — `node node_modules\typescript\bin\tsc -b` (zero output, no type errors) and `node node_modules\vite\bin\vite.js build` (152 modules, built in 802ms) both ran clean on the user's real machine, including the Download Template fix above. (Note: `npm run build`/`npx tsc -b` failed on this machine for unrelated reasons — a Windows `.cmd` shim path-resolution quirk tied to how the mounted project folder is reached, not a code issue; invoking `node node_modules\<pkg>\bin\...` directly sidesteps it.) Backend's 59/59 tests and clean migrate also reconfirmed. Still outstanding: the manual browser click-through (upload → coverage map → history → duplicate dialog → delete).

Before this was confirmed, the plan was a real build + manual click-through:
```powershell
docker compose exec django python manage.py test core   # confirms nothing on the backend regressed (no backend changes made this pass)
cd frontend-react
npm run build                                             # tsc + vite build — catches any type error in the four new/changed files
npm run dev                                               # then manually: log in as admin, open DT Data Manager, upload a real CSV template, verify the map renders and colors match the legend, save, confirm it appears in History, re-upload the same file to confirm the duplicate dialog appears with all three options working, delete it
```

## Phase 4d — Explore-by-coordinate + session comparison (2026-07-29)

Built after the coverage-map black-tile bug (see Phase 4b/4c section above) was fully resolved and confirmed live. Two features, both ported from `bts_monitor.html`'s RSRP Manager:

**Explore-by-coordinate** (v1's "By Coordinates" pane, `renderRsrpCoordTab`/`renderCoordCoverageMap`, ~6648-7062) — new `components/DtExploreTab.tsx`, added as a third tab on the DT Data Manager page. **Real gap found + fixed same day**: the first pass only accepted a raw lat/lng pair; the user pointed out (via a screenshot of v1's actual search box placeholder) that v1's search accepts a Site ID, city name, or district name too, not just coordinates. Ported v1's real resolution order (`rsrpCoordSearch`/`_resolveSiteIdQuery`/`_resolvePlaceQuery`, ~6794-6908): try raw coordinates first, then an exact/prefix/substring Site ID or name match, then a city/district name match resolved to the centroid of real sites sharing that field — all computed client-side from the same `sites` list already loaded everywhere else (`useSites()`), no new data or endpoint needed. **Scope decision, same real-data-only rule already applied to the Phase 4c district auto-namer**: v1's district/city resolution additionally prefers a real `NEPAL_DISTRICT_BOUNDARIES` polygon or `NEPAL_PROVINCES` centroid before falling back to the site-averaging method used here — neither dataset was ported to v2 (only 30/77 districts have real boundary data; see `project_rsrp_2g3g_boundary_features` memory — "never fabricate the rest"), so district queries here always resolve via the same site-centroid averaging as city queries, one fewer independent source than v1 has but still entirely real data. Once resolved to a point (by any of the four input kinds), the search area itself is always a plain radius circle — v1's boundary-polygon/convex-hull *shape* for district/city searches specifically is still out of scope, for the same boundary-data reason.

New backend endpoint: `GET /api/v2/dt-sessions/near/?lat=&lng=&radius_km=&tech=4G,3G,2G` (`DriveTestSessionViewSet.near()` in `drive_test.py`) — bounding-box prefilter via the ORM, then exact haversine distance in Python (no PostGIS in this stack), returns every session with ≥1 sample inside the radius, each trimmed to just its in-radius samples via the new `DriveTestSessionNearSerializer`. Nearby BTS *sites* need no new endpoint at all — computed entirely client-side from the sites list every page already loads (`useSites()`) plus the existing `haversineKm` helper, exactly mirroring how v1 does its own radius-circle site search over an already-in-memory `SITES` array.

**Session comparison** (v1's `rsrpOpenCompare()`/`_rsrpSiteTabOpenCompare()`, ~8180-8344 — two near-identical copies in v1, unified into one component here) — new `components/DtCompareMap.tsx`. Checkboxes added to the Session History table (max 4 selectable — v1 doesn't hard-enforce this and would silently repeat colors via palette modulo past 4; v2 caps the UI at 4 instead, a documented small improvement). Selecting 2+ and clicking "Compare N Sessions" fetches each session's full detail in parallel via `useQueries` (reusing the same `GET /dt-sessions/{id}/` the single-session view already calls — no new backend endpoint needed here) and renders one overlaid map with the same 4 blue/red/purple/orange palettes as v1, plus a stats table (avg/min/max/% poor, computed off the shared `rsrp` field same as v1). Explicitly does **not** set `preferCanvas` on this map's `MapContainer`, per the black-tile fix above — it draws real `L.circleMarker`s too.

`tsc -b` clean (zero errors) in this sandbox; `vite build` couldn't run here (`@rolldown/binding-linux-x64-gnu` missing — this sandbox's `node_modules` was installed on Windows, a platform mismatch unrelated to the code, same class of issue as the `.cmd` shim quirk). Not yet verified with a real build or live click-through — needs, on the real machine:
```powershell
docker compose build django
docker compose up -d django
docker compose exec django python manage.py test core   # confirms the new near() endpoint doesn't break anything existing; no new model/migration this phase
cd frontend-react
node node_modules\typescript\bin\tsc -b
node node_modules\vite\bin\vite.js build
node node_modules\vite\bin\vite.js                        # then manually: DT Data Manager → Explore tab → paste a coordinate near a known site/session, confirm nearby sites + DT points render on the map; History tab → check 2+ session checkboxes → Compare → confirm overlaid map + stats table
```

### Real gap found live-testing Explore, same day: district search resolved to the wrong point

The user tested the Explore tab live and searched "kathmandu" — it resolved to `Kathmandu (447 sites)` but the marker landed near Bajrabarahi, well south of the actual city, with a screenshot showing the mismatch. Root cause: the district-name resolution above (site-averaging) computes a plain centroid of every site tagged `district="Kathmandu"` — for a large, non-convex district, a scattered point cloud's average isn't a meaningful "center," and can land far from where a user would expect. The user asked to "bring over" the export/street-satellite-toggle/fullscreen/click-popup UI parity gaps flagged earlier in the same message.

**District boundaries, now ported.** Re-examined `bts_monitor.html` and found `NEPAL_DISTRICT_BOUNDARIES` (~line 15497) is a real, complete embedded object — 31 of Nepal's 77 districts (not 30; recounted directly off the real data), most from `mesaugat/geoJSON-Nepal` (~40pt decimation), with a precise ~150pt boundary for Kathmandu/Lalitpur/Bhaktapur specifically via Open Knowledge Nepal's LocalBoundaries dataset. Extracted verbatim (byte-for-byte, machine-copied from the source line, not retyped) into new `lib/nepalDistrictBoundaries.ts`. Also ported `_convexHull`/`_pointInPolygon` (~15503-15538) into new `lib/geo.ts`, plus a `polygonAverageCenter` helper (new — v1 never needed one itself, since it always had a separate `NEPAL_PROVINCES` centroid per district independent of the boundary shape; that dataset wasn't ported, so the boundary polygon's own vertex average now serves as both the resolved point and the search shape) and `polygonBoundingRadiusKm` (sizes the existing radius-based `near()` backend query to a covering superset for polygon/hull shapes, avoiding a second endpoint — the returned samples are then trimmed precisely client-side with `pointInPolygon`).

`DtExploreTab.tsx`'s resolution order is now: real boundary polygon (if the district name matches one of the 31 real keys) → convex hull of matching sites (real data, ≥3 points) → plain circle (last resort, and always the case for raw-coordinate and Site ID/name searches, matching v1). This directly fixes the Bajrabarahi bug: "Kathmandu" now matches the real boundary key, so the resolved point is that polygon's own vertex average (inside the real city shape) and the search area is the real boundary, not a scattered-site centroid.

**UI parity items also added this pass**, all in `DtExploreTab.tsx`: multi-tech metric tabs (`RSRP:4G`/`RSRQ:4G`/`SINR:4G`/`RSCP:3G`/`Ec/Io:3G`/`RxLevel:2G`/`RxQual:2G`, matching v1's real tab set — a flattened list across `metricsForTech()` for all three techs, since a combined multi-session view can have mixed techs at once); click-to-open Leaflet popups (full timestamp/metric-value/serving-site detail) replacing hover tooltips on every layer; a Street/Satellite tile toggle (satellite reuses the same public `mt{s}.google.com/vt/lyrs=y` tile pattern the v1-ported `DtCompareMap.tsx` already uses); a Fullscreen toggle via the browser's native Fullscreen API; and CSV + KML export of the currently-filtered points for whichever metric tab is selected.

**Deliberately deferred: XLSX export.** v1's screenshot showed CSV/XLSX/KML buttons. CSV and KML are plain text formats, safe to hand-generate; a real `.xlsx` needs a ZIP container (local file headers, central directory, CRC32) — nothing in this codebase writes ZIP files (the existing `lib/xlsxReader.ts` only *reads* one using the browser's `DecompressionStream`, which has no write-side equivalent). Building a correct hand-rolled ZIP writer is real, non-trivial binary-format work, and this whole batch was written while the sandbox's shell tool was down (`Workspace unavailable — VM service not running`), so `tsc -b` could not be run to self-verify even the code that WAS written. Shipping an unverified ZIP writer on top of that felt like the wrong risk to take in one pass — CSV already opens fine in Excel, so it covers the same practical need. Flagged here rather than silently dropped; worth a dedicated follow-up once there's shell access again to actually test the byte format.

**Not yet verified at all** — this entire addendum (district boundaries + all five UI items) was written without any compiler or build check (sandbox shell unavailable throughout). Reviewed by hand for syntax/type correctness but this is meaningfully less reliable than the `tsc -b`-clean confirmation everything else in this file has. Before trusting it, run on the real machine:
```powershell
cd frontend-react
node node_modules\typescript\bin\tsc -b
```
If that's clean, then rebuild (`vite.js build`) and click through: Explore tab → search "Kathmandu" → confirm the point now lands inside the actual city (not Bajrabarahi) and a real boundary outline is drawn; try a district with no boundary data (e.g. a Terai district not in the 31) to confirm it falls back to a site hull or circle instead of erroring; try the metric tabs, CSV/KML export, satellite toggle, and fullscreen button.

### Fullscreen black area fix + JWT-across-refresh (2026-07-30)

**Fullscreen black area, same root-cause class as the coverage-map bug.** User reported the Explore tab's fullscreen mode showed the map filling only the top of the screen with a black area below (screenshot: Lalitpur boundary correctly rendered on satellite tiles, but not filling the fullscreen viewport). Root cause: same class as the earlier black-tile bug — Leaflet caches the map container's pixel size internally and only recomputes it via `invalidateSize()`; the Fullscreen API resizes the wrapping `<div>` (420px → 100vh) entirely outside Leaflet's own knowledge, so the tile/marker panes kept rendering at the old size, exposing `.dt-explore-map-fullscreen`'s own background color for the rest of the screen. Fixed in `DtExploreTab.tsx`: new `FullscreenSync` component (`useMap()` + a `requestAnimationFrame` after `isFullscreen` changes, calling `map.invalidateSize()` then `map.fitBounds(currentBounds, {padding:[24,24], maxZoom:16})`) mounted inside the `MapContainer`; `currentBounds` is a new `useMemo` in the main component computing an `L.LatLngBounds` from the current search shape (polygon bounds if a district boundary/hull is active, else a circle of the current radius) so re-fitting after the resize keeps the same search area visible instead of snapping to the default Nepal-wide view. Esc-to-exit needed no new code — the browser's native Fullscreen API already exits on Esc, and the existing `fullscreenchange` listener already flips `isFullscreen` back, which now also re-triggers `FullscreenSync` to shrink the map back down cleanly.

**JWT persists across a normal page refresh now.** User asked: "when i refresh my browser, it gets logged out from the system, only log out after hard refresh or after logout button click." Investigated `api/client.ts` (tokens were a pure module-level variable, wiped by ANY reload) and `auth/AuthContext.tsx` (no restore-on-mount logic existed). **Technical caveat, communicated to the user, not silently ignored**: no web API can tell a "hard" refresh (cache-bypass reload) apart from a "soft" one — `sessionStorage`/`localStorage` persist identically across both, clearing only when the tab/window itself is closed. The literal ask isn't achievable; what was built instead is "stay logged in across any refresh, log out only via the Logout button, token/refresh-token expiry, or closing the tab," which covers the actual complaint (routine refreshes kicking the user out).

Implementation: `api/client.ts` now mirrors `accessToken`/`refreshToken` into `sessionStorage` (`bagalewatch_access_token`/`bagalewatch_refresh_token`) on every `setTokens()`/`clearTokens()`/silent-refresh, reading them back at module load via `readStorage()` (wrapped in try/catch — some private-browsing contexts throw on `sessionStorage` access); new `getRefreshToken()` export added alongside the existing `getAccessToken()`. `AuthContext.tsx` adds a `restoring` boolean (`true` initially only if a token was found in storage) and a mount-time effect that calls `GET /api/v2/auth/me/` (already existed, unused until now) to re-hydrate `user` when a token survived a reload — going through the existing `apiFetch`, so an expired *access* token still transparently silent-refreshes via the existing 401-retry path, and only a genuinely dead refresh token clears everything and drops the user to `/login`. `auth/ProtectedRoute.tsx` now checks `restoring` before checking `user`, so it doesn't redirect a valid restored session to `/login` on the single render before the `/me/` call resolves.

`tsc -b` NOT run (sandbox shell still unavailable this session) — reviewed by hand only. Before trusting this, on the real machine:
```powershell
cd frontend-react
node node_modules\typescript\bin\tsc -b
```
then click through: log in, open DT Data Manager → Explore tab → search a district with real boundary data (e.g. Kathmandu) → click Fullscreen → confirm the map fills the ENTIRE screen with no black band and the same search area is still framed → press Esc → confirm it returns to the normal in-page size cleanly. Separately: log in, refresh the page (F5) → confirm you're still logged in and land back on the same page instead of `/login`; then click Logout → confirm you're actually logged out and a refresh afterward stays on `/login`.

### Fullscreen fix, take 2 — the real root cause (2026-07-30, same day)

User reported the black area persisted after the `FullscreenSync`/`invalidateSize()` fix above — tested with Kathmandu (looked OK) vs. Lalitpur/Bhaktapur (still showed the black band). The `invalidateSize()` fix was necessary but not sufficient — it was solving for the wrong layer. Actual root cause: **`react-leaflet`'s `MapContainer` only reads its `style`/`className` props ONCE, at first mount** — after that it hands the container `<div>` over to Leaflet's own imperative code, and React re-renders no longer update that div's inline `style`. The original fix drove the fullscreen height through `style={{ height: isFullscreen ? '100vh' : undefined }}` on `MapContainer` itself — this was silently a no-op on every toggle after the component's first render, so the map's actual DOM box stayed frozen at whatever height it had on page load (420px). `invalidateSize()` was faithfully telling Leaflet to match that frozen box — which is why it "worked" in the sense of not crashing, but never actually grew the map.

Real fix: height now lives entirely on the wrapping `<div ref={wrapRef}>` (a plain React-managed element that DOES re-render normally on every `isFullscreen` change) via a new `.dt-explore-map-wrap` base class (`height: 420px`) plus the existing `.dt-explore-map-fullscreen` override (`height: 100vh`). `.dt-coverage-map` (the `MapContainer`'s own class) now just has a scoped `height: 100%` rule under `.dt-explore-map-wrap`, so it fills whatever the wrapper's current height is — no reactive style prop needed on `MapContainer` at all. `FullscreenSync`'s `invalidateSize()`/`fitBounds()` are still required (Leaflet still needs to be told its container resized), but now they're operating on a container that's actually resizing. This does NOT touch `.dt-coverage-map`'s original rule (still `height: 420px` globally) since `DtCoverageMap.tsx` — a different component — reuses that same class and relies on its own fixed height; the override only applies inside the Explore tab's own wrapper.

Not yet re-verified live (same sandbox-shell-down situation) — same test steps as above apply, this time expected to actually pass for every district, not just Kathmandu.

### Metric tabs now also filter by what's actually nearby, + a Lalitpur crash guard (2026-07-30, same day, 3rd pass)

User confirmed fullscreen now genuinely works (screenshot: Kathmandu boundary, 442 sites, full map, no black band) and reported two more things in the same message:

**Metric tabs showed techs with zero nearby data.** With 4G/3G/2G all ticked in the filter row, searching an area with only a single 2G session still showed all 7 tabs (RSRP:4G, RSRQ:4G, SINR:4G, RSCP:3G, Ec/Io:3G, RxLevel:2G, RxQual:2G) — the tabs were filtered only by the tech-filter checkboxes, not by which techs actually had a session in the results. Fixed in `DtExploreTab.tsx`: a new `presentTechs` set is derived from `nearSessions` (the actual query result, already tech-filtered and polygon-trimmed), and `visibleMetrics` now intersects the tech-filter list with it — so only tabs for techs genuinely present in the current search area show up. Falls back to the tech-filter-only list while the sessions query is still loading or genuinely found nothing, so the tab bar isn't empty mid-search.

**Lalitpur produced a black screen (not just the earlier partial-map bug).** Unlike the earlier fullscreen sizing bug (which at least showed a partial map), this was a full crash-to-black — strongly suggesting an uncaught JS exception during render rather than a CSS sizing issue, since Kathmandu's search+fullscreen sequence worked immediately before. Root cause not pinned down with certainty (no shell/browser access this session to reproduce and read the actual console error), but the most likely candidate found by code review: `SearchAreaLayer`'s own effect (reruns on every new search, independent of the fullscreen toggle) calls `map.fitBounds(bounds, ...)` with **no error handling at all** — if that throws for any reason (e.g. a transient odd container size if the user searched while still in fullscreen from a prior district), it crashes the whole map tree with no recovery path short of a reload, which reads exactly as "black screen, stuck." Added a `try/catch` there (mirroring the one already added to `FullscreenSync`'s `fitBounds` call), plus hardened `currentBounds`'s `L.polygon(...).getBounds()` computation with a `try/catch` + `.isValid()` check. These are defensive fixes, not a confirmed root-cause fix — **if the black screen recurs, open the browser DevTools console (F12) right when it happens and send the actual error text**, since that's the fastest way to nail the real cause instead of guessing further.

Not yet re-verified live. Test: tech filter all three ticked, search an area with only one tech's session (should show only that tech's tabs); search Lalitpur, enter fullscreen, exit, search Bhaktapur without a reload in between (the exact sequence suspected of triggering the original crash) — confirm no black screen and check DevTools console for any residual errors even if the page itself stays usable.

### Lalitpur black screen — real cause found via actual console error (2026-07-30, 4th pass)

The defensive try/catch guards above did NOT fix it (correctly predicted as "not confirmed" — they wrapped the wrong call). User's own theory ("maybe boundary data is missing for some districts") led to a real, valuable side-effort: fetched `mesaugat/geoJSON-Nepal`'s older pre-2015 75-district file (`nepal-districts.geojson`, real/MIT, same repo as the original 31) and expanded `lib/nepalDistrictBoundaries.ts` from 31 to **75 of 77** real district boundaries via a one-off Node script (`generate-district-boundaries.js`, run by the user locally since the Claude sandbox's web-fetch tool caps downloads at ~72KB and its code sandbox was down all session — script reads the user's own downloaded GeoJSON, decimates each new district to ~45 points, converts `[lng,lat]`→`[lat,lng]`, merges into the existing file without touching the original 31). Eastern Rukum and Nawalpur are the only two left without real boundaries — this source predates their 2015 split from Rukum/Nawalparasi, so their combined old shape can't honestly represent either half; they correctly keep the radius-circle fallback.

But the boundary expansion did NOT fix the crash either — proving the user's own hunch about missing data, while reasonable, wasn't the actual cause. **Real cause, found from the user's DevTools console screenshot**: `Uncaught TypeError: Cannot read properties of undefined (reading 'layerPointToLatLng')` at `DtExploreTab.tsx:199`, inside `SearchAreaLayer`. That line was `circle.getBounds()`, called **before** `L.layerGroup([marker, areaLayer]).addTo(map)`. Leaflet's `Circle.getBounds()` internally does `this._map.layerPointToLatLng(...)` to project the circle's pixel radius back to lat/lng — and `this._map` is only set once Leaflet's `onAdd()` lifecycle runs, i.e. after `addTo()`. Calling `getBounds()` first meant `this._map` was `undefined`, throwing an uncaught error that crashed the whole map component (blank/black view, no recovery short of a reload). `Polygon.getBounds()` has no such dependency (pure lat/lng min/max over the polygon's own points, no map needed) — which is exactly why boundary-polygon searches (Kathmandu, Lalitpur-as-a-name once it had real data) never crashed, while any plain-circle search (raw coordinates, or — after this session's earlier fallback-simplification — any city/district without a real boundary) crashed every time. This is a much better explanation than either of the prior two guesses (transient container sizing, or missing boundary data) and is now root-cause-fixed, not just guarded:

1. `SearchAreaLayer`: reordered to add the layer group to the map first, then call `.getBounds()` on the already-attached layer (works for both Polygon and Circle now).
2. `currentBounds` (feeds `FullscreenSync`'s re-fit): replaced `L.circle(...).getBounds()` (same bug, silently swallowed by the earlier try/catch, meaning fullscreen never properly re-centered for a circle search) with `L.latLng(point).toBounds(radiusMeters)` — Leaflet's map-independent equivalent, pure geometry, no `_map` dependency at all.

The earlier try/catch guards are left in place as a second line of defense, but the actual fix is the reordering/method-swap above. Verify: hard refresh, search by raw coordinates (triggers the circle path directly) or any district without a boundary, confirm no crash and the map recenters correctly; also re-test fullscreen on a circle-shaped search now that `currentBounds` computes a real value instead of `null`.

### 5th pass, same day: crash confirmed fixed, but "lalitpur" resolved to a site, not the district

User confirmed the crash is gone (44 new districts + the getBounds/addTo fix both live), but reported: searching "lalitpur" now shows a 2km radius circle around a specific site (`KTM422-Lalitpur_Ward_No_3_Micro`, 56 nearby sites), not the real Lalitpur district boundary — "except kathmandu others are displaying radius."

Root cause: `resolveQuery`'s original order was `resolveSiteQuery(text, sites) ?? resolvePlaceQuery(text, sites)` — site matching ran FIRST and unconditionally, including a loose substring check (`site.id/name.includes(q)`). A site literally named `KTM422-Lalitpur_Ward_No_3_Micro` contains "lalitpur" as a substring, so it matched and returned before the district-boundary lookup (inside `resolvePlaceQuery`) ever got a chance to run. Kathmandu worked purely by luck — no site's name happens to contain the substring "kathmandu".

Fixed by splitting the resolution into five explicit priority tiers in `resolveQuery`: (1) raw coordinates, (2) exact Site ID/name match or ID-prefix match (`resolveSiteQuery(text, sites, false)` — a new `loose` param), (3) real district-boundary name match (`resolveBoundaryQuery`, split out of the old `resolvePlaceQuery`), (4) loose Site ID/name substring match (`resolveSiteQuery(text, sites, true)`), (5) city/district substring match against the sites list (`resolveCityDistrictQuery`, the other half of the old `resolvePlaceQuery`). A real boundary match now always outranks a coincidental substring hit on an unrelated site's name.

Not yet re-verified live. Test: re-search "lalitpur" — should now show the real district boundary outline, not a 2km site circle; also re-test a couple of the 44 newly-added districts (Chitwan, Banke, Dhading) to confirm they resolve to their own boundary and not to some unrelated site whose name happens to contain the query.

### 8th pass, same day: site/sample marker popups didn't open at all; found a real unstable-prop bug

User reported clicking a site marker or a DT sample dot did nothing — no popup, no console error — and separately noted "first click slightly moves the map." Ruled out (via actual code/CSS inspection, not guessing): no `.leaflet*` CSS overrides exist anywhere in the app (checked App.css/index.css), `refetchOnWindowFocus` is already globally disabled in `main.tsx`'s `QueryClient` (ruling out a background-refetch-driven re-render theory), `preferCanvas` is not set on this `MapContainer` (ruling out the canvas-hit-testing class of bug from [[feedback_leaflet_prefercanvas_black_tiles]]), and `NearSitesLayer`/`NearSamplesLayer`'s own props (`nearSites`, `nearSessions`) are already stable `useMemo` results.

What WAS found: `<SearchAreaLayer point={[point.lat, point.lng]} .../>` in the JSX creates a brand-new array literal on every single render of `DtExploreTab`, and that array sits directly in `SearchAreaLayer`'s `useEffect` dependency list — so React treated it as "changed" on every render, regardless of cause, tearing down and re-adding that layer's marker/area shape and calling `fitBounds()` again each time. This plausibly explains both symptoms together: the map "shifting" on click (a fresh `fitBounds()` firing), and other markers' clicks going nowhere (DOM churn on `SearchAreaLayer`'s own elements happening in the same window as a mousedown/mouseup on an unrelated marker can disrupt the browser's click-target tracking for that gesture). Fixed with a new `pointTuple = useMemo(() => point ? [point.lat, point.lng] : null, [point])`, used at the `SearchAreaLayer` call site instead of the inline array literal.

**Confidence note, stated honestly to the user**: this is a real, verified bug (not a guess) that should stop the map from thrashing/refitting constantly, which is a legitimate improvement regardless. Whether it's the COMPLETE explanation for site/sample popups never opening at all is not 100% certain — `NearSitesLayer`/`NearSamplesLayer` already had stable props before this fix, so if popups still don't work after this, the cause is something else and needs the actual click behavior re-examined (possibly via a screen recording, or testing whether popups work on a completely different, unrelated Leaflet map elsewhere in the app to isolate whether this is Explore-tab-specific).

Not yet re-verified live. Test: click a site dot or DT sample dot — does a popup open now, and does the map stop shifting on the first click? If popups still don't open, that rules out this theory and the real cause is still unknown — don't assume this fix was sufficient without confirming.

### 9th pass, same day: click-to-open popup confirmed working, but too fiddly on small dots — reverted to hover

User confirmed the popup-open bug is fixed (the unstable-array fix above worked), but reported clicking precisely on a 3-5px dot is tedious, and hover was better — this reverses the earlier UI-parity decision that specifically replaced v1's hover tooltips with click popups (see the "Real gap found... district search" entry above). All three `bindPopup()` calls in `DtExploreTab.tsx` (search-point marker, `NearSitesLayer`, `NearSamplesLayer`) changed to `bindTooltip()` with `{ sticky: true, direction: 'top', offset: [0, -4] }` — sticky mode follows the cursor while hovering, no click required. Confirmed working live by the user.

### 10th pass, same day: stop plotting grey "no data" dots on the map

User asked not to plot grey dots for samples with no value for the selected metric. `NearSamplesLayer` now skips any sample where `sample[metric.key]` is null before ever calling `bandColor()`/creating a marker for it — previously every sample was plotted regardless, with `bandColor()`'s own grey (#94a3b8) fallback used for missing values. Export (CSV/KML) behavior is unchanged — this only affects what's drawn on the live map.

### 7th pass, same day: CSV/KML export only ever contained DT samples, so a zero-session area exported nothing

User confirmed the metric-tab and boundary-priority fixes both work, then reported: exporting KML for Chitwan (0 sessions, 119 real sites, real boundary) opened in Google Earth to a totally empty globe — no boundary, no sites, nothing. Also asked for the default export filename to reflect what was actually searched instead of a generic `explore_<metric>.kml`.

Root cause: `exportCsv`/`exportKml` only ever wrote out DT sample points, filtered to the current metric's tech — the search-area shape and the nearby BTS sites (both clearly visible on the map itself) were never included. For any district with zero DT sessions, that meant an empty file by construction, regardless of how much real data (boundary + sites) the search actually returned.

Fixed both functions to export the same three things the map shows: the search point, the search-area shape (the real boundary polygon if one was used, or a 36-point circle approximation of the radius otherwise — `circleRing()`, a destination-point approximation consistent with the app's existing radius-based geometry), every nearby site, and the DT samples for the selected metric (unchanged). Filenames now use `slugify(pointLabel)` (e.g. `explore_Chitwan_District_RXLEVEL_2G.kml`) instead of a fixed generic name. Both functions' signatures changed to take `nearSites`, `point`, `shape`, and `radiusKm` in addition to the existing `sessions`/`metric` — call sites (the CSV/KML toolbar buttons) updated to match.

Not yet re-verified live. Test: export KML for a zero-session district (e.g. Chitwan) — should now open in Google Earth showing the district boundary outline and all its sites, even with no DT sample dots; export for an area WITH sessions and confirm samples still show up correctly alongside the boundary/sites; check the downloaded filename reflects the actual search term.

### 6th pass, same day: confirmed both the crash fix and the boundary-priority fix; one more metric-tab gap

User confirmed: Chitwan now shows its real boundary (119 sites) — the site-name-collision fix works. Kathmandu (1 real 2G session) correctly showed only RXLEVEL:2G/RXQUAL:2G tabs. But Chitwan, with **zero** nearby sessions, still showed all 7 metric tabs — because `visibleMetrics`'s fallback (`if (sessionsLoading || presentTechs.size === 0) return byFilter`) treated "genuinely zero results" the same as "still loading," showing the full tech-filter list in both cases. Fixed: the fallback now only applies while `sessionsLoading` is true; once the query resolves, an empty `presentTechs` means zero tabs shown, full stop — matching the user's explicit ask.

### 11th pass, 2026-07-30: DtDataManagerPage tab/card overlap fix (Session History detail view, not the Explore tab)

User reported (screenshot): in the Session History tab's single-session detail view, the RxLevel/RxQual metric tab buttons visually overlap the `report-summary-cards` row above them — a different component (`DtCoverageMap`'s host page, `DtDataManagerPage.tsx`) from all the Explore-tab work above. Confirmed via AskUserQuestion this meant "tab buttons overlap the cards," not map dots overlapping each other.

Code review of the JSX/CSS (`.report-summary-cards`, `.dt-metric-tabs`, `.dt-coverage-map-wrap`) found no obvious absolute-positioning or negative-margin bug — the likely mechanism is CSS margin-collapsing between the two adjacent block elements. Rather than keep guessing at the exact collapse trigger, applied a defensive, non-speculative fix: wrapped the cards + `<DtCoverageMap>` pair in a `<div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>` and set `margin: 0` on the cards row, so spacing comes from flex `gap` (immune to margin-collapse) instead of `margin-top`/`margin-bottom`. **Not yet confirmed live** — needs a hard refresh + a re-check of that exact screen.

### Nearby-site (~1km) tagging for DT sessions, 2026-07-30

User asked: "while saving the session nearby sites around 1km tagging is missing. through this tag, it will be easier for future search also." Confirmed scope via AskUserQuestion: the tag should be **both** visible in the Session History table and searchable/filterable, and **existing sessions should be backfilled too**, not just new uploads going forward.

Backend (`core/serializers.py`): added `_nearby_site_ids(sample_points, radius_km=1.0)` — bounding-box-prefilter-then-haversine, same pattern already used by `drive_test.py`'s `near()` endpoint, duplicated (not imported) since `drive_test.py` imports from `serializers.py` and importing back would be circular. Sample points are deduped to a coarse ~100m grid first (a session can have tens of thousands of samples; only "is this site within radius of at least one point" is needed, not a per-sample distance). `DriveTestSessionWriteSerializer.create()` now computes this at save time and stores it as `meta['nearby_site_ids']` — inside the existing flexible `meta` JSONField, not a new DB column, deliberately avoiding a migration given `DriveTestSession.meta`'s own docstring already establishes this "add keys to the blob while the shape is evolving" pattern (and the sandbox shell had no working Docker access all session, making a migration risky to test). Zero serializer-shape changes needed for this to reach the frontend — `meta` was already in `DriveTestSessionListSerializer`'s fields.

Backfill: new management command `core/management/commands/backfill_nearby_sites.py`, following the existing `take_kpi_snapshot.py`/`seed_legacy_data.py` style. Walks every existing `DriveTestSession`, recomputes `nearby_site_ids` from that session's real stored samples, and updates `meta` in place (`--dry-run` prints counts without saving). Idempotent — safe to re-run after a GPS re-import to refresh stale tags, not just once.

Frontend (`DtDataManagerPage.tsx`): added a `siteNameById` lookup (from the already-loaded `useSites()` data, so display always reflects current site names, never a stale snapshot), a `nearbySiteLabels()` helper, a new "Nearby Sites" column in the Session History table (shows up to 2 resolved names + a "+N" overflow, full list in a hover title, "—" with an explanatory tooltip for sessions saved before this feature and not yet backfilled), and a client-side search box (`historySearch` state, `visibleSessions` memo) matching session name OR any tagged site's id/name — no backend query param, since session lists are small.

**Not yet run/verified**: the `backfill_nearby_sites` command has not been run against real data yet (needs `docker compose exec django python manage.py backfill_nearby_sites --dry-run` first to sanity-check the count, then without `--dry-run` for real), and the new column/search box have not been checked live in the browser.

### 12th pass, 2026-07-30: the flex-gap overlap fix from the 11th pass didn't work — real cause was a different bug I introduced in the same turn

User tested and reported the overlap was still there, with a screenshot showing the Session History left-side table's "Nearby Sites" column header and the right panel's metric tabs (RSCP/Ec-Io) + a Delete button all visually colliding in the same horizontal band.

Real cause: adding the "Nearby Sites" column (10th pass work, same session) made the left sidebar `<table>` wider than its `360px` CSS Grid track. Neither the table nor its wrapping `<div>` had any overflow handling, and a CSS Grid item's automatic minimum width defaults to its content's min-content size — so the whole 360px track (and the table inside it) grew past 360px and visually bled into the right-hand detail panel's space. The 11th pass's flex-gap fix addressed a *different*, plausible-sounding hypothesis (margin-collapse between the cards and tabs) that was never the actual mechanism; it's now understood to have been the wrong theory, not just unconfirmed.

Fixed properly this time: wrapped the table in `.report-table-wrap` (`overflow-x: auto`), an overflow-scroll container this codebase already uses for wide `admin-table`s in the Phase 3 reporting suite — and added `minWidth: 0` to the left grid item `<div>` (without this, `overflow-x: auto` on a descendant doesn't actually kick in, since the grid item itself still sizes to its content's min-content width first). Not yet re-verified live.

### 13th pass, same day: Explore tab KML export — real bug, not the same one from the 7th pass

User attached a Google Earth screenshot showing a scattering of pin labels reading "No data", "0", "2.09999990463257", "3.09999990463257" cluttering the Koteshwor/Jadibuti area — this is a different bug from the 7th pass's "export was empty for zero-session districts" fix; this one is about *what* gets exported for real DT samples, not whether anything gets exported at all.

Root cause: `exportKml`'s sample loop (a) never skipped null-metric samples (exported every one as a `<Placemark><name>No data</name>`, unlike the live map's `NearSamplesLayer`, which the user had already asked to stop plotting grey no-data dots for, 10th pass — the export path was never given the same fix), and (b) used the raw unrounded float value as the `<name>`, and Google Earth renders `<name>` as a permanent on-map text label for `<Point>` placemarks by default — hundreds of overlapping floating-point numbers.

Compared directly against v1's own real KML export (the user's attached reference file, `rsrp_search_KTM401_BishwamitraMarg_KTM401_.kml`): v1 never emits a placemark for a null sample, and draws each sample as a small filled `<Polygon>` "dot" (not a `<Point>` pin) with a `<Style>` containing `<LabelStyle><scale>0</scale></LabelStyle>`, which suppresses the on-map label entirely while keeping `<name>`/`<description>` available for when a dot is clicked. Rewrote `exportKml` to match: skip null-metric samples, generate a small ~10m-radius polygon "dot" per sample (reusing `circleRing`, the same destination-point approximation already used for the search-area circle), one `<Style>` per distinct band color (deduped, not one per sample), round the displayed value to 1 decimal, and group sites/samples into `<Folder>`s the way v1's reference file does. Also applied the same null-skip to `exportCsv` for consistency (a "no data" row added nothing useful to the spreadsheet either). Not yet re-verified live — needs a real KML export opened in Google Earth to confirm it now looks like the attached reference.

### 14th pass, same day: user confirmed overlap fixed, asked for resizable/collapsible panels + a topbar menu toggle

User confirmed the 12th pass's real fix (report-table-wrap + minWidth:0) resolved the overlap. Follow-up ask, clarified via AskUserQuestion (drag-resize vs. collapsible-sidebar vs. auto-grow — user picked more than one): "drag to resize divider in left sidebar, but also need collapsible right sidebar toggle and topbar menu toggle."

Three separate, additive UI changes, all code-complete, none yet verified live:

1. **Drag-to-resize divider** — Session History's left session-list / right detail-panel split switched from a fixed CSS Grid (`360px 1fr`) to a flex row with a stateful `historyLeftWidth` (px, default 360, clamped 220-720) and a draggable `.dt-history-resize-handle` between them. Plain `window` mousemove/mouseup listeners (no drag library), added in `onHistoryResizeMouseDown` and removed in `onHistoryResizeMouseUp` — both reference the same closures from a single render pass so cleanup is self-consistent without needing `useCallback`/refs for the handlers themselves.

2. **Collapsible right panel** — separate `historyRightCollapsed` boolean, independent of drag-resize. A "Hide panel ▸" button collapses the detail panel entirely; a thin `.dt-history-expand-tab` button appears in its place to bring it back. When collapsed (or when nothing is selected at all), the left session-list panel's width formula falls back to `100%`, directly answering the user's "right part is unused… can use that area also" — the previously-dead space is now reclaimed automatically whenever the detail panel isn't shown, not just before a session is ever selected.

3. **Topbar menu toggle** — app-wide, in `Layout.tsx` (not DT-page-specific): the horizontal `app-nav` link row (~11 links across all phases) now has a `☰` toggle button (`navOpen` state, default open) that hides/shows the whole row.

### 15th pass, same day: the Hide Panel button wasn't the actual "unused right side" the user meant — a real dead-space bug at the page level

User confirmed the topbar toggle is fine, but circled the *actual* problem in a screenshot: on a wide monitor, there's a large black dead zone to the right of the map — well outside the detail panel entirely, at the page's own outer edge. Said the Hide Panel button (14th pass) is "good but useless here."

Real cause: `DtDataManagerPage.tsx`'s outer wrapper had `style={{ maxWidth: 1300 }}` (only this page and `RfAuditPage.tsx` override the shared `.admin-page` class's 1100px default). On any monitor wider than ~1300px + padding, that cap starves the whole flex row — table + resize handle + detail panel — of the real available width, even though the detail panel already has `flex: 1` and would happily fill more space if given it. Fixed by dropping the cap to `maxWidth: 'none'` for this page only (other `.admin-page` pages keep their 1100px default deliberately — they're narrow forms/tables, not a wide map+table dashboard). No new toggle needed for this — flex's own `flex: 1` does the "expand to fill" automatically once nothing artificial is capping the outer container.

Left-side ask ("draggable to resize, if content is available") is already covered by the 14th pass's `.dt-history-resize-handle` — no additional change made there. Not yet re-verified live.

### 16th pass, same day: same drag-resize pattern requested for the Sites page's tree sidebar

User pointed at the Sites page (`SitesPage.tsx`/`SidebarTree.tsx`) next, asking for the same draggable resize already built for DT History, and separately noted v1's sidebar tree also had inline search/edit/add-sector actions per site row that v2's read-only tree doesn't have yet.

Implemented the resize half directly (`.sites-sidebar`'s old fixed `width: 300px` replaced with state-driven `sidebarWidth`, same drag-handle pattern as DT History — plain window mousemove/mouseup, clamped 220-640px). The search/edit/add-sector parity gap is real (v2's `SidebarTree.tsx` is currently read-only, no search box, no per-row action icons) but is a genuinely bigger feature with real design choices (inline modal vs. navigate to the existing `SiteDetailPage`, which already has edit + "+ Add sector" — see `addSector()` there) — asked the user to scope it before building rather than guessing.

**Also fixed proactively, not yet reported as broken but a predictable regression**: Leaflet caches its container's pixel size and has no way to detect a CSS-driven resize (like the new drag handles) on its own — without a fix, dragging either the Sites sidebar or the DT History divider would leave the map showing grey/missing tile bands sized for the old container until the next pan/zoom. Added a shared `useMapInvalidateOnResize()` hook (`lib/useMapInvalidateOnResize.ts`, ResizeObserver-based, general — doesn't care why the container resized, so it also covers plain window resizes) and wired it into all four Leaflet map components in the app: `MapView`, `DtCoverageMap`, `DtExploreTab`, `DtCompareMap`. None of this has been tested live yet.

### 17th pass, same day: Sites tree search + edit + add-sector icons — scope confirmed via AskUserQuestion

User confirmed scope for the v1 feature-parity gap flagged in the 16th pass: tree row icons should **navigate to the existing `SiteDetailPage`** (`/sites/{id}`) rather than building new inline modals — reusing what already works instead of a second implementation of edit/add-sector.

Built:
- `SidebarTree.tsx`: added a search input (`sidebar-tree-search`) above the virtualized list. Non-empty query switches to v1's own established convention — flat mode, no hierarchy (`buildFlatSearchRows`), matching id/name/city/district but deliberately **not** `region` (same reasoning as CLAUDE.md's existing `_siteMatchesQ` note: matching on region text risks a false cross-province match). Each site row now also has ✎ (Edit) and + (Add sector) icon buttons, gated behind the same `isAllowed(user.role, user.permissions.sites, 'update')` check `SiteDetailPage` itself already uses (so a viewer-role user doesn't see icons that would just 403). Icons `stopPropagation()` so clicking them doesn't also trigger the row's own `selectSite()`.
- Edit navigates to `/sites/{id}?edit=1`; Add Sector navigates to `/sites/{id}?addSector=1`.
- `SiteDetailPage.tsx`: new `useEffect` (placed above the early returns — hooks must run unconditionally) reads those query params once the site has loaded, calls the equivalent of the existing `startEdit()` (and, for add-sector, also pre-appends one empty sector row via the same `emptySector` template `addSector()` already uses, then scrolls the Sectors section into view via a new `sectorsSectionRef`), then strips the query params from the URL (`replace: true`) so a refresh or back-navigation doesn't re-trigger it.

Not yet verified live — needs a real click-through: search filtering, both icons from a few different rows, and confirming the URL params are gone after landing on the detail page.

### 18th pass, same day: selected site invisible on the map — two real bugs, one of them latent from before this session

User reported selecting a site (via tree or search) gave no visual indication on the map of which pin was selected — "hovering many" still couldn't find it. Two real causes found by reading `MapView.tsx`, not guessed:

1. No highlight ever existed at all — `ClusteredMarkers` gives every site the same plain blue `defaultIcon`, selected or not.
2. Latent bug, unrelated to anything built this session: `FlyToSelected` flies to `Math.max(map.getZoom(), 13)`, but `ClusteredMarkers` sets `disableClusteringAtZoom: 14` — 13 is *below* that threshold, so selecting a site from a zoomed-out view could fly to a zoom level where that site's marker is still folded into an unopened cluster bubble, with no individual pin to find no matter how long someone hovers.

Fixed both: raised the fly-to target to 15 (safely past the clustering threshold), and added a `SelectedHighlight` component — a pulsing gold-ring `L.divIcon` marker drawn at the selected site's exact coordinates, added directly to the map (not into the cluster group), so it renders identically whether or not the real marker underneath happens to be clustered. Not yet verified live.

User also referenced v1's Topology Map (a separate page — province/district/site/all-Nepal scope-gated view with status-colored circles, not yet ported to v2 at all) as a style reference, but said "display style after selection is of like v2" — read as wanting v2's current look kept, with v1's Topology Map only as inspiration for *how selection should look*, not a request to port that whole page. Asked the user directly to confirm before starting anything that size.

### 19th pass, same day: Topology Map ported to v2 — confirmed via AskUserQuestion ("Yes, port it now")

Read `project_topology_map_and_session_reset` memory (v1's own multi-round implementation history) before building anything, per CLAUDE.md's "research v1's real implementation first" rule. That history is a long chain of real bugs, nearly all caused by ONE root pattern: v1 shares a single tree/click-handler codepath between the normal KPI dashboard and Topology, gated by a `topologyViewActive` boolean that had to be checked in every entry point by hand — and at least one entry point (`selectSiteTree`, the sidebar's *actual* onclick target) went a full round without the check, so "click a site in the tree" silently did nothing while looking identical to a working build. Decided up front NOT to repeat that architecture in v2: Topology got a fully separate page/component tree (`TopologyPage.tsx`, `TopologyTree.tsx`, `TopologyMap.tsx`), not a shared one branched by a flag — React Router's per-route components make two small components safer than one component with a hidden mode switch.

**New files:**
- `lib/statusColor.ts` — `STATUS_COLOR`/`STATUS_LABELS`/`STATUS_ORDER`, pulled out of `SidebarTree.tsx` (which used to have its own inline copy) so Topology's filter chips use the exact same status vocabulary (`ok`/`warn`/`crit`/`nodata`, matching `Site.status`) instead of a second hand-copied table.
- `components/TopologyTree.tsx` — forked from `SidebarTree.tsx`, own **local** expand state (deliberately not the shared `useTreeStore` the Sites page uses — Topology's "scope" concept, possibly many sites at once, is fundamentally different from Sites' single `selectedSiteId`, and sharing state would cross-contaminate the two pages). Province/district row clicks both toggle expand AND set the map scope to every site under that row (matching v1's final tree-linked design, per the memory's "replaced the manual scope dropdown with direct tree-click linking" entry — v1 tried a separate dropdown first and the user explicitly rejected it). A pinned "NTC — All Sites" row sits above the scrollable/searchable list. Search reuses the same flat-mode-excludes-region convention as `SidebarTree`/DT History.
- `components/TopologyMap.tsx` — status-colored `L.circleMarker`s (not `L.marker`/clustering like the plain Sites map) — v1's own performance fix for ~4,700 markers was scope-limiting, not clustering, and `preferCanvas` + vector circleMarkers scale fine even for the full "All Sites" scope without needing a second clustering system just for this page (CLAUDE.md's MarkerCluster rationale is specifically about per-marker DOM/image icons, which don't apply to circleMarkers). Status filter chips (All/OK/Warning/Critical/No KPI), Fit Nepal button, satellite/street toggle, fullscreen (same real Fullscreen API + `fullscreenchange` listener pattern as `DtExploreTab.tsx`, same "drive size via a wrapper div, never a reactive MapContainer `style` prop" lesson from this session's earlier fullscreen bug). Popups are raw HTML strings (site name/id/district/region/type/tech/status), with a "View site detail →" button wired up imperatively on `popupopen` to call a real `useNavigate()` (client-side route change, not a plain `<a href>` reload).
- `pages/TopologyPage.tsx` — page shell: same drag-to-resize sidebar as Sites/DT History, a "📍 Showing: X — N sites" status line, and the scope-selection logic (clicking a site already in the loaded scope just highlights it there; clicking one outside any loaded scope loads it as a fresh single-site scope — mirrors v1's final behavior after its own several iterations).

**Deliberate scope reduction vs. v1**: v1's original topology popup included the full sector list + live KPI numbers, because v1 already holds the complete site record in memory. v2's `SiteListItem` (the list-endpoint's lightweight shape) doesn't carry sectors/KPI fields — fetching those per-marker for a scope that can be ~4,700 sites would mean thousands of extra API calls. Kept the popup to what's already available (name/id/location/status) with a link to the real detail page instead.

Route `/topology`, nav link added to `Layout.tsx` right after Sites, ungated (same as Sites itself — no per-role permission key exists for this view, it's just an alternate lens on the same Site data). **Not yet verified live at all** — this is a brand-new page, needs a full click-through: all 4 scope-selection paths (all/province/district/site), status filter chips, both tile layers, fullscreen, Fit Nepal, and the popup's detail-page link.

### 20th pass, 2026-08-04: map-based site add/relocate/delete, on both the Sites map and the Topology map

User request: "add edit, update, delete of site related details directly through the map. like feature of adding missing place with name with lat long directly through the click in map in the system. relocating the location of site etc." Clarified via AskUserQuestion: applies to **both** `MapView.tsx` (Sites page) and `TopologyMap.tsx` (Topology page), and a relocate-by-drag must **confirm before saving** (not autosave on drop).

**Shared building blocks (new files):**
- `api/queries.ts` — `useRelocateSite(siteId)`, a `PATCH /api/v2/sites/{id}/` mutation sending only `{lat, lng}`. Deliberately **not** reusing the existing `useUpdateSite` (PUT): `SiteWriteSerializer`'s own docstring warns a PUT that omits an optional field clears it to null — using PUT for a lat/lng-only relocate would silently blank every other field on the site. Backend already supports PATCH for this without any change — `SiteViewSet.get_permissions()` already gates `partial_update` (PATCH) identically to `update`/`create`/`destroy` via `IsAdminOrSuperadmin`.
- `components/AddSiteModal.tsx` — small form (id/name/region/district/city/lat/lng) pre-filled with the clicked map coordinates, `useCreateSite()`.
- `components/RelocateConfirmModal.tsx` — shows old vs. new coordinates, confirm button calls `useRelocateSite`.

**Per-page wiring (`SitesPage.tsx` + `MapView.tsx`, `TopologyPage.tsx` + `TopologyMap.tsx`, symmetric on both):**
- A "+ Add Site" toggle arms click-to-add mode; the next map click opens `AddSiteModal` pre-filled with that lat/lng.
- Existing markers become draggable when the user has `update` permission on the `sites` CRUD menu (`isAllowed(user.role, user.permissions.sites, 'update')` — same key `SiteDetailPage`'s own edit gate already uses, so the map never offers an action the detail page would reject). On `dragend`, the marker snaps back to its original position immediately and `RelocateConfirmModal` opens with old/new coordinates; the marker only actually moves once the modal's save succeeds, because `useRelocateSite`'s cache invalidation refetches `sites` and the marker-drawing effect rebuilds from the fresh data — no separate "revert on cancel" code path needed.
- Delete: a Delete button (Sites page: in the selected-site quickview panel; Topology: inside each marker's popup, wired up imperatively via a `popupopen` listener since popup content is raw HTML, not React) behind a `confirm()` dialog and the `delete` permission key.

**Real bug caught before it reached the user**: `TopologyMap.tsx`'s markers were `L.circleMarker`s (chosen originally for perf on large scopes, see 19th pass). Core Leaflet's `CircleMarker`/`Path`-family layers have **no built-in drag support at all** — `draggable: true` is silently ignored; real drag only exists on `L.Marker`, or via the separate `Leaflet.Path.Drag` plugin (not installed here). Found while wiring up the relocate feature, not from a "dragging does nothing" report. Fixed by adding `statusDivIcon()` — an `L.divIcon` styled as a small colored circle — and switching `ScopeMarkers` from `L.circleMarker` to `L.marker` + that icon, preserving the exact same visual while gaining real drag support.

**Second refactor, done proactively while wiring `TopologyPage.tsx`**: its `Scope` state used to store a frozen `sites[]` snapshot captured at the moment a tree row was clicked. That would have gone stale the instant a site inside the loaded scope was added/relocated/deleted through the map — e.g. a deleted site would keep showing on the map until the user happened to re-click the same tree row. Changed `Scope` to a small selector (`{type: 'all'|'province'|'district'|'site', ...}` describing *what* was picked) with the actual `sites` array now re-derived via `useMemo` from the live `useSites()` data on every render. `TopologyTree`'s callback props changed to match (`onSelectProvince(province: string)`, `onSelectDistrict(province, district)` — passing names instead of a row's own stale `sites` snapshot); `SitesPage.tsx` didn't need this fix since it never held a scope snapshot to begin with (Sites always shows the full site list, filtered only by search).

**Verified so far**: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` run in the sandbox — zero errors across the whole frontend, including the `TopologyTree` signature change. **Not yet click-tested live** — needs: add-site on both pages, drag-relocate-confirm on both pages (including confirming the marker snaps back correctly on Cancel), delete on both pages, and confirming a relocate/delete/add immediately reflects in an already-loaded Topology scope without needing to re-click the tree row.

### 21st pass, 2026-08-05: Topology folded into Sites, logout hard-reload, Compare Sessions rebuilt around real metric types, stale permission row removed, first perf pass

User's own words: "use concept of NTC all sites, region wise, district wise selection of topology in sites map without affecting the display theme of sites map as attached. if this is done then we do not need topology. rename top menu 'sites' as 'sites topology'." Plus three more asks in the same message: (2) logout→login should land in a fresh state, not the previously-open one; (2b) Session Comparison should use real per-type metric tabs like Explore instead of one blended average; (3) update the menu/role permission matrix to match; (4) a general efficiency/performance pass. All five done in one session, in this order:

**1. Topology's scope concept folded into the Sites map, Topology page retired.** `SidebarTree.tsx` gained a pinned "NTC — All Sites" row plus province/district row clicks that now do double duty (still toggle expand/collapse AND set the map's scope) — same dual-purpose click pattern `TopologyTree.tsx` used. `SitesPage.tsx` gained the same live-derived `ScopeSelector` (`{type:'all'|'province'|'district'|'site',...}` re-derived via `useMemo` off `useSites()`, not a frozen snapshot — same staleness fix already applied to `TopologyPage.tsx` in the 20th pass) and passes `scope.sites` (not the full list) to `<MapView>`. Critically, **`MapView.tsx` itself was not touched at all** — same clustered plain-blue-marker rendering, same gold selected-site ring, same drag-relocate/click-to-add — only the `sites` array it's handed got smaller. A small floating `.sites-scope-status` badge (top-left, same "absolute over the map" convention as the existing `.map-add-toggle`/`.site-quickview`) shows what's currently loaded. Confirmed via `tsc --noEmit`: zero errors.

`/topology` route now redirects to `/sites` (`<Navigate to="/sites" replace />`) rather than 404ing on an old bookmark. `TopologyPage.tsx`/`TopologyMap.tsx`/`TopologyTree.tsx` are left in the repo but unreferenced by any route — physically deleting them would need `allow_cowork_file_delete` permission for a workspace-folder file, not requested up front, so they're just dead code for now. Nav link renamed `Sites` → `Sites Topology` in `Layout.tsx`; page header in `SitesPage.tsx` renamed to match.

**2. Logout now hard-reloads instead of just clearing `user` state.** Root cause: tokens were moved into `sessionStorage` back on 2026-07-30 (so a normal page refresh keeps you logged in), which fixed accidental logouts but had a side effect nobody had hit yet — `AuthContext.tsx`'s `logout()` only ever called `clearTokens()` + `setUser(null)`, leaving every other piece of client state (Zustand's `useTreeStore` — expanded nodes, selected site, and now the map scope too; DT Data Manager's active tab and session-history selections; any other page-local `useState`) sitting untouched in the JS heap, since none of it was ever actually tied to the auth session. Logging back in just re-populated `user` on top of whatever was already there. Fixed by making `logout()` do `window.location.href = '/login'` — a real navigation wipes the entire JS heap, which is the only thing that actually guarantees a clean slate. This also affects the idle-timeout path (same `logout` function), which is consistent with v1's own logout/idle-timeout behavior (hard-reload) per `project_topology_map_and_session_reset` memory, not a new UX pattern for this codebase.

**3. Session Comparison rebuilt around real per-tech metric types.** `DtCompareMap.tsx`'s original version (built in Phase 4d) hardcoded `sample.rsrp` everywhere and one generic "Avg (dBm)" stats column — numerically not wrong (this codebase's `rsrp` field always holds whatever the tech's own primary signal reading is: true RSRP for 4G, RSCP for 3G, RxLevel for 2G — see `dtBands.ts`'s `metricsForTech()`), but mislabeled non-4G sessions and offered zero way to compare secondary metrics (RSRQ/SINR/Ec-Io/RxQual) or pick a metric at all. `ALL_METRICS`/`TaggedMetric`/`ALL_TECHS` (the tab set `DtExploreTab.tsx` already built — "RSRP:4G", "RSRQ:4G", "SINR:4G", "RSCP:3G", "Ec/Io:3G", "RxLevel:2G", "RxQual:2G") were moved into `dtBands.ts` so both components share one definition instead of risking two drifting copies; `DtExploreTab.tsx` now imports them instead of defining its own. `DtCompareMap.tsx` gained the same tab row, computed from the union of techs actually present among the checked sessions, and its stats table's "% Poor" column — previously a hardcoded `< -95` cutoff that only made sense for RSRP/RSCP's own scale — is now `isPoorBand()` (new `dtBands.ts` export): "the value's band color is one of the red shades every band table already uses for a bad reading," which holds up across all 5 band tables including RXQUAL_BANDS' inverted (low-is-good) scale, without needing a per-metric best/worst-direction flag. Per-session identity (which dot is which of the up to 4 checked sessions — the actual point of a *comparison* view, unlike Explore's single-dataset map) is now a marker OUTLINE color (`SESSION_HUES`, same 4 base hues as the old `COMPARE_PALETTES`) separate from the FILL color, which is the real metric band color — so a dot now shows both "which session" and "how good" at once instead of one gradient trying to do both jobs. A session whose tech doesn't match the selected tab shows greyed "no data for {tag}" in its stats row instead of a stale/wrong number, mirroring how `DtExploreTab`'s own map layer already skips non-matching sessions. Confirmed via `tsc --noEmit`: zero errors.

**4. Stale `topology` permission row removed from `PermissionsPage.tsx`.** It gated nothing real even before today — `Layout.tsx`'s old `Topology` NavLink was never actually wrapped in an `isAllowed()` check, kept only for v1-schema parity — and now that the page itself is gone, removed from `SIMPLE_MENU_KEYS` entirely rather than leaving a checkbox that does nothing. Any `menu_key='topology'` rows already sitting in a deployed database are harmless leftovers, not worth a migration to clean up. `CRUD_MENU_KEYS`'s `sites` row label updated to "Sites Topology" for consistency with the nav rename. Backend's `CRUD_MENUS` set (`core/serializers.py`) was checked — `'topology'` was never a member, nothing to change there.

**5. First efficiency/performance pass.** Backend audit first (`SiteViewSet`/`SiteListSerializer`/`SiteDetailSerializer` in `views.py`/`serializers.py`): already deliberately lean for the ~4,700-site hot path — the list endpoint's serializer excludes sectors/KPI fields entirely (a documented Phase-1 decision, not something built today), and the one place sectors ARE nested (`SiteDetailSerializer`) only ever serializes a single site (`retrieve`), so there's no N+1 there to fix. Frontend got two real changes: (a) `App.tsx` converted every route except `/login` and `/sites` to `React.lazy()` + a `<Suspense>` boundary — before this, the initial bundle included every admin/reporting page's code up front, most expensively `DtDataManagerPage` (Leaflet + several map components + CSV/XLSX/TRP parsing, none of which a user who only ever looks at the Sites map was paying to download); (b) `main.tsx`'s `QueryClient` got a default `staleTime: 30_000` (previously unset = 0, meaning every query without its own explicit staleTime — Thresholds/Tree/Users/Permissions/etc. — refetched on every single remount even with `refetchOnWindowFocus` already off) — per-query overrides like `useSites()`'s existing `60_000` still take precedence.

**Verification status**: `tsc --noEmit` clean after every step above (checked incrementally, not just at the end). `vite build` could not be run in the sandbox to confirm the lazy-loaded routes actually split into separate chunks — the sandbox's `node_modules/rolldown` is missing its native binding (`Cannot find module '@rolldown/binding-linux-x64-gnu'`, a documented npm optional-dependency bug, unrelated to this session's code) — this needs a real `npm run build`/`docker compose up --build` on the user's machine to confirm chunk-splitting actually happened and to click-test all 5 items above, none of which have been exercised live yet.

### 22nd pass, same day: Compare Sessions rebuilt AGAIN — real multi-panel grid, not a tab switcher

User confirmed the 21st pass's fix worked as designed (screenshot showed EC/IO:3G selected, correctly plotting only the 3G session and showing "no data for Ec/Io:3G" for the 4G one) — then attached v1's own real reference screenshot: a 3-panel small-multiples grid (Serving Cell RSRP / RS SINR / RSRQ, one map each, shown simultaneously, each with an inline legend listing per-band point counts right next to the swatch) and asked: "if possible display making multiple view panel for selected sessions. if not then no need to display it on map, display it as attached."

Read as: don't settle for a single map + tab switcher (21st pass's version) if a real multi-panel layout is achievable — and it is, so `DtCompareMap.tsx` was rewritten a second time the same day. Dropped the `metricTag`/tab-row state entirely; now renders one `<MetricPanel>` (its own small `<MapContainer>` + inline per-band-count legend) for every DISTINCT metric tag present across the checked sessions' techs — comparing two 4G sessions produces 3 panels (RSRP/RSRQ/SINR), each overlaying both sessions together; comparing a 4G + a 3G session produces 5 panels total, each panel only plotting whichever session(s) actually have that tech. This is strictly better than the tabs version for the original complaint too: every metric is visible at once instead of one-at-a-time behind a click, and there's no more "no data for X" placeholder state to design around — a panel for a metric with no matching-tech session among the current selection simply isn't rendered at all (`visibleMetrics` already excludes it).

Per-panel legend now shows point counts per band (`bandCounts()`, new helper) instead of a separate stats table below the grid — matches the reference's own style, where the legend doubles as the stats display. The separate `admin-table` (Avg/Min/Max/%Poor per session) from the 21st pass was removed; per-session identity is still visible via each dot's outline color (`SESSION_HUES`) plus a "Session (dot outline)" legend row shown once above the whole grid, not per panel. `isPoorBand()` (added in `dtBands.ts` during the 21st pass) is now unused by this file but left in place — it's a small, real, potentially-reusable helper, not worth removing over one call site going away.

New CSS: `.dt-compare-grid` (`repeat(auto-fit, minmax(360px, 1fr))`, matching the reference's roughly-2-column layout without a hardcoded count), `.dt-compare-panel`/`.dt-compare-panel-title`/`.dt-compare-panel-map`/`.dt-compare-panel-legend`/`.dt-compare-panel-legend-row`/`.dt-compare-panel-legend-count`. `tsc --noEmit`: zero errors. Not yet click-tested live.

### 23rd pass, same day: Compare Sessions dots weren't actually showing their band colors

User ran the 22nd pass's build and sent a real screenshot: every dot across all 3 panels rendered as flat solid blue, even though each panel's legend clearly listed 5 distinct band colors with real counts (188/512/406/401/141 etc.). Feedback: "do not use plain dot outline. plot its actual plot value with color in index as we display in explore."

Root cause, confirmed by re-reading the 22nd pass's own `CompareDots`: each `L.circleMarker` was drawn at `radius: 4` with a `weight: 2` colored OUTLINE (the per-session hue) around a `fillColor` set to the real metric band color. At that radius, a 2px stroke consumes most of the visible circle — the tiny inner fill area reads as indistinguishable from the outline color at normal zoom, so every dot LOOKED like a flat session-hue circle regardless of its actual value, even though the underlying `fillColor` really was set correctly per point.

Fixed by dropping the per-session outline from dot rendering entirely and matching `DtExploreTab`'s `NearSamplesLayer` styling exactly: `radius: 3, weight: 0` (no stroke at all), `fillColor`/`color` both set to `bandColor(metric.bands, v)`. A dot now always reads as its real value's color, full stop. Session identity — which mattered specifically because this is a *comparison* view — moved out of dot styling entirely: it's still in each dot's tooltip on hover, and the "Sessions" list above the grid (previously "Session (dot outline):") now just text-colors each session's name via `SESSION_HUES` rather than showing an outline swatch that no longer corresponds to anything drawn. `tsc --noEmit`: zero errors. Not yet re-verified live with a real screenshot after this fix.

### 24th pass, 2026-08-05: Sites Topology map never re-fits when the tree scope changes; Compare Sessions dot-color bug re-reported was a stale build

Two items in one user message, both with screenshots:

**1. Real bug, fixed.** User's screenshot showed "Showing: Bhaktapur, Central — 91 sites" in the status line, but the map viewport was still centered on a completely different area (Bara district — a golden selected-site ring for a CDR001/Bara site was floating in frame, left over from an earlier click), only correcting itself once the user manually panned to Bhaktapur. Root cause, confirmed by re-reading `MapView.tsx`: it had ZERO viewport-fitting logic at all — the 21st pass's scope-selection feature only ever changed which markers `ClusteredMarkers` draws, never told the map to actually re-frame them. (`TopologyMap.tsx` already has exactly this via its own `FitToScope` component; `MapView.tsx` was simply never given the equivalent when scope filtering was added to it the same day.) Fixed by porting that same `FitToScope` pattern into `MapView.tsx` — a new `scopeKey?: string` prop, fed by `SitesPage.tsx`'s `scope.key`, drives a `FitToScope` effect that only fires on a genuine scope change (not on every render/selection), fitting to real site bounds with a fallback to all-Nepal bounds if a scope somehow has zero geocoded sites. `scopeKey` is optional on `MapView`'s props so any other future caller that doesn't pass it just keeps the old "never auto-refit" behavior rather than breaking. `tsc --noEmit`: zero errors.

**2. Not a new bug — stale build.** User's second screenshot of Compare Sessions still showed the exact pre-23rd-pass symptoms (flat-blue dots, AND the legend literally still read "Session (dot outline):" with outline swatches) — both of those strings/behaviors were already removed in the 23rd pass earlier the same session. This screenshot is from before that fix was rebuilt into a running container; told the user to rebuild (`docker compose up --build`, or at minimum rebuild+restart the `frontend` service and hard-refresh the browser) rather than treating it as a second occurrence of the same bug.

### 25th pass, 2026-08-05: Band Colors — new admin feature, add/edit/delete/recolor coverage bands, fully backend-verified

User confirmed the 23rd pass's dot-color fix worked (real screenshot showing correct graduated colors per panel), then asked for a new capability: "add a feature to add, edit, delete index details/legend to display in map and changing color also." Clarified scope via AskUserQuestion before building anything (per this app's established discipline for anything this size): **shared/server-saved** (not per-browser localStorage), a **dedicated new admin page**, editable by **superadmin or admin**.

This is the first genuinely v2-only feature in this app with **no v1 schema to mirror at all** — v1's coverage bands (`RSRP_BANDS`/`RXLEV_BANDS`/`RSRQ_BANDS`/`SINR_BANDS`/`ECIO_BANDS`/`RXQUAL_BANDS`) are hardcoded JS constants in `bts_monitor.html`, never a DB-backed or user-editable concept there. Built as a genuinely new, standalone feature rather than trying to force-fit it into any existing v1-parity pattern:

**Backend** (`core/models.py`, `core/views.py`, `core/urls.py`):
- New `DtBand` model — `metric_tag` (e.g. "RSRP:4G", matching the frontend's existing `TaggedMetric.tag` string exactly), `label`, `min_value`, `max_value`, `color`, `sort_order`. Deliberately keyed by the full TAG, not just the raw sample field (`rsrp`/`rsrq`/`sinr`/`ecno`/`rx_qual`) — today RSRP:4G and RSCP:3G happen to share identical default bands, but an admin should be able to diverge them independently going forward.
- Migration `0007_dtband` (`makemigrations`-generated, not hand-written — this app's own established rule after the `feedback_hand_guessed_index_names_break_migrate` incident) + a follow-up data migration `0008_seed_dtband_defaults` that seeds all 46 rows across the 7 metric tags (5+5+5+7+7+9+8) from today's hardcoded band tables, transcribed exactly so behavior is byte-for-byte unchanged until an admin actually edits something. Idempotent (`if DtBand.objects.exists(): return`) so re-running it is a safe no-op.
- `DtBandsView` (GET/PUT `/api/v2/dt-bands/`) — GET returns `{tag: [{label,min,max,color}]}` for any authenticated role (every DT map needs this to render); PUT is a **full replace per tag** (delete-and-recreate, same contract shape as Site's sector list and Tree's folder structure elsewhere in this app — matches the editor UI's natural "here's this tag's whole list now" save action), gated to superadmin/admin via the existing `IsAdminOrSuperadmin` class, with real validation (label/color required, min/max must parse as numbers) returning 400 with a specific message rather than a 500 or silent corruption.
- **Deliberately NOT added to `CRUD_MENUS`** in `serializers.py` — that set is explicitly documented as a hand-maintained mirror of v1's real permission schema ("if this drifts from v1's list... that's a real parity bug"), and this feature has no v1 lineage to mirror. Gated by role tier directly (`IsAdminOrSuperadmin`), matching how `ThresholdDetailView`'s DELETE (the prior beyond-v1-parity addition) was already gated — not by the fine-grained per-menu permissions matrix.
- **Fully verified end-to-end against a real (throwaway sqlite) DB in the sandbox**, not just `manage.py check`: ran the actual migrations, confirmed all 46 seeded rows and their labels per tag, then drove `DtBandsView` through DRF's `APIClient` — unauthenticated GET → 401, viewer GET → 200 with correct data, viewer PUT → 403, admin PUT → 200 with a real full-replace (edited RSRP:4G, confirmed RSCP:3G was untouched), and a deliberately malformed payload → 400 with the expected message. `manage.py makemigrations --check` confirms zero model/migration drift.

**Frontend**:
- `api/types.ts`: `DtBandRow`/`DtBandsMap` types. `api/queries.ts`: `useDtBands()` (60s staleTime, matching `useSites()`) / `useUpdateDtBands()`.
- `lib/useDtMetrics.ts` (new) — the actual integration point. Overlays server band customizations onto the static `ALL_METRICS` defaults from `dtBands.ts` **per-tag**, not a wholesale replace: a tag nobody's touched yet keeps using the hardcoded default (which is also what the seed migration wrote, so the two start identical), and everything downstream still gets back plain `TaggedMetric` objects with the exact same shape it already expected — this is a merge layer, not a rewrite of `dtBands.ts` itself. Falls back cleanly to the static defaults during the query's loading window so every map still renders correctly on first paint without waiting on a network round-trip.
- `DtExploreTab.tsx`, `DtCompareMap.tsx`, `DtCoverageMap.tsx` (single-session view) — all three switched from importing the static `ALL_METRICS`/`metricsForTech()` to calling `useDtMetrics()`. This was the one part of the feature that touched already-shipped code; scoped carefully via `Grep` first to make sure no fourth call site was missed.
- `pages/DtBandsPage.tsx` (new) — one editable table per metric tag (fixed order matching `ALL_METRICS`, so all 7 sections always show even if a tag has zero rows), each row: Label / Min / Max / a real `<input type="color">` swatch + hex text field / ↑↓ reorder / Delete, plus an "+ Add band" row per section and one shared Save button — draft-state-then-save pattern copied directly from `ThresholdsPage.tsx`, including the same "coerce to real numbers only at save time" fix for the trailing-decimal-point typing bug that pattern already solved once. Gated directly on `user.role`, matching `UsersPage.tsx` — not a `CRUD_MENUS`/permissions-matrix checkbox, for the same reason the backend isn't (and to avoid recreating the exact "checkbox that doesn't gate anything" trap the old `topology` permission key turned out to be, cleaned up earlier the same session).
- Route `/dt-bands` (lazy-loaded, matching every other admin page since the 21st pass's perf work), nav link "Band Colors" added next to Users, role-gated the same way.

`tsc --noEmit`: zero errors across the whole frontend. **Not yet click-tested live** — needs a real rebuild + a run-through: add a band, edit one, delete one, reorder, save, then confirm the change actually shows up on Explore/Compare/Coverage maps' dots and legends without a page reload (React Query's cache invalidation on the mutation should make this automatic, but hasn't been watched happen in a real browser yet).

**Correction, same day:** the "zero errors" check above used `tsc --noEmit -p tsconfig.json`, which is a no-op in this repo — `tsconfig.json` is a solution file (`"files": []` + project references), so that command checks nothing. The very next `docker compose up --build` failed on a real error in `useDtMetrics.ts` (imported `DtTech` from `./dtBands`, which only imports that type for its own use and never re-exports it — fixed by importing from `../api/types` instead). From here on, frontend verification in this repo uses `tsc -b --force` (what `npm run build` actually runs), not `tsc --noEmit -p tsconfig.json`.

### 26th pass, 2026-08-05: Explore coordinate search DMS parsing bug + Compare Sessions 4th revision

**DMS coordinate parsing bug (real, user-reported with exact repro).** User pasted `26°33'40.7"N 87°16'44.7"E` into DT Data Manager → Explore's coordinate search box and got a different location than pasting its exact decimal equivalent `26.561306, 87.279083` — confirmed by hand these represent the identical point (26 + 33/60 + 40.7/3600 = 26.561306...). Root cause in `DtExploreTab.tsx`'s `parseLatLng()`: it split the input on whitespace/commas into two tokens, then ran `parseFloat` on each — `parseFloat` doesn't fail on trailing non-numeric characters, it just stops reading at the first one, so `parseFloat("26°33'40.7"N")` silently returned `26` (truncated at "°") and the longitude token similarly truncated to `87`. No error was thrown; the search just silently landed ~65km away at (26, 87) instead of the real point. Not a Leaflet/projection/datum issue — this system and Google Maps agree on the same WGS84/Web Mercator frame, decimal-degree input already worked correctly; only the DMS-format path was silently mis-parsed.

Fixed by adding a real DMS parser (`parseLatLngDms`, `DMS_PAIR_RE`) tried FIRST, before the truncation-prone plain-decimal-pair path gets a chance to run: matches two `deg°min'sec"HEMI` groups (accepting straight or curly apostrophe/quote, upper/lower-case N/S/E/W), converts each to decimal via `deg + min/60 + sec/3600` with sign flipped for S/W. Only one coordinate-search entry point exists in the whole frontend (grepped to confirm), so this was the only place the bug could hide.

**Compare Sessions, 4th revision.** Two independent view toggles added to `DtCompareMap.tsx` per follow-up feedback:
- **"Show sessions separately"** — until now, sessions sharing a tech were always combined into one panel per metric. When on, `panels` (renamed from a single `visibleMetrics.map`) instead produces one panel per (metric, session) pair — same dot styling/legend/counts, just each panel scoped to one session's samples via `sessions: [s]`.
- **"Blank view (plots only)"** — new `ScatterPanelPlot` component renders every panel as a plain white SVG scatter (no Leaflet instance, no basemap tiles) instead of `MetricPanel`'s existing map. Points are normalized into the panel's own lat/lng bounding box (not true geographic scale — a relative scatter, matching the look of the v1 reference screenshot with no basemap/scale bar), colored via the same `bandColor()` as the map version.

Both toggles are independent/composable. `MetricPanel` now takes an explicit `title` and `blank` prop instead of computing its own title internally, since the split-by-session case needs a per-session title (`"S1 SessionName — RSRP (dBm)"`) that the plain per-metric case doesn't.

Verified with `tsc -b --force` (the real build-mode check, per the correction above) — zero errors. **Not yet click-tested live.**

### 27th pass, 2026-08-05: Explore — "open site detail" from a nearby site

Small follow-up request: in DT Data Manager → Explore, clicking a nearby site (marker or list row) had no way to jump to that site's detail page — only Sites Topology's map had that (`.site-quickview` card with an "Open site detail →" button, `SitesPage.tsx`).

Ported the same `.site-quickview` card into `DtExploreTab.tsx`, minus the Delete button — Explore is a read-only lookup view, it doesn't own site CRUD, unlike Sites Topology. Two ways to open it: clicking a site marker on the map (`NearSitesLayer` gained an `onSelect` callback wired to a click handler on each `L.circleMarker`) or clicking a row in the "Nearby Sites" list below the map (`dt-dup-card` rows gained `onClick`/`cursor:pointer`). Both set the same `selectedSite` state; the card shows name/ID/district/region plus "Open site detail →" (`navigate('/sites/:id')`) and a plain "✕" to dismiss. Cleared automatically on a new search (`setSelectedSite(null)` alongside the existing `setPoint`/`setSitesExpanded` reset in `handleSearch`).

`.site-quickview` is `position: absolute`, so it needs a positioned ancestor — `.dt-explore-map-wrap` didn't have one (SitesPage's own map wrapper does), added `position: relative` there.

Verified with `tsc -b --force` — zero errors. Not yet click-tested live.

### 28th pass, 2026-08-05: Backup & Restore — Complete Project (new menu, v2 had nothing here)

User request: "we have feature in v1 as backup, but in v2 it is not present. add all this feature with menu backup with import/export project. for excel export of site, sector or both, add feature of selection of all nepal wise, or region or district wise export." Screenshot attached showed v1's real "Backup & Restore — Complete Project" modal (bts_monitor.html ~1581-1700 for the UI, `exportProject()`/`restoreProject()`/`exportSiteDetailsXlsx()` etc. ~13222-14312 for the logic).

**Discovered mid-build**: `'backup'` was already a real entry in `CRUD_MENUS` (`serializers.py`) and already listed in `PermissionsPage.tsx`'s matrix — wired during an earlier phase but never given an actual page. Real seeded data in the dev DB confirms rows exist (`admin: read=True, write/update/delete=False`; `viewer`: all False) — this pass only needed to build the page and endpoints, not touch the permission plumbing.

**Backend** (`core/backup.py`, new file): `BackupSummaryView` (counts card), `BackupExportView` (full JSON export), `BackupImportView` (transactional full-replace restore). Deliberately built the export payload from the SAME shapes the app's existing live GET endpoints already return — `TreeView`'s `{folders, assignments, active}`, `ThresholdsView`'s `{kpi_key: {...}}`, `DtBandsView`'s `{tag: [...]}`, plus `SiteDetailSerializer` for sites+sectors — rather than inventing a second parallel export shape, since v2 (unlike v1) has all of this in real Postgres tables behind those endpoints already. Restore is a real DB transaction (`transaction.atomic()`) covering every selected section at once — a genuine improvement over v1's own `restoreProject()`, which has no such guarantee since it's just sequential localStorage/IndexedDB writes in the browser.

Gating: export -> `IsAdminOrSuperadmin` (matches v1's `userCan('backup','write')`, and this app's established "server-side write auth is a coarse role tier, not a per-menu lookup" convention). **Restore -> superadmin only**, a deliberate deviation from v1's finer matrix-based gating — the same extra caution this app already reserves for `PermissionsMatrixView.put()`, its other most destructive action. Frontend hides the Restore section entirely unless `user.role === 'superadmin'`, rather than using the matrix's `backup.update` value, so an admin whose matrix happens to grant that permission never sees a button that would just 403.

**Deliberately NOT ported**: v1's "GPS Coordinate Update" / "Fix Region Names" bulk-reseed tools (re-populate lat/lng/district from a 4,703-row GPS dataset baked into a single enormous line in `bts_monitor.html`). v2's Site table is already seeded from the live production `bagalewatch.db`, not a known-incomplete dataset the way v1's original problem was, so there's no equivalent bulk-correction need today — porting the embedded dataset itself (extracting ~4,700 rows out of one giant JS array literal into a new Django data migration) would have been a large chunk of work for a feature v2's live DB doesn't currently need. Flagged in a visible note card on the page itself (not just a code comment), and a real finding from testing is worth flagging here too: **the dev sandbox DB's `region` column still holds legacy names (`Central`/`Western`/`Eastern`/`Mid-West`/`Far-West`), not the corrected province names** (`Bagmati Province` etc.) — if the real deployed v2 database is in the same state, "Fix Region Names" specifically (much cheaper than the full GPS re-seed — it's a static legacy-name-to-province lookup, not an external dataset) may be worth doing as a fast follow. Not confirmed against the real deployed DB, only the sandbox copy.

**Excel export** (`core/exports.py`, new file): `SiteExportXlsxView`, using `openpyxl` (added to `requirements.txt`) instead of v1's hand-rolled client-side XLSX/ZIP writer (`xlsx_download()`, ~13060-13218 — only exists because v1 has no server). Same 3 kinds as v1 (`details`/`sectors`/`kpi`, matching v1's exact column headers), **plus scope filtering v1 never had** — `scope=all|region|district` — per the explicit request. No extra permission gate on this endpoint beyond being logged in, matching v1 exactly (its 3 Excel buttons never call `userCan()`, unlike the Export/Restore actions in the same modal).

**Frontend**: `BackupPage.tsx` (new), `api/types.ts`/`api/queries.ts` gained `BackupSummary`/`BackupExportPayload`/`BackupRestoreFlags`/`BackupImportResult` types and a `useBackupSummary()` hook — export/restore/xlsx-download themselves are one-shot actions (`apiJson`/`apiFetch` called directly from the page), not cached queries, same pattern the DT template CSV download already uses. Region/district dropdowns for the Excel scope selector are derived client-side from `useSites()` (already loaded elsewhere in the app) — no extra endpoint needed just to populate them. Nav link "Backup" added to `Layout.tsx`, gated on `isAllowed(user.role, user.permissions.backup, 'read')`, and `/backup` route added to `App.tsx` (lazy-loaded, matching every admin page since the 21st pass's perf work).

**Verification, real not assumed**: backend — `manage.py check` clean, `makemigrations --check --dry-run` clean (no model changes), full `manage.py test core` suite (59 tests) still passes, and a live functional smoke test against the real dev DB (4,720 sites / 11,933 sectors) via `APIClient`: unauthenticated summary -> 401, viewer -> 403, admin summary/export -> 200, admin import -> 403 (superadmin-only enforced), superadmin import -> 200 with a real restore verified (renamed a site, dropped another, confirmed both took effect, sectors preserved), malformed payload -> 400. Excel export: real openable workbooks confirmed via `openpyxl.load_workbook()` on the response bytes, correct headers/values, `scope=region`/`scope=district` filtering confirmed against real region/district values, error paths (bad kind, missing region, empty-scope 404) all correct. Frontend `tsc -b --force` — zero errors. **Not yet click-tested live in a browser.**

### 29th pass, 2026-08-05: Add-only Site/Sector import from Excel/CSV

Same-day follow-up: "since i have not uploaded complete site, coordinate, sector details so i need feature to upload excel file such that, it checks the uploaded file and compare with the database data of site, if exist already then do nothing, if not exist then add data like in V1." Deliberately narrower than v1's "GPS Coordinate Update" (which the 28th pass explicitly chose not to port) — this never touches an existing row, it only ever adds rows whose ID is missing. No embedded dataset needed; the user supplies their own file.

**Frontend parsing** (`lib/siteImportParser.ts`, new): `parseSiteRows()`/`parseSectorRows()`, flexible header matching (normalize + substring, same `findCol` pattern already proven in `dtTemplateParser.ts` for DT template uploads — not a new approach invented for this feature). Expected headers deliberately match this page's own Excel EXPORT columns exactly (Site Details / Sector Data), so the natural workflow is: export a template from this same page, fill in what's missing, re-upload it here. `xlsxReader.ts` gained a generic `readXlsxRows(buffer, nameHint?)` sibling to the existing tech-keyed `readXlsxRowsForTech()` (DT uploads pick a sheet by tech name; this picks one by an arbitrary name hint like "site" or "sector", falling back to the first sheet) — reuses all the same internal ZIP/XML parsing helpers, no duplicated logic.

**Backend** (`core/site_import.py`, new file): `ImportSitesView`, `kind: 'sites' | 'sectors'`. Receives already-parsed JSON rows (not a raw file — parsing happens client-side, matching this app's established convention for template uploads) and is the sole source of truth for "does this already exist": a site is skipped if its ID is already in the DB (existing fields are NEVER touched, true add-only, not an upsert); a sector is skipped if the same site already has a sector with the same `cell_name` (the closest practical "already exists" definition available — `Sector` has no natural unique key in this schema). Sector rows referencing a site that doesn't exist yet are recorded as a per-row error, not a crash — the site and sector uploads can happen in either order. Gated `IsAdminOrSuperadmin` (this is additive, not destructive, so it doesn't need `BackupImportView`'s extra superadmin-only caution).

**Frontend UI**: new "Import Sites & Sectors (add-only)" card in `BackupPage.tsx`, two independent drop-zones (reusing the existing `.dt-drop-zone` CSS class rather than inventing new styling). Site import shows a real client-side preview ("will add N, will skip M already-exist") computed against the already-loaded `useSites()` cache before the user confirms — a genuine UX improvement over v1, which has no preview step at all for its GPS import. This preview is explicitly documented as approximate (a stale cache could be a few sites off); the server-side check in `ImportSitesView` is what actually decides what gets written, never the client's count. Sector import has no equivalent preview (existing sectors per site aren't preloaded anywhere client-side) — the UI says so plainly rather than showing a fake number.

**Verification, real not assumed**: a full round-trip against the real dev DB via `APIClient` — imported a batch with one already-existing real site ID (confirmed its name was NOT overwritten), two genuinely new site IDs (confirmed both were created), a blank-ID row (recorded as an error, not a crash), and a same-batch duplicate (correctly skipped, not double-inserted); sector import against one of the newly-added sites (added), against a nonexistent site (per-row error, not a crash), and a same-batch duplicate (skipped); re-ran the exact same site import a second time and confirmed everything skipped (`added: 0`) — proves this is genuinely idempotent, not just add-once-then-error; viewer role confirmed 403. `manage.py test core` (59 tests) still passes, `makemigrations --check` clean. The flexible header parser itself was run standalone in Node against both the exact export-format header row and a hand-typed alternate header row ("SiteID"/"Name"/"District"/"Lat"/"Long") — both parsed correctly. Frontend `tsc -b --force` — zero errors. **Not yet click-tested live in a browser.**

### 30th pass, 2026-08-05: Sector import upgraded from add-only to add + update

Same-day follow-up, specifically about the sector-data half of the 29th pass's feature: "while uploading sector data, if site is already present in the system and only sector is missing, then add missing sector data, if site and sector already present then check for update and if only update is available then update it else do nothing, if site is not present in the system then add site as well as sector details (by using lat long of the site, manage required site details data)." The `kind='sites'` (Site Details) import stays exactly as the 29th pass left it — pure add-only, unchanged, per the ORIGINAL request's own wording. Only `kind='sectors'` changed.

**`core/site_import.py` rewritten for `kind='sectors'`** — 3-way per row, not 2-way: (1) site exists, sector missing -> add. (2) site AND sector both exist -> compare every field the row provides (`sector`, `local_cell_id`, `height`, `azimuth`, `mech_tilt`, `elec_tilt`, `pci`) against what's stored; if any genuinely differ, update just those fields; if none differ, do nothing (counted in `skipped`, not `updated`). (3) site doesn't exist at all -> auto-create a minimal `Site` (id + lat/lng only — no name/region/district, since the Sector Data file format doesn't carry those) before creating the sector under it. A blank cell in the uploaded row is deliberately never treated as "clear this field" during the update comparison — only a real, non-blank, different value counts as a change, so a partial re-export (someone re-uploading a file missing a column) can't silently wipe data that row simply didn't carry. Both `sites_by_id` and `sectors_by_pair` lookup dicts are updated in-place as rows are processed (not just read once up front), so a site/sector created by an earlier row in the SAME batch is immediately visible to a later row referencing it — duplicate rows within one upload land naturally in the "compare for update" branch instead of needing separate batch-dedup tracking.

`ImportSitesResult`'s response shape grew from `{added, skipped, errors}` to `{added, updated, skipped, sites_added, errors}` — `kind='sites'` responses simply always report `updated: 0, sites_added: 0` since that path never touches those counters.

**Frontend**: `ParsedSectorRow` (`lib/siteImportParser.ts`) gained `lat`/`lng` (parsed from the Sector Data file's own Lat/Long columns — those already exist in the export format, repeating the parent site's coordinates on every sector row, so nothing new needed on the export side). `BackupPage.tsx`'s Sector Data card copy and result message updated to describe add+update+auto-create-site instead of add-only, and now reports `sites_added` when applicable.

**Verification, real not assumed**: a full 3-case round-trip against the real dev DB — case 1 (existing site, new sector) confirmed added; case 2 (existing site+sector, one field changed: pci 99->88) confirmed the value actually changed in the DB; case 3 (nonexistent site) confirmed BOTH the site (with the row's lat/lng, blank name) and its sector were created. Re-ran the identical 3-row batch a second time and confirmed `added: 0, updated: 0, skipped: 3` — proves idempotency holds under the new update logic too, not just the old pure-skip one. A third pass explicitly tested the "blank cell must not wipe existing data" rule: uploaded a row with `pci: null` for the already-updated sector and confirmed its stored `pci` was still 88 afterward, not cleared. `manage.py test core` (59 tests) still passes. Frontend `tsc -b --force` — zero errors. **Not yet click-tested live in a browser.**

### 31st pass, 2026-08-05: Real bug — "Import failed." on a real 23,607-row Sector Data upload

User hit "Import failed." (no useful message) uploading their real `export_sectors.xlsx` (23,607 rows) through the feature built in the 29th/30th passes. Root cause, confirmed by reproducing with a synthetic 24,000-row payload against this app's own dev DB rather than guessing: `ImportSitesView`'s `kind='sectors'` branch called `Site.objects.create()`/`Sector.objects.save()` once PER ROW inside a single `atomic()` block — timed at **21 seconds** even on local SQLite with zero network latency. Against the real deployed stack (`backend-django/Dockerfile`'s gunicorn `CMD` had no `--timeout` flag, so gunicorn's default 30-second worker timeout applied, and Postgres runs in a separate `db` container — every one of those thousands of individual writes is a real network round trip), this comfortably exceeds 30s. Gunicorn kills the worker mid-request, the TCP connection drops, and the browser's `fetch()` rejects before any HTTP response comes back at all — which is exactly why the frontend showed a bare "Import failed." with no HTTP status code: `apiErrorMessage()` only appends "(HTTP nnn)" when it has a real `ApiError` with a response object, and there never was one to have.

**Fix — `core/site_import.py` rewritten to batch every write.** Row processing is now pure Python (no DB access per row, building `Site`/`Sector` objects in memory and a small number of lookup dicts), then a handful of `bulk_create`/`bulk_update` calls apply everything at once — `_apply_sites()` and `_apply_sectors()`, same external behavior/response shape as the 29th/30th passes (identical `{added, updated, skipped, sites_added, errors}`), same 3-way sector logic, same "duplicate rows within one batch resolve correctly" and "blank cell never clears existing data" guarantees — this was purely a performance rewrite, not a logic change, and was re-verified against the exact same functional test cases from the 30th pass (all still pass identically).

**Also added, defense in depth**: `backend-django/Dockerfile`'s gunicorn `CMD` now includes `--timeout 120`. This is NOT the real fix (a slow-but-under-120s request would still be a bad user experience) — it's a safety net so that if some future endpoint is ever this slow again, it fails with a clean timeout the frontend can potentially do something with, instead of a silent connection drop that produces a useless "Import failed." with zero diagnostic information.

**Verification, real and timed, not assumed**: re-ran the exact synthetic 24,000-row payload after the rewrite — **21s -> 9.5s** for the initial all-new-rows case (still on local SQLite; the real-world improvement against network-separated Postgres is expected to be far larger, since round-trip COUNT dropped from ~24,000 to ~26, not just total local CPU time), and a re-run of the identical payload (pure skip path, no writes) completed in **1.4s**. Re-ran all 4 functional correctness cases from the 30th pass (add-missing / update-changed / auto-create-site / blank-cell-safety) against the rewritten code — all identical results confirmed. Full `manage.py test core` suite (59 tests) still passes, `makemigrations --check --dry-run` clean (no model changes, pure view-layer rewrite). **Not yet click-tested live with the user's actual 23,607-row file** — the synthetic reproduction matched the reported symptom and scale closely enough to be confident, but the real file itself hasn't been re-tried yet.

### 32nd pass, 2026-08-06: Advanced Site Search (new global feature, ported from v1)

User request, with two screenshots (v1's top nav bar and v1's "Advanced Site Search" modal): "add feature of advance site search with the only parameters that are available in the system." Ported v1's exact 12-field modal (`bts_monitor.html`'s search modal HTML ~1810-1904, `openSearchModal()`/`clearSearch()`/`runSearch()`~8510-8621, `exportSearchCsv()`~8623) — same 12 filters, same matching semantics — with one deliberate correction: v1's Region/Tech/Type dropdowns are hardcoded option lists; this version derives every dropdown (Region/Tech/Type/**and Status**, which v1 also hardcodes) from the real distinct values already in the app's `useSites()` cache, per the user's explicit "only the parameters that are available in the system" wording. Confirmed via a real dev-DB query before writing any code: `type` is `'Macro-BTS'` for all 4,718 sites (not v1's assumed Macro/Micro/Indoor/Outdoor), `tech` is `'4G'` only, and `status` distribution is `nodata: 2476, ok: 2237, warn: 5` — v1's hardcoded lists would have shown irrelevant or simply wrong options.

**Backend** (`SiteSearchView`, added to `core/views.py`; route `sites/search/` in `core/urls.py`, deliberately registered BEFORE the router's `sites/<pk>/` include — Django matches top-to-bottom, so the literal path has to win or the router would treat "search" itself as a site-ID lookup). All 12 v1 filters ported: `q` (ID/name substring), `region` (exact), `city` (substring, matches either `city` or `district`), `status` (exact), `tech`/`type` (substring, matching v1's `includes()` behavior), 5 KPI-threshold filters (`rrc_max`, `drop_min`, `avail_max`, `prb_min`, `thru_max` — each only applies to sites with `kpi_entered=True`, matching v1's rule that KPI filters silently exclude sites with no KPI data rather than treating null as a match) with `prb`/`thru` falling back from the DL-specific field to the general one exactly like `SiteSearchView`'s sibling report views already do, and `pci` (exact match against ANY sector on the site, via `Exists(Sector.objects.filter(site_id=OuterRef('pk'), pci=pci_val))` — deliberately a subquery rather than a join+annotate, to avoid the row-multiplication bug that would otherwise double-count `sector_count` for sites with multiple sectors). No permission gate beyond `IsAuthenticated`, matching v1 exactly (its search modal never calls `userCan()`).

**Frontend**: `AdvancedSiteSearchModal.tsx` (new, `components/`) — reuses the app's existing `.modal-overlay`/`.edit-grid`/`.admin-table` CSS rather than inventing new styling, `useSiteSearch()` (new mutation hook in `api/queries.ts` — a mutation, not an auto-refetching query, since the modal fires on demand via a Search button / Enter key, not on every keystroke across 12 fields). Dropdown options computed with the same `[...new Set(sites.map(...))].sort()` idiom `SlaTrackerPage.tsx` already established for its own Region filter — no new backend endpoint needed just to populate them. Results table rows navigate to `/sites/:id` on click (same pattern `ScatterPlotPage.tsx`/`SitesPage.tsx` already use). CSV export reuses the same `Blob`/`URL.createObjectURL` pattern `SlaTrackerPage.tsx`'s `exportCsv()` already established. Wired as a global "🔍 Search" button in `Layout.tsx`'s header (not a nav link, since it opens a modal rather than routing anywhere) — visible to every authenticated user regardless of role, mirroring v1's own always-visible search icon and the backend's `IsAuthenticated`-only gate.

**Verification, real not assumed**: backend — `manage.py check` clean, then a full functional pass via `APIClient` against the real dev DB (4,718 sites): unauthenticated -> 401, no-filter request returns `count == total == 4718` (confirms the literal `sites/search/` path isn't being shadowed by the router's dynamic `sites/<pk>/` pattern — this was the one failure mode most worth checking for given how the route had to be ordered), `q=<real site id>` finds exactly that site, `region=<real value>` returns all-matching rows, `status=warn` returns exactly 5 (the known real count), `tech=4G` returns all 4,718, `type=Macro` (substring of the real `Macro-BTS` value) returns all 4,718, `rrc_max=100` returns 2,240 (correctly ≤ the 2,242 sites with `kpi_entered=True`), a combined `status=ok&avail_max=100` filter, a real `pci` value correctly finds the owning site, an invalid non-numeric `pci` returns 400, and a `sector_count` value on a returned row was cross-checked against a direct `Sector.objects.filter(site_id=...).count()` query and matched exactly. Frontend: `tsc -b --force` (this repo's established real typecheck command, not the no-op `--noEmit -p tsconfig.json` — see the 26th pass) — zero errors. `npm run build` (real `vite build`) could NOT be run in this sandbox — `node_modules` here contains only the Windows (`win32-x64-msvc`) native `@rolldown` binding, since it was installed on the user's actual machine, not this Linux sandbox; this is a pre-existing environment gap unrelated to this change, not a new one it introduced. Full `manage.py test core` suite (59 tests) re-run after this change and still passes. **Not yet click-tested live in a browser** — the modal, dropdowns, and results table have not been visually confirmed on the user's real machine.

### 33rd pass, 2026-08-06: Advanced Site Search — KPI filters swapped for site/sector/drive-test filters

Same-day follow-up to the 32nd pass: "since this system mainly focus on site info, sectors info and drive test data, so make search option related to them not kpi data." The 5 KPI-threshold fields ported from v1 (`rrc_max`/`drop_min`/`avail_max`/`prb_min`/`thru_max`) were removed entirely — KPI-based lookups already exist as dedicated pages (SLA/NTA/RF Audit/Scatter/KPI Trend), so this search's job is finding a specific site/sector/DT-session record, not duplicating KPI reporting. Replaced with 5 new filters covering exactly the three domains named: **site info** — `status_2g`/`status_3g` (new, substring match against `Site.status_2g`/`status_3g`); **sector info** — `cell_name` (substring, matches if ANY of the site's sectors has a matching `Sector.cell_name`) and `local_cell_id` (int, exact match against ANY sector) added alongside the existing `pci` filter (unchanged); **drive test data** — `has_dt` (`1`/`0`, whether the site appears in ANY `DriveTestSession.meta.nearby_site_ids` list, i.e. whether DT coverage exists near it at all — the one genuinely new capability v1 never had, since v1's in-browser search had no way to cross-reference IndexedDB-stored DT sessions from its site-array search).

**Backend** (`core/views.py`'s `SiteSearchView`): `status_2g`/`status_3g` are simple `icontains` filters. `cell_name`/`local_cell_id` use the same `Exists(Sector.objects.filter(site_id=OuterRef('pk'), ...))` subquery pattern already established for `pci`, to avoid the join+annotate double-counting problem against the `sector_count` annotation. `has_dt` required a different approach than a subquery: `DriveTestSession.meta` is a JSONField storing v1's free-form blob (not normalized — see the model's own docstring for why), and Postgres's `__contains` JSON lookup can't take an `OuterRef` as its right-hand side (it needs a literal to serialize to jsonb), so an `Exists()` subquery wasn't viable. Instead, `_sites_with_dt_coverage()` loads every session's `meta` once (`.values_list('meta', flat=True)`) and builds a plain Python `set()` of every site ID any session's `nearby_site_ids` list contains — correct on both SQLite (dev) and Postgres (prod) without lookup-syntax differences, and cheap given DT session counts are small (tens to low hundreds — distinct from the 121,000+ *sample* rows a single upload batch can contain, per Phase 4's own docstring). The same set is reused for both the `has_dt` filter itself and populating each result row's `has_dt` boolean, computed once per request rather than twice. Response shape changed: `rrc`/`call_drop`/`cell_avail`/`prb`/`thru` removed, `status_2g`/`status_3g`/`has_dt` added.

**Frontend**: `AdvancedSiteSearchModal.tsx`'s 5 KPI inputs replaced with Status 2G/3G (plain text inputs, deliberately NOT dropdowns — the dev DB currently has these blank for every site, so a dropdown built from real distinct values would only ever offer an empty option; these stay usable once real 2G/3G data exists), Cell Name, Local Cell ID, and a Drive Test Data Any/Has/No-data dropdown. Results table and CSV export updated to show Status 2G/3G/Sectors/Has DT Data instead of the removed KPI columns. `api/types.ts`'s `SiteSearchParams`/`SiteSearchResult` updated to match.

**Verification, real not assumed**: full functional `APIClient` pass against the real dev DB (4,718 sites, 0 DT sessions initially) — baseline response confirmed the new fields are present and the removed KPI fields are genuinely gone from the response shape; `status_2g=<garbage>` correctly matches 0 (every real value is blank); real `cell_name` and `local_cell_id` values each correctly found their owning site; invalid non-numeric `local_cell_id` returns 400; `pci` filter re-confirmed still working after the rewrite; `has_dt=1`/`has_dt=0` against the empty-DT-sessions baseline returned 0 and `count==total` respectively; then a real `DriveTestSession` was created with `meta.nearby_site_ids` pointing at a real site, and `has_dt=1` correctly found it, `has_dt=0` combined with a `q` filter for that same site correctly excluded it, and the site's own result row correctly showed `has_dt: true` — the test session was cleaned up afterward. Full `manage.py test core` suite (59 tests) still passes, `manage.py check` clean. Frontend `tsc -b --force` — zero errors. **Not yet click-tested live in a browser.**

### 34th pass, 2026-08-07: Real browser crash while using Advanced Site Search — root cause + app-wide fix

User reported the browser crashed (blank white page screenshot) while using Advanced Site Search, and asked to "optimize memory, size and security of the system." Clarified scope first (v2, triggered by Advanced Search specifically, fix the crash before any broader audit) rather than guessing.

**Root cause, found by code review (no live repro available in the sandbox, so reasoned from the actual render path rather than assumed)**: `AdvancedSiteSearchModal.tsx`'s results `<table>` had no row cap and no virtualization — it rendered every matching result directly into the DOM. Hitting Search with no filters set (the default state when the modal opens) or even one loose filter (e.g. `tech=4G`, which every site matches) returns up to all 4,718 sites, meaning the modal tries to synchronously create ~47,000+ DOM nodes (4,718 rows × 10 cells) inside a `max-height` scrollable div. This is the EXACT SAME failure mode this app has already hit and fixed twice elsewhere — see CLAUDE.md's own "Decisions Log": the Sites Topology sidebar needed virtual scroll for precisely this reason ("4,700 sites in a 3-level tree would create ~6,000+ DOM nodes... unacceptable"), and the map needed marker clustering ("4,700 individual Leaflet markers... collapsed the browser tab"). This modal was a genuinely new, unguarded instance of the same class of bug, not a new kind of problem.

**Fix — render cap, not a backend change.** Added `RESULTS_RENDER_LIMIT = 300` in `AdvancedSiteSearchModal.tsx`; the table body renders `results.slice(0, RESULTS_RENDER_LIMIT)` instead of the full array, with a visible "showing the first 300 — narrow your filters or use Export CSV for the full list" note when truncated. CSV export is untouched and still exports the FULL result set — that's a text-file write over an in-memory array, not a DOM render, and was never the expensive part. No backend change needed; `SiteSearchView` itself is cheap (a handful of indexed filters + one Count annotation over 4,718 rows), the cost was 100% in how the frontend rendered the response.

**Second, separate finding from the same investigation: no error boundary anywhere in the app.** While tracing how an uncaught exception could produce a literal blank white page (rather than a normal error message), found that this app has zero `ErrorBoundary` components at any level — `main.tsx` renders `<App />` directly inside `QueryClientProvider`/`BrowserRouter`/`AuthProvider` with nothing to catch a render-time exception. Before this pass, ANY uncaught error anywhere in the tree — this bug or any future one — would unmount the entire React app with no recovery UI, which is indistinguishable from a real crash to a user. Added `components/ErrorBoundary.tsx` (a minimal class component — error boundaries can't be function components in React) wrapping `<App />` in `main.tsx`, logging the real error/component stack to the console and rendering a "Something went wrong — Reload" screen instead of a blank page. This is a genuine safety-net addition, not a fix for a specific other bug — it changes what happens the *next* time something throws, wherever that ends up being.

**Verification**: `tsc -b --force` — zero errors. Sandbox couldn't reproduce an actual browser crash to re-verify against (this environment has no real browser to load 4,718 DOM rows in), so this was a code-review-driven fix based on a concrete, reproducible mechanism (confirmed via the 32nd/33rd passes' own testing that a no-filter search really does return `count==total==4718`) rather than a guessed patch — the fix is a straightforward render-cap that can't make results wrong, only bounded. **Recommend the user re-test the exact repro (open Advanced Search, click Search with no filters, or with a broad filter) live once rebuilt**, to confirm the crash is actually gone and not just theoretically addressed.

### 36th pass, 2026-08-07: Full memory/size/security audit + 3 High-severity fixes

User asked for a broader audit ("do the broader memory/size/security audit across the app") after the Advanced Search crash fix and the follow-up "Back to search results" feature. Full report saved at `docs/v2_memory_size_security_audit_2026-08-07.md`; every finding verified against real source/live behavior, several initial hypotheses disproven by testing before being written up (see the report's own "Confirmed safe" sections and the memory file for the two that were tested and dropped).

**Memory**: confirmed 2 more instances of the exact bug class Advanced Search just had — `SlaTrackerPage.tsx` (default `region='all'`) and `NtaCompliancePage.tsx` (default `pane='all-sites'`) both render every KPI-entered site (2,242 in dev DB) into an uncapped table, and unlike Advanced Search, both fire automatically on page load with zero user action. Also flagged (lower severity, not yet fixed): `TreeAdminPage`'s "Assigned sites" table, and `DtCompareMap`'s blank-mode `ScatterPanelPlot` (up to `MAX_COMPARE=4` sessions' raw samples, no downsampling). Confirmed SAFE: no raw `L.map()` Leaflet leak class in v2 (everything uses `react-leaflet`'s auto-disposing `MapContainer`), Sites sidebar is properly virtualized (`@tanstack/react-virtual`), Scatter Plot uses `<canvas>` not per-point DOM nodes.

**Size**: dependencies lean, no duplicate libraries; route-level code-splitting covers 14/15 pages. Minor finding: `AdvancedSiteSearchModal` loads eagerly via `Layout.tsx` (not yet fixed). Could not get a real current bundle size — sandbox's `vite build` fails (Windows-only `@rolldown` binding), and the on-disk `dist/` predates this session's code-splitting work.

**Security — 3 High findings, all fixed same session**:
1. Real `backend-django/.env` (not the template) had `DEBUG=1` — confirmed by reading the actual file. Fixed: now `DEBUG=0`. **Needs a container restart/rebuild to take effect.**
2. `AUTH_PASSWORD_VALIDATORS` configured but never enforced — `UserWriteSerializer` called `set_password()` directly. Verified live by creating a real user with password `"1"` (201 Created). Fixed: `validate()` now calls Django's `validate_password()` whenever a password is set, using the real instance (update) or a throwaway one built from submitted fields (create) so `UserAttributeSimilarityValidator` has something to compare against. One existing test used `'hunter2'` as a fixture password — now correctly rejected, updated to a real strong password. All 59 tests pass.
3. SLA Tracker + NTA Compliance unbounded tables (see Memory section above) — fixed with the same `RESULTS_RENDER_LIMIT = 300` pattern as Advanced Search.

Also confirmed SAFE (tested, not assumed): no SQL injection surface; the 3 `dangerouslySetInnerHTML` uses all go through `lib/markdown.ts`'s `renderMarkdown()`, which properly HTML-escapes — read the escaping code directly rather than assuming; permission_classes coverage is complete (only `AllowAny` on health-check + login). Two hypotheses were tested and DISPROVEN before being reported: (a) suspected `DATA_UPLOAD_MAX_MEMORY_SIZE` (2.5MB default) would reject the real 23,607-row sector import from the 31st pass — sent a same-shaped 4.84MB payload via APIClient, got 200 OK; turns out this Django setting only applies to form/multipart parsing, not raw JSON bodies; (b) initially suspected the markdown XSS vector, disproven by reading the actual escaping code.

Lower-severity findings left open (documented in the report, not yet fixed): hardcoded insecure `SECRET_KEY` fallback string in `settings.py`; JWT `ROTATE_REFRESH_TOKENS=True` without `token_blacklist` app; no HTTPS-enforcement settings; no JSON request body size cap; `TreeAdminPage`/`DtCompareMap` render caps; no git repository exists for this project at all (`.gitignore` is correctly written but isn't protecting anything since nothing is tracked yet).

**Verification**: `manage.py check` clean, full `manage.py test core` (59 tests) passes, `tsc -b --force` zero errors, 5 live functional password-validation test cases run via a real `APIClient` script (not just unit-test coverage). **Not yet click-tested live** — recommend restarting the Django container (for the `.env` change) and retrying weak-password user creation + the SLA/NTA pages once rebuilt.

### 37th pass, 2026-08-07: Row-render cap made user-adjustable (default 50) across all 3 fixed views

Same-day follow-up to the 36th pass's audit fixes: "for memory optimization, for all, use in default with 50-row render cap and allow to choose 100,150 etc (CSV export still gets the full set)." The flat `RESULTS_RENDER_LIMIT = 300` constant duplicated across `AdvancedSiteSearchModal.tsx`, `SlaTrackerPage.tsx`, and `NtaCompliancePage.tsx` is replaced with a shared `components/RowLimitSelect.tsx` — `ROW_LIMIT_OPTIONS = [50, 100, 150, 250, 500]`, `DEFAULT_ROW_LIMIT = 50` — rendered as a small "Show [N] rows" dropdown next to each page's existing toolbar controls (Region selector + Export CSV for SLA; All Sites/Violations Only toggle for NTA; Search/Clear/Export CSV for Advanced Search).

Advanced Search's `rowLimit` state is lifted into `Layout.tsx` alongside `form`/`hasSearched`/the `useSiteSearch()` mutation (same reasoning as the 35th pass's "Back to search results" fix — reopening the modal via `SearchModalContext` should show the same view, including the same chosen row limit, not silently reset to 50). SLA Tracker and NTA Compliance keep it as plain local `useState` — no cross-navigation concern on those pages, nothing to lift.

CSV export is untouched on all three — it was already reading the full, unsliced result array before this change and still does; only the `<table>`'s `.slice(0, ...)` call and its accompanying truncation-note text changed from the fixed constant to the new `rowLimit` state variable.

**Not extended (out of scope for this specific request)**: the audit's two lower-severity Medium findings — `TreeAdminPage`'s "Assigned sites" table and `DtCompareMap`'s blank-mode `ScatterPanelPlot` — still have no cap at all (not 300, not adjustable). They weren't part of the 3 views this fix targeted; flagged to the user as an available follow-up if wanted.

**Verification**: `tsc -b --force` — zero errors across all touched files (`RowLimitSelect.tsx`, `AdvancedSiteSearchModal.tsx`, `Layout.tsx`, `SlaTrackerPage.tsx`, `NtaCompliancePage.tsx`, `App.css`). No backend changes in this pass, so the existing 59-test suite result stands unchanged. **Not yet click-tested live.**

### 38th pass, 2026-08-07: Remaining audit Medium findings fixed + Sites map default-load change + tile-label finding

Four-part follow-up after the user tested the 36th/37th passes' fixes live and hit a real "Aw, Snap! Out of Memory" crash on `/nta` (screenshot attached), plus 3 more requests: extend the row-limit treatment to the two audit findings that hadn't gotten it yet, look into a garbled map label near Annapurna, and stop loading all 4,729 sites onto the map by default after login.

**1. `TreeAdminPage`'s "Assigned sites" table and `DtCompareMap`'s blank-mode `ScatterPanelPlot`** — the two Medium-severity unbounded-render findings from the original audit that were explicitly left unfixed at the time — now both use the same shared `RowLimitSelect` (default 50). `RowLimitSelect` gained an optional `unit` prop (defaults to `'rows'`) so Tree Admin can say "sites" instead. `ScatterPanelPlot` takes a new `pointLimit` prop, slices its point array before rendering, and draws a small in-SVG `<text>` note when truncated (`showing N of M`) — the real-map (non-blank) mode is deliberately left uncapped, since that wasn't the audited finding.

**2. NTA "Out of Memory" crash — confirmed pre-rebuild stale state, not a residual bug.** Re-read the live `NtaCompliancePage.tsx` source directly: `rowLimit` initializes to `DEFAULT_ROW_LIMIT` (50) via `useState`, and the table already slices with `sites.slice(0, rowLimit)` before this screenshot was reported — there is no code path in the current source that renders an unbounded table. The crash almost certainly happened against a frontend container that hadn't been rebuilt yet with the 36th/37th passes' fixes. No code change needed here; flagged to the user to rebuild (`docker compose up --build frontend`) and hard-refresh before retesting.

**3. Annapurna label rendering as boxes — investigated, NOT something this app's code can fix.** `MapView.tsx`'s `TileLayer` uses `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` — OpenStreetMap's standard pre-rendered RASTER tiles. Confirmed via grep that this page has no GeoJSON boundary/label overlay of its own (`nepalDistrictBoundaries.ts` is only used by `DtExploreTab.tsx`'s polygon filtering, unrelated to this map) — the Devanagari text ("अन्नपूर्ण संरक्षण क्षेत्र" / Annapurna Conservation Area) is baked as pixels into the downloaded tile image by OpenStreetMap's own rendering servers, not drawn by any code in this repo. No `font-family` CSS or label-layer change here can alter pixels inside a third-party PNG. Reported this finding plainly to the user rather than attempting an unfixable code change; offered switching tile providers (e.g. CartoDB's Positron/Voyager styles) as an experiment if they want to try — flagged as unverifiable without live visual comparison, and a broader visual change to the whole map's appearance, not a targeted label fix.

**4. Sites map — memory-optimization default-load change.** Per explicit request ("after login, in default only load map and sitebar, after selection only display sites"): `SitesPage.tsx`'s `ScopeSelector` gained a `'none'` variant, now the DEFAULT (was `'all'`) — on load, the map renders base tiles only, zero markers, fit to Nepal's bounding box; the sidebar tree is unaffected (always shows the full unfiltered site list/counts, as it did before — nothing new to load there). The pinned "NTC — All Sites" sidebar row still works exactly as before, loading and clustering all 4,729 sites on demand when clicked. `MapView.tsx`/`FitToScope` needed zero changes — both already handled an empty `sites` array gracefully (confirmed by reading the existing fallback-to-`NEPAL_BOUNDS` logic before assuming a change was needed there). Status bar text now shows a "select something from the sidebar" prompt instead of "Showing: All Nepal — 0 sites" when nothing's picked yet.

**Verification**: `tsc -b --force` — zero errors across all touched files. No backend changes, so the 59-test suite result is unaffected. **Not yet click-tested live** — recommend rebuilding the frontend container and confirming: (a) the NTA page no longer crashes, (b) Sites Topology loads with just the map+sidebar and no markers until a selection is made, (c) the new row-limit controls appear on Tree Admin and DT Compare's blank view.

### 39th pass, 2026-08-07: Compare Sessions reworked — uncapped plots, per-panel map loading, no combined view

Same-day correction after live use of the 38th pass's DT Compare row-limit control: "in compare session, load directly all the session separately in blank view (plot only) donot limit to 500, i was confused earlier, need full plot there. allow click in each individual panel to load map in panels not for all at once. no need of average plot for now."

**Reverted the point cap.** `ScatterPanelPlot`'s `pointLimit` (added in the 35th pass) is gone — every real sample is always plotted in the blank/plots-only SVG view again, no truncation note. A cheap SVG scatter with no Leaflet/tile overhead behind it isn't the same cost profile as a DOM table row, so the row-cap pattern didn't actually belong here — see the updated `feedback_unbounded_result_tables_crash_browser` memory for the general lesson.

**Removed the two global view-toggle checkboxes.** "Show sessions separately" and "Blank view (plots only)" are gone from `DtCompareMap.tsx`. Panels are now unconditionally split one-per-(metric, session) — the combined "all sessions in one panel" mode ("average plot") was explicitly declined as unneeded for now.

**Real Leaflet maps now load per-panel, on click, not all at once.** This is the actual fix for the underlying memory concern: unchecking "Blank view" used to instantiate a real `MapContainer` (tiles + `CompareDots` layer) in every visible panel simultaneously — with sessions split apart, comparing 2 sessions × 3 metrics meant 6 live Leaflet instances loading at the same moment, a far more plausible crash/memory contributor than SVG point count ever was. Every panel now defaults to the blank scatter and has its own "🗺️ Map" button (`.dt-compare-panel-maptoggle`) that mounts a real map for just that panel; clicking "📊 Plot" unmounts it again (react-leaflet disposes it cleanly).

**Verification**: `tsc -b --force` — zero errors. No backend changes. **Not yet click-tested live.**

### 40th pass, 2026-08-07: Compare Sessions panels made individually resizable

"in compare session make these individual panel resizable." Each panel's map/plot area is now wrapped in a `.dt-compare-panel-resizable` div using plain CSS `resize: both` + `overflow: hidden` — a native browser drag handle at the bottom-right corner, no JS drag-state needed (unlike the sidebar's own hand-rolled mousemove/mouseup resize elsewhere in this app; with potentially a dozen+ panels open at once, giving each its own independent size via CSS is simpler than tracking per-panel width/height in React state). `.dt-compare-panel-map` (the Leaflet container or SVG) now just fills the wrapper at 100%/100% instead of carrying its own fixed 260px height. `useMapInvalidateOnResize` (already wired into every real map) uses a `ResizeObserver`, so it doesn't care that the resize came from this new drag handle instead of a window resize — no changes needed there. Also set `.dt-compare-grid { align-items: start }` so resizing one panel taller doesn't stretch its row-siblings to match (CSS Grid's default `stretch` would've left dead space under their legends).

**Verification**: `tsc -b --force` — zero errors. No backend changes. **Not yet click-tested live** — worth confirming a resized real-map panel's tiles fill the new size correctly (the ResizeObserver hook should handle this, but hasn't been visually confirmed against this specific trigger).

**Same-day follow-up: horizontal resize still wasn't working — 2nd attempt found the real cause.** First attempt (removing an explicit `width: 100%`, suspecting a percentage-width quirk) didn't fix it — user reported it was still vertical-only. The actual cause: `.dt-compare-panel-resizable` kept `max-width: 100%`, and every panel already renders at exactly 100% of its grid column on load — so there was zero headroom to ever drag it wider; only shrinking, or growing *taller* (no `max-height` was ever set), could do anything. That's precisely "vertical works, horizontal doesn't." Fixed by removing `max-width` entirely, so a panel can now genuinely grow past its own grid column, intentionally overlapping whatever's to its right; added `z-index` (bumped via `:hover`/`:focus-within`) so the panel actively being resized draws on top of its neighbor instead of being covered by its opaque background. CSS-only change, no typecheck needed. **Not yet confirmed live.**

### 41st pass, 2026-08-07: Site marker vanished after "Open site detail" → back to Sites

"after returning from go back to site, site indicator is missing. initially it was there." Caused by the 38th pass's memory-optimization change (default map scope `'none'`, no markers until a selection is made): `scopeSelector` is local component state, so it reset to `'none'` on every remount of `SitesPage`, including the round-trip to `/sites/:id` and back. `selectedSiteId` itself lives in `useTreeStore`, a module-level Zustand store that survives route changes — so the sidebar highlight and the bottom quickview panel (which only depend on `selectedSiteId`) still looked right, but the map's marker (which depends on `scope`, derived from the now-reset `scopeSelector`) had already gone back to plotting nothing. Fixed by seeding `scopeSelector`'s initial state lazily from `selectedSiteId` (`useState(() => selectedSiteId ? { type: 'site', id: selectedSiteId } : { type: 'none' })`) instead of always starting at `'none'` — a fresh login with no prior selection still gets the cheap no-markers default, but returning to Sites while a site is already selected (from Site Detail, or any other page) now re-shows that site's marker immediately.

**Verification**: `tsc -b --force` — zero errors. No backend changes. **Not yet confirmed live.**

**Same-day follow-up (6th and final attempt): dropped native CSS `resize` entirely — the real blocker was `.app-main`'s scroll behavior, not any panel CSS.** User reported resize still worked "up to a fixed max frame width" and then only vertical growth continued. Root cause: `.app-main` (the whole app's content area, wrapping every route) is `overflow: auto`. Browsers do not auto-scroll a scrollable ancestor during an interactive native `resize` drag — once a panel's edge reached the current edge of `.app-main`'s visible scroll viewport, further mouse movement had nothing to grab onto, so it looked exactly like resize "stopped," while vertical growth kept extending the page's natural scroll height without hitting the same wall. This is a genuine platform limitation of native `resize`, not fixable with more CSS tuning. Replaced it with a hand-rolled drag handle (`.dt-compare-panel-resize-handle`, small diagonal-line grip in the bottom-right corner) using `window`-level `mousemove`/`mouseup` listeners — the exact same pattern already used for this app's sidebar and DT session-history divider drag-resize (`onHistoryResizeMouseDown` in `DtDataManagerPage.tsx`). Mouse coordinates from `window` events aren't bound to any element's visible scroll viewport, so dragging now keeps working correctly no matter how far past `.app-main`'s current scroll position the user goes — real "expand to wherever it's dragged, in both directions." The panel's own size is measured live via `getBoundingClientRect()` at drag-start (not a hardcoded guess), so the very first drag feels seamless. `.dt-compare-panel` keeps `flex: 0 0 360px` as its pre-drag CSS default; once dragged, `MetricPanel` overrides it via inline `style`. `tsc -b --force` clean. **Not yet confirmed live.**

**Same-day follow-up (5th attempt): `flex-grow: 1` was quietly re-blocking horizontal resize, same failure class as the earlier `max-width: 100%` bug.** After switching to flex-wrap, user reported horizontal resize was *still* not working. Cause: `.dt-compare-panel`'s `flex: 1 0 360px` had `flex-grow: 1`, which stretches every panel to consume 100% of its row's width on every layout pass — so a row was already at full capacity before the resize handle was ever touched, leaving zero slack to drag into (dragging right had nowhere to go, functionally identical to the earlier `max-width: 100%` story, just caused by `flex-grow` instead this time). Changed to `flex: 0 0 360px` (fixed 360px basis, no grow, no shrink) — panels no longer auto-stretch to fill a wide row (a deliberate trade-off: a wide window now just shows blank space after the last panel in a row instead of evenly stretched panels), but there's now real headroom for the resize handle to use, and `flex-wrap` still pushes an overflowing neighbor to the next line once a row's total width would exceed the container. CSS-only, `tsc -b --force` clean. **Not yet confirmed live.**

**Same-day follow-up (4th attempt): switched from CSS Grid to flex-wrap so expanding a panel reflows its neighbors instead of overlapping them.** "donot overlap while expanding, relate with other whole panel and move other if needed." The z-index hover-bump from the 3rd attempt only hid the overlap by drawing the resized panel on top — it never actually solved it, because CSS Grid's `1fr` columns don't respond to a resized item's real on-screen size at all. Switched `.dt-compare-grid` from `display: grid` to `display: flex; flex-wrap: wrap`, and `.dt-compare-panel` to `flex: 1 0 360px` (grow to fill leftover row space like the old `1fr`, but never shrink below 360px — wrap to the next line instead, matching the old `minmax` floor). This is genuine native reflow: when the browser's interactive `resize` drag overrides a flex item's main size, flexbox recomputes the row like any other layout change, so a panel that no longer fits pushes its neighbor down to the next line instead of being drawn over. The z-index hover-bump is removed entirely — with real reflow there's nothing left for it to paper over. `tsc -b --force` clean, CSS-only. **Not yet confirmed live.**

**Same-day follow-up (3rd attempt): moved the resize handle to the whole card, not just the inner map box.** "currently inside map panel resizable, i need outer boundary of panel resizable making similar resize of inside map panel" — the drag handle was only on the inner `.dt-compare-panel-resizable` (the map/plot box itself), leaving the outer card's title bar and legend a fixed size around it. `.dt-compare-panel` (the whole card: title row + map/plot + legend) is now a flex column with `resize: both` + `overflow: hidden` on itself instead; the title row and legend are `flex: none` (keep their natural size) while the inner map/plot box is `flex: 1 1 260px` (starts at the old 260px, then simply absorbs whatever the outer drag adds or removes) — so dragging the card's own bottom-right corner grows/shrinks the map area inside it, matching what was asked ("make similar resize of inside map panel"). The inner box lost its own independent `resize`/`max-width`/`min-*` properties, since it's no longer separately draggable. `z-index` hover/focus bump moved from the inner box to the outer card to match. CSS + one doc-comment update in `DtCompareMap.tsx`, `tsc -b --force` clean (no logic changed). **Not yet confirmed live.**

### 35th pass, 2026-08-07: "Back to search results" — search results survive visiting a site's detail page

User confirmed the crash fix worked (screenshot showed a real 267-of-4,729 search running cleanly) and immediately hit a real usability gap: clicking a site ID in the results opens `SiteDetailPage`, but its "← Back to sites" always went to Sites Topology — losing the search entirely, forcing the user to re-enter every filter to check a second result. Exact request: "keep source page id and when click on back to site or maybe back to search it redirects to the previous page from where it was opened."

**Root cause of the loss**: `AdvancedSiteSearchModal.tsx` owned `form`/`hasSearched`/the `useSiteSearch()` mutation as its OWN local state. Since `Layout.tsx` only mounts the modal component while `searchOpen` is true (`{searchOpen && <AdvancedSiteSearchModal .../>}`), closing it to navigate to a site's detail page unmounted the modal — and with it, all local state. Reopening later started from a blank form.

**Fix — lift the state, don't persist navigation.** `form`/`hasSearched`/the `useSiteSearch()` mutation moved from `AdvancedSiteSearchModal` up into `Layout.tsx` (which already owned `searchOpen`) and are now passed down as props — same lifted-state pattern used any time a value needs to outlive a child component's mount lifecycle. Reopening the modal (`searchOpen: true` again) now shows the exact same results, since the mutation's `.data` was never thrown away.

To let `SiteDetailPage` (a totally separate route, several component layers away) ask `Layout` to reopen the modal, added `contexts/SearchModalContext.tsx` — a plain React context exposing `{ openSearch: () => void }`, provided by `Layout` wrapping its entire render output (including `{children}`, i.e. every routed page). `AdvancedSiteSearchModal`'s `openSite()` now navigates to `/sites/:id?fromSearch=1` (a URL query param, not router `location.state` — deliberately matching this page's own existing `?edit=1`/`?addSector=1` convention so it survives a refresh) instead of a bare `/sites/:id`. `SiteDetailPage` reads that param and, when present, renders "← Back to search results" (a `<button>` styled to match `.back-link`, calling `useSearchModal().openSearch()`) instead of the normal `<Link to="/sites">← Back to sites</Link>` — reopening the modal is enough on its own; no navigation is needed since the modal is a route-independent overlay that already renders on top of whatever page is underneath.

Deliberately did NOT strip `?fromSearch=1` after use (unlike `?edit=1`/`?addSector=1`, which this page already strips once consumed) — there's no state to leak from leaving it, and stripping it would mean a plain page refresh silently reverting the back-link to "Back to sites" instead of staying consistent for as long as the tab stays on that URL.

**Verification**: `tsc -b --force` — zero errors, confirming the prop-drilled types (`AdvancedSiteSearchModalProps`, the context's `SearchModalContextValue`) line up end to end. Structural check that `Layout` truly wraps every route (`App.tsx`: `<Layout>...<Routes>...</Routes>...</Layout>`), so `useSearchModal()` inside `SiteDetailPage` is guaranteed to find its provider rather than throwing. **Not yet click-tested live** — recommend the user verify by running a search, opening a result, clicking "← Back to search results", and confirming the exact same rows reappear without re-searching.

## NTC brand design-system overhaul (2026-08-07)

"lets make this system GUI look high standard. This is logo to use in the system and use its color code for GUI for this system." User attached the real Nepal Telecom logo; asked to (1) keep both a dark and a light theme with a user-selectable toggle, (2) use the logo in the header, login page, and browser tab icon, (3) do a full design-system pass, not just a color swap.

**Colors sampled directly from the logo**, not guessed or recalled from general "NTC branding" knowledge — `logo.jpg` was already sitting in the project root from an earlier session. Ran it through Pillow (`Image.getcolors()`, most-frequent-pixel analysis): background blue is `#0153A5` (96,953 of ~115,000 sampled pixels), the tower/text gold clusters around `#E4B54D`.

**Assets** (`frontend-react/public/`): `ntc-logo.jpg` (the real logo, used in header + login), `favicon-16.png`/`favicon-32.png`/`apple-touch-icon.png`/`favicon-192.png` (center-cropped-square + resized via Pillow). `index.html` updated: real favicon links replacing the old placeholder `favicon.svg`, `<meta name="theme-color" content="#0153A5">`, title changed to "BAGALEWATCH BTS — Nepal Telecom". The old `favicon.svg`/`icons.svg` files are left in `public/` unreferenced rather than deleted (harmless, not worth the risk of breaking something else that might still reference them).

**Design tokens** — `App.css`'s old 6-line `:root { --rpt-* }` block replaced with a full semantic token system (~60 CSS custom properties): brand (`--brand-primary`/`--brand-primary-hover`/`--brand-accent`), neutral surface scale (`--bg-app`/`--bg-surface`/`--bg-surface-alt`/`--bg-hover`), text scale (`--text-primary` through `--text-dim`), borders, status colors (success/warning/danger/info, each with a badge-style soft-bg variant), and elevation (`--shadow-sm`/`--shadow-md`, `--radius-sm/md/lg`). `--rpt-green`/`--rpt-yellow`/`--rpt-red`/`--rpt-blue`/`--rpt-hint` are kept under their original names (chained onto the new status tokens via `var()`) since `NtaCompliancePage.tsx`/`SlaTrackerPage.tsx` read them directly by name — renaming would've meant touching those files for no benefit.

Two brand-color roles were deliberately kept separate rather than using one blue everywhere: `--brand-primary` (the true logo blue, `#0153A5`) for solid fills — buttons, the light-theme header bar — where enough area carries a fairly dark, lower-luminance blue regardless of exact contrast; `--link-accent` (`#94B7D9`, a lighter tint) for small text/border accents in DARK mode specifically, because `#0153A5` reads poorly as a thin border or small text directly against this app's near-black backgrounds (the color it's replacing, `#7f77dd`, was originally chosen for exactly that reason — bright enough to read there). In light mode `--link-accent` just equals `--brand-primary`, since the true blue already has excellent contrast on white. Gold (`--brand-accent`) is reserved for brand moments only — the selected-site map marker ring/dot (previously a generic amber `#fbbf24`, now the real logo gold) and the active-nav-tab underline — kept semantically separate from `--status-warning` (which stays its own amber) so a status badge is never visually confused with a brand accent.

**Light theme is a genuinely separate palette**, not an inverted dark one — the dark theme's bright green/amber/red status text and pale blue link tint would fail contrast on white, so light-mode status colors are separately chosen saturated-but-darker shades (e.g. success text `#15803d` on a `#dcfce7` bg, vs. dark mode's `#4ade80` on `#14532d`).

**Mechanical hex→token replacement**: read the entire 1257-line `App.css` first to categorize every one of the ~40 recurring literal hex colors by actual role (not by hex value alone), then applied the replacement via a Python script — targeted, context-specific replacements first (the old `#7f77dd` accent split across 10 different rule blocks into either `--brand-primary` for solid fills or `--link-accent` for text/border accents, depending on each rule's actual role; `#1e2c4d` "selected row" background paired with its `color: #fff` into `--brand-primary-soft-strong` + `--text-on-selected`; the 3 `#fbbf24` occurrences split — 2 became the brand gold marker, 1 stayed generic warning-amber), then a blanket pass for the ~30 remaining hexes that play the exact same role everywhere in the file (borders, text grays, backgrounds, status colors).

**A real bug during this pass, caught before shipping**: the blanket replacement script ran over the ENTIRE file including the token block it had just inserted, so lines like `--bg-app: #0b0d12;` got rewritten to the self-referential `--bg-app: var(--bg-app);` — every token would have resolved to nothing. Caught by re-reading the file with the `Read` tool right after (not trusting the script's own success message) and noticing `--text-primary: var(--bg-surface);` in the light theme block, which is an obviously wrong pairing. Fixed by regenerating the token block from the pristine source file and re-splicing it in, leaving the (correctly-tokenized) rest of the file untouched. Verified with a second pass afterward: no `--x: var(--x)` self-references anywhere, and a `tinycss2` parse of the final file reports zero errors.

**Theme toggle** — `contexts/ThemeContext.tsx` (new, matches the existing `SearchModalContext.tsx` convention: plain React context, fail-safe `useTheme()` that falls back to dark if no provider is found rather than throwing). Sets `document.documentElement.dataset.theme = 'light'` (or deletes the attribute for dark, so dark stays the literal zero-attribute default — existing users see no visual change until they opt in) and persists the choice to `localStorage` under `bagalewatch_theme`. Wrapped around `<App>` in `main.tsx`. Toggle button (☀️/🌙) added to the header (next to Search/Sign out, `Layout.tsx`) AND the login page (top-right corner, reachable before authentication too, since the request wasn't scoped to logged-in sessions only).

**Logo integration**: header (`app-header-brand` — logo + title, left of the nav toggle), login page (64px logo above the "BAGALEWATCH BTS" heading, subtitle changed to "Nepal Telecom · 4G RAN O&M — sign in"), and the browser tab (favicon).

**Other polish applied everywhere via the shared primitives** (so it lands on all ~15 pages at once, not just wherever new code happens to touch): global `:focus-visible` outline in brand blue on every input/select/textarea/button/link (there was NO visible focus state anywhere before this — a real, previously-missing accessibility gap, not just cosmetic); `:focus` box-shadow ring on form fields; themed scrollbars (Chromium/Safari/Edge); `box-shadow: var(--shadow-sm/md)` added to every previously-flat elevated surface (`.login-card`, `.modal-box`, `.report-card`, `.tree-folder-card`, `.audit-section`, `.backup-card`, `.md-report`, `.dt-compare-panel`, `.scatter-tooltip`); table headers (`.admin-table th`, `.sectors-table th`) restyled as small-caps muted labels, matching the micro-copy style `.report-card-label` already used, instead of just slightly-darker body text; `.btn-danger` folded into the same base selector as `.btn-primary`/`.btn-secondary` (it was previously missing border-radius/padding/font-size entirely wherever used alone without `.btn-small`, e.g. `BackupPage.tsx`'s Restore button — a genuine pre-existing bug this incidentally fixes); button/link/nav hover transitions (`transition: background-color 0.15s ease`) added where missing.

**Deliberately left untouched**: RSRP/DT band colors, site status dots (ok/warn/crit), and any other JS-computed functional color (these encode real signal/status meaning via `bandColor()`/similar functions in `.tsx` files, not CSS classes — recoloring them for "branding" would confuse their actual meaning, exactly the reasoning already documented for keeping `--brand-accent` and `--status-warning` visually distinct). The `.dt-compare-panel-blank` white plot background stays literal `#ffffff` in both themes — it's an intentional "paper" background matching the v1 reference screenshot, not a themed surface.

**Verification**: `tsc -b --force` — zero errors. `tinycss2` parse of the full `App.css` — zero errors, 291 top-level rules. Brace-balance sanity check (294 `{` / 294 `}`). Grep-audited that every literal hex color remaining outside the token block is one of exactly two deliberate exceptions (`#4b5262`× 3, the resize-handle grip decoration; `#ffffff`× 1, the DT Compare blank-plot background). **Not yet visually confirmed live in a browser** — this was a large, mostly-mechanical pass with no live rendering available in this environment; recommend the user rebuild the frontend and click through: (a) toggle dark/light from the header and login page, confirm both look coherent and nothing goes invisible (dark-text-on-dark or white-on-white), (b) confirm the logo renders in the header/login/tab icon, (c) spot-check a report page's pass/warn/fail badges and the DT Compare selected-site gold marker.

## Reset-on-menu-change (2026-08-07)

"at every menu change reset previous menu reset." Confirmed scope via AskUserQuestion first, since a blanket "every navigation resets everything" would have undone the "Open site detail → back re-shows your selected site" fix from earlier the same day: (1) reset should apply to TOP-NAV section switches only (Sites Topology → SLA → NTA etc.), not the `/sites` ↔ `/sites/:id` round trip within the Sites section, which should keep remembering the selection exactly as just fixed; (2) switching sections should also close the Advanced Search overlay if it's open.

**Most pages needed no code change at all** — each top-nav link is its own route with its own page component owning plain `useState`; React Router already unmounts the previous page and mounts a fresh one on any route change, which resets that local state for free. The only things that actually persist ACROSS navigation by design are two Layout-level/global mechanisms built earlier this session: the Advanced Search overlay's state (deliberately lifted into `Layout.tsx` so "← Back to search results" works) and `useTreeStore`'s `selectedSiteId` (a module-level Zustand store, now seeded into `SitesPage`'s map scope on mount). Those are the only two things this fix actually touches.

**Implementation** (`Layout.tsx`, which is the one component that stays mounted across every route): a `useEffect` watching `useLocation().pathname`, comparing the top-level path segment (`pathname.split('/')[1]`) against a `useRef`-held previous value. On an actual segment change (e.g. `sites` → `sla`): closes the search modal, clears its form/results/row-limit state, and calls the search mutation's own `.reset()`. Only clears `selectedSiteId` (via `useTreeStore().selectSite(null)`) when the OLD segment was specifically `'sites'` and the new one isn't — so `/sites` → `/sites/:id` → `/sites` (same segment throughout) never triggers it, but `/sites` → `/sla` does, and the next visit to Sites starts fresh (`SitesPage`'s scope-seeding `useState` initializer sees `selectedSiteId === null` and defaults to `'none'`, exactly like a first-ever visit).

**Verification**: `tsc -b --force` — zero errors. No backend changes. **Not yet click-tested live** — recommend confirming: (a) select a site, open its detail page, click back — marker still shows (unchanged behavior); (b) select a site, then click a different top-nav item (e.g. SLA), then click back to Sites Topology — map should now show no markers/selection, not the previously selected site; (c) open Advanced Search, run a search, then click a different top-nav item — the search overlay should close.

## Dynamic top-nav with submenus (2026-08-08)

"add feature to add, update, delete top menu with submenu feature also." Scoped via AskUserQuestion first, since this touches core nav/permission architecture: (1) fully dynamic — convert the ENTIRE header nav (not just new custom extras) to be DB-managed, so the 14 previously-hardcoded items get the same add/edit/delete treatment as anything new; (2) only superadmin can manage menu items; (3) a menu item can link to either an internal route or an external URL.

**New model** — `core.models.MenuItem` (migration `0009_menuitem.py`): `label`, `link_type` (route/external), `path`, `parent` (self-FK, `on_delete=CASCADE`), `order`, `access`, `permission_key`, `is_active`. Submenus are capped at exactly one level deep (a parent item cannot itself have a parent) — enforced in `MenuItemSerializer.validate()`, not just a UI convention, since the header renders a simple click-to-open dropdown, not a nested tree widget.

**`access` is deliberately simpler than the granular CRUD (read/write/update/delete) permission matrix** that already exists for real data operations (`MenuPermission`/`CRUD_MENUS` — Sites/Tree/Thresholds/Backup/etc.) — a nav entry only ever needs a yes/no "can this role see this link," never a full CRUD shape. Four modes cover every gating pattern the old hardcoded `Layout.tsx` used:
- `all` — unconditional (matches the old Sites Topology, which had no check at all)
- `permission` — resolved through the EXACT SAME `MenuPermission` table + `isAllowed()` every existing simple menu key already uses (see `MeSerializer.get_permissions`) — a brand-new `permission_key` is default-deny for admin/viewer until a superadmin explicitly grants it a row via the Permissions page, same safe default every existing simple menu already had
- `admin` — admin + superadmin only (matches the old Band Colors/Users role checks)
- `superadmin` — superadmin only (matches the old Permissions page)

**Data migration** (`0010_seed_menuitem_defaults.py`) seeds all 15 rows — the 14 that used to be hardcoded JSX (Sites Topology…Permissions), transcribed with the exact same label/path/gating each one used to have, PLUS a 15th row for the new Menu Admin page itself (superadmin-only, since the nav is now fully DB-driven — even the page that manages `MenuItem` needs its own row to appear). Verified in an isolated throwaway sqlite DB (`DJANGO_DB_ENGINE=sqlite`, never touches the real Postgres data) that all 15 seed correctly and byte-for-byte match the old hardcoded list.

**API** — `GET /api/v2/menu-tree/` (`MenuTreeView`, any authenticated user): returns a nested, ALREADY-FILTERED tree (only active items the requesting user's role/permissions allow, superadmin bypasses every gate) — same "server resolves visibility, client just renders" split as `isAllowed()` elsewhere, so `Layout.tsx` never needs to duplicate any gating logic. `/api/v2/menu-items/` (`MenuItemViewSet`, superadmin-only both read and write): the raw, unfiltered CRUD used by the new admin page.

**Frontend** — `Layout.tsx`'s hardcoded `<NavLink>` list is gone; the whole `<nav>` now renders from `useMenuTree()`. A leaf item is a plain link (`NavLink` for routes, so it still picks up react-router's own "active" class handling; a plain `<a target="_blank">` for external URLs). An item with children renders as a click-to-open dropdown (`openMenuId` state + an outside-click listener via `navRef`) rather than hover-only CSS — this app already prefers explicit JS state over hover-only interaction elsewhere (see the Compare Sessions resize saga), and hover-only doesn't work on touch anyway. The parent's own path stays a real, clickable first row inside its dropdown (every `MenuItem` requires a path, even ones with children) rather than being a dead label. New page `MenuAdminPage.tsx` (`/menu-admin`, superadmin-only, matches `UsersPage.tsx`'s inline-edit-row convention): add/edit/delete, a `<datalist>` of known internal routes to reduce typos without forcing a closed dropdown, a Parent select restricted to top-level items only, and a delete-confirm that warns with the actual child count before a cascading delete.

**`PermissionsPage.tsx` extended, not replaced** — its hardcoded `SIMPLE_MENU_KEYS` list stays exactly as-is (the 6 original simple menus + the legacy `reports` row), but now merges in any NEW `permission_key` found on an `access='permission'` `MenuItem` that isn't already in that list (`dynamicSimpleKeys` memo, sourced from the same superadmin-only `useMenuItems()` query the Menu admin page uses). This closes the loop: add a custom item with a fresh permission_key on the Menu admin page, and a toggle for it appears on the Permissions page automatically — no code change needed to actually grant it to a role.

**Verification**: `python3 manage.py check` — clean. `tsc -b --force` — zero errors. Ran the full migration against an isolated throwaway sqlite DB and confirmed via `MenuTreeView` directly (not just by reading the code) for `superadmin`/`admin`/`viewer`: (a) the 15 default items resolve with EXACTLY the same visibility as the old hardcoded checks (admin sees everything except Permissions/Menu Admin, viewer sees a further-reduced subset matching its actual pre-existing `MenuPermission` rows); (b) a manually-added submenu item (external URL, under Sites Topology) appears correctly nested for all three roles; (c) a manually-added custom item with a fresh, ungranted `permission_key` is visible to superadmin only, confirming default-deny for a brand-new key. Also exercised `MenuItemSerializer.validate()` directly: rejects a grandchild (parent-of-a-parent), rejects re-parenting an item that already has its own children, rejects `access='permission'` with an empty `permission_key`, rejects a malformed external URL, and accepts a normal new top-level item. **Not yet click-tested live in a browser** — recommend the user, after migrating, spot-check: (a) the header nav looks identical to before (nothing missing, nothing extra); (b) Menu Admin lets you add a submenu item and it shows up as a dropdown; (c) a new custom item with "Governed by Permissions matrix" is invisible to admin/viewer until granted on the Permissions page, which should now list its key automatically.

## Left sidebar + customizable Dashboard (2026-08-08, same-day follow-up)

Screenshot of Databricks' "Add data" page attached as a reference: "add feature to add, update, delete menu with submenu feature also. let us take this as an example for menu and dashboard. after login, display dashboard should be like this. left panel for menu and submenu (icon display with detail on hover) with collapse/expand on hover feature and after clicking menu and submenu, display its hierarchy on top bar, and dashboard should be like with some features that can be displayed with style including representing image (some may be summary display and some may be link to feature). and dashboard display contents also should be customizable by individual user by themselves and save for later use." Scoped via AskUserQuestion first, since this replaces the nav shell built earlier the same day: (1) REPLACE the top-nav header entirely with a left sidebar + breadcrumb top bar (not add a second nav alongside it); (2) Dashboard becomes the default post-login landing page, Sites Topology moves to being a regular sidebar item; (3) per-user dashboard layout saves to the backend (syncs across browsers, consistent with everything else in this app), not localStorage; (4) default dashboard cards are a mix of live stats + shortcut tiles, not shortcuts-only.

**`MenuItem` extended with `icon` (single emoji) and `description` (one-line detail)** — migrations `0011`/`0012`. Emoji chosen over an icon-font/image-upload system deliberately: zero new assets, zero new CDN dependency, renders identically in the collapsed sidebar rail, the expanded label row, and a Dashboard shortcut card. `0012` also backfills a sensible icon+description for all 15 existing items (🗺️ Sites Topology, 📶 SLA, ✅ NTA, etc.) and seeds a 16th row: **Dashboard itself** (`/dashboard`, `access='all'`, `order=0` — first in the sidebar, above Sites Topology).

**Shared visibility logic extracted, not duplicated** — `get_visible_menu_items(user)` (moved out of `MenuTreeView` into a standalone function in `views.py`) is now called by BOTH `MenuTreeView` (the sidebar) and the new `DashboardView` (shortcut-card catalog), so a Dashboard shortcut can never link somewhere the sidebar itself wouldn't show — one gating rule, not two hand-maintained copies that could drift apart.

**New `DashboardCardConfig` model** (migration `0013`) — per-user saved layout (`user`, `card_key`, `order`, `visible`), backend-persisted per the user's explicit choice. Absence of rows for a user means "use catalog defaults," so a brand-new user gets a sensible dashboard without ever customizing anything.

**New `core/dashboard.py` module** — `GET/PUT /api/v2/dashboard/` (`DashboardView`). GET merges three things: (1) a small hardcoded `STAT_CARDS` catalog with live-computed values (`stat-total-sites`, `stat-sites-crit`, `stat-sites-warn`, `stat-dt-sessions` — real `Site`/`DriveTestSession` queries, not fabricated), (2) one shortcut card per top-level `MenuItem` the user can see (via the shared `get_visible_menu_items`, excluding Dashboard's own row — no point linking Dashboard to itself), and (3) the user's saved `DashboardCardConfig` rows overlaid for order/visibility, defaulting to catalog order + visible when nothing's saved yet. PUT does a per-card upsert (same convention as `ThresholdsView`/`PermissionsMatrixView` elsewhere — only the cards actually included in the request are touched, not a full replace).

**Frontend nav rewrite** — `Layout.tsx`'s horizontal header + top-nav dropdown (built earlier the same day) is gone, replaced by `.app-shell` (flex row): a left `.app-sidebar` (64px collapsed icon rail, expands to 240px on hover OR when pinned via a footer toggle button persisted to `localStorage`) and a `.app-content-col` holding a new `.app-topbar` (breadcrumb showing the current section›subsection, derived by matching `location.pathname` against the menu tree — `findBreadcrumbTrail()` — plus the Search/theme/user/logout controls moved over from the old header) above `.app-main`. Submenus render as an indented list under their parent, toggled by a small caret button, only ever shown while the sidebar itself is expanded (a 64px rail has no room for a nested list regardless of CSS visibility tricks, so this is a real JS-level render decision, not just an opacity toggle). Known limitation, noted in code: hover has no equivalent on touch devices, so a touch user needs the pin toggle to ever see sidebar labels at all.

**Real latent bug caught and fixed while re-homing the header**: `.theme-toggle-btn` (shared between the header and `LoginPage.tsx`'s pre-login toggle) was styled with `--header-text`/`--header-hover-bg` — tokens tuned for the OLD header's bold-blue light-theme background. `LoginPage.tsx` was never actually on that background (it sits on `--bg-app`, a plain near-white surface in light theme) — meaning the login page's theme toggle would have rendered as white text on a near-white background in light mode, invisible, from the moment the design-system pass shipped. Never reported because the design-system pass itself was flagged "not yet visually confirmed live." Fixed by giving `.theme-toggle-btn` its own neutral `--text-secondary`/`--border`/`--bg-hover` styling, correct in both of its actual real-world contexts (the new `.app-topbar`, and the login page).

**New `DashboardPage.tsx`** (`/dashboard`, default landing page) — a card grid (`dash-card`: stat cards show icon+big number+label, shortcut cards are clickable tiles with a hover lift) plus a "Customize" mode (`dash-customize-row`: up/down reorder buttons + a visible/hidden checkbox per card, including currently-hidden ones so they can be brought back). Save renumbers every card sequentially (`index * 10`) and PUTs the full list; Cancel discards the in-progress draft without saving.

**Other follow-ups**: `MenuAdminPage.tsx`'s `ItemFields` form gained Icon/Description inputs (every `MenuItem` field is now editable there, matching the "fully dynamic" scope from the same-day nav feature) and its `KNOWN_ROUTES` datalist gained `/dashboard`; `LoginPage.tsx`'s already-logged-in redirect and `App.tsx`'s `RootRedirect` both changed from `/sites` to `/dashboard`.

**Verification**: `python3 manage.py check` — clean. `tsc -b --force` — zero errors. Ran the full migration chain (`0001`→`0013`) against a fresh throwaway sqlite DB start to finish with no errors. Confirmed directly (not by reading the code): 16 `MenuItem` rows exist including Dashboard at `order=0` with its icon/description; `MenuTreeView`'s JSON payload includes `icon`/`description` per node; `DashboardView` GET returns correct live stat values against real `Site` rows (2 sites created → 1 crit → totals matched exactly) and a shortcut-card list that correctly EXCLUDES the Dashboard item itself while including only what that role's `get_visible_menu_items` allows (admin: Sites Topology + Band Colors + Users, matching its actual granted `MenuPermission` rows in a fresh DB with none of the "permission" menus pre-granted). PUT round-tripped correctly: hiding a card and reordering another both persisted and reflected on the next GET. **Not yet click-tested live in a browser** — this is a large, mostly-mechanical layout rewrite; recommend the user, after migrating and rebuilding the frontend: (a) confirm login lands on Dashboard, not Sites; (b) hover the sidebar and confirm it expands smoothly with icons+labels+descriptions, and a parent with a submenu (once one exists — none of the 16 seeded items have children yet) shows its caret/indented list correctly; (c) confirm the breadcrumb in the top bar updates correctly when clicking different sidebar items, including `/sites/:id`; (d) on Dashboard, click Customize, hide a card, reorder another, Save, and reload to confirm it stuck; (e) toggle dark/light theme on both the login page and inside the app now that `.theme-toggle-btn` changed.

## Multi-level submenus + logo crop fix + customizable branding (2026-08-08, second same-day follow-up)

Screenshot of the sidebar's logo/brand area attached: "here it is one level submenu, but need multilevel submenu. for logo and name, provided image shows circular logo with top exceeded. will it look better if both top and bottom exceeded with clear logo and name. another is also add feature to customize logo and name." Three asks, no AskUserQuestion needed this round (each was concrete enough to implement directly): (1) submenus must nest arbitrarily deep, not just one level; (2) the sidebar's circular logo badge should overflow symmetrically above AND below the brand row, and the source crop needs fixing (it was slicing through the wordmark); (3) let a superadmin customize the app logo + name.

**Arbitrary-depth submenus** — the one-level cap from the earlier nav feature is gone. `MenuItemSerializer.validate_parent()` (which rejected a parent-of-a-parent) was removed entirely and replaced with a cycle-detection walk in `validate()`: given a candidate `parent`, walk `parent.parent.parent...` and reject if the item being edited ever appears in that chain (would make it its own ancestor). `get_visible_menu_items()` was reworked from returning `(visible_top, {top_level_id: [children]})` to `(visible_top, visible_children_fn)` — a callable usable at any depth — with its own defensive `visiting` set inside `is_visible()` so a hypothetical data-level cycle (e.g. introduced directly via Django admin, bypassing the serializer) resolves to "not visible" instead of infinite-looping. `MenuTreeView` now recurses through `visible_children(item.id)` at every level instead of only once.

**Frontend recursion to match** — `Layout.tsx`'s sidebar gained a `SidebarNode` component that renders itself for `node.children`, with `openGroupIds` upgraded from a single id to a `Set<number>` (two ancestors along the same path can both be open at once). `findBreadcrumbTrail()` became recursive so a breadcrumb can read "Section › Subsection › Sub-subsection" to whatever depth exists. `MenuAdminPage.tsx` gained `flattenTree()` (depth-first parent→children walk, used both for the admin table's row order/indentation and the Parent picker's option order) and `collectDescendantIds()` (excludes an item and everything under it from its own Parent picker, so the UI can't even offer a choice that would create a cycle — belt-and-suspenders with the server-side check).

**Logo crop was genuinely broken, not just small** — opened the source `logo.jpg` directly (404×316) rather than guessing: it's a VERTICAL lockup, circular tower emblem on top, "नेपाल टेलिकम" wordmark below. The circular-badge CSS (`object-fit: cover` + `border-radius: 50%`) had been centering a circle on the whole rectangle, which sliced straight through the wordmark. Fixed with a Pillow script that auto-detects the emblem's pixel bounding box (background-color-distance scan) and re-crops a clean square containing only the icon; regenerated `ntc-logo.jpg` (256×256) and all four favicon sizes from that clean crop, confirmed visually via a direct image-preview read before finalizing.

**Symmetric top+bottom overflow** — `.app-logo` gained `margin: -10px 0`, which shrinks the image's contribution to `.app-sidebar-brand`'s own height calculation while its rendered box still overflows the row's edges by that same 10px both above and below (previously it only bled upward, since only the row's own smaller height was clipping it on one side). `.app-sidebar-brand`'s padding was bumped from 14px to 18px to keep the overflow from crowding the sidebar edges.

**Customizable branding** — new singleton `BrandingSettings` model (`app_name`, `logo` `ImageField`, same `pk=1`/`get_or_create` convention as the pre-existing `TreeSettings`), migration `0014` + a `0015` data migration seeding a `Branding` nav row (`/branding`, superadmin-only). `GET/PUT /api/v2/branding/` (`BrandingSettingsView`). The logo travels as a base64 data URL in a plain JSON field (`logo_data_url`), NOT multipart/form-data — this app's shared `apiFetch()` client force-sets `Content-Type: application/json` on any request with a body unless one's already set, which would corrupt a real multipart upload; rather than special-casing the shared client for one endpoint, this follows the SAME convention `BackupPage.tsx` already established (read the file client-side, send its content as JSON). The view validates the data URL's mime type (`image/*` only), caps decoded size at 5MB, and swaps the stored file (`obj.logo.delete(save=False)` before assigning the new one, so replacing a logo never leaves an orphaned upload). **GET is deliberately `AllowAny`, not `IsAuthenticated`** — caught during verification: `LoginPage.tsx` renders before the user has a token at all, so an auth-gated GET would have made the login page's own branding silently fail to load every single time. There's nothing sensitive in the response (a display name + a public image URL), so this is a considered exception, not an oversight. PUT stays superadmin-only, matching every other app-wide-setting write.

**Frontend wiring** — new `BrandingPage.tsx` (`/branding`, superadmin-gated the same way `MenuAdminPage.tsx` gates itself, i.e. a plain in-component role check backing up the server's own 403) with a file input (client-side `FileReader.readAsDataURL()` → preview → Save), a Remove-logo button (only shown once a custom logo exists), and an app-name text field. `Layout.tsx`'s sidebar brand block and `LoginPage.tsx` both now read `useBranding()` and fall back to the stock `/ntc-logo.jpg` + "BAGALEWATCH BTS" when nothing's been customized (a fresh install's GET comes back `{app_name: '', logo_url: null}`, not an error, so the fallback is the common case, not an edge case). A new `useBrandingSideEffects()` hook, called once at the `App()` root (so it also runs pre-login, matching the GET's `AllowAny` reasoning), pushes a customized name into `document.title` and a customized logo into every `<link rel="icon">`/`<link rel="apple-touch-icon">` tag — the two places outside React's own render tree that also need to reflect a custom logo, and can't be set via JSX.

**Verification**: `python3 manage.py check` — clean both immediately after the base64 rewrite and again after the `AllowAny` fix. `tsc -b --force` — zero errors. Ran the full migration chain (`0001`→`0015`) against a fresh throwaway sqlite DB. Exercised `BrandingSettingsView` directly: unauthenticated GET returns 200 with defaults (confirming the login-page fix actually works); superadmin PUT with a real base64-encoded 1×1 PNG succeeds and `logo_url` resolves to a real `/media/branding/logo.png` URL; a non-superadmin PUT is rejected 403; a malformed data URL and a non-image mime type are both rejected 400 with a field-level error; `remove_logo: true` clears it back to `null`. Exercised multi-level submenus directly: built a real 3-level chain (SLA → NTA → Monthly Report) via three separate PATCHes, confirmed `MenuTreeView` returns them correctly nested for superadmin; confirmed a genuine cycle attempt (re-parenting SLA under its own descendant Monthly Report) is rejected 400 with the "already a descendant" message; confirmed an admin role with a read grant on `sla` but not `nta` sees SLA in the tree with an empty `children` array (each node's own access is checked independently of its parent's — a parent being visible does not implicitly grant visibility to its children). **Not yet click-tested live in a browser** — recommend the user, after migrating and rebuilding the frontend: (a) confirm the sidebar's logo now overflows evenly top and bottom, with no wordmark clipping visible on hover-zoom; (b) build a real 2+-level submenu via Menu Admin and confirm it renders correctly indented in the sidebar with working expand/collapse at each level; (c) as superadmin, visit Branding, upload a logo and set a custom name, and confirm it immediately shows in the sidebar, on the login page (after signing out), and in the browser tab's favicon/title; (d) confirm "Remove custom logo" reverts everything to the stock Nepal Telecom branding.

## Login-page reload loop fix (2026-08-08, live bug caught after shipping)

User report: "my login name is flickering" (clarified to mean the login PAGE, not a username field). Root cause: `Layout.tsx` wraps every route including `/login`, and calls `useMenuTree()` unconditionally to render the sidebar. `MenuTreeView` requires `IsAuthenticated`, so on the login page (no access token yet) that request always 401s. `apiFetch()` in `client.ts` treated ANY 401 as "your session expired," clearing tokens and calling `onAuthExpired()` — wired to `AuthContext.logout()`, a hard `window.location.href = '/login'` reload. Reloading `/login` remounts `Layout`, which fires the same doomed query again — an infinite reload loop, which visually looks exactly like flickering. This bug shipped with the very first dynamic-nav feature and survived three more same-day follow-ups because verification never went past direct API calls against a throwaway sqlite DB — never an actual browser sitting on `/login` with `Layout` mounted around it.

**Fix, two layers**: `useMenuTree()` (`queries.ts`) now takes an `enabled` param, called as `useMenuTree(!!user)` in `Layout.tsx` — the query simply never fires pre-login. Defense-in-depth: `apiFetch()` now only treats a 401 as session-expired when a token was actually attached and rejected (`hadToken` check) — a 401 on a request that never had a token is just "not logged in," not "your session just expired," and must never trigger the hard-reload path. This protects against the same mistake in any future authenticated-only hook that ends up called from an always-mounted component.

**Verification**: `tsc -b --force` — zero errors. This is a client-side-only logic fix (no backend/migration involved), verified by reading the exact reproduction path end-to-end rather than a live click-test (the fix removes a code path entirely, `enabled: false` is a well-understood React Query primitive). Recommend the user reload `/login` a few times, including with dev tools' Network tab open, to confirm `/api/v2/menu-tree/` no longer fires until after a successful login.

## Per-menu-item icon image upload (2026-08-08, third same-day follow-up)

User: "how to add new icon on menu?" then, after being told Menu Admin's Icon field only accepts a typed emoji: "i downloaded icon file but cant edit or add icon in menu." Confirmed via AskUserQuestion this should be a real feature (per-item image upload), not just emoji guidance.

**New `MenuItem.icon_image` ImageField** (migration `0016`) — additive, not a replacement for the existing `icon` emoji field: when set, it takes precedence over `icon` everywhere an icon renders (sidebar rail, submenu rows, breadcrumb, Dashboard shortcut cards); when absent, everything falls back to the emoji exactly as before. Upload path is `menu_icons/<uuid>.<ext>` (a random filename, unlike the branding logo's fixed `branding/logo.<ext>` — MenuItem rows are created/deleted freely and have no stable identity to key a path off of before their first save).

**Extracted a shared decode helper (`core/imageutils.py`)** — `decode_data_url_image(data_url, max_bytes)` — used by BOTH `BrandingSettingsView.put()` (refactored to use it, replacing its original inline decode logic) and the new `MenuItemSerializer` icon handling, rather than two copies of the same base64/mime/size-limit validation.

**`MenuItemSerializer` gained `icon_image_url` (read), `icon_image_data_url` (write-only base64 data URL) and `remove_icon_image` (write-only bool)**, with custom `create()`/`update()` methods — `icon_image` itself is deliberately not a direct serializer field, same reasoning as `BrandingSettingsSerializer`'s write-only `logo`. Cap is 2MB (`MAX_MENU_ICON_BYTES`), smaller than the org logo's 5MB since this is a small rail icon. `MenuTreeView.serialize()` and `core/dashboard.py`'s shortcut-card catalog both gained a matching `icon_image_url` (the latter required threading `request` into `_catalog()`, which previously only took `user`).

**Frontend**: `MenuAdminPage.tsx`'s `ItemFields` gained a file input (client-side `FileReader.readAsDataURL()`, 2MB cap enforced before it ever reaches the server) with a live preview and a "Remove image" button; a `toMenuItemWrite()` helper strips the read-only `id`/`icon_image_url` off a fetched `MenuItem` before it seeds an edit draft. `Layout.tsx`'s `SidebarLink`, its breadcrumb, and `DashboardPage.tsx`'s `CardTile`/`CustomizeRow` all render `<img icon_image_url>` when present, falling back to the emoji otherwise — a shared `CardIcon` sub-component on the Dashboard side avoids duplicating that fallback logic twice.

**Verification**: `python3 manage.py check` — clean. Ran the full migration chain (`0001`→`0016`) against a fresh throwaway sqlite DB. Exercised directly: creating a menu item with a real base64 PNG succeeds and the uploaded URL appears correctly in BOTH `MenuTreeView`'s nested tree AND `DashboardView`'s shortcut-card catalog (confirming the shared `get_visible_menu_items` plumbing threads the new field through both consumers); `remove_icon_image: true` clears it back to `null`; a garbage data URL is rejected 400 with a field-level error. `tsc -b --force` — zero errors. **Not yet click-tested live** — recommend the user, as superadmin, upload an icon file on an existing or new menu item via Menu Admin and confirm it shows correctly in the sidebar rail (collapsed AND expanded), the breadcrumb, and — if that item is top-level — its Dashboard shortcut card.

## Login-page text customization + section pages + security hardening (2026-08-08, fourth same-day follow-up)

Three requests in one message: (1) "let superadmin to customize the login interface texts also"; (2) "for top level item menu if submenu is present then... display all the inside submenu items in its dashboard page with icon and details"; (3) "add feature to secure the dynamic path url of the inside system page so that no one can see the actual path... secure the system for unauthorized access and tampering." Item 3 was scoped via AskUserQuestion first, since "hide the URL" isn't a coherent goal on its own — a browser always shows its current address to whoever's using it. Presented the real options (block unauthorized access, block injection/tampering, cosmetically obfuscate paths) and the user picked all three.

**1. Login-page text customization** — `BrandingSettings` gained four more blank-able text fields (migration `0017`): `login_subtitle`, `login_username_label`, `login_password_label`, `login_button_text`, same "empty means use the hardcoded default" convention as `app_name`/`logo`. `BrandingSettingsView.put()` refactored to loop over a `TEXT_FIELDS` list instead of repeating the same "if present, set it" line five times. `BrandingPage.tsx` gained a "Login page text" section (four inputs, one combined save); `LoginPage.tsx`'s subtitle/field-labels/button text all read from `useBranding()` with the original hardcoded strings as fallback.

**2. Auto-generated section pages for parent menu items** — new `MenuSectionPage.tsx` (reuses `DashboardPage.tsx`'s exact `.dash-card`/`.dashboard-grid` styling — this IS a small scoped dashboard, not a new visual language) and `MenuSectionGate.tsx`, which shows it INSTEAD OF a top-level route's own page component whenever that item has children in the menu tree. Wired into `App.tsx` via a `withSection(path, element)` helper wrapping every top-level route except `/dashboard` (already its own customizable overview — kept deliberately separate so there aren't two competing "home" concepts). Reads from the same `useMenuTree()` query Layout.tsx already populates (shared cache key, no extra request), so a section can only ever list children the current user can actually see. Deliberately scoped to TOP-LEVEL items only (matches the literal request) and only DIRECT children (one level) — a grandchild is reached by clicking through its own parent's card.

**3a. URL-guessing access-control audit** — a dedicated sub-agent grepped every admin-gated page (`UsersPage`, `PermissionsPage`, `ThresholdsPage`, `TreeAdminPage`, `DtBandsPage`, `BackupPage`) and confirmed: every one either has an explicit page-level role gate (`PermissionsPage`, matching `MenuAdminPage`/`BrandingPage`'s existing pattern) or gates only individual write controls while relying on the API's own server-side permission checks for reads — and in every case the underlying API already enforces the correct role regardless of what the frontend route renders (confirmed earlier in this session for `UserViewSet` etc.). **Finding, not a fix**: this was already correctly architected; no page silently leaks admin-only data to an unauthorized role just by being visited. Real access control has never depended on a route being hard to guess.

**3b. Login brute-force lockout** — `LoginView` had NO rate limiting at all (a real gap vs. v1's documented "5-attempt/15-minute lockout"). Added the same 5-attempt/15-minute lockout via Django's cache framework, keyed by username (not IP, to avoid one shared office NAT locking out every real user behind it), checked BEFORE calling `authenticate()` and cleared on success. Returns 429; `LoginPage.tsx` shows a matching message.

**3c. Upload content verification, not just label-trusting** — `core/imageutils.py`'s `decode_data_url_image()` previously trusted the CLIENT-DECLARED `data:<mime>` header to decide whether a payload was really an image; nothing stopped labeling arbitrary bytes `image/png`. Now (1) whitelists PNG/JPEG/GIF/WEBP only — **`svg+xml` is deliberately excluded**, since an SVG is XML and can embed a `<script>` that executes if the uploaded file is ever opened directly in a browser tab (a real stored-XSS vector for any upload feature) — and (2) actually verifies the decoded bytes parse as one of those formats via Pillow (`Image.verify()`) instead of trusting the label alone. Verified directly: a real PNG passes; a `data:image/png` label wrapping non-image bytes is correctly rejected; an SVG payload is correctly rejected regardless of content.

**3d. Django security settings** — added `X_FRAME_OPTIONS='DENY'`, `SECURE_CONTENT_TYPE_NOSNIFF=True` (explicit, matching Django's own defaults, so a future settings refactor can't silently drop them), and an explicit `CSRF_TRUSTED_ORIGINS` whitelist. **A real regression was caught and fixed during verification**: the first pass gated `SESSION_COOKIE_SECURE`/`CSRF_COOKIE_SECURE`/`SECURE_SSL_REDIRECT`/HSTS on `not DEBUG`, assuming "DEBUG=0 means this deployment has HTTPS" — but this app's OWN real deployment already runs `DEBUG=0` over plain HTTP (see the earlier "Set DEBUG=0 in real .env" hardening pass), so `SECURE_SSL_REDIRECT=True` would have caused an infinite http→https redirect loop the moment this shipped, breaking login entirely. Caught because the verification suite itself (a plain-http Django test client) hit the redirect immediately. Fixed by gating on its own explicit `HTTPS_ENABLED=1` env flag instead — these settings now require a deliberate opt-in once a real TLS-terminating proxy is actually in front of Django, never inferred from `DEBUG`.

**3e. Cosmetic URL obfuscation (explicitly acknowledged as NOT real security)** — 15 of the app's 17 built-in top-level routes were confirmed, via a full `src/` grep, to have zero hardcoded path references anywhere outside `App.tsx`/`Layout.tsx`/`DashboardPage.tsx`/`MenuAdminPage.tsx`'s generic menu-rendering code, making them safe to rename. New data migration `0018` renames their seeded `MenuItem.path` from descriptive slugs (`/sla`, `/users`, ...) to opaque 6-character tokens (`/p3k7q2`, `/d8k2wr`, ...). `/sites` was deliberately EXCLUDED — the same grep found 9 scattered hardcoded `/sites/${id}` references across `AdvancedSiteSearchModal.tsx`, `SidebarTree.tsx`, `TopologyMap.tsx`, `ScatterPlotPage.tsx`, `SiteDetailPage.tsx`, and `SitesPage.tsx`; renaming it risked missing one and silently breaking navigation on the app's highest-traffic page for a purely cosmetic gain. `/dashboard` and `/login` were also excluded. **Purely additive**: `App.tsx` mounts each new opaque route AND keeps the old descriptive path mounted as a plain redirect to the new one, so no existing bookmark or shared link 404s — going forward the sidebar/breadcrumb/dashboard only ever generate the new opaque links, since they're built straight from `MenuItem.path`. The token mapping is hand-kept-in-sync across three places (the migration, `App.tsx`'s `OPAQUE_PATHS`, `MenuAdminPage.tsx`'s `KNOWN_ROUTES`), each cross-referencing the others in comments.

**Verification**: `python3 manage.py check` — clean, including after catching and fixing the `SECURE_SSL_REDIRECT` regression above. `tsc -b --force` — zero errors. Ran the full migration chain (`0001`→`0018`) against a fresh throwaway sqlite DB twice (once to catch the redirect bug, once clean after the fix). Exercised directly: login-text GET/PUT round-trips and is readable unauthenticated (confirming the login page itself can render it); 5 failed logins lock the account out with a 429 on the 6th attempt while a different account is unaffected; the real-PNG/fake-PNG/SVG upload cases all resolve correctly; a child created under the renamed `/f9j4qs` (Backup) shows up correctly nested under that same opaque path in `MenuTreeView`'s response. **Not yet click-tested live** — recommend the user, after migrating: (a) confirm old bookmarks like `/users` still work (redirecting to the new opaque path); (b) add a submenu item under an existing top-level item via Menu Admin and confirm clicking that parent now shows a card-grid section page instead of its usual content; (c) as superadmin, customize the login page text on the Branding page and confirm it shows correctly on the (signed-out) login screen; (d) attempt 5 wrong passwords and confirm the 6th shows the lockout message.

## Port-hiding / reverse-proxy architecture (2026-08-10)

User's request: "can we also hide or randomize port like 8000, 8080 or 5180 in the browser to access. only for main program like 5180 can be accessed by using ip only?" — i.e. don't let anyone on the LAN reach django/node-gateway/go-worker directly on their own ports; only the app's own port (5180) should ever be dialable from a browser.

**What changed.** `frontend-react/nginx.conf` (the `frontend` container — the only service that still publishes a host port, `5180:80`) gained three new `location` blocks that `proxy_pass` to the other services by their Docker Compose service name over the internal network: `/api/` → `http://django:8000`, `/media/` → `http://django:8000`, `/admin/` → `http://django:8000`, each forwarding `Host`/`X-Real-IP`/`X-Forwarded-For`/`X-Forwarded-Proto`. `docker-compose.yml` then had `ports:` removed entirely from `django`, `node-gateway`, and `go-worker` — they still listen on their usual ports (8000/8090/8070) but only reachable from inside the Docker network now, same pattern already used for `db`/`redis`. The browser only ever talks to `5180`.

**Frontend now defaults to same-origin.** `frontend-react/src/api/client.ts`'s `DJANGO_API_URL` changed from a hardcoded `'http://localhost:8000'` fallback to `''` (same-origin) — this incidentally fixed a real **pre-existing latent bug**: the old hardcoded fallback meant a friend loading the app from a different machine had their browser's own `localhost:8000` silently fail every API call, since `localhost` always resolves to the browser's own machine, not the server. Only ever worked by accident when the Docker host's own browser was the one being used. `frontend-react/.env`/`.env.example` are now blanked (comments explain when you'd actually want to set `VITE_DJANGO_API_URL`). `vite.config.ts` gained a `server.proxy` block (`/api`, `/media`, `/admin` → `http://localhost:8000`) so `npm run dev` still works locally without needing same-origin nginx in front of it.

**Also found and removed while touching this:** `docker-compose.yml`'s `frontend.build.args` block passed `VITE_DJANGO_API_URL`/`VITE_NODE_GATEWAY_URL` as Docker build args, but `frontend-react/Dockerfile` has no matching `ARG` declaration — this had silently done nothing on every build; the real source of truth was always `frontend-react/.env`, copied in via `COPY . .`. Removed with an explanatory comment so it doesn't cause confusion later.

**ALLOWED_HOSTS risk, resolved via AskUserQuestion, not guessed.** Once django is only reachable through nginx, it sees whatever Host header the browser actually used (a LAN IP, not `localhost`), which the previous `ALLOWED_HOSTS=localhost,127.0.0.1` would reject with a 400 DisallowedHost — a real risk of locking the user out of their own app. Presented the tradeoff directly; user explicitly chose `ALLOWED_HOSTS=*`, accepted as reasonable for an internal-only LAN tool where every real endpoint already requires JWT auth regardless of Host header. `backend-django/.env`/`.env.example` updated accordingly, plus `CSRF_TRUSTED_ORIGINS` (new key, defaults to `http://localhost:5180`) and `CSRF_TRUSTED_ORIGINS`'s existing default in `settings.py` updated from `:8000` to `:5180`. `HTTPS_ENABLED`-gated security settings (SESSION_COOKIE_SECURE/SECURE_SSL_REDIRECT/HSTS, see the 2026-08-08 entry above) were rechecked and are unaffected — the stack remains plain HTTP throughout, no change there.

**GZipMiddleware** was added as a same-session drive-by fix (found during the preceding memory/size/performance audit, not part of the port-hiding work itself, but shipped in the same deploy) — see the audit summary above this entry's position for the API-payload-compression context.

**Verification.** No sandbox/Docker access was available this session (bash tool was down throughout) — everything here was verified by manual re-reading of every changed file plus reasoning through the request flow (nginx location-block precedence, `$host` forwarding correctness for `build_absolute_uri()`-based media/logo URLs, Vite dev-proxy vs. production-nginx-proxy parity), NOT by actually running `docker compose up --build`. Also swept the whole repo for other lingering `localhost:8000`/`8090`/`8070` references that would now give stale instructions: fixed `docs/RUNBOOK.md`'s own quick-start health-check commands (above) and `docs/SERVER_MIGRATION.md` / `docs/SERVER_MIGRATION_WINDOWS.md`'s "point the app at the server's IP" / firewall / "test it" sections (all three previously told the user to open/curl 8000 and 8090 directly from another machine — now updated to explain only 5180 needs to be reachable, matching the new architecture). Left untouched: `docker-compose.yml`'s own container-internal healthcheck `test:` commands (still correctly use `localhost:8000` etc. — those execute *inside* each container's own network namespace, where the service still listens on its normal port) and `docs/RUNBOOK.md`'s bare-metal `python manage.py runserver` dev-workflow section (unrelated to Docker/nginx, `localhost:8000` is genuinely correct there).

**Not yet verified live** — recommend the user, after pulling these changes: (1) run `python manage.py makemigrations core` BEFORE migrating, to check/correct migration `0025`'s hand-guessed index name (see that file's own docstring — this is unrelated to the port-hiding change itself but was written in the same session and hasn't been run yet either); (2) `docker compose build django frontend` (both changed images); (3) `docker compose up -d`; (4) confirm the app is still reachable at `http://<host>:5180` and that `8000`/`8090`/`8070` are no longer reachable from another machine on the LAN (e.g. `curl http://<host-ip>:8000` should now just hang/refuse, not answer); (5) confirm login still works and an existing branding logo/menu icon still renders (exercises `build_absolute_uri()` behind the new proxy).

## Migration 0027 recovered from container-only state (2026-08-11)

Follow-up to the previous entry's own recommendation #1: the user ran `docker compose exec django python manage.py makemigrations core` to fix migration `0025`'s guessed index name, confirmed via `--dry-run` that it produced a clean `RenameIndex` (`v2_dt_sampl_lat_1a2b3c_idx` → `v2_dt_sampl_lat_1ab414_idx`), and ran `migrate` successfully. **That migration file (`0027`) never made it to host disk** — per the project's own established lesson (memory `feedback_docker_migrations_no_persist.md`), the `django` service has no source bind mount, so `makemigrations` run via `docker compose exec` writes only into the container's writable layer. Confirmed via `ls`/grep that `backend-django/core/migrations/` on the real host stopped at `0026`. Left alone, the NEXT `docker compose build django` (needed anyway for the TRP File Analysis work below) would have silently dropped `0027`, and a subsequent `makemigrations` would have regenerated the exact same rename against an index that had *already* been renamed — failing with "index ... does not exist", exactly the "forever RenameIndex" trap that memory file warns about.

Fixed by hand-writing `0027_rename_v2_dt_sampl_lat_1a2b3c_idx_v2_dt_sampl_lat_1ab414_idx.py` to disk with the exact operation Django itself already generated and the user already successfully ran (not a fresh guess) — `migrations.RenameIndex(model_name='drivetestsample', new_name='v2_dt_sampl_lat_1ab414_idx', old_name='v2_dt_sampl_lat_1a2b3c_idx')`. **Verified in-sandbox** (this session had real `mcp__workspace__bash` access, unlike the previous few): installed `backend-django/requirements.txt`, ran the full migration chain `0001`→latest against a fresh throwaway sqlite DB (`DJANGO_DB_ENGINE=sqlite`) end to end with zero errors, then `makemigrations core --check --dry-run` reported "No changes detected in app 'core'" — confirming the hand-written file exactly matches what Django's own autodetector expects, closing this out for good.

## TRP File Analysis submenu (2026-08-11)

User's request: "Add this feature from v1 as trp file analysis in separate submenu in DT data Manager" — a full port of `bts_monitor.html`'s "TRP File Analysis" feature (deep per-file diagnostics for TEMS Investigation `.trp` drive-test files: decode EVERY declared 4G/3G/2G radio field, not just the curated handful the session-upload path stores) into v2, as a fourth child of the existing "DT Data Manager" menu item (alongside Upload/Session History/Explore).

**Scope decision, resolved via AskUserQuestion.** v1's feature has a 4th tab, "AI Report" (sends computed summary stats through v1's local Python AI proxy to generate a narrative write-up). v2 has no AI backend at all — confirmed via a repo-wide grep (no `ANTHROPIC_API_KEY`/`callAI`/AI-proxy endpoint anywhere in `backend-django`) — so porting that tab meant building new backend infrastructure (API key management, a Django proxy endpoint) as a side quest to the parsing port itself. Presented the tradeoff; user chose to skip AI Report for now and revisit it as a separate follow-up. Everything else — Summary, Serving Timeseries, Neighbor Sightings, Best Server Comparison, multi-file combining, XLSX/CSV export, the opt-in "extract every possible field" raw dump — is a full port.

**v2 had NO `.trp` binary decoder at all before this.** `dtTemplateParser.ts`'s own header comment already flagged this explicitly: "the .trp/.nmf binary decoder is... the single highest-risk item in the whole v2 migration... deliberately not rushed in here." This port builds that decoder from scratch in TypeScript (`frontend-react/src/lib/trpAnalysis.ts`) — byte-exact against v1's implementation (varint/ZIP-entry/protobuf-flat-field primitives at v1 lines ~9184-9494, the `TRPA_TECH_FIELDS` per-tech dictionaries and `_trpaAnalyzeFile`/`_trpaCombineResults` engine at ~9910-10339) — rather than reusing/sharing code with `xlsxReader.ts`'s own private ZIP-entry primitives (that file reads `.xlsx` XML parts; this one additionally needs raw-deflate `.trp` payloads and the protobuf-ish declaration/data-record format `.xlsx` never touches — kept separate to avoid coupling two independently-verified parsers). Same verification status as v1's own module comment states: field-path dictionaries CONFIRMED against 3 real `.trp` files (a 4G DL capture, a 4G-to-2G CSFB voice-fallback capture, a standalone 2G voice capture) from the original v1 build; 3G/WCDMA remains UNVERIFIED — no real 3G sample has ever been available in either codebase — kept as best-effort candidate paths, flagged everywhere it's surfaced (`summary.unverifiedTech`, the page's tech banner, the exported workbook's own warning row).

**New files:** `frontend-react/src/lib/trpAnalysis.ts` (the decoder + analysis engine, ~700 lines) and `frontend-react/src/pages/TrpAnalysisPage.tsx` (the UI — multi-file drag/drop upload, extract-raw checkbox, collapsible Files/Combined Summary `<details>` cards, Serving Timeseries/Neighbor Sightings/Best Server Comparison tabs, XLSX/CSV export). Built entirely from v2's EXISTING CSS classes (`.admin-page`, `.dt-drop-zone`, `.feat-tabs`/`.feat-tab`, `.report-table-wrap`/`.admin-table`, `.form-error`, `.muted`, `.btn-primary`/`.btn-secondary`) — no new CSS needed, and native `<details>`/`<summary>` for the collapsible cards instead of porting v1's manual collapse-state JS. On-screen tables cap at 500 displayed rows with a "use Export for the full dataset" note (matches this project's own established rule — see memory `feedback_unbounded_result_tables_crash_browser.md` — and mirrors v1's own identical cap).

**New dependency: `xlsx` (SheetJS) 0.18.5**, added for the multi-sheet XLSX export only (v2 had no client-side XLSX *writer* before this — `xlsxReader.ts` deliberately hand-rolls its own *reader* to avoid this exact dependency, but hand-rolling a correct multi-sheet *writer* is much higher-risk than reading, so this follows v1's own approach for the write side instead). **Known issue, flagged not hidden:** `npm audit` reports 2 high-severity CVEs in this exact package version with "No fix available" (SheetJS stopped publishing patched builds to the public npm registry) — Prototype Pollution and ReDoS, both in `XLSX.read()`'s file-PARSING path. This code only ever calls the WRITE-side API (`utils.aoa_to_sheet`/`utils.book_append_sheet`/`writeFile`) on data this app already computed itself — `XLSX.read()`/`readFile()` are never called anywhere in this codebase — so real exposure to those specific CVEs is low, but worth knowing about if a future change ever uses this library to parse an uploaded file. Lazy-loaded via the existing route-level code-splitting (`React.lazy()`), so the ~300KB (105KB gzipped) it adds only loads for a session that actually visits this one page — confirmed via a real `npm run build`: `TrpAnalysisPage-*.js` is its own separate chunk, not merged into the main bundle.

**Backend:** migration `0028_seed_trp_analysis_submenu.py` adds the "TRP File Analysis" MenuItem as a fourth child of the existing "DT Data Manager" row, same `permission_key`/`access` inheritance pattern `0020_seed_dt_data_manager_submenus.py` already established (so anyone who could already reach DT Data Manager can reach this new child with no extra Permissions-page step). New opaque path `/v8k3nq` added to `frontend-react/src/constants/opaqueRoutes.ts` and `MenuAdminPage.tsx`'s `KNOWN_ROUTES`, matching every other entry's convention.

**Deliberately NOT wired into the DT session upload path** — `DtUploadPage.tsx` still only accepts the CSV/XLSX template. This is a separate, standalone diagnostic tool; nothing it decodes gets saved to `DriveTestSession`/`DriveTestSample` or shows up on the coverage map. Actually connecting `.trp` uploads to session storage remains a distinct, not-yet-scoped follow-up.

## TRP File Analysis engine robustness upgrade (2026-08-11, same-day follow-up)

User's request: "this one is old version created earlier in v1. can you upgrade to more robust engine for trp file extraction." Since `.trp` has no public spec and no known open-source parser exists (confirmed via WebSearch before starting — this port's field-path dictionaries and record-shape heuristics are still the only ground truth there is), "more robust" couldn't mean "conform to a real schema." Presented four concrete, scoped directions via AskUserQuestion; user selected three: auto-discover fields beyond the curated candidate list, a proper message-boundary-aware protobuf walk (replacing v1's original always-advance-one-byte scan), and hardened error handling / partial-file resilience. `.nmf` legacy-format support was offered and explicitly NOT selected — still out of scope.

**Message-boundary-aware declaration scan.** `trpScanDeclarations()` in `lib/trpAnalysis.ts` previously advanced one byte at a time regardless of whether it had just successfully parsed a declaration record — byte-exact with v1, but wasteful and, worse, indistinguishable from actual corruption in its own return value. Now it advances past a successfully-parsed record's real end and only falls back to a single-byte resync on failure, returning `{ decls, resyncCount }` instead of a bare array — `resyncCount` is a genuine signal of how much of the file didn't parse cleanly (surfaced as a warning above 20 resyncs).

**Provider-selection fallback.** Previously, the engine committed to the FIRST `sp{N}` provider whose `declarations.cdf` matched a tech's serving-signal field, then read that provider's `data.cdf` afterward unconditionally — if that specific `data.cdf` turned out missing or corrupt, the whole file failed with no fallback even when another provider entry would have worked. Both declarations AND `data.cdf` are now confirmed readable before a provider is committed to inside `trpaAnalyzeFile`'s provider loop; a failure at either step moves on to the next candidate `sp{N}` and records why in `warnings`.

**Partial-file resilience in the sample scan.** `trpScanDataRecords()` previously `break`d silently the instant it couldn't read a record — no way for the caller to tell "clean end of file" from "the export got cut off mid-drive." It now returns `{ samples, truncated, bytesConsumed, totalBytes }`; `truncated` is set when a record's length prefix can't be read with more than a few bytes still remaining, or when a record's claimed length would run past the buffer's actual end. Verified via a synthetic fixture built in the sandbox (Node's `zlib.deflateRawSync` + hand-built protobuf-shaped declaration/data records, matching the 10-byte-header-then-raw-deflate app-layer shape documented in this project's own CLAUDE.md): a record stream cut off mid-way through decompresses fine but is genuinely incomplete, and the engine correctly recovered 11 of 20 planted samples and reported the truncation, rather than either crashing or silently returning a partial result with no signal. A separately-tested case — the ZIP's stored `data.cdf` bytes themselves chopped so the raw-deflate stream can't decompress at all — correctly triggers the provider-fallback path and, with no other provider available, fails with a clear diagnostic message naming which provider/tech was tried and why it didn't work, instead of an opaque stack trace.

**New `TrpaFileResult.warnings: string[]` field**, populated for: missing/empty GPS track, a high declaration-scan resync count, sample-data truncation (with the recovery percentage), provider fallback events, auto-discovered-field counts, and the pre-existing 3G-unverified flag (previously only visible via `summary.unverifiedTech`, now also a warning string). Surfaced in `TrpAnalysisPage.tsx`'s Upload Queue table (per-file, live during analysis) and the combined Files (N) table (with an Auto Fields count column too), and included as two extra columns (`autoDiscoveredServingFields`/`autoDiscoveredNeighborFields`/`warnings`) appended after the existing columns in the XLSX `Files_Overview` sheet — appended rather than interleaved, so the export stays column-compatible with the previous version for anyone already scripting against it.

**Auto-discovery beyond the curated candidate list.** Each `TrpaTechConfig` gained a `namespacePrefixes` field (`Radio.Lte.` for 4G, `Radio.Umts.`/`Radio.Wcdma.` for 3G, `Radio.Gsm.` for 2G). After the existing curated serving/neighbor field matching, `trpaAnalyzeFile` now scans every remaining declaration under the chosen tech's namespace and classifies it Serving- or Neighbor-shaped by path pattern (`ServingCell`/`ServingSystem` vs. `Neighbor`), adding it under an `auto_<sanitizedPath>` key. This is purely additive — auto-discovered keys get their own columns in the Serving/Neighbor tabs and exports, but summary statistics (`levelField`/`qualityField`/`identityField` etc.) stay pinned to the curated keys, since there's no principled way to decide which of several unknown fields deserves top billing.

**Verified in-sandbox, end to end.** `tsc -b` clean, `npm run build` clean (`TrpAnalysisPage-*.js` still its own 321KB/106KB-gzip chunk, unchanged from the initial port). Additionally — a step beyond what prior TRP-related sessions could do, since no real `.trp` file has ever been available in this environment — compiled `trpAnalysis.ts` standalone to CommonJS and ran it directly under Node 22 (which has a native `DecompressionStream`, same as a browser) against a hand-built synthetic `.trp`-shaped ZIP (stored GPX + 4G declarations/data.cdf parts built with `zlib.deflateRawSync` and hand-encoded protobuf records) covering: a clean well-formed file (confirmed correct tech detection, 20/20 samples recovered, curated + auto-discovered fields all populated, GPS correlation, best-server comparison), a `data.cdf` that fails to decompress at all (confirmed clean provider-fallback failure with a diagnostic message), a `data.cdf` truncated mid-record after successful decompression (confirmed partial recovery + truncation warning), and a `declarations.cdf` with 5 bytes of injected garbage (confirmed the message-boundary-aware scan resyncs and still recovers all curated fields). This is still not a real `.trp` file — the underlying record-shape heuristics remain unverified in that sense, same caveat as the original port — but it is now real proof that the resilience *mechanisms themselves* (truncation detection, provider fallback, resync recovery) function correctly against the byte-level shapes they're designed to handle, not just a `tsc`/`build` pass.

**Verification — real, not just manual review, this session had sandbox access:** `pip install -r requirements.txt` + full migration chain (`0001`→`0028`) against a fresh throwaway sqlite DB, zero errors; `makemigrations core --check --dry-run` clean; confirmed the seeded `MenuItem` row via `manage.py shell` (`TRP File Analysis` correctly parented under `DT Data Manager`). Frontend: `tsc -b` clean after every edit (caught and fixed one real unused-import error along the way), a full `npm run build` succeeded end-to-end and confirmed the lazy chunk split. A standalone Node smoke test (not part of the app, run directly in the sandbox) hand-built a minimal ZIP container and confirmed the ported `trpZipListEntries`/`trpZipReadEntry` byte offsets resolve correctly, plus a varint encode/decode round-trip check across several values (0, 127, 128, 300, 16384, 123456789) — this validates the foundational ZIP/varint plumbing but NOT the higher-level protobuf declaration/data-record scanning or the tech field-path dictionaries, since no real `.trp` file was available in this sandbox to test against (same inherent limitation v1 itself always had — this is a reverse-engineered undocumented binary format with no spec to check against, only real sample files). **Not yet exercised against a real `.trp` file in this port** — recommend the user upload a real 4G and/or 2G `.trp` file (the same kind v1's own confirmed-against files were) as the first live test; if the numbers don't match a known-good v1 export for the same file, that would point at a transcription error in this port rather than v1's original logic (which stays untouched, per this project's own "never edit v1 files" rule).

## External data-exchange API (2026-08-12)

User's request: "add feature to create api to share certain data of system to other and to receive certain data from other system." Genuinely greenfield — a research pass before writing any code confirmed there is no `APIKey`/webhook/third-party-integration concept anywhere in v2, and neither v1's `CLAUDE.md` nor this file mentioned one being planned. Scope was narrowed via `AskUserQuestion` before building: both directions (share out AND receive in), covering **Sites & Sectors** and **Drive Test sessions/samples** only (KPI-thresholds/SLA data and an Alarms category were both offered and not selected — Alarms doubly so, since no alarm/fault model exists anywhere in v2 to expose), header-based **API keys** (not OAuth2, not JWT-reuse), managed by **superadmin only** via a new admin page.

**New top-level surface: `/api/external/v1/`** (`core/external_urls.py` + `core/external_api.py`), deliberately separate from both `/api/v2/` (the React app's own JWT-authenticated contract) and v1's own `/api/v1/`. Every view authenticates ONLY via `X-API-Key` (no JWT/session fallback) — see `core/api_auth.py`'s `ApiKeyAuthentication`.

**Auth design.** New `ApiKey` model (`core/models.py`) stores only a SHA-256 hash of the full key plus a short lookup prefix — same one-way posture this app already uses for user passwords — the full plaintext key (`bw_<prefix>_<secret>`, via `secrets.token_urlsafe`) is generated once, returned in the create response, and never retrievable again (losing it means generating a new key, not "resetting" it). Each key carries a `scopes` list from a fixed vocabulary: `sites:read`, `sites:write`, `dt:read`, `dt:write` — `core/api_auth.py`'s `require_scope(scope)` factory returns a DRF permission class per view checking `request.auth.scopes` (where `request.auth` is the authenticated `ApiKey`, not a Django User — `request.user` stays anonymous for these calls, matching DRF's own documented non-user-token pattern). A dedicated `ApiKeyRateThrottle` (scope `external_api`, rate configurable via `EXTERNAL_API_RATE` env var, default `300/min`) is keyed per-key-prefix, not per-user, and is opted into per-view only — it has zero effect on any `/api/v2/` endpoint.

**Endpoints, all under `/api/external/v1/`:**
- `GET/POST /sites/` — paginated list (filters: `region`, `district`, `updated_since`) / upsert-by-`id` (single object or a capped bulk array, `MAX_BULK_SITES=500`, returns per-item `created`/`updated`/`error` results with 200/207/400 status).
- `GET /sites/<id>/` — full detail incl. nested sectors + 2G/3G KPI JSON blobs.
- `GET/POST /dt-sessions/` — paginated list (filters: `tech`, `date_after`, `date_before`) / create-with-inline-samples (capped `MAX_SAMPLES_PER_REQUEST=5000`).
- `GET /dt-sessions/<id>/` — metadata only, matching the internal API's own "samples can be 100,000+ rows, never inline them" convention.
- `GET/POST /dt-sessions/<id>/samples/` — paginated raw samples / append more to an existing session.

**Deliberately NOT built:** no DELETE anywhere in this module (an external system can create/update but never remove BAGALEWATCH data — matches the "share/receive" framing of the request, not "full remote CRUD"); sector upserts are additive-only, matched by `cell_name`, never deleting an unmentioned sector (the internal `SiteWriteSerializer`'s "full replace" contract would let a partial external KPI push silently wipe sectors it never meant to touch — see `ExternalSiteWriteSerializer`'s own docstring in `core/serializers.py`); every write path uses hand-written plain `Serializer`s (not the internal `ModelSerializer`s) specifically so an OMITTED field stays genuinely absent from `validated_data` instead of being silently defaulted/blanked — true partial-update semantics for a KPI feed that only wants to push a handful of fields per call.

**Internal admin surface:** `ApiKeyViewSet` at `/api/v2/api-keys/` (JWT-authenticated, superadmin-only, same convention as Users/Menu Admin/Permissions/Branding) backs the new **API Access** page (`ApiAccessPage.tsx`, migration `0030_seed_api_access_menuitem.py` seeds its `MenuItem` at opaque path `/n8w5qk`, `access='superadmin'`). Create/edit/revoke/delete keys, pick scopes via checkboxes, optional expiry date. The plaintext key is shown exactly once in a dismissible banner right after creation, with a copy button — never persisted client-side beyond that render, never fetchable again from any GET. The page also documents the base URL, header name, and two example `curl` commands.

**Verification.** The sandbox was unavailable for the entire session this was built in (`mcp__workspace__bash` reported "VM service not running" on every retry), so every file was written and manually re-reviewed line-by-line first — one real bug was caught that way before it shipped (`_upsert_site` was reading the unvalidated raw `id` value instead of the serializer-validated one). The user then ran verification themselves on their real machine: `docker compose exec django python manage.py makemigrations core --check --dry-run` initially reported "No changes detected" / `migrate` reported "No migrations to apply" — a false negative, not a real pass, because neither the `django` nor `frontend` container had been rebuilt yet (this project's `django`/`frontend` services have no source bind mount, see `feedback_docker_migrations_no_persist.md` — `docker compose exec` runs whatever image already exists). After `docker compose build django frontend` + `docker compose up -d django frontend`, `migrate` applied `0029_apikey` and `0030_seed_api_access_menuitem` for real, and the user confirmed the API Access page renders live in the sidebar. Confirmed working end-to-end; a real `.trp`-style live-data smoke test of the external endpoints themselves (an actual external client hitting `/api/external/v1/`) hasn't happened yet — recommend that as the next real-world check.

## Multi-file .trp upload for DT sessions (2026-08-14)

User's request, from 3 screenshots of v2's CSV/XLSX-only DT Session Upload page next to v1's DT Data Manager (which has a working `.trp — 4G only` upload button alongside the template): "add feature to upload multiple .trp file (4g,3g,2g) and extract data and save it as session as working in v1. but in v1 when session is saved from .trp file, all old saved sessions gets erased which is wrong. donot erase any data."

**Reused, not rebuilt, the decoder.** `lib/trpAnalysis.ts`'s `trpaAnalyzeFile()` — built 2026-08-11 for the read-only TRP File Analysis diagnostic page — is the same engine now powering this feature. It auto-detects each file's radio technology (4G/2G confirmed against real files, 3G best-effort/unverified — see that module's own header comment) from the file's own `declarations.cdf`, so `DtUploadPage.tsx` doesn't need a second parser and files don't need to be pre-sorted by tech before upload. This genuinely exceeds what v1 itself can do here: v1's `.trp` upload (`rsrpHandleTrpFiles`, bts_monitor.html ~7779) only ever supports 4G and merges an entire multi-file batch into ONE session using the first file's detected tech, silently mislabeling anything else in the batch. This port instead groups files by their own detected tech first — a mixed 4G+2G selection produces one 4G session and one 2G session, not one mislabeled session.

**Investigated the "erases all old sessions" claim before designing around it.** Read v1's actual `saveDtSession()` (bts_monitor.html ~5895-6015) and its duplicate-check dialog end to end: the real behavior there is a single-session, user-confirmed Cancel/Keep Both/Replace Old decision, identical in shape to what v2's template upload already has — there is no bulk-delete or "clear all sessions" code path anywhere in that function or its callers. The most likely real explanation is CLAUDE.md's own already-documented, still-open v1 bug: "DT session History tab shows '0 sessions' intermittently... likely an IndexedDB timing race between saveDtSession completing and renderDtHistory being called" — a rendering race that makes the list LOOK emptied right after a `.trp` save, not actual data loss. This is a v1-only issue (never touched — v1 files are read-only reference material per `CLAUDE.md`), noted here only so the "donot erase any data" requirement is provably satisfied in v2 by construction rather than by patching a bug that doesn't actually exist in the reused save path: every session this feature creates goes through `createSession.mutateAsync(...)` → `POST /api/v2/dt-sessions/`, the exact same additive-only call the CSV/XLSX template path already uses. `DriveTestSessionViewSet` has no bulk-replace/erase operation in its contract at all (only single-row Create/Destroy) — the only way an existing session is ever removed by this feature is the same single-session "Replace Old" button already in the duplicate dialog, applied per detected-duplicate tech-group, never automatically.

**UI.** `DtUploadPage.tsx` gained a mode toggle ("Template (CSV/XLSX)" / ".trp Files (4G/3G/2G)") above the existing, untouched template flow — the two upload kinds use entirely separate React state (`trpQueue`/`trpSessions`/`trpActiveIdx`/etc. vs. the original `uploadedFile`/`parsedSamples`/etc.) specifically so this new path couldn't regress the already-verified template path. `.trp` mode accepts a multi-file drop (`accept=".trp,.nmf" multiple`), parses sequentially with a live status queue (same pattern `TrpAnalysisPage.tsx` already uses), then walks the user through each resulting tech-group session one at a time — editable auto-generated name (`DT_trp_%date%_%district%_%tech%`, matching v1's own `uploadKind:'trp'` naming exactly), summary cards, coverage map preview, Save/Skip, and the same duplicate dialog (scoped per tech-group so one duplicate in a mixed batch doesn't block the others).

**Field mapping** (`trpRowToDtSample` in `DtUploadPage.tsx`) converts each tech's serving-cell reading into the fixed `DriveTestSample` schema: `rsrp` always carries the generic dBm-scale primary signal (true RSRP for 4G, RSCP for 3G, RxLevel for 2G) — same convention `dtTemplateParser.ts` already uses — with true tech-specific values also populated (`rscp`/`ecno`/`scrambling_code` for 3G, `rx_qual`/`bcch`/`bsic` for 2G). 4G additionally carries `dl` from `pdschThroughput` when TEMS declared it — real, confirmed-decoded data, not the never-verified DL extraction CLAUDE.md flags as broken in v1's own binary decoder. Only serving-cell readings are converted, not neighbor sightings: v1's neighbor-to-site PCI labeling (`_rsrpMatchServingCell`) depends on a full site/sector/azimuth lookup that hasn't been ported into v2, and unlabeled neighbor points would just be noise on the coverage map. Samples missing GPS or falling outside Nepal's bounds (26–31°N, 79–89°E) are dropped per-record, matching v1's own bounds filter in `saveDtSession`.

**Verification.** Sandbox was available this session. `node node_modules/typescript/bin/tsc -b` (the real build-equivalent check — plain `tsc --noEmit -p tsconfig.json` is a documented no-op in this repo, see `feedback_frontend_tsc_noemit_is_a_noop.md`) passed clean, and a full `vite build` succeeded (`DtUploadPage` chunk 19.81 kB gzip 5.90 kB, `trpAnalysis` its own 17.65 kB chunk, no new warnings beyond the pre-existing "large chunk" notice for the unrelated main bundle). Not yet click-tested live against a real `.trp` file in the browser — recommend that as the next real-world check, same as the still-open 3G-unverified caveat inherited from the TRP File Analysis engine.

## `.trp` upload HTTP 413 fix (2026-08-14, same-day follow-up)

The user click-tested the feature above immediately after it shipped, with a real 25-file 4G `.trp` batch — 363,082 GPS points, 99.43 km route. Save failed: "Could not save this session. (HTTP 413)".

**Root cause.** nginx's own default `client_max_body_size` (1MB) rejects the request before it ever reaches Django — `frontend-react/nginx.conf` had no override at all. A 363k-sample session serialized to JSON is on the order of 100MB+ in one POST body, nowhere close to fitting. Confirmed by reading `nginx.conf` end to end (no size directive anywhere) and `settings.py` (no `DATA_UPLOAD_MAX_MEMORY_SIZE` override either — Django's own 2.5MB default would have rejected it too, just with a different error, once past nginx).

**Why "just raise the limits" isn't the whole fix.** Even with both caps raised, a single request asking DRF to validate 300k+ nested `DriveTestSample` items (pure Python, one `to_internal_value()` call per item per field) is slow enough to risk the request just timing out (gunicorn's 120s worker timeout) instead of 413ing — trading one failure mode for another on the very file that exposed this. The real fix is chunking, with the raised limits as defense-in-depth underneath it, not the primary fix.

**What changed:**
- `frontend-react/nginx.conf` — added `client_max_body_size 20m;`.
- `backend-django/bagalewatch_v2/settings.py` — added `DATA_UPLOAD_MAX_MEMORY_SIZE = 20 * 1024 * 1024`.
- `backend-django/core/serializers.py` — new `DT_SAMPLES_BATCH_SIZE = 5000` constant; `DriveTestSessionWriteSerializer` gained `validate_samples()` rejecting an inline `samples` list over that cap (so a non-UI caller — a script, the DRF browsable API — can't bypass it by hitting `create()` directly with everything inline).
- `backend-django/core/drive_test.py` — new `POST /api/v2/dt-sessions/<id>/samples/` action (`DriveTestSessionViewSet.samples()`), admin/superadmin-gated same as `create()`/`destroy()`. Appends a batch of already-validated samples via `bulk_create` to an EXISTING session — purely additive, no update/delete path, same guarantee every other write path in this feature already has. `meta.nearby_site_ids` is updated incrementally (this batch's matches unioned into whatever was already there) rather than recomputed from scratch each call, so it's correct without needing every prior batch's points in memory.
- `frontend-react/src/api/queries.ts` — new `useAppendDtSamples()` hook, deliberately with no per-call cache invalidation (a large session means dozens of sequential batch calls; invalidating `['dt-sessions']` on every one would refetch the whole list that many times for nothing).
- `frontend-react/src/pages/DtUploadPage.tsx` — new shared `saveSessionChunked()`, used by BOTH `doSave()` (template path) and `doSaveTrp()` (`.trp` path): creates the session with the first `SAMPLES_BATCH_SIZE` (5000) samples inline, then streams the rest through `useAppendDtSamples()` in same-sized batches, with a live "Saving X / Y points…" status line and the Save button staying disabled for the whole sequence (`savingBusy`, not just the first request's `isPending`). One `qc.invalidateQueries(['dt-sessions'])` after the full sequence completes, not per-batch. If a batch fails partway through, the session already exists with whatever landed before the failure — the error message says so explicitly and points at Session History rather than implying the upload vanished with no trace, since that's exactly the kind of "did my data just disappear" confusion this same feature was built to avoid in the first place.

**Verification.** The sandbox went down mid-session ("VM service not running — restart your computer") for the entire duration of this fix, so `tsc -b`/`vite build` could not be re-run at write time. It came back up shortly after and all three checks were then run for real: `tsc -b` clean, `vite build` clean, Django `manage.py check` clean (`DJANGO_DB_ENGINE=sqlite`), `makemigrations core --check --dry-run` correctly reports no pending migration (settings/serializer/view-only change, no model change). Still needs `docker compose build django frontend` + a retry of the exact same 25-file/363k-point upload on the user's real machine as the next check — this is the one bug in this whole feature that's now been hit by real production data.

## Coverage map slowness on large sessions (2026-08-14, same-day follow-up)

Right after the 413 fix above, the user reported "application is acting too slow." Confirmed via a clarifying question that it was specifically tied to opening/viewing the same 363,082-point session, not a general app-wide slowdown.

**Root cause.** `DtCoverageMap.tsx` (used by both the DT Session Upload preview and Session History's session detail panel) draws one real `L.circleMarker` — an actual SVG element, not canvas, per that file's own multi-day debugging history from 2026-07-29 — per GPS-tagged sample, with no cap. Its own header comment said outright: "DT sessions run a few thousand points at most... plain CircleMarkers via raw Leaflet calls are fast enough." That assumption held until the `.trp` multi-upload feature (same day) made a 363k-point session possible for the first time; rendering 363,082 real SVG nodes froze the tab.

**Fix.** New `subsampleForMap()` helper in `lib/dtBands.ts` — evenly STRIDES through the array down to `MAX_MAP_DOTS = 15000` rather than truncating to the first N, so a long route still shows its full geographic extent, just less densely sampled, instead of only its first few kilometers. `DtCoverageMap.tsx` now draws `subsampleForMap(withGps)` instead of the raw array; `fitBounds` still uses the full, un-subsampled point set (cheap, a single min/max pass) so the map always frames the real full route. A visible note appears under the legend when subsampling actually happened ("Showing X of Y GPS points... the summary stats above use every real point") — same transparency convention as `TrpAnalysisPage.tsx`'s "Showing first 500 of X rows," never a silent truncation.

**Deliberately NOT applied to `DtCompareMap.tsx`.** That file's own comment records an explicit prior user reversal (2026-08-07) of a similar point cap on its blank/plots-only panel: "do not limit to 500, i was confused earlier, need full plot there" — and its own stated guidance for future perf problems there is "prefer canvas-based rendering... over silently dropping points again," not to reapply a cap. Compare's real-Leaflet-map mode (`CompareDots`) has the same latent unbounded-rendering shape as the fixed `DtCoverageMap`, but given that explicit history this needs its own separate decision with the user, not an automatic extension of today's fix. Flagged to the user; not yet acted on.

**Verification.** Sandbox was back up for this one — `tsc -b` and `vite build` both passed clean (`DtCoverageMap` chunk 2.51 kB / `dtBands` chunk 2.74 kB, both trivially small changes). Not yet click-tested live against the real 363k-point session — recommend reopening it in Session History as the next check; should now render in roughly the time it takes to draw 15,000 dots instead of 363,000.

## `.trp` compound-event detection (2026-08-15, same feature area)

Looking at the two auto-named `DT_trp_...` sessions in Session History (one from the 4G DL check, one from the 4G fallback check), the user asked for something beyond the existing coverage-map plot: **"detect and store separately but relating to session as particular events for which the log is taken like fallback events from fallback log, download success event from DL log etc"** — using TEMS's own explicit event markers, not inferred signal thresholds. Three real `.trp` sample files were provided (a 4G DL/FTP capture, and two voice-call captures) to ground the design in real data before writing anything, per this project's standing anti-fabrication rule.

**What was found by hand first.** ZIP-inspecting the 3 real files (Python, read-only forensics — no app code touched yet) showed TEMS declares compound "Event" records under `Call.*`/`Data.*`/`Location.*`/`General.ServiceProvider.*` namespaces that `lib/trpAnalysis.ts`'s existing `trpaAnalyzeFile()` never reads — that engine only ever decodes ONE level of nesting (a sample record's flat parameter list). These compound events nest a SECOND full `[declared id, value]` parameter list one level deeper, inside what the outer decode treats as an opaque byte value. Real decoded examples confirmed by hand: `Call.CallSetupEvent.SetupTime`, `Call.CallEndEvent.Cause`/`.CallEstablished`, `Data.Ftp.Download.EndEvent.ServiceStatus`/`.ServiceThroughputAverage`/`.FileSize`, `Data.SessionStatisticsEvent.TimeSpentOnLte`. Numeric enum meanings (e.g. `ServingRadioTechnology=4`, `CallDomain=2`) could not be confirmed against any public TEMS documentation — stored as raw codes, not translated, per the same rule.

**User's scoping answers, followed exactly.** "How should detected events be stored/shown for a session?" → **"Just bundle into session meta JSON"** (the Recommended option, a dedicated events table/model, was explicitly declined). "Which event categories should this cover first?" → **"according to the log file"** — i.e. detect whatever event types a given file's own declarations actually contain, generically, not a fixed upfront Call/Data/Location category list.

**Implementation — `lib/trpAnalysis.ts`.** New generic recursive decoder, NOT a hardcoded per-category field dictionary (matches "according to the log file"): `trpScanEvents()` walks every sample record's parameter list (independent of the curated `wantedIds` scalar dictionary the rest of the engine uses, since event-root declarations were never added to that dictionary), and for every parameter whose value is length-delimited bytes, `trpTryDecodeEventFields()` attempts to decode it as a nested `[child declared id, value]` list using the exact same wire-shape logic the outer parameter list already uses. If every child id resolves to a real declaration, it's a genuine compound event (`type` = the outer field's own declared path, e.g. `"Call.CallEndEvent"`); if decoding fails or even one child id is unrecognized, it's left alone as an ordinary field — conservative, not a best-effort guess. `trpaAnalyzeFile()` now returns `events: TrpaEventRow[]` (ts/isoTs/lat/lon/type/fields), correlated to GPS the same way regular samples are.

**A real tuning pass, verified live against the 3 sample files (not left to guesswork).** The first version of this decoder was run against the real files via a standalone `tsc`-compiled harness (Node's own `DecompressionStream`, no browser needed) and found 426/82/300 "events" per file — technically all genuinely, correctly decoded, but the overwhelming majority were raw over-the-air Layer3 protocol messages (`Message.Layer3.*` — MeasurementReport, PagingRequest, SystemInformation, the GSM Cc/Mm/Rr call-control messages — plus a generic `Radio.Common.Layer3MessageEvent` wrapper firing once per message). That's a protocol TRACE, not the named business/service occurrences the user described ("fallback events... download success event"), and bundling hundreds of them into every session's persisted `meta` JSON (fetched on every session-list load) would be wrong for what `meta` is for. Added a 2-item exclusion (`Message.Layer3.` prefix + the `Radio.Common.Layer3MessageEvent` wrapper) — re-run against the same 3 files afterward: 8 / 60 / 6 events respectively, all genuinely meaningful (full call lifecycle in file 1 including `CallSetupEvent`/`CallEndEvent`; two complete FTP download cycles plus periodic `Radio.Lte.SessionStatistics.*`/`SessionUsage.*` snapshots in the DL file; and, in file 3, a real find — no `CallEndEvent` at all, but a `General.ServiceProvider.HealthChangedEvent` reading "Device restart due to DiagnosticMalfunction" followed by a `Location.PositionLostEvent`, a genuine TEMS-native explanation for that capture being the odd one out). This exclusion is a targeted firehose cutout, not a narrowing back down to a fixed category whitelist — everything else any file's declarations contain (Call/Data/Location/Dial/General.ServiceProvider/Radio.Lte session-statistics snapshots, etc.) still gets picked up automatically.

**Wiring — `api/types.ts`, `DtUploadPage.tsx`, `DtSessionHistoryPage.tsx`, new `DtEventsTable.tsx`.** New `DtSessionEvent` type (`ts`/`type`/`sourceFile`/`lat`/`lng`/`fields`) and `DtSessionMeta.events?: DtSessionEvent[]` — bundled straight into the existing meta blob, exactly as the user chose, no new model/migration/table. `buildTrpSessions()` in `DtUploadPage.tsx` now also collects each file's `events`, tags them with `sourceFile`, sorts by time, and sets `meta.events` per tech-group session — so events ride along with the same `createSession`/`saveSessionChunked` save path everything else in this feature already uses (no new save call). New shared `DtEventsTable.tsx` component (time / event type / flattened field=value details / source file) renders in both the `.trp` upload review screen and the saved-session detail view in Session History — one component, not duplicated JSX, since both read the identical `DtSessionMeta.events` shape. CSV/XLSX template uploads never populate `events` (no such stream exists in a flat template) — the table renders nothing when absent, no guard needed at call sites.

**Verification.** `tsc -b` and `vite build` both clean. Beyond type-checking, the actual decoder was run live against all 3 real uploaded sample files via a standalone Node harness (not just asserted) — output reviewed by hand line-by-line, confirmed to exactly reproduce every event this session's earlier manual Python forensics had found (including the previously-uncertain "SetupTime=3339.23ms"/"Cause=2" style values), plus additional real events the manual pass hadn't gone as deep to find. Not yet click-tested live in the browser UI — recommend uploading one of the 3 real sample files through DT Session Upload's `.trp` mode as the next check, and reviewing the Events table that appears under the coverage map.

## `.trp` call/download KPI summary — replaces the raw event table (2026-08-15, same-day follow-up)

Immediately after seeing the raw event table above, the user clarified what they actually wanted: **"i need to store only the data like total no. of call attempted, total call success, total call drop, total call rejected, percentage... for 4g dl, total no. of download attempted, total download succeed, total download fail... for 4g fallback, total no. of call attempted, total no. of fallback, success, fail"** — aggregate KPI counts, not a per-event dump.

**No new decoding needed** — this is pure aggregation over the same `TrpaEventRow[]` the previous pass already verified correct. The hard problem was classification, not decoding: TEMS's own numeric `Cause`/`EndType`/`CallEstablished` codes on `Call.CallEndEvent` have no public documentation (confirmed via another `WebSearch` pass — a Scribd doc titled "TEMS Investigation Call Event Definitions" that might have had the answer was blocked by a JS client-challenge, and no forum/vendor page surfaced the actual mapping), so building "success vs. drop vs. rejected" on top of those codes would have meant guessing — exactly the fabrication risk this project has flagged repeatedly for this file format.

**The fix: classify by which named TEMS events fired, not by interpreting ambiguous codes.** New `trpaSummarizeCallEvents()`/`trpaSummarizeDownloadEvents()` in `lib/trpAnalysis.ts`, both pure functions over `TrpaEventRow[]`:
- **Calls** (grouped by each event's own `CallIndex` field, present on every `Call.*` event type): `attempted` = has `CallAttemptEvent`/`CallInitiationEvent`; `setupSuccess` = also has `CallSetupEvent` (TEMS's own "setup completed" marker — the standard Call Setup Success Rate definition); `rejected` = attempted, never reached setup; `completed` = setup reached AND a `CallEndEvent` exists; `dropped` = setup reached, NO `CallEndEvent` ever — the standard telecom call-drop definition (a connected call that ended abnormally), and directly confirmed against real data: sample file `ff023691.trp`'s call reaches `CallSetupEvent` but its provider never even *declares* a `CallEndEvent` type for that call at all, and that same file logs a `General.ServiceProvider.HealthChangedEvent` reading "Device restart due to DiagnosticMalfunction" right where a normal call would still be running — real structural evidence of a drop, not an inference from a guessed code. `fallbackDetected` = `Call.CallEndEvent.SrvccHandoverOccurredDuringCall` decoded as `1` — TEMS's own literal, self-describing SRVCC/fallback marker (the field's own name states its meaning, no external table needed). Stated plainly rather than hidden: this flag only ever appears ON a `CallEndEvent`, so a dropped call's fallback status is structurally unreadable from it — and none of the 3 real sample files had it fire true, so real fallback counts read 0 until an actual CSFB-triggering capture is uploaded.
- **Downloads**: `attempted` = count of `Data.Ftp.Download.BeginEvent`; `succeeded` = the paired `EndEvent` reports a real positive `FileSize` or `ServiceThroughputAverage` (i.e. TEMS actually recorded completion data) — again structural, not a status-code guess; `failed` = the rest.

**Live-verified against the 3 real files** (same standalone Node+tsc harness as the event-decoder pass): file `8e83a1b3` (clean voice call) → `{attempted:1, setupSuccess:1, completed:1, dropped:0, fallbackDetected:0}`. File `e21b9d3e` (4G DL) → `{attempted:2, succeeded:1, failed:1, successRatePct:50}` — matches the real data exactly (first FTP cycle's `EndEvent` has `FileSize=10534912`/`ServiceThroughputAverage=4391.4`; second cycle's has neither). File `ff023691` (the device-restart file) → `{attempted:1, setupSuccess:1, completed:0, dropped:1, dropRatePct:100}` — correctly flags the call as fully dropped.

**Storage/UI change.** `DtSessionMeta` gained `callSummary?: DtCallSummary` / `downloadSummary?: DtDownloadSummary` (new types in `api/types.ts`); `DtUploadPage.tsx`'s `buildTrpSessions()` now pools all events across a tech-group's source files and calls the two summarizers into `meta.callSummary`/`meta.downloadSummary` instead of writing the raw `meta.events` list from the previous pass. New `components/DtCallDownloadSummary.tsx` (report-card style, matching the existing GPS Points/Route Distance card row) replaces `DtEventsTable.tsx` in both `DtUploadPage.tsx`'s `.trp` review screen and `DtSessionHistoryPage.tsx`'s session detail view — only renders a call/download card row when that summary is actually present, so a pure-DL session shows only download cards and a pure-voice session shows only call cards. `DtEventsTable.tsx`/`DtSessionEvent`/`TrpaEventRow`/`meta.events` are all left in place (not deleted) as a lower-level building block a future raw/diagnostic view could still use — they're just no longer what gets written into a session's persisted meta.

**Verification.** `tsc -b` and `vite build` both clean. The two summarizer functions were run live against all 3 real sample files (not just type-checked) with output hand-reviewed against the real event data already verified in the pass above — numbers match by construction (pure aggregation over already-verified events) and were spot-checked against the real `FileSize`/`ServiceThroughputAverage`/declared-namespace evidence. Not yet click-tested live in the browser UI.

## `.trp` test-type naming + sample decimation (2026-08-15, same-day follow-up)

Two more real, concrete problems the user hit after using the feature above:

**1. Two sessions with the identical auto-generated name.** A real upload produced `DT_trp_20260611_Chitwan_4G` twice — one from the 4G DL test, one from the 4G Fallback (CSFB voice) test — with nothing in Session History to tell them apart. Root cause: the auto-naming scheme (`DT_trp_%date%_%district%_%tech%`) only ever encoded the SERVING-CELL tech, never which of NTC's standard test types (DL / Fallback / plain Voice) the underlying capture actually was.

Fix: new `detectTrpTestType(tech, callSummary, downloadSummary)` in `DtUploadPage.tsx`, using the SAME structural evidence the KPI-summary pass above already computes — no new decoding. A session with `downloadSummary` and no `callSummary` is `'DL'`; a session with `callSummary` and no `downloadSummary` is `'Fallback'` when its overall tech is 4G (matches the real NTC methodology already established in this conversation: the call itself falls back to 2G/3G mid-call while the surrounding serving-cell samples stay predominantly 4G) or `'Voice'` for 2G/3G; both present is `'Mixed'`; neither is untyped (no suffix, same as today). The auto-generated name now reads `DT_trp_%date%_%district%_%tech%_%testType%` (e.g. `..._4G_Fallback` vs. `..._4G_DL`), and `meta.testType` is stored alongside for any future filtering/badge use. The review screen's tech/file-count badge also shows the detected type before saving.

**2. Millions of points, slow to extract and load.** The user's own comparison: their org's usual CSV/XLSX exports (produced by TEMS itself from the same `.trp` captures) "give less points but the exact picture of the dt plot," while this app's direct `.trp` decode "gives millions of points and takes time to extract and load." Root cause, confirmed against real data: TEMS's raw internal scan rate for the curated `Radio.*` serving-cell fields this engine reads runs several times a second — the real 4G DL sample file alone produced 1446 rows across ~41 seconds, roughly 35/sec. A full multi-file drive test at that rate genuinely reaches into the hundreds of thousands to millions of rows. Critically, nearly all of that density is manufactured, not real: every row's GPS position is LINEARLY INTERPOLATED between the same two real GPX waypoints (`trpCorrelateGps`), so sub-second samples along the same short interpolated stretch of road add negligible new spatial information — they're closely-spaced repeat measurements, not new ground truth.

Fix: new `decimateTrpRows()` in `DtUploadPage.tsx` — keeps at most one serving-cell row per whole second (first chronologically in each second-bucket), applied to each file's `servingRows` BEFORE they're converted to `DtSample`s in `buildTrpSessions()`. This shrinks every downstream cost that scales with sample count, not just what gets drawn on the map (`subsampleForMap`, from the earlier 2026-08-14 fix, was already capping the MAP RENDER but not the underlying stored/uploaded data) — fewer `saveSessionChunked()` batches, a smaller `GET` payload every time the session is reopened in Session History, smaller `meta`. A visible note appears under the summary cards whenever decimation actually reduced the count ("Decoded X raw radio samples... saving Y (decimated to at most 1 per second)...") — never silent, same convention as every other capping decision in this feature area. Deliberately scoped to ONLY the DT session save path in `DtUploadPage.tsx`, not `lib/trpAnalysis.ts`'s shared engine — the separate TRP File Analysis diagnostic page still wants every real decoded sample for its own deep per-file stats.

**Live-verified reduction against the 3 real sample files** (same standalone Node+tsc harness): `8e83a1b3` (voice) 239 → 47 rows; `e21b9d3e` (4G DL) 1446 → 54 rows (~27x); `ff023691` (voice) 168 → 34 rows. A real 363,082-point/25-file production session (the one that originally triggered the HTTP 413 fix) would be expected to shrink by a similar order of magnitude, though that hasn't been re-tested against this exact file set.

**Verification.** `tsc -b` and `vite build` both clean. `detectTrpTestType` reasons purely over already-verified `callSummary`/`downloadSummary` presence (no new decoding to verify). `decimateTrpRows` was run live against real decoded `servingRows` from all 3 sample files via the same Node harness as the earlier passes, with real before/after counts confirmed by hand (not just asserted). Not yet click-tested live in the browser UI — recommend re-uploading a real multi-file `.trp` batch as the next check, watching both the new test-type suffix in the auto-generated name and the decimation note.

## Full memory/size/performance audit (2026-08-15, same-day follow-up) — a reported memory crash

Follow-up to the 2026-08-07 audit ([`docs/v2_memory_size_security_audit_2026-08-07.md`](./v2_memory_size_security_audit_2026-08-07.md)), triggered by a reported memory crash. Full report: [`docs/v2_memory_size_perf_audit_2026-08-15.md`](./v2_memory_size_perf_audit_2026-08-15.md).

**Most likely root cause, High severity:** `DtCompareMap.tsx`'s `ScatterPanelPlot` — the default panel every Compare Sessions metric panel starts on — rendered one real SVG `<circle>` DOM node per sample, with no cap at all. This was a DELIBERATE decision: a cap was added and then explicitly reverted on 2026-08-07 per direct user feedback ("do not limit to 500... need full plot there"), with standing guidance left in the code to switch to canvas rendering instead of re-capping if this ever became a real problem. It now has, for a concrete reason: `.trp`-derived sessions can reach tens to hundreds of thousands of points, roughly two orders of magnitude beyond what motivated that 2026-08-07 decision, and Compare Sessions fetches + renders up to 4 full sessions across several metric panels simultaneously.

**Fixed exactly per that standing guidance — canvas, not a new cap:** `ScatterPanelPlot` now draws on `<canvas>` (same technique as `ScatterPlotPage.tsx`) — every real point is still plotted, nothing dropped, only the render target changed from DOM nodes to pixels. Hover tooltips preserved via an O(1) spatial-grid hit-test (built during the same draw pass) instead of an O(n) per-mousemove scan. `CompareDots` (the real Leaflet map mode, loaded per-panel on click) and `DtExploreTab.tsx`'s `NearSamplesLayer` (fed by the backend `near()` endpoint, which has no row cap of its own beyond a 50km radius bound) both had the same unbounded `L.circleMarker`-per-sample shape — both now run their samples through the same `subsampleForMap()` (≤15,000 dots, evenly strided, visible note) `DtCoverageMap.tsx` already established on 2026-08-14.

**Also fixed:** no query in the app previously overrode React Query's default 5-minute `gcTime` — `useDtSession()` and Compare Sessions' `useQueries` block both now use a shared 60s `gcTime` (`DT_SESSION_GC_TIME`, `api/queries.ts`), so large session payloads don't linger fully resident in memory for minutes after their component unmounts.

**Flagged, not fixed this pass (needs a decision, not a silent change):** `GET /dt-sessions/<id>/` (`DriveTestSessionDetailSerializer`) still returns every sample with no pagination/cap — new `.trp` uploads already avoid this via the earlier same-day decimation fix, but already-saved large sessions (like the known 363,082-point one) still hold their full original row count in Postgres and get fully downloaded every time they're opened. A permanent server-side decimation of already-saved sessions would need explicit user go-ahead first (it means deleting real recorded rows); a lighter alternative (a `?max_samples=` query param returning an evenly-strided subset) is noted as a follow-up option, not implemented.

**Verification.** The sandbox was unavailable for this entire audit ("VM service not running") — `tsc -b`/`vite build` could not be re-run. Every new construct used (canvas 2D context, `ResizeObserver`, `gcTime`) already has a working precedent elsewhere in this codebase, and the changed files were reviewed line-by-line against those originals for type-shape consistency, but this is explicitly NOT the same as a passing build — **run `tsc -b` and `vite build` as the first next step once the sandbox is back**, before treating this pass as fully verified.

## `.trp` save-time decimation walked back — flat 1/sec cap was over-correcting (2026-08-17)

Immediately after the "millions of points" decimation fix above shipped, the user reported the opposite problem: "plot from .trp upload is giving very less points. need clear plot in dt path" (with a screenshot of a visibly sparse/gappy DT coverage-map route).

**Root cause.** `decimateTrpRows()` applied its ≤1-sample/sec cut to EVERY `.trp` upload unconditionally, per file, regardless of how large that file actually was. The original complaint it was solving was specifically about a pathological multi-file/multi-hour capture (the known 363,082-row/25-file session) — but the fix as written also thinned ordinary small/typical single-file tests that never had a performance problem in the first place, throwing away real decoded density (real measured rates: 239, 1446, 168 raw rows for three ~40-second sample files) and making short/normal routes look sparse instead of continuous. Two different problems (render performance vs. save/upload size for genuinely huge captures) had been collapsed into one blanket rule that penalized the common case to guard against the rare one.

**Fix, in `DtUploadPage.tsx`.** `decimateTrpRows()` and its per-file, always-on time-bucketing are removed entirely. In its place, `buildTrpSessions()` now:
1. Converts every file's decoded `servingRows` to `DtSample`s at full fidelity, no reduction.
2. Concatenates all of a tech-group's files together (as it already did).
3. Only THEN, once, applies a single group-level cap — `TRP_SAVE_SAMPLE_CAP = 50000` — via the same evenly-strided `subsampleForMap()` the coverage map's own render-time cap already uses (imported from `lib/dtBands.ts`), after sorting the combined samples chronologically so a triggered cap still preserves the full geographic extent of the route rather than favoring one file.

This means a typical single- or few-file test (well under 50,000 combined rows) now saves with its full real decoded density — no artificial thinning, directly addressing "need clear plot in dt path." A session that genuinely crosses the cap (the 363k-row pathological case) still gets bounded, at a ceiling more than 3x the map's own 15,000-dot render cap, so it's never the tighter constraint in practice. The map's own `subsampleForMap()` in `DtCoverageMap.tsx` is unchanged and still independently protects render performance regardless of how much is stored — the two caps now cleanly separate "how much do we store/upload" from "how much do we draw," instead of one setting trying to do both jobs. The visible reduction-disclosure note (only shown when the cap actually triggers) was reworded to describe the cap instead of the old fixed 1/sec interval.

**Verification.** The sandbox was still down at the time of this fix ("VM service not running") — changes reviewed manually line-by-line, not compiled. `subsampleForMap` is an existing, already-verified generic helper reused as-is (no new logic in it); the only new code is the group-level call site and the chronological sort, both straightforward. **Run `tsc -b` and `vite build`, then re-upload a real small/typical `.trp` file to confirm its plotted route now looks dense/continuous, as the first next step once the sandbox is back.**

## Compare Sessions blank scatter panel rendering black instead of white (2026-08-17)

Real screenshot from the user showed `DtCompareMap.tsx`'s `ScatterPanelPlot` (the default canvas-based scatter panel, rewritten from SVG on 2026-08-15 as part of the memory-crash audit, never build-verified until now) rendering on a black background instead of the intended white — `.dt-compare-panel-blank`'s CSS already sets `background: #ffffff` on the wrapping div, but that only shows through if the `<canvas>` itself stays fully transparent, which isn't guaranteed across browsers/dark-mode configurations for an un-styled canvas element.

**Fix.** Two redundant guarantees, both in `ScatterPanelPlot`: (1) the canvas element now has an explicit inline `style={{ background: '#ffffff' }}`, and (2) `draw()` paints an explicit white `ctx.fillRect(0, 0, W, H)` right after `ctx.clearRect(...)`, so the canvas's own pixels are white rather than relying on transparency plus a parent div's CSS. Either alone would likely have fixed it; both together make it independent of any future CSS/theme cascade change.

## pgAdmin added — web-based Postgres access via URL (2026-08-20)

User tried opening `localhost:5432` in a browser expecting to see the database and got "site can't be reached" — Postgres speaks its own wire protocol, not HTTP, so that was never going to work regardless of port publishing; on top of that, `db`'s `ports:` are deliberately unpublished (2026-08-08 LAN-hardening pass), so nothing was even listening on the host at all.

**Added:** a `pgadmin` service (`dpage/pgadmin4`) to `docker-compose.yml`, giving a real browser-reachable admin UI at `http://localhost:5050`. Bound to `127.0.0.1:5050:80` only — same LAN-hardening reasoning as every other `ports:` decision in this file; this is a raw admin surface over the entire database, so it never gets a bare/LAN-facing port. Depends on `db` being healthy first. Two new root `.env` vars, `PGADMIN_EMAIL`/`PGADMIN_PASSWORD` (own pgAdmin login, unrelated to the app's own users) — a real password was generated and written directly into the local `.env` (never into chat, never committed — `.env` stays gitignored like the rest of this file's secrets).

**Persistence + convenience:** new named volume `bagalewatch_v2_pgadmin_data` (pgAdmin's own internal config DB — saved connections/preferences — entirely separate from `bagalewatch_v2_pgdata`, which is the actual application data pgAdmin connects TO). `pgadmin/servers.json` (new file, read-only bind mount) pre-registers a "BAGALEWATCH v2 (docker)" server pointing at `db:5432`/`bagalewatch_v2`/`bagalewatch` so the server tree isn't empty on first login — it can only carry host/port/db/username, never a password (pgAdmin has no secure way to pre-seed one), so the first connection still prompts once. If `POSTGRES_USER` has ever been changed from the `bagalewatch` default, this file's `Username` needs a matching manual edit or the pre-registered connection will fail.

**Verification.** `docker-compose.yml` YAML and `pgadmin/servers.json` JSON both parse clean (`python3 -c "import yaml; yaml.safe_load(...)"` / `json.load(...)`). Docker itself isn't available in this sandbox, so `docker compose up -d pgadmin` and an actual browser login were NOT run here — that's the real next step on the user's machine.

**Real bug hit on first actual run:** the container crash-looped (`Restarting (1)`, `localhost:5050` refused to connect). `docker compose logs pgadmin` showed the real cause: `'admin@bagalewatch.local' does not appear to be a valid email address... The part after the @-sign is a special-use or reserved name`. pgAdmin's `PGADMIN_DEFAULT_EMAIL` runs through an email-format validator that rejects reserved/special-use TLDs (`.local` is one, being the mDNS reserved domain) even with `CHECK_EMAIL_DELIVERABILITY: False` — that setting only skips the DNS-deliverability check, not basic syntax/domain validation. Fixed by changing the default (and the value already written into the user's real `.env`) from `admin@bagalewatch.local` to `admin@bagalewatch.app` in both `docker-compose.yml` and `.env.example`. This is a real, confirmed-live crash+fix, not a guess — caught from the user's own `docker compose ps`/`logs` output. Next step after this fix ships: `docker compose up -d pgadmin` again to pick up the corrected `.env`, then re-check `docker compose ps` shows it `Up`/healthy before retrying `http://localhost:5050`.

**Verification.** Sandbox still down at time of fix — reviewed manually, not compiled. Purely additive (one CSS property, one canvas fill call), no logic change to point plotting. Recommend re-opening Compare Sessions on any session pair as the visual check once the sandbox/build is available.
