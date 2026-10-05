import NetTelemetry
import SwiftUI

/// A minimal demo/test harness for the NetTelemetry iOS package -- NOT the
/// pilot's real UI, same "separate front-end effort" split as the Android
/// demo app. This exists only so the SDK is something a developer can
/// press buttons on and watch behave, both to sanity-check a real
/// build/run on a Mac (this was written with none available, see the SDK
/// README's "Verification status") and to show every integration point in
/// one place -- mirroring `app/src/main/kotlin/.../demo/MainActivity.kt`
/// and `DemoApplication.kt` button-for-button where the concept carries
/// over.
///
/// `NetTelemetry.registerBackgroundTasks()` is called here, in the App
/// struct's `init()`, and deliberately not from a view or from a button
/// action -- see NetTelemetry.swift's header comment and
/// SamplingScheduler.swift: BGTaskScheduler requires task identifiers to
/// be registered before the app finishes launching, a hard crash-if-wrong
/// requirement, not a style preference. `init()` on `@main App` runs at
/// the earliest point SwiftUI's lifecycle offers, exactly analogous to why
/// the Android demo calls `NetTelemetry.init()` from `Application
/// .onCreate()` and not `MainActivity.onCreate()`.
@main
struct NetTelemetryDemoApp: App {
    init() {
        NetTelemetry.registerBackgroundTasks()
        NetTelemetry.initialize(
            config: TelemetryConfig(
                // Same live dtwatch deployment the Android demo's
                // DemoApplication.kt points at
                // (core/telemetry_urls.py's `/api/telemetry/v1/` mount) --
                // see that file's own CAUTION comment: this hostname
                // resolves to an RFC1918 private address (172.16.41.201),
                // so it's only reachable from inside NTC's own network
                // (office Wi-Fi/VPN), not from ordinary mobile data or an
                // outside Wi-Fi network. That's a reachability fact to
                // confirm before a field test, not a bug here.
                endpointUrl: URL(string: "https://dtwatch.ntc.net.np/api/telemetry/v1/samples/")!,
                // TODO before building: paste in a real ingest key from
                // this live deployment's own Telemetry Admin panel
                // (Admin -> Telemetry -> Ingest Keys -> new key). The
                // placeholder below gets 401 on every upload until replaced --
                // same TODO the Android demo's DemoApplication.kt carries.
                apiKey: "TODO_LIVE_INGEST_KEY",
                driveTestConsentUrl: URL(string: "https://dtwatch.ntc.net.np/api/telemetry/v1/drive-test-consent/"),
                driveTestConsentMessageUrl: URL(string: "https://dtwatch.ntc.net.np/api/telemetry/v1/drive-test-consent-message/"),
                rescueEnrollUrl: URL(string: "https://dtwatch.ntc.net.np/api/telemetry/v1/rescue-enroll/")
            )
        )
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
