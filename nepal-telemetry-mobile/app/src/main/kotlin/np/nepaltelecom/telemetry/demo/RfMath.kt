package np.nepaltelecom.telemetry.demo

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/** Display helpers for radio and location values. Nothing here is sent anywhere. */
object RfMath {

    /**
     * LTE band for an EARFCN, for the FDD bands in use in Nepal and the region.
     * Approximate: the table covers the bands most often seen here, and an
     * EARFCN outside it is shown as "EARFCN n" rather than guessed.
     */
    fun lteBandLabel(earfcn: Int?): String? {
        val e = earfcn ?: return null
        val band = when (e) {
            in 0..599 -> "B1 · 2100"
            in 1200..1949 -> "B3 · 1800"
            in 2400..2649 -> "B5 · 850"
            in 2750..3449 -> "B7 · 2600"
            in 3450..3799 -> "B8 · 900"
            in 6150..6449 -> "B20 · 800"
            in 9210..9659 -> "B28 · 700"
            else -> null
        }
        return band ?: "EARFCN $e"
    }

    /** Fraction 0..1 of a -140 to -40 dBm range, for drawing a signal bar. */
    fun barFraction(dbm: Int?): Float {
        val v = dbm ?: return 0f
        return ((v + 140f) / 100f).coerceIn(0f, 1f)
    }

    /** Great-circle distance in metres between two points. */
    fun distanceM(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val r = 6_371_000.0
        val p1 = Math.toRadians(lat1)
        val p2 = Math.toRadians(lat2)
        val dPhi = Math.toRadians(lat2 - lat1)
        val dLambda = Math.toRadians(lng2 - lng1)
        val a = sin(dPhi / 2).pow(2) + cos(p1) * cos(p2) * sin(dLambda / 2).pow(2)
        return 2 * r * asin(sqrt(a))
    }
}
