package np.nepaltelecom.telemetry.demo

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.RequestSigner
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Signed uploads (2026-10-14). Once this phone is registered, it tells the
 * server once, signed, which SDK device id is its own ([TraceApi.linkSdk]).
 * From then on the SDK's uploads (readings, speed results, push token, calls)
 * are signed with the phone's key instead of the shared key that ships inside
 * every APK. Until then, and for a phone that never registers, they keep
 * using the shared key.
 */
object SdkLink {
    private const val KEY_LINKED = "sdk_linked"
    private const val WORK_NAME = "sdk_link"

    private fun prefs(context: Context) =
        context.getSharedPreferences(TraceRequestsPanel.PREFS, Context.MODE_PRIVATE)

    fun isLinked(context: Context): Boolean = prefs(context).getBoolean(KEY_LINKED, false)

    internal fun setLinked(context: Context, linked: Boolean) {
        prefs(context).edit().putBoolean(KEY_LINKED, linked).apply()
    }

    /** Sends the link in the background if this phone is registered and not yet linked. */
    fun ensure(context: Context) {
        val app = context.applicationContext
        if (!Registration.isRegistered(app) || isLinked(app)) return
        val work = OneTimeWorkRequestBuilder<SdkLinkWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(app).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP, work)
    }

    /** Signs the SDK's uploads once this phone is registered and linked. */
    class Signer(private val context: Context) : RequestSigner {
        override fun headers(method: String, url: URL, body: ByteArray): Map<String, String>? {
            if (!Registration.isRegistered(context) || !isLinked(context)) return null
            return runCatching { TraceApi.signedHeaders(method, url.path, body) }.getOrNull()
        }

        // The server no longer knows this key (registration removed or the app
        // reinstalled): go back to the shared key and link again when registered.
        override fun onRejected() {
            setLinked(context, false)
        }
    }
}

internal class SdkLinkWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        if (!Registration.isRegistered(applicationContext)) return Result.success()
        return try {
            TraceApi.linkSdk(NetTelemetry.sdkDeviceId())
            SdkLink.setLinked(applicationContext, true)
            Result.success()
        } catch (e: TraceApi.ApiException) {
            // 401: the server does not know this key; registering again fixes it.
            if (e.code == 401) Result.success() else Result.retry()
        } catch (e: Exception) {
            Result.retry()
        }
    }
}

/**
 * Sets the SDK's signer at process start, before any background upload can
 * run (2026-10-14). A provider runs before the Application's own onCreate on
 * every process start, including one WorkManager starts in the background.
 */
class SdkSignerProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        val app = context?.applicationContext ?: return true
        NetTelemetry.setRequestSigner(SdkLink.Signer(app))
        // After the Application has run NetTelemetry.init().
        Handler(Looper.getMainLooper()).post { runCatching { SdkLink.ensure(app) } }
        return true
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
