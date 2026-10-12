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
  DemoApplication.kt google-services.json *.apk hs_err_pid*.log`. Check
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
  not been seen running. After deploy, update the manuals and both decks:
  the Viewer Manual still says viewers see site photos.
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
  always marked planned with a dashed border. Do not build it until
  asked.
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

**Do not build** "ping to discover" in the form of silent registration,
registration without a number, or server-triggered location of an
identified device. It was declined; Area Sample is the agreed
replacement.

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
