# Telemetry LLM Diagnostics — Implementation Plan

**Date:** 2026-09-10 · **Scope:** `dtwatch/` (Django + React + Postgres/PostGIS
stack). Companion to `TELEMETRY_LLM_DESIGN.md` (the architecture concept from the
GPU-server side). This document is the build plan against the code that actually
exists in this repo today.

## What this is

A self-hosted LLM that reads telemetry already stored in this stack and produces
root-cause diagnoses an O&M engineer can act on — correlating RF signal quality,
network alarms, and (where consented) rescue-location accuracy into one
explanation, instead of leaving the correlation to a human reading dashboards.

The model does **not** get raw log text. It gets a small set of query tools over
a read-only diagnostics API; a normal database does the filtering and
aggregation. This keeps the model's job to *deciding what to look up and what it
means*.

## Reality check against `TELEMETRY_LLM_DESIGN.md`

The design doc says "neither project has a telemetry data pipeline built yet."
That was true when the concept was written; it is not true of this repo now.
Verified against the current source (`backend-django/core/models.py`,
`docker-compose.yml`, `core/urls.py`), the following already exists and must
**not** be rebuilt:

| Capability | Where it lives now |
|---|---|
| Crowdsourced RF samples (rsrp/rsrq/sinr/rssi, rx_qual, rscp/ecio, cell_id, pci, tac, mcc/mnc, network_type, lat/lng + PostGIS `location`, region, pseudonymous device_id) | `TelemetrySample` → `v2_telemetry_samples`, monthly RANGE-partitioned by `received_at` (migration 0040) |
| Aggregated coverage (geohash-7 ≈ 150 m: rsrp mean/p10/min, rsrq_mean, sinr_mean, sample/device counts, per network_type + mnc + region) | `TelemetryCoverageBin` → `v2_telemetry_coverage_bins`, written by `prune_telemetry.py` on partition expiry, kept indefinitely |
| Drive-test RF (rsrp/rsrq/sinr/dl/pci, serving_site_id, serving_cell_name, serving_local_cell_id, serving_dist_km, rscp/ecno, serving/neighbor role) | `DriveTestSample` → `v2_dt_samples`, `DriveTestSession` |
| Rescue location (phone → last known location, opt-in, consent-policied, every read audit-logged) | `SubscriberLastLocation`, `RescueLocationAccessLog`, `RescueConsentPolicy`, flow in `core/rescue.py` |
| Site / sector inventory (4,718 sites, azimuth/tilt/PCI/height, per-tech KPI JSON, region) | `Site`, `Sector`; `KpiSnapshot`, `KpiThreshold` for KPI history + thresholds |
| Multi-source live site directory sync | `LiveSiteSource`, `LiveSiteSyncStatus`, `core/live_sites.py` |
| Ingestion auth, idempotency, rate-limit, retention | `core/telemetry.py` (ingest-key auth, content-hash `TelemetryBatch`), `telemetry-maintenance` / `telemetry-bin-roller` compose loops |

Cross-project correlation on `site_id` / `cell_id` is **already possible today**
between `TelemetrySample`, `DriveTestSample`, and `Site`.

### What is genuinely missing

1. **No alarm / fault stream.** The design doc's `alarm_code / alarm_severity /
   alarm_description` has no table. `KpiThreshold` / `KpiSnapshot` / `rf_audit.py`
   exist, but there is no live alarm feed. This is the real data gap — RCA needs
   "what alarmed, when, is it still active."
2. **No LLM layer of any kind** — no Ollama/vLLM client, no tool layer, no agent
   loop, no model config. Grep for `ollama|vllm|anthropic|openai` in
   `backend-*/` returns nothing real.
3. **No diagnostics / correlation API** that joins RF degradation ↔ rescue
   accuracy ↔ inventory in one place.
4. **Storage is plain Postgres + PostGIS with manual monthly partitioning**, not
   TimescaleDB. **Keep it that way** — the partition-drop retention path already
   works; a Timescale migration buys nothing here and risks the rescue/consent
   invariants.

Net: the data half of the design doc is ~80% done. The work concentrates on one
new model, one read-only API namespace, and one new service.

## Architecture decision

The design doc sketches a standalone `local-llm-telemetry/` Python folder reading
CSV/JSON. Because the data already lives in Postgres behind a service mesh, build
it as a **new service in this stack** instead:

```
  React "Diagnose"  ──▶  django  /api/v2/diag/ask   (thin proxy, JWT)
                                   │
                                   ▼
                         backend-llm/  (NEW — FastAPI)
                          ├─ agent.py   tool-calling loop
                          └─ tools.py   HTTP wrappers, service token
                            │                         │
                            ▼                         ▼
              django /api/v2/diag/*            OLLAMA_BASE_URL
              (NEW, read-only, RBAC)           (external GPU box)
                            │
                            ▼
                   existing Postgres / PostGIS
```

**Core decision: the agent's tools call Django, not the database directly.**

- One place keeps schema, PostGIS, and partition knowledge (`core/`), not two.
- The rescue-location consent check and `RescueLocationAccessLog` write in
  `core/rescue.py` are enforced for the LLM path automatically, because the LLM
  reaches that data only through a Django endpoint that already does both.
- `tools.py` becomes the *only* file that changes when the diag API evolves; the
  prompt, model, and serving stack are untouched. This mirrors the design doc's
  own "tool functions are the only code that changes" goal.
- The GPU box stays external and swappable: `backend-llm` only knows an
  OpenAI-compatible base URL.

The design doc's `--mock` prototype idea is kept, as an internal test mode of
`backend-llm` (scripted tool-call sequence, no live model) for CI and
wiring validation.

## New data model — `NetworkAlarm`

Add to `core/models.py`, migration in `core/migrations/`.

```
class NetworkAlarm(models.Model):
    SEVERITIES = [('critical','Critical'),('major','Major'),
                  ('minor','Minor'),('warning','Warning')]
    SOURCES   = [('nms','NMS feed'),('manual','Manual'),('derived','Derived from KPI')]

    site        = models.ForeignKey(Site, on_delete=models.CASCADE,
                                    related_name='alarms', null=True, blank=True)
    site_ref    = models.CharField(max_length=64, db_index=True, blank=True, default='')
    cell_id     = models.BigIntegerField(null=True, blank=True)   # bigint — NR NCI is 36-bit
    alarm_code  = models.CharField(max_length=64, db_index=True)
    severity    = models.CharField(max_length=12, choices=SEVERITIES)
    description = models.TextField(blank=True, default='')
    source      = models.CharField(max_length=12, choices=SOURCES, default='nms')
    raised_at   = models.DateTimeField(db_index=True)
    cleared_at  = models.DateTimeField(null=True, blank=True)     # null ⇒ still active
    raw         = models.JSONField(default=dict, blank=True)      # untouched source record
    received_at = models.DateTimeField(db_index=True)

    class Meta:
        db_table = 'v2_network_alarms'
        indexes = [
            models.Index(fields=['site', 'raised_at']),
            models.Index(fields=['severity', 'cleared_at']),
            models.Index(fields=['alarm_code']),
            models.Index(fields=['cleared_at'],
                         name='v2_alarm_active', condition=Q(cleared_at__isnull=True)),
        ]
```

Notes:

- Keep both `site` FK and `site_ref` string — alarms often arrive before the site
  directory has the referenced ID (same pattern `TelemetrySample.region` uses:
  server-derived, backfillable).
- Retention: follow the telemetry pattern. `received_at` can be the partition key
  if volume warrants it later; start unpartitioned, revisit if the NMS feed is
  chatty. A `prune_alarms.py` management command (cleared + older than N days →
  drop) mirrors `prune_telemetry.py`.

### Ingestion, cheapest first

1. **CSV / Excel importer** in the style of `core/site_import.py` — accept a
   Nokia NetAct / Huawei U2000 alarm export, whatever NT can produce. This is the
   only path needed to start.
2. **`POST /api/external/v1/alarms/`** — ApiKey-authenticated (`core/api_auth.py`),
   for a push feed if NT's NMS can do webhooks/scheduled POST. Add to
   `core/external_urls.py`.
3. **Derived alarms (stopgap).** Until a real NMS feed exists, a management
   command reads `KpiSnapshot` vs `KpiThreshold` breaches and writes
   `NetworkAlarm` rows with `source='derived'`. This gives the agent real signal
   to correlate against on day one. Clearly flagged as derived so a diagnosis can
   say so.

## New API — `/api/v2/diag/`

Read-only DRF views under `core/urls.py`, new module `core/diag.py`. Auth: JWT,
**superadmin/admin only** (`viewer` excluded). Operator-scoped users
(`User.operator_mncs` non-empty) get only their MNC slice — the filter pattern
already exists on `TelemetryCoverageBin.mnc` and in `TelemetryCoverageView`.

One endpoint per tool the model calls. Each response includes the exact time
window used and the row/sample counts it aggregated, so the agent can cite
evidence and the frontend can show it.

| Endpoint | Purpose | Reads |
|---|---|---|
| `GET /diag/site-health?site_id=&from=&to=` | Per-cell RF rollup: rsrp/rsrq/sinr mean + p10, sample counts, delta vs the preceding window of equal length | `TelemetrySample`, `DriveTestSample` |
| `GET /diag/alarms?site_id=&active=&severity=&from=&to=` | Alarm rows, newest first | `NetworkAlarm` |
| `GET /diag/rescue-quality?site_id=&from=&to=` | **Aggregates only** — mean/p50/p90 `accuracy_m`, gps vs cell-triangulation split, report count. Never individual rows. Consent-filtered. Writes `RescueLocationAccessLog`. | `SubscriberLastLocation` + consent tables |
| `GET /diag/neighbors?site_id=&radius_km=` | Adjacent sites/sectors by PostGIS distance — lets the agent tell "one cell" from "area-wide" | `Site`, `Sector` |
| `GET /diag/site-inventory?site_id=` | Sectors, azimuth/tilt/PCI/height, last KPI snapshot | `Site`, `Sector`, `KpiSnapshot` |
| `GET /diag/anomalies?region=&from=&to=&limit=` | Sites ranked by degradation over the window — the "what's worst right now" entry point | `TelemetryCoverageBin`, `TelemetrySample` |

Design rules:

- **Read-only.** No endpoint writes anything except `RescueLocationAccessLog`
  (an audit row, by design). The agent can never mutate state.
- **Bounded.** Every endpoint caps its window (max 30 days) and its result size.
- **Self-describing.** Response envelope: `{ data, window: {from, to}, counts:
  {...}, notes: [...] }`. `notes` carries caveats like "derived alarms only" or
  "coverage bins used — raw partition expired".
- Register the routes **before** the `sites/<pk>/` router include, same
  precedence note as `sites/search/` in `core/urls.py`.
- Add to the drf-spectacular schema (`/api/v2/schema/`) so the tool wrappers can
  be generated/checked against it.

## New service — `backend-llm/`

New top-level directory, new `Dockerfile`, new `docker-compose.yml` service.
Python + FastAPI (matches the design doc's prototype; keeps `tools.py` / `agent.py`
names so that prototype maps 1:1).

```
backend-llm/
  Dockerfile
  pyproject.toml            # fastapi, httpx, openai (client only), pydantic
  app/
    main.py                 # POST /diagnose  {question, site_id?, window?}
    agent.py                # OpenAI-compatible tool-calling loop
    tools.py                # httpx wrappers over /api/v2/diag/*  (+ service token)
    prompts.py              # system prompt, tool schemas
    mock.py                 # scripted tool sequence, no live model  (--mock / MOCK=1)
  tests/
    test_mock_scenario.py   # runs mock against the seeded fault, asserts the RCA
```

- **`tools.py`** — one function per diag endpoint, same names as the design doc
  (`summarize_site_health`, `query_active_alarms`,
  `query_emergency_location_reports`, plus `query_neighbors`,
  `query_site_inventory`, `query_anomalies`). Each does one authenticated GET and
  returns the JSON envelope. A short-lived **service JWT** (dedicated
  `role='admin'`, non-login service account, or a signed service token verified
  by a small custom permission) — not a real user's token.
- **`agent.py`** — tool-calling loop against `OLLAMA_BASE_URL` (OpenAI-compatible
  `/v1/chat/completions`). System prompt: O&M RCA assistant; decide which tool to
  call next; conclude only when the evidence supports it; always return the
  windows and counts each claim rests on. Hard cap on tool-call iterations
  (e.g. 12) and total wall-clock.
- **Output contract:**
  `{ diagnosis, confidence: "high|medium|low", evidence: [{claim, source, window,
  counts}], tools_called: [...], model, elapsed_ms }`.
- **`--mock` mode** — replays a fixed tool sequence and composes the same output
  envelope, no LLM needed. This is the CI gate and the "is the wiring right"
  check before the GPU box exists.

### compose service

```yaml
  backend-llm:
    profiles: ["future"]          # same parking pattern as node-gateway / go-worker
    build: ./backend-llm
    restart: unless-stopped
    env_file: [./.env]
    environment:
      DIAG_API_URL:        http://django:8000/api/v2/diag
      DIAG_SERVICE_TOKEN:  ${DIAG_SERVICE_TOKEN}
      OLLAMA_BASE_URL:     ${OLLAMA_BASE_URL}      # http://<gpu-box>:11434/v1
      LLM_MODEL:           ${LLM_MODEL}            # e.g. the pulled Ollama tag
      LLM_MAX_TOOL_CALLS:  "12"
    depends_on:
      django: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "python", "-c",
             "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8100/health').status==200 else 1)"]
      interval: 10s
      timeout: 5s
      retries: 5
```

Internal port 8100, no `ports:` published (same port-hiding pass as every other
backend service). Reached only via the Django proxy below.

### Django proxy — `/api/v2/diag/ask`

One view in `core/diag.py`: JWT-auth (superadmin/admin), forwards
`{question, site_id, window}` to `backend-llm`'s `/diagnose`, streams or relays
the result. Keeps the frontend on one origin + one auth contract, and means the
React app never talks to `backend-llm` directly. nginx already proxies `/api/` →
`django:8000`, so no nginx change.

### build-push.sh

`build-push.sh`'s `COMPONENTS` array lists four contexts
(`backend-django:django`, `backend-node:node-gateway`, `backend-go:go-worker`,
`frontend-react:frontend`). Adding `backend-llm:llm-agent` to that array is the
only change needed for the image to build/tag/push with the rest. Note the same
comment in the script already anticipates "FOUR build contexts" — update that
count.

## Serving stack

Follow the design doc: **Ollama now, vLLM when concurrency demands it.**

1. On the GPU box (24 GB+ VRAM): install Ollama, `ollama serve`, pull the chosen
   model, Q4_K_M, configure for long context (~64K).
2. Point `backend-llm` at `http://<gpu-box>:11434/v1` via `OLLAMA_BASE_URL`.
3. Move to vLLM only once more than one or two engineers — or an automated
   alarm-triage job — issue diagnoses concurrently. Ollama has no continuous
   batching; requests queue. vLLM's API is OpenAI-compatible too, so the switch
   is `OLLAMA_BASE_URL` → the vLLM endpoint and nothing in `tools.py` or
   `agent.py` changes.

> **Model-name caveat.** The design doc names "Qwen3.6 27B (Reasoning)", "Qwen3.6
> 35B-A3B", "Gemma 4 31B", and benchmark figures (TAU2 94.2, Intelligence Index
> 45.8). These could not be verified — the exact tags may not exist in the Ollama
> library under those names. **Before committing, check the current Ollama
> library and pick the strongest actually-available model in the 24 GB VRAM class
> that supports tool calling and ~64K context.** The architecture here does not
> depend on which model wins — `LLM_MODEL` is one env var.

## Privacy & RBAC constraints (non-negotiable)

These are the invariants the rest of the stack already enforces; the LLM path
must not weaken them.

- **Rescue-location data never reaches the model as rows.** The
  `/diag/rescue-quality` endpoint returns only aggregates (means, percentiles,
  counts), filtered by the active `RescueConsentPolicy`, and writes a
  `RescueLocationAccessLog` row for every call. Enforced in the endpoint, not in
  the prompt.
- **`viewer` role gets no diagnostics access at all.** Superadmin/admin only.
- **Operator-scoped users** (`operator_mncs`) see only their MNC slice, on every
  diag endpoint — reuse the existing `TelemetryCoverageBin.mnc` filter.
- **The agent cannot write.** All tools are GET; no tool touches a mutating
  endpoint. The service token is scoped to `/api/v2/diag/*` only.
- **Diagnoses are advisory.** Output always carries `confidence` and `evidence`;
  nothing is auto-actioned. A future WS "diagnosis ready" push (node-gateway) is
  a notification, not an action.
- **No subscriber identity, ever.** `TelemetrySample` has no IMEI/MSISDN column
  by design; the diag API exposes nothing that could re-identify a device.

## Phased delivery

**Phase 1 — Alarm data**
- [ ] `NetworkAlarm` model + migration + `admin.py` registration
- [ ] CSV/Excel importer (`site_import.py` style) + a management command
- [ ] `POST /api/external/v1/alarms/` (ApiKey auth)
- [ ] Derived-alarm command from `KpiSnapshot` × `KpiThreshold` (stopgap signal)
- [ ] `prune_alarms.py` + wire into `telemetry-maintenance` loop (or its own)

**Phase 2 — Diagnostics API**
- [ ] `core/diag.py` with the six read-only endpoints + envelope
- [ ] RBAC: superadmin/admin gate + `operator_mncs` scoping
- [ ] Rescue-quality endpoint: aggregates only, consent filter, access-log write
- [ ] drf-spectacular annotations; routes registered before `sites/<pk>/`
- [ ] `tests_diag.py` — window bounds, RBAC, rescue aggregation, envelope shape

**Phase 3 — Agent service**
- [ ] `backend-llm/` scaffold (FastAPI, `tools.py`, `agent.py`, `prompts.py`)
- [ ] `--mock` mode + `test_mock_scenario.py`
- [ ] `Dockerfile` + compose service (`profiles: ["future"]`, port 8100)
- [ ] Service token mechanism (service account or signed token + permission)
- [ ] `/api/v2/diag/ask` proxy view in Django
- [ ] Add `backend-llm:llm-agent` to `build-push.sh` `COMPONENTS`

**Phase 4 — Real model**
- [ ] Stand up Ollama on the GPU box; pick + pull the model; set `LLM_MODEL`
- [ ] Point `backend-llm` at it; run `--question` mode against the seeded scenario
- [ ] Tune system prompt / tool descriptions against real output
- [ ] Load/latency check → decide Ollama vs vLLM

**Phase 5 — Surface in the app**
- [ ] "Diagnose" action on the site-detail and alarm views (React)
- [ ] Stream reasoning + final RCA with evidence links
- [ ] (optional) node-gateway WS push: "new critical alarm → diagnosis ready"

## Validation scenario

Reuse the design doc's injected fault so there is a known-good answer before real
data exists. A `seed_synthetic_telemetry` management command writes, into the
real tables (not CSVs):

- One site (e.g. a real `KTM-*` ID) develops rising VSWR / falling SINR across a
  simulated day in `TelemetrySample` and `DriveTestSample`.
- A `critical` `NetworkAlarm` (`RF-VSWR-HIGH`, `source='derived'` or `'manual'`)
  raised partway through that day.
- `SubscriberLastLocation` rows for that site's cell showing degraded
  `accuracy_m` over the same window (so `/diag/rescue-quality` corroborates).

Pass condition: the agent (mock first, then real model) calls `site-health` →
`alarms` → `rescue-quality` (± `neighbors`), and concludes an antenna/feeder
fault at that site rather than a capacity problem, citing the three windows.

## Open questions for NT / O&M

1. What can NT's NMS actually export for alarms — format, cadence, push vs pull?
2. Are VSWR / PRB utilisation / CPU load / temperature available per cell
   anywhere, or is RF signal (rsrp/rsrq/sinr) the only quantitative input? The
   diag `site-health` schema has slots for them but nothing populates them yet.
3. GPU box specs and network path from the compose host — latency budget for a
   multi-tool diagnosis.
4. Who is allowed to run a diagnosis — all admins, or a named subset? (Affects
   whether the service token is one account or per-user pass-through.)

## File-by-file change summary

| File | Change |
|---|---|
| `backend-django/core/models.py` | + `NetworkAlarm` |
| `backend-django/core/migrations/00xx_*.py` | + `NetworkAlarm` table + indexes |
| `backend-django/core/admin.py` | register `NetworkAlarm` |
| `backend-django/core/diag.py` | **new** — six read-only diag views + `/ask` proxy |
| `backend-django/core/urls.py` | mount `diag/*` before `sites/<pk>/` |
| `backend-django/core/external_urls.py` + `external_api.py` | + `alarms/` POST |
| `backend-django/core/site_import.py` (or new `alarm_import.py`) | alarm CSV/Excel importer |
| `backend-django/core/management/commands/` | `import_alarms`, `derive_alarms`, `prune_alarms`, `seed_synthetic_telemetry` |
| `backend-django/core/tests_diag.py` | **new** |
| `backend-llm/` | **new service** — FastAPI agent + tools + mock + Dockerfile |
| `docker-compose.yml` | + `backend-llm` service (`profiles: ["future"]`) |
| `docker-compose.deploy.yml` | + `backend-llm` deploy override |
| `build-push.sh` / `build-push.ps1` | + `backend-llm:llm-agent` component |
| `.env.example` | + `OLLAMA_BASE_URL`, `LLM_MODEL`, `DIAG_SERVICE_TOKEN`, `LLM_MAX_TOOL_CALLS` |
| `frontend-react/src/` | "Diagnose" action + RCA panel (Phase 5) |
| `docs/RUNBOOK.md` | add `backend-llm` to the service table + "Service contracts" |
