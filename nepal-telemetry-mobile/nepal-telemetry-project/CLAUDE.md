# nepal-telemetry-project — Project Brief

> This directory (`nepal-telemetry-project/nepal-telemetry-project/`) is the active project.
> It is a **different deliverable** from the `bts_monitor.html` dashboard described in the
> parent-folder `CLAUDE.md` (`../../CLAUDE.md`) — that brief does not apply to work in here.
> This is the Android telemetry SDK that *feeds* the `bagalewatch-v2` backend
> (`../../bagalewatch-v2/`, Django ingestion at `core/telemetry.py`).

## Project Overview

A ready-to-open **Android Studio / Gradle** project with two modules:

- **`netplanning-telemetry-sdk`** — the actual deliverable. The mobile-app integration
  layer for Nepal Telecom's crowdsourced coverage / drive-test pilot: background
  cell + signal + GPS sampling, local JSONL queueing, batched Wi-Fi-preferred upload,
  opt-in gating enforced at the collection layer, pseudonymous per-device UUID.
  **No UI by design** — the pilot's opt-in screen, "your signal quality" view, and
  dashboard are a separate front-end effort.
- **`app`** — a minimal demo/test harness (5 buttons: Opt In, Opt Out, Sample Now,
  Refresh Status, Upload Now + a status readout). **Not** the pilot's real UI. Exists
  only so the SDK can be compiled, installed, and exercised on a real device.

**Why the project exists:** the SDK was written and line-by-line audited against real
Android API signatures in an environment with **no Android SDK, no emulator, no Google
Maven access** — so it had never been compiled. This wrapper project exists to build it
for real in Android Studio. As of 2026-08-31 it **compiles and runs** (CLI Gradle build
+ full button-flow smoke test on an API 34 emulator — see "Build & Run" below); two bugs
that surfaced in that pass are fixed (see "Fixes applied"). **Still outstanding: a run on
real OEM hardware across a couple of vendors** before this goes near a pilot subscriber.

**Tech stack:** Kotlin 2.0.21 · AGP 8.5.2 · Gradle 8.7 · `minSdk 26` / `compileSdk 34` /
`targetSdk 34` · AndroidX WorkManager (`work-runtime-ktx 2.9.1`) · `security-crypto
1.1.0-alpha06` (EncryptedSharedPreferences) · `play-services-location 21.3.0`
(FusedLocationProviderClient) · kotlinx-coroutines 1.8.1 · `org.json` · plain
`HttpURLConnection` (no Retrofit/OkHttp dependency, deliberately)

---

## Current Status

**Done (built + smoke-tested on an API 34 emulator, 2026-08-31):**
- Full SDK surface — `NetTelemetry.init / optIn / optOut / isOptedIn / getStatus / sampleNow / uploadNow`
- `CellSampleCollector` — reads serving cell (LTE/UMTS/GSM/NR) via `TelephonyManager.getAllCellInfo`
  + one-shot GPS via `getCurrentLocation`; `Int.MAX_VALUE`/`UNAVAILABLE` sentinels → null
- `HandoverListener` — `TelephonyCallback` (API 31+) / `PhoneStateListener` (26–30) split;
  NR / API-gated classes isolated behind `SDK_INT` checks to avoid ART class-verification failures
- `SamplingWorker` (periodic, ≥15 min floor) + `UploadWorker` (batched 200, Wi-Fi-by-default,
  WorkManager exponential backoff, `ExistingPeriodicWorkPolicy.KEEP`)
- `SampleQueue` — append-only JSONL file, `ReentrantLock`, `MAX_QUEUED_SAMPLES = 5000` (drops oldest)
- `DeviceIdentity` — pseudonymous UUID + opt-in flag in EncryptedSharedPreferences,
  falls back to plain prefs on Keystore failure; opt-in defaults to **false**
- `Sample` — flat JSON model; custom `optIntOrNull`/`optLongOrNull`/`optDoubleOrNull`
  because `JSONObject.optX` returns 0 for absent keys (would corrupt legitimate zeros)
- Demo `app` — `DemoApplication` calls `init()` in `Application.onCreate()` (not an Activity),
  `MainActivity` wires the 5 buttons + runtime permission request

**Added 2026-09-01 (built + emulator-verified):**
- Last GPS fix in `TelemetryStatus` — `lastLat` / `lastLon` / `lastFixAccuracyM` /
  `lastFixAtMs` (all nullable, defaulted `null` so existing constructor/test call sites
  still compile). `SampleQueue.append()` stashes the fix in the `netplanning_telemetry_state`
  prefs (doubles as raw bits — no `putDouble`; accuracy uses `NaN` = absent) only when the
  sample actually carried one, so a later cell-only sample never blanks it;
  `SampleQueue.lastKnownFix()` reads it back as an internal `LastFix`; `getStatus()` flattens
  that onto the four public fields. Demo `MainActivity.refreshStatus()` shows a
  `Last GPS fix: <lat>, <lon> (±N m) at <date>` line (or `none`). Verified: a GPS sample
  populates the line; a subsequent location-disabled sample advances `Last sample at` but
  leaves the fix line unchanged.
- `NetTelemetry.uploadNow()` — enqueues a one-time `UploadWorker` (no unmetered
  constraint, unlike the periodic schedule) for a host "sync now" affordance / backend
  testing without the periodic wait. No-ops when not opted in. Demo `MainActivity` adds
  an **Upload Now** button (5th button) that calls it and toasts a pointer to the
  `NetTelemetry.Upload` logcat tag for the real result.

**Verified on emulator:** `assembleDebug` succeeds (AGP 8.5.2 / Kotlin 2.0.21 / Gradle 8.7
/ the listed library versions do compile together). On an API 34 AVD: opt-in schedules the
two WorkManager jobs, periodic + handover + manual samples all land in the JSONL queue with
LTE cell/signal/battery fields, GPS populates when a fix is available, opt-out wipes the
queue, and state survives an app-data-preserving reinstall and an emulator reboot (queue
kept growing after cold boot — WorkManager re-registered via `Application.onCreate()`).

**Not verified / outstanding:**
- **Never run on real OEM hardware.** WorkManager background relaunch on a real device,
  OEM signal-callback quirks, `getAllCellInfo()` on a live Nepal Telecom SIM,
  EncryptedSharedPreferences on odd OEMs — all still untested off the emulator.
- Emulator telephony is a fake US carrier (`mcc 310 / mnc 260`), not Nepal Telecom.
- Demo `apiKey` is a literal `REPLACE_WITH_TEL_KEY_FROM_telemetry_key_create` placeholder;
  nothing has actually been POSTed to a live bagalewatch-v2 ingestion endpoint yet.

**Deliberately not here:** launcher icon resources, CI config, signing config, ProGuard/R8
rules beyond the SDK's `consumer-rules.pro`, any UI beyond the 5-button harness, a backend,
iOS (CoreTelephony doesn't expose cell ID / signal metrics to third-party apps).

---

## Architecture / Structure

```
settings.gradle.kts            include(":app", ":netplanning-telemetry-sdk"); repos: google + mavenCentral
build.gradle.kts              root — plugin versions declared once with `apply false`
gradle.properties             AndroidX on, nonTransitiveRClass, parallel
local.properties              sdk.dir (machine-local, not for VCS)
gradle/wrapper/               Gradle 8.7

netplanning-telemetry-sdk/
  build.gradle.kts            com.android.library, namespace np.nepaltelecom.telemetry
  consumer-rules.pro          empty (no keep rules needed)
  src/main/AndroidManifest.xml  ACCESS_FINE_LOCATION, READ_PHONE_STATE, ACCESS_NETWORK_STATE,
                                INTERNET; ACCESS_BACKGROUND_LOCATION commented out on purpose
  src/main/kotlin/np/nepaltelecom/telemetry/
    NetTelemetry.kt            public API (object) + `internalConfig` top-level var
    TelemetryConfig.kt         host-tunable settings; effectiveSamplingIntervalMinutes clamps ≥15
    TelemetryStatus.kt         read-only snapshot for host UI (opt-in, queue count,
                               last-sample-at, last-upload-at, + last GPS fix:
                               lastLat/lastLon/lastFixAccuracyM/lastFixAtMs, all nullable)
    model/Sample.kt            one reading + to/fromJson
    collector/CellSampleCollector.kt   TelephonyManager + FusedLocationProviderClient → Sample
    collector/HandoverListener.kt      event-triggered sampling (process-alive only)
    collector/SamplingWorker.kt        periodic WorkManager tick
    storage/DeviceIdentity.kt          pseudonymous ID + opt-in flag (EncryptedSharedPreferences)
    storage/SampleQueue.kt             local JSONL offline queue; also remembers
                                       last-sample-at + last GPS fix in a side prefs
                                       file (survive a row being uploaded/removed)
    upload/TelemetryApi.kt             HttpURLConnection POST of a JSON array batch
    upload/UploadWorker.kt             periodic constrained batched upload

app/
  build.gradle.kts            com.android.application, applicationId np.nepaltelecom.telemetry.demo
  src/main/AndroidManifest.xml  no permissions (merged from SDK module); networkSecurityConfig
  src/main/kotlin/np/nepaltelecom/telemetry/demo/
    DemoApplication.kt        NetTelemetry.init() with TelemetryConfig pointing at bagalewatch-v2
    MainActivity.kt           5 buttons + status TextView + runtime permission launcher
  src/main/res/                activity_main.xml, strings.xml, themes.xml, xml/network_security_config.xml
```

**Data flow:**

```
periodic tick (SamplingWorker, ≥15 min)  ─┐
handover/signal change (HandoverListener) ─┼─► CellSampleCollector.collect(reason)
host "check now" (NetTelemetry.sampleNow) ─┘        │  (opt-in gate + FINE_LOCATION check first)
                                                     ▼
                                    Sample  ──► SampleQueue.append()  (JSONL file, cap 5000)
                                                     │
                        UploadWorker (periodic, unmetered-by-default constraint)
                                                     ▼
                        TelemetryApi.uploadBatch(peek 200)  ──POST JSON array──►  TelemetryConfig.endpointUrl
                                                     │ on 2xx: SampleQueue.remove(batch)
                                                     ▼
                        bagalewatch-v2 Django  core/telemetry.py → TelemetryIngestView
```

**Demo endpoint wiring (`DemoApplication.kt`):** `http://10.0.2.2:5180/api/telemetry/v1/samples/`
— `10.0.2.2` is the standard AVD host-loopback alias (Genymotion uses `10.0.3.2`); host port
`5180` is the bagalewatch-v2 frontend nginx container, whose `/api/` proxies to `django:8000`
(the django container publishes no host port). For bare `manage.py runserver 0.0.0.0:8000`,
use `:8000`. Cleartext to `10.0.2.2` only is whitelisted in `network_security_config.xml`.
A real pilot uses an HTTPS endpoint and needs no cleartext exception.

---

## Build & Run

**Preferred: Android Studio.** "Open" this folder (the one with `settings.gradle.kts`, not
the outer nesting level), let Gradle sync (needs internet on first run), pick the `app`
run config, run on an API 26+ device/emulator. Studio's own Gradle integration is not
affected by the CLI wrapper caveat below.

**CLI build (what was used on 2026-08-31):**

- Needs **JDK 17** (AGP 8.5.2). `JAVA_HOME` → a 17 JDK; Temurin 17 works.
- **Path caveat — the wrapper cannot run from its real location.** `gradlew.bat` (the
  Gradle 8.7 template) does an unquoted `set DIRNAME=%~dp0`; the parent path
  `…BAGALEWATCH BTS RAN O&M MANAGEMENT…` contains `&`, which cmd splits mid-command
  (`'M' is not recognized`). Work around it by mapping the project to a clean drive:
  ```
  subst N: "C:\Users\HP\…\nepal-telemetry-project\nepal-telemetry-project"
  cd /d N:\ && N:\gradlew.bat --no-daemon --console=plain assembleDebug
  subst N: /D          # unmap when done
  ```
  Not a project bug — any batch-based tool hits it; Android Studio does not.
- Outputs: `app/build/outputs/apk/debug/app-debug.apk`,
  `netplanning-telemetry-sdk/build/outputs/aar/netplanning-telemetry-sdk-debug.aar`.

**Run the demo on an emulator (headless-friendly):**

```
emulator -avd nt_pixel_api34 -no-snapshot-save -no-boot-anim -gpu swiftshader_indirect
adb wait-for-device
# until: adb shell getprop sys.boot_completed  == 1
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n np.nepaltelecom.telemetry.demo/.MainActivity
```

- **Skip the permission dialog** (drive it from adb):
  ```
  adb shell pm grant np.nepaltelecom.telemetry.demo android.permission.ACCESS_FINE_LOCATION
  adb shell pm grant np.nepaltelecom.telemetry.demo android.permission.ACCESS_COARSE_LOCATION
  adb shell pm grant np.nepaltelecom.telemetry.demo android.permission.READ_PHONE_STATE
  ```
  With these granted, the **Opt In** button calls `NetTelemetry.optIn()` directly (no dialog).
- **GPS in samples on this AVD:** `adb emu geo fix` does **not** reach GMS
  `FusedLocationProviderClient` on the `google_apis` (non-Play-Store) image — samples come
  out with null `lat`/`lon` (the SDK handles that correctly; nullable fields). Inject a
  platform mock location instead, and keep re-pushing it during the SDK's ~10 s
  `getCurrentLocation` window:
  ```
  adb shell appops set 2000 android:mock_location allow
  for p in fused gps; do
    adb shell cmd location providers add-test-provider $p --supportsAltitude --supportsSpeed --supportsBearing
    adb shell cmd location providers set-test-provider-enabled  $p true
    adb shell cmd location providers set-test-provider-location $p --location 27.7172,85.3240 --accuracy 5
  done
  ```
- **Inspect the on-device queue:**
  `adb shell run-as np.nepaltelecom.telemetry.demo cat files/netplanning_telemetry_queue.jsonl`
- **Clean slate:** `adb shell pm clear np.nepaltelecom.telemetry.demo` (wipes the opt-in
  flag, the pseudonymous UUID, the queue, and cancels the WorkManager jobs; also resets
  the runtime permission grants). `adb install -r` alone keeps all app data.

---

## Fixes applied

1. **Invalid `--` in XML comments** (commit `9bdb7c9`) — `<!-- … -->` may not contain a
   literal double-hyphen. Four occurrences (prose em-dashes) in `netplanning-telemetry-sdk/
   src/main/AndroidManifest.xml`, `app/src/main/AndroidManifest.xml`, and
   `app/src/main/res/xml/network_security_config.xml` made `processDebugManifest` /
   resource parsing fail. Replaced with a real em-dash. **The `--` prose style used
   throughout the Kotlin comments is fine in `.kt`, never inside an XML comment.**
2. **`device_id` race on first opt-in** (commit `f10cee0`) — `DeviceIdentity.deviceId`
   generated the pseudonymous UUID with a non-atomic read-generate-`apply()`. On the
   first `optIn()`, `SamplingWorker` and `HandoverListener` hit the getter within ~1 ms,
   before either `apply()` committed, and each minted its own UUID — the first few samples
   were split across two "devices" (reproduced on the emulator: periodic + handover 1 ms
   apart, two ids). Now serialized on a private process-wide monitor (`ID_LOCK`) with a
   synchronous `commit()`. Re-verified: periodic + handover 4 ms apart plus 10 concurrent
   `sampleNow()` calls → all 12 samples share one `device_id`.

---

## Decisions Log

- **SDK is the deliverable; `app` is scaffolding.** The pilot's real front end (consent
  screen, signal view, dashboard) is a separate effort. Don't build UI into the SDK module.
- **Opt-in enforced in code, not just UI.** `DeviceIdentity.optedIn` defaults false;
  `CellSampleCollector.collect()` and both workers re-check it. No API accepts IMEI /
  Android ID / MSISDN — the only device identifier is a locally generated UUID.
- **`DeviceIdentity.deviceId` first-read generation is lock-guarded + `commit()`ed**, not
  `apply()`ed — several collectors can call it concurrently right after `optIn()`. Do not
  "simplify" it back to a bare `apply()` (see "Fixes applied" #2).
- **`init()` must run in `Application.onCreate()`**, never an Activity. WorkManager
  relaunches the process in the background; if `internalConfig` is null when a worker
  runs, it silently no-ops. The demo's `DemoApplication` exists to model this correctly.
- **Flat JSONL file, not SQLite/Room.** Pilot scale = one device, capped backlog, flushed
  every cycle. Easy to inspect by hand. Revisit only when it needs to scale.
- **`HttpURLConnection`, not Retrofit/OkHttp.** Host apps carry their own networking stack;
  don't force a second, possibly conflicting one. `TelemetryApi` is swappable in isolation.
- **15-minute sampling floor.** `PeriodicWorkRequest` enforces it; `TelemetryConfig` clamps
  to the same value up front. Finer responsiveness comes from `HandoverListener` — but only
  while the host process is alive, never while fully backgrounded/killed.
- **`ACCESS_BACKGROUND_LOCATION` commented out.** Declaring it triggers Play Console review
  scrutiny. Foreground/recently-backgrounded sampling works without it. Host-app decision.
- **API-31+ / NR classes isolated behind `SDK_INT` checks in separate methods/fields.**
  Referencing a class that doesn't exist on the running device makes ART's class
  verification choke even in a dead branch — keep such references out of always-loaded code.
- **Custom `optXOrNull` JSON helpers.** `JSONObject.optInt`/`optDouble` return 0/0.0 for
  absent keys, which silently corrupts any metric that could legitimately be zero.
- **Last GPS fix for `getStatus()` lives in the side prefs, not read from the queue file.**
  Same rationale as `last_sample_at_ms`: the row that carried the fix disappears the moment
  it uploads, but a host "your last known location" readout should still answer. Written in
  `SampleQueue.append()` and **only when `sample.lat != null && sample.lon != null`** — a
  cell-only sample (no fix available) must not overwrite a good earlier position. Do not
  "simplify" it to always write, or to scan the queue instead.

---

## Known Issues / TODO

_(Build + emulator smoke test: done 2026-08-31 — see "Current Status" / "Build & Run".)_

1. **Run on real OEM hardware.** A couple of vendors, a live Nepal Telecom SIM. Check
   WorkManager background relaunch after real process death, `getAllCellInfo()` on a real
   modem, `TelephonyCallback` on API 31+, EncryptedSharedPreferences on odd OEMs.
2. **`app` `apiKey` placeholder** — generate a real key via bagalewatch-v2
   `python manage.py telemetry_key create "android-pilot"` (printed once, unrecoverable),
   then actually POST a batch to a running ingestion endpoint (nothing has been uploaded
   end-to-end yet — the queue only drains on a 2xx).
3. **Verify against bagalewatch-v2 ingestion** — confirm the `Sample.toJson()` field names
   (`device_id`, `ts`, `rsrp_dbm`, …) match what `core/telemetry.py` `TelemetryIngestView`
   expects. The two were written separately.
4. **`git remote`** — the repo is local only (`git init` done 2026-08-31, branch `main`);
   no remote configured, deliberately, pending a decision on where it lives.
5. **Directory nesting** — project root is doubly nested
   (`nepal-telemetry-project/nepal-telemetry-project/`); the outer folder holds only a
   stale `.idea/`. The git repo is at the inner (correct) level.

---

## Conventions

- **Package:** `np.nepaltelecom.telemetry` (SDK), `np.nepaltelecom.telemetry.demo` (app).
  Kotlin sources under `src/main/kotlin/`, not `src/main/java/`.
- **Visibility:** SDK internals are `internal`; only `NetTelemetry`, `TelemetryConfig`,
  `TelemetryStatus`, and `Sample` are `public`. Keep it that way — the public surface is
  the contract with the host app.
- **Naming:** classes `PascalCase`, functions/props `camelCase`, consts `UPPER_SNAKE`
  in `companion object`. WorkManager unique-work names are the `netplanning_telemetry_*`
  string constants in `NetTelemetry`.
- **JSON keys:** `snake_case` (`device_id`, `rsrp_dbm`, `trigger_reason`). `triggerReason`
  values: `"periodic"` | `"handover"` | `"manual"`.
- **`networkType` values:** `"LTE"` | `"NR"` | `"UMTS"` | `"GSM"` | `"UNKNOWN"`.
- **Permissions:** the SDK never requests permissions — it checks and returns no sample if
  missing. Requesting is the host app's job (`MainActivity` shows the pattern).
- **No new third-party dependencies** without a reason — the "don't force a networking stack"
  principle applies broadly. WorkManager, security-crypto, play-services-location,
  coroutines, core-ktx are the whole list.
- **Nullable signal fields** — not every radio generation reports every metric; a GSM/UMTS
  reading has no RSRP/RSRQ/SINR. Never coerce these to 0.
