package np.nepaltelecom.telemetry.collector

import android.content.Context
import android.location.Location

/**
 * Where a reading was taken: outdoors, inside a building or in a vehicle
 * (2026-10-26). Indoor readings are often 10-20 dB weaker than outdoor ones
 * on the same street, so mixing them made a building look like a coverage
 * hole. Sent with every sample as `environment` and `environment_source`:
 *
 *   user       the person tapped Outdoors / Inside a building / In a vehicle;
 *              it holds for every reading until the next tap or until the
 *              drive or sharing session ends
 *   estimated  no tap: worked out from the fix the reading already has --
 *              moving faster than [VEHICLE_SPEED_MS] is a vehicle; a poor fix
 *              (worse than [INDOOR_ACCURACY_M]) while hardly moving is
 *              probably indoors; anything else outdoors
 *
 * No position, no estimate (null). Nothing here asks for a new permission.
 */
object Environment {
    const val OUTDOOR = "outdoor"
    const val INDOOR = "indoor"
    const val VEHICLE = "vehicle"
    val ALL = listOf(OUTDOOR, INDOOR, VEHICLE)

    private const val PREFS = "netplanning_environment"
    private const val KEY = "manual"
    private const val VEHICLE_SPEED_MS = 4.2f    // about 15 km/h
    private const val STILL_SPEED_MS = 1.0f
    private const val INDOOR_ACCURACY_M = 30f

    /** The person's choice, or null for "decide for me". */
    fun manual(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)?.takeIf { it in ALL }

    fun setManual(context: Context, value: String?) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply {
            if (value != null && value in ALL) putString(KEY, value) else remove(KEY)
        }.apply()
    }

    fun estimate(location: Location?): String? {
        val loc = location ?: return null
        val speed = if (loc.hasSpeed()) loc.speed else null
        if (speed != null && speed >= VEHICLE_SPEED_MS) return VEHICLE
        if (loc.hasAccuracy() && loc.accuracy > INDOOR_ACCURACY_M && (speed == null || speed < STILL_SPEED_MS)) return INDOOR
        return OUTDOOR
    }

    /** (environment, source) for one reading. */
    fun forSample(context: Context, location: Location?): Pair<String?, String?> {
        manual(context)?.let { return it to "user" }
        return estimate(location)?.let { it to "estimated" } ?: (null to null)
    }
}
