package np.nepaltelecom.telemetry.device

import np.nepaltelecom.telemetry.device.SpeedRatings.Level
import np.nepaltelecom.telemetry.device.SpeedRatings.Use
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeedRatingsTest {

    private fun result(down: Double?, up: Double?, ping: Double?, jitter: Double? = 5.0, loss: Double? = 0.0,
                       loadedDown: Double? = null, loadedUp: Double? = null) =
        SpeedTest.Result(ping, jitter, loss, down, up, null, onMobileData = true,
            latencyDownMs = loadedDown, latencyUpMs = loadedUp)

    @Test
    fun fastAndQuickIsVeryGoodEverywhere() {
        val r = SpeedRatings.rate(result(114.5, 131.3, 7.0, loadedDown = 80.0, loadedUp = 90.0))
        assertTrue(r.values.all { it == Level.VERY_GOOD })
    }

    @Test
    fun loadedLatencyPullsDownGamingAndCalls() {
        // The user's Ookla run: fast, 7 ms idle, but 180 / 349 ms under load.
        val r = SpeedRatings.rate(result(114.5, 131.3, 7.0, loadedDown = 180.0, loadedUp = 349.0))
        assertEquals(Level.VERY_GOOD, r[Use.VIDEO])
        assertEquals(Level.FAIR, r[Use.GAMING])
        assertEquals(Level.FAIR, r[Use.VIDEO_CALL])
        assertEquals(Level.GOOD, r[Use.BROWSING])
    }

    @Test
    fun slowLineIsPoorAndNoDownloadMeansNoRating() {
        assertEquals(Level.POOR, SpeedRatings.rate(result(0.5, 0.2, 300.0))[Use.VIDEO_CALL])
        assertTrue(SpeedRatings.rate(result(null, null, 20.0)).isEmpty())
    }
}
