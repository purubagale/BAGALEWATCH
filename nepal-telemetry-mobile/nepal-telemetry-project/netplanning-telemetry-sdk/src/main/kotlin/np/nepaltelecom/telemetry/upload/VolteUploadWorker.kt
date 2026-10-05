package np.nepaltelecom.telemetry.upload

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import np.nepaltelecom.telemetry.internalConfig
import np.nepaltelecom.telemetry.storage.DeviceIdentity
import np.nepaltelecom.telemetry.storage.VolteSampleQueue

/**
 * Enqueued once per completed call (see VolteCallQualityListener), NOT on a
 * periodic schedule like [UploadWorker] -- §12.4 of the mobile guide is
 * explicit that this pipeline's cadence is "one upload per completed call,"
 * unlike RF samples' periodic/handover batching.
 */
internal class VolteUploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val config = internalConfig ?: return Result.success()
        val volteUrl = config.volteSamplesUrl ?: return Result.success() // feature not configured
        if (!DeviceIdentity(applicationContext).optedIn) return Result.success()

        val queue = VolteSampleQueue(applicationContext)
        val api = VolteApi(volteUrl, config.apiKey)

        var uploadedAny = false
        while (true) {
            val batch = queue.peek(UploadWorker.BATCH_SIZE)
            if (batch.isEmpty()) break
            val ok = api.uploadBatch(batch)
            if (!ok) {
                // Same reasoning as UploadWorker: leave it queued, let
                // WorkManager's retry/backoff (set where this is enqueued)
                // try again rather than looping on a dead network now.
                return if (uploadedAny) Result.success() else Result.retry()
            }
            queue.remove(batch)
            uploadedAny = true
            if (batch.size < UploadWorker.BATCH_SIZE) break
        }
        return Result.success()
    }
}
