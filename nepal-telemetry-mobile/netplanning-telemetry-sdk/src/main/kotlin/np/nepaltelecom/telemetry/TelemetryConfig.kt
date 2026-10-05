package np.nepaltelecom.telemetry

/**
 * Everything the host app can tune. There is no UI-related field here on
 * purpose -- consent screens, a "your signal quality" view, and any
 * in-app status display are the host app's job (per the project's own
 * task split: this module is the integration layer, not the front end).
 */
data class TelemetryConfig(
    /** Where batched samples get POSTed as a JSON array. */
    val endpointUrl: String,

    /** Optional bearer token for the pilot backend, if it requires one. */
    val apiKey: String? = null,

    /**
     * How often the periodic background sampling job runs. WorkManager
     * enforces a 15-minute floor for PeriodicWorkRequest -- values below
     * that are silently raised to 15 by WorkManager itself, so this SDK
     * clamps to the same floor up front rather than let that surprise
     * someone later. Sub-15-minute responsiveness comes from the
     * handover-triggered listener while the app process is alive, not from
     * this interval -- see README, "Why 15 minutes."
     */
    val samplingIntervalMinutes: Long = 15,

    /** How often queued samples get flushed to [endpointUrl]. */
    val uploadIntervalMinutes: Long = 30,

    /** Require an unmetered (Wi-Fi) connection before uploading, to keep the pilot off subscribers' mobile data. */
    val uploadOnlyOnUnmetered: Boolean = true,

    /**
     * Floor on how close together two handover-triggered samples can be.
     * Signal-strength callbacks can fire many times a minute on a moving
     * device; without this, that alone would dominate both the queue and
     * the phone's battery budget.
     */
    val minHandoverSampleIntervalSeconds: Long = 120,

    /**
     * Endpoint for the separate rescue-consent lane (`POST .../rescue-enroll/`).
     * Left null when a given deployment doesn't offer rescue registration --
     * `NetTelemetry.enrollForRescue()`/`optOutOfRescue()` fail fast via
     * `check()` without it, rather than silently no-op. Deliberately a
     * separate URL from [endpointUrl] rather than derived by string surgery
     * on it, since the two can live on different hosts/paths depending on
     * how a deployment is fronted, and because rescue enrollment being
     * unconfigured is a meaningfully different state from telemetry upload
     * being unconfigured.
     */
    val rescueEnrollUrl: String? = null,

    /**
     * Endpoint for the drive-test participation consent lane
     * (`POST .../drive-test-consent/`). Left null when a deployment
     * doesn't offer consent-gated drive-test sessions --
     * `NetTelemetry.setDriveTestConsent()` fails fast via `check()`
     * without it, same reasoning as [rescueEnrollUrl].
     */
    val driveTestConsentUrl: String? = null,

    /**
     * Endpoint for fetching the CURRENT drive-test consent message
     * (`GET .../drive-test-consent-message/`) -- deliberately a separate
     * URL from [driveTestConsentUrl] (that one is POST-only, this one is
     * GET-only, and a deployment could in principle offer one without the
     * other). Optional in a stricter sense than [rescueEnrollUrl]/
     * [driveTestConsentUrl]: leaving this null does not disable a
     * capability the way those do -- [NetTelemetry.fetchDriveTestConsentMessage]
     * just reports back `null` instead of throwing, since a host app is
     * always free to hardcode its own consent copy and never call this at
     * all (see that method's doc comment, and DriveTestConsentConfig's
     * docstring on the backend for why this exists as a convenience, not
     * a requirement).
     */
    val driveTestConsentMessageUrl: String? = null,

    /**
     * Whether a device with NO prior explicit opt-in choice starts opted
     * IN (true) or opted OUT (false, the historical default and still the
     * default here). Only affects the very first [NetTelemetry.init] call
     * on a given device (see [np.nepaltelecom.telemetry.storage.
     * DeviceIdentity.hasExplicitOptInState]) -- an explicit
     * [NetTelemetry.optIn]/[NetTelemetry.optOut] call afterward, on this
     * or any later launch, is never overridden by this setting again.
     *
     * true is an opt-OUT consent model: collection starts automatically
     * at install, and the subscriber's recourse is [NetTelemetry.optOut].
     * That's only appropriate when the host app's own terms of service (or
     * a carrier's own first-party app under its existing subscriber
     * agreement) already establish that basis -- it is a legal/product
     * decision for the HOST APP to make deliberately, not a default this
     * SDK should quietly assume. This is why it defaults to false: an
     * integrator has to opt into opt-out, not the other way around.
     * Separate from and does NOT affect [rescueEnrollUrl] consent or
     * [driveTestConsentUrl] consent -- both of those always require an
     * explicit call ([NetTelemetry.enrollForRescue] /
     * [NetTelemetry.setDriveTestConsent]) regardless of this setting.
     */
    val defaultOptIn: Boolean = false,
) {
    internal val effectiveSamplingIntervalMinutes: Long
        get() = samplingIntervalMinutes.coerceAtLeast(15)
}

