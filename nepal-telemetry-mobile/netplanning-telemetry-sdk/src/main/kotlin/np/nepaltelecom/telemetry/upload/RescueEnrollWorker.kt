package np.nepaltelecom.telemetry.upload

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import np.nepaltelecom.telemetry.internalConfig
import np.nepaltelecom.telemetry.storage.DeviceIdentity

/**
 * Syncs one rescue-consent change (opt in with an MSISDN, or opt out) to the
 * backend. Scheduled as a unique one-time work request by
 * `NetTelemetry.enrollForRescue()` / `NetTelemetry.optOutOfRescue()` rather
 * than called inline, so the request survives the app being killed
 * mid-request and gets WorkManager's retry/backoff on a flaky connection --
 * the same reasoning [UploadWorker] already relies on. The desired state
 * (consent + msisdn) travels in WorkManager's own persisted input data, so
 * unlike [UploadWorker] this worker needs no separate on-disk queue of its
 * own -- and enqueueing with `ExistingWorkPolicy.REPLACE` (see NetTelemetry)
 * means only the most recently requested consent state is ever in flight.
 */
internal class RescueEnrollWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val config = internalConfig ?: return Result.success() // SDK not initialized (shouldn't happen if scheduled correctly)
        val rescueEnrollUrl = config.rescueEnrollUrl ?: return Result.success() // rescue feature not configured for this deployment

        val consent = inputData.getBoolean(KEY_CONSENT, false)
        val msisdn = inputData.getString(KEY_MSISDN)
        // Same raw device_id used for telemetry sampling/upload -- see
        // DeviceIdentity's doc comment on why this is the only identifier
        // this module will ever send, rescue lane included.
        val deviceId = DeviceIdentity(applicationContext).deviceId

        val ok = RescueApi(rescueEnrollUrl, config.apiKey).enroll(deviceId, consent, msisdn)
        return if (ok) Result.success() else Result.retry()
    }

    companion object {
        const val KEY_CONSENT = "consent"
        const val KEY_MSISDN = "msisdn"
    }
}
