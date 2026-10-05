# NetTelemetry iOS demo app -- setup

This folder is Swift **source files only** (`NetTelemetryDemoApp.swift`,
`ContentView.swift`, `Info.plist`), the iOS counterpart of the Android
project's `app/` demo module -- **not** a ready-to-open Xcode project. That
was a deliberate choice, not an oversight: an `.xcodeproj` is a fragile,
mostly-binary-ish plist format that is very easy to get subtly wrong by
hand with no Xcode available to open or validate it (see
`../netplanning-telemetry-sdk-ios/README.md`'s "Verification status" for
why no Xcode was available while writing this). Xcode itself generates a
correct, valid `.xcodeproj` in about two minutes; a hand-rolled one risking
a corrupt project file that wastes your first ten minutes on a real Mac is
a worse trade than these five setup steps.

Needs a Mac with Xcode installed (see the top-level project's own note on
this: no Mac was reachable from the environment this was written in
either, cloud or the Windows machine this project lives on -- building/
signing an iOS `.ipa` needs one, by Apple's own restriction, whichever
machine ends up doing it).

## Setup (once you have a Mac + Xcode)

1. **Xcode > File > New > Project... > iOS > App.** Name it
   `NetTelemetryDemo`, interface: SwiftUI, language: Swift. Any bundle
   identifier / team is fine for local testing (a paid Apple Developer
   account is only needed once you want to install on a real device or
   distribute a build -- a free account is enough for the Simulator, and
   even for a real device for a week at a time).

2. **Delete** the app-template's generated `NetTelemetryDemoApp.swift` and
   `ContentView.swift`, and **drag in** the two files from this folder in
   their place (make sure "Copy items if needed" is checked).

3. **File > Add Package Dependencies... > Add Local...**, select the
   `netplanning-telemetry-sdk-ios` folder (the sibling of this one), and
   add the `NetTelemetry` library product to the `NetTelemetryDemo` target.

4. Apply the three keys from this folder's `Info.plist` to the real
   project -- either add them by hand in the target's **Info** tab, or set
   Build Settings > "Generate Info.plist File" to No and point "Info.plist
   File" at a copy of the provided one. Either way also flip on
   **Signing & Capabilities > + Capability > Background Modes >
   Background processing** (this is the UI path to the same
   `UIBackgroundModes` entry the plist sets by hand -- doing it via the
   capability toggle is the more normal way and safer against typos).

5. Before actually testing against a live pilot backend, replace
   `"TODO_LIVE_INGEST_KEY"` in `NetTelemetryDemoApp.swift` with a real
   ingest key from the dtwatch deployment's own **Telemetry Admin** page
   (Admin -> Telemetry -> Ingest Keys -> new key) -- same TODO the Android
   demo's `DemoApplication.kt` carries, and the same CAUTION about
   `dtwatch.ntc.net.np` only being reachable from inside NTC's own network
   (see that file's comment).

From there: Product > Run onto the Simulator to sanity-check the UI and
opt-in flow (CoreTelephony/carrier data won't be real on the Simulator --
see the SDK README's "Verification status"), then onto a real device with
a real Nepal Telecom SIM to actually verify network-type/carrier reads and
a live upload.
