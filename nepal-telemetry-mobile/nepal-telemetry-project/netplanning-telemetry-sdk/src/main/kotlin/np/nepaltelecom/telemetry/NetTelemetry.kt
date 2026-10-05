package np.nepaltelecom.telemetry

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import np.nepaltelecom.telemetry.collector.CellSampleCollector
import np.nepaltelecom.telemetry.collector.HandoverListener
import np.nepaltelecom.telemetry.collector.SamplingWorker
import np.nepaltelecom.telemetry.collector.VolteCallQualityListener
import np.nepaltelecom.telemetry.storage.DeviceIdentity
import np.nepaltelecom.telemetry.storage.SampleQueue
import np.nepaltelecom.telemetry.storage.VolteSampleQueue
import np.nepaltelecom.telemetry.upload.UploadWorker
import np.nepaltelecom.telemetry.upload.VolteUploadWorker
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Public entry point -- this is the entire surface the host app needs to
 * call. No UI anywhere in this module; the host app's own opt-in screen and
 * any "your signal quality" view are expected to call these methods and
 * render [getStatus] themselves.
 *
 * INTEGRATION NOTE, easy to get wrong: call [init] from the host app's
 * `Application.onCreate()`, not from an Activity/Fragment. WorkManager can
 * (and, on a pilot running for weeks, will) execute [SamplingWorker] and
 * [UploadWorker] after the app's process has been killed and relaunched
 * fresh by the OS -- if [init] only ever ran inside an Activity that never
 * got reopened, [internalConfig] is null when that work executes and it
 * quietly no-ops. Application.onCreate() runs on every process start,
 * including OS-triggered background relaunches, which is why it belongs
 * there.
 */
object NetTelemetry {

    private lateinit var appContext: Context
    private var handoverListener: HandoverListener? = null
    private var volteListener: VolteCallQualityListener? = null
    private val scope = CoroutineScope(Dispatchers.Default)
    private val lastHandoverSampleAtMs = AtomicLong(0)

    private const val SAMPLING_WORK_NAME = "netplanning_telemetry_sampling"
    private const val UPLOAD_WORK_NAME = "netplanning_telemetry_upload"

    fun init(context: Context, config: TelemetryConfig) {
        appContext = context.applicationContext
        internalConfig = config
        // Rescheduling on every init() is deliberately idempotent (KEEP policy
        // below) -- calling init() again with the same config on every app
        // launch, as the integration guide recommends, does not reset or
        // duplicate already-scheduled work.
        if (DeviceIdentity(appContext).optedIn) {
            scheduleBackgroundWork()
            startHandoverListener()
            startVolteListener()
        }
    }

    fun optIn() {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before optIn()" }
        DeviceIdentity(appContext).optedIn = true
        scheduleBackgroundWork()
        startHandoverListener()
        startVolteListener()
    }

    fun optOut(wipeQueuedData: Boolean = true) {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before optOut()" }
        DeviceIdentity(appContext).optedIn = false
        WorkManager.getInstance(appContext).cancelUniqueWork(SAMPLING_WORK_NAME)
        WorkManager.getInstance(appContext).cancelUniqueWork(UPLOAD_WORK_NAME)
        handoverListener?.stop()
        handoverListener = null
        volteListener?.stop()
        volteListener = null
        if (wipeQueuedData) {
            SampleQueue(appContext).clear()
            VolteSampleQueue(appContext).clear()
        }
    }

    fun isOptedIn(): Boolean {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before isOptedIn()" }
        return DeviceIdentity(appContext).optedIn
    }

    fun getStatus(): TelemetryStatus {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before getStatus()" }
        val identity = DeviceIdentity(appContext)
        val queue = SampleQueue(appContext)
        val lastFix = queue.lastKnownFix()
        return TelemetryStatus(
            optedIn = identity.optedIn,
            queuedSampleCount = queue.size(),
            lastSampleAtMs = queue.lastSampleAtMs(),
            lastUploadAttemptAtMs = null, // left for the host app to track via a WorkManager observer if it wants finer detail than this
            lastLat = lastFix?.lat,
            lastLon = lastFix?.lon,
            lastFixAccuracyM = lastFix?.accuracyM,
            lastFixAtMs = lastFix?.atMs,
        )
    }

    /**
     * Optional: lets the host app trigger an immediate, foreground sample --
     * e.g. from its own "check my signal now" button. Not required for the
     * pilot's automatic collection, which runs on its own schedule.
     */
    fun sampleNow() {
        if (!isOptedIn()) return
        scope.launch {
            val identity = DeviceIdentity(appContext)
            val sample = CellSampleCollector(appContext, identity).collect(triggerReason = "manual")
            sample?.let { SampleQueue(appContext).append(it) }
        }
    }

    /**
     * Optional: triggers an immediate upload attempt instead of waiting for
     * [TelemetryConfig.uploadIntervalMinutes] (default 30 minutes -- and
     * WorkManager enforces a 15-minute floor on the periodic schedule
     * regardless, the same floor documented for sampling). Mainly useful
     * for a host app's own "sync now" affordance or, as here, for testing
     * against a real backend without sitting through the periodic wait.
     * Unlike the scheduled periodic upload, this does NOT wait for an
     * unmetered connection even if [TelemetryConfig.uploadOnlyOnUnmetered]
     * is true -- an explicit manual "sync now" action bypassing that is the
     * normal expectation for this kind of call (and is exactly what makes
     * it useful for testing against a real backend on an emulator, where
     * the virtual network's metered status can be unpredictable). The
     * automatic background schedule is unaffected either way.
     */
    fun uploadNow() {
        if (!isOptedIn()) return
        WorkManager.getInstance(appContext).enqueue(OneTimeWorkRequestBuilder<UploadWorker>().build())
    }

    private fun scheduleBackgroundWork() {
        val config = internalConfig ?: return
        val workManager = WorkManager.getInstance(appContext)

        val samplingRequest = PeriodicWorkRequestBuilder<SamplingWorker>(
            config.effectiveSamplingIntervalMinutes, TimeUnit.MINUTES,
        ).build()
        workManager.enqueueUniquePeriodicWork(
            SAMPLING_WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, samplingRequest,
        )

        val uploadConstraints = Constraints.Builder()
            .setRequiredNetworkType(if (config.uploadOnlyOnUnmetered) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .build()
        val uploadRequest = PeriodicWorkRequestBuilder<UploadWorker>(
            config.uploadIntervalMinutes, TimeUnit.MINUTES,
        ).setConstraints(uploadConstraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
            .build()
        workManager.enqueueUniquePeriodicWork(
            UPLOAD_WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, uploadRequest,
        )
    }

    private fun startHandoverListener() {
        if (handoverListener != null) return
        val config = internalConfig ?: return
        handoverListener = HandoverListener(appContext) {
            val now = System.currentTimeMillis()
            val minGapMs = config.minHandoverSampleIntervalSeconds * 1000
            val last = lastHandoverSampleAtMs.get()
            if (now - last < minGapMs) return@HandoverListener // throttle -- see TelemetryConfig.minHandoverSampleIntervalSeconds
            if (!lastHandoverSampleAtMs.compareAndSet(last, now)) return@HandoverListener
            scope.launch {
                val identity = DeviceIdentity(appContext)
                val sample = CellSampleCollector(appContext, identity).collect(triggerReason = "handover")
                sample?.let { SampleQueue(appContext).append(it) }
            }
        }.also { it.start() }
    }

    /**
     * No-ops entirely when [TelemetryConfig.volteSamplesUrl] isn't set --
     * VoLTE collection is opt-in at the config level, separate from the
     * subscriber-level opt-in this method is already gated behind by both
     * its callers (init() when already opted in, and optIn()).
     */
    private fun startVolteListener() {
        if (volteListener != null) return
        val config = internalConfig ?: return
        if (config.volteSamplesUrl == null) return
        volteListener = VolteCallQualityListener(appContext, DeviceIdentity(appContext)) { sample ->
            VolteSampleQueue(appContext).append(sample)
            // Uploaded on its own one-time trigger right after the call ends
            // (mobile guide §12.4's "one upload per completed call"), not
            // folded into the periodic upload schedule the RF queue uses.
            WorkManager.getInstance(appContext).enqueue(OneTimeWorkRequestBuilder<VolteUploadWorker>().build())
        }.also { it.start() }
    }
}

/** Set by [NetTelemetry.init]; read by the WorkManager-instantiated workers, which cannot receive constructor injection directly. */
internal var internalConfig: TelemetryConfig? = null
