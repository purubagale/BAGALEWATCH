package np.nepaltelecom.telemetry.storage

import np.nepaltelecom.telemetry.model.Sample
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.concurrent.thread

/** The offline queue's count, cap, order and removal (audit 2026-10-23). */
class SampleQueueTest {

    private fun sample(i: Int) = Sample(
        deviceId = "dev", timestampMs = 1_000L + i, lat = 27.7, lon = 85.3, gpsAccuracyM = 5f,
        cellId = 475137L, pci = 116, tac = 10429, mcc = "429", mnc = "01", networkType = "LTE",
        rsrpDbm = -80, rsrqDb = -9, rssiDbm = null, sinrDb = 14, rxQual = null, rscpDbm = null, ecioDb = null,
        batteryPct = 50, triggerReason = "periodic",
    )

    private fun newFile(): File = Files.createTempDirectory("queue").resolve("q.jsonl").toFile()

    @Test
    fun countsAndPeeksInOrder() {
        val q = SampleQueue(newFile(), null)
        repeat(10) { q.append(sample(it)) }
        assertEquals(10, q.size())
        assertEquals(listOf(1_000L, 1_001L, 1_002L), q.peek(3).map { it.timestampMs })
    }

    @Test
    fun countSurvivesANewInstanceAndAFileWrittenEarlier() {
        val file = newFile()
        file.writeText((0 until 7).joinToString("\n", postfix = "\n") { sample(it).toJson().toString() })
        val q = SampleQueue(file, null)
        assertEquals(7, q.size())
        q.append(sample(7))
        assertEquals(8, SampleQueue(file, null).size())
    }

    @Test
    fun removeDropsOnlyUploaded() {
        val q = SampleQueue(newFile(), null)
        repeat(5) { q.append(sample(it)) }
        q.remove(q.peek(2))
        assertEquals(3, q.size())
        assertEquals(1_002L, q.peek(1).single().timestampMs)
    }

    @Test
    fun capKeepsNewestAndTrimsInBatches() {
        val file = newFile()
        val q = SampleQueue(file, null)
        val total = SampleQueue.MAX_QUEUED_SAMPLES + SampleQueue.TRIM_SLACK + 1
        repeat(total) { q.append(sample(it)) }
        assertEquals(SampleQueue.MAX_QUEUED_SAMPLES, q.size())
        assertEquals(SampleQueue.MAX_QUEUED_SAMPLES, file.readLines().count { it.isNotBlank() })
        assertEquals(1_000L + total - SampleQueue.MAX_QUEUED_SAMPLES, q.peek(1).single().timestampMs)
    }

    @Test
    fun twoInstancesOnTwoThreadsLoseNothing() {
        val file = newFile()
        val a = thread { repeat(500) { SampleQueue(file, null).append(sample(it)) } }
        val b = thread { repeat(500) { SampleQueue(file, null).append(sample(10_000 + it)) } }
        a.join(); b.join()
        assertEquals(1_000, SampleQueue(file, null).size())
        assertEquals(1_000, file.readLines().count { it.isNotBlank() })
        assertTrue(SampleQueue(file, null).peek(1_000).size == 1_000)
    }

    @Test
    fun clearEmpties() {
        val q = SampleQueue(newFile(), null)
        repeat(3) { q.append(sample(it)) }
        q.clear()
        assertEquals(0, q.size())
        assertTrue(q.peek(5).isEmpty())
    }
}
