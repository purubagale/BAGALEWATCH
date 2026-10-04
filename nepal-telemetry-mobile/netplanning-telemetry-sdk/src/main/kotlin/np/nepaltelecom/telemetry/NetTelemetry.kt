package np.nepaltelecom.telemetry

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import androidx.work.workDataOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import np.nepaltelecom.telemetry.collector.CellSampleCollector
import np.nepaltelecom.telemetry.collector.DriveHistoryStore
import np.nepaltelecom.telemetry.collector.DriveTestService
import np.nepaltelecom.telemetry.collector.RouteTrail
import np.nepaltelecom.telemetry.model.CellReading
import np.nepaltelecom.telemetry.model.DriveSession
import np.nepaltelecom.telemetry.collector.HandoverListener
import np.nepaltelecom.telemetry.collector.SamplingWorker
import np.nepaltelecom.telemetry.storage.DeviceIdentity
import np.nepaltelecom.telemetry.model.Sample
import np.nepaltelecom.telemetry.storage.SampleQueue
import np.nepaltelecom.telemetry.upload.DriveTestConsentApi
import np.nepaltelecom.telemetry.upload.DriveTestConsentWorker
import np.nepaltelecom.telemetry.upload.RescueEnrollWorker
import np.nepaltelecom.telemetry.upload.UploadWorker
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
    private val scope = CoroutineScope(Dispatchers.Default)
    private val lastHandoverSampleAtMs = AtomicLong(0)

    private const val SAMPLING_WORK_NAME = "netplanning_telemetry_sampling"
    private const val UPLOAD_WORK_NAME = "netplanning_telemetry_upload"
    private const val RESCUE_ENROLL_WORK_NAME = "netplanning_telemetry_rescue_enroll"
    private const val DRIVE_TEST_CONSENT_WORK_NAME = "netplanning_telemetry_dt_consent"

    fun init(context: Context, config: TelemetryConfig) {
        appContext = context.applicationContext
        internalConfig = config
        val identity = DeviceIdentity(appContext)
        // First-run seeding (2026-09-02): only when this device has NEVER
        // stored an opt-in choice, and only when the host app opted into
        // an opt-out model via TelemetryConfig.defaultOptIn -- see that
        // field's doc comment. hasExplicitOptInState guards this so it can
        // never fire again after the very first init() on a device, even
        // if a later app update changes defaultOptIn: a subscriber's own
        // later optIn()/optOut() call always wins from that point on.
        if (!identity.hasExplicitOptInState && config.defaultOptIn) {
            identity.optedIn = true
        }
        // Rescheduling on every init() is deliberately idempotent (KEEP policy
        // below) -- calling init() again with the same config on every app
        // launch, as the integration guide recommends, does not reset or
        // duplicate already-scheduled work.
        if (identity.optedIn) {
            scheduleBackgroundWork()
            startHandoverListener()
        }
    }

    fun optIn() {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before optIn()" }
        DeviceIdentity(appContext).optedIn = true
        scheduleBackgroundWork()
        startHandoverListener()
    }

    fun optOut(wipeQueuedData: Boolean = true) {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before optOut()" }
        DeviceIdentity(appContext).optedIn = false
        WorkManager.getInstance(appContext).cancelUniqueWork(SAMPLING_WORK_NAME)
        WorkManager.getInstance(appContext).cancelUniqueWork(UPLOAD_WORK_NAME)
        handoverListener?.stop()
        handoverListener = null
        if (wipeQueuedData) SampleQueue(appContext).clear()
    }

    fun isOptedIn(): Boolean {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before isOptedIn()" }
        return DeviceIdentity(appContext).optedIn
    }

    fun getStatus(): TelemetryStatus {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before getStatus()" }
        val identity = DeviceIdentity(appContext)
        val queue = SampleQueue(appContext)
        return TelemetryStatus(
            optedIn = identity.optedIn,
            queuedSampleCount = queue.size(),
            lastSampleAtMs = queue.lastSampleAtMs(),
            lastUploadAttemptAtMs = null, // left for the host app to track via a WorkManager observer if it wants finer detail than this
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
     * Reads this device's live cell, signal and location state right now and
     * passes it to [onResult] -- for a host app's own "show my live readings"
     * screen. Nothing is queued or uploaded; this is a local read only.
     *
     * [onResult] runs on a background thread. It receives null when location
     * permission is missing or no cell/location state is available. Works
     * without opt-in, since it sends nothing anywhere.
     */
    fun readLiveSample(onResult: (Sample?) -> Unit) {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before readLiveSample()" }
        scope.launch {
            val sample = CellSampleCollector(appContext, DeviceIdentity(appContext)).collect(triggerReason = "manual")
            onResult(sample)
        }
    }

    /**
     * Reads the current cell and signal state with no location fix, so a
     * screen can refresh every few seconds without waiting on GPS. Needs only
     * location permission, not opt-in. Passes null when permission is missing.
     * Nothing is queued or uploaded.
     */
    fun readLiveCell(onResult: (Sample?) -> Unit) {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before readLiveCell()" }
        scope.launch {
            onResult(
                CellSampleCollector(appContext, DeviceIdentity(appContext))
                    .sampleFrom(null, "manual", requireOptIn = false),
            )
        }
    }

    /**
     * Reads every cell the modem reports right now, serving cell and
     * neighbours alike. Passes an empty list when location permission is
     * missing. Local read only, with nothing queued or uploaded.
     */
    fun readCellsNow(onResult: (List<CellReading>) -> Unit) {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before readCellsNow()" }
        scope.launch {
            onResult(CellSampleCollector(appContext, DeviceIdentity(appContext)).readAllCells())
        }
    }

    /** Fixes accepted by the current drive test, in order. Lives in memory only. */
    fun routeTrail(): List<RouteTrail.Point> = RouteTrail.points()

    /** Clears the on-phone route trail. Does not touch anything already queued for upload. */
    fun clearRouteTrail() = RouteTrail.clear()

    /** Past drive tests kept on this phone, newest first. Local only. */
    fun driveSessions(): List<DriveSession> {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before driveSessions()" }
        return DriveHistoryStore(appContext).list()
    }

    /** The fixes saved for one past drive, in order. Local only. */
    fun driveSessionPoints(sessionId: String): List<RouteTrail.Point> {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before driveSessionPoints()" }
        return DriveHistoryStore(appContext).points(sessionId)
    }

    /** Deletes one past drive from this phone. Anything already uploaded stays on the server. */
    fun deleteDriveSession(sessionId: String) {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before deleteDriveSession()" }
        DriveHistoryStore(appContext).delete(sessionId)
    }

    /**
     * Starts continuous drive-test tracking (see DriveTestService): a fix
     * every 2 seconds while running, shown with a persistent notification.
     * Does nothing unless the device has opted in. The host app must already
     * hold location permission, or the service stops itself.
     */
    fun startDriveTest(context: Context) {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before startDriveTest()" }
        if (!isOptedIn()) return
        ContextCompat.startForegroundService(context, Intent(context, DriveTestService::class.java))
    }

    /** Ends drive-test tracking started by [startDriveTest]. Safe to call when it isn't running. */
    fun stopDriveTest(context: Context) {
        context.startService(
            Intent(context, DriveTestService::class.java).setAction(DriveTestService.ACTION_STOP),
        )
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

    /**
     * Registers this device for the rescue-location lane: a separate,
     * explicit consent from the general telemetry opt-in handled by [optIn].
     * [msisdn] is stored server-side alongside this device's pseudonymous ID
     * so a rescue operator can look up a last-known location by phone
     * number -- see the backend's `SubscriberLastLocation`/`RescueLookupView`.
     *
     * The backend only starts updating that last-known location from
     * samples this device is already uploading -- so on its own, this call
     * has no effect on a device that isn't also opted into regular sampling
     * via [optIn]. This module doesn't enforce that ordering for the caller
     * (no silent auto opt-in on the host app's behalf, consistent with the
     * rest of this object's "the host app decides, we don't guess" design);
     * it's on the host app's consent UI to make that dependency clear, e.g.
     * by disabling its own rescue-registration screen until [isOptedIn].
     *
     * Requires [TelemetryConfig.rescueEnrollUrl] to be set; throws otherwise
     * rather than silently no-op-ing, since a deployment either offers this
     * feature or it's a caller bug to invoke it.
     *
     * The HTTP call itself runs on a WorkManager job ([RescueEnrollWorker])
     * rather than inline -- see that class for why. Calling this again (or
     * [optOutOfRescue]) before a prior call has synced replaces the pending
     * one; only the most recently requested consent state is ever in
     * flight.
     */
    fun enrollForRescue(msisdn: String) {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before enrollForRescue()" }
        checkNotNull(internalConfig?.rescueEnrollUrl) {
            "TelemetryConfig.rescueEnrollUrl must be set to use rescue enrollment"
        }
        enqueueRescueSync(consent = true, msisdn = msisdn)
    }

    /**
     * Withdraws rescue-location consent; the backend deletes any stored
     * last-known location for this device (see `RescueEnrollView`). Does
     * NOT affect general telemetry opt-in/out -- call [optOut] separately if
     * the host app wants both.
     */
    fun optOutOfRescue() {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before optOutOfRescue()" }
        checkNotNull(internalConfig?.rescueEnrollUrl) {
            "TelemetryConfig.rescueEnrollUrl must be set to use rescue enrollment"
        }
        enqueueRescueSync(consent = false, msisdn = null)
    }

    private fun enqueueRescueSync(consent: Boolean, msisdn: String?) {
        val data = workDataOf(
            RescueEnrollWorker.KEY_CONSENT to consent,
            RescueEnrollWorker.KEY_MSISDN to msisdn,
        )
        val request = OneTimeWorkRequestBuilder<RescueEnrollWorker>()
            .setInputData(data)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
            .build()
        // REPLACE, not KEEP/APPEND: if the caller flips their choice again
        // before the first sync lands, only the latest requested consent
        // state should ever reach the backend.
        WorkManager.getInstance(appContext).enqueueUniqueWork(
            RESCUE_ENROLL_WORK_NAME, ExistingWorkPolicy.REPLACE, request,
        )
    }

    /**
     * Records this device's standing consent to being INCLUDED in a
     * consent-gated drive-test/coverage session -- see the backend's
     * `TelemetryDriveTestSession.require_consent` /
     * `TelemetryDriveTestConsent`. One flag, not per-session: whatever the
     * most recent call here set is what every consent-gated session's
     * samples view checks at fetch time, so accepting or withdrawing takes
     * effect on a session already in progress, not just future ones.
     *
     * Independent of both [optIn] (general telemetry collection) and
     * [enrollForRescue] (the rescue-location lane) -- this only controls
     * whether an ALREADY-collected sample is surfaced through a
     * consent-gated session's results, never whether sampling/upload
     * happens at all.
     *
     * Requires [TelemetryConfig.driveTestConsentUrl] to be set; throws
     * otherwise, same reasoning as [enrollForRescue]. Runs on a
     * WorkManager job ([DriveTestConsentWorker]), same durability/backoff
     * story as the rescue sync.
     */
    fun setDriveTestConsent(consent: Boolean) {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before setDriveTestConsent()" }
        checkNotNull(internalConfig?.driveTestConsentUrl) {
            "TelemetryConfig.driveTestConsentUrl must be set to use drive-test consent"
        }
        val data = workDataOf(DriveTestConsentWorker.KEY_CONSENT to consent)
        val request = OneTimeWorkRequestBuilder<DriveTestConsentWorker>()
            .setInputData(data)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
            .build()
        WorkManager.getInstance(appContext).enqueueUniqueWork(
            DRIVE_TEST_CONSENT_WORK_NAME, ExistingWorkPolicy.REPLACE, request,
        )
    }

    /**
     * Fetches the CURRENT subscriber-facing copy for drive-test
     * participation consent (backend's `DriveTestConsentConfig`, editable
     * from the Telemetry Admin page) -- a pure convenience for a host app
     * that wants centrally-editable wording instead of hardcoding its own.
     * This does NOT mean the SDK shows any UI itself; the caller is
     * expected to display [onResult]'s text (e.g. in its own consent
     * dialog) and then call [setDriveTestConsent] with the subscriber's
     * answer, same as if it had hardcoded the copy.
     *
     * Runs the network call off the main thread; [onResult] is always
     * delivered on the main thread. Unlike [enrollForRescue]/
     * [setDriveTestConsent], this does NOT throw when
     * [TelemetryConfig.driveTestConsentMessageUrl] is unset, or when the
     * fetch itself fails -- both just deliver `null`, since a failed READ
     * has an obvious safe fallback (show the host app's own hardcoded
     * copy instead) that a failed WRITE does not.
     */
    fun fetchDriveTestConsentMessage(onResult: (String?) -> Unit) {
        check(::appContext.isInitialized) { "NetTelemetry.init() must be called before fetchDriveTestConsentMessage()" }
        val url = internalConfig?.driveTestConsentMessageUrl
        if (url == null) {
            onResult(null)
            return
        }
        val apiKey = internalConfig?.apiKey
        scope.launch {
            val message = DriveTestConsentApi(url, apiKey).fetchMessage()
            withContext(Dispatchers.Main) { onResult(message) }
        }
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
        }.also {
            // A revoked permission must never crash the host app at launch: the
            // listener simply stays off until the permission is granted again.
            runCatching { it.start() }
        }
    }
}

/** Set by [NetTelemetry.init]; read by the WorkManager-instantiated workers, which cannot receive constructor injection directly. */
internal var internalConfig: TelemetryConfig? = null
