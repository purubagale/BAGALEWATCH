package np.nepaltelecom.telemetry.collector

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import np.nepaltelecom.telemetry.internalConfig
import np.nepaltelecom.telemetry.storage.DeviceIdentity
import np.nepaltelecom.telemetry.storage.SampleQueue

/** The periodic (>=15 min, see TelemetryConfig) background sampling tick. */
internal class SamplingWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        internalConfig ?: return Result.success()
        val identity = DeviceIdentity(applicationContext)
        if (!identity.optedIn) return Result.success()

        val collector = CellSampleCollector(applicationContext, identity)
        val sample = collector.collect(triggerReason = "periodic") ?: return Result.success()
        SampleQueue(applicationContext).append(sample)
        return Result.success()
    }
}
