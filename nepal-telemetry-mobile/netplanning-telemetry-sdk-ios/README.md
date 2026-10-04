# NetTelemetry (iOS)

The iOS counterpart of `../netplanning-telemetry-sdk` (the Android module) --
background collection, local queueing, and upload for the same crowdsourced
coverage pilot. Like the Android module, this is **only** that layer: no
consent screen, no "your signal quality" view, no dashboard. Those are the
host app's job on both platforms, by the project's own task split.

## Verification status -- read this first

Written in an environment with no macOS, no Xcode, and no way to compile or
run Swift at all (this sandbox is Linux-only) -- so, same limitation
flagged in the Android module's own README for that module, **this has not
been compiled or run.** Every file was written against stable, documented
Apple framework APIs (CoreLocation, CoreTelephony, Network.framework,
BackgroundTasks, Security/Keychain) and re-read carefully for the kind of
mistake a compiler would normally catch, but that review is not a
substitute for one. **Opening this in Xcode on a real Mac, fixing whatever
it flags, and testing on a real device are the first things that should
happen with this, before it goes anywhere near a pilot subscriber.** A
simulator is not enough on its own either -- the simulator has no real
cellular radio, so `CTTelephonyNetworkInfo` and carrier-name reads need a
real device with a real Nepal Telecom SIM to mean anything.

## Why this is scoped down compared to the Android SDK

The Android SDK reads serving-cell ID, PCI, TAC, MCC/MNC, and
RSRP/RSRQ/RSSI/SINR via `TelephonyManager.getAllCellInfo()`, a public
Android API available to any app with location permission. Apple's
CoreTelephony framework does **not** expose any of that to an ordinary
third-party app -- getting it requires a specific carrier entitlement
(e.g. `com.apple.CommCenter.fine-grained`) that Apple grants directly to a
carrier as a business relationship, not something obtainable through
app-side engineering effort. This pilot does not have that entitlement as
of this writing.

So this device honestly captures only:

- **GPS location** -- a one-shot `CLLocationManager` fix per sample, same
  "not a continuous lock" intent as Android's one-shot
  `FusedLocationProviderClient` request.
- **A coarse network-generation bucket** -- 2G/3G/4G/5G, derived from
  `CTTelephonyNetworkInfo`'s current radio access technology string. This
  tells you "this device is on LTE right now," not which cell, and carries
  **no signal-strength number of any kind.**
- **Wi-Fi vs. cellular**, via `Network.framework`.
- **Carrier name, best-effort only.** See
  `Sources/NetTelemetry/Collector/TelemetrySampleCollector.swift`'s
  `readCarrierName()` doc comment: Apple deprecated `CTCarrier` in iOS 16
  and its own release notes say the underlying values may come back as a
  placeholder rather than the real carrier for apps without a special
  entitlement. Treat any value this returns as unverified until checked on
  a real, current-iOS device with a real Nepal Telecom SIM.

No cell ID, no PCI/TAC, no RSRP/RSRQ/RSSI/SINR, no 2G RxQual, no 3G
RSCP/Ec-Io -- ever, on any iOS version, for any third-party app without
that carrier entitlement. This is Apple platform policy, not a gap to
close later in this module.

## Two things the backend does NOT currently store from this device

`core/telemetry.py`'s `coerce_sample()` on the backend only has columns for
the fields the Android SDK already sends. This SDK sends two additional
JSON keys the current backend does not have columns for and will silently
ignore (per that same function's own "data minimisation" docstring: *"any
extra keys in a sample are ignored"*):

- `connection_type` (`"wifi"` / `"cellular"` / `"unknown"`)
- `carrier_name` (best-effort, see above)

They're sent anyway so the wire format is already right the day someone
adds `connection_type`/`carrier_name` columns server-side (a small,
additive migration + two new fields in `coerce_sample()`/`_COPY_COLS` in
`core/telemetry.py`) -- until then, they simply don't show up in stored
samples or the Telemetry Admin pages. `network_type` itself needs no
backend change: this SDK maps its 2G/3G/4G/5G bucket onto the exact same
`GSM`/`UMTS`/`LTE`/`NR`/`UNKNOWN` vocabulary the backend already validates
(`_NET_TYPES` in `core/telemetry.py`), with `UNKNOWN` sent whenever the
device is on Wi-Fi (no cellular radio access technology applies).

## The other big platform difference: background scheduling is best-effort

Android's WorkManager genuinely runs close to its configured interval, process
killed and relaunched or not, because Android is designed to let scheduled
background work actually run. **iOS's `BGTaskScheduler` makes no such
promise.** `earliestBeginDate` is only the earliest a task may run --
actual execution is entirely up to iOS's own heuristics (recent app usage,
battery, Low Power Mode, whether the device is idle/charging overnight),
and can be minutes late, hours late, or effectively never for an app a
subscriber opens rarely. There is no setting or entitlement this SDK can
use to force Android-like reliability -- see
`Sources/NetTelemetry/Collector/SamplingScheduler.swift`'s header comment
for the full explanation and exactly which two task identifiers need to be
declared in the host app's Info.plist.

The foreground timer (`TelemetryConfig.foregroundSampleIntervalSeconds`,
default 120s) is this SDK's stand-in for Android's handover-triggered
listener, and it works differently for a real reason: iOS's CoreTelephony
has no public "serving cell/signal changed" callback for third-party apps
the way Android's `TelephonyCallback.SignalStrengthsListener`/
`CellInfoListener` do. So instead, while the host app is actually in the
foreground, this SDK just samples on a plain repeating timer -- more
frequent than the background task's interval, but only while the app is
open in front of the user, never merely "alive" the way Android's listener
manages.

## Integrating into Nepal Telecom's app

1. In Xcode: **File > Add Package Dependencies... > Add Local...**, point
   it at this `netplanning-telemetry-sdk-ios` folder, and add the
   `NetTelemetry` library product to the host app target.

2. Call `NetTelemetry.registerBackgroundTasks()` and
   `NetTelemetry.initialize(config:)` from the host app's launch path --
   `@main App`'s `init()` (SwiftUI) or
   `AppDelegate.application(_:didFinishLaunchingWithOptions:)` (UIKit) --
   **not** from a view that only appears after some user action:

   ```swift
   NetTelemetry.registerBackgroundTasks() // MUST run before launch finishes -- see SamplingScheduler.swift
   NetTelemetry.initialize(
       config: TelemetryConfig(
           endpointUrl: URL(string: "https://dtwatch.ntc.net.np/api/telemetry/v1/samples/")!,
           apiKey: "<a real tel_... ingest key from Telemetry Admin>",
       )
   )
   ```

   This matters for the same class of reason the Android README calls
   out for `Application.onCreate()`, even though the underlying mechanism
   is different: `BGTaskScheduler.register(forTaskWithIdentifier:...)`
   **must** run before the app finishes launching, or scheduling a task
   later crashes. See `ios-demo-app/README.md` for the exact file/line to
   put this in.

3. Add to the host app's **Info.plist**:
   - `NSLocationWhenInUseUsageDescription` -- a real, subscriber-facing
     string explaining why location is requested (App Store review
     requires this to be genuine, not boilerplate).
   - `UIBackgroundModes` -> array containing `processing`.
   - `BGTaskSchedulerPermittedIdentifiers` -> array containing
     `np.nepaltelecom.telemetry.sampling` and
     `np.nepaltelecom.telemetry.upload` (the exact strings
     `SamplingScheduler.samplingTaskIdentifier`/`.uploadTaskIdentifier`
     define -- keep these in sync if either ever changes).
   - Enable the **Background Modes** capability in the target's Signing &
     Capabilities tab (checking "Background processing") -- this writes
     the same `UIBackgroundModes` entry from the Xcode UI instead of by
     hand, either is fine.

4. Wire the host app's own consent screen to `NetTelemetry.optIn()` /
   `.optOut()`. Nothing collects before `optIn()` is called at least once
   -- same as Android.

5. Request location permission (`CLLocationManager
   .requestWhenInUseAuthorization()`) through the host app's own runtime
   permission flow before calling `optIn()` -- this SDK checks for the
   permission and simply returns no sample if it's missing, it does not
   request permission itself, same "that's a UI concern, kept out of this
   module" design as Android.

6. For a "check my signal now" button, call `NetTelemetry.sampleNow()`;
   for a "sync now" button, `NetTelemetry.uploadNow()`; for a status
   display, `NetTelemetry.getStatus()` -- identical names and semantics to
   the Android SDK.

## A privacy-relevant iOS difference worth knowing about

Android's SharedPreferences (this pilot's pseudonymous-ID store there) are
wiped automatically on uninstall -- a fresh install gets a fresh
pseudonymous ID for free. **iOS's Keychain is not wiped on uninstall by
default** -- a reinstall of the same app can read back a Keychain item a
previous install wrote, which would otherwise quietly break the "uninstall
= fresh identity" property this pilot's privacy design assumes. This SDK
handles it (see `Storage/DeviceIdentity.swift`'s doc comment: a
UserDefaults flag, which IS wiped on uninstall, is used to detect a
reinstall and force a fresh Keychain identity), but it's worth
understanding why that file looks the way it does rather than just reading
a Keychain value directly the way the Android SDK reads a SharedPreferences
value directly.

## Diagnosing a queue that never drains

Same idea as the Android README: `getStatus().queuedSampleCount` climbing
and not coming back down means samples are collecting but uploads are
failing. Every upload attempt logs under the unified-logging subsystem
`np.nepaltelecom.telemetry`, category `Upload` (`TelemetryApi.swift`) --
filter Console.app or `log stream --predicate 'subsystem ==
"np.nepaltelecom.telemetry"'` on a connected device for the HTTP status
and whatever body the server sent back, same 401/403/404/413/429
interpretation as the Android README describes. Call `uploadNow()` to
trigger an attempt immediately rather than waiting on
`BGTaskScheduler`'s unpredictable timing.

## What's deliberately not in this module

- Any UI: consent screens, a signal-quality view, a pilot dashboard --
  same as Android.
- A backend -- points at whatever `TelemetryConfig.endpointUrl` says, same
  backend the Android SDK already talks to.
- Real cell-level RF metrics (cell ID, PCI, TAC, RSRP/RSRQ/RSSI/SINR) --
  see "Why this is scoped down" above. Not a future TODO for this module;
  it would need Apple's carrier entitlement, a decision and a relationship
  between Nepal Telecom and Apple, not more code here.
- SMS-fallback transport, same as Android.
- A hand-written `.xcodeproj` -- see `Package.swift`'s header comment for
  why this ships as a Swift Package instead, and
  `../ios-demo-app/README.md` for how to actually run something with it.

## File layout

```
Package.swift                                   Swift Package manifest
Sources/NetTelemetry/
  NetTelemetry.swift                              Public API: initialize/registerBackgroundTasks/optIn/optOut/getStatus/sampleNow/uploadNow/rescue+drive-test-consent
  TelemetryConfig.swift                            Host-app-tunable settings
  TelemetryStatus.swift                            Read-only status snapshot for the host app's UI
  Model/Sample.swift                               One reading; JSON (de)serialization
  Collector/TelemetrySampleCollector.swift          Reads CoreLocation + CoreTelephony + battery
  Collector/NetworkMonitor.swift                    Wi-Fi vs. cellular via Network.framework
  Collector/SamplingScheduler.swift                 BGTaskScheduler periodic sampling/upload + foreground timer
  Storage/DeviceIdentity.swift                      Pseudonymous ID + opt-in flag (Keychain, reinstall-safe)
  Storage/SampleQueue.swift                         Local JSONL offline queue
  Upload/TelemetryApi.swift                         Batched sample upload (URLSession)
  Upload/RescueApi.swift                            Rescue-consent lane
  Upload/DriveTestConsentApi.swift                  Drive-test-consent lane
```
