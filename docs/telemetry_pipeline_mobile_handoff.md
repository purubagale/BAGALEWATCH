# DT-WATCH Telemetry Ingestion Pipeline — Mobile Integration Guide

**For:** the mobile app developer integrating drive-test / crowdsourced network telemetry with DT-WATCH
**Owner (backend/web):** Puru
**Last updated:** 2026-09-21

## 1. What this document covers

DT-WATCH already has a working, deployed backend pipeline for receiving network-quality
samples (GPS position + serving-cell + signal metrics) from subscriber devices. This is a
**separate surface from the DT-WATCH web app's own API** — it is public-internet-facing,
authenticated by a simple API key (not a user login), and designed for high-volume,
unattended background uploads from a phone.

This document is everything the mobile app needs to integrate against it: authentication,
every endpoint, exact request/response payloads, the sample data model, consent and
opt-out handling, rate limiting, and a working reference Android SDK that already
implements most of the client side.

Out of scope here: the DT-WATCH admin/web app's own JWT-authenticated API
(`/api/v2/telemetry/...`), which is for DT-WATCH staff to view coverage maps, manage keys,
and run drive-test sessions — the mobile app never calls that surface directly.

## 2. Base URL

All endpoints in this document are mounted under:

```
/api/telemetry/v1/
```

on the DT-WATCH Django backend. Ask Puru for the actual host/port for your target
environment (dev/staging/production) — the mobile app talks to the Django backend
directly, not through a reverse proxy path.

## 3. Authentication

Every endpoint on this surface (except `/health/`) requires a **Telemetry Ingest Key** —
a credential type separate from DT-WATCH user logins and separate from the partner
data-exchange API key. It exists specifically so a compromised or throttled telemetry
key can never touch anything else in the system.

- **Format:** `tel_<48 hex chars>`, e.g. `tel_a1b2c3...` — shown once, at creation, by a
  DT-WATCH superadmin. It cannot be retrieved again; losing it means issuing a new one.
- **How to send it**, either header works:
  - `Authorization: Bearer tel_<key>` (this is what the reference SDK uses)
  - `X-API-Key: tel_<key>`
- **Getting a key:** ask Puru to generate one from the DT-WATCH admin panel
  (`TelemetryIngestKey`). Each key has its own name, an optional expiry, and its own
  rate limit (see §7), so a dev/staging key and a production key should be separate keys.
- Keys can be deactivated instantly by an admin if a build is compromised or misbehaving.

## 4. Endpoints

### 4.1 `POST /api/telemetry/v1/samples/` — upload a batch of readings

This is the one endpoint that matters for day-to-day operation: the app collects samples
locally and periodically uploads them in a batch.

**Request:** a JSON array of sample objects (see §5 for the exact fields). Not an object,
not a single sample — always an array, even for one sample.

```json
[
  {
    "device_id": "3f9a1c2e-...-uuid",
    "ts": 1758444000000,
    "lat": 27.7172,
    "lon": 85.3240,
    "gps_accuracy_m": 12.5,
    "cell_id": 123456,
    "pci": 301,
    "tac": 4501,
    "mcc": "429",
    "mnc": "01",
    "network_type": "LTE",
    "rsrp_dbm": -95,
    "rsrq_db": -10,
    "rssi_dbm": null,
    "sinr_db": 12,
    "rx_qual": null,
    "rscp_dbm": null,
    "ecio_db": null,
    "cqi": 9,
    "battery_pct": 76,
    "trigger_reason": "periodic"
  }
]
```

**Limits:** up to 2000 samples per request. The reference SDK batches at 200 — any batch
size up to the 2000 cap is fine, 200 is just what the sample client happens to use.

**Responses:**

| Status | Body | Meaning |
|---|---|---|
| 202 | `{"accepted": N, "opt_out": bool}` | Batch stored. `opt_out: true` means the backend has a pending remote opt-out request for one of the devices in this batch — see §8.2, the app **must** act on this. |
| 200 | `{"accepted": 0, "duplicate": true}` | This exact batch was already received before (see §6, idempotency) — treat as success, do not retry. |
| 400 | `{"detail": "..."}` | Malformed body (not an array, missing/invalid `device_id` or `ts` on some sample, etc). |
| 401 | `{"detail": "invalid or missing telemetry ingest key"}` | Bad or missing key. |
| 413 | `{"detail": "max 2000 samples per request"}` | Batch too large — split it. |
| 429 | `{"detail": "rate limit exceeded"}` | Too many batches this minute for this key (§7) — back off and retry later. |

### 4.2 `GET /api/telemetry/v1/health/` — liveness probe

No auth required. Returns `{"status": "ok", "service": "telemetry-ingest", "time": "<iso8601>"}`.
Use this to confirm the endpoint is reachable before queueing real uploads against it —
useful for a first-run connectivity check or a status screen.

### 4.3 `POST /api/telemetry/v1/rescue-enroll/` — optional: emergency-locator opt-in

Only relevant if the app also implements the rescue-beacon feature (a subscriber opts in
to sharing their last known location for search-and-rescue use). Not required for basic
telemetry/coverage collection — skip this section if that feature isn't in scope for your
build.

**Request:**
```json
{ "device_id": "<raw device id, same string used for samples>", "consent": true, "msisdn": "+977..." }
```
`msisdn` is required when `consent: true` (must look like a phone number: digits, spaces,
`+`/`-`, 7–20 chars). To withdraw, send `{"device_id": "...", "consent": false}` — the
`msisdn` field isn't needed for withdrawal.

**Response:** `{"enrolled": true}` on enroll, or `{"enrolled": false, "removed": bool}` on
withdrawal (`removed` is normally true; see the backend note below on a rare
emergency-override case where withdrawal is "soft" instead of erasing the record — that's
a backend-policy detail the app doesn't need to branch on, just always send `consent`
truthfully and read `enrolled`).

Note: this is the **only** place in the whole pipeline where the app sends its raw,
un-hashed device id together with a real phone number — because the device itself is the
one making that link, at the moment its own subscriber opts in.

### 4.4 `POST /api/telemetry/v1/drive-test-consent/` — optional: per-device drive-test flag

Only relevant for a session-scoped "drive test" feature where DT-WATCH staff run a
time-boxed data-collection session and want only consenting devices' samples visible in
that session's view. This flag has **no effect on whether samples are stored at all** —
regular ingestion via §4.1 is unaffected either way. Skip this if your build doesn't need
session-level consent gating.

**Request:** `{ "device_id": "<raw device id>", "consent": true }`
**Response:** `{"consent": true}` (echoes back the flag now on file). A device can flip
this at any time; a later-viewed session reflects the change immediately.

### 4.5 `GET /api/telemetry/v1/drive-test-consent-message/` — optional: fetch consent copy

Returns `{"message": "<current consent text>"}` — lets the app display centrally-editable
consent wording (managed by a DT-WATCH superadmin) instead of hardcoding copy that would
need a new app release to change. Purely optional — the app is equally free to hardcode
its own wording and never call this.

## 5. Sample fields (`TelemetrySample`)

Only `device_id` and `ts` are required. Every other field degrades to `null`/omitted
rather than failing the whole batch — a batch of 200 samples should not be rejected
because one optional field on one sample is bad.

| Field | Type | Notes |
|---|---|---|
| `device_id` | string | **Required.** A locally generated pseudonymous ID (e.g. a UUID) — never IMEI, Android ID, or MSISDN. The backend one-way-hashes this before storage; it can never be reversed back to your raw value. Use the *same* raw value consistently per device (needed for accurate distinct-device counts) but never a subscriber-identifying value. |
| `ts` | integer (epoch ms) | **Required.** When the reading was taken, on-device clock. |
| `lat`, `lon` | float | GPS position. Note the wire field is `lon`, not `lng` (the backend stores it as `lng` internally, but the JSON key it accepts is `lon`). |
| `gps_accuracy_m` | float | GPS fix accuracy in meters. |
| `cell_id` | integer | Serving cell ID. Use a 64-bit-safe integer type client-side — 5G NR's cell identifier (NCI) is 36-bit and won't fit in a 32-bit int. |
| `pci` | integer | Physical Cell ID. |
| `tac` | integer | Tracking Area Code (LTE/NR) / Location Area Code (2G/3G). |
| `mcc`, `mnc` | string | Mobile Country/Network Code of the serving cell. |
| `network_type` | string | One of `LTE`, `NR`, `UMTS`, `GSM`, `UNKNOWN`. Anything else is coerced to `UNKNOWN` server-side. |
| `rsrp_dbm`, `rsrq_db`, `sinr_db` | integer | **LTE/NR only.** Leave `null` on 2G/3G. |
| `rssi_dbm` | integer | Populated on GSM/UMTS (and usable as a general signal-strength fallback); not the metric to use for LTE/NR quality — use RSRP/RSRQ/SINR there. |
| `rx_qual` | integer | **GSM only** — RxQual class, 0–7 (3GPP TS 45.008/27.007 §8.5). |
| `rscp_dbm`, `ecio_db` | integer | **WCDMA (3G) only.** Only obtainable on Android 10+ (API 29+) devices — send `null` below that. |
| `cqi` | integer | **LTE/NR only.** Channel Quality Indicator, 0–15, higher is better. |
| `battery_pct` | integer | Device battery %, 0–100. |
| `trigger_reason` | string | One of `periodic`, `handover`, `manual`. Anything else is coerced to `periodic`. |

Notes:
- RSRP/RSRQ/SINR/CQI alone aren't meaningful for 2G/3G radios — that's why `rx_qual` (GSM)
  and `rscp_dbm`/`ecio_db` (WCDMA) exist as their proper standard-defined equivalents,
  rather than trying to force 2G/3G readings into the LTE/NR fields.
- Any JSON keys beyond this set are silently ignored (data minimization — the backend only
  ever accepts this exact metric set, by design, and has no field at all for IMEI /
  Android ID / MSISDN).

## 6. Idempotency (safe retries)

The backend computes a content hash over the batch (`device_id` + `ts` of every sample in
it) and remembers it. If your upload worker retries the exact same batch after a network
failure or a non-2xx response, the retry comes back `200 {"accepted": 0, "duplicate": true}`
instead of inserting duplicates. Practically: **retry a failed batch by resending the
identical unmodified array** — don't reconstruct or reorder it, or the hash (and the
dedupe) won't match.

## 7. Rate limiting

Each ingest key has its own per-minute batch-count limit (`rate_limit_per_min`, default
600/minute — plenty for normal use; ask Puru if a specific key needs a different value).
Exceeding it returns `429`. There's no documented "retry-after" header — back off and
retry on your own schedule (the reference SDK relies on WorkManager's exponential backoff
for this).

## 8. Consent & privacy model

### 8.1 What the backend guarantees
- The backend never stores anything that could resolve to a subscriber identity. There is
  no IMEI/Android-ID/MSISDN column anywhere in the sample pipeline.
- `device_id` is one-way hashed (salted SHA-256) the moment a batch is received — even
  someone with full database access cannot recover your raw device id from it.
- The one narrow exception is the rescue-beacon feature (§4.3), where the *device itself*
  deliberately links its id to a phone number, only when its own subscriber opts in.

### 8.2 Remote opt-out — the one thing the app must implement
The backend has **no way to directly flip a device's local opt-in flag** — that flag only
lives on the device. What it *can* do is leave a "please opt this device out" request
(e.g. a DT-WATCH admin ending a drive-test session and choosing "end & opt out"). The way
this reaches the device is entirely through the ingest response:

> Every `POST /samples/` response includes `"opt_out": true|false`. When the app sees
> `opt_out: true`, it must stop collecting/uploading for that device (flip its own local
> opt-in flag off) on that same upload cycle.

This is a one-shot instruction, not a standing rule — if the subscriber opts back in
later, they aren't immediately re-opted-out by a stale request.

**Important gap to know about:** the bundled reference SDK (§9) does **not** currently
read the response body at all — it only checks the HTTP status code. Reading and acting
on `opt_out` needs to be added; it's a small change (parse the JSON response in
`TelemetryApi.uploadBatch`, call the local opt-out) but it is not done yet in the sample
code, despite older code comments assuming it is. Flagging this explicitly so it isn't
missed.

## 9. Reference Android SDK — a real starting point, not just a spec

There is already a working (unbuilt/unverified, but carefully written and reviewed)
Android library module for this exact pipeline: **`netplanning-telemetry-sdk`**. It was
built for an earlier pilot and already implements most of the client-side plumbing this
integration needs. I'm attaching/sharing it — start from this rather than from scratch.

### 9.1 What it already does
- Reads serving-cell ID/PCI/TAC/MCC-MNC/RSRP/RSRQ/RSSI/SINR via `TelephonyManager`, plus a
  one-shot GPS fix via `FusedLocationProviderClient` (not a continuous lock).
- Samples on two triggers: a periodic WorkManager tick (15-minute floor — Android's own
  `PeriodicWorkRequest` enforces this) and an event-triggered sample on cell/signal change
  while the app is alive (throttled, default once per 60s).
- Queues samples locally (flat JSONL file) and flushes them in batches of 200 on its own
  schedule, Wi-Fi-only by default.
- Enforces its own opt-in gate at the collection layer (`NetTelemetry.optIn()`/`optOut()`)
  — collection refuses to run at all if the stored flag is off, regardless of what calls it.
- Generates and stores the pseudonymous device id itself (`DeviceIdentity`, in
  `EncryptedSharedPreferences`) — you don't need to build this part.

### 9.2 Public API surface (this is the entire integration surface for the host app)
```kotlin
NetTelemetry.init(context, TelemetryConfig(endpointUrl = "...", apiKey = "tel_..."))  // call from Application.onCreate(), NOT an Activity
NetTelemetry.optIn()      // wire to your consent screen's "agree" action
NetTelemetry.optOut()     // wire to "withdraw" / settings toggle
NetTelemetry.isOptedIn()
NetTelemetry.getStatus()  // queued sample count, last sample time — for a status/debug screen
NetTelemetry.sampleNow()  // optional manual "check my signal now" trigger
```
`TelemetryConfig.endpointUrl` should be set to
`https://<your-dtwatch-host>/api/telemetry/v1/samples/`, and `apiKey` to the `tel_...` key
Puru issues you.

The **init-from-`Application.onCreate()`** requirement matters: WorkManager can and will
run the sampling/upload workers after Android has killed and relaunched the app's process
in the background. If `init()` only ran once inside an Activity, it's a no-op after that.

### 9.3 Required permissions (already declared in the module's manifest)
`ACCESS_FINE_LOCATION` (required), `READ_PHONE_STATE` (defensive, some OEMs gate cell info
behind it), `ACCESS_NETWORK_STATE`, `INTERNET`. The host app must request
`ACCESS_FINE_LOCATION` through its own runtime-permission flow before calling `optIn()` —
the SDK checks for the permission and just returns no sample if it's missing; it does not
prompt for permissions itself.

`ACCESS_BACKGROUND_LOCATION` is deliberately left out/commented — declaring it requires
Play Console justification. Without it the SDK still works whenever the app is foregrounded
or recently backgrounded; decide with your own team whether background-location approval
is worth pursuing for more reliable long-backgrounded sampling.

### 9.4 Known gaps between this SDK and the current backend (fill these in)
The SDK was written before a few backend fields/behaviors existed. Concretely, before
building against it:

1. **Missing fields in `Sample.kt` / `CellSampleCollector.kt`:** `rx_qual`, `rscp_dbm`,
   `ecio_db` (2G/3G metrics, §5) and `cqi` (LTE/NR) aren't collected or serialized yet —
   add them to `Sample`, populate them in `CellSampleCollector.parseCellInfo()` from the
   corresponding `CellSignalStrengthGsm`/`CellSignalStrengthWcdma`/`CellSignalStrengthLte`
   APIs, and include them in `toJson()`.
2. **`opt_out` response handling isn't implemented** — see §8.2 above. `TelemetryApi.
   uploadBatch()` currently only checks the HTTP status; it needs to parse the JSON body
   and call `NetTelemetry.optOut()` locally when `opt_out: true` comes back.
3. **Rescue-enroll and drive-test-consent (§4.3/§4.4) have no client calls yet** — only
   needed if your build uses those features; otherwise skip them.
4. This SDK was never compiled (written in an environment with no Android SDK/emulator
   access) — treat it as a solid, reviewed starting point, not a drop-in verified library.
   Building it in a real Android Studio project on a couple of real devices should be the
   first thing done with it.

### 9.5 What's deliberately NOT in the SDK
No UI (consent screens, a signal-quality view) — that's the host app's job. No iOS build
— iOS's CoreTelephony doesn't expose cell ID/signal metrics to third-party apps at all, so
there's no iOS equivalent of the RF-detail collection; an iOS build could still contribute
GPS + coarse network-generation status if that's ever wanted.

## 10. Quick start checklist

1. Ask Puru for: a `tel_...` ingest key, and the real base URL for your target environment.
2. Confirm reachability: `GET /api/telemetry/v1/health/` (no auth needed).
3. Drop in `netplanning-telemetry-sdk` (§9), call `NetTelemetry.init()` from
   `Application.onCreate()` with your endpoint + key.
4. Wire your consent UI to `optIn()`/`optOut()`; request `ACCESS_FINE_LOCATION` first.
5. Fill the gaps in §9.4 (new fields, `opt_out` response handling) before real rollout.
6. Send a real test batch, confirm `202 {"accepted": N, ...}`, and check with Puru that
   the samples show up in the DT-WATCH admin's telemetry coverage/live-samples view.
7. Only implement §4.3/§4.4 if the rescue-beacon or session-consent features are in scope
   for this build.

## 11. Who to ask

Backend/API questions, ingest keys, and confirming data is landing correctly: Puru (owns
the DT-WATCH backend/web app going forward). This document reflects the pipeline as
deployed on 2026-09-21; if the backend adds fields or endpoints later, treat this as a
snapshot, not a live spec — ask before assuming.
