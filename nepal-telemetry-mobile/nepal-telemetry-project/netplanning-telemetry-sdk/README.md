# netplanning-telemetry-sdk

The mobile-app integration layer for the crowdsourced coverage/drive-test
pilot described in the network-planning brief. This is **only** that layer:
background collection, local queueing, and upload. It has no UI of its own —
the opt-in screen, any "your signal quality" view, and the pilot dashboard
are a separate front-end effort, by design (this project's own task split).

## Verification status -- read this first

This was written in an environment with no Android SDK, no emulator, and no
reachable Android/Google Maven repository (dl.google.com returned 403 from
that sandbox's network egress) -- so **it has not been compiled or run**,
the same limitation flagged earlier for the Kotlin/Swift reference sketches
in the disaster-response prototype. This module is a step up from those
sketches in one respect: every file here was manually re-audited line by
line against the real Android/AndroidX/Play Services API signatures after
first-draft writing, and two real mistakes were caught and fixed in that
pass (an `Int` value was being called with a `Long`-parsing stdlib method
that doesn't exist for `Int`; a status method was reading the *oldest*
queued sample instead of the *most recent* one). That review closes the
easy-to-catch category of error, not the category only a real compiler and
a real device can catch. **Building this against a real Android Studio
project, on a real device across a couple of OEMs, is still the first thing
that should happen with it before it goes anywhere near a pilot subscriber.**

## What it does

- Reads serving-cell ID, PCI, TAC, MCC/MNC, RSRP/RSRQ/RSSI/SINR and network
  generation via Android's public `TelephonyManager` APIs (Android-only --
  see the network-planning brief for why iOS can't provide this).
- Reads a one-shot GPS fix (via `FusedLocationProviderClient`) alongside
  each cell reading -- not a continuous location lock, to keep GPS-on time
  minimal.
- Samples on two triggers: a periodic background tick (WorkManager, floor
  of 15 minutes -- see "Why 15 minutes" below) and opportunistically when
  the serving cell or signal strength changes while the host app process is
  alive (throttled to at most once per `minHandoverSampleIntervalSeconds`).
- Queues samples locally (a flat JSONL file, not a database -- see the
  comment in `SampleQueue.kt` for why that's a deliberate choice at pilot
  scale) and flushes them in batches on its own schedule, by default only
  over an unmetered (Wi-Fi) connection so the pilot doesn't consume
  subscribers' mobile data.
- Enforces its own opt-in gate at the collection layer, not just in the
  host app's UI: `NetTelemetry.optIn()` / `.optOut()` are the only way
  collection starts or stops, and `CellSampleCollector` refuses to collect
  anything if the stored opt-in flag is false, regardless of what else
  calls it.
- Uses a locally generated pseudonymous UUID as the only device identifier
  -- never IMEI, Android ID, or the subscriber's MSISDN. See
  `DeviceIdentity.kt`.

## Integrating into Nepal Telecom's app

1. Add this as a module (e.g. `:netplanning-telemetry-sdk`) in the host
   app's `settings.gradle.kts`, and add
   `implementation(project(":netplanning-telemetry-sdk"))` to the host
   app's own `build.gradle.kts`.

2. Call `NetTelemetry.init()` from the host **Application** class, not an
   Activity:

   ```kotlin
   class NepalTelecomApp : Application() {
       override fun onCreate() {
           super.onCreate()
           NetTelemetry.init(
               this,
               TelemetryConfig(
                   endpointUrl = "https://pilot-backend.example.np/api/telemetry",
                   apiKey = BuildConfig.TELEMETRY_API_KEY,
               ),
           )
       }
   }
   ```

   This matters: WorkManager can execute the sampling/upload workers after
   the app's process has been killed and relaunched by the OS in the
   background. If `init()` only ever ran inside an Activity that isn't
   reopened, `internalConfig` is null when that work runs and it silently
   no-ops. `Application.onCreate()` runs on every process start, including
   OS-triggered background relaunches.

3. Wire the host app's own consent screen to `NetTelemetry.optIn()` /
   `optOut()`. Nothing collects before `optIn()` is called at least once.

4. Request `ACCESS_FINE_LOCATION` (and `READ_PHONE_STATE`, needed on some
   OEMs) through the host app's own runtime permission flow before calling
   `optIn()` -- the SDK checks for the permission and simply returns no
   sample if it's missing, it doesn't request permissions itself (that's a
   UI concern, kept out of this module deliberately).

5. If the host app wants a "check my signal now" button, call
   `NetTelemetry.sampleNow()`; for a status display, call
   `NetTelemetry.getStatus()`.

## Why 15 minutes

`androidx.work.PeriodicWorkRequest` enforces a 15-minute floor -- values
below that are silently raised to 15 by WorkManager itself, which is why
`TelemetryConfig.samplingIntervalMinutes` clamps to the same floor rather
than let that surprise someone later. The handover-triggered listener is
what provides finer responsiveness than that between periodic ticks, but
only while the host app's process is alive; it is not a way to sample more
often while the app is fully backgrounded or killed. If the pilot needs
guaranteed sub-15-minute sampling even in that state, the only way to get
it on Android is a foreground service with its own persistent notification
-- a real UX and battery tradeoff, and a decision for Nepal Telecom's app
team, not something this module imposes on its own.

## Background location

`ACCESS_BACKGROUND_LOCATION` is deliberately left commented out in
`AndroidManifest.xml`. Declaring it requires a specific, reviewed
justification in Google Play Console and invites extra scrutiny at review
time. Without it, the SDK still samples correctly whenever the host app is
in the foreground or recently backgrounded (which is how WorkManager and
the handover listener behave by default); with it, background sampling is
more reliable across long backgrounding. Decide this with Nepal Telecom's
app team -- don't uncomment it by default.

## Privacy and efficiency at scale

Everything above already carries this discipline on the client side, worth
naming explicitly since it's a hard requirement, not a nice-to-have, the
moment this leaves a small pilot for Nepal Telecom's real subscriber base:
opt-in enforced at the collection layer itself (not just the host app's
UI), a pseudonymous UUID as the only device identifier (never IMEI,
Android ID, or MSISDN), encrypted local storage, no continuous GPS lock
(one-shot fixes only), a 15-minute sampling floor plus throttled
handover-triggered sampling instead of constant polling, and batched,
Wi-Fi-preferred uploads so per-device cost and data usage stay flat
regardless of how many devices are running this. None of that is optional
at real scale -- a corner cut here is invisible at pilot size and expensive
(in subscriber data cost, battery complaints, or privacy exposure) at
millions of devices.

The matching half of this lives in whatever backend receives the uploads,
which this module deliberately has no opinion on beyond
`TelemetryConfig.endpointUrl` (see below). Whoever builds that ingestion
service should carry the same discipline forward: data minimization
(store only the defined metric set, never derive subscriber identity from
it), retention enforced automatically rather than by policy someone has
to remember to run, encryption and scoped/audited access, and an
architecture (sharded/partitioned, rate-limited) sized for national
subscriber volume from the start rather than rebuilt for it later. See the
"Data governance" section of the network-planning brief for the fuller
version of this.

## What's deliberately not in this module

- Any UI: consent screens, a signal-quality view, a pilot dashboard.
- A backend. The upload target is just `TelemetryConfig.endpointUrl` --
  point it at whatever ingestion endpoint the pilot backend exposes. (A
  matching backend can be provided separately if useful -- ask.)
- iOS. Per the network-planning brief, iOS's CoreTelephony doesn't expose
  cell ID or signal metrics to third-party apps, so there is no equivalent
  RF-detail client to build there; an iOS build could still contribute GPS
  + coarse network-generation status if that's later worth doing.
- SMS-fallback transport, and the emergency-beacon use case from the
  companion NTA/NDRRMA note -- both out of scope for this pilot per the
  brief's scope table.

## File layout

```
build.gradle.kts                 Library module build config
src/main/AndroidManifest.xml     Permissions
src/main/kotlin/np/nepaltelecom/telemetry/
  NetTelemetry.kt                 Public API: init/optIn/optOut/getStatus/sampleNow
  TelemetryConfig.kt               Host-app-tunable settings
  TelemetryStatus.kt                Read-only status snapshot for the host app's UI
  model/Sample.kt                  One reading; JSON (de)serialization
  collector/CellSampleCollector.kt  Reads TelephonyManager + FusedLocationProviderClient
  collector/HandoverListener.kt     Event-triggered sampling on cell/signal change
  collector/SamplingWorker.kt       Periodic (>=15 min) WorkManager sampling tick
  storage/DeviceIdentity.kt         Pseudonymous ID + opt-in flag (EncryptedSharedPreferences)
  storage/SampleQueue.kt            Local JSONL offline queue
  upload/TelemetryApi.kt            Plain HTTP POST of a batch
  upload/UploadWorker.kt            Periodic, constrained (Wi-Fi-by-default) WorkManager upload
```
