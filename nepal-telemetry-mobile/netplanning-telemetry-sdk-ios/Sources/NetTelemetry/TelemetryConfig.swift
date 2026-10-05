import Foundation

/// Everything the host app can tune -- deliberate mirror of the Android
/// SDK's `TelemetryConfig.kt` field-for-field where the concept carries
/// over to iOS, with iOS-specific caveats called out on the fields that
/// behave differently here. No UI-related field here on purpose, same as
/// Android: consent screens and any in-app status view are the host app's
/// job.
public struct TelemetryConfig {
    /// Where batched samples get POSTed as a JSON array -- the same
    /// `/api/telemetry/v1/samples/` endpoint the Android SDK's
    /// `TelemetryApi.kt` posts to (see core/telemetry.py on the backend).
    public let endpointUrl: URL

    /// Bearer token for the pilot backend (a `tel_...` TelemetryIngestKey).
    public let apiKey: String?

    /// How often the background sampling task *asks* to run.
    ///
    /// IMPORTANT, the single biggest behavioural difference from Android:
    /// Android's WorkManager enforces a hard 15-minute floor and then
    /// genuinely runs close to that cadence. iOS's `BGTaskScheduler` has no
    /// such guarantee at all -- `earliestBeginDate` is only the *earliest*
    /// the OS may run the task; the actual run can be minutes or many
    /// hours later (or, for an app the user rarely opens, effectively
    /// never), decided entirely by iOS's own heuristics (battery, usage
    /// patterns, Low Power Mode, whether the app is in the user's
    /// "frequently used" set). This field is clamped to the same 15-minute
    /// floor as Android purely for config-shape parity and because
    /// requesting anything shorter is pointless -- it is advisory, not
    /// enforced by anything in this module the way Android's really is by
    /// WorkManager. See SamplingScheduler.swift's doc comment for the full
    /// story and what actually provides more-frequent sampling while the
    /// app is open.
    public let samplingIntervalMinutes: Double

    /// How often queued samples get flushed to `endpointUrl` via a
    /// background processing task. Same iOS-scheduling caveat as
    /// `samplingIntervalMinutes` above.
    public let uploadIntervalMinutes: Double

    /// Require an unmetered (Wi-Fi) connection before the *scheduled*
    /// background upload runs, to keep the pilot off subscribers' mobile
    /// data -- same intent as Android's identically-named field. Checked
    /// via `NetworkMonitor` (Network.framework), not a hard OS-level
    /// constraint the way Android's `Constraints.setRequiredNetworkType`
    /// is: if the check says cellular, the task simply reschedules itself
    /// for later rather than uploading. `uploadNow()` bypasses this, same
    /// as Android's `uploadNow()`.
    public let uploadOnlyOnUnmetered: Bool

    /// Floor on how close together two foreground-timer samples can be.
    ///
    /// This is iOS's stand-in for Android's handover-triggered listener,
    /// and it works differently for a real reason, not an oversight:
    /// Android's `TelephonyCallback.SignalStrengthsListener` /
    /// `CellInfoListener` push a callback the instant the serving cell or
    /// signal strength changes. iOS's CoreTelephony exposes no equivalent
    /// public notification for third-party apps -- `CTTelephonyNetworkInfo`
    /// can be *polled* for the current radio access technology, but
    /// nothing calls you back when it changes. So instead, while the host
    /// app is in the foreground, `NetTelemetry` runs a plain repeating
    /// timer at this interval and takes a sample each tick -- genuinely
    /// more frequent than the background task's interval, but only ever
    /// while the app is actually open and in front of the user, never in
    /// the background the way Android's listener manages for as long as
    /// the process is merely alive.
    public let foregroundSampleIntervalSeconds: Double

    /// Endpoint for the separate rescue-consent lane
    /// (`POST .../rescue-enroll/`). Left `nil` when a deployment doesn't
    /// offer rescue registration -- `enrollForRescue`/`optOutOfRescue`
    /// fail fast without it, mirroring Android.
    public let rescueEnrollUrl: URL?

    /// Endpoint for the drive-test participation consent lane
    /// (`POST .../drive-test-consent/`). Same semantics as Android's field
    /// of the same name.
    public let driveTestConsentUrl: URL?

    /// Endpoint for fetching the current drive-test consent message
    /// (`GET .../drive-test-consent-message/`). Optional in the softer
    /// sense Android's field is: `fetchDriveTestConsentMessage` reports
    /// `nil` rather than throwing when this is unset.
    public let driveTestConsentMessageUrl: URL?

    /// Whether a device with no prior explicit opt-in choice starts opted
    /// IN (true) or opted OUT (false, the default). Same reasoning and
    /// same default as Android's field of the same name -- this is a
    /// legal/product decision for the host app to make deliberately, this
    /// SDK does not default to it on its own. Only affects the very first
    /// `NetTelemetry.initialize` call on a device; see
    /// `DeviceIdentity.hasExplicitOptInState`.
    public let defaultOptIn: Bool

    public init(
        endpointUrl: URL,
        apiKey: String? = nil,
        samplingIntervalMinutes: Double = 15,
        uploadIntervalMinutes: Double = 30,
        uploadOnlyOnUnmetered: Bool = true,
        foregroundSampleIntervalSeconds: Double = 120,
        rescueEnrollUrl: URL? = nil,
        driveTestConsentUrl: URL? = nil,
        driveTestConsentMessageUrl: URL? = nil,
        defaultOptIn: Bool = false
    ) {
        self.endpointUrl = endpointUrl
        self.apiKey = apiKey
        self.samplingIntervalMinutes = max(samplingIntervalMinutes, 15)
        self.uploadIntervalMinutes = max(uploadIntervalMinutes, 15)
        self.uploadOnlyOnUnmetered = uploadOnlyOnUnmetered
        self.foregroundSampleIntervalSeconds = foregroundSampleIntervalSeconds
        self.rescueEnrollUrl = rescueEnrollUrl
        self.driveTestConsentUrl = driveTestConsentUrl
        self.driveTestConsentMessageUrl = driveTestConsentMessageUrl
        self.defaultOptIn = defaultOptIn
    }
}
