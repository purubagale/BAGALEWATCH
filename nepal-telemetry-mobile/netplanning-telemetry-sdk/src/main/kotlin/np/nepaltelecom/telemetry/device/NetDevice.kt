package np.nepaltelecom.telemetry.device

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.RequestSigner
import np.nepaltelecom.telemetry.storage.HardwareInfo
import org.json.JSONObject
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * This phone's registration with NTC, without any screen (2026-10-16; moved
 * from the reference app so any host app, including a Flutter one, can use
 * it). Covers:
 *
 * - registering the phone's key with its mobile number, with a background
 *   retry when the first try fails;
 * - proving the number by SMS code when the server can send one;
 * - signing the SDK's own uploads once registered, and telling the server
 *   once which SDK device id is this phone's ("sdk-link").
 *
 * The signer is installed by [DeviceSignerProvider] at every process start,
 * so a host app needs no setup for it. The stored state uses the file and
 * keys the reference app used before the move, so a phone registered with an
 * older build stays registered.
 */
object NetDevice {
    const val PREFS = "dtwatch_device"
    const val KEY_MSISDN = "msisdn"
    const val KEY_REGISTERED = "registered"
    private const val KEY_LINKED = "sdk_linked"
    private const val KEY_VERIFIED = "number_verified"
    private const val KEY_AVAILABLE = "number_verify_available"
    private const val KEY_USER_TYPE = "user_type"

    private const val REGISTER_WORK = "trace_register"
    private const val LINK_WORK = "sdk_link"

    @Volatile
    private var onRegistered: ((Context) -> Unit)? = null

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * Runs on a background thread after each successful registration, here or
     * in the retry job, e.g. to upload a push token. Set it at process start
     * (a provider or Application.onCreate), because the retry can run in a
     * process the app's screens never started.
     */
    fun setOnRegistered(listener: ((Context) -> Unit)?) {
        onRegistered = listener
    }

    fun isRegistered(context: Context): Boolean = prefs(context).getBoolean(KEY_REGISTERED, false)

    /** The number typed at registration, or "" when none was. */
    fun number(context: Context): String = prefs(context).getString(KEY_MSISDN, "").orEmpty()

    /**
     * Registers this phone with [msisdn]. Tries once now; if that fails, a
     * background job keeps trying, so a moment without the network does not
     * need a second tap. [onDone] runs on the main thread with whether this
     * first try worked and, if not, a message safe to show.
     *
     * [userType] is "employee" or "general", as the user declared it.
     */
    fun register(context: Context, msisdn: String, userType: String = "general", onDone: (Boolean, String?) -> Unit) {
        val app = context.applicationContext
        prefs(app).edit().putString(KEY_MSISDN, msisdn).putString(KEY_USER_TYPE, userType).apply()
        Thread {
            val error = try {
                registerNow(app, msisdn, userType)
                null
            } catch (e: Exception) {
                enqueueRetry(app, msisdn, userType)
                friendlyErrorMessage(e)
            }
            Handler(Looper.getMainLooper()).post { onDone(error == null, error) }
        }.start()
    }

    /** One blocking registration attempt. Throws on failure. */
    internal fun registerNow(app: Context, msisdn: String, userType: String) {
        DeviceKeys.ensureKey()
        val hardwareId = HardwareInfo.hardwareId(app)
        val answer = DeviceApi.register(msisdn, DeviceApi.challenge(), HardwareInfo.appVersion(app), hardwareId)
        prefs(app).edit().putBoolean(KEY_REGISTERED, true).apply()
        saveNumberAnswer(app, answer)
        // A new key: link it again so the SDK's uploads are signed with it.
        setLinked(app, false)
        ensureLinked(app)
        runCatching { onRegistered?.invoke(app) }
        // Best effort: a failed identity upload never fails registration.
        runCatching { DeviceApi.uploadIdentity(Build.MODEL, Build.MANUFACTURER, userType, hardwareId) }
    }

    /** Unique and replacing, so only the most recently typed number is ever sent. */
    private fun enqueueRetry(context: Context, msisdn: String, userType: String) {
        val request = OneTimeWorkRequestBuilder<DeviceRegisterWorker>()
            .setInputData(workDataOf(DeviceRegisterWorker.KEY_MSISDN to msisdn, DeviceRegisterWorker.KEY_USER_TYPE to userType))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(REGISTER_WORK, ExistingWorkPolicy.REPLACE, request)
    }

    // ---- Proving the number by SMS code (2026-10-15) ----

    fun isNumberVerified(context: Context): Boolean = prefs(context).getBoolean(KEY_VERIFIED, false)

    /** True when the server can send a code and this phone has not proved its number yet. */
    fun numberVerificationNeeded(context: Context): Boolean =
        isRegistered(context) && prefs(context).getBoolean(KEY_AVAILABLE, false) && !isNumberVerified(context)

    /** Keeps what the server said (registration answer or status check). */
    fun saveNumberAnswer(context: Context, answer: JSONObject) {
        prefs(context).edit()
            .putBoolean(KEY_VERIFIED, answer.optBoolean("number_verified", false))
            .putBoolean(KEY_AVAILABLE, answer.optBoolean("verification_available", false))
            .apply()
    }

    /** Asks the server again. Blocking; errors are ignored. */
    fun refreshNumberStatus(context: Context) {
        if (!isRegistered(context)) return
        runCatching { saveNumberAnswer(context, DeviceApi.numberStatus()) }
    }

    /**
     * Asks the server to text a code to the registered number. Blocking.
     * Returns true when the number turns out to be verified already. Throws
     * [DeviceApi.ApiException] or an IO error when the code cannot be sent.
     */
    fun sendNumberCode(context: Context): Boolean {
        val answer = DeviceApi.sendNumberCode()
        if (answer.optBoolean("number_verified")) saveNumberAnswer(context, answer)
        return isNumberVerified(context)
    }

    /** Sends the 6-digit code back. Blocking. Throws [DeviceApi.ApiException] with the reason when wrong. */
    fun confirmNumberCode(context: Context, code: String): Boolean {
        saveNumberAnswer(context, DeviceApi.confirmNumberCode(code))
        return isNumberVerified(context)
    }

    // ---- Signed uploads and the SDK link (2026-10-14) ----

    fun isLinked(context: Context): Boolean = prefs(context).getBoolean(KEY_LINKED, false)

    internal fun setLinked(context: Context, linked: Boolean) {
        prefs(context).edit().putBoolean(KEY_LINKED, linked).apply()
    }

    /** Sends the link in the background if this phone is registered and not yet linked. */
    fun ensureLinked(context: Context) {
        val app = context.applicationContext
        if (!isRegistered(app) || isLinked(app)) return
        val work = OneTimeWorkRequestBuilder<SdkLinkWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(app).enqueueUniqueWork(LINK_WORK, ExistingWorkPolicy.KEEP, work)
    }

    /** Signs the SDK's uploads once this phone is registered and linked; until then the shared key is used. */
    class Signer(private val context: Context) : RequestSigner {
        override fun headers(method: String, url: URL, body: ByteArray): Map<String, String>? {
            if (!isRegistered(context) || !isLinked(context)) return null
            return runCatching { DeviceApi.signedHeaders(method, url.path, body) }.getOrNull()
        }

        // The server no longer knows this key (registration removed or the app
        // reinstalled): go back to the shared key and link again when registered.
        override fun onRejected() {
            setLinked(context, false)
        }
    }
}

internal class DeviceRegisterWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val msisdn = inputData.getString(KEY_MSISDN) ?: return Result.failure()
        val userType = inputData.getString(KEY_USER_TYPE) ?: "general"
        return try {
            // A fresh challenge on every try: the one fetched for a failed try is spent.
            NetDevice.registerNow(applicationContext, msisdn, userType)
            Result.success()
        } catch (e: DeviceApi.ApiException) {
            // A 4xx is the server refusing this number or key; trying again changes nothing.
            if (e.code in 400..499 && e.code != 429) Result.failure() else Result.retry()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    companion object {
        const val KEY_MSISDN = "msisdn"
        const val KEY_USER_TYPE = "user_type"
    }
}

internal class SdkLinkWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        if (!NetDevice.isRegistered(applicationContext)) return Result.success()
        return try {
            DeviceApi.linkSdk(NetTelemetry.sdkDeviceId())
            NetDevice.setLinked(applicationContext, true)
            Result.success()
        } catch (e: DeviceApi.ApiException) {
            // 401: the server does not know this key; registering again fixes it.
            if (e.code == 401) Result.success() else Result.retry()
        } catch (e: Exception) {
            Result.retry()
        }
    }
}

/**
 * Sets the SDK's signer at process start, before any background upload can
 * run. A provider runs before the Application's own onCreate on every process
 * start, including one WorkManager starts in the background. Declared in the
 * SDK's manifest, so it merges into every host app.
 */
class DeviceSignerProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        val app = context?.applicationContext ?: return true
        NetTelemetry.setRequestSigner(NetDevice.Signer(app))
        // After the Application has run NetTelemetry.init().
        Handler(Looper.getMainLooper()).post { runCatching { NetDevice.ensureLinked(app) } }
        return true
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
