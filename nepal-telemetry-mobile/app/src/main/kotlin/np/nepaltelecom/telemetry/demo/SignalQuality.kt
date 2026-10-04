package np.nepaltelecom.telemetry.demo

import androidx.annotation.ColorRes

/**
 * Quality bands for a received-signal reading in dBm, using the same cut-offs
 * as the DT-WATCH web app's RSRP colour scale. The phone's own labels are not
 * used, so the app and the dashboard read the same reading the same way.
 */
object SignalQuality {

    fun label(dbm: Int?): String = when {
        dbm == null -> "No reading"
        dbm >= -77 -> "Excellent"
        dbm >= -87 -> "Good"
        dbm >= -95 -> "Fair"
        dbm >= -105 -> "Moderate"
        else -> "Poor"
    }

    @ColorRes
    fun colorRes(dbm: Int?): Int = when {
        dbm == null -> R.color.q_nodata
        dbm >= -77 -> R.color.q_excellent
        dbm >= -87 -> R.color.q_good
        dbm >= -95 -> R.color.q_fair
        dbm >= -105 -> R.color.q_moderate
        else -> R.color.q_poor
    }
}
