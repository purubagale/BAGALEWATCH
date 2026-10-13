package np.nepaltelecom.telemetry.demo

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.work.BackoffPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import androidx.work.workDataOf
import np.nepaltelecom.telemetry.storage.HardwareInfo
import java.util.concurrent.TimeUnit

/**
 * Registering this phone with its mobile number (2026-10-13). One place for
 * it, because two screens start it: the pop-up shown after first-run setup or
 * after an update, and the form in Settings.
 *
 * "Registered" is what this phone remembers. It is set when the server
 * accepts the registration, here or in the background retry
 * ([TraceRegisterWorker]). It survives an app update and is lost with the
 * phone's key when the app is uninstalled.
 */
object Registration {

    private const val APP_VERSION = "1.0"

    private fun prefs(context: Context) =
        context.getSharedPreferences(TraceRequestsPanel.PREFS, Context.MODE_PRIVATE)

    fun isRegistered(context: Context): Boolean =
        prefs(context).getBoolean(TraceRequestsPanel.KEY_REGISTERED, false)

    /** The number typed at registration, or "" when none was. */
    fun number(context: Context): String =
        prefs(context).getString(TraceRequestsPanel.KEY_MSISDN, "").orEmpty()

    /**
     * Tries once now. If that fails, a background job keeps trying, so a
     * moment without the network does not need a second tap. [onDone] runs on
     * the main thread with whether this first try worked and a message to show.
     */
    fun register(context: Context, msisdn: String, onDone: (Boolean, String) -> Unit) {
        val app = context.applicationContext
        prefs(app).edit().putString(TraceRequestsPanel.KEY_MSISDN, msisdn).apply()
        Thread {
            val (ok, message) = try {
                DeviceKeys.ensureKey()
                TraceApi.register(msisdn, TraceApi.challenge(), APP_VERSION, HardwareInfo.hardwareId(app))
                prefs(app).edit().putBoolean(TraceRequestsPanel.KEY_REGISTERED, true).apply()
                FcmToken.fetchAndUpload(app)
                // Best effort: a failed identity upload never fails registration.
                val userType = if (StaffMode.isEmployee(app)) "employee" else "general"
                runCatching { TraceApi.uploadIdentity(Build.MODEL, Build.MANUFACTURER, userType, HardwareInfo.hardwareId(app)) }
                true to app.getString(R.string.req_registered_as, msisdn)
            } catch (e: Exception) {
                enqueueRetry(app, msisdn)
                false to app.getString(R.string.req_failed_retrying, friendlyErrorMessage(e))
            }
            Handler(Looper.getMainLooper()).post { onDone(ok, message) }
        }.start()
    }

    /** Unique and replacing, so only the most recently typed number is ever sent. */
    private fun enqueueRetry(context: Context, msisdn: String) {
        val request = OneTimeWorkRequestBuilder<TraceRegisterWorker>()
            .setInputData(
                workDataOf(
                    TraceRegisterWorker.KEY_MSISDN to msisdn,
                    TraceRegisterWorker.KEY_APP_VERSION to APP_VERSION,
                )
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            TraceRegisterWorker.WORK_NAME, ExistingWorkPolicy.REPLACE, request,
        )
    }
}
