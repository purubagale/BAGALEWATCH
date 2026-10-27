package np.nepaltelecom.telemetry.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Which neighbour cells go with a reading, and their trip through the queue (2026-10-27). */
class NeighbourCellsTest {

    private fun lte(pci: Int?, rsrp: Int?, serving: Boolean = false) = CellReading(
        networkType = "LTE", isServing = serving, mcc = null, mnc = null, cellId = null, pci = pci, tac = null,
        earfcn = 1850, scramblingCode = null, bcch = null, bsic = null, rsrpDbm = rsrp, rsrqDb = -11,
        sinrDb = null, rssiDbm = null, rscpDbm = null, ecioDb = null, band = 3,
    )

    private fun gsm(bcch: Int, rssi: Int) = CellReading(
        networkType = "GSM", isServing = false, mcc = null, mnc = null, cellId = null, pci = null, tac = null,
        earfcn = null, scramblingCode = null, bcch = bcch, bsic = 12, rsrpDbm = null, rsrqDb = null,
        sinrDb = null, rssiDbm = rssi, rscpDbm = null, ecioDb = null,
    )

    @Test
    fun keepsStrongestOfServingTechFirstWithinCaps() {
        val cells = (1..10).map { lte(it, -120 + it) } + (1..5).map { gsm(10 + it, -90 + it) } +
            lte(99, -60, serving = true) + lte(null, -70) + lte(50, null)
        val picked = NeighbourCells.select(cells, "LTE")
        assertEquals(NeighbourCells.MAX_TOTAL, picked.size)
        // Six 4G cells, strongest first, then two of the 2G ones.
        assertEquals(listOf(10, 9, 8, 7, 6, 5), picked.take(6).map { it.pci })
        assertEquals(listOf(15, 14), picked.drop(6).map { it.bcch })
        assertTrue(picked.none { it.isServing || it.pci == 99 || it.pci == 50 })
    }

    @Test
    fun survivesTheQueueRoundTrip() {
        val sample = Sample(
            deviceId = "dev", timestampMs = 1L, lat = 27.7, lon = 85.3, gpsAccuracyM = 5f, cellId = 475137L,
            pci = 116, tac = 10429, mcc = "429", mnc = "01", networkType = "LTE", rsrpDbm = -80, rsrqDb = -9,
            rssiDbm = null, sinrDb = 14, rxQual = null, rscpDbm = null, ecioDb = null, batteryPct = 50,
            triggerReason = "periodic", neighbours = listOf(lte(65, -98), gsm(42, -71)),
        )
        val back = Sample.fromJson(sample.toJson())
        assertEquals(listOf(65, null), back.neighbours?.map { it.pci })
        assertEquals(listOf(1850, null), back.neighbours?.map { it.earfcn })
        assertEquals(42, back.neighbours?.get(1)?.bcch)
        assertEquals(-71, back.neighbours?.get(1)?.rssiDbm)
    }
}
