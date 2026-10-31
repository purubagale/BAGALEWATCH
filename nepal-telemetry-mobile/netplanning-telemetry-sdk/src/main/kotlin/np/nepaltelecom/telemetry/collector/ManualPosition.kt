package np.nepaltelecom.telemetry.collector

import android.content.Context

/**
 * A spot the person marked on the map for an indoor test (2026-10-30).
 * Indoors GPS can sit 20 to 50 m off for minutes while claiming +/-15 m, so
 * the route lands on the neighbour's house. While a spot is set, every drive
 * reading takes it instead of GPS and is sent with `position_source:
 * "manual"`. It is cleared when the person picks Outdoors or In a vehicle,
 * goes back to automatic, or stops the drive (see Environment.setManual).
 */
object ManualPosition {

    private const val PREFS = "netplanning_manual_position"
    private const val KEY_LAT = "lat"
    private const val KEY_LNG = "lng"
    const val SOURCE = "manual"

    fun get(context: Context): Pair<Double, Double>? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.contains(KEY_LAT) || !prefs.contains(KEY_LNG)) return null
        return java.lang.Double.longBitsToDouble(prefs.getLong(KEY_LAT, 0)) to
            java.lang.Double.longBitsToDouble(prefs.getLong(KEY_LNG, 0))
    }

    fun set(context: Context, lat: Double, lng: Double) {
        if (lat !in -90.0..90.0 || lng !in -180.0..180.0) return
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putLong(KEY_LAT, java.lang.Double.doubleToRawLongBits(lat))
            .putLong(KEY_LNG, java.lang.Double.doubleToRawLongBits(lng))
            .apply()
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    }
}
