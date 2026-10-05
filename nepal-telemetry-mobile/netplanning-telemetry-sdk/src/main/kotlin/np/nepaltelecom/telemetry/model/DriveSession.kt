package np.nepaltelecom.telemetry.model

/**
 * Summary of one drive test kept on the phone (2026-10-04). Its fixes are
 * loaded separately, so the list of drives stays quick to read.
 *
 * [endMs] is null while a drive is running, or when the app was closed before
 * the drive was stopped.
 */
data class DriveSession(
    val id: String,
    val startMs: Long,
    val endMs: Long?,
    val fixCount: Int,
    val distanceM: Double,
)
