package np.nepaltelecom.telemetry.demo

import android.app.Application
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.TelemetryConfig

/**
 * NetTelemetry.init() is called here, in Application.onCreate(), and
 * deliberately not from MainActivity -- see netplanning-telemetry-sdk's own
 * README ("INTEGRATION NOTE, easy to get wrong") for why that placement
 * matters once WorkManager starts relaunching this process in the
 * background. This demo exists specifically to exercise that real
 * lifecycle, not just call the API once from a foreground screen.
 */
class DemoApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        NetTelemetry.init(
            this,
            TelemetryConfig(
                // LIVE-SERVER TEST BUILD (2026-09-07) -- points at the
                // actual dtwatch deployment (https://dtwatch.ntc.net.np/,
                // core/telemetry_urls.py's `/api/telemetry/v1/` mount),
                // not the dev PC LAN IP the rest of this file's history
                // used to point at. HTTPS to a real domain needs no entry
                // in network_security_config.xml -- that file only
                // governs cleartext (http://) exceptions; leave its
                // dev-only 10.0.2.2/192.168.100.6 entries alone, they're
                // simply unused by this build.
                //
                // CAUTION, confirmed by `ping dtwatch.ntc.net.np`
                // resolving to 172.16.41.201: that's an RFC1918 private
                // address, so this hostname only resolves/routes from
                // inside NTC's own network (office Wi-Fi or VPN). A phone
                // on ordinary mobile data or an outside Wi-Fi network
                // will fail to connect entirely -- that's a reachability
                // problem, not a consent/SDK bug, if uploads don't show
                // up during a field test done off NTC's network. Confirm
                // which networks this hostname actually resolves on
                // before relying on it for an off-site "real scenario"
                // test; if the pilot needs to be reachable from anywhere,
                // this needs a public DNS record/IP, not just this app
                // change.
                endpointUrl = "https://dtwatch.ntc.net.np/api/telemetry/v1/samples/",
                // TODO before building: paste in a real ingest key from
                // this live deployment's own Telemetry Admin panel
                // (Admin -> Telemetry -> Ingest Keys -> new key, scoped/
                // rate-limited however this test should be). The old
                // "local test" key below is a row in the DEV database
                // only -- it does not exist on live and every request
                // will get 401 until this is replaced.
                apiKey = "TODO_LIVE_INGEST_KEY",
                // A real phone on NTC's Wi-Fi/VPN is not the emulator's
                // always-reports-metered virtual adapter, so the SDK's
                // real Wi-Fi-preferred default is exactly what a live
                // pilot should exercise -- left at the TelemetryConfig
                // default (true) rather than the emulator-only override
                // this file used to carry.
                driveTestConsentUrl = "https://dtwatch.ntc.net.np/api/telemetry/v1/drive-test-consent/",
                driveTestConsentMessageUrl = "https://dtwatch.ntc.net.np/api/telemetry/v1/drive-test-consent-message/",
                rescueEnrollUrl = "https://dtwatch.ntc.net.np/api/telemetry/v1/rescue-enroll/",
            ),
        )
    }
}
