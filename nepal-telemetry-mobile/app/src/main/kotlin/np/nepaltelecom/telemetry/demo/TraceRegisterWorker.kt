package np.nepaltelecom.telemetry.demo

import android.content.Context
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import np.nepaltelecom.telemetry.storage.HardwareInfo

/**
 * Registers this phone's device key + MSISDN with the server, with
 * WorkManager's own retry/backoff on a flaky connection (2026-10-08,
 * "since server is accessible using vpn and data are being uploaded, why
 * there is problem with registration only?" -- because almost everything
 * else here (telemetry upload, drive-test consent, rescue enrollment) is
 * already built on a WorkManager worker exactly like this one, so a
 * network blip at the wrong moment just gets retried automatically until
 * it lands; "Register this phone" was the one exception, a plain one-shot
 * background Thread with no retry at all -- see
 * netplanning-telemetry-sdk's RescueEnrollWorker for the sibling this
 * mirrors).
 *
 * A fresh challenge is fetched on every attempt, including retries -- the
 * challenge is single-use, so the one fetched for a FAILED attempt is
 * already spent and must never be reused on the next try.
 *
 * `TraceRequestsPanel.register()` still makes one immediate attempt
 * inline first, for fast feedback on the common case (already on the
 * right network) -- this worker is enqueued only as a fallback when that
 * immediate attempt fails, so it does not slow down or change behavior
 * for anyone whose first try already succeeds.
 */
internal class TraceRegisterWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val msisdn = inputData.getString(KEY_MSISDN) ?: return Result.failure()
        val appVersion = inputData.getString(KEY_APP_VERSION) ?: "unknown"
        return try {
            DeviceKeys.ensureKey()
            TraceApi.register(msisdn, TraceApi.challenge(), appVersion, HardwareInfo.hardwareId(applicationContext))
            applicationContext
                .getSharedPreferences(TraceRequestsPanel.PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(TraceRequestsPanel.KEY_REGISTERED, true).apply()
            FcmToken.fetchAndUpload(applicationContext)
            // Best effort, same as the inline attempt -- identity upload
            // failing never fails registration itself.
            val userType = if (StaffMode.isEmployee(applicationContext)) "employee" else "general"
            runCatching { TraceApi.uploadIdentity(Build.MODEL, Build.MANUFACTURER, userType, HardwareInfo.hardwareId(applicationContext)) }
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    companion object {
        const val KEY_MSISDN = "msisdn"
        const val KEY_APP_VERSION = "app_version"
        const val WORK_NAME = "trace_register"
    }
}
