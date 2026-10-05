package np.nepaltelecom.telemetry.upload

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import np.nepaltelecom.telemetry.internalConfig
import np.nepaltelecom.telemetry.storage.DeviceIdentity

/**
 * Syncs one drive-test-consent change to the backend. Scheduled as a
 * unique one-time work request by `NetTelemetry.setDriveTestConsent()`
 * rather than called inline -- same durability/retry reasoning as
 * [RescueEnrollWorker], which this mirrors closely (a separate class
 * rather than a shared generic one, matching how [TelemetryApi] and
 * [RescueApi] are also kept as separate, purpose-specific HTTP clients
 * rather than one generic one).
 */
internal class DriveTestConsentWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val config = internalConfig ?: return Result.success() // SDK not initialized (shouldn't happen if scheduled correctly)
        val consentUrl = config.driveTestConsentUrl ?: return Result.success() // feature not configured for this deployment

        val consent = inputData.getBoolean(KEY_CONSENT, false)
        val deviceId = DeviceIdentity(applicationContext).deviceId

        val ok = DriveTestConsentApi(consentUrl, config.apiKey).setConsent(deviceId, consent)
        return if (ok) Result.success() else Result.retry()
    }

    companion object {
        const val KEY_CONSENT = "consent"
    }
}
