package np.nepaltelecom.telemetry

/** Read-only snapshot for the host app's own UI (its own "signal quality" screen, a debug panel, etc.). */
data class TelemetryStatus(
    val optedIn: Boolean,
    val queuedSampleCount: Int,
    val lastSampleAtMs: Long?,
    val lastUploadAttemptAtMs: Long?,
    /**
     * The last GPS fix the SDK managed to record, from the most recent sample
     * that carried one. All four are null together until a fix has been taken
     * at least once; [lastFixAtMs] can lag [lastSampleAtMs] when recent
     * samples were cell-only (no location available). [lastFixAccuracyM] may
     * still be null on its own if the platform reported a position without an
     * accuracy estimate.
     */
    val lastLat: Double? = null,
    val lastLon: Double? = null,
    val lastFixAccuracyM: Float? = null,
    val lastFixAtMs: Long? = null,
)
