package np.nepaltelecom.telemetry.collector

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.telephony.CellInfo
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.CellInfoWcdma
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import kotlinx.coroutines.suspendCancellableCoroutine
import np.nepaltelecom.telemetry.model.Sample
import np.nepaltelecom.telemetry.storage.DeviceIdentity
import kotlin.coroutines.resume

/**
 * Turns "what's the phone's current cell/signal/location state" into one
 * [Sample]. Deliberately reads everything fresh at call time rather than
 * caching -- callers (periodic worker, handover listener) decide *when* to
 * sample; this class only decides *what* a sample contains.
 *
 * Every cell/signal field here comes from [TelephonyManager.getAllCellInfo],
 * a public API gated behind ACCESS_FINE_LOCATION since Android 10 -- Android
 * itself treats this data as location-revealing, which is exactly why the
 * SDK's own opt-in gate (see NetTelemetry.kt) sits in front of this class
 * rather than the other way around.
 */
internal class CellSampleCollector(
    private val context: Context,
    private val identity: DeviceIdentity,
) {
    private val telephonyManager =
        context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
    private val fusedLocationClient = LocationServices.getFusedLocationProviderClient(context)

    private fun hasLocationPermission() =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission") // guarded by hasLocationPermission() below
    suspend fun collect(triggerReason: String): Sample? {
        if (!identity.optedIn) return null // defense in depth -- see NetTelemetry.optIn/optOut
        if (!hasLocationPermission()) return null

        val cell = readServingCell()
        val location = readLocationWithTimeout()

        return buildSample(cell, location, triggerReason)
    }

    /**
     * Just the cell + location half of [collect], with no opt-in/permission
     * gating of its own -- for callers (currently [np.nepaltelecom.telemetry
     * .collector.VolteCallQualityListener]) that need the same cell/GPS
     * snapshot but build a different sample type around it, and that already
     * do their own opt-in/permission checks before calling this.
     */
    @SuppressLint("MissingPermission") // caller is responsible for the permission check, same contract as collect()
    suspend fun readCellAndLocation(): CellLocationSnapshot {
        val cell = readServingCell()
        val location = readLocationWithTimeout()
        return CellLocationSnapshot(cell, location)
    }

    private fun buildSample(cell: ParsedCell?, location: android.location.Location?, triggerReason: String): Sample {
        return Sample(
            deviceId = identity.deviceId,
            timestampMs = System.currentTimeMillis(),
            lat = location?.latitude,
            lon = location?.longitude,
            gpsAccuracyM = location?.accuracy,
            cellId = cell?.cellId,
            pci = cell?.pci,
            tac = cell?.tac,
            mcc = cell?.mcc,
            mnc = cell?.mnc,
            networkType = cell?.networkType ?: "UNKNOWN",
            rsrpDbm = cell?.rsrpDbm,
            rsrqDb = cell?.rsrqDb,
            rssiDbm = cell?.rssiDbm,
            sinrDb = cell?.sinrDb,
            rxQual = cell?.rxQual,
            rscpDbm = cell?.rscpDbm,
            ecioDb = cell?.ecioDb,
            cqi = cell?.cqi,
            batteryPct = readBatteryPct(),
            triggerReason = triggerReason,
        )
    }

    /** A short-lived, one-shot location request -- not a continuous fix, to keep GPS-on time minimal. */
    private suspend fun readLocationWithTimeout(): android.location.Location? =
        suspendCancellableCoroutine { cont ->
            val cancelSource = CancellationTokenSource()
            cont.invokeOnCancellation { cancelSource.cancel() }
            try {
                fusedLocationClient.getCurrentLocation(
                    CurrentLocationRequest.Builder()
                        .setPriority(Priority.PRIORITY_BALANCED_POWER_ACCURACY)
                        .setDurationMillis(10_000)
                        .build(),
                    cancelSource.token,
                ).addOnSuccessListener { loc -> if (cont.isActive) cont.resume(loc) }
                    .addOnFailureListener { if (cont.isActive) cont.resume(null) }
            } catch (e: SecurityException) {
                if (cont.isActive) cont.resume(null)
            }
        }

    @SuppressLint("MissingPermission")
    private fun readServingCell(): ParsedCell? {
        val allCellInfo: List<CellInfo> = try {
            telephonyManager.allCellInfo ?: emptyList()
        } catch (e: SecurityException) {
            emptyList()
        }
        // Prefer the registered (serving) cell; if none is flagged registered
        // (seen on a few OEMs), fall back to the first entry rather than
        // reporting nothing.
        val serving = allCellInfo.firstOrNull { it.isRegistered } ?: allCellInfo.firstOrNull()
        return serving?.let { parseCellInfo(it) }
    }

    private fun parseCellInfo(info: CellInfo): ParsedCell? = when (info) {
        // NOTE: ci/cid on Lte/Wcdma/Gsm identities are Int; ParsedCell.cellId
        // is Long only because NR's nci (below) genuinely needs the wider
        // range. cellIdToLongOrNull() does the sentinel-check-then-widen in
        // one step so that's not duplicated at every call site.
        is CellInfoLte -> ParsedCell(
            cellId = info.cellIdentity.ci.cellIdToLongOrNull(),
            pci = info.cellIdentity.pci.toIntOrNull(),
            tac = info.cellIdentity.tac.toIntOrNull(),
            mcc = info.cellIdentity.mccString,
            mnc = info.cellIdentity.mncString,
            networkType = "LTE",
            rsrpDbm = info.cellSignalStrength.rsrp.toIntOrNull(),
            rsrqDb = info.cellSignalStrength.rsrq.toIntOrNull(),
            rssiDbm = null,
            // RSSNR (reference signal signal-to-noise ratio) is the closest
            // LTE equivalent exposed here and is conventionally reported as
            // the SINR field for LTE in tools like this one.
            sinrDb = info.cellSignalStrength.rssnr.toIntOrNull(),
            rxQual = null,
            rscpDbm = null,
            ecioDb = null,
            // CellSignalStrengthLte.getCqi() was only added in API 29 -- below
            // that there's no public way to read CQI at all, so this stays
            // null rather than guessing.
            cqi = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) info.cellSignalStrength.cqi.toIntOrNull() else null,
        )
        is CellInfoWcdma -> ParsedCell(
            cellId = info.cellIdentity.cid.cellIdToLongOrNull(),
            pci = info.cellIdentity.psc.toIntOrNull(),
            tac = info.cellIdentity.lac.toIntOrNull(),
            mcc = info.cellIdentity.mccString,
            mnc = info.cellIdentity.mncString,
            networkType = "UMTS",
            rsrpDbm = null,
            rsrqDb = null,
            rssiDbm = info.cellSignalStrength.dbm.toIntOrNull(),
            sinrDb = null,
            rxQual = null,
            // getRscp() and getEcNo() are both dedicated getters added in API
            // 29 -- distinct from the generic getDbm() above, not a reuse of
            // it (confirmed against the backend team's own field reference,
            // which names getRscp() specifically).
            rscpDbm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) info.cellSignalStrength.rscp.toIntOrNull() else null,
            ecioDb = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) info.cellSignalStrength.ecNo.toIntOrNull() else null,
            cqi = null,
        )
        is CellInfoGsm -> ParsedCell(
            cellId = info.cellIdentity.cid.cellIdToLongOrNull(),
            pci = null,
            tac = info.cellIdentity.lac.toIntOrNull(),
            mcc = info.cellIdentity.mccString,
            mnc = info.cellIdentity.mncString,
            networkType = "GSM",
            rsrpDbm = null,
            rsrqDb = null,
            rssiDbm = info.cellSignalStrength.dbm.toIntOrNull(),
            sinrDb = null,
            // getBitErrorRate() reports exactly the RxQual class (0-7) TS
            // 45.008 defines, with 99 as its own "unknown" sentinel --
            // bitErrorRateOrNull() below folds that (and anything else
            // outside 0-7) to null.
            rxQual = info.cellSignalStrength.bitErrorRate.bitErrorRateOrNull(),
            rscpDbm = null,
            ecioDb = null,
            cqi = null,
        )
        else -> parseNrCellInfo(info) // isolated: CellInfoNr needs API 29+, see below
    }

    // Kept in its own function (rather than a fourth `is` branch above) for
    // more than readability: CellInfoNr/CellIdentityNr/CellSignalStrengthNr
    // don't exist in the framework below API 29 (minSdk here is 26), and
    // isolating any reference to them behind an SDK_INT check in a separate
    // method -- checked first, before the class is ever touched -- is the
    // standard way to avoid ART's class-verification choking on a class that
    // doesn't exist on the running device, even in a branch that would never
    // execute there.
    private fun parseNrCellInfo(info: CellInfo): ParsedCell? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        if (info !is CellInfoNr) return null
        val identity = info.cellIdentity as? android.telephony.CellIdentityNr ?: return null
        val strength = info.cellSignalStrength as? android.telephony.CellSignalStrengthNr ?: return null
        return ParsedCell(
            cellId = identity.nci.takeIf { it != CellInfo.UNAVAILABLE_LONG },
            pci = identity.pci.toIntOrNull(),
            tac = identity.tac.toIntOrNull(),
            mcc = identity.mccString,
            mnc = identity.mncString,
            networkType = "NR",
            rsrpDbm = strength.ssRsrp.toIntOrNull(),
            rsrqDb = strength.ssRsrq.toIntOrNull(),
            rssiDbm = null,
            sinrDb = strength.ssSinr.toIntOrNull(),
            rxQual = null,
            rscpDbm = null,
            ecioDb = null,
            // CellSignalStrengthNr has no public CQI getter as of this API
            // level -- left null rather than guessing; flag it back per the
            // mobile guide's §12 note if that ever changes.
            cqi = null,
        )
    }

    private fun readBatteryPct(): Int? {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return null
        val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return pct.takeIf { it in 0..100 }
    }

    // internal, not private -- VolteCallQualityListener (via
    // readCellAndLocation()/CellLocationSnapshot below) needs to read
    // cellId/pci/tac/mcc/mnc off this from outside this class.
    internal data class ParsedCell(
        val cellId: Long?,
        val pci: Int?,
        val tac: Int?,
        val mcc: String?,
        val mnc: String?,
        val networkType: String,
        val rsrpDbm: Int?,
        val rsrqDb: Int?,
        val rssiDbm: Int?,
        val sinrDb: Int?,
        val rxQual: Int?,
        val rscpDbm: Int?,
        val ecioDb: Int?,
        val cqi: Int?,
    )
}

/** Result of [CellSampleCollector.readCellAndLocation] -- a raw cell + GPS snapshot, not yet shaped into any particular sample type. */
internal data class CellLocationSnapshot(
    val cell: CellSampleCollector.ParsedCell?,
    val location: android.location.Location?,
)

// Android's telephony APIs use Int.MAX_VALUE / CellInfo.UNAVAILABLE (also
// Int.MAX_VALUE) as an "unknown/unavailable" sentinel instead of throwing or
// returning null. Surfacing that as an actual Int.MAX_VALUE in uploaded data
// would look like a real, absurd reading -- these convert it to a proper
// null wherever such a field is read above.
private fun Int.toIntOrNull(): Int? = if (this == Int.MAX_VALUE || this == CellInfo.UNAVAILABLE) null else this
private fun Int.cellIdToLongOrNull(): Long? = this.toIntOrNull()?.toLong()
// TS 27.007 §8.5 defines RxQual as 0-7, with 99 as its own separate "unknown"
// sentinel (not Int.MAX_VALUE/CellInfo.UNAVAILABLE like the fields above) --
// anything outside the valid range folds to null the same way.
private fun Int.bitErrorRateOrNull(): Int? = if (this in 0..7) this else null
