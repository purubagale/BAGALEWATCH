package np.nepaltelecom.telemetry.collector

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.Tasks
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import np.nepaltelecom.telemetry.internalConfig
import np.nepaltelecom.telemetry.model.RadioBand
import np.nepaltelecom.telemetry.storage.DeviceIdentity
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.Calendar
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/**
 * "Help improve NTC's network" (2026-10-29). With the person's own opt-in,
 * the phone sends four short readings a day, around 10:00, 14:00, 19:00 and
 * 00:00 (quiet and busy hours), each at a random moment within
 * [WINDOW_MINUTES] of its slot so phones do not all send at once. Android
 * may delay a reading while the phone sleeps.
 *
 * A reading holds the network, band, signal and the serving cell's number.
 * Only when the person has allowed location "all the time" (the reading is
 * taken while the app is closed) does it add the position, with its accuracy
 * and the centre of the [AREA_DEG] square it is in (exact position since
 * 2026-10-30, the user's decision; the app says so when it asks). It goes
 * with the shared key under a random id that changes every [ANON_DAYS] days,
 * never with the phone's registration, so it carries no number.
 * Off by default; [setEnabled] false cancels the next reading.
 */
object ScheduledReadings {

    private const val PREFS = "netplanning_scheduled_readings"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_ASKED = "asked"
    private const val KEY_ANON = "anon_id"
    private const val KEY_ANON_AT = "anon_since"
    internal const val WORK_NAME = "netplanning_scheduled_reading"
    internal const val KEY_SLOT = "slot"
    private val SLOTS = intArrayOf(0, 10, 14, 19)
    private const val WINDOW_MINUTES = 30
    private const val ANON_DAYS = 30L
    /** Size of the rough area in degrees: about 550 m north-south, 500 m east-west in Nepal. */
    internal const val AREA_DEG = 0.005

    /** True when a closed app may read the position (Android 10+ needs "Allow all the time"). */
    fun hasBackgroundLocation(context: Context): Boolean {
        val fine = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        if (!fine) return false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
    }

    /** The centre of the [AREA_DEG] square holding (lat, lng). */
    internal fun roughArea(lat: Double, lng: Double): Pair<Double, Double> {
        fun centre(v: Double) = (Math.floor(v / AREA_DEG) + 0.5) * AREA_DEG
        return centre(lat) to centre(lng)
    }

    fun isEnabled(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, false)

    /** True once the person has answered the question, either way. */
    fun wasAsked(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ASKED, false)

    fun setEnabled(context: Context, enabled: Boolean) {
        val app = context.applicationContext
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_ENABLED, enabled).putBoolean(KEY_ASKED, true).apply()
        if (enabled) scheduleNext(app, ExistingWorkPolicy.REPLACE)
        else WorkManager.getInstance(app).cancelUniqueWork(WORK_NAME)
    }

    /** Keeps the next reading booked after an app start (no-op when off or already booked). */
    fun ensureScheduled(context: Context) {
        if (isEnabled(context)) scheduleNext(context.applicationContext, ExistingWorkPolicy.KEEP)
    }

    internal fun scheduleNext(context: Context, policy: ExistingWorkPolicy) {
        val now = System.currentTimeMillis()
        var best: Pair<Long, Int>? = null
        for (dayOffset in 0..1) {
            for (slot in SLOTS) {
                val at = Calendar.getInstance().apply {
                    add(Calendar.DAY_OF_YEAR, dayOffset)
                    set(Calendar.HOUR_OF_DAY, slot); set(Calendar.MINUTE, 0)
                    set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
                }.timeInMillis + Random.nextLong(-WINDOW_MINUTES * 60_000L, WINDOW_MINUTES * 60_000L)
                if (at > now + 5 * 60_000L && (best == null || at < best.first)) best = at to slot
            }
        }
        val (at, slot) = best ?: return
        val work = OneTimeWorkRequestBuilder<ScheduledReadingWorker>()
            .setInitialDelay(at - now, TimeUnit.MILLISECONDS)
            .setInputData(workDataOf(KEY_SLOT to slot))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, policy, work)
    }

    /** The random id readings go under; a new one every [ANON_DAYS] days. */
    internal fun anonId(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val since = prefs.getLong(KEY_ANON_AT, 0L)
        val current = prefs.getString(KEY_ANON, null)
        if (current != null && System.currentTimeMillis() - since < TimeUnit.DAYS.toMillis(ANON_DAYS)) return current
        val fresh = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_ANON, fresh).putLong(KEY_ANON_AT, System.currentTimeMillis()).apply()
        return fresh
    }
}

/** Takes and sends one scheduled reading, then books the next. */
internal class ScheduledReadingWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext
        if (!ScheduledReadings.isEnabled(app)) return Result.success()
        val config = internalConfig
        val url = config?.endpointUrl?.let { readingsUrl(it) }
        if (url != null) {
            val s = runCatching {
                CellSampleCollector(app, DeviceIdentity(app)).sampleFrom(null, "scheduled", requireOptIn = false)
            }.getOrNull()
            if (s != null && s.networkType.isNotBlank()) {
                val body = JSONObject().apply {
                    put("anon_id", ScheduledReadings.anonId(app))
                    put("ts", System.currentTimeMillis())
                    put("slot", inputData.getInt(ScheduledReadings.KEY_SLOT, -1))
                    put("network_type", s.networkType)
                    RadioBand.label(s.networkType, s.band, if (s.networkType == "GSM") s.bcch ?: s.arfcn else s.arfcn)
                        ?.let { put("band", it) }
                    val level = when (s.networkType) {
                        "LTE", "NR" -> s.rsrpDbm
                        "UMTS" -> s.rscpDbm ?: s.rssiDbm
                        else -> s.rssiDbm
                    }
                    level?.let { put("level_dbm", it) }
                    s.rsrqDb?.let { put("rsrq_db", it) }
                    s.sinrDb?.let { put("sinr_db", it) }
                    s.mcc?.let { put("mcc", it) }
                    s.mnc?.let { put("mnc", it) }
                    s.cellId?.let { put("cell_id", it) }
                    s.tac?.let { put("tac", it) }
                    s.pci?.let { put("pci", it) }
                    position(app)?.let { loc ->
                        put("lat", loc.latitude); put("lng", loc.longitude)
                        if (loc.hasAccuracy()) put("gps_accuracy_m", loc.accuracy.toDouble())
                        val (alat, alng) = ScheduledReadings.roughArea(loc.latitude, loc.longitude)
                        put("area_lat", alat); put("area_lng", alng)
                    }
                }.toString().toByteArray(StandardCharsets.UTF_8)
                val sent = try {
                    val connection = (URL(url).openConnection() as HttpURLConnection).apply {
                        requestMethod = "POST"
                        setRequestProperty("Content-Type", "application/json; charset=utf-8")
                        // The shared key, never the registration signature: the reading must not name the phone.
                        config.apiKey?.let { setRequestProperty("Authorization", "Bearer $it") }
                        doOutput = true
                        connectTimeout = 15_000
                        readTimeout = 15_000
                    }
                    connection.outputStream.use { it.write(body) }
                    val code = connection.responseCode
                    connection.disconnect()
                    code in 200..299 || code == 400 || code == 404 || code == 429
                } catch (e: Exception) {
                    Log.w(TAG, "Scheduled reading not sent: ${e.javaClass.simpleName}")
                    false
                }
                if (!sent && runAttemptCount < 3) return Result.retry()
            }
        }
        ScheduledReadings.scheduleNext(app, ExistingWorkPolicy.APPEND_OR_REPLACE)
        return Result.success()
    }

    /** The position, only with "Allow all the time"; null otherwise or without a fix in 20 s. */
    @android.annotation.SuppressLint("MissingPermission")
    private fun position(context: Context): android.location.Location? {
        if (!ScheduledReadings.hasBackgroundLocation(context)) return null
        return runCatching {
            val client = LocationServices.getFusedLocationProviderClient(context)
            Tasks.await(client.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, com.google.android.gms.tasks.CancellationTokenSource().token), 20, TimeUnit.SECONDS)
                ?: Tasks.await(client.lastLocation, 5, TimeUnit.SECONDS)
        }.getOrNull()
    }

    /** `.../telemetry/v1/samples/` becomes `.../telemetry/v1/scheduled-readings/`. */
    private fun readingsUrl(samplesUrl: String): String? {
        val base = samplesUrl.trimEnd('/')
        if (!base.endsWith("/samples")) return null
        return base.removeSuffix("samples") + "scheduled-readings/"
    }

    private companion object {
        const val TAG = "NetTelemetry.Scheduled"
    }
}
