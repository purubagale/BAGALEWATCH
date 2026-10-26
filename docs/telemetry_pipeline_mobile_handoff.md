# DT-WATCH Telemetry Pipeline and Mobile App: Handoff to the NT Mobile App Team

**For:** the Nepal Telecom mobile app developer team

**From:** Puru (RAN O&M, owner of the DT-WATCH server and web application)

**Last updated:** 2026-10-24 (signed rescue sharing, serving-site lookup, SINR fill-in, upload queue). This version replaces the guide of 2026-09-21 and its two addenda.

## 1. Summary

DT-WATCH is NTC's RAN O&M web application. It has a server-side pipeline that
receives signal readings from phones, and a working Android app and SDK that
send them. Both are built and running on test phones against the live server.
The app is not published.

What we are handing over:

- the **device API** of the server (section 4 onward): every endpoint a phone calls;
- the **Android SDK** (`netplanning-telemetry-sdk`) and the **reference app**
  built on it (section 14);
- the list of things only the app team or NTC can complete (section 15).

Three things need the app team more than anything else:

1. **Carrier-privileged status** for the app, so it can read the SIM's number
   and call statistics. Today the user types the number.
2. **Play Integrity** at registration. Today the app sends no integrity token.
3. **Signing every upload with the phone's own key**, so the shared key can be
   removed from the APK.

## 2. How the pieces fit

```
Phone (app + SDK)  --HTTPS-->  DT-WATCH server  <--HTTPS--  Web application (staff)
                                     |
                     Firebase push --+--> phone (two message types)
```

- The phone and the web application never talk to each other. Both talk to the server.
- The phone uses only the device API under `/api/telemetry/v1/`. It never calls
  the staff API under `/api/v2/`.
- Nothing leaves the phone until the user turns a sharing feature on. Each
  feature has its own switch and its own endpoint.

What the server does with a reading, so the app does not have to:

| Step | Detail |
|---|---|
| Hides the device | `device_id` is replaced by a salted SHA-256 hash before storage |
| Finds the serving site | Matches PCI (4G), scrambling code (3G) or BCCH and BSIC (2G) to a site within 5 km |
| Estimates CQI | From SINR; from RSRQ by a step table when SINR is missing. The app sends no CQI |
| Picks the level to show | RSRP on 4G and 5G, RSCP on 3G, RSSI on 2G |
| Names the band | From the channel number, or the band the phone reports: "B3 (1800)" |
| Averages | Hourly, into map cells of about 150 m |
| Deletes | Raw readings after 90 days; the averaged cells are kept |

## 3. Hosts and credentials

**Production:** `https://dtwatch.ntc.net.np`. It has a private address and is
reachable only on the NTC network or VPN. A public app needs a public route to
the device API; that is an open decision (section 15).

There are two credentials. They are separate from staff logins.

| Credential | What it is | Used for | Status |
|---|---|---|---|
| Shared ingest key | `tel_` + 48 hex characters, compiled into the app. Sent as `Authorization: Bearer tel_...` or `X-API-Key` | Samples, speed results, push token, rescue enrolment, drive-test consent | In use. To be retired (section 15) |
| Device key | An EC P-256 key pair in the Android Keystore; the private key cannot be exported. Each request is signed (section 7) | Registration-only features: trace requests, site photos, device identity | In use for those features only |

Ask Puru for a key. A key is shown once when created, has its own rate limit
(600 batches a minute by default) and can be switched off at any time. Never
commit a key or `google-services.json` to a repository.

Every endpoint that accepts the shared key also accepts a signed device call,
and prefers it: if `X-Signature` is present the key is ignored.

## 4. Endpoint catalogue

All paths are under `/api/telemetry/v1/`. "Key" means the shared ingest key or
a signed call (section 7.3). "Signed" means a registered phone only.

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `health/` | GET | none | Reachability check |
| `samples/` | POST | Key | Batch of signal readings (section 5) |
| `push-token/` | POST | Key | Push address of a sharing phone (section 8) |
| `speed-samples/` | POST | Key | One speed test result (section 10) |
| `speedtest/ping/`, `download/`, `upload/` | GET, GET, POST | none, rate limited | Far end of the speed test |
| `rescue-enroll/` | POST | Key | Rescue sharing on or off, with a typed number. Older apps only; refused with 410 after the cut-off date (section 12) |
| `device/rescue-consent/` | POST | Signed | Rescue sharing on or off for the registered number (section 12) |
| `device/serving-site/` | GET | Signed | Site and sector of the serving cell, for the Signal screen; nothing is stored |
| `drive-test-consent/` | POST | Key | Standing consent to be included in staff drive-test sessions |
| `drive-test-consent-message/` | GET | none | Current consent wording |
| `volte-samples/` | POST | Key | Call quality. Dormant (section 13.2) |
| `call-samples/` | POST | Key | Finished calls: voice network, cell and level, no quality figures (section 13.1) |
| `device/challenge/` | GET | none | One-time value for registration |
| `device/register/` | POST | none, rate limited | Registers the phone's public key with its number |
| `device/fcm-token/` | PUT | Signed | Push address of a registered phone |
| `device/sdk-link/` | POST | Signed | Ties the phone to its SDK device id, for signed uploads (section 7.3) |
| `device/verify-number/` (`start/`, `confirm/`) | GET, POST | Signed | Proves the registered number by SMS code (section 7.4) |
| `device-identity/` | POST | Signed | Model, user type and, when readable, number and IMEI |
| `device/trace-requests/` | GET | Signed | Open location requests for this phone |
| `device/trace-requests/<id>/respond/` | POST | Signed | Accept, reject or stop |
| `device/trace-requests/<id>/samples/` | POST | Signed | Location fixes, only while accepted |
| `device/trace-requests/<id>/speedtest/...` | GET, POST | Signed | Speed test tied to an accepted request |
| `device/nearby-sites/` | GET | Signed | Sites within 1 km, for the photo screen |
| `device/site-photos/` | POST | Signed | One site or drive photo (section 11) |
| `device/problem-reports/` | POST | Signed | "Report a problem" from the app (section 10a) |

## 5. Signal samples

`POST /api/telemetry/v1/samples/` with a JSON **array** of objects, even for one reading.

```json
[
  {
    "device_id": "3f9a1c2e-7b1d-4e8a-9c2f-5a6b7c8d9e0f",
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
    "sinr_db": 12,
    "arfcn": 1650,
    "band": 3,
    "battery_pct": 76,
    "trigger_reason": "periodic"
  }
]
```

### 5.1 Fields

Only `device_id` and `ts` are required. A bad optional field becomes null; it
does not fail the batch. Unknown keys are ignored. There is no field for IMEI,
Android ID or phone number.

| Key | Type | Notes |
|---|---|---|
| `device_id` | string | Required. A random ID the SDK generates and keeps per install. Never IMEI, Android ID or a number |
| `ts` | integer | Required. Epoch **milliseconds**, time of the reading |
| `lat`, `lon` | float | WGS84. The key is `lon`, not `lng` |
| `gps_accuracy_m` | float | Metres |
| `cell_id` | integer | Use a 64-bit type; a 5G cell identity is 36 bits |
| `pci` | integer | 4G and 5G only |
| `scrambling_code` | integer | 3G only, 0 to 511 |
| `bcch`, `bsic` | integer | 2G only: ARFCN 0 to 1023, BSIC 0 to 63 |
| `arfcn` | integer | Channel number of the serving cell: EARFCN on 4G, UARFCN on 3G, NR-ARFCN on 5G, BCCH ARFCN on 2G. Added 2026-10-13 |
| `band` | integer | 3GPP band number (3 for 1800 MHz, 20 for 800 MHz). Send what the phone reports (`getBands()`, Android 11 and later). Leave it out on 2G, or when unknown. Added 2026-10-13 |
| `tac` | integer | Tracking area code, or location area code on 2G and 3G |
| `mcc`, `mnc` | string | For example `"429"`, `"01"` |
| `network_type` | string | `LTE`, `NR`, `UMTS`, `GSM` or `UNKNOWN`. Anything else becomes `UNKNOWN` |
| `rsrp_dbm`, `rsrq_db`, `sinr_db` | integer | 4G and 5G. Null on 2G and 3G |
| `rssi_dbm` | integer | 2G and 3G level |
| `rx_qual` | integer | 2G only, 0 to 7. Send null for "unknown" (99) |
| `rscp_dbm`, `ecio_db` | integer | 3G only, Android 10 and later |
| `cqi` | integer | Accepted, but the SDK does not send it; Android rarely exposes it |
| `battery_pct` | integer | 0 to 100 |
| `trigger_reason` | string | See 5.2. Anything else becomes `periodic` |
| `drive_session_id` | string | Up to 36 characters. Groups the readings of one drive or one share window |
| `service_state` | string | `in_service`, `out_of_service`, `emergency_only` or `radio_off`, from `TelephonyManager.getServiceState()` (phone-state permission, no location). Added 2026-10-26 |
| `cell_info_status` | string | Why the cell is there or missing: `ok`, `background` (app in the background without background location), `location_off`, `no_permission` or `empty` (the phone returned no cell). Added 2026-10-26 |
| `airplane_mode` | boolean | Flight mode on. Added 2026-10-26 |
| `sim_state` | string | `ready`, `absent`, `locked` or `other`. Added 2026-10-26 |
| `environment` | string | Where the person is: `outdoor`, `indoor` or `vehicle`; leave it out when unknown. Added 2026-10-26 |
| `environment_source` | string | `user` (tapped in the app) or `estimated` (from movement and GPS accuracy). Sent only with `environment`. Added 2026-10-26 |

**Readings without a network (2026-10-26).** Always send a reading, even when
the cell list is empty: `network_type` `UNKNOWN` plus the four fields above.
The server only counts it as a coverage gap when `service_state` is
`out_of_service` or `emergency_only`; flight mode, radio off or a missing SIM
is "radio off", and anything else is "not measured" and stays out of every
coverage share. When the cell list is empty, fill the level and `network_type`
from `getSignalStrength()` (no location needed), as the reference SDK does.
Older readings without these fields are judged by their position: no network
and no GPS position means the phone withheld both, so "not measured".

**Band.** Send `arfcn` on every reading; it is available from Android 7. The
server works out the band from it when `band` is missing, and names it in MHz
(900, 1800, 2100). A band the phone reports wins over the channel. The server's
table covers 4G bands 1, 2, 3, 4, 5, 7, 8, 20, 28, 38, 39, 40, 41, 3G bands 1,
2, 3, 5, 8, and 2G 850, 900 and 1800. A 5G reading gets a band only if the
phone reports one. Readings from an app built before 13 October 2026 carry no
channel, so they show no band; 2G readings are the exception, since `bcch`
already is the channel.

**SINR matters.** On the live server on 12 October 2026, none of 2,099 4G
readings carried `sinr_db`. Without it the server falls back to a rougher CQI
estimate from RSRQ. Please check `CellSignalStrengthLte.getRssnr()` on the
target phones and send it whenever the modem reports it.

### 5.2 Trigger reasons

| Value | Sent when |
|---|---|
| `periodic` | The background job runs, every 15 minutes while sharing |
| `handover` | The serving cell changes, at most once every 2 minutes |
| `manual` | The user asks for a reading |
| `drive` | A fix during a phone drive test, every 2 seconds |
| `drive_start`, `drive_stop` | Markers at the start and end of a drive or share window |
| `on_demand` | The phone answers a request from the server (section 8) |

### 5.3 Responses

| Status | Body | Meaning |
|---|---|---|
| 202 | `{"accepted": N, "opt_out": bool}` | Stored. If `opt_out` is true the phone must switch sharing off (section 6) |
| 200 | `{"accepted": 0, "duplicate": true}` | The same batch was already received. Treat as success |
| 400 | `{"detail": "..."}` | Not an array, or a reading without `device_id` or `ts` |
| 401 | `{"detail": "..."}` | Bad key or bad signature. After retirement: `shared telemetry key retired; update the app` |
| 413 | `{"detail": "max 2000 samples per request"}` | Split the batch |
| 429 | `{"detail": "rate limit exceeded"}` | Back off and retry |

- **Batch size:** up to 2,000. The SDK sends 200.
- **Retries:** resend the identical array. The server remembers a hash of each
  batch, so a retry does not create duplicates. Do not reorder or rebuild it.
- **Rate:** 600 batches a minute per shared key; 60 a minute per signed phone.

## 6. Sharing and consent in the app

The app implements these rules today. A new app must keep them.

- **Off by default.** Nothing is collected or sent until the user turns sharing on.
  The one exception is the first-install sample below.
- **One-minute sample.** Whenever the user allows location on the setup screen
  (first install, after an update, or any time the permission was missing),
  the app shares for about one minute, takes a few readings, and switches
  sharing off by itself. The setup screen says this before the user allows
  anything. If the permission is already held, nothing is shared.
- **First start after install.** The app asks for location, phone state and, on
  Android 13 and later, notifications. Then a pop-up asks for the phone's number
  to register it. The user can put either off.
- **First start after an update.** The app first checks the permissions and
  shows the setup screen if location is missing. It then checks whether the
  phone is registered. If not, the same pop-up asks for the number. If it is, a message
  says so and nothing more is asked.
- **Settings** shows the registration form only while the phone is not
  registered. After that it shows the registered number.
- **Share with NTC** opens a window of 60 minutes. It ends on its own, and the
  user can end it earlier. The window survives a restart.
- **Drive test.** Start asks for location permission if missing, then asks
  "Share this drive with NTC?". Share switches sharing on for the drive and off
  again at Stop. Keep on phone records locally and queues nothing. An employee
  may tick "Remember my answer".
- **After sharing is switched off**, what is already queued is still sent, so a
  drive's last readings and its stop marker reach the server. Nothing new is collected.
- **Remote opt-out.** When a `samples/` response has `"opt_out": true`, the SDK
  switches sharing off on that upload cycle. This is one instruction, not a
  standing block: the user can opt in again.
- **Uploads wait for Wi-Fi** by default (`uploadOnlyOnUnmetered`), so readings
  can arrive well after they were taken. A manual upload does not wait.
- **Separate consents.** Rescue sharing and drive-test consent each need their
  own explicit action. General sharing never implies them.
- **Location permission** is foreground only. The app does not ask for
  background location.

## 7. Registering a phone and signing requests

Registration is needed for trace requests, site photos and device identity.

### 7.1 Registration

1. `GET device/challenge/` returns `{"challenge": "...", "expires_in": 300}`. Single use.
2. `POST device/register/`:

```json
{
  "public_key": "<PEM, EC P-256>",
  "challenge": "...",
  "play_integrity_token": "",
  "msisdn": "+97798...",
  "fcm_token": "...",
  "app_version": "0.1",
  "manufacturer": "HUAWEI",
  "phone_model": "...",
  "hardware_id": "..."
}
```

| Status | Meaning |
|---|---|
| 200 | `{"device_id": "...", "registered": true, "created": bool}` |
| 400 | Bad key, bad number, or bad or expired challenge |
| 403 | Integrity check failed, or the phone was revoked. The text is the same for both |
| 409 | The number is already registered on another phone |
| 429 | More than 10 attempts a minute from one address |

- `device_id` is the first 32 hex characters of the SHA-256 of the public key
  (DER, `SubjectPublicKeyInfo`). The server computes it from the PEM.
- One number has one active registered phone. Moving a number is a superadmin action.
- `hardware_id` is a SHA-256 of the Android ID with a fixed prefix. It lets the
  server see that two IDs belong to one phone.

**Current state, to be changed by the app team:** the user types the number
(in the pop-up at first start, or under "Register this phone" in Settings) and
it is not verified against the SIM. "Registered" is what the phone remembers
from the server's answer; it survives an update and is lost on uninstall. The
app sends an empty `play_integrity_token`, so the server runs with the
integrity check switched off. The app retries registration in the background
with a fresh challenge each time.

### 7.2 Signing

Every signed call carries four headers.

| Header | Value |
|---|---|
| `X-Device-Id` | The `device_id` from registration |
| `X-Timestamp` | Epoch **seconds**, within 120 seconds of server time |
| `X-Nonce` | 8 to 128 characters of `[A-Za-z0-9_-]`, unique per request |
| `X-Signature` | Standard base64 of the DER ECDSA-SHA256 signature |

The signed text is one line, UTF-8, no trailing newline:

```
METHOD|PATH|TIMESTAMP|NONCE|SHA256_HEX_OF_BODY
```

- `METHOD` in capitals. `PATH` starts with `/api/` and has no query string.
- The hash is lowercase hex of the exact bytes sent. For a request with no body
  it is the hash of the empty string.
- Send the bytes you hashed. Do not serialise the JSON again after signing.
- A repeated nonce or a timestamp outside the window returns 401.
- Use `Signature.getInstance("SHA256withECDSA")` with the Keystore key.

### 7.3 Signed uploads (14 October 2026)

The shared ingest key ships inside every APK, so anyone can extract it and
post readings. A registered phone therefore signs its regular uploads too:
`samples/`, `speed-samples/`, `push-token/`, `call-samples/` and
`volte-samples/` accept the signed headers above in place of the key.

1. After registering, the phone sends its SDK device id once, signed:
   `POST device/sdk-link/` with `{"sdk_device_id": "<the SDK's device_id>"}`.
   It returns `{"linked": true}`.
2. From then on the server files the phone's signed uploads under that SDK id,
   the same identity its shared-key uploads had. Push tokens for Area Sample,
   rescue positions, drive-test consent and earlier readings keep matching.
   Without the link, signed uploads are filed under the key's own id, which
   splits the phone in two; so sign uploads only after the link succeeded.
   The link also ties the registered number to the SDK id, so the staff
   Device Location Trace tool (declared emergency, case reference, every
   search logged) can find the phone's shared readings. A phone whose owner
   withdrew rescue consent stays hidden. Rescue Lookup is unchanged: it
   covers only phones that turned on the rescue beacon.
3. A `401` on a signed upload means the server no longer knows the key
   (registration removed, or the app reinstalled with a new key). Go back to
   the shared key and link again after registering.

In the SDK the host app supplies the signing through
`NetTelemetry.setRequestSigner(RequestSigner)`; `NetTelemetry.sdkDeviceId()`
gives the id to link. The reference app does both in `SdkLink.kt`, from a
content provider so the signer is set before any background upload runs.

A phone that never registers keeps using the shared key. The key can be
retired on the server (`TELEMETRY_SHARED_KEY_ACCEPTED_UNTIL`) only once every
sharing phone is registered; until then it still works for anyone holding it.

### 7.4 Proving the number by SMS code (15 October 2026)

The number sent at registration is typed by the user, so on its own it
proves nothing. When the server can send SMS, the registration answer says
so:

```json
{"device_id": "...", "registered": true, "created": true,
 "number_verified": false, "verification_available": true, "verification_required": false}
```

With `verification_available` true and `number_verified` false, the app
asks the server to send a code and lets the user type it. All three calls
are signed (section 7.2):

| Path | Method | Body | Answer |
|---|---|---|---|
| `device/verify-number/` | GET | none | the three flags above |
| `device/verify-number/start/` | POST | `{}` | `{"sent": true, "expires_in": 600, "resend_after": 60}`; 429 when asked again within a minute or more than 5 times a day; 503 when no SMS can be sent |
| `device/verify-number/confirm/` | POST | `{"code": "123456"}` | the flags, with `number_verified: true`; 400 with `detail` ("Wrong code. 4 tries left.", "The code has expired. Ask for a new one.") |

A code lives 10 minutes and takes 5 tries. A verified phone keeps the
number: another phone typing the same number is then refused (409), and an
unverified phone that had typed it loses it. Changing the number at
registration clears the verified flag. Until NTC's SMS gateway is set up
the server answers `verification_available: false` and the app asks
nothing. The reference app does this in `NumberVerify.kt`: after
registering, and from the "registered as" line in Settings.

## 8. Push messages and readings on request

The server sends Firebase **data** messages only. Each carries a type and an
ID, never a number, a case reference or a position.

| `type` | Sent to | The phone then |
|---|---|---|
| `sample_request` | A sharing phone (`push-token/`) | Takes one reading and uploads it with `trigger_reason` `on_demand` |
| `trace_request` | A registered phone (`device/fcm-token/`) | Fetches its open requests and shows the consent screen |

The two push addresses are stored separately on purpose.

- `POST push-token/` with `{"device_id": "<SDK id>", "fcm_token": "..."}` when
  sharing starts. Send an empty `fcm_token` when sharing stops; the server then
  deletes the row. A phone that is not sharing is never asked for a reading.
- `PUT device/fcm-token/` with `{"fcm_token": "..."}` whenever Firebase rotates
  the token of a registered phone.

A reading on request (Area Sample in the web application): staff pick an area;
the server asks the phones that shared there in the last 24 hours and are
sharing now; readings that arrive within 15 minutes are shown with no device
ID. The phone checks its own sharing switch before it answers, and gives up
after 15 seconds without a position.

Status: the server side is live. On 12 October 2026 a request on the live
server found a sharing phone but the push was not delivered; the cause is
being checked on the server (Firebase setting or outbound access).

## 9. Location requests (trace)

Only DT-WATCH staff can create a request, and only for a registered phone. The
phone never starts one.

```
PENDING --accept--> ACCEPTED --stop--> REVOKED
PENDING --reject--> REJECTED
PENDING or ACCEPTED --staff cancel--> CANCELLED
any open state after expires_at --> EXPIRED
```

1. On a `trace_request` push, on app start and about every 15 minutes, call
   `GET device/trace-requests/`. It returns open requests with `id`, `status`,
   `consent_at`, `expires_at`, `created_at`. Push only speeds this up; polling
   is the reliable path.
2. Show a full-screen consent prompt for a `PENDING` request. Send the answer to
   `POST device/trace-requests/<id>/respond/` with `{"action": "accept" | "reject"}`.
   An action from the wrong state returns 409.
3. If the request has `"operator_attested": true`, staff recorded the user's
   agreement by phone. Say so on the prompt. The request still starts only when
   the user taps Accept on the phone.
4. Ask for location permission only after Accept.
5. While sharing, run a foreground service with a notification that shows the
   end time and a Stop action. Stop sends `{"action": "stop"}`.
6. Send fixes to `POST device/trace-requests/<id>/samples/` as an array of
   `{"ts": <epoch ms>, "lat": .., "lon": .., "accuracy_m": ..}`. A fix is kept
   only if `ts` is between `consent_at` and `expires_at`. Others are counted in
   `rejected` and dropped.
7. A 409 on samples means the request is no longer accepted. Stop and do not retry.

A request lasts 120 minutes by default.

## 10. Speed test

The test runs when the user taps a test button (and every 30 minutes in the
Collector edition, section 14).

**How it measures (since 26 October 2026).** The way LibreSpeed and Ookla do,
so the numbers can be compared with theirs: several connections at once, each
for a fixed time, the first second or so left out while TCP speeds up, and
the sustained rate reported. The far end is served by nginx at the root of the
dtwatch server (not under `/api/`), so parallel streams never hold up the web
application:

| Call | Detail |
|---|---|
| `GET /speedtest/empty` | 204, no body. Ping; add a `?r=<random>` so nothing caches it |
| `GET /speedtest/garbage` | A 32 MB random file. Each download stream requests it again and again until its time is up |
| `POST /speedtest/upload` | Any body up to 64 MB, read and dropped; returns 200. Chunked bodies are accepted |

At most 16 open connections per address. Two profiles:

| Profile | When | Download | Upload | Data at most |
|---|---|---|---|---|
| Full | the user taps a test button | 6 connections, 10 s | 4 connections, 10 s | 150 MB down, 60 MB up |
| Light | Collector every 30 min, a problem report's test | 3 connections, 5 s | 2 connections, 5 s | 15 MB down, 6 MB up |

On a fast 4G cell a full test uses roughly 50 to 90 MB; tell the user before
running it on a metered plan. A server without `/speedtest/empty` (404) gets
the old single-connection test below, which reads lower than Ookla.

The old endpoints stay for older app builds:

Since 15 October 2026 the reference app offers two tests: **Test mobile
data** and **Test Wi-Fi**. Both results are sent, tagged with `bearer`
(`mobile` or `wifi`), so the server keeps Wi-Fi results apart from figures
about NTC's mobile network. The Collector edition's automatic test uses
mobile data.

The mobile-data test runs every request over the mobile-data network, even
while the phone is on Wi-Fi: it asks Android
for a network with `TRANSPORT_CELLULAR` (`ConnectivityManager.requestNetwork`,
needs `CHANGE_NETWORK_STATE`) and binds its sockets to it. Packet loss is the
share of 20 pings with no answer within 2 seconds. The Wi-Fi test asks for a network with `TRANSPORT_WIFI`
the same way.

| Call | Detail |
|---|---|
| `GET speedtest/ping/` | Returns 204 with no body |
| `GET speedtest/download/?bytes=N` | N bytes that cannot be compressed. Default 6 MB, at most 20 MB |
| `POST speedtest/upload/` | Reads the body, at most 20 MB. Returns `{"received_bytes": N}` |

These three need no key and are limited to 60 requests a minute per address.
The app sends no ID with them and the server stores nothing.

The result goes to `POST speed-samples/`, only while the user is sharing:

```json
{"device_id": "<SDK id>", "ts": 1758444000000, "ping_median_ms": 38,
 "jitter_ms": 4, "download_mbps": 21.4, "upload_mbps": 6.2,
 "packet_loss_pct": 5, "network_type": "LTE", "rsrp_dbm": -90,
 "bearer": "mobile"}
```

Returns `201 {"stored": true}`. Limited to 20 a minute. `packet_loss_pct`
(0 to 100) is optional. `bearer` is `mobile` or `wifi`; any other value, or
none, is stored blank (results from builds before 15 October 2026).

A second set under `device/trace-requests/<id>/speedtest/` is signed and works
only while that request is accepted. Its result call takes `ran_at` (epoch ms,
inside the consent window) in place of `ts`.

## 10a. Report a problem

A registered phone can send a problem with the reading and a speed test at
that moment. `POST device/problem-reports/`, signed (section 7):

```json
{"category": "slow_data", "note": "Slow in the evening", "ts": 1758444000000,
 "lat": 27.70, "lon": 85.32, "network_type": "LTE", "band": "B3 (1800)",
 "pci": 120, "cell_id": 26385921, "level_dbm": -98, "rsrq_db": -12, "sinr_db": 4,
 "download_mbps": 3.1, "upload_mbps": 1.2, "ping_ms": 62, "jitter_ms": 9,
 "packet_loss_pct": 5, "phone_model": "...", "android_version": "14",
 "app_version": "..."}
```

`category` is one of `no_signal`, `slow_data`, `call_drop`, `stuck_2g3g`,
`other`; `lat` and `lon` are required, everything else is optional. Returns
Optional `environment` and `environment_source` as in 5.1: a report made
inside a building lets the server tell "weak indoors, good outside" from a
coverage gap.
`201 {"id": N, "stored": true}`. At most 10 a day per phone; the 11th gets 429.
The server checks the report against stored measurements; staff see the
result on the Problem Reports page. The reference app also shows hints from
the same rules on the phone (`ProblemHints.kt`).

## 11. Site photos

A staff member points the phone along a sector and takes a photo. The server
shows the direction the phone faced next to the sector's planned azimuth. A
registered phone is required.

1. `GET device/nearby-sites/?lat=..&lon=..` returns up to five sites within 1 km:

```json
{"sites": [{"id": "KTM856", "name": "...", "distance_m": 140,
            "directions": [{"azimuth": 20.0, "sectors": "J20, J3"}]}]}
```

2. `POST device/site-photos/`:

```json
{
  "image_b64": "<base64 JPEG>",
  "bearing_deg": 24.5,
  "lat": 27.7172, "lon": 85.3240,
  "accuracy_m": 8, "altitude_m": 1320,
  "taken_at": 1758444000000,
  "site_id": "KTM856",
  "planned_azimuth": 20, "sector_label": "J20, J3",
  "drive_session_id": "",
  "note": "",
  "signal": {"network_type": "LTE", "rsrp": -88, "rsrq": -10, "sinr": 12, "pci": 116, "cell_id": "..."}
}
```

Returns `201 {"id": N, "status": "pending"}`.

| Rule | Value |
|---|---|
| Required | `image_b64`, `bearing_deg`, `lat`, `lon`, and either `site_id` or `drive_session_id` |
| Site photo | The phone must be within 1 km of the site |
| Drive photo | Taken while a phone drive test runs. Send that drive's `drive_session_id`; no site is needed |
| Picture | JPEG, at most 2 MB and 8 megapixels. The app sends about 0.5 MB at 1600 px |
| Volume | 100 a day per phone, 5,000 a day in total. Refused while 2,000 await review |
| After upload | Every photo waits for an admin to approve it. Only admins and superadmins see photos |

The picture travels as base64 inside the JSON body so that the request is
signed like any other. The server re-encodes it and drops its metadata. The
bearing is the direction of the back camera with the phone held upright, read
from the rotation-vector sensor and corrected to true north. A phone compass is
typically within 5 to 15 degrees.

## 12. Rescue sharing, drive-test consent, device identity

**Rescue sharing** (`POST rescue-enroll/`). The subscriber agrees that staff may
see the phone's last known position during a declared emergency.

- Enrol: `{"device_id": "<SDK id>", "consent": true, "msisdn": "+977..."}` returns `{"enrolled": true}`.
  Optional: `manufacturer`, `phone_model`, `app_version`, `hardware_id`.
- Withdraw: `{"device_id": "...", "consent": false}` returns `{"enrolled": false, "removed": bool}`.
- Enrolling carries no position. The position updates only from ordinary
  samples while the phone is sharing.
- A subscriber who withdrew is never shown by a lookup, even in an emergency.

**Signed rescue sharing (24 October 2026).** `rescue-enroll/` takes any typed
number from any phone that holds the shared key, so anyone who extracts the key
can enrol someone else's number. A registered phone therefore uses
`POST device/rescue-consent/` (signed, section 7.2) instead:

- Body: `{"consent": true}` or `{"consent": false}`, plus optional
  `app_version`. The number is never sent; the server takes it from the
  phone's registration.
- The beacon is filed under the phone's SDK id, so the phone must have sent
  `device/sdk-link/` first; until then both on and off answer `409`.
- On: `200 {"enrolled": true, "msisdn": "977..."}`. With no number on the
  registration: `400`. When the server requires proved numbers and this one has
  not been proved by SMS (section 7.4): `403`.
- Off: `200 {"enrolled": false, "removed": bool}`. The stored position is deleted.
- The SDK's `RescueEnrollWorker` uses this route for a registered phone. It falls
  back to `rescue-enroll/` only when the server answers `404` (an older server),
  retries `409`, `408`, `429` and `5xx`, and stops on any other answer.
- After `RESCUE_SHARED_KEY_ACCEPTED_UNTIL` (server setting; proposed
  31 December 2026) `rescue-enroll/` answers
  `410 {"detail": "Rescue sharing now needs the latest app. Please update it."}`.
  The SDK treats `410` as final and does not retry.

**Serving site** (`GET device/serving-site/`, signed). Query parameters, all
optional: `network` (`LTE`, `NR`, `WCDMA`, `GSM`), `cell_id`, `tac`, `pci`,
`psc`, `bcch`, `bsic`, `lat`, `lon`. Returns `{"site": null}` or
`{"site": {"site_id", "site_name", "sector", "cell_name", "distance_m"}}`,
matched as stored readings are: 4G by eNodeB ID, 2G/3G by LAC (TAC) and cell
ID, else by PCI, scrambling code or BCCH/BSIC near the position. Nothing is
stored. The reference app asks once per serving cell and waits 30 s after a
failure. Before the answer, it shows the site and sector worked out on the
phone from NTC's numbering (`model/NtcCellName.kt`).

**Drive-test consent** (`POST drive-test-consent/`) with
`{"device_id": "...", "consent": true}` returns `{"consent": true}`. It decides
whether this phone's readings may appear in a staff drive-test session. It does
not affect whether samples are stored. `GET drive-test-consent-message/`
returns `{"message": "..."}`, the wording a superadmin maintains.

**Device identity** (`POST device-identity/`, signed). Every field is optional:
`msisdn`, `imei`, `phone_model`, `manufacturer`, `user_type` (`general` or
`employee`), `hardware_id`. An empty string clears a field. Returns
`{"stored": [...]}` with field names only. A normal Android app cannot read the
number or IMEI, so those stay empty until the app is carrier-privileged.

## 13. Calls

Two lanes. The first works in any app today; the second needs carrier
privilege and is not in the app.

### 13.1 Call records without quality figures: in the SDK and on the server

Since 14 October 2026 the SDK records each call made while the user shares,
using only `READ_PHONE_STATE` and location, which it already holds
(`collector/CallListener.kt`). It is on when `TelemetryConfig.callSamplesUrl`
is set.

- A call is the off-hook time, from dialling or answering to hang-up. A
  missed call is not recorded.
- The voice network (`TelephonyManager.getVoiceNetworkType()`, on the SIM
  that places calls) is read at the start and every 3 seconds, so a call
  that drops from 4G to 3G shows both.
- The data network just before the call is kept, so a CSFB call shows 2G/3G
  voice with 4G data before it.
- The serving cell and level are read at the start and the end (level: RSRP
  on 4G/5G, RSCP on 3G, RSSI on 2G).
- No number, no call direction, no audio or quality figures.
- Finished calls are queued on the phone (at most 200) and sent by
  `CallUploadWorker` once a network is available. Opting out with the queue
  wiped clears it.
- It runs only while the app process is alive. Calls made while the app is
  fully stopped are not seen; the Collector edition keeps the process alive
  while sharing.

`POST call-samples/` takes an array, at most 100 calls:

```json
[{"device_id": "...", "started_at": 1758444000000, "ended_at": 1758444060000,
  "voice_networks": ["LTE", "UMTS"], "voice_network_start": "LTE",
  "voice_network_end": "UMTS", "data_network_before": "LTE",
  "start": {"lat": 27.70, "lon": 85.32, "network_type": "LTE",
            "cell_id": 26385921, "pci": 120, "tac": 1201, "mcc": "429",
            "mnc": "01", "level_dbm": -112},
  "end": {"lat": 27.71, "lon": 85.33, "network_type": "UMTS",
          "cell_id": 1234567, "level_dbm": -98}}]
```

Returns `202 {"accepted": N, "skipped": M}`. A call with no `device_id`, an
end before its start, or longer than 6 hours is skipped, not the batch.
Network names: `LTE`, `NR`, `IWLAN`, `UMTS`, `HSDPA`, `HSUPA`, `HSPA`,
`HSPAP`, `TD_SCDMA`, `GSM`, `EDGE`, `GPRS`, `CDMA`, `1XRTT`, `EVDO`,
`UNKNOWN`.

The server classes each call:

| Outcome | When |
|---|---|
| VoLTE / VoNR | Every voice reading on LTE or NR |
| Wi-Fi calling | Voice on IWLAN, no 2G/3G |
| Fell back to 2G/3G | 2G/3G voice while on 4G/5G just before, or a call that started on 4G |
| 2G/3G, no 4G before | 2G/3G voice and 2G/3G before the call too |
| Unknown | No usable voice network reading |

Superadmins see the counts, the cells where calls most often fell back and
the latest calls under "Calls from phones" on the VoLTE Quality page.

### 13.2 Call quality (VoLTE and VoNR): built on the server, not in the app

`POST volte-samples/` takes an array, one object per finished call:

```json
[{"device_id": "...", "ts": 1758444000000, "network_type": "LTE",
  "codec": "AMR-WB", "call_duration_s": 42, "packet_loss_pct": 0.5,
  "jitter_ms": 8, "rtt_ms": 60, "quality_level": "GOOD",
  "lat": 27.7172, "lon": 85.3240, "cell_id": 123456, "pci": 301,
  "mcc": "429", "mnc": "01"}]
```

Returns `202 {"accepted": N}`.

- **Blocked on carrier privilege.** The figures come from Android's
  `CallQuality`, which needs `READ_PRECISE_PHONE_STATE`. Only a
  carrier-privileged or system app is granted it. Without it the listener is
  silent, with no error.
- **API:** `TelephonyCallback.CallAttributesListener` (API 31 and later), or
  `PhoneStateListener` with `LISTEN_CALL_ATTRIBUTES_CHANGED` (API 29 and 30).
  Read the last `CallQuality` at the end of the call.
- **Send raw figures only.** The server computes the score with the ITU-T G.107
  E-model. Send `quality_level` exactly as Android names it.
- **Codec coverage on the server:** AMR-WB, G.711 and G.729 use published
  constants. EVS and AMR-NB give a provisional score. Any other codec gives no score.

## 14. The Android SDK and the reference app

**Source:** `nepal-telemetry-project`, pushed to the `mobile` branch. Two
modules: `netplanning-telemetry-sdk` (the library) and `app` (the reference app,
package `np.nepaltelecom.telemetry.demo`). Kotlin, min SDK 26, target SDK 34,
JDK 17. Build with `:app:assembleDebug`.

The reference app's Application class and `google-services.json` are not in the
repository, because they hold the ingest key and the Firebase project. Puru
supplies them separately.

### 14.1 What the app does today

| Tab or screen | Function |
|---|---|
| Signal | Gauge of the serving cell's level, quality rating, 3-minute history, technology and band, speed test |
| Cells | Serving and neighbour cells as the modem reports them, each with its band |
| Map | Own position, drive test (Start, Stop, Upload, Past), route coloured by signal level, tap a point for its reading, Site photo |
| Wi-Fi | Wi-Fi readings |
| Settings | Employee tick box, Share with NTC, rescue sharing, Register this phone, battery settings |

Everyone gets Signal, Wi-Fi and Settings. The Cells and Map tabs, and with Map
the drive test and site photo, appear only after "I am an NTC employee" is
ticked in Settings; until then they are not on the bar at all. The tick box
also marks drives as staff drives. It grants nothing on the server. The app
has no staff login.

The Signal screen also has **Report a problem** (section 10a) and shows a
hint about the likely cause of a poor reading.

**Collector edition** (14 October 2026). The reference app has two build
flavours, `standard` and `collector` (`:app:assembleCollectorDebug`), with
the same application ID, so one replaces the other on a phone. The collector
build is for a small group of staff gathering test data: sharing has no time
limit until the user stops it, and a foreground service (`CollectorService`)
takes a reading every 15 seconds, uploads every 5 minutes and runs a speed
test over mobile data every 30 minutes, skipped below 20% battery unless the
phone is charging. The employee tabs are on.

### 14.2 SDK entry points

Call `init` from `Application.onCreate()`, not from an Activity: WorkManager
restarts the process in the background and needs the configuration.

```kotlin
NetTelemetry.init(context, TelemetryConfig(endpointUrl = "...", apiKey = "tel_..."))

NetTelemetry.startShare(capMinutes = 60)   // returns the end time
NetTelemetry.stopShare()
NetTelemetry.optIn(); NetTelemetry.optOut(); NetTelemetry.isOptedIn()

NetTelemetry.startDriveTest(context, share = true)
NetTelemetry.stopDriveTest(context)
NetTelemetry.currentDriveSessionId()
NetTelemetry.routeTrail(); NetTelemetry.driveSessions()

NetTelemetry.readLiveSample { }; NetTelemetry.readCellsNow { }
NetTelemetry.sampleNow(); NetTelemetry.uploadNow(); NetTelemetry.getStatus()

NetTelemetry.setPushToken(token)           // from FirebaseMessagingService.onNewToken
NetTelemetry.answerSampleRequest()         // on a sample_request push
NetTelemetry.reportSpeedTest(...)
NetTelemetry.enrollForRescue(msisdn); NetTelemetry.optOutOfRescue()
NetTelemetry.setDriveTestConsent(true)
NetTelemetry.setEnvironment(context, "indoor")   // "outdoor", "indoor", "vehicle" or null; cleared at stop
NetTelemetry.environment(context)
```

### 14.3 Configuration (`TelemetryConfig`)

| Field | Default | Meaning |
|---|---|---|
| `endpointUrl` | required | Full URL of `samples/` |
| `apiKey` | null | The shared ingest key |
| `samplingIntervalMinutes` | 15 | Android's floor for periodic work is 15 |
| `uploadIntervalMinutes` | 30 | How often the queue is sent |
| `uploadOnlyOnUnmetered` | true | Wait for Wi-Fi |
| `minHandoverSampleIntervalSeconds` | 120 | Gap between cell-change readings |
| `rescueEnrollUrl`, `driveTestConsentUrl`, `driveTestConsentMessageUrl`, `speedSamplesUrl`, `pushTokenUrl`, `callSamplesUrl` | null | Each feature is off until its URL is set |
| `defaultOptIn` | false | Keep false unless the app's own terms cover collection from install |
| `deviceApiUrl` | null | Base of the device endpoints; null takes it from `endpointUrl` |

Registration, signing, number verification, speed test and problem report
are in the SDK (`device` package, section 14.6). The trace request screens
and service and the site photo screen stay in the reference app
(`TracePush`, `TraceSharingService`, `SitePhotoActivity`) and call the SDK's
`DeviceApi`.

### 14.4 Permissions

- SDK: `ACCESS_FINE_LOCATION`, `READ_PHONE_STATE`, `ACCESS_NETWORK_STATE`,
  `INTERNET`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`.
- App: `POST_NOTIFICATIONS`, `CAMERA` (asked only when the photo screen opens),
  `ACCESS_WIFI_STATE`, `CHANGE_WIFI_STATE`, `CHANGE_NETWORK_STATE` (speed test
  over mobile data), `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
- Not requested: `ACCESS_BACKGROUND_LOCATION`.

### 14.5 Behaviour to know when testing

- Battery restrictions stop push messages reaching an idle phone. The app
  offers a button to lift them, and a second one for Huawei start-up settings.
- A drive test records a fix every 2 seconds and drops fixes worse than 30 m.
- Past drives stay on the phone. Deleting one there does not delete it on the server.
- Error messages shown to the user are general. Details go to the device log.
- SINR and CQI: many modems leave them blank in `getAllCellInfo()` but report
  them in `getSignalStrength()` (seen on an Oppo CPH2569). Since 19 October
  2026 the SDK fills a blank from the same SIM's `getSignalStrength()`
  (Android 10 and later).
- The upload queue (`SampleQueue.kt`) uses one lock per queue file shared by
  every instance, keeps its line count instead of re-reading the file, trims
  500 lines past the cap at a time, and reads a batch without loading the
  whole file. The SDK's first unit tests cover it:
  `:netplanning-telemetry-sdk:testReleaseUnitTest`.
- iOS does not expose cell or signal figures to apps, so there is no iOS
  equivalent of the signal collection.

### 14.6 Using the SDK from the Nepal Telecom app (Flutter)

The Nepal Telecom customer app (`shirantech.android.nepaltelecom`, 4.0.49
checked on 16 October 2026) is a Flutter app: its APK carries
`libflutter.so`, `libapp.so` and `assets/flutter_assets`. The proposal is to
add NTC telemetry to that app as a **Flutter plugin**, not to rewrite either
side. On Android the plugin calls the Kotlin SDK as it is; on iOS it offers
only what Apple allows.

**What each platform can do**

| Feature | Android | iOS |
|---|---|---|
| Signal level, quality, serving and neighbour cells, band | Yes | No: iOS has no API for these |
| Network type (4G, 5G, 3G) | Yes | Yes, coarse |
| Shared readings with position | Yes | Position and network type only, while the app is open or with "Always" location |
| Drive test | Yes | Route and speed only |
| Collector (a reading every 15 s all day) | Yes | No: iOS suspends background work |
| Speed test over mobile data, also while on Wi-Fi | Yes | Yes |
| Report a problem | Yes, with the reading | Yes, without signal figures |
| Register the phone and sign requests (EC P-256 key) | Android Keystore | Secure Enclave, same key type and signature |
| Prove the number by SMS code | Yes | Yes. iOS cannot read the number from the SIM, so the user always types it |
| Device check at registration | Play Integrity | App Attest |
| Push: reading requests, location requests | FCM | FCM through Apple's push service |
| Rescue position during a declared emergency | Yes | Yes |
| Calls (voice network during a call) | Yes | Start and end only |

The server needs no change for iOS. A reading with no radio fields is
already accepted, and the signing scheme (section 7.2) is the same.

**Device features are in the SDK (16 October 2026).** Registration,
signing, number verification, speed test and problem report used to live in
the reference app. They are now in the SDK's `np.nepaltelecom.telemetry.device`
package, without any screen, and the reference app calls them:

```kotlin
NetDevice.register(context, msisdn, userType = "general") { ok, error -> }  // key, registration, retry, sdk-link
NetDevice.isRegistered(context); NetDevice.number(context)
NetDevice.sendNumberCode(context); NetDevice.confirmNumberCode(context, code)  // blocking
NetDevice.setOnRegistered { ctx -> /* e.g. upload the push token */ }
SpeedTest.runOnMobileData(context, fallback = false); SpeedTest.runOnWifi(context)  // blocking
NetProblem.send(context, category, note)   // blocking; reading + speed test + report
ProblemHints.explain(sample, speed)        // the on-phone likely cause
DeviceApi.*                                // the raw device endpoints
```

The server address comes from `TelemetryConfig.deviceApiUrl`, or from
`endpointUrl` when that is null. The SDK signs its own uploads once the phone
is registered (a provider in its manifest installs the signer), so a host
app needs no setup for that. The stored state and the key alias are the ones
the reference app used, so phones registered with an older build stay
registered.

**Built for Android (16 October 2026):** `flutter/ntc_telemetry` in the
mobile project, version 1.1.0, with its own README for the app team. It
carries the SDK as a library package in `android/sdk-repo`, so the app needs
no Gradle change. `init` saves its settings and a start-up provider sets the
SDK up again whenever Android starts the app in the background. The SDK
and plugin install on Android 7.0 (API 24), as the Nepal Telecom app does,
but work only on Android 8.0 and newer: below that `NetTelemetry.isSupported()`
is false, nothing is scheduled, and the plugin's calls answer `unsupported`
(`NtcTelemetry.supportedOnThisPhone()` tells the app to hide its screens).
The SDK now also declares approximate location next to precise location;
Android 12+ expects both in one runtime request. Tested: Dart calls against a
stand-in for the Android side, and the example app builds with every
component merged. Not yet run on a phone.

**Plugin layout as first planned** (one Flutter package, `ntc_telemetry`;
the iOS part is not built)

- `lib/ntc_telemetry.dart`: the Dart calls below, over a method channel and
  an event channel for live readings.
- `android/`: Kotlin, depends on the SDK `.aar`, forwards each call.
- `ios/`: Swift. Location (Core Location), network type (Core Telephony),
  speed test (`URLSession` limited to cellular), key and signing (Secure
  Enclave, CryptoKit), App Attest, upload queue. Same endpoints and request
  body as Android.
- `example/`: a small app to test the plugin by itself.

```dart
await NtcTelemetry.init(endpoint: '...', apiKey: null);  // key-less once signed uploads are required
await NtcTelemetry.register(msisdn: '98XXXXXXXX');
await NtcTelemetry.sendNumberCode(); await NtcTelemetry.confirmNumberCode('123456');
await NtcTelemetry.startShare(minutes: 60); await NtcTelemetry.stopShare();
await NtcTelemetry.startDriveTest(share: true); await NtcTelemetry.stopDriveTest();
final r = await NtcTelemetry.speedTest(bearer: Bearer.mobile);
final p = await NtcTelemetry.reportProblem(category: 'slow_data', note: '...');
NtcTelemetry.liveReadings.listen((s) { /* null signal fields on iOS */ });
final caps = await NtcTelemetry.capabilities();  // what this platform supports
```

`capabilities()` lets the app hide what a platform cannot do, rather than
the app checking for iOS itself.

**Where it fits in the customer app.** The app already has a complaint
screen; "Report a problem" can sit there and send the reading and a speed
test with the complaint. The app's own login knows the customer's number,
which can feed `register` (SMS verification still proves it on the phone).

**Building.** The Android side builds on any PC with the Flutter SDK. The
iOS side needs a Mac with Xcode (or a hosted macOS build service) and NTC's
Apple developer account for signing, App Attest and push.

## 15. What is open

| Item | Who | Why it matters |
|---|---|---|
| Carrier-privileged status for the app | NTC, app team | Read the number from the SIM; read IMEI; measure call quality |
| Play Integrity at registration | App team, with the Google Cloud project | A copied or modified app can register today. The server check exists and is switched off |
| Retire the shared key | App team, Puru | Registered phones sign every upload and rescue request. Unregistered phones still use the shared key, which is in the APK. The server refuses rescue enrolment with it after `RESCUE_SHARED_KEY_ACCEPTED_UNTIL`, and all uploads with it after `TELEMETRY_SHARED_KEY_ACCEPTED_UNTIL` (not set; to be chosen from `manage.py shared_key_usage` on the live server) |
| Send SINR | App team | Filled from the overall signal reading since 19 October 2026; check on more phone models |
| Staff login in the app | App team, NTC identity team | "NTC employee" is a tick box. Site photos rest on registration, distance and admin review instead |
| Firebase project owned by NTC | App team | Push for reading requests and location requests |
| Public route to the device API | NTC network team | The live server is reachable only inside NTC or over VPN |
| Push end to end on the live server | Puru | A reading request was not delivered on 12 October 2026 |
| Publishing | App team | The app is installed on a few test phones only |
| Flutter plugin for the Nepal Telecom app (section 14.6) | App team, Puru | Brings telemetry to the customer app on both platforms without a rewrite |
| Mac, Xcode and NTC's Apple developer account | NTC | Needed to build, sign and test the iOS side |

## 16. Who to ask

Server, keys, and whether data is arriving: Puru. This document describes the
server as of 24 October 2026. If something here disagrees with what the server
returns, the server is right; please report the difference.
