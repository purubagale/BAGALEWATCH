package np.nepaltelecom.telemetry.demo

/**
 * A short, user-safe message for any failure (2026-10-08). The rule lives in
 * the SDK since 2026-10-16, next to the calls whose errors it explains.
 */
fun friendlyErrorMessage(e: Throwable): String = np.nepaltelecom.telemetry.device.friendlyErrorMessage(e)
