package np.nepaltelecom.telemetry.upload

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.internalConfig
import np.nepaltelecom.telemetry.storage.DeviceIdentity
import np.nepaltelecom.telemetry.storage.SampleQueue

/**
 * Runs on WorkManager's schedule (see NetTelemetry.start()), respecting
 * whatever network constraint (unmetered/Wi-Fi-only vs any-network) the host
 * app configured. Uploads in bounded batches so one slow or huge queue
 * doesn't turn into one giant, easily-interrupted request.
 */
internal class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    companion object {
        const val BATCH_SIZE = 200
    }

    override suspend fun doWork(): Result {
        val config = internalConfig ?: return Result.success() // SDK not initialized (shouldn't happen if scheduled correctly)
        if (!DeviceIdentity(applicationContext).optedIn) return Result.success() // opted out since this was scheduled

        val queue = SampleQueue(applicationContext)
        val api = TelemetryApi(config.endpointUrl, config.apiKey)

        var uploadedAny = false
        while (true) {
            val batch = queue.peek(BATCH_SIZE)
            if (batch.isEmpty()) break
            val result = api.uploadBatch(batch)
            if (!result.accepted) {
                // Leave the batch queued and let WorkManager's own retry/backoff
                // policy (configured where this worker is enqueued) try again
                // later, rather than looping on a dead network right now.
                return if (uploadedAny) Result.success() else Result.retry()
            }
            queue.remove(batch)
            uploadedAny = true
            if (result.remoteOptOutRequested) {
                // The backend asked THIS device to opt itself out (see
                // TelemetryApi.uploadBatch's doc comment) -- e.g. a
                // superadmin ended the drive-test session this device was
                // enrolled in and explicitly requested its opt-out.
                // NetTelemetry.optOut() is the exact same call a subscriber
                // tapping "opt out" themselves would trigger: cancels the
                // scheduled work, stops the handover listener, and (by
                // default) wipes whatever's still queued -- so stop
                // uploading the rest of this queue too rather than finish
                // draining it first.
                NetTelemetry.optOut()
                break
            }
            if (batch.size < BATCH_SIZE) break // that was the last partial batch
        }
        return Result.success()
    }
}
