package np.nepaltelecom.telemetry.collector

import android.Manifest
import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.provider.Settings
import android.telephony.CellSignalStrengthGsm
import android.telephony.CellSignalStrengthLte
import android.telephony.CellSignalStrengthNr
import android.telephony.CellSignalStrengthWcdma
import android.telephony.ServiceState
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat

/**
 * Why a reading has (or lacks) a cell, sent with every sample (2026-10-26).
 *
 * A reading with no network used to look like "no service", but on prod and
 * here nearly all of them had no GPS position either: the phone had withheld
 * both, because the app was in the background without background location,
 * or location was switched off. A real coverage gap still gets a position.
 * These fields let the server tell the cases apart:
 *
 *   service_state     in_service | out_of_service | emergency_only | radio_off
 *                     (ServiceState: needs phone-state permission, no location)
 *   cell_info_status  ok | background | location_off | no_permission | empty
 *   airplane_mode     true / false
 *   sim_state         ready | absent | locked | other
 */
internal object RadioStatus {
    data class Status(
        val serviceState: String?,
        val cellInfoStatus: String,
        val airplaneMode: Boolean?,
        val simState: String?,
    )

    /** Level read from getSignalStrength(), which needs no location permission. */
    data class SignalOnly(
        val networkType: String,
        val rsrpDbm: Int? = null,
        val rsrqDb: Int? = null,
        val sinrDb: Int? = null,
        val rscpDbm: Int? = null,
        val rssiDbm: Int? = null,
    )

    fun read(context: Context, tm: TelephonyManager?, haveCell: Boolean): Status {
        val cellStatus = when {
            haveCell -> "ok"
            !has(context, Manifest.permission.ACCESS_FINE_LOCATION) -> "no_permission"
            !locationOn(context) -> "location_off"
            inBackground(context) && !hasBackgroundLocation(context) -> "background"
            else -> "empty"
        }
        return Status(serviceState(context, tm), cellStatus, airplaneMode(context), simState(tm))
    }

    fun signalOnly(tm: TelephonyManager?): SignalOnly? {
        if (tm == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val list = runCatching { tm.signalStrength?.cellSignalStrengths }.getOrNull() ?: return null
        fun ok(v: Int, lo: Int = -150, hi: Int = -20) = v.takeIf { it in lo..hi }
        for (s in list) {
            when (s) {
                is CellSignalStrengthLte -> ok(s.rsrp)?.let {
                    return SignalOnly("LTE", rsrpDbm = it, rsrqDb = ok(s.rsrq, -34, 3), sinrDb = ok(s.rssnr, -20, 40))
                }
                is CellSignalStrengthNr -> ok(s.ssRsrp)?.let { return SignalOnly("NR", rsrpDbm = it, rsrqDb = ok(s.ssRsrq, -43, 20)) }
                is CellSignalStrengthWcdma -> ok(s.dbm, -125, -25)?.let { return SignalOnly("UMTS", rscpDbm = it, rssiDbm = it) }
                is CellSignalStrengthGsm -> ok(s.dbm)?.let { return SignalOnly("GSM", rssiDbm = it) }
            }
        }
        return null
    }

    private fun has(context: Context, permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun hasBackgroundLocation(context: Context) =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || has(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)

    private fun locationOn(context: Context): Boolean {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return true
        return runCatching { LocationManagerCompat.isLocationEnabled(lm) }.getOrDefault(true)
    }

    /** True when no screen of the app is in front and no foreground service runs. */
    private fun inBackground(context: Context): Boolean {
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        return info.importance > ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE
    }

    private fun serviceState(context: Context, tm: TelephonyManager?): String? {
        if (tm == null || !has(context, Manifest.permission.READ_PHONE_STATE)) return null
        val state = runCatching { tm.serviceState?.state }.getOrNull() ?: return null
        return when (state) {
            ServiceState.STATE_IN_SERVICE -> "in_service"
            ServiceState.STATE_OUT_OF_SERVICE -> "out_of_service"
            ServiceState.STATE_EMERGENCY_ONLY -> "emergency_only"
            ServiceState.STATE_POWER_OFF -> "radio_off"
            else -> null
        }
    }

    private fun airplaneMode(context: Context): Boolean? =
        runCatching { Settings.Global.getInt(context.contentResolver, Settings.Global.AIRPLANE_MODE_ON, 0) == 1 }.getOrNull()

    private fun simState(tm: TelephonyManager?): String? = when (runCatching { tm?.simState }.getOrNull()) {
        null -> null
        TelephonyManager.SIM_STATE_READY -> "ready"
        TelephonyManager.SIM_STATE_ABSENT -> "absent"
        TelephonyManager.SIM_STATE_PIN_REQUIRED, TelephonyManager.SIM_STATE_PUK_REQUIRED,
        TelephonyManager.SIM_STATE_NETWORK_LOCKED -> "locked"
        else -> "other"
    }
}
