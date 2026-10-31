package np.nepaltelecom.telemetry.collector

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.telephony.SubscriptionManager

/** One active SIM (2026-10-31). [slot] counts from 1. */
data class SimInfo(
    val slot: Int,
    val subId: Int,
    val carrierName: String?,
    val mcc: String?,
    val mnc: String?,
) {
    /** Nepal Telecom's own SIM: the only second SIM whose readings are sent. */
    val isNtc: Boolean get() = SimSlots.opKey(mcc, mnc) == NTC_OPERATOR

    private companion object {
        const val NTC_OPERATOR = "429/1"
    }
}

/**
 * Two-SIM phones (2026-10-31). Android's cell list holds the registered cell
 * of every SIM, whichever SIM is asked, so a SIM's own cell is found by its
 * operator; for two SIMs of one operator, by their order. The phone's number
 * and IMEI are not read here: Android keeps them from ordinary apps.
 */
object SimSlots {

    /** The active SIMs in slot order; empty without the phone permission or a SIM. */
    @SuppressLint("MissingPermission") // a missing permission is caught below
    fun active(context: Context): List<SimInfo> = try {
        val subs = (context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as? SubscriptionManager)
            ?.activeSubscriptionInfoList.orEmpty()
        subs.sortedBy { it.simSlotIndex }.map { s ->
            val (mcc, mnc) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                s.mccString to s.mncString
            } else {
                @Suppress("DEPRECATION")
                s.mcc.toString() to s.mnc.toString()
            }
            SimInfo(s.simSlotIndex + 1, s.subscriptionId, s.carrierName?.toString(), mcc, mnc)
        }
    } catch (e: SecurityException) {
        emptyList()
    }

    /** The SIM set for mobile data, or null when Android does not say. */
    fun dataSim(sims: List<SimInfo>): SimInfo? {
        val id = SubscriptionManager.getDefaultDataSubscriptionId()
        return sims.firstOrNull { it.subId == id }
    }

    /** "429/1" for 429 and 01: a cell and a SIM can spell the same operator differently. */
    internal fun opKey(mcc: String?, mnc: String?): String? {
        val c = mcc?.trim()?.toIntOrNull() ?: return null
        val n = mnc?.trim()?.toIntOrNull() ?: return null
        return "$c/$n"
    }

    /**
     * The registered cell that belongs to [own]. With one SIM, the first. With
     * two, one whose operator matches; two SIMs of one operator take their
     * cells in slot order. Null when none matches.
     */
    internal fun <T> pick(registered: List<T>, operatorOf: (T) -> String?, sims: List<SimInfo>, own: SimInfo?): T? {
        if (sims.size < 2 || own == null) return registered.firstOrNull()
        val key = opKey(own.mcc, own.mnc)
        val same = registered.filter { operatorOf(it) == key }
        val order = sims.filter { opKey(it.mcc, it.mnc) == key }.indexOfFirst { it.subId == own.subId }
        return same.getOrNull(order) ?: same.firstOrNull()
    }
}
