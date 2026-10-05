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
            if (result.optOut) {
                // Mobile integration guide §8.2: a pending remote opt-out
                // request for one of this batch's devices must be acted on
                // this same upload cycle -- NetTelemetry.optOut() flips the
                // local flag, cancels future sampling/upload work, and (by
                // default) wipes whatever's still queued, which is correct
                // here since none of it should go out once opted out.
                queue.remove(batch)
                NetTelemetry.optOut()
                return Result.success()
            }
            if (!result.success) {
                // Leave the batch queued and let WorkManager's own retry/backoff
                // policy (configured where this worker is enqueued) try again
                // later, rather than looping on a dead network right now.
                return if (uploadedAny) Result.success() else Result.retry()
            }
            queue.remove(batch)
            uploadedAny = true
            if (batch.size < BATCH_SIZE) break // that was the last partial batch
        }
        return Result.success()
    }
}
