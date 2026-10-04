package np.nepaltelecom.telemetry

/** Read-only snapshot for the host app's own UI (its own "signal quality" screen, a debug panel, etc.). */
data class TelemetryStatus(
    val optedIn: Boolean,
    val queuedSampleCount: Int,
    val lastSampleAtMs: Long?,
    val lastUploadAttemptAtMs: Long?,
)
