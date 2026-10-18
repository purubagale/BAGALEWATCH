package np.nepaltelecom.ntc_telemetry

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.TelemetryConfig

/**
 * The SDK's settings, kept on the phone (2026-10-16). The SDK must be set up
 * on every process start, including one Android starts in the background to
 * take a reading or send the queue, when no Flutter code runs at all. So
 * `NtcTelemetry.init` saves its settings here and [NtcTelemetryInitProvider]
 * sets the SDK up from them at every later start.
 *
 * Only the server address is required. Every feature address is worked out
 * from it with the server's standard paths, unless given.
 */
internal object StoredConfig {
    private const val PREFS = "ntc_telemetry_config"
    private const val API = "/api/telemetry/v1/"

    @Volatile
    private var initialized = false

    fun isInitialized(): Boolean = initialized

    fun save(context: Context, args: Map<*, *>) {
        val server = (args["serverUrl"] as? String)?.trimEnd('/')
        require(!server.isNullOrEmpty()) { "serverUrl is required" }
        val e = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear()
        e.putString("serverUrl", server)
        (args["apiKey"] as? String)?.let { e.putString("apiKey", it) }
        (args["uploadOnlyOnWifi"] as? Boolean)?.let { e.putBoolean("uploadOnlyOnWifi", it) }
        (args["samplingIntervalMinutes"] as? Number)?.let { e.putLong("samplingIntervalMinutes", it.toLong()) }
        (args["uploadIntervalMinutes"] as? Number)?.let { e.putLong("uploadIntervalMinutes", it.toLong()) }
        (args["calls"] as? Boolean)?.let { e.putBoolean("calls", it) }
        (args["rescue"] as? Boolean)?.let { e.putBoolean("rescue", it) }
        e.apply()
    }

    /** Sets the SDK up from the saved settings. Does nothing when none are saved yet. */
    fun initSdk(context: Context) {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val server = p.getString("serverUrl", null) ?: return
        val base = server + API
        NetTelemetry.init(
            context.applicationContext,
            TelemetryConfig(
                endpointUrl = base + "samples/",
                apiKey = p.getString("apiKey", null),
                samplingIntervalMinutes = p.getLong("samplingIntervalMinutes", 15),
                uploadIntervalMinutes = p.getLong("uploadIntervalMinutes", 30),
                uploadOnlyOnUnmetered = p.getBoolean("uploadOnlyOnWifi", true),
                speedSamplesUrl = base + "speed-samples/",
                pushTokenUrl = base + "push-token/",
                callSamplesUrl = if (p.getBoolean("calls", true)) base + "call-samples/" else null,
                rescueEnrollUrl = if (p.getBoolean("rescue", true)) base + "rescue-enroll/" else null,
                driveTestConsentUrl = base + "drive-test-consent/",
                driveTestConsentMessageUrl = base + "drive-test-consent-message/",
                deviceApiUrl = base,
            ),
        )
        initialized = true
    }
}

/** Sets the SDK up at every process start from the saved settings (see [StoredConfig]). */
class NtcTelemetryInitProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        context?.let { runCatching { StoredConfig.initSdk(it) } }
        return true
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
