package np.nepaltelecom.telemetry.upload

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import np.nepaltelecom.telemetry.device.DeviceApi
import np.nepaltelecom.telemetry.device.NetDevice
import np.nepaltelecom.telemetry.internalConfig
import np.nepaltelecom.telemetry.storage.DeviceIdentity
import np.nepaltelecom.telemetry.storage.HardwareInfo
import java.io.IOException

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
 *
 * A registered phone goes signed (2026-10-23): `device/rescue-consent/`
 * takes the number from the phone's registration, so a typed number can't be
 * enrolled on someone else's behalf. Only an unregistered phone uses the old
 * shared-key request, which the server retires after a date it sets.
 */
internal class RescueEnrollWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val config = internalConfig ?: return Result.success() // SDK not initialized (shouldn't happen if scheduled correctly)
        val rescueEnrollUrl = config.rescueEnrollUrl ?: return Result.success() // rescue feature not configured for this deployment

        val consent = inputData.getBoolean(KEY_CONSENT, false)
        val msisdn = inputData.getString(KEY_MSISDN)

        if (NetDevice.isRegistered(applicationContext)) {
            try {
                DeviceApi.rescueConsent(consent, HardwareInfo.appVersion(applicationContext))
                return Result.success()
            } catch (e: DeviceApi.ApiException) {
                when {
                    // A server without the signed route yet (before its deploy): old request below.
                    e.code == 404 -> Unit
                    // 409: the phone's link to its readings is not made yet; rate limit; server error.
                    e.code == 409 || e.code == 408 || e.code == 429 || e.code >= 500 -> return Result.retry()
                    // A final answer, e.g. no registered number or the number not yet proved by SMS.
                    else -> return Result.failure()
                }
            } catch (e: IOException) {
                return Result.retry()
            }
        }

        // Same raw device_id used for telemetry sampling/upload -- see
        // DeviceIdentity's doc comment on why this is the only identifier
        // this module will ever send, rescue lane included.
        val deviceId = DeviceIdentity(applicationContext).deviceId

        // Device details go only with an enrolment, never with a withdrawal.
        val device = if (consent) {
            mapOf(
                "manufacturer" to HardwareInfo.manufacturer(),
                "phone_model" to HardwareInfo.model(),
                "app_version" to HardwareInfo.appVersion(applicationContext),
                "hardware_id" to HardwareInfo.hardwareId(applicationContext),
            )
        } else {
            emptyMap()
        }
        val code = RescueApi(rescueEnrollUrl, config.apiKey).enroll(deviceId, consent, msisdn, device)
        return when {
            code in 200..299 -> Result.success()
            // No connection, a timeout, rate limit or a server error: try again later.
            code == -1 || code == 408 || code == 429 || code >= 500 -> Result.retry()
            // A final answer, e.g. 410 once shared-key enrolment is retired: stop.
            else -> Result.failure()
        }
    }

    companion object {
        const val KEY_CONSENT = "consent"
        const val KEY_MSISDN = "msisdn"
    }
}
