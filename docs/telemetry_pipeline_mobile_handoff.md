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

### 4.6 `POST /api/telemetry/v1/volte-samples/` — optional: VoLTE/VoNR call-quality upload

**Added 2026-10-02. Not implemented in the reference SDK yet — see §12 for the full
addendum (why this requires carrier-privileged app status, which Android API to use, and
the complete field reference).** Same auth as §4.1 (`Authorization: Bearer tel_<key>` or
`X-API-Key`), same JSON-array-of-objects shape, same 2000-per-request cap.

```json
[
  {
    "device_id": "3f9a1c2e-...-uuid",
    "ts": 1758444000000,
    "network_type": "LTE",
    "codec": "AMR-WB",
    "call_duration_s": 42,
    "packet_loss_pct": 0.5,
    "jitter_ms": 8,
    "rtt_ms": 60,
    "quality_level": "GOOD",
    "lat": 27.7172,
    "lon": 85.3240,
    "cell_id": 123456,
    "pci": 301,
    "mcc": "429",
    "mnc": "01"
  }
]
```

**Responses:** `202 {"accepted": N}` on success; `400`/`401`/`413` same meanings as §4.1.
No `opt_out`/duplicate-detection handling on this endpoint (see §12 for why).

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
5. **VoLTE/VoNR call-quality collection (§4.6) isn't implemented at all** — not a gap in
   an existing feature, a whole feature not yet started. Blocked on a real external
   prerequisite (carrier-privileged app status), not just unwritten code — see §12 for the
   full addendum before starting this one.

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

## 12. VoLTE/VoNR call-quality addendum (2026-10-02)

The backend's `/volte-samples/` endpoint (§4.6) and its server-side ITU-T G.107 E-model
MOS estimator are built and live. **Nothing on the SDK side exists yet** — this section is
the complete spec for whoever implements it, not a description of working code.

### 12.1 Blocking prerequisite: carrier-privileged app status

Real VoLTE call-quality metrics come from Android's `CallQuality` API, which requires the
`READ_PRECISE_PHONE_STATE` permission. **This is a privileged/signature permission a normal
Play Store app cannot just request and have granted** — it is restricted to apps with
carrier privileges (a certificate relationship tied to the SIM/carrier config) or
system/privileged apps. Getting this app carrier-privileged status is an NTC-internal
provisioning process, not an app-code change — **do not start building §12.2 below until
that status is confirmed to exist for your build**, since the collection code is silently
inert without it (the permission check simply fails; there is no error to debug).

### 12.2 What to collect, and which Android API

- Register `TelephonyCallback.CallAttributesListener` (API 31+) or, for API 29–30,
  `PhoneStateListener` with `LISTEN_CALL_ATTRIBUTES_CHANGED` set — both deliver a
  `CallQuality` object during an active call.
- At call end, read from the last-received `CallQuality`: downlink/uplink packet loss,
  jitter, round-trip time, codec, and the call's overall `CallQuality.Level` enum
  (`EXCELLENT`/`GOOD`/`FAIR`/`POOR`/`BAD`/`NOT_AVAILABLE`).
- **Do not compute a MOS value on-device.** Send the raw metrics; the backend computes the
  estimate (see §12.4 for why) — sending a client-computed MOS would just be ignored, the
  `/volte-samples/` endpoint has no field for one.
- Send the captured metrics as one `POST /api/telemetry/v1/volte-samples/` call per
  completed call, using the exact field names in §4.6's example payload. Note the field
  name differences from §4.1's RF-sample payload: `codec` (string), `packet_loss_pct`
  (0–100 float), `jitter_ms`/`rtt_ms` (float, milliseconds), `quality_level` (the raw
  Android enum string, sent exactly as-is — do not translate or number-code it).

### 12.3 Codec coverage on the backend side — report this honestly, don't work around it

**Updated 2026-10-02 (third pass).** Three tiers now, not two — every VoLTE codec produces
*some* estimate, but the UI/API must distinguish how trustworthy each one is
(`mos_is_provisional` on every sample, see §4.6):

- **Verified** (`mos_is_provisional: false`) — AMR-WB (real ITU-T G.113 Appendix IV
  wideband constants, 12.65 kbit/s mode), plus G.711/G.729 for general testing.
- **Provisional** (`mos_is_provisional: true`, explicit 2026-10-02 decision: ship an
  approximate number now rather than block, correct later) — **EVS**, real G.113 Appendix V
  constants run through the wideband formula as a stand-in for the unverified fullband
  E-model; **AMR-NB**, no ITU source found at all, proxied via GSM-EFR's verified
  narrowband value (AMR-NB's 12.2 kbit/s mode is algorithmically derived from GSM-EFR, a
  defensible stand-in, not an arbitrary one). Expect these numbers to shift once a real
  source is found — the SDK side needs no change when that happens, only the backend table.
- **Unavailable** (`mos_estimate: null`) — any codec with literally no entry, or any call
  reporting packet loss for a codec with no published robustness factor to account for it.

This is a known, tracked state, not something the SDK needs to work around — keep sending
the raw metrics regardless of codec or provisional status; the estimate tier improves
automatically as backend coverage is extended, with no SDK change needed.

One thing worth flagging back if you find out otherwise: Android's `CallQuality` API
reports a codec TYPE, not the negotiated bitrate, so the backend's AMR-WB estimate always
uses the 12.65 kbit/s constants regardless of which of AMR-WB's 9 possible bitrates a real
call actually negotiated — a representative-rate approximation, not a per-call exact
match. If the SDK ever gains a way to read the actual negotiated bitrate, say so; the
backend table has per-bitrate AMR-WB constants ready to wire in.

### 12.4 Why this is a separate pipeline from §4.1's RF samples

Different cadence (one upload per completed call, not a periodic/handover tick), no
`opt_out`/duplicate-batch handling (call volume doesn't need it), and no on-device MOS
computation (keeping that server-side means a future constant correction — see §12.3 —
applies retroactively via a backend deploy, not an app re-release to every device).

## 13. Device-bound, consent-gated tracing (2026-10-04)

Written for: the Android SDK team. This section replaces the shared-key device
model for two things: trace uploads (new) and every ingest call (retirement
below). Only DT-WATCH operators can start a trace. The app never starts one
itself, and it never sends location until the user has accepted and the OS
location permission is granted.

### 13.1 Credential: a Keystore keypair, never the APK key

- On first launch, generate an EC P-256 keypair in the Android Keystore with the
  private key non-exportable. Keep it there. Never write it to disk, prefs, or logs.
- The device id is the SHA-256 of the public key's DER encoding
  (`SubjectPublicKeyInfo`), first 32 hex chars. The server recomputes it from the
  PEM you send, so the id cannot be chosen independently of the key.
- The shared `tel_` key is retired (§13.6). Do not add new uses of it.

### 13.2 Registration: silent, on install and on every update

No user prompt. Run it at app start whenever no registration exists for the
current key, and again after an app update.

1. `GET /api/telemetry/v1/device/challenge/` → `{"challenge": "...", "expires_in": 300}`.
   The challenge is single-use and expires after 5 minutes.
2. Request a Play Integrity token with the challenge as its nonce.
3. `POST /api/telemetry/v1/device/register/` with JSON:
   `{"public_key": "<PEM>", "challenge": "...", "play_integrity_token": "...", "msisdn": "+977...", "fcm_token": "...", "app_version": "1.2.3"}`.
   `msisdn` comes from the SIM through the carrier-privileged API. The app never
   asks the user for it.

Responses: `200 {"device_id": "...", "registered": true, "created": bool}`;
`403` on a failed integrity check or a revoked device (the detail is always
generic, so a probing client learns nothing); `409` if the MSISDN is already
bound to a different device; `400` on a bad challenge or key; `429` on too many
attempts from one IP.

Re-registering the same key updates msisdn, fcm_token, and app_version. It never
un-revokes a device.

### 13.3 Signing every device call

Every call after registration, except the two above, carries four headers:

| Header | Value |
|---|---|
| `X-Device-Id` | the `device_id` from registration |
| `X-Timestamp` | current epoch **seconds** (not ms); must be within ±120 s of server time |
| `X-Nonce` | 8–128 chars of `[A-Za-z0-9_-]`, unique per request |
| `X-Signature` | base64 (standard, padded) of the DER ECDSA-SHA256 signature |

The signed string is one line, UTF-8, with no trailing newline:

```
METHOD|PATH|TIMESTAMP|NONCE|SHA256_HEX_OF_BODY
```

- `METHOD` is uppercase. `PATH` is the request path including the leading `/api/…`
  and with no query string.
- `SHA256_HEX_OF_BODY` is the lowercase hex SHA-256 of the exact body bytes you
  send. For GET and other body-less requests it is the hash of the empty string.
- Send the same bytes you hashed. Do not re-serialize JSON after signing.

Use the Keystore's `Signature.getInstance("SHA256withECDSA")`. Encode the result
as standard base64 (not URL-safe).

A replayed nonce gets `401`, and so does a timestamp outside the window.

### 13.4 Push and polling

- FCM data messages only, with `{"type": "trace_request", "request_id": "<uuid>"}`.
  The push carries no MSISDN, case reference, or location. Do not show the push
  payload to the user as-is.
- On a `trace_request` push, and also on every app start and every ~15 minutes,
  call `GET /api/telemetry/v1/device/trace-requests/`. That returns only open
  requests (`PENDING` or `ACCEPTED`) with `id`, `status`, `consent_at`, `expires_at`,
  and `created_at`. Push is an accelerator. Polling is the reliable path.
- Renew the FCM token with `PUT /api/telemetry/v1/device/fcm-token/` whenever FCM rotates it.

### 13.5 Consent and sampling

1. For a `PENDING` request, show a full-screen consent prompt. Accept and Reject
   both go to `POST /api/telemetry/v1/device/trace-requests/<id>/respond/` with
   `{"action": "accept" | "reject"}`. Each action is valid only from one specific
   state, and any other state returns `409`.
   If the response has `"operator_attested": true`, an operator has recorded the
   user's agreement by phone. Show the prompt as "An NTC operator recorded your
   agreement by phone. Tap Accept to continue." The phone-call record does not
   start the trace. Only this on-device Accept does, so the user always makes the
   final decision on their own phone.
2. **Only after Accept**, request `ACCESS_FINE_LOCATION` at runtime. If the
   user refuses the OS grant, keep the request `ACCEPTED` on the server and tell
   the user location is off. Do not send anything.
3. While sampling, run a foreground service with a persistent notification:
   "Location shared with NTC network team until HH:MM — Stop". Its Stop action
   calls `respond/` with `{"action": "stop"}`, which moves the request to `REVOKED`.
4. Send fixes in batches to `POST /api/telemetry/v1/device/trace-requests/<id>/samples/`
   as a JSON array of `{"ts": <epoch ms>, "lat": ..., "lon": ..., "accuracy_m": ...}`.
   The server accepts a fix only if `ts` is inside `[consent_at, expires_at]`.
   Out-of-window and malformed items are counted in `rejected` and dropped, and
   they never fail the batch. Keep `ts` honest: use the fix's own time. Do not
   back-date it.
5. Stop sampling when the request expires, is `REVOKED`, `CANCELLED`, or
   `EXPIRED`, or when the user revokes. A `409` on samples means the request
   is no longer `ACCEPTED`. Stop the service and do not retry.

### 13.6 Retiring the shared key

- Crowdsourced ingest (`samples/`, `volte-samples/`) accepts signed device calls
  right away. Ship signing in the next build.
- The shared `tel_` key still works until `TELEMETRY_SHARED_KEY_ACCEPTED_UNTIL`
  is set on the server. After that date it returns `401 "shared telemetry key
  retired; update the app"`. A device-signed call is unaffected either way.
- Until then, the key stays in the APK, and anyone who extracts it can still post
  crowdsourced rows. That is the risk the cutoff closes. Tracing is not affected,
  because trace samples are accepted only on device-signed calls.
- Crowdsourced rows from a signed device are always owned by that device. A body
  `device_id` is ignored.

### 13.7 Blocking external prerequisites

- **Firebase project** for FCM, with the service-account credential supplied to
  the server (`FCM_SERVICE_ACCOUNT_JSON`) and `google-services.json` in the app.
- **Play Integrity** linked to the Google Cloud project that holds that service
  account, with the package name set on the server (`PLAY_INTEGRITY_PACKAGE_NAME`).
  `PLAY_INTEGRITY_REQUIRED` defaults to true, so registration fails closed until
  this is in place.
- **Carrier-privileged status** for the SIM MSISDN read (§12.1). Without it, the
  app has no number to register.
- The server's push and integrity checks are inert until the first two are
  configured. A trace still works by polling, but registration cannot succeed
  until Play Integrity is configured or explicitly turned off on a dev server.
