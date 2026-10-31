package np.nepaltelecom.telemetry.collector

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SimSlotsTest {
    private val ntc1 = SimInfo(1, 11, "NT", "429", "01")
    private val ntc2 = SimInfo(2, 12, "NT", "429", "01")
    private val ncell = SimInfo(2, 13, "Ncell", "429", "02")
    private val ops = mapOf("a" to "429/1", "b" to "429/2", "c" to "429/1")

    @Test fun `one SIM takes the first registered cell`() {
        assertEquals("b", SimSlots.pick(listOf("b", "a"), ops::get, listOf(ntc1), ntc1))
    }

    @Test fun `two operators are told apart`() {
        val sims = listOf(ntc1, ncell)
        assertEquals("a", SimSlots.pick(listOf("b", "a"), ops::get, sims, ntc1))
        assertEquals("b", SimSlots.pick(listOf("a", "b"), ops::get, sims, ncell))
    }

    @Test fun `two SIMs of one operator go in slot order`() {
        val sims = listOf(ntc1, ntc2)
        assertEquals("a", SimSlots.pick(listOf("a", "c"), ops::get, sims, ntc1))
        assertEquals("c", SimSlots.pick(listOf("a", "c"), ops::get, sims, ntc2))
    }

    @Test fun `a SIM with no cell of its own gets none`() {
        assertNull(SimSlots.pick(listOf("a"), ops::get, listOf(ntc1, ncell), ncell))
    }

    @Test fun `operator codes compare by value`() {
        assertEquals(SimSlots.opKey("429", "01"), SimSlots.opKey("429", "1"))
        assertTrue(ntc1.isNtc)
        assertTrue(!ncell.isNtc)
    }
}
