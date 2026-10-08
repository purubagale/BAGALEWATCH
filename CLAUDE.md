# DT-WATCH BTS v2 — Project Brief

> Generated 2026-10-02, last updated 2026-10-08. This file is the fast-load orientation doc for this
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
| Deployment | Docker Compose, 10 services (see below) |

## Repo layout

```
backend-django/core/*.py       One file per feature area (not MVC folders) —
                                e.g. password_reset.py, audit.py, rf_reports.py,
                                telemetry_admin.py, roles.py, sso.py. models.py
                                holds every model; serializers.py every
                                serializer; urls.py wires it all together.
backend-django/core/migrations/  113 migrations as of 0113. Numbered sequentially,
                                  no squashing.
frontend-react/src/pages/*.tsx  51 pages, one per route. Most are React.lazy()
                                 imported in App.tsx except Login/Sites/Dashboard
                                 (the pages nearly every session hits immediately).
frontend-react/src/api/
  client.ts                     apiFetch/apiJson, token storage (sessionStorage),
                                 ApiError, apiErrorMessage()
  queries.ts                    Every React Query hook, grouped by feature
  types.ts                      Every TS interface for API payloads
docker-compose.yml               10 services: db, redis, django, frontend,
                                  site-sync, telemetry-maintenance,
                                  telemetry-bin-roller, audit-log-maintenance,
                                  node-gateway (profile: future, unused),
                                  go-worker (profile: future, unused)
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
  Desktop as `dtwatchTelemetry.apk`.
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
deployed through `644cfc0`; everything later, including migrations
0111-0113, still has to be pulled and migrated there by the user.

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

**Do not build** "ping to discover" in the form of silent registration,
registration without a number, or server-triggered location of an
identified device. It was declined; Area Sample is the agreed
replacement.

**Open items:**
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
