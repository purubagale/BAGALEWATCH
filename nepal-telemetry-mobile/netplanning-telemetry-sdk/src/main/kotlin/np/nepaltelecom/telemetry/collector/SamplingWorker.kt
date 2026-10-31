package np.nepaltelecom.telemetry.collector

import android.content.Context
import android.location.Location
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
        val queue = SampleQueue(applicationContext)
        queue.append(sample)
        // A second Nepal Telecom SIM is read too, at the same place (2026-10-31).
        // Another operator's SIM stays on the phone.
        val sims = SimSlots.active(applicationContext)
        val dataSim = SimSlots.dataSim(sims)
        val place = sample.lat?.let { lat ->
            Location("sample").apply {
                latitude = lat
                longitude = sample.lon ?: return@let null
                sample.gpsAccuracyM?.let { accuracy = it }
            }
        }
        sims.filter { it.isNtc && it.subId != dataSim?.subId }.forEach { other ->
            CellSampleCollector(applicationContext, identity, other)
                .sampleFrom(place, "periodic", driveSessionId = sample.driveSessionId)
                ?.takeIf { it.networkType.isNotBlank() && it.networkType != "UNKNOWN" }
                ?.let { queue.append(it) }
        }
        return Result.success()
    }
}
