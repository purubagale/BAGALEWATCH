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
    val minHandoverSampleIntervalSeconds: Long = 60,

    /**
     * Optional: enables VoLTE/VoNR call-quality collection (mobile guide
     * §12) when set, pointing at .../api/telemetry/v1/volte-samples/. Leave
     * null (the default) to disable the feature entirely.
     *
     * Setting this is not enough on its own -- collection also requires the
     * host app to have carrier-privileged status (READ_PRECISE_PHONE_STATE
     * is otherwise silently denied, with no error to detect). See
     * VolteCallQualityListener's class doc before enabling this for a build
     * that doesn't have that status yet.
     */
    val volteSamplesUrl: String? = null,
) {
    internal val effectiveSamplingIntervalMinutes: Long
        get() = samplingIntervalMinutes.coerceAtLeast(15)
}
