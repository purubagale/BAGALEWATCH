# DT-WATCH BTS v2 — Project Brief

> Generated 2026-10-02, last updated 2026-10-11. This file is the fast-load orientation doc for this
> repo — read this instead of re-deriving architecture/status from scratch.
> For an always-fresh, DB-introspected reference (every model field, every
> menu item, every role's permission counts), use the in-app Documentation
> page (superadmin/admin, `/api/v2/system-doc/`) instead of duplicating that
> here — this file covers what that endpoint doesn't: conventions, workflow
> gotchas, and current project status.

## What this is

Nepal Telecom's 4G RAN Operations & Maintenance platform — site/sector
inventory, KPI tracking, drive-test analysis, crowdsourced telemetry
coverage, RF optimization report import, and the admin surfaces (RBAC,
audit logging, live site sync) that support them. Single-tenant Django
REST Framework + React application, deployed via Docker Compose.

This is the **v2 rewrite** (Django + React) of a legacy single-file HTML
dashboard (`bts_monitor.html`, documented in the parent directory's own
`CLAUDE.md` one level up from this repo) — that file describes a different,
earlier project, not this one. Ignore it when working in this repo.

## Tech stack

| Concern | Choice |
|---|---|
| Backend | Django 5 + DRF, one app: `core` |
| Database | PostgreSQL 16 + PostGIS |
| Cache / ephemeral state | Redis (login lockout counters, SSO transaction state, rate limits) |
| Auth | JWT (SimpleJWT) + optional Keycloak SSO (OIDC) |
| API docs | drf-spectacular — `/api/v2/schema/`, `/api/v2/docs/` |
| Frontend | React 19 + TypeScript + Vite, React Query for server state |
| Maps | Leaflet + MarkerCluster |
| Deployment | Docker Compose, 4 services (see below) |

## Repo layout

```
backend-django/core/*.py       One file per feature area (not MVC folders) —
                                e.g. password_reset.py, audit.py, rf_reports.py,
                                telemetry_admin.py, roles.py, sso.py. models.py
                                holds every model; serializers.py every
                                serializer; urls.py wires it all together.
backend-django/core/migrations/  119 migrations as of 0119. Numbered sequentially,
                                  no squashing.
frontend-react/src/pages/*.tsx  51 pages, one per route. Most are React.lazy()
                                 imported in App.tsx except Login/Sites/Dashboard
                                 (the pages nearly every session hits immediately).
frontend-react/src/api/
  client.ts                     apiFetch/apiJson, token storage (sessionStorage),
                                 ApiError, apiErrorMessage()
  queries.ts                    Every React Query hook, grouped by feature
  types.ts                      Every TS interface for API payloads
docker-compose.yml               4 services: db, redis, django, frontend.
                                  The four background jobs (site sync,
                                  telemetry retention, coverage roll-up,
                                  audit-log pruning) run inside django:
                                  entrypoint.sh starts `manage.py
                                  run_maintenance` next to gunicorn.
                                  RUN_MAINTENANCE=0 turns them off.
docs/                            Dated audits, server migration guides, runbook
```

## Critical workflow facts (learned the hard way this session)

- **The `django` service has NO bind mount for source code.** Editing a
  `.py` file on the host does nothing to the running container until you
  `docker compose build django && docker compose up -d django`. Same for
  `frontend` (`docker compose build frontend && docker compose up -d
  frontend`) — `build` alone does not recreate the running container.
- **Generating a migration requires the named-container pattern**, not
  `--rm`: `docker compose run --name tmp_X django python manage.py
  makemigrations core`, then `docker cp tmp_X:/app/core/migrations/XXXX.py
  ./backend-django/core/migrations/`, then `docker rm tmp_X`. A plain
  `--rm` run destroys the generated file along with the container before it
  can be copied out.
- **Always run `python manage.py makemigrations --check --dry-run` before
  committing a `models.py` change** — a missed migration (e.g. a `choices=`
  change on an existing field) won't fail `manage.py check` but will show up
  here. Apply + regenerate the image before committing.
- **This dev machine's Docker Desktop is capped at 2 CPUs**, regardless of
  the host's real core count. Every `cpus:`/`mem_limit:` value in
  `docker-compose.yml` is `${VAR:-default}`-driven for exactly this reason
  — override via `.env` on a real production host, never hardcode.
- **Frontend is published on port 5180**, not 8080 — `docker compose ps`
  to confirm before smoke-testing with curl.
- **Bash tool + this repo's path**: the parent directory name contains
  `O&M`, which breaks naive shell invocations that shell out through
  `cmd.exe` (notably `npx` on Windows — it errors on the bare `&`). Run
  `node ./node_modules/typescript/bin/tsc -b --force` and `node
  ./node_modules/vite/bin/vite.js build` directly instead of via `npx`.
- **Git on this checkout warns `LF will be replaced by CRLF`** on every
  staged file — expected/harmless (`.gitattributes` config), not a sign of
  unintended line-ending churn.
- **Only commit when explicitly asked.** This project's established
  pattern: build and verify first, commit as a separate, explicit step.
- **The local Docker stack is dev only. Production is a separate
  deployment** at `/data/dtwatch` on the prod server (`dtwatch.ntc.net.np`,
  private IP, reachable only on the NTC network or VPN). The user pulls,
  rebuilds and migrates there themselves. "Verified" means verified
  locally unless the user confirms it on prod. The entrypoint runs
  `migrate` on container start.
- **Docker Desktop is often closed.** Start it with PowerShell
  `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"` and
  wait for `docker info` to succeed.
- **Use the Edit tool for file changes, one file at a time.** A Bash or
  Python script that edits several files at once is denied in auto mode.
- **After recreating `django`, the local frontend can answer 502** because
  nginx still holds the old container address. `docker compose restart
  frontend` fixes it.
- **On-screen text is plain user language.** No file, class, model,
  API-path or job names in page intros, hints, errors or menu
  descriptions. Functional details on superadmin-only screens (the
  "Using a key" examples on API Access and Telemetry Admin) may stay.
  Menu descriptions live in the database (`MenuItem.description`, shown
  on Dashboard cards), so changing one needs a data migration that only
  updates rows still holding the seeded text (see 0116, 0117).
- **`index.html` is served with `Cache-Control: no-cache`**
  (`frontend-react/nginx.conf`). Without it browsers kept an old build
  after a deploy. Hashed assets stay immutable.
- **Signed-in screenshots: the user signs in, never mint a token.** Open
  a headed Edge with `--remote-debugging-port` and a scratchpad profile
  on `/login`, wait for the user to sign in, then drive the same tab
  over CDP. Force light theme (`localStorage['dtwatch_theme']='light'`)
  and disable the cache. Skip pages that list real phone numbers,
  usernames or IPs. Creating a JWT from the Django shell for this is
  denied in auto mode and must not be worked around.
- **Local test fixtures to keep:** users `p5_sup_4110d6`,
  `p5_viewer_4110d6`, `p5_rescue_4110d6`, `p5_custom_4110d6` and role
  `p5id4110d6` exist only in the local database. The user wants them kept
  for future tests. They must not exist on prod.
- **A new page on an opaque route needs four things:** an entry in
  `constants/opaqueRoutes.ts`, a lazy import + route in `App.tsx`, a
  `KNOWN_ROUTES` entry in `MenuAdminPage.tsx`, and a seed-`MenuItem`
  migration.

## Android companion app (separate repo, same machine)

- Source: `D:\Claude Project\BAGALEWATCH BTS RAN O&M MANAGEMENT\nepal-telemetry-project`
  (`app/` is the host app, `netplanning-telemetry-sdk/` is the SDK).
- **Never read, print, sync or commit `app/.../demo/DemoApplication.kt`
  or `app/google-services.json`.** The first holds the real ingest key.
  To add a config line to it, use a non-printing anchored `sed -i` on a
  known line and check the result with `grep -c`.
- Build (from that directory, no daemon, small heap or Gradle runs out of
  memory): `export JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-17.0.20.101-hotspot"`,
  then `"$JAVA_HOME/bin/java" -classpath gradle/wrapper/gradle-wrapper.jar
  org.gradle.wrapper.GradleWrapperMain --no-daemon
  -Dorg.gradle.jvmargs="-Xmx1024m"
  -Dkotlin.compiler.execution.strategy=in-process :app:assembleDebug`.
- XML comments in Android resources must not contain `--`.
- adb: `/d/DevCache/Android/Sdk/platform-tools/adb.exe`. **Install only on
  the Huawei** (serial `JYNBB18411157971`). Copy each new APK to the
  Desktop as `dtwatchTelemetry.apk`. On 2026-10-10 the user asked once
  for an install on an Oppo; it has the newest build, the Huawei and a
  Redmi still have the older one.
- Push goes through a staging clone, `C:\mobile-push\nepal-telemetry-mobile`
  (branch `mobile`). Sync with the PowerShell tool (Bash mangles `/E`):
  `robocopy "<src>" "C:\mobile-push\nepal-telemetry-mobile" /E /XD build
  .gradle .idea .git nepal-telemetry-project /XF local.properties
  DemoApplication.kt google-services.json keystore.properties *.jks
  *.keystore *.apk hs_err_pid*.log`. Check
  that `git status` shows neither secret file, then add only the intended
  files.

## Conventions

- Functions: `camelCase` (frontend) / `snake_case` (backend), `_`-prefixed
  for private/internal helpers.
- New backend feature = new `core/<feature>.py` file (not added to
  `views.py`), wired into `core/urls.py` explicitly — no shared ViewSet
  mixin for cross-cutting concerns like audit logging (most ViewSets
  already override `create`/`update`/`destroy` for their own reasons,
  which would silently shadow a mixin's hooks via MRO).
- Singleton settings models (`BrandingSettings`, pattern to reuse for any
  future one): `pk=1` forced in `save()`, `AllowAny` GET / superadmin-only
  PUT, audit-logged.
- Short-lived opaque server-side tokens (SSO login codes, MFA-pending
  tickets): Redis `SETEX` + single-use `GETDEL`, short TTL — not a DB table.
- Optional/external-dependency features (SSO, GeoIP, reCAPTCHA, SMTP)
  degrade gracefully when unconfigured — env var unset means the feature is
  inert, never a hard failure. `EMAIL_BACKEND` falling back to Django's
  console backend when `EMAIL_HOST` is unset is the latest example.
- Self-service password reset uses Django's own `PasswordResetTokenGenerator`
  (HMAC, self-invalidates on password change) — no token storage table.

## Current status

Project purpose, as the user states it: a research prototype for NTC's
RAN/O&M/RF department to present to management. It covers (a) a
repository of completed drive-test plots and (b) live signal quality from
subscribers for comparison, for analysing problems and proposing RF
optimization. The rescue features were added after the Bhotekoshi flood,
to find a missing person's approximate location instead of only the
serving site.

**Done and pushed, 2026-10-03 to 2026-10-08** (dtwatch branch `telemetry`
at `3146e55`; mobile branch `mobile` at `43800bf`). Prod was confirmed
deployed through `644cfc0`; everything later still has to be pulled and
migrated there by the user.

- **Emergency switch** (`core/emergency.py`, shared `EmergencySwitchPanel`
  exported from `RescuePolicyPage.tsx`). Rescue search is off unless a
  superadmin declares an emergency (7 days default, 30 max). It replaced
  the old optional-consent policy.
- **Rescue** (`core/rescue.py`). MSISDNs are canonicalized by
  `_clean_msisdn` (digits only, `977` prefix); migration 0109 backfilled
  old rows. Superadmin "Rescue Enrolled Devices" list. Enrolling does not
  carry a position; the position updates only from regular samples while
  the device is sharing.
- **Device Location Trace** (`core/device_lookup.py`, superadmin). Looks
  up a device's latest position by MSISDN or IMEI with no consent from
  its owner. Works only while an emergency is declared and needs a case
  reference; each search goes to `DeviceLocationTraceLog` and the audit
  log.
- **Registered Devices** list (`core/device_trace.py`
  `RegisteredDeviceListView`). "Register this phone" (`DeviceCredential`)
  is separate from the rescue beacon (`SubscriberLastLocation`).
- **Telemetry Drive Test.** Sessions auto-end on stop and at
  `max_duration_minutes`. Devices load only after an area search. The
  preview map recentres on click and shows active devices (30 min, green)
  and last-known ones (24 h, grey), with a blue ring for selected.
  Select all, suggested name `{district} Drive — {date}`, session filters.
- **Collections** (`core/collection.py`). Per-row detail with plot, more
  filters, and a session with no samples for 90 minutes shows as Ended.
- **Plot overlap** (`lib/declusterPlot.ts`, `declusterForPlot`). Same
  coordinate + site + sector keeps only the worst and best reading;
  different sites at one coordinate are spread on a small ring. Used by
  every telemetry and DT map.
- **DT Session History.** "Latest only" groups by district + tech
  (`lib/dtSessionClustering.ts`, `sameTech` option). The district is read
  from the auto-generated session name, since it is not stored; a renamed
  session falls back to nearby-site grouping. Tech and date filters.
  Metric tabs with no data are hidden in Coverage, Compare and Explore.
- **Area Sample** (`core/area_sample.py`, `AreaSamplePage.tsx`, admin and
  superadmin). An admin picks an area and radius; the server pushes a
  `sample_request` to devices that were sharing there in the last 24 h
  (`TelemetryPushToken`, held only while a device shares). `on_demand`
  readings that arrive within 15 minutes are shown with no device ID.
  Needs `FCM_SERVICE_ACCOUNT_JSON` in `.env` and outbound HTTPS to
  `oauth2.googleapis.com` and `fcm.googleapis.com`. The backend is tested
  locally; a real push end to end is NOT yet tested.
- **Mobile app.** Close button on full parameters, legible map popup,
  50 m route accuracy filter, single SERVING cell, generic error messages
  (`ErrorMessages.kt`), registration retry (`TraceRegisterWorker.kt`),
  registration form hidden once registered, and the SDK's
  `setPushToken` / `answerSampleRequest` for Area Sample.

**Done 2026-10-09 to 2026-10-11** (all pushed on 2026-10-11: dtwatch
`telemetry` at `a9955fe`, mobile `mobile` at `490a24f`). None of it is on
prod yet; prod still needs migrations 0111-0119.

- **Performance and security audit fixes** (`80ded60`): subquery sample
  counts, `/media/` limited to `branding/` and `menu_icons/`, per-path
  nginx body limits, login-only API schema, security headers, single-use
  refresh tokens (simplejwt blacklist), smaller Django image.
- **CQI estimation module** (`3905ed9`) and **number-to-device links in
  one table** that both lookup tools read (`11a65ea`).
- **Strict consent in rescue lookup.** A subscriber who turned rescue
  sharing off is not shown by any lookup tool, even during an emergency.
  The on-screen text and two menu descriptions that said otherwise were
  corrected (`ee36507`, migrations 0116 and 0117).
- **Gunicorn size from `.env`**: `GUNICORN_WORKERS`, `GUNICORN_THREADS`
  (`gunicorn.conf.py`). Unset keeps the computed count.
- **Manuals** (Claude Docs artifacts, private to the user): Technical
  `claude.ai/code/artifact/5b69c28d-3db4-4cb1-beca-7214284b94f6`, Admin
  `.../918037c5-779b-4c67-a7f6-dd4eaf4d357d`, Viewer
  `.../39adc7fe-f96f-4865-a753-514e4a52d1bf`, and the earlier combined
  one `.../c17ebaa6-c362-4424-83b3-48b63e41d5c4`. Light-theme web
  screenshots from a superadmin session; no mobile screenshots yet.

**Prod host facts** (read-only check on `ssw-prod`, reported 2026-10-11):

- 8 cores, 19 GiB RAM, shared with about 50 other containers.
- Postgres is on a separate machine (`POSTGRES_HOST=172.16.62.126`); the
  prod compose file has no `db` service. Postgres tuning needs that
  machine's numbers and whether other apps share it.
- The prod compose file runs only django, frontend, redis, go-worker and
  node-gateway. The four maintenance services (site-sync,
  telemetry-maintenance, telemetry-bin-roller, audit-log-maintenance)
  are NOT running there, so pruning, coverage roll-up and site sync do
  not happen on prod unless something else runs them.
- `dtwatch-django-1` runs as root, and `/data/dtwatch/data/media` is
  `root:root 755`. Moving the containers to a non-root user needs a
  one-time `chown` of that folder first, or uploads break.
- Gunicorn there resolved to 12 workers x 4 threads, about 1 GB. The
  computed cap is now 4, so no prod `.env` entry is needed.

**Application-side changes of 2026-10-11** (the user chose not to change
the live server's own configuration):

- Django admin is closed: `/admin/` is not mounted and nginx answers 404.
  The app's password login and SSO are unchanged.
- The maintenance jobs moved into the django container (see Repo
  layout). `run_maintenance` holds a Postgres advisory lock so only one
  runner works per database. On prod the first run will prune old audit
  rows and expired telemetry partitions; back up first or deploy with
  `RUN_MAINTENANCE=0`.
- node-gateway and go-worker are gone from every compose file and both
  build scripts. Prod must deploy with `docker compose up -d
  --remove-orphans`. The `backend-node/` and `backend-go/` folders were
  deleted by the user (`189ac10`); folder deletion is denied in auto
  mode, so hand such steps to the user with PowerShell syntax.

**Site photos** (2026-10-11, committed and pushed in both repos, not on
prod). `core/site_photo.py`, model `SitePhoto` (migrations 0118, 0119),
`SitePhotoCard.tsx`, `SitePhotosPage.tsx` (opaque route `/p6h2sv`, admin),
a "Site Photos" section on the site page, and `SitePhotoActivity.kt` in
the app (Map tab, "Site photo" button, CameraX).

- The app has no staff login, so trust rests on: registered phone only
  (signed request), phone within 1 km of the site, and every upload
  PENDING until an admin approves it. Viewers see approved photos only.
- The engineer picks a planned direction (distinct azimuth with its
  sectors), not a cell; left on automatic, the nearest one is used. The
  site page flags a difference above 20 degrees.
- The picture travels as base64 JPEG inside the signed JSON body and is
  re-encoded on arrival (max 1600 px, metadata dropped).
- Load limits (constants at the top of `core/site_photo.py`): 2 MB and
  8 megapixels per picture (pixels checked before decoding), 100 a day
  per phone, 5000 a day in total, uploads refused while 2000 are
  pending, nginx 4 MB on the upload path. Lists use a 480 px thumbnail
  and 60 per page. `prune_site_photos` (in `run_maintenance`) deletes
  rejected photos after 30 days and unreviewed ones after 90.
- Server and API tested locally with a throwaway device key; one test
  photo of CDR001 is left in the local database. The web pages were
  built but not looked at in a browser, and the capture screen has not
  run on a phone. The app talks to prod, so a phone test needs the prod
  deploy first.

**Site photos, second round** (2026-10-12, built, NOT committed in either
repo, not on prod):

- Photos are for admin and superadmin only, pending or approved (list and
  image endpoints, the site page section). The user decided this on
  2026-10-12; viewers no longer see them.
- A photo taken while a phone drive test runs carries that drive's
  `drive_session_id` and then needs no site (`SitePhoto.site` is
  nullable, migration 0120). The SDK exposes
  `NetTelemetry.currentDriveSessionId()`.
- `SitePhotoLayer.tsx` draws approved photos on maps: by drive session on
  the Collections plot, by the area on screen on Sites, DT coverage, DT
  Explore, Telemetry Coverage and the new Map view of the Site Photos
  page. `CurrentLocationMarker.tsx` shows the viewer's own position on
  the same maps; the position stays in the browser.
- App Map tab shows and centres on the phone's position and asks for
  location once per visit.
- Live Site Sync now lists each created site and the fields that changed
  in its result (`core/live_sites.py`), to explain "1 created" on every
  run. The app's site lookup waits 30 s after a failure.
- Server tested locally. The web maps and the app's Map tab changes have
  not been seen running. The manuals and both decks were updated for
  this on 2026-10-12.
- **CQI on the coverage map** (2026-10-12). The roll-ups averaged only the
  phone-reported `cqi`, which is almost always null, so the CQI map was
  grey. They now average `cqi.sample_cqi_sql()` (reported, else SINR
  ladder, else RSRQ line); migration 0121 backfills bins from stored
  samples. SQL and Python agree on every local sample.
- **The RSRQ fallback line (CQI = RSRQ + 17) is not trustworthy.** On
  prod the same RSRQ -11 showed CQI 10-12 from SINR and 6 from RSRQ. A
  full-load physical model was tried and rejected (it gives 15 for the
  RSRQ -9/-10 readings prod also has). `manage.py cqi_rsrq_calibration`
  (read-only) compares the two on stored samples and prints a fitted
  `CQI_CONFIG_JSON`. Waiting for its output from prod.
- **RSRQ estimate never below CQI 1** (2026-10-12, `rsrq_min_cqi` in
  `core/cqi.py`, Python and SQL). Prod showed "0 (est. RSRQ)" for
  connected LTE readings at RSRQ -17/-18. A 0 the phone reports, or one
  from a measured SINR, still shows. Migration 0123 recomputes the bins
  whose samples are all still stored. This removes the zeros only; the
  line itself is still uncalibrated.
- **RSRQ estimate is now a step table, not the line** (2026-10-12, built,
  NOT committed). Prod's phones report no SINR at all (0 of 2,099 LTE
  samples), so `cqi_rsrq_calibration` had nothing to compare there and
  nearly every phone CQI on prod comes from RSRQ. Checked on 31,269 local
  drive-test readings instead: the line read 3 to 5 steps low (RSRQ -11
  gave 6, drive tests average 11). `RSRQ_TABLE_NTC_DT` in `core/cqi.py`
  (`rsrq_table`; `null` in `CQI_CONFIG_JSON` restores the line), Python
  and SQL, migration 0124 recomputes the bins. The command gained
  `--drive-tests`, which prints a fresh table from all stored 4G drive
  tests; run it on prod, which has more of them. A user-supplied
  RSRQ-to-SINR formula was tested and rejected: its simple form lacks
  the factor 12 and gives CQI 0 everywhere, and the load-aware form
  needs the cell load.
- **RSRQ table refitted to MEASURED CQI** (2026-10-13, built, NOT
  committed, not on prod; supersedes the bullet above). The 12 October
  table (`805ef53`, pushed) was built from CQI worked out from SINR in
  three `.trp` logs and read about 1.2 steps high against measured CQI
  (miss 2.7, worse than a constant at 2.4). The user uploaded nine
  Excel exports from the TEMS server (750,186 readings with the CQI the
  test phone reported): `RSRQ_TABLE_NTC_MEASURED` in `core/cqi.py`, miss
  2.2, no bias. Same data: the SINR threshold table is too steep (2-3
  low below 0 dB, 2-3 high above 20 dB; miss 2.1, refit would be 1.7)
  and RSRQ+RSRP would give 2.0. Both offered to the user, not built;
  they wanted an RF engineer to look first.
- **`DriveTestSample.cqi_estimated`** (same day, migration 0126, which
  also recomputes the bins). A `.trp` log has no CQI; the upload page
  fills one in from SINR and now marks it. An Excel export carries
  measured CQI. 0126 marks existing `.trp` sessions. The CQI plot's
  "estimated" note shows only for marked readings, and
  `cqi_rsrq_calibration --drive-tests` uses measured CQI only. Lesson:
  never calibrate against the `cqi` of a `.trp` session.
- **Upload page stays open after a template/Excel save** (2026-10-13):
  it lists what was saved with a link to Session History.
- **Engineering-parameters import guard** (2026-10-13). The user dropped
  the 2G/3G RF Database workbook into the "Engineering Parameters (4G)"
  box. It was accepted (any file with a Cell Name column was): the page
  read the first sheet (2G) and the server, matching by cell name across
  all technologies, rewrote 13,958 2G sectors' band text ("900" to
  "GSM900") and a few sites' tower fields. No 4G sector was touched.
  Fix: the box refuses a file with BCCH/BSIC/PSC and no PCI, each box
  sends its `tech`, and the server matches only that technology. The
  import also loaded every column of 51,000 sectors and their sites; on
  this PC's 1 GB container the worker was killed (the user saw "import
  failed"). It now loads only the columns it uses. On prod the remedy
  for the band text is to import the file again in the 2G RF box.
  The same import also wrote all 25 sector columns for every changed
  row: the real 4G file (20,190 rows) took 115 s here and got HTTP 504
  on prod. It now writes only the columns that changed (33 s worst
  case here). All of this is in `d1cdf9d` (committed 2026-10-13, with
  the CQI table, `cqi_estimated` and the upload-page change).
- **Site map: reach from tilt, and measured coverage** (2026-10-13,
  built, NOT committed; not AI work, so it can ship without it).
  The wedges on a site's map are a diagram: azimuth from the site list,
  beamwidth and radius from the KML
  (`../Nepal NTC_LTE engineering_parameter_14_June_26.kml`, imported
  through the 4G engineering-parameters box), fixed per band (B20 40
  degrees/200 m, B3 60/150). `SiteLocationMiniMap.tsx` now has three
  switches: Diagram (as before, on), Reach from tilt (a dashed line to
  height / tan(total tilt), flat ground assumed, `tiltReachM` in
  `lib/sectorWedge.ts`), and Measured (`core/site_coverage.py`,
  `GET /api/v2/sites/<id>/measured-coverage/`: readings matched to the
  site's sectors, in 55 m squares, with half/nine-in-ten/farthest
  distance per sector; drive tests for everyone, phone readings for
  admin and superadmin). Migration 0127 adds the index on
  `DriveTestSample.serving_site_id` (the read took 3.7 s without it,
  0.5 s with). AI migrations moved to 0128-0132. Checked through the
  view in-process, not in a browser. On a hill site the two disagree
  widely (WDR521 band 20: tilt says 230-270 m, half the readings were
  taken 3.4-3.7 km out), which is the point of showing both.
- **Which site a reading belongs to, and the direction check**
  (2026-10-13, built, NOT committed; not AI work). The user's rule:
  distance is the hard constraint, direction only refines where distance
  does not settle it. `choose_sector` in `core/dt_serving_cell.py`: only
  sites within the cap are candidates; the nearest wins on distance
  alone when the reading is within 300 m of it or it is clearly nearer
  (at most 0.6 of the next one's distance); otherwise the one whose
  sector points at the reading (within 60 degrees) wins; if none or
  several do, the nearest is kept and the reading is "uncertain". Every
  reading is now matched on its own position. Before, the drive-test
  path gave all readings on an id in an upload batch (and, in the
  backfill, in a whole session) to the site nearest their centre, so one
  site collected readings taken beside another with the same PCI.
  `backfill_dt_serving_cells` was rewritten to work in chunks and to
  clear or move a match; run locally it moved about 2% of 856,000
  readings. **After deploying this on prod, run
  `manage.py backfill_dt_serving_cells` there once.** Uncertainty is
  worked out when the site page is read, not stored (no new column).
  The site map's Measured layer now draws uncertain readings hollow,
  offers a choice of drive test, and reports per sector the share of
  readings where it points and the direction they centre on, flagged
  beyond 30 degrees on 100 or more readings; readings within 300 m,
  weak ones and uncertain ones are left out of that check. It never
  changes an azimuth. Example: WDR521 K3 went from 40% in direction to
  80%, centred 1 degree from its azimuth, with 819 readings marked
  uncertain (PCI 10 is also on WDR496, 6.7 km away). CDR751 2G sector A
  is flagged: azimuth 0, readings centre on 227. Antenna-change records
  carry no usable date, so they are shown as a caution only.
- **Exact match by cell identity** (2026-10-13, built, NOT committed;
  not AI work). A 4G reading that names its cell is matched to that
  sector exactly, ahead of the PCI rule. The identity is eNodeB ID x 256
  + local cell ID. `Sector.enodeb_id` comes from the "NodeB ID" column
  of the LTE engineering parameter file (the 4G box now imports it);
  `DriveTestSample.cell_id` is saved from a TEMS `.trp` (the decoder
  already read it) and from an optional "Serving Cell Identity" column
  of the 4G Excel template (or separate eNodeB ID and Cell ID columns);
  phone samples already carried `cell_id`. Migration 0128; AI migrations
  moved to 0129-0133. Checked on `../sample/0611101538.trp`: all 29,243
  readings matched by identity, and the PCI rule agreed on 29,233 of
  them (a flat Chitwan drive; hill drives are where PCI is ambiguous).
  The user's TEMS-server exports
  (`D:\WSD\data for dtwatch\drive test plot in excel\ccsi\T1..T18.xlsx`)
  have only the template's ten columns, so they carry no identity: they
  need a new export with that column. Sessions already stored have no
  `cell_id` until uploaded again. 2G/3G identity (LAC + cell ID, already
  in the site list from the RF Database) is not built.
- **2G/3G AI rules use the serving site** (2026-10-13, asked by the
  user, uncommitted with the AI work). After the user's RF Database
  imports the local site list has BCCH/BSIC (13,960 2G sectors) and
  scrambling codes (12,640 3G). `backfill_dt_serving_cells --session N`
  was run on the stored 2G/3G sessions: the TEMS-log 2G sessions matched
  (81 to 100% of readings); the Excel 2G/3G exports carry no cell
  identity and stay unmatched. `_analyse_23g` now uses the serving site
  where known (act-on site, "nearer site not serving", the two sites of
  a ping-pong pair) and falls back to the nearest site otherwise.
- **Operating band of phone readings** (2026-10-13, committed: dtwatch
  `ba796b3` pushed, mobile `17b952b`; not on prod). The app sends `arfcn` (channel number)
  and `band` (`getBands()` on Android 11+, else from the channel) with
  every sample; `core/radio_band.py` resolves and labels it
  ("B3 (1800)", "900" on 2G), stored as `arfcn`, `band`, `band_mhz` on
  `TelemetrySample` (migration 0125, which also fills 2G rows from
  `bcch`). A Band column is on Live Samples, Telemetry Drive Test,
  Area Sample and Collections. SDK: `model/RadioBand.kt` holds the same
  tables; keep the two in step. App: band on Signal, Cells, full
  parameters and the route popup. Built, not yet run on a phone. The AI
  migrations moved up again to 0126-0129 so 0125 can ship without them;
  `models.py` and `api/types.ts` now hold both band and AI changes, so
  a commit without the AI work must stage those two by hunk.
- **App tabs and registration flow** (2026-10-13, built, NOT committed,
  not yet run on a phone). Everyone gets Signal, Wi-Fi and Settings;
  Cells and Map are removed from the bar (not greyed) until "I am an NTC
  employee" is ticked. First start after install: Quick Setup asks for
  location, phone state and notifications, then a pop-up asks for the
  number. First start after an update (`AppLaunch`, from the package's
  update time): asks for the number if not registered, else says
  "already registered". Settings shows the form only while not
  registered. `Registration.kt` holds the one registration routine.
  Decided by the user on 2026-10-13: allowing location on the setup
  screen shares for about one minute and then stops by itself, on every
  visit (first install, after an update, or whenever the permission was
  missing): `FirstRunSample.kt`, a one-minute share window; the setup
  text says so. After an update the permission check comes before the
  registration check.
- **Mobile handoff document rewritten** (2026-10-13):
  `docs/telemetry_pipeline_mobile_handoff.md` and its `.docx` (made with
  a scratch script from the Markdown), for the NT mobile app team.
- **Documents brought up to date on 2026-10-12** (the four manuals and
  both decks): step table, CQI map, level by technology, telemetry in
  Explore, site photos second round, app share question. The AI
  assistant was left out of them on the user's instruction; they still
  show it as "planned". The prototype has its own brief, a Claude Docs
  artifact: `claude.ai/code/artifact/54e54623-eedd-4b2a-aa4f-a6ee3c5781f1`.
- **Planned local AI assistant (documents only, no code).** On
  2026-10-12 the user asked for a future-plan item: an open-source model
  hosted by NTC that identifies problems, likely causes and suggested
  actions from stored data. Agreed wording: "NTC-hosted", no model
  named, all three uses, admin and superadmin plus any role given the
  permission, engineer accepts or rejects every draft, numbers computed
  by the server, no personal data to the model. Do not say it runs on a
  separate server: same or different server is undecided (the user's
  correction). It is in the Technical
  Manual (overview diagram, "Future plan" section with its own flow),
  the combined manual's overview diagram, the Admin Manual ("Planned: AI
  assistant"), management deck slide 14 and technical deck slide 21,
  always marked planned with a dashed border. The documents still say
  "planned"; the prototype below is not in them yet.
- **AI assistant prototype** (2026-10-12, built on this PC, NOT
  committed, not on prod). Approved by the user stage by stage the same
  day. Menu item "AI Assistant" (opaque route `/a8k3zd`), permission
  `ai.assist` (admin and superadmin hold it; a superadmin can tick other
  roles on the page). Migrations 0129-0133.
  - **2G and 3G reviews and higher caps** (2026-10-13, asked by the
    user). Caps raised to 120 findings and 30 per kind (were 40 and
    12). 2G and 3G sessions are reviewed with the checks their logs
    support: weak coverage near a site or in a gap, good level with poor
    quality (RxQual on 2G, Ec/No on 3G), worse than an earlier drive,
    and ping-pong between two BCCH/BSIC cells on 2G. The site directory
    has no BCCH, BSIC or scrambling code, so a 2G/3G reading has no
    serving site and findings name the nearest site of that technology.
    Thresholds are in `PROFILES`; three new rulebook entries are seeded
    by 0130. Seen on the user's uploads of 2026-10-13: the two long
    Excel drives (Palpa, Gulmi) give 462 and 281 findings, mostly
    ping-pong and far serving cell, which looks like rules too
    sensitive for hill terrain or interleaved rows, not real faults;
    and `good_level_poor_quality` fired with a single PCI seen, where
    the model repeated the "several cells" cause anyway. Both need an
    RF engineer's judgement before the limits are changed.
  - `core/ai_findings.py` finds the problems in a 4G drive test with
    plain rules (no model): weak coverage in three forms, far serving
    cell, same PCI nearby, ping-pong handover, good signal with low
    speed, worse than an earlier drive, and three that need the
    neighbour reading (PCI mod-3, far neighbour, no dominant cell). It
    sets severity and confidence and names the site to act on. Limits
    are constants at the top, starting values for RF engineers to tune.
  - `AiRule` is the RF rulebook (cause and action per kind, editable on
    the page, `{name}` filled from the finding's facts). It is the main
    quality lever: tested models gave wrong RF advice without it.
  - `core/ai_assistant.py` sends one finding at a time to the model,
    which only words it; `check_text` flags any number or site name not
    in the facts. Engineers accept, edit or reject; "Pilot results" tab
    counts the decisions. `core/ai_tools.py` holds seven read-only
    look-ups for the "Ask" tab: the model picks one, the server runs it,
    the model answers from that result. No look-up reads personal data.
  - The worker is `run_ai_drafts` inside `run_maintenance`. Questions go
    ahead of drafts. `AI_MODEL_URL` unset means no model call at all;
    findings then carry the rulebook wording.
  - Model: any OpenAI-compatible server. Here llama.cpp's server runs
    natively on Windows (`D:\DevCache\llm\start-model.ps1`, port 8099,
    bound to 127.0.0.1; binding to 0.0.0.0 is denied in auto mode) and
    Docker reaches it as `host.docker.internal`. Docker on this PC has
    only 4 GB, so the model cannot run inside it. Measured on this CPU:
    Phi-4 14B about 160 s per finding and 11 GB, right on all test
    findings; Qwen2.5 7B about 70 s and 7.5 GB, some wrong sites; 3B
    models not usable. Server target from the user's earlier note
    (`../dtwatch-local-llm/DESIGN.md`): a 27B model on a 24 GB GPU.
  - Neighbour readings: a TEMS .trp has one LTE neighbour per record.
    `DtUploadPage.tsx` now attaches the nearest one in time to each
    reading (`earfcn`, `nbr_pci`, `nbr_earfcn`, `nbr_rsrp` on
    `DriveTestSample`). Tested with a script that mirrors the page, not
    through the page. Old sessions have none until re-uploaded. Local
    test session "AI test: Chitwan 4G DL with neighbours" was made this
    way from `../sample/0611101538.trp`.
  - **Problem Dashboard drafts (phase 2, 2026-10-15)**: `core/ai_problems.py`,
    `AiProblemDraft` (migration 0141, which also seeds nine rulebook
    entries `problem_<cause>`), `components/ProblemAiDraft.tsx`. Kinds:
    report (summary, cause, action, customer reply; in the report's
    detail), hotspot ("AI" on a Hotspots row) and digest (period summary
    for management on Overview, filed under `days:N`). Same terms as the
    drive-test drafts: server facts, rule wording, `check_text` flags,
    accept/edit/reject. The facts never hold the customer's number, the
    phone, the linked system's name or ticket, or the customer's note.
    Worker order in `run_ai_drafts`: questions, problem drafts, drive-test
    drafts. Ask tab gained `site_problem_reports` and `problem_hotspots`.
    `dashboard_data()` was split out of the dashboard view (committed
    code) for the digest. Tested with Phi-4 here: a report draft took
    206 s, no flags. All of `ProblemReportsPage.tsx`'s changes after
    `5957ff5` are AI-only, so a non-AI commit leaves that file out.
  - Decided by the user on 2026-10-12: the assistant is for NT engineers
    only, with a staff-only pilot that runs on this PC until a live
    server is planned for the local model; no subscriber-facing
    assistant is planned now. If one is ever built it needs the subscriber's consent
    and identity verified against the NTC billing system. Do not build
    a subscriber lane without being asked.
- **Telemetry sessions in DT Explore** (2026-10-12). `core/telemetry_near.py`
  (`/api/v2/telemetry/sessions-near/`), `TelemetryNearLayer.tsx`, and an
  "Include telemetry sessions" tick box in Explore, off by default and
  shown to admin and superadmin only. Covers named Telemetry Drive Test
  sessions and Collections phone drives; operator trace sessions are
  left out on purpose.
- **App drive test and sharing** (2026-10-12, built, not yet seen
  running). Start asks for location permission if missing, then "Share
  this drive with NTC?". Everyone is asked each time; an employee may
  tick "Remember my answer" (long-press Start to be asked again;
  unticking the employee box forgets it). Share: sharing is switched on
  for the drive if it was off (`DriveShare.autoOptIn`) and off again at
  Stop. Keep on phone: recorded locally, nothing queued.
  `NetTelemetry.startDriveTest(context, share)`.
- **Uploads after sharing is switched off.** `UploadWorker` used to do
  nothing once opted out, so the tail of a share window or drive and its
  `drive_stop` marker stayed on the phone. `DriveShare.drainPending` now
  lets the queue be sent until it is empty (unique work
  `netplanning_drain_upload`, network constraint, backoff). Used by
  `stopShare()` and by drive stop.
- **Route popup on the phone map.** Each route point keeps the signal
  read at it (`RouteTrail.Signal`, saved in drive history). Tapping the
  line or the end marker shows it per technology, with position, in the
  map library's standard bubble with dark text. One popup at a time; it
  survives the 2-second redraw. Drives saved before this have no signal.
- **Signal level by technology** (2026-10-12). One rule everywhere: RSRP
  on 4G/5G, RSCP on 3G (RSRP scale), RSSI/RxLev on 2G (RxLev scale).
  `core/telemetry_level.py` (Python and SQL), `lib/telemetryLevel.ts`,
  and `RouteColor` in the app's `MapFragment.kt`. Before, RSRP-only code
  drew every 3G and 2G phone reading grey. Applied to Collections, the
  Explore telemetry layer (which now also obeys the 4G/3G/2G buttons via
  `?tech=`), Area Sample, and Telemetry Coverage, whose bins gained
  `level_mean` (migration 0122, backfilled). Telemetry Drive Test and
  Live Samples already handled it per technology.
- **App route colours.** The drive route on the phone is coloured by that
  rule per point; a legend line sits under the status text.
- The PC's page file was raised on 2026-10-12 (commit limit 19 GB to
  24 GB), after builds failed for lack of memory.
- The app build needs about 1.5 GB of free memory. When the PC is short,
  use `-Xmx128m -XX:+UseSerialGC` on the wrapper JVM and
  `-Dorg.gradle.jvmargs="-Xmx640m -XX:+UseSerialGC"` with
  `-Pkotlin.compiler.execution.strategy=in-process`.

- **Device features in the SDK, and the app version** (2026-10-16, mobile
  `10f9e68`, committed, not pushed). Registration, key and signing, number
  proof, speed test and problem report moved from the reference app into
  the SDK's `device` package (`NetDevice`, `DeviceApi`, `SpeedTest`,
  `NetProblem`); the SDK installs the upload signer itself. App version is
  set once in `app/build.gradle.kts` (`appVersionName`, 1.1.0 = build
  10100), shown in Settings, sent with registration and reports. An update
  notice (latest/minimum version) was offered and deferred by the user.
- **Flutter plugin `ntc_telemetry`** (2026-10-16, built, NOT committed, not
  run on a phone). The Nepal Telecom customer app is Flutter (its APK
  4.0.49 has `libflutter.so`); iOS was set aside by the user. Plugin in
  `nepal-telemetry-project/flutter/ntc_telemetry`, Android only, carries the
  SDK in `android/sdk-repo` (written by `:netplanning-telemetry-sdk:publish`,
  which also writes `maven-repo/`). Example app = test screen for every call.
  The plugin needs API 26; the NT app supports API 24.
- **Android 7 and location permissions** (2026-10-16, NOT committed). SDK
  and plugin `minSdk` 24 (the NT app's); `NetTelemetry.isSupported()` is
  false below Android 8.0 and every feature is then off; the plugin answers
  `unsupported`. The SDK now declares coarse location too, and the app asks
  for fine and coarse together (Android 12+).
- **Subscriber Profile, phones and signal history** (2026-10-16, built, NOT
  committed, not seen in a browser). Phones card: one physical phone shows
  as several ids (registration keys, the app install holding the readings,
  an earlier install linked by hand); `_describe_phones` gives each a
  `role`, a `phone_key` (hardware hash, else make and model) and marks an
  older registration replaced by a newer one from the same phone; summary
  line explains that Registered Devices lists registrations only.
  `devices_of_number()` is shared by the profile and the new
  `GET /api/v2/subscriber-profile/signal/` (newest 300, all up to 5000, one
  session; tech filter; every measure, serving site; positions only in an
  emergency; logged as `SUBSCRIBER_PROFILE.SIGNAL`).
  `ProfileSignalHistory.tsx`: colour by level/RSRQ/SINR/CQI/network, hover
  card, click or drag to pick, map of the picked readings (serving sites
  when no emergency). "Who looked this number up" is collapsed by default.
- **Subscriber Profile after UTS** (2026-10-16 to 18, built, NOT
  committed, not seen in a browser; user's steps 1-4 after comparing with
  NTC's ticketing system UTS). Step 1, `core/subscriber_analytics.py` (in
  the profile answer as `analytics`, no positions): quality by network
  (weak/fair/good from problem_report WEAK_DBM/GOOD_DBM), cells and sites
  served (busiest 60, UTS "cell sites visited" with quality), daily trend
  (90 days, Nepal time), time of day, level/RSRQ/SINR histograms, 4G bands
  seen. `ProfileAnalytics.tsx` + `ProfileCharts.tsx` (plain SVG, hover
  cards). Network colours re-picked with the dataviz validator (old 3G and
  5G were indistinguishable): `--sp-net-*` tokens, `lib/netColors.ts`.
  Step 2, off by default: `SecuritySettings.complaint_location_access`,
  `_days` (7), `_hours` (3), migration 0138 (AI migrations moved to
  0139-0144, local history renamed). `complaint_windows()`: exact positions
  of readings within H hours of the number's problem reports of the last N
  days, without an emergency; logged `SUBSCRIBER_PROFILE.COMPLAINT_LOCATION`
  per report; Security page card with a confirm. Steps 3+4:
  `core/provisioning.py`, `GET /api/v2/subscriber-profile/provisioning/`,
  `PROVISIONING_*` in settings/.env.example (off, demo, http with URL,
  headers, token and a field map; the UTS team's API is not known yet),
  cached 5 min, IMEI masked, logged. `ProfileProvisioning.tsx`: provisioned
  vs measured tiles, plain verdicts (4G not provisioned, not a USIM, VoLTE
  off, band missing), NTC bands (GSM900/1800, WCDMA B1, B3, B20, n78)
  against the phone's list and the bands seen. Local `.env` has
  `PROVISIONING_BACKEND=demo`. Not done: the problem check using
  provisioning ("4G not provisioned" as a cause).
  After the user looked (2026-10-19): `.app-shell` has `overflow: hidden`
  (an absolutely placed hidden label stretched the window past the
  footer); the profile searches again when the emergency status (polled,
  not logged) disagrees with it, since it is cached 30 min; the location
  map falls back to `earlier_position`; signal history has a time axis
  (adaptive ticks, line broken over gaps, no-service ticks) and ranges
  day/week/month counted back from the newest reading. Decided by the
  user: location history (cells and sites served, and UTS's cells
  visited, `location_history` field) only while an emergency is declared;
  counts always. Provisioning is now "OSS side details", one card at the
  end of the profile opening a window (tabs: subscription, device and
  bands, location history), asked only when opened. Per day and time of
  day share one row.
  Second look (2026-10-19, built, NOT committed): the analysis cards follow
  the signal filter (`analytics` in the signal answer, `profile_analytics(qs=)`;
  "newest" covers the span of those readings). Operator names from
  `core/operators.py` (app: `model/Operators.kt`; keep in step). The location
  card names the serving site and sector: stored, else matched now
  (`core/serving_site_lookup.py`), else the newest reading that has one
  ("Last attached site"). The other systems are two cards: BI (usage per
  day, network split, location history in an emergency; `BI_FIELDS`,
  `usage_daily`, `network_split`) and OSS & Core (provisioning, device and
  bands); one source, one lookup.
- **Phone SINR and serving site** (2026-10-19, built, NOT committed in
  either repo). Why prod had no SINR: many modems leave RSSNR and CQI blank
  in `getAllCellInfo()` but report them in `getSignalStrength()` (seen on the
  Oppo CPH2569: cell list blank, overall 16 dB). `CellSampleCollector`
  fills a blank from the same SIM's `getSignalStrength()` (Android 10+).
  New signed `GET device/serving-site/` (site and sector of the serving
  cell, same matching as stored readings, nothing stored); the app's Signal
  screen shows a "Serving site" row once the server answers
  (`ServingSiteLookup.kt`, once per cell, 30 s wait after a failure) and
  "Nepal Telecom" instead of 429/01. Installed on the Oppo (release-signed
  collector 1.1.0, upgraded in place; SINR 14 dB seen); both release APKs
  on the Desktop. The phone's mobile data (APN `ntnet`) cannot reach prod
  (172.16.41.201, ports 80/443 time out), so every server call from a phone
  on mobile data fails there, the speed test included; not an app fault.
- **Exact cell matching by identity** (2026-10-19, built, NOT committed).
  NTC numbering, checked on the site list: eNodeB = region digit (1 KTM,
  2 EDR, 3 CDR, 4 WDR, 5 MWDR, 6 FWDR) + site number, so 1856 is KTM856
  (`site_of_enodeb`). `attach_serving_cells` now matches exactly, with or
  without a position: 4G by eNodeB ID, else the site from the number plus
  the local cell ID (`sectors_by_cell_identity`), else plus the PCI within
  that site; 2G/3G by LAC + CI (the CI alone repeats in every region; 3G
  uses CI & 0xFFFF of the phone's full cell ID). The site list holds some
  4G sectors twice (site-list row with cell ID, engineering row with eNodeB
  only): one sector name counts as one match. New command
  `backfill_telemetry_serving_cells [--all] [--dry-run]` matched 730 of 793
  unmatched local phone readings; **run it on prod after the deploy.** The
  app sends `tac` to `device/serving-site/`.
- **Session filter in the profile's signal history** (same day): its own
  "Session" select; the Sessions card rows have "Show in signal history",
  which sets it (and the analysis cards follow).
- **App in the Nepal Telecom look** (same day, built, NOT committed):
  light theme (`Theme.MaterialComponents.Light.NoActionBar`), NT blue
  #1E4FA0 status bar, titles and buttons, gold #F2C21B accents, white cards
  with a thin border. Taken from the NT app's own assets (blue mountain
  banner, gold line icons, Myriad Pro); the NT app blocks screenshots, so
  its screens were not seen. Installed on the Oppo. After the user's photos
  of the NT app: deep blue #023A8E header band continuing the status bar,
  title in gold capitals (`ScreenHeader` style, `clipToPadding=false` on
  each screen), white-to-light-blue background (`bg_screen`), gold row
  dividers (`bg_row_divider` on `CellRow`), solid blue square buttons.
- **Site and sector on the phone without the server** (same day):
  `model/NtcCellName.kt` reads them from the cell number. 4G: eNodeB rule,
  local cell 1 J3, 2 K3, 3 L3, 4 J20, 5 K20, 6 L20, 7 M3, 8 N3 (99% of the
  site list); 2G CI = 1 + site + sector digit (A, B, C...); 3G CI = 2 +
  site + digit (P1, Q1, R1, P2, Q2, R2); region from the LAC's first two
  digits (10 KTM, 11-13 EDR, 14-16 CDR, 17-19 WDR, 20-22 MWDR, 23-24 FWDR).
  The Signal screen shows "KTM856 · J3" at once and the full site name once
  the server answers. Seen on the Oppo.
- **Committed 2026-10-19:** dtwatch `78d10ec` (everything above except the
  AI work), mobile `bfd274d` (also the Flutter plugin and the Android 7
  switch-off). Neither pushed.
- **Sector analytics** (2026-10-19, after that commit; built, NOT
  committed). `core/sector_stats.py`: readings per serving site + sector +
  technology (share, weak/fair/good by the problem check's limits, average
  level, RSRQ, SINR, CQI, download on drive tests, distance, first/last).
  `GET dt-sessions/<id>/sectors/` (any signed-in user),
  `collection-sessions/<id>/sectors/` (drive.view),
  `telemetry/dt-sessions/<id>/sectors/` (admin; its readings come from
  `telemetry_admin.session_samples_qs`, now shared with the plot). One web
  component, `SectorBreakdown.tsx`, under the map on DT Session History,
  Collections and Telemetry Drive Test, and as "Sector analysis" on the
  Subscriber Profile, where sectors are location history: emergency only,
  the count always, following the signal filter. A 140,000-reading drive
  test takes about 3 s here.
- **Profile, complaint and map follow-ups** (2026-10-19, built, NOT
  committed). Profile: "Signal history" is now "Signal analytics"; its
  Session filter always shows ("No sessions stored" when none); "Location
  history" and "Sector analysis" merged into one card (sites chart and map,
  the sector table with each sector's CI/PCI/TAC, and cells the site list
  does not know). Problem Dashboard: staff entry takes the customer's mobile
  (optional, `ProblemReport.msisdn`, superadmin sees it); `q` search on the
  list (PR-12, id, ticket, note words; the number for superadmin only);
  each report has a `reference`; the report is a UTS-style dashboard
  (complaint details, diagnostics with "Open full diagnostics": likely
  cause and measurements, nearest sites 1-10 km from
  `core/problem_sites.py`, phone's reading, reply; status and note). The
  number opens the Subscriber Profile with `reason=Complaint <ref>` and
  `from=<report address>`; the profile shows "Back to the complaint" (only
  a Problem Dashboard address is accepted). `ProblemReportsPage.tsx` now
  mixes this with the AI draft line (`ProblemAiDraft` in CauseTab): a
  non-AI commit must stage it by hunk. Site Topology: the search box takes
  a position in any common format (`lib/parseLatLng.ts`: decimal, N/E
  letters, DMS, degrees and decimal minutes, swapped order, Google Maps
  links), flies there and marks it with the nearest site.
- **Session names** (2026-10-19, built, NOT committed). `CollectionSession`
  gained `name`, `msisdn`, `district` (migration 0139, which also names
  existing sessions; AI migrations are now 0140-0145, local history
  renamed). Set when a session starts in `record_collection_sessions`:
  "<district> · <source> · <start, Nepal time>"; the district from the first
  reading's serving site, else the nearest site within 20 km, filled in by
  the first batch with a position. The number is stored beside the name,
  never in it, and shown to superadmin only. Collections: Session column and
  search (`q`: name, district, the number for superadmin). Profile: the
  session picker lists named sessions and, for readings with no session tag
  (app builds before share windows), "sharing periods" split at 30 minutes
  of silence (`sharing_periods`, key `period:<from>|<to>`).
- **Audit 2026-10-23** (`docs/AUDIT_2026-10-23.md`, 13-item action list).
  Items 1 and 2 done the same day, NOT committed: Pillow 13.0.0 and DRF
  3.18.2 (`requirements.txt`); `DriveTestSession.samples_total` kept by two
  statement-level triggers on `v2_dt_samples` (migration 0140, Postgres
  only; `sample_count_expr()` now reads it, callers unchanged); `jit=off`
  in `DATABASES.OPTIONS`. Session list 26 s cold to 0.57 s. AI migrations
  are now 0141-0146 (local history renamed). Prod needs 0138-0140.
  `manage.py test core` has 13 stale failures that predate the audit.
  Item 3 done (frontend only, NOT committed): `weakestPerSquare()` in
  `lib/dtBands.ts` replaces every-Nth thinning on the Session History,
  Compare and Explore measure plots (PCI/band plots unchanged). Session 27:
  12,451 dots, every weak square shown (2,840 of 2,840, was 1,298).
  Item 5 done (mobile, NOT committed): `SampleQueue.kt` keeps its line
  count and a lock shared by all instances (it was one lock per instance),
  trims only 500 lines over the cap, streams `peek`. First SDK unit tests:
  `netplanning-telemetry-sdk/src/test/.../SampleQueueTest.kt` (JUnit +
  org.json test deps), run with `:netplanning-telemetry-sdk:testReleaseUnitTest`.
  Release APKs on the Desktop, not yet run on a phone; SDK republished to
  `maven-repo/` and the Flutter plugin's `sdk-repo`.
  Items 6-9 and 11-13 done the same day (NOT committed): web-process-only
  `statement_timeout` 115 s (`gunicorn.conf.py` sets
  `DB_STATEMENT_TIMEOUT_MS`); `PUBLIC_URL` for reset links (prod `.env`
  must set it and a named `ALLOWED_HOSTS`); 2 gunicorn threads; lazy map on
  Sites (first download 205 to 140 KB gzip); `DemoApplication.kt` untracked
  in the staging clone, project `.gitignore` now identical to the clone's;
  `DATA_UPLOAD_MAX_MEMORY_SIZE` 150 MB (it never covered file parts); all
  244 unit tests pass. New: backup export takes 74 s (item 14);
  `manage.py shared_key_usage` (read-only) for deciding items 4 and 10.
  Item 4 done 2026-10-24: signed `device/rescue-consent/`
  (`core/rescue_signed.py`, number from the registration, beacon under the
  SDK id, 409 until linked); old `rescue-enroll/` answers 410 after
  `RESCUE_SHARED_KEY_ACCEPTED_UNTIL` (proposed 2026-12-31 in
  `.env.example`; local `.env` has none). SDK `RescueEnrollWorker` goes
  signed for registered phones, falls back on 404, stops on final answers;
  app's rescue dialog shows the registered number. Item 10
  (`TELEMETRY_SHARED_KEY_ACCEPTED_UNTIL`) waits for `shared_key_usage` on prod.
- **Documents brought up to date on 2026-10-24** for the work of 14-24
  October, AI still left out: the four manuals ("Updated 24 October"
  paragraph plus sections; Technical has new Problem Dashboard and Subscriber
  Profile sections, security rows, deploy and config steps), management deck
  (new slide `complaints`, now 17 slides), technical deck (new slide
  `complaints-flow`, now 26), and the mobile handoff `.md`/`.docx` (signed
  rescue consent, serving-site lookup, SINR fill-in, queue). Deck page numbers
  are typed in each slide file; inserting a slide means renumbering the ones
  after it.
- **Live readings from a complaint, and the rename** (2026-10-24, built, NOT
  committed, not seen in a browser). "Subscriber Profile" is now "Subscriber
  Network Diagnosis Dashboard" on screen and in the menu (migration 0141,
  only rows still holding the seeded text; AI migrations are now 0142-0147,
  local history renamed). A report on the Problem Dashboard has two views,
  `?view=` in the address: Site related analysis (the old cards plus "Live
  readings around this spot", an area request at the complaint's position,
  label `Complaint <ref>`) and Subscriber related analysis (the number, a
  link to the diagnosis dashboard, and "Send request to the customer's
  phone": a trace request, case reference `Complaint <ref>`, 30/60/120 min,
  to the phone that sent the report or the newest registration of the
  number; one open request per complaint). `core/problem_live.py`;
  `create_area_request`, `area_results` and `create_trace` were split out of
  `area_sample.py` and `device_trace.py`. Live answers never carry the
  number. Tested in a rolled-back transaction with a throwaway registered
  phone; a real push needs FCM on prod.
  Rules decided by the user the same day: the Problem Dashboard permission
  is the visibility of its menu item (`can_use_problem_dashboard` in
  `core/problem_report.py`: admin, superadmin, or a role ticked for the
  menu item), used by every problem view. One complaint's detail shows the
  customer's number to all of them (list and number search stay
  superadmin-only); a non-superadmin opening it is logged
  `PROBLEM_REPORT.NUMBER_VIEWED`, once an hour per person and complaint.
  Any of them may send the phone request; it is an investigation and waits
  for the customer's Accept, except a superadmin's during a declared
  emergency, which is a case trace (POLICY_BYPASS, no Accept). Readings and
  cancel go through the complaint (`live/phone/<trace>/`), so no trace
  permission is needed. The diagnosis dashboard link stays superadmin-only.
  A local emergency "test1" is declared until 2026-10-25 17:56 UTC.
  Committed and pushed as `85e5e67`. Documents updated 2026-10-25: Technical,
  Admin and combined manuals (rename, two views, live readings, who may use
  the dashboard; the Viewer manual has no Problem Dashboard), management
  slide `complaints` and technical slide `complaints-flow`. No APK change:
  the app already shows Accept/Reject for trace requests.
- **Related data of a complaint** (2026-10-26, built, NOT committed, not
  seen in a browser). The check looks only within 500 m around the problem
  time, so PR-28 said "no measurements" while its number had 81 phone
  readings (4 September, elsewhere). `core/problem_related.py`,
  `GET problem-reports/<id>/related/?range=latest|around|7d|30d|90d|all|custom
  &hours=&from=&to=&radius_km=`: customer (every phone of the number, as
  the diagnosis dashboard: readings per technology, newest reading and its
  serving site, speed tests, calls, sessions, other complaints; sites per
  reading and positions only in an emergency or a complaint window), site
  (phone readings and drive tests it served, its complaints) and area (phone
  and drive-test readings within 0.5-5 km, complaints). `latest` = newest
  300 phone readings and the newest drive test per scope (the default).
  Maps draw the weakest reading per 50 m square. Web:
  `components/ProblemRelatedData.tsx` (range in the address: rr, rh, rf, rt,
  rk), a site/area card on Site related analysis, the customer card on
  Subscriber related analysis, and a summary line in Diagnostics and the
  full-diagnostics window. Non-superadmin views logged
  `PROBLEM_REPORT.RELATED_VIEWED` once an hour.
- **Active alarms** (2026-10-26, built, NOT committed, not seen in a
  browser). NTC's alarm middleware (`GET .../api/v1/alarms/active`, Bearer
  token, `limit`/`offset` pages, no site filter; 674 alarms on 320 sites on
  26 October) is read live by `core/alarms.py`: all pages fetched, cached
  `ALARM_CACHE_SECONDS` (60) in Redis for every user, filtered by site on
  the server, nothing stored. `GET alarms/active/?site=` (signed-in users),
  `GET alarms/summary/` (admin), `refresh=1` (6 a minute per user). A record
  without `siteId` takes it from the device name. `ALARM_API_URL` /
  `ALARM_API_TOKEN` are in the local `.env` only (never commit the token);
  prod `.env` needs them and the django container needs a route to the
  middleware. Web: `components/ActiveAlarmsButton.tsx` (count on the button,
  window like the user's reference) on Site Detail and on the complaint's
  site in Related data; an "Active alarms" card on Live Site Sync (status,
  by severity/type/NE type, sites with the most alarms, Refresh now).
  Later the same day (not committed): the connection is set on that card
  ("Edit connection": address, Bearer/Token, key, keep-for time, on/off),
  `AlarmSourceSettings` singleton (migration 0143; AI migrations now
  0144-0149, local history renamed, table created by hand), key encrypted
  with `mfa.encrypt_secret` and never returned; .env applies only when no
  address is saved. The user had tried adding the alarm API as a site
  source; a site source overwrites site fields, so never do that.
- **Blank cell and signal on phone calls** (2026-10-26, mobile built, NOT
  committed, not run on a phone). On prod only the Collector edition's calls
  had cell and level: during a call the dialer is in front, and Android
  gives a background app no cell list or position without
  ACCESS_BACKGROUND_LOCATION (commented out in the SDK manifest) or a
  foreground location service. `CallListener.snapshot()` now falls back to
  the voice network and `getSignalStrength()` (no location needed) for the
  level; the cell stays blank. VoLTE Quality shows "Not recorded" with the
  reason. Release APKs (both editions) on the Desktop, older ones in
  `Desktop\old-apks\*_before_2026-10-26.apk`; SDK republished.
- **What "no service" readings mean** (2026-10-26, built, NOT committed,
  not on prod; the new app not run on a phone). Locally every reading
  without a network (62) also had no GPS position, mostly periodic
  background readings: the phone withheld cell and position (background
  without ACCESS_BACKGROUND_LOCATION, or location off), so they are not
  coverage gaps. `core/telemetry_status.py` groups them: measured /
  no_coverage (out of service or emergency only; on old readings no network
  but a position) / radio_off (flight mode, radio off, no SIM) /
  not_measured. `TelemetrySample` gained `service_state`,
  `cell_info_status`, `airplane_mode`, `sim_state` (migration 0142,
  nullable; AI migrations now 0143-0148, local history renamed, columns
  added locally by hand). SDK `collector/RadioStatus.kt` sends them and
  fills level + network from `getSignalStrength()` when the cell list is
  empty. Profile: network card rows per group, "Time on 4G/5G" over measured
  readings, doughnut and chart ticks by group, hover says why and how late
  the reading arrived. Related data: groups in the table, "Reached the
  server late" tile (> 10 min). Handoff doc lists the four fields. Release
  APKs on the Desktop (previous in `old-apks\*_before_status_*`).
- **Speed test like LibreSpeed / Ookla** (2026-10-26, built, NOT committed,
  not run on a phone). The old test was one connection, a fixed 6 MB / 2 MB
  file through Django, so it read below Ookla. Now nginx serves
  `/speedtest/empty` (204), `/speedtest/garbage` (32 MB random file baked
  into the frontend image) and `/speedtest/upload` (body dropped, 64 MB
  max), `limit_conn` 16 per address, no Django worker used. SDK
  `device/SpeedTest.kt`: parallel streams for a fixed time, first 1-1.5 s
  left out, sustained rate; Profile FULL (6 down / 4 up, 10 s, caps 150 MB /
  60 MB) for a tap, LIGHT (3/2, 5 s, caps 15 MB / 6 MB) for Collector and
  problem reports; falls back to the old Django test on a 404. Phones on
  mobile data still cannot reach prod (172.16.41.201) until NTC routes the
  APN to it. Ookla itself can only come through Ookla's licensed SDK or
  data products.
  Then (same day, NOT committed): `SpeedTestSettings` singleton (migration
  0144; AI migrations now 0145-0150, local history renamed, table created
  by hand) set on Security, card "Speed test server" (superadmin; blank =
  this server); phones read `GET /api/telemetry/v1/speedtest/config/`
  before each test and remember it. Speed results are held on the phone
  (`storage/SpeedResultQueue.kt`, `upload/SpeedResultUploadWorker.kt`)
  until DT-WATCH can be reached; an unreachable server on mobile data says
  so in plain words. `docs/speedtest-server/` = nginx config, Dockerfile
  and guide for a public test machine (tested in Docker). Public exposure
  checklist (Claude Docs, private to the user):
  `claude.ai/artifact/WudWv2TDh1GmRFM73tDrF2`.
- **Session names with every district** (2026-10-26, built, NOT committed).
  `CollectionSession.district` is now a comma list of the districts in the
  order first reached (`districts_in`, `merge_districts` in
  `core/collection.py`; serving site's district, else nearest site, at most
  20 map lookups a batch); every batch adds to it and the generated name
  follows ("Lalitpur, Kathmandu, Bhaktapur +2 · Crowd drive · …"). No
  migration. **After deploying, run `manage.py refresh_session_districts`
  on prod once** (`--dry-run` first) to rename stored sessions.
- **Readable complaint tiles** (same day): Phone's reading and the
  measurements of Likely cause are tiles with rounded values and a plain
  verdict (Good/Fair/Weak, Slow, High) from the check's limits.
- **Compact pages and Site Topology from a complaint** (same day, built,
  NOT committed, not seen in a browser). Last block of `App.css` tightens
  every page under `ui-console`: 18 px page heading, the intro one line
  (full on hover), smaller gaps, tighter cards and tables, Problem
  Dashboard charts at most 210 px high. Site Topology opens on
  `?at=lat,lng` (search box filled, map flies there, nearest site);
  `BackToProfileBar` also accepts a Problem Dashboard `back=` address
  ("← Back to the complaint"). The complaint's location has "Show in Site
  Topology →". Then, after the user compared with UTS's screen, a second
  last block "Density like UTS": 13 px base, 40 px top bar, one-line
  footer, 17 px brand-blue title over a thin rule (no gradient strip), 30 px
  controls, smaller buttons/tabs, 8 px corners, tighter complaint cards.
  The map in the complaint's Diagnostics card was removed (Related data has
  the map). Third block "A livelier look, after UTS": page title and its
  description on one line (cut with "…", full on hover, a rule under
  them), and `components/MetricTile.tsx` (Tile with icon chip and coloured
  value, CardHead = icon chip + title + subtitle, Band = soft blue group
  header, rate/rateLevel helpers) used across the Problem Dashboard and
  Related data; the analysis tabs carry a subtitle. Then: the top bar shows
  the page and its one-line summary (the menu item's description) with an
  ⓘ button; while the top bar names the page (`has-crumb` on `<main>`) the
  page's own h1 and intro are hidden, ⓘ (`show-intro`) shows the intro in a
  light box. Every `.admin-page > section` is a card with the h2 as its
  header line. Card contents use light inner panels (`#f5f8fc`).
- **Session History "slow"** (same day): the 16-18 s seen in the browser
  came while containers were rebuilt and tests ran on the same 2-CPU
  Docker; the list itself answers in about 0.45 s (`sample_count` subquery
  over 918,000 readings).
- **Flutter on this PC:** SDK at `D:\DevCache\flutter` (3.47.7), pub cache
  `D:\DevCache\pub-cache`, Gradle home `D:\DevCache\gradle`. `flutter build
  apk` fails here (the `&` in the path breaks `gradlew.bat`; a junction does
  not help, Flutter resolves it). Build the example with
  `"$JAVA_HOME/bin/java" -Xmx128m -classpath gradle/wrapper/gradle-wrapper.jar
  org.gradle.wrapper.GradleWrapperMain --no-daemon assembleDebug` from
  `example/android`. Java cannot download from GitHub release hosts here, so
  a new Gradle version must be fetched with curl into
  `D:\DevCache\gradle\wrapper\dists\<name>\<hash>\`. `flutter analyze` and
  `flutter test` work normally.

- **Collector edition of the app** (2026-10-14, built, not committed, not
  run on a phone). Product flavours `standard` and `collector` in
  `app/build.gradle.kts`, same application ID (Firebase needs it, so one
  replaces the other). Collector: sharing with no time limit until the
  user stops it, `CollectorService` takes a reading every 15 s, uploads
  every 5 min and runs a speed test every 30 min, employee tabs on.
  Desktop: `dtwatchTelemetry_Collector.apk` next to `dtwatchTelemetry.apk`.
  For a small group of staff only.
- **Speed test over mobile data** (2026-10-14). `SpeedTest.runOnMobileData`
  asks Android for the mobile-data network and sends every request over
  it, even on Wi-Fi; packet loss is the share of 20 pings with no answer
  in 2 s (`TelemetrySpeedResult.packet_loss_pct`). A Wi-Fi result is not
  sent to NTC.
- **Problem reports** (2026-10-14, built, not committed, not on prod;
  not AI work). `core/problem_report.py`, model `ProblemReport`,
  migration 0129 (with the menu item, opaque route `/r4q7cx`), page
  `ProblemReportsPage.tsx` (admin and superadmin). The app's "Report a
  problem" button (Signal screen, registered phone, signed) sends the
  category, note, reading and a mobile-data speed test; staff can enter
  a complaint by clicking the map. The check is plain rules worked out on
  read: weak signal, interference, busy cell, phone on 2G/3G where 4G is
  measured, worse than the 7 days before, call drops (needs KPI), no
  data; with a customer reply per cause. Other phones are shown only as
  counts and averages; the reporter's number to superadmin only. The
  app shows the same rules on the phone (`ProblemHints.kt`). Server
  tested in-process with a throwaway key. Not done: AI wording of a
  report (C), alarm/billing feeds.
- **Explore on wide searches** (2026-10-14, built, not committed). A
  district search (Gulmi: 318,698 readings in its covering circle) ran
  the 1 GB server out of memory and the page showed no sessions. Now:
  the page sends the district outline; above 20,000 readings the server
  reads `DtPlotSquare` (`core/dt_plot_squares.py`, migration 0130): per
  session and 50 m square the count and weakest/strongest/average of
  each measurement, one dot showing the weakest value. Built by the
  migration for stored sessions; a new session, or one appended to,
  carries `plot_squares_stale` and is built on its next search. Zoomed
  to 4 km across or less, the page loads every reading in view. Gulmi:
  0.6 s, 4 MB; every session's weakest RSRP kept. Committed `b35cb6c`.
- **Drive-test retention** (2026-10-14, built, NOT committed; rule agreed
  with the user that day). `core/dt_retention.py`, migration 0131, page
  `DtRetentionPage.tsx` (opaque route `/d5r8vt`, superadmin). Per 50 m
  square and technology, a session keeps its full readings when it is one
  of the 2 latest yearly (NTA) drives there (any age), one of the 2 most
  recent drives of any purpose there and at most 24 months old, pinned
  (Keep) or linked to an optimization activity, or the last full readings
  of that square. Elsewhere readings are deleted and the square summary
  stays (`DtPlotSquare.detail_removed`); a session with nothing kept,
  older than 5 years and unprotected, is erased. Counts as "measured" with
  3+ readings. Off by default; a superadmin runs a dry run and approves
  it; `apply_dt_retention` (in `run_maintenance`) carries it out only if
  a fresh plan matches. `DtPruneRecord` keeps what was removed for good.
  Phone data does not count for pruning. Upload asks the purpose
  (required) and where the original is kept; the file is never sent,
  only its SHA-256, which finds a re-upload. Session History edits
  purpose/Keep/source. Explore has Sessions / Recent / Change views from
  the squares. Audit log default raised to 180 days (6 months): check
  prod `.env` for `AUDIT_LOG_RETENTION_DAYS`. Tested with simulated
  history in rolled-back transactions; local data untouched. AI
  migrations moved to 0132-0136.

- **PCI plot in Explore** (2026-10-14, built, not committed; frontend
  only). The fixed hash (PCI mod 12) gave PCI 8, 20 ... 440 one colour and
  the legend listed only the 24 lowest PCIs. Now `pciColorMap()` in
  `lib/dtBands.ts` ranks the search's PCIs by reading count and hands out 20
  distinct colours; the legend lists every PCI with its count, and a click
  (or the Find PCI box) shows that PCI alone. "PCI mod 3" view, and PCI
  numbers on the map at 2 km across or less (`PciLabelsLayer`). Session
  History has no PCI plot, so only Explore changed.

- **Calls from phones, no quality figures** (2026-10-14, built, NOT
  committed in either repo, not on prod, not run on a phone; not AI work).
  The call-quality lane (VoLTE Quality, `core/volte_quality.py`) needs a
  carrier-privileged app and has no data. This lane needs only
  READ_PHONE_STATE: `CallListener.kt` in the SDK records each call made
  while sharing (voice network every 3 s, data network before, start/end
  cell and level; no number, no direction), `CallQueue`, `CallUploadWorker`,
  `TelemetryConfig.callSamplesUrl` (added to the private config file by a
  non-printing sed copy of the speed-test line). Server:
  `core/call_context.py`, model `CallContextSample`, migration 0132 (AI
  migrations moved to 0133-0137), `POST /api/telemetry/v1/call-samples/`,
  `GET /api/v2/telemetry/call-samples/` (superadmin), "Calls from phones"
  section on the VoLTE Quality page. Outcome per call: VoLTE, Wi-Fi
  calling, fell back to 2G/3G, 2G/3G with no 4G before, unknown. Tested
  in-process in a rolled-back transaction. A 404 keeps calls queued, so the
  app is safe against prod before the deploy.
- **Stale nested copy:** `nepal-telemetry-project/nepal-telemetry-project/`
  is an old copy of the app (it has a `VolteCallQualityListener` the real
  SDK never had). It is not built or pushed; read the real SDK at
  `nepal-telemetry-project/netplanning-telemetry-sdk/`.
- **App hardening after a MobSF scan** (2026-10-14, built, NOT committed).
  Release build type: R8 shrink/obfuscate, debug/info logs stripped
  (`app/proguard-rules.pro`), signed from `keystore.properties` at the
  project root when present (the user creates and holds the keystore; never
  generate it, never commit it). Cleartext rule moved to
  `app/src/debug/res/xml/`; release is HTTPS only. Backup off
  (`allowBackup=false`, `data_extraction_rules.xml`). Map tiles cached in
  app storage. Release APK 2.7 MB against 9.6 MB debug; release is not yet
  signed or run on a phone. Accepted: minSdk 26 (the Huawei is API 26),
  library and native-lib findings.
- **Signed uploads** (same day, built, NOT committed, not on prod). The SDK
  takes a `RequestSigner` (`NetTelemetry.setRequestSigner`); the app's
  `SdkLink.kt` sets it from a content provider and, once registered, sends
  `POST device/sdk-link/` (signed) with the SDK device id. The server stores
  it as `DeviceCredential.sdk_device_hash` (migration 0132, renamed
  `0132_calls_and_sdk_link`) and `ingest_row_device_id()` files signed
  samples, speed results, push tokens, call and VoLTE rows under it, so a
  phone keeps one identity. Unregistered phones keep the shared key; a 401
  on a signed upload falls back to it. Tested in a rolled-back transaction
  (link, identity, tampered body, replayed nonce). Retiring the shared key
  (`TELEMETRY_SHARED_KEY_ACCEPTED_UNTIL`) is the user's decision and would
  stop unregistered phones from sharing.

- **CQI and 3G values in the phone lists** (2026-10-14, built, NOT
  committed). Live Samples and Telemetry Drive Test showed only the
  SINR-based `cqi_derived`, so LTE rows without SINR had no CQI; they now
  get `cqi_value`/`cqi_source` from `sample_cqi_fields` (reported, SINR,
  RSRQ), the coverage map's chain. 3G readings of RSCP/RSSI -24 dBm with
  Ec/Io 0 (seen on prod after a fallback to 3G) are the modem's no-value
  code: `_wcdma_levels` in `core/telemetry.py` drops levels outside
  -125..-25 dBm and Ec/Io outside -30..0 or 0 with no level; the SDK does
  the same (`wcdmaLevelOrNull`), and migration 0132 clears stored rows.

- **Registered phones in Device Location Trace** (2026-10-15, approved by
  the user, built, NOT committed). Shared readings are stored under the SDK
  id, registration and identity links under the key id, so the trace tool
  found no position for a phone that registered but never turned on the
  rescue beacon. `DeviceSdkLinkView` now also links the number to the SDK id
  (`VIA_REGISTRATION`, the registration link's model and hardware key, so it
  folds into one phone). Rules unchanged: emergency, case reference, log,
  withdrawn rescue consent hides it. Rescue Lookup still covers beacon
  opt-ins only (it passes `only_devices`). Tested in a rolled-back
  transaction; existing subscriber-device, telemetry and serving-cell tests
  pass. Works once a phone runs the new app against the deployed server.

- **Speed tests on Live Samples** (2026-10-15, built, NOT committed). The
  phone's speed tests (`TelemetrySpeedResult`) showed only inside a
  Telemetry Drive Test session covering that phone and time.
  `TelemetrySpeedResultsView` (`GET /api/v2/telemetry/speed-results/`,
  superadmin, same window and device filter as Live Samples, operator-scoped
  through visible samples) and a "Speed tests" table on Live Samples,
  polled every 30 s.

- **Speed test over Wi-Fi too, tagged** (2026-10-15, built, NOT committed).
  App: "Test mobile data" and "Test Wi-Fi" buttons (`SpeedTest.runOnWifi`),
  every result sent with `bearer` (`mobile`/`wifi`); Collector stays mobile.
  Server: `TelemetrySpeedResult.bearer` (migration 0133), shown as "Over"
  on Live Samples, Telemetry Drive Test and Subscriber Profile.
- **Subscriber Profile** (2026-10-15, built, NOT committed, asked by the
  user). `core/subscriber_profile.py`, `GET /api/v2/subscriber-profile/`,
  page `SubscriberProfilePage.tsx`, opaque route `/s7p2nd`, superadmin,
  seeded by migration 0133 (AI migrations moved to 0134-0138). One number
  (any spelling) to: phones and installs (links, registration under every
  spelling, rescue, identity, masked IMEI), readings summary, last location,
  Collections, Telemetry Drive Test sessions, trace requests, speed tests,
  problem reports, calls, VoLTE, site photos, and who looked it up. Stored
  data only. Reason required, every search audit-logged
  (`SUBSCRIBER_PROFILE.VIEWED`). Location kept to the existing rule: cell,
  network and signal always; exact coordinates only while an emergency is
  declared; nothing for a withdrawn rescue consent. Live Samples opens on
  one device with `?device=`. Tested in a rolled-back transaction.
  Redesigned the same day after the user's TelcoPulse reference (dark
  console: `.sp-*` styles at the end of `App.css`, own tokens with a light
  variant). The number and reason live in the page address; the profile is
  cached 30 minutes (each server search is logged, Refresh asks again);
  every link out carries `back=<profile address>` and `BackToProfileBar`
  (in `Layout.tsx`, accepts only the profile path) leads back; the scroll
  position is restored. Not yet seen in a browser.
  Second pass (same day): cards flow in one auto-fill grid (`.sp-flow`,
  wide tables `.sp-wide`), empty sections are left out and named in one
  line. Links land on the records: Live Samples `?device=&minutes=129600`
  (server allows 90 days and 5000 rows for one device, `_live_cap`,
  `_MAX_DEVICE_LIMIT`; all devices stay at 24 h and 500), Collections
  `?device=`, Telemetry Drive Test `?name=`, Problem Reports
  `?status=all`, Site Photos `?status=`, VoLTE Quality `?days=90`. Each
  page only reads these as its starting filter.
  Third pass: compact spacing (last block of `.sp-*` in `App.css` wins),
  every section shown, empty ones as a one-line card; tables 10 rows a page
  (`Paged`); charts in plain SVG (signal history from `signal_series`, the
  newest 300 readings without positions; readings-by-network ring; download
  per speed test); the location card shows the full last reading and a
  small map of the serving site (a mast, always shown; the customer's own
  position only in an emergency). The location card no longer links to
  Live Samples (same list as "Open all readings"); the phones card links to
  Registered Devices only for a registered number, else Rescue Enrolled.

- **Console design on every page** (2026-10-15, asked by the user after
  the profile redesign; built, NOT committed, not seen in a browser).
  `Layout.tsx` puts `ui-console` on `<main>` (signed in only); the last
  block of `App.css` restyles the shared classes under it: page title with
  a gradient strip, `.admin-table` as a rounded card with a quiet uppercase
  header (replaces the solid brand-blue header bar the user approved on
  2026-10-01), `.report-card` tiles, form fields, gradient `.btn-primary`,
  pill `.feat-tab`, compact `.page-status`. Removing the class restores the
  old look. Pages with their own bespoke styling are unchanged.
  Second pass, after the user looked: menu-item cards and Dashboard
  shortcuts keep the original gold edge that turns brand blue on hover (no
  other card hovers); pages widen to 1680 px (forms of 640 px or less stay
  narrow, `!important` because many pages set `maxWidth` inline). Site
  Detail is in profile-style cards (`.site-card`, heading `data-icon`):
  Identity and Tower side by side as label-over-value grids, Sectors under
  them in the left column, Quick Stats and the map (fixed 320 px, sticky)
  on the right, Drive Tests + Antenna Changes, Photos and Issues below. The
  map went blank when the sidebar stopped stretching (its box had no
  height); the Leaflet container is now absolutely positioned in its box.
- **Problem Dashboard, phase 1** (2026-10-15, built, NOT committed, not
  on prod; not AI work). The Problem Reports page became a dashboard with
  Overview (tiles, reports per day, causes, sources, districts, network),
  Reports (the old list and check, filterable by cause, site or 500 m
  area), Map (dots by cause) and Hotspots (by serving or nearest site, else
  500 m area). Tab, period and filters live in the page address.
  `ProblemReport` keeps the check's main `cause`, `site`, `site_by`,
  `sector`, `classified_at` (migration 0134, which also renames the menu
  item); `classify_problem_reports` in `run_maintenance` works them out
  every 2 min and again once the readings around the time have arrived;
  the dashboard spends at most 3 s on any still waiting. The stored check
  ignores the viewer's operator filter so counts are the same for all.
  The check's drive-test lookup used `distance_lte` (no spatial index,
  2 s a check); it is `dwithin` now (0.02 s).
  **Reports from other NTC systems** (asked by the user the same day):
  `core/external_problem.py`, `POST/GET /api/external/v1/problem-reports/`
  with API keys holding the new `problems:write` / `problems:read` scopes
  (API Access page). The key's name is the system's name
  (`external_system`); its ticket number (`external_ref`) is unique per
  system, so a re-send updates the report while it is new and changes
  nothing once checked. Place: lat/lng, or `site_id`, or 4G `cell_id`
  (`located_by` site/cell: the check looks around the mast, and the
  report says so). The read-back carries status, likely cause and the
  customer reply, but no engineer's note and no number. Up to 200
  per request, 5000 new a day per system. Tested in a rolled-back
  transaction.
  **Linked systems, same day** (user's decisions): linked systems are
  NTC's own, so they may send the customer's number (`msisdn`, canonical
  977..., superadmin-only like an app reporter's number; the report shows
  on that number's Subscriber Profile; notes are no longer stripped of
  numbers). `core/problem_notify.py`: `LinkedSystem` (name = API key
  name, address, signing secret shown once, mode Automatic / Manual / Off,
  pause) and `ProblemNotification` (delivery log; waiting updates for a
  report are merged; body built at send time; HMAC-SHA256 of
  "timestamp.body" in `X-DTWatch-Signature`; retries 1 min to 12 h, 8
  tries, then failed; Retry now). Automatic sends on a status or cause
  change; Manual only from the report's "Send update"; the job
  `send_problem_updates` (every minute, in `run_maintenance`). Managed on
  API Access ("Linked systems"). Migration 0135; AI migrations moved to
  0136-0140 (local history renamed). Tested with a local receiver in a
  rolled-back transaction. Prod needs outbound HTTP from the django
  container to each system's address.
- **Security audit follow-up** (2026-10-15, built, NOT committed in either
  repo, not on prod). Asked by the user after a public-exposure audit.
  - SECRET_KEY: with DEBUG off the server refuses to start on the default,
    a key under 50 characters or a repetitive one. Note `.env` here has
    `DEBUG=True`, which settings read as off (only `1` is on).
  - Rate limits: `core/throttles.py` (per user `API_USER_RATE` 1200/min,
    per address `API_ANON_RATE` 120/min; `/api/telemetry/` and
    `/api/external/` exempt), keyed on X-Real-IP. nginx `limit_req` 30/min
    burst 30 on `/api/v2/auth/`. nginx now sets the real client address
    from X-Forwarded-For when the peer is a private address (Traefik,
    Docker): before, behind Traefik every user had Traefik's address, so
    three failed logins by anyone could IP-block the whole site.
  - Browser session login off unless DEBUG or `API_SESSION_AUTH=1`.
  - Linked-system update addresses: `check_address` (https only unless
    `LINKED_SYSTEM_HTTPS_ONLY=0`, `LINKED_SYSTEM_ALLOWED_HOSTS` with
    `*.domain`, never loopback/link-local/internal service names; checked
    on save and every send; no redirects). A local http test receiver is
    therefore refused now.
  - SheetJS from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`,
    DOMPurify 3.4 (`lib/safeHtml.ts`) on every `dangerouslySetInnerHTML`;
    `npm audit --omit=dev` reports 0.
  - Two-factor login: the backend existed (Phase C) but the web app had
    no screens, and a TOTP-enrolled account could not sign in. Now: code
    step on the login page, `TwoFactorModal` (user menu, and forced when
    required), `SecuritySettings.mfa_required_admins`.
  - Phone number verification by SMS (Phase G seam): `core/sms.py`
    (`SMS_BACKEND` off/console/http/ntc, every gateway detail in `.env`,
    see settings.py), `core/number_verify.py` (signed device endpoints,
    6-digit code, 10 min, 5 tries, hashed in Redis), registration answer
    carries the flags, `DeviceCredential.msisdn_verified_at`, only a
    verified owner blocks a number, `SecuritySettings
    .phone_verification_required` filters `devices_for_msisdn` and the
    Subscriber Profile to SMS/SIM-proved links. Local `.env` has
    `SMS_BACKEND=console` for testing. App: `NumberVerify.kt`, built, APK
    on the Desktop, not run on a phone.
  - Security page (superadmin, `/s9k4tq`, migration 0136 with the menu
    seed): the three switches, SMS gateway status and test SMS, and what
    .env has in effect. AI migrations are now 0137-0142.
  - `log_audit_event` no longer fails when a phone (DeviceCredential) is
    the caller.
  - Tested in a rolled-back transaction with a throwaway signed phone:
    every check passed.
  - **Attack alerts** (same day, asked by the user): `core/alerts.py`.
    An address newly auto-blocked (`ip_block.maybe_auto_block`) or a real
    account reaching the 5-failure lockout (`LoginView`) alerts every
    active superadmin by the email and the new `User.mobile_number` on
    their account (Users page), plus extra recipients; one alert per
    address/account an hour; sent in a background thread; written to the
    Audit Log (`ATTACK_ALERT.SENT`). Security page "Attack alerts": on/off,
    channels Email / SMS / both, extra emails and numbers, "Send a test
    alert", warnings for no EMAIL_HOST, no SMS gateway, superadmins with
    no email or mobile. Migration 0137 (AI migrations now 0138-0143).
    Tested in a rolled-back transaction (alerts sent in place).
  - **CI**: `.github/dependabot.yml` (pip, npm except xlsx, both
    Dockerfiles, Actions; against `telemetry`) and
    `.github/workflows/security-scan.yml` (pip-audit, npm audit high,
    gitleaks fail the run; bandit reports only). pip-audit run here found
    nothing. Not yet run on GitHub.
- **Linking earlier readings by hand** (2026-10-15, built, NOT committed).
  A reinstall (e.g. debug to signed release) gives a phone a new SDK id,
  and apps before 14 October never sent `sdk-link`, so old readings belong
  to no number. `core/subscriber_link.py`: candidates = device ids linked
  to no number whose last-90-day readings share 500 m squares with this
  number's phones (most overlap first); superadmin links one with the case
  reference (`SubscriberDevice` via `manual_link`, self-declared, audit
  log), or removes it. Profile Phones card: "Find this phone's earlier
  readings…" (`LinkEarlierReadings.tsx`). Also: Registered Devices and
  Rescue Enrolled filter by `?msisdn=` from the profile
  (`lib/msisdnMatch.ts`); dashboard shortcut cards got the gold edge;
  Collections route fits all points (`FitToPoints.tsx`). Desktop now holds
  only the signed release APKs `dtwatchTelemetry.apk` and
  `dtwatchTelemetry_Collector.apk` (older ones in `Desktop\old-apks`).
  Release builds need the llama-server (11 GB) stopped for memory.
- **Rows per page on every table** (2026-10-15, built). `lib/tablePager.ts`,
  installed by `Layout.tsx`, watches the page and pages any table with more
  than 10 rows: rows outside the page are hidden (never removed, so sorting,
  filters and exports are untouched), a bar under the table has rows per
  page (10/20/50/100/200, default 20), previous/next and "21-40 of 135". A
  row whose only cell spans columns stays with the row above (opened
  details). One choice for the whole app, kept in this browser
  (`lib/rowsPerPage.ts`). Tables that page on the server or on their own
  carry `data-pager="off"` and use `RowsPerPageSelect`: Audit Log, the
  Sites table, the Subscriber Profile tables. Checked in headless Edge on a
  test page (paging, detail rows, size change, filter, removal), not on the
  real pages.

- **Indoor / outdoor / vehicle tag** (2026-10-26, committed, not on prod,
  not run on a phone). SDK `collector/Environment.kt`: a manual
  choice (`NetTelemetry.setEnvironment`, cleared at drive stop and share
  stop), otherwise an estimate (speed ≥ 4.2 m/s vehicle; GPS accuracy over
  30 m while still indoor; else outdoor). Every sample carries `environment`
  + `environment_source` (user/estimated); problem reports carry it too.
  App Map tab: Outdoors/Indoors/Vehicle buttons and a "Where are you
  starting?" question before a drive. Server: `TelemetrySample.environment`,
  `environment_source`; `DriveTestSession.environment` (drive /
  walk_outdoor / walk_indoor, chosen at upload and on Session History);
  `ProblemReport.environment`; migration 0145 (AI migrations now
  0146-0151). `core/environment.py` (`POST telemetry/environment/`, admin)
  tags a stretch afterwards (source `edited`), from Collections and
  Telemetry Drive Test (`EnvironmentTools.tsx`, also a place filter).
  Sector table gains "Indoor loss" (outdoor minus indoor average, 10+ of
  each). New problem cause `building_penetration` ("Weak indoors, good
  outside") ahead of weak coverage. Profile, complaint and related data
  show the indoor share. Release APKs on the Desktop. Committed and
  pushed 2026-10-26: dtwatch `17537be`, mobile `90246dc`.
- **Channel bandwidth on phone readings** (2026-10-27, committed and
  pushed: dtwatch `fda1dde`, mobile `5db2471`; not on prod, not run on a
  phone). SDK sends
  `bandwidth_khz` (serving 4G cell, `CellIdentityLte.getBandwidth()`,
  Android 9+) and `cell_bandwidths_khz` (every carrier in use, primary
  first, `ServiceState.getCellBandwidths()`; several = carrier aggregation
  or 4G + 5G). `RadioBand.bandwidthLabel` / `bandwidthOrNull` in the SDK
  and `radio_band.resolve_bandwidth` / `bandwidth_label` on the server
  (keep in step; 1-400 MHz kept, 16 carriers max). `TelemetrySample`
  gained `bandwidth_khz`, `total_bandwidth_khz`, `carrier_count`
  (migration 0146; AI migrations now 0147-0152, local history renamed,
  columns added locally by hand). Shown as "20 MHz (3 carriers, 45 MHz)":
  Bandwidth column on Live Samples, Telemetry Drive Test, Area Sample and
  Collections; diagnosis dashboard location card and signal hover; app
  Signal network line and full parameters (4G). Route popup on the phone
  map does not show it. Old readings stay empty. Release APKs on the
  Desktop (previous in `old-apks\*_before_bandwidth.apk`), SDK
  republished.
- **Documents brought up to date on 2026-10-27** for the work of 26-27
  October (AI still left out): the four manuals ("Updated 27 October"
  paragraph plus sections: related data, active alarms, reading status,
  speed test, session districts, indoor/outdoor, bandwidth, deploy steps
  and `ALARM_*` settings in Technical), management deck slides `live`,
  `complaints`, `status`, technical deck slides `telemetry-flow`,
  `complaints-flow`, `deploy` (notes only there). No slide added, so no
  renumbering. Standing rule from the user: every commit also updates
  these documents and the APKs, and lists them.
- **APK names carry the version** (user's rule, 2026-10-27): Desktop
  holds `dtwatchTelemetry_v<version>.apk` and
  `dtwatchTelemetry_Collector_v<version>.apk`; raise `appVersionName` in
  `app/build.gradle.kts` for every APK update. Now 1.2.0 (code 10200,
  built 2026-10-27, everything since 1.1.0 of 16 October); the 1.1.0 pair
  is in `old-apks` as `*_v1.1.0_2026-10-27.apk`. The version bump is NOT
  committed in the mobile repo.
- **10-digit number field** (2026-10-27, app 1.2.1, built, NOT committed,
  not run on a phone). `NumberField.kt` serves the registration pop-up and
  the Settings form: digits only, at most 10, no 977 typed (the server's
  `_clean_msisdn` adds it; a pasted +977 number keeps its last 10 digits),
  border grey while empty, red while incomplete, green at 10; Register
  refuses anything but 10 digits. Hint "10-digit mobile number,
  9XXXXXXXXX" (NTC has 98, 97 and other prefixes, so no prefix check).
- **Site names on the Cells tab** (2026-10-27, app 1.2.2, built, NOT
  committed, not run on a phone). Each cell card gets a bold "KTM856_NAME ·
  J3" line once NTC's server answers (`ServingSiteLookup`, same signed
  `device/serving-site/` call as the Signal tab); no answer (server not
  reachable, phone not registered, cell unknown) leaves the card as before.
  The serving cell is matched by its cell number; a neighbour known only by
  PCI/code sends Android's last known position (no GPS fix), and its answer
  is cached per ~1 km (key rounded to 0.01 degree). Several cells can be
  asked at once (`inFlight` is a set). Checked on the local server: PCI 65
  near CDR001 gives CDR001 J3; a PCI with no position gives nothing.
- **Committed 2026-10-27:** mobile `bb37bd6` (app 1.2.2: version bump,
  10-digit number field, Cells tab site names; not pushed). Handoff
  `.md`/`.docx` (number format, Cells tab lookup), the three manuals' app
  sections and management slide `app` notes updated the same day.
- **Neighbour cells with every phone reading** (2026-10-27, built, NOT
  committed in either repo, app 1.2.3 not run on a phone). SDK
  `model/NeighbourCells.kt`: from the same cell read as the serving cell,
  no registered entry, only cells with an identity (PCI/PSC/BCCH) and a
  level; serving technology first (6), 3 per other technology, 8 in all;
  sent as `neighbours` (`net`, `pci|psc|bcch`, `bsic`, `arfcn`, `band`,
  `cell_id`, `tac`, levels). Server `core/neighbour_cells.py`: `coerce`
  (known keys, ranges, at most 8), `attach_sites` names each at upload
  with the serving-cell matcher on the reading's position (`site`,
  `sector`, `km`), stored as `TelemetrySample.neighbours` JSON (migration
  0147, pruned with the partitions; AI migrations now 0148-0153, local
  history renamed, column added by hand). Neighbours column (count, opens
  to the list) on Live Samples, Collections, Telemetry Drive Test and Area
  Sample; "Neighbour cells heard" under the sector table on Collections and
  Telemetry Drive Test (`session_summary`: heard, average/best level, share
  3 dB or more above the serving cell of the same technology, distance,
  serving sector it was mostly heard beside; newest 50,000 readings). Not
  on the Subscriber Profile. SDK tests `NeighbourCellsTest`, server
  `tests_neighbour_cells.py`.
- **Sector table CQI and Collections scroll** (2026-10-27, after the
  user's prod screenshots). The sector table's CQI averaged only the
  phone-reported `cqi`, which phones almost never send, so it showed "—";
  phone readings now average `cqi.sample_cqi_sql()` (reported, else SINR,
  else RSRQ), as the reading list does. Clicking a Collections session
  scrolls to its route map.
- **Committed and pushed 2026-10-27** (neighbours, CQI, scroll, app
  1.2.3): dtwatch `3f009a7`, mobile `04ea39f`. Prod needs migration 0147.
- **After that push** (2026-10-27; committed and pushed as dtwatch
  `281d607`, mobile `ae6ccff`; app 1.2.4 not run on a phone):
  - 3G level blank on prod (rows with band B1 and no RSCP; nothing on
    Explore's RSCP:3G tab): the cell list held no level and the overall
    signal reading was used only when there was no cell. SDK
    `withServingLevel` fills a blank 3G/2G level (and Ec/Io) from
    `getSignalStrength()`, for samples and the Cells tab. Unverified on a
    phone; if 1.2.4 readings still lack it, the modem gives no 3G level
    at all.
  - Explore: Sessions/Recent/Change work on team drive tests only; the
    note says so with the count, phone dots are hidden in Recent and
    Change, and Change says it needs two drive tests.
  - Neighbours in the Problem Dashboard: `_neighbours_near` (500 m, 7 days
    before to 1 h after) and two causes ahead of the interference guess:
    `stronger_neighbour` (a cell 3 dB above serving in 30%+ of 5+
    readings) and `no_dominant_cell` (3+ cells within 5 dB in 30%+);
    labels, replies, colours; "Other cells phones heard here" table in
    Likely cause (`ProblemReportsPage.tsx`, mixed with AI lines: stage by
    hunk, the new block sits beside `ProblemAiDraft`). No migration
    (`cause` is free text). Existing reports get them on their next check.
  - Diagnosis dashboard: `analytics.neighbours` (full in an emergency,
    `counts_only` otherwise: cells heard per reading, stronger share, no
    dominant share), shown under Sectors served or as a line on the locked
    card; signal hover "Other cells heard: N, strongest PCI x · -88 dBm"
    (site only where the position shows, `point_fields`).
  - **Staff see everything but positions** (the user's decision,
    2026-10-27, for the Problem Dashboard and the diagnosis dashboard
    only; it replaces the 2026-10-19 "location history in an emergency"
    rule). Admin and superadmin: the diagnosis dashboard
    (`SubscriberProfileView`, `SubscriberSignalView`,
    `SubscriberProvisioningView` now `IsAdminOrSuperadmin`; menu `/s7p2nd`
    access `admin`, migration 0148, AI migrations now 0149-0154, local
    history renamed and menu row updated by hand), cells/sites/sectors/
    neighbours and the OSS "cells visited" always; Problem Dashboard list
    number and number search (`is_staff` in `problem_report.py`), link to
    the diagnosis dashboard, Related data's sites served always. Exact
    positions: superadmin always (no emergency needed, the user's follow-up
    the same day); admin only in an emergency or a complaint window
    (`open_positions` in `subscriber_profile.py`, `location_rule`
    'superadmin' in `problem_related.py`).
- **Calls in analysis, push address** (2026-10-27, committed and pushed;
  app 1.2.5 not run on a phone). `core/call_cells.py`: `name_calls` names
  a call's start/end cell ("KTM856 J3", same matcher as readings) on VoLTE
  Quality and the diagnosis Calls card; `sector_calls` adds Calls and "fell
  back" to the phone sector tables (`_add_calls` in `sector_stats.py`, from
  the same phones and time span); `call_findings` gives the problem check
  `call_fallback` and `call_weak_end` from the customer's calls within 3 h
  (categories call_drop, no_signal, other; `_customer_devices`); the old
  "cannot be seen" finding stays when there are no such calls. Push: an
  area request is silent on the phone by design. A trace request's
  Accept/Reject needs `DeviceCredential.fcm_token`, which the app sent once
  and lost when DT-WATCH was unreachable; app 1.2.5 sends it with a
  retrying job (`FcmTokenUploadWorker`), and the complaint page warns when
  the phone has no push address (`push_ready`).
    For admins the diagnosis page hides links to pages that plot the phone's
    route or change links (Live Samples, Collections, Telemetry Drive Test,
    Trace Requests, VoLTE, Registered/Rescue lists, "Find earlier
    readings"); those stay superadmin. Checked in a rolled-back transaction
    with a throwaway admin: profile 200, sites shown, 0 of 81 points with a
    position, problem list number shown, viewer 403. Not seen in a browser.

- **Explore: phone readings in Recent/Change, session lists as tables**
  (2026-10-28, built, NOT committed, not seen in a browser; frontend plus
  one server parameter). Recent and Change now draw the ticked telemetry
  sessions too: 50 m squares built in the page (`phoneRecentSquares` in
  `DtExploreTab.tsx`), newest phone session per square vs the one before,
  white-ringed. Drive tests, telemetry sessions and nearby sites are boxed
  tables (`components/ExploreListBox.tsx`, 10 rows by default, 10/20/50/100,
  own choice, not the app-wide one). Drive tests and telemetry sessions have
  tick boxes (one and all); only ticked ones are drawn, exported and used for
  the PCI/band legends; a new search ticks all. `dt-sessions/recent/` takes
  `sessions=` (ids) for the ticked drive tests.
  A click on a Nearby sites row scrolls to the map and flies to the site
  (`FlyToSite`).

- **Complaints tab** (2026-10-28, built, NOT committed, not seen in a
  browser). The Problem Dashboard's Reports tab is "Complaints", laid out
  after NTC's complaint system: status tiles (Total/New/Checked/Closed,
  click to filter), a filter card (search, source, problem, likely cause,
  from/to dates in Nepal days that replace the period, sort, Clear all), a
  paged table with a blue header (10/20/50/100, `page`/`size` in the
  address), and a complaint opens full width with Back and Previous/Next.
  `problem-reports/` gained `category` (already), `from`, `to`, `sort`,
  `page`, `page_size`; with `page` it answers `total` and `counts` (per
  status over the same filters without the status). Without `page` it
  answers as before (500 rows). Styles: the `.cx-*` block at the end of
  `App.css`.
- **3D terrain on the site page** (2026-10-28, built, NOT committed, not
  seen in a browser). "3D terrain" switch on the site map
  (`SiteLocationMiniMap.tsx`) swaps in `SiteTerrain3D.tsx` (MapLibre GL
  6.13.0, exact pin; 5.x has a critical advisory; lazy chunk ~290 KB gzip,
  worker loaded with `setWorkerUrl` from a `?url` import). Google imagery
  over AWS Terrain Tiles (terrarium, public, no key; all four tile hosts
  answer CORS `*`), height ×1/1.5/2/3, wedges, tilt lines and measured
  dots draped. `lib/terrainProfile.ts` reads the same height tiles (zoom 13,
  ~17 m) and works out per sector where the beam centre meets the ground
  on real terrain (4/3 earth), shown as ringed dots and a small profile
  chart beside the flat-ground estimate. Heights checked: Kathmandu 1,306 m,
  Pokhara lakeside 811 m, Sarangkot 1,528 m. nginx: `connect-src` gained
  `https://*.google.com https://s3.amazonaws.com`, `img-src` the AWS host,
  and a `.mjs` location (the worker was sent as octet-stream). Browsers
  need internet to those hosts, as the flat maps already do.
  First version drew a blank map: maplibre's stylesheet loads after ours and
  sets `position: relative` on the map box, so `inset: 0` gave it no height;
  it is now `width/height: 100%`. Seen drawing in headless Edge on a
  throwaway page. The beam list sits in a scrollable box (340 px).
  Decluttered after the user's WDR521 screenshot (same day): sectors with
  the same mast position, azimuth, tilt and height form one direction
  (2G A + 3G P1 + 4G J3), one solid beam line each from the site to where it
  lands, with a label ("50° → 3.3 km"; faint line and "no landing" when it
  does not come down within 6 km). Chips pick one direction; then only its
  wedges, tilt lines and readings show, readings coloured by level (RSRP
  scale, RxLev on 2G). Plain imagery (`lyrs=s`) by default, "Place names"
  brings back the hybrid layer.
  Then (same day): the strong part of each beam, from where its lower edge
  (tilt + half the vertical beamwidth) to where its upper edge (tilt - half)
  meets the ground, drawn thick on the line, in the label ("120° · 0.6–2.4
  km"), the list and the chart. Vertical beamwidth is not in the site list
  (only the antenna model, `Site.antenna_device`: Kathrein 80010865 12,162
  rows, CommScope RZVV-65A-R4 6,609, RRZZ-65B-R4 1,416 in the 4G file), so it
  is per band group, editable on the page and kept in the browser: low band
  (700-900 MHz) 15 degrees, high band 7 degrees (RZVV-65A-R4 catalogue: about
  14-17 low, 5.4-9.4 high; no Kathrein 80010865 datasheet found). Directions
  split by band group (`bandGroup`: the sector's `site_band` first, since a
  B3 sector's carrier reads "B3+B20"). Turn/tilt buttons on the 3D map (a
  touchpad has no right button). A model-to-beamwidth table from NT's
  datasheets would replace the band defaults.
  Lit and shadow (same day, the user's question on "beyond 6 km"):
  `coverRuns` in `lib/terrainProfile.ts` sorts each step along a direction
  into strong (antenna sees the ground and it is inside the vertical beam),
  weak (in view, outside the beam) and shadow (a nearer hill rises above the
  line). The beam line draws strong stretches thick and shadow dark dashed;
  the chart shades them; the text says "strong from X to Y" or "to 6 km,
  where the check stops (it carries on further)" and how much is hidden.
  Picking one direction draws its whole 65-degree sector as a footprint
  (`beamFan`: radials every 5 degrees, 50 m steps), lit in colour and
  shadow dark. Shadow means no direct line, not no signal (diffraction).
  WDR521 sector A (40 deg, 17 m, 3 deg tilt): shadow 0.3-1.9 km below the
  ridge brow, lit 2.45-2.85 and 3.1-3.85 km on the far valley side.
- **"No measurements nearby" when readings exist** (2026-10-28). The check
  looked only within 500 m and the 7 days before (PR-28: nothing there, 22
  readings within 1 km at other times). When that is empty it now uses
  `WIDE_RADIUS_M` 1 km and `WIDE_DAYS` 90 either side, flags `widened`,
  and the page says which window it used; `no_data` names the wide window.
  Open reports still at `no_data` are re-checked once a day (`_unsettled`),
  so stored ones update on prod by themselves after the deploy.

- **No hints for developers on screen** (2026-10-28, the user's rule): text
  like "use the antenna's datasheet if you have it", setting names (.env,
  SMS_*, EMAIL_HOST, HTTPS_ENABLED, TELEMETRY_SHARED_KEY_ACCEPTED_UNTIL) and
  "restart the server" were removed from the site map, Security and Live
  Site Sync pages; such details go in the Technical Manual (superadmin
  technical document) instead. The in-app Documentation page may keep them.
  Live alarms on 28 October: the local server's connection comes from .env,
  but 10.26.192.141:3000 did not answer from this PC (not on NTC's network).

- **Active alarms column on Sites Topology** (2026-10-28). Table column
  after Site: the three most severe alarms per site (severity, alarm, network
  type, device) and "+N more"; header shows when the list was read, a
  refresh button (asks the alarm system itself, `refresh=1`, rate-limited)
  and an "Only active" switch (`alarms=1` on `/sites/`, filtered by the
  cached alarm list's site ids). `GET alarms/sites/?sites=` returns the
  page's sites' alarms (max 200) and `sites_with_alarms`. Tested with a
  stand-in alarm list (the middleware was not reachable from this PC).
- **3D terrain in DT Explore** (2026-10-28). "3D terrain" button beside
  Satellite swaps the flat map for the same 3D component as the site page
  (`SiteTerrain3D.tsx`, now also taking `area` and `sitePoints`): search
  area, sites, and the dots of the chosen view and tab (weakest per square
  as on the flat map, PCI/band colours, white-ringed phone dots, Recent /
  Change squares via the shared `recentSquareStyle`), with turn, tilt and
  height. "Street" on the flat map means place names on in 3D.

- **"Where" on every session map, and start/end pins** (2026-10-28, built,
  NOT committed). Drive-test readings got `environment` (migration 0149,
  nullable; AI migrations now 0150-0155, local history renamed, column added
  by hand): null means the session's test type (drive = vehicle, walk
  outdoors, walk indoors; `withSessionPlace` in `EnvironmentTools.tsx`).
  `POST telemetry/environment/` takes `dt_session` (times are text, each is
  parsed; naive = UTC). The "Where" bar is now on DT Session History's map
  (`DtCoverageMap` props `sessionId`, `sessionEnvironment`, `canTag`;
  tagging for admin and superadmin), DT Explore (filter only, over drive
  tests and phone points; Sessions view, not on square searches; the 3D view
  follows it) and the diagnosis dashboard's signal analytics (pills; the
  analysis cards do not follow it). Collections and Telemetry Drive Test had
  it already. `components/RouteEnds.tsx`: green S pin at the first reading,
  dark red E at the last, time on hover; on Collections, Telemetry Drive
  Test (per phone), DT Session History and Explore (per ticked session, up
  to 30). Collections' jump to the route keeps re-aligning for 2.5 s until
  the user scrolls.

- **One card per phone** (2026-10-28, built, NOT committed). Prod showed one
  Samsung as "3 phones" and 8 cards: only some ids carry the hardware
  fingerprint, and `_describe_phones` keyed on it first. Now make and model
  is the key; the fingerprint splits a model only when two fingerprints were
  seen for it. Diagnosis dashboard: one card per phone (current registration,
  total readings, app now) with its records folded into a table. Registered
  Devices marks a registration replaced by a newer one from the same number
  and model (`replaced_at`, nothing revoked) and hides those by default.

- **Stacked readings and pins** (2026-10-28, built, NOT committed). Local
  Telemetry Drive Test "koteshwor chowk area" (2 September): 34 readings on
  two spots (32 + 2), all RSRP -44, operator 310/260, i.e. a test phone that
  did not move; one dot per spot, both under the S/E pins, so it looked like
  "no plot". Pins now float 8 px above the reading; `StackedNote` in
  `RouteEnds.tsx` says "34 readings at 2 places" on Collections, Telemetry
  Drive Test and DT Session History maps when there are 3+ readings per
  place. Telemetry Drive Test's reading table is in time order.

- **Jump to the map on every session list** (2026-10-28, built, NOT
  committed). Collections' scroll watch moved to
  `lib/useScrollToSelection.ts` and is used on Collections, Telemetry Drive
  Test (selected session in a section headed "Session — name" with "↑ Back to
  the session list") and DT Session History (the detail panel).

- **Network KPIs per cell** (2026-10-28). NTC's KPI team is building an
  API for their dashboard's per-cell figures; no manual upload or mail
  (the user's decision). `core/cell_kpi.py`: `CellKpi` (one row per cell
  and day / busy hour / hour, `uniq_cell_kpi_period`, null = not measured,
  never "/0") and `CellKpiSourceSettings` (singleton: off / demo / http,
  address, encrypted key, field map their->ours, levels, fetch hour, keep
  days, link pattern to their dashboard), migration 0150 (AI migrations
  now 0151-0156, local history renamed, tables made from `sqlmigrate`).
  Pull: `fetch_cell_kpis` in `run_maintenance` fetches yesterday after the
  fetch hour, retries every 30 min; `GET <url>?date=&level=&page=&page_size=5000`,
  answers a list or `results`/`data` with `next`. Push: `POST
  /api/external/v1/cell-kpis/` with scope `kpis:write`. Demo: the daily
  "Network 2" exports in `data/media/cell_kpi_demo/` (git-ignored; placed
  here, not on prod). Matching: cell name, site + label, eNodeB + local
  cell, site + local cell; 22 Oct export: 24,374 rows, 99.3% matched, 26 s.
  After each import the site list's `prb`/`prb_dl`/`prb_ul` take the busiest
  sector's newest busy hour (monthly report). Site page card "Network KPIs"
  (`SiteCellKpis.tsx`: busy hour / whole day, 7-30 day DL PRB line, network
  CQI beside drive-test CQI, link to their dashboard); Live Site Sync card
  (`CellKpiSourceSection.tsx`). Complaint check: `cell_load` (serving cell,
  else the site's busiest cell; hour row, else busy hour, else day, else up
  to 3 days before), `busy_cell` quotes it, new cause `slow_not_busy` (DL
  PRB under 50%), call-drop finding shows the cell's drop rates; Hotspots
  "Cell load" column. Tested: 9 unit tests, rolled-back checks; pages not
  seen in a browser. Network 2 covers EDR, WDR and FWDR only; its BBH is
  20:00 for every cell.
- **One card per phone; Registered Devices replaced rows** (2026-10-28):
  see the diagnosis dashboard notes; stacked-readings note and route pins;
  jump to the map on Telemetry Drive Test and DT Session History. All in
  the same commit as the network KPIs.

- **Antenna beams on the site map** (2026-10-28, built, NOT committed). The
  site list's 4G `beamwidth`/`radius` are KML drawing values (40 or 60
  degrees, 200 or 150 m; none on 2G/3G; no Tx power anywhere), so three
  sectors showed 60-80 degree gaps. The "Diagram" switch is now "Beams": one
  beam per antenna direction (same grouping as the 3D view), drawn from the
  3GPP horizontal pattern (12 x (angle/HPBW)^2 dB, floor 25 dB) with path-loss
  exponent 3.5, so the outline at 60 degrees off boresight is half the length
  and neighbouring sectors meet. Strong fill = within 3 dB, light dashed = out
  to the floor. HPBW from `Site.antenna_device` (`antennaHpbw`: CommScope
  names carry it, Kathrein 80010865 taken as 65, Omni = circle, unknown = 65),
  changeable on the page (localStorage `dtwatch_horizontal_beamwidth`). Length
  = where the top of the vertical beam meets flat ground, 150 m to 1.5 km,
  500 m when height or tilt is missing (`beamReachM`). Helpers in
  `lib/sectorWedge.ts` (band group and beamwidth storage moved there too).
  The DT coverage map (`SectorBeamOverlay` in `DtCoverageMap.tsx`) draws the
  same beams; `serving-cells/` now also returns tech, site_band, carrier,
  height, tilts and the site's antenna model.
- **Predicted coverage on the site map** (2026-10-28, built, NOT committed,
  not seen in a browser). "Predicted" switch: `lib/coveragePrediction.ts`
  works out a 120 x 120 grid (1.5/3/5/8 km round the site, about 0.3 s) per
  technology: power + gain - cable loss - 3GPP pattern (horizontal and
  vertical, max 25 dB) - Hata (Okumura <= 1500 MHz, COST-231 above; antenna
  height over the point's ground; urban/suburban/rural) - knife-edge loss
  over the main ridge (ITU-R P.526, one walk per mast) + model offset, on the
  terrain tiles (`heightSampler` in `lib/terrainProfile.ts`). Views: Level,
  Best sector, Overlap (next sector within 3/6 dB). With Measured on, the
  panel compares readings with the prediction for the same sector and an
  admin can save the mean difference as the model offset. Radio values:
  `CoveragePredictionSettings` singleton (migration 0151; AI migrations now
  0152-0157, local history renamed, table created by hand),
  `core/coverage_prediction.py` (`GET/PUT coverage-prediction/settings/`,
  GET any user, PUT admin, audit `COVERAGE_PREDICTION.UPDATED`). Starting
  values per band (B20 RS 18.2 dBm/15.5 dBi, B3 15.2/17.5, 3G CPICH 33/18,
  2G BCCH 43 with 2 dB cable), only changed values are stored; a sector's
  own `max_tx_power_dbm` comes first (4G: minus 10 log(12 x 5 x MHz); 3G
  minus 10). Waiting for NTC's planning values; an admin types them in on
  the site map ("Change values"). Flat-ground check: B3 -94 dBm at 1 km,
  B20 -83. Tests `tests_coverage_prediction.py`.
  Both committed and pushed as `4a88375` (2026-10-28); manuals and decks updated.

- **OSS diagnostics (KPI) on a complaint** (2026-10-29, built, NOT
  committed, not seen in a browser; the user's request). The diagnosis
  dashboard's "Core network diagnostics (MME / MSC / PGW / HSS / SPR)" card
  is gone; its two tabs (Subscription & provisioning, Device & bands) moved
  into the BI card's window ("Subscriber usage, provisioning & location
  history"). In its place, under a complaint's Site related analysis:
  "OSS diagnostics (KPI)" (`components/ProblemOssKpi.tsx`, asked when
  opened). `core/problem_oss.py`, `GET problem-reports/<id>/oss-kpi/
  ?radius_km=1|2|3|5` (Problem Dashboard users): related sites = the
  complaint's site (else nearest), sites serving phone readings within 1 km
  (3 days either side) or drive-test readings there (last year), then the
  nearest sites in the radius (8); each with the busiest cell around the
  problem time (`load_at`), the week up to the problem day (busy days, worst
  availability, highest drops, lowest speed per user) and a verdict (partly
  down < 99% availability, busy, close to busy, normal, room to spare, no
  KPIs). A site with no figures that week shows its newest week
  (`figures_from`). A row's "Cells" opens `SiteCellKpis` for that site.
  Locally the KPI demo covers EDR/WDR/FWDR only (22 Oct), so the KTM
  complaints show "No KPIs". Tests `tests_problem_oss.py`.
  `ProblemReportsPage.tsx` gains two lines (import + card) beside the AI
  hunks: stage by hunk.

**Do not build** "ping to discover" in the form of silent registration,
registration without a number, or server-triggered location of an
identified device. It was declined; Area Sample is the agreed
replacement. Allowed since 2026-10-29 (the user's decision): Area Sample
and a complaint's live readings also send registered, non-sharing phones
an Accept/Reject request; nothing is sent until the person accepts.

- **Registered phones in Area Sample** (2026-10-29, built, NOT committed,
  not seen in a browser or on a phone). `_ask_registered` in
  `core/area_sample.py`: phones with a registration (`DeviceCredential`,
  push address, number) seen in the circle in the last 7 days (newest
  readings from an earlier share, under the SDK id or key id), not sharing
  now (no `TelemetryPushToken`) and with no open trace get an investigation
  `TraceRequest` (15 min, case "Area sample <label>", `area_request` FK);
  max 50. The app already shows that request's Accept/Reject notification
  and, on Accept, sends signal and place every 10 s (`TraceSharingService`),
  so no app change. Results add those trace readings inside the circle
  (`source: registered`, no number) and `registered` counts (asked,
  accepted, declined, waiting). Admin and superadmin only
  (`can_ask_registered`); `ask_registered` on POST, default on; a tick box
  on Area Sample. Migration 0152 (`registered_asked`, `area_request`; AI
  migrations now 0153-0158, local history renamed, columns added by hand).
  A phone with no reading in the circle in the last 7 days cannot be found
  (the server does not know where it is). Tests `tests_area_registered.py`.
  `ProblemReportsPage.tsx` changes sit beside AI hunks: stage by hunk.
- **Complaint ID and superadmin-only details** (2026-10-29, built, NOT
  committed). Complaints are named "Complaint ID 28" (was "PR-28",
  Problem Report): `complaint_reference` / `complaint_labels` in
  `core/problem_report.py`; live requests and traces are found by the new
  label and the old "Complaint PR-28"; search takes "Complaint ID 28",
  "ID 28", "28" and "PR-28"; the list column is "Complaint ID". On the
  diagnosis dashboard "Who looked this number up" and the rescue beacon
  (chip, phone role, last-location source) are superadmin only, removed on
  the server for admins (`lookups` null; a beacon-only phone shows as
  "Linked to this number").
- **Complaint registered location** (2026-10-29, built, NOT committed).
  `ProblemReport.reported_lat/reported_lng` (migration 0152; app reports
  backfilled from their position): where the customer was when complaining,
  beside the problem location (`lat`/`lng`). The app's position fills it;
  staff entry and the external API take optional `reported_lat`/
  `reported_lng`. Both shown, copyable, in Customer complaint details.
  Option A (each phone checking its own position against an area request
  sent to registered phones) was started and then dropped on 2026-10-29;
  its code was removed. Area Sample still asks only phones seen in the
  circle in the last 7 days.
  Committed and pushed with the items above as `984bfe5` (2026-10-29).
- **"Share my location with NTC until this is fixed"** (2026-10-29, app
  1.3.0, built, NOT committed in either repo, not run on a phone). A tick
  box on the app's Report a problem screen. The report carries
  `share_until_fixed`; `start_customer_share` in `core/problem_report.py`
  creates an ACCEPTED trace (consent APP, `policy_mode` 'customer_share',
  case = the complaint's label, 72 h) and answers `share` {trace_id,
  expires_at, interval_s 300}. The app starts `TraceSharingService` with a
  5-minute interval and no speed tests (new `intervalMs`/`speedTests`
  extras). Closing the complaint (`patch` status closed) ends it
  (`end_customer_share`, COMPLETED), and the phone stops on the next 409.
  The readings show in the complaint's customer phone card like any trace.
  SDK: `NetProblem.send(shareUntilFixed=)`, `Outcome.share`,
  `DeviceApi.reportProblem` returns the answer. Tests `tests_customer_share.py`.
- **"Help improve NTC's network"** (2026-10-29, app 1.3.0, the user's
  request, designed to be anonymous). Opt-in, off by default: asked once on
  the first start after install or update (`NetworkHelpPrompt.kt`, before
  registration) and a Settings tick box. SDK `collector/ScheduledReadings.kt`:
  readings around 00:00, 10:00, 14:00, 19:00 local, each at a random moment
  within 30 min (WorkManager, so Android may delay them); network, band,
  level, RSRQ, SINR and serving cell id read without a GPS fix; sent with the
  shared key only (a signed call is refused) under a random id renewed every
  30 days. Server `core/scheduled_readings.py`, model `ScheduledReading`
  (migration 0153; AI migrations now 0154-0159, local history renamed,
  table made from `sqlmigrate`): stores a hash of that id, the slot, the
  readings and only the site/sector of the cell (identity match, no
  position); 8 a day per id; kept 365 days. Summary
  `GET telemetry/scheduled-readings/?days=` (admin): per slot and technology
  average and weak/fair/good, and the weakest sites per slot; card "Readings
  by time of day" on Telemetry Coverage (admin, superadmin). Stops working
  if the shared telemetry key is retired. Tests `tests_scheduled_readings.py`.
  Committed and pushed 2026-10-29: dtwatch `f2e83bb` (+ handoff `0d853cb`),
  mobile `ec764bc` (app 1.3.0).
  **Map and rough area** (same day, app 1.3.1, built, NOT committed, not run
  on a phone). Map: `ScheduledReadingMapView`
  (`GET telemetry/scheduled-readings/map/?days=&slot=&tech=`, admin) and
  `ScheduledReadingsMap.tsx` in the card: hour and technology buttons,
  district filter, sectors as wedges at their site along the azimuth and
  rough-area squares, coloured by weak share; "Sectors in view" table.
  Rough area: only with location "Allow all the time"
  (ACCESS_BACKGROUND_LOCATION now in the app manifest, not the SDK's), asked
  after a yes to the readings (`NetworkHelpPrompt.offerArea`) and from a
  Settings button; the phone sends the centre of the 0.005-degree square
  (`ScheduledReadings.roughArea`), the server rounds again (`_area`, Nepal
  bounds only) into `area_lat/area_lng` (migration 0154; AI migrations now
  0155-0160, local history renamed, columns added by hand). A host app on
  Google Play must declare background location in Play Console.
- **Newest readings first, and the location card by session** (2026-10-29,
  built, NOT committed). Collections' readings endpoint returned the OLDEST
  2000 of a session (`order_by('ts')[:limit]`), so a long open session never
  showed its latest readings and disagreed with the diagnosis dashboard's
  last location. It now returns the newest `limit` in time order plus
  `total`; the Collections table lists newest first with "Showing the latest
  N of M"; Telemetry Drive Test's table shows the 50 newest, newest first;
  `sharing_periods` reads the newest readings. The diagnosis dashboard's last
  location (`_last_reading` in `core/subscriber_profile.py`, agreed with the
  user after a first session-only version): the NEWEST reading of any kind
  -- open or closed phone session, a reading outside any session, an
  accepted request or a share until fixed (TraceLocationSample) -- with a
  "From" line naming it; when an open session or open sharing exists but the
  newest reading is not from it, a "Still open" line gives that one's last
  reading (position under the same rules).

**Open items:**
- Deploy to prod (back up the database, pull, `docker compose build
  django frontend`, `docker compose up -d --remove-orphans`). The first
  maintenance run there prunes old audit rows and telemetry partitions.
- After that deploy: look at the two site photo web pages, and test the
  capture screen on the Huawei (compass direction against a known
  bearing first). Check free disk in prod's media folder.
- The four manuals were updated on 2026-10-11 for the admin closure, the
  in-container jobs and site photos; they have no site photo screenshots.
- Non-root containers: skipped by the user's decision.
- Before the prod deploy, check no cron job there already runs the
  maintenance commands.
- Mobile app screenshots for the manuals; newest APK on the Huawei and
  Redmi.
- Area Sample end-to-end test on prod with a real push.
- System Health page shows a blank "Telemetry roll-up" on prod; the local
  API returns a value. Waiting for the prod Network-tab response.
- `TelemetryConfig.pushTokenUrl` is set only in the local, uncommitted
  `DemoApplication.kt`.

**Done and pushed earlier** (as of commit `e427bf1`):
- Multi-role RBAC, System Health page, in-app current-state Documentation
  (`/api/v2/system-doc/`), unified Audit Log (replacing the old Access Log)
- Performance audit top-5 fixes: N+1 elimination + 500-row list caps on RF
  Reports/DT Sessions, 3 new `Sector` indexes, 60s cache on report
  endpoints + dashboard stats, env-var-driven Docker resource limits
- Telemetry live-samples delta-fetch (`since` param + `server_time`
  cursor) — map pages no longer remount on every 10s poll
- **Forgot/change password** (`core/password_reset.py`): email-based reset
  (anti-enumeration, rate-limited, self-invalidating token),
  logged-in change-password, `User.email` now editable in Users admin,
  new user-menu dropdown in `Layout.tsx` (replacing the old plain Sign Out
  button) with Change Password + Sign Out

- **MFA (TOTP), superadmin-togglable** (`core/mfa.py`, Phase C). `SecuritySettings`
  singleton (`mfa_required`), `User.totp_secret_encrypted`/`totp_enabled`,
  enroll/confirm/disable/status + login-time `MFAVerifyView` using a Redis
  `SETEX`+`GETDEL` pending ticket, same shape as `sso.py`'s login code.
  `LoginView.post()`'s tail extracted into `_finish_login()`, shared by
  both the no-MFA and post-verify paths. A user who has enrolled is
  challenged on every login regardless of the org-wide toggle; the toggle
  only forces enrollment for everyone else (`mfa_setup_required` flag on
  the login response). SSO users entirely untouched, by design.
- **VoLTE/VoNR call-quality estimation** (`core/volte_quality.py`,
  `VolteCallSample` model, `/api/telemetry/v1/volte-samples/` ingest +
  `/api/v2/telemetry/volte-samples/` admin list, seeded "VoLTE Quality"
  MenuItem under Telemetry). Server-side ITU-T G.107/G.107.1 E-model MOS
  estimator — narrowband AND wideband paths (AMR-WB needs the wideband
  scale, a genuinely different R0/formula, not just different constants).
  Three-tier codec coverage, `mos_is_provisional` flagging which tier a
  given row's estimate came from: **verified** (AMR-WB, G.711, G.729 —
  real cited ITU-T G.113 constants) vs **provisional** (EVS — real
  constants run through the wideband formula as a stand-in for the
  unverified fullband E-model; AMR-NB — no source at all, proxied via
  GSM-EFR) vs **unavailable** (no entry, or packet loss reported with no
  published robustness factor). Dormant until the mobile app has
  carrier-privileged status (`READ_PRECISE_PHONE_STATE` is a
  privileged/signature permission) — spec for the separate, inaccessible
  `netplanning-telemetry-sdk` repo lives in
  `docs/telemetry_pipeline_mobile_handoff.md`'s §12 addendum, not code
  here.
- **Attack-attempt detection + active IP blocking** (`core/audit.py`'s
  `_annotate_suspicious()` + `core/ip_block.py`, Phases E/E2). An IP with
  ≥3 failure-type access events (`login_failed`/`login_locked`/
  `sso_login_failed`) in a trailing 15 minutes — across potentially
  different usernames, a lower/different bar than the existing
  per-username 5-attempt lockout — gets flagged with a ⚠ badge on the
  Audit Log AND, for local login specifically, actually auto-blocked
  (`BlockedIP` model) before `authenticate()` runs on any further attempt.
  Superadmin-only "Blocked IPs" page to review/manually block/reverse a
  false positive — unblocking stamps who/when rather than deleting the
  row, so the correction stays visible. Found and fixed a real pre-existing
  bug while building this: `core/auth_log.py`'s `_client_ip()` trusted
  `X-Forwarded-For`'s first entry, which a client can forge (nginx
  *appends* via `$proxy_add_x_forwarded_for`, never replaces) — now
  prefers `X-Real-IP` (nginx-set from the TCP peer, unspoofable). Scope:
  local login only, not SSO — same boundary as MFA, for the same reason
  (Keycloak owns SSO's own brute-force posture).

**Deferred by the user — Auth security hardening, Phases D, F, G** (plan
file: `C:\Users\HP\.claude\plans\majestic-napping-stream.md` on the
machine this was planned on; summarized here so that file isn't
load-bearing):

- **Phase D — GeoIP on Audit Log.** `geoip2` + MaxMind GeoLite2 `.mmdb`
  (user supplies the license key later) — `core/geoip.py`, lazy reader,
  `None`/"Unknown location" fallback when the file is absent. Read-time
  lookup in `core/audit.py`'s row normalizers, no schema migration.
- **Phase F — Google reCAPTCHA v3 on login.** `SecuritySettings.recaptcha_enabled`
  + `RECAPTCHA_SITE_KEY`/`RECAPTCHA_SECRET_KEY` env vars. Inert when unset.
- **Phase G — SMS OTP, pluggable seam only (not wired).** NTC has an
  internal SMS API but integration details were never provided. Build
  `core/sms.py`'s `send_otp_sms()` dispatcher (`SMS_BACKEND` env var,
  default `ConsoleSMSBackend`, stub `NtcSmsBackend` placeholder),
  `User.mobile_number`, `SecuritySettings.sms_otp_enabled`. `MFAVerifyView`
  must be method-agnostic from the start so wiring in the real gateway
  later needs no rework.

Verification pattern for all of the above: `ast.parse` + `manage.py check`
after each phase; live Django-shell round-trip tests (token generation,
TOTP enroll+verify, ticket single-use); confirm GeoIP/reCAPTCHA degrade
correctly with no credentials present; full rebuild+redeploy
(`docker compose build <svc> && docker compose up -d <svc>`) before calling
any phase done.
