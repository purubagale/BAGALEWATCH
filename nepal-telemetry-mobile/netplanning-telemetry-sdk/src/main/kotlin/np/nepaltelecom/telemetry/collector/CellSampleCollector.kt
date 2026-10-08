package np.nepaltelecom.telemetry.collector

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.telephony.CellIdentityGsm
import android.telephony.CellIdentityLte
import android.telephony.CellIdentityWcdma
import android.telephony.CellInfo
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.CellInfoWcdma
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import kotlinx.coroutines.suspendCancellableCoroutine
import np.nepaltelecom.telemetry.model.CellReading
import np.nepaltelecom.telemetry.model.Sample
import np.nepaltelecom.telemetry.storage.DeviceIdentity
import kotlin.coroutines.resume

// Location quality targets (2026-10-04). A fix at or under GOOD_FIX_ACCURACY_M
// is accepted at once; otherwise up to LOCATION_ATTEMPTS requests are made and
// the most accurate one is kept.
private const val TAG = "NetTelemetry.Cells"
private const val GOOD_FIX_ACCURACY_M = 15f
private const val LOCATION_ATTEMPTS = 3

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
    private val telephonyManager = defaultDataTelephony(context)
    private val fusedLocationClient = LocationServices.getFusedLocationProviderClient(context)

    private fun hasLocationPermission() =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission") // guarded by hasLocationPermission() below
    suspend fun collect(
        triggerReason: String,
        // Samples taken during a share window carry its session ID (2026-10-07).
        driveSessionId: String? = ShareWindow.currentSessionId(context),
    ): Sample? {
        if (!identity.optedIn) return null // defense in depth -- see NetTelemetry.optIn/optOut
        if (!hasLocationPermission()) return null
        return sampleFrom(readLocationWithTimeout(), triggerReason, driveSessionId = driveSessionId)
    }

    /**
     * A local read for the phone's own screens (2026-10-05). Needs only location
     * permission, not opt-in, and nothing it returns is queued or uploaded.
     */
    @SuppressLint("MissingPermission") // guarded by hasLocationPermission() below
    suspend fun collectLive(triggerReason: String): Sample? {
        if (!hasLocationPermission()) return null
        return sampleFrom(readLocationWithTimeout(), triggerReason, requireOptIn = false)
    }

    /**
     * Builds a sample from a location the caller already has. Drive-test
     * tracking uses this so each fix doesn't wait for a fresh location request.
     */
    @SuppressLint("MissingPermission") // guarded by hasLocationPermission() below
    fun sampleFrom(
        location: android.location.Location?,
        triggerReason: String,
        driveSessionId: String? = null,
        requireOptIn: Boolean = true,
    ): Sample? {
        // Uploads need opt-in. A local live read (requireOptIn = false) only
        // shows the phone its own readings and never queues anything.
        if (requireOptIn && !identity.optedIn) return null
        if (!hasLocationPermission()) return null

        val cell = readServingCell()

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
            cqi = cell?.cqi,
            rxQual = cell?.rxQual,
            rscpDbm = cell?.rscpDbm,
            ecioDb = cell?.ecioDb,
            scramblingCode = cell?.scramblingCode,
            bcch = cell?.bcch,
            bsic = cell?.bsic,
            batteryPct = readBatteryPct(),
            triggerReason = triggerReason,
            driveSessionId = driveSessionId,
        )
    }

    /**
     * One location for a sample, held to an accuracy target. Attempts repeat
     * until a fix at or under [GOOD_FIX_ACCURACY_M] arrives, or until
     * [LOCATION_ATTEMPTS] are used. The most accurate fix seen is kept. A
     * single attempt often returns a coarse network-assisted fix, which is
     * what made routes look jagged.
     */
    private suspend fun readLocationWithTimeout(): android.location.Location? {
        var best: android.location.Location? = null
        repeat(LOCATION_ATTEMPTS) {
            val fix = requestOneFix()
            if (fix != null && (best?.accuracy ?: Float.MAX_VALUE) > fix.accuracy) best = fix
            val current = best
            if (current != null && current.accuracy <= GOOD_FIX_ACCURACY_M) return current
        }
        return best
    }

    /** A short-lived, one-shot location request -- not a continuous fix, to keep GPS-on time minimal. */
    private suspend fun requestOneFix(): android.location.Location? =
        suspendCancellableCoroutine { cont ->
            val cancelSource = CancellationTokenSource()
            cont.invokeOnCancellation { cancelSource.cancel() }
            try {
                fusedLocationClient.getCurrentLocation(
                    CurrentLocationRequest.Builder()
                        .setPriority(Priority.PRIORITY_HIGH_ACCURACY)
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
        val allCellInfo: List<CellInfo> = readTelephonyCells().ifEmpty { CellInfoCache.fresh() }
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
            mcc = info.cellIdentity.mccCompat(),
            mnc = info.cellIdentity.mncCompat(),
            networkType = "LTE",
            rsrpDbm = info.cellSignalStrength.rsrp.toIntOrNull(),
            rsrqDb = info.cellSignalStrength.rsrq.toIntOrNull(),
            rssiDbm = null,
            // RSSNR (reference signal signal-to-noise ratio) is the closest
            // LTE equivalent exposed here and is conventionally reported as
            // the SINR field for LTE in tools like this one.
            sinrDb = info.cellSignalStrength.rssnr.toIntOrNull(),
            // CQI is API 29+ on LTE; no public CQI getter on older releases.
            cqi = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) info.cellSignalStrength.cqi.toIntOrNull() else null,
            rxQual = null,
            rscpDbm = null,
            ecioDb = null,
        )
        // rscp/ecNo (2026-09-03, "for 3g rscp and ec/io"). Only getEcNo()
        // is public SDK API (added in API 30, R) -- getRscp() exists on
        // CellSignalStrengthWcdma but is @hide, so it can't be called
        // directly. For WCDMA, getDbm() already reports the value in the
        // RSCP domain (dBm of the CPICH), so it doubles as the RSCP
        // reading here; it's also kept in rssiDbm as the generic signal
        // fallback. getEcNo() stays behind an SDK_INT guard (see below).
        is CellInfoWcdma -> ParsedCell(
            cellId = info.cellIdentity.cid.cellIdToLongOrNull(),
            // The UMTS primary scrambling code goes in its own field, not in
            // pci: pci is the LTE physical cell id, and mixing the two in one
            // column is what made 3G serving-cell matching ambiguous (2026-10-04).
            pci = null,
            scramblingCode = info.cellIdentity.psc.toIntOrNull(),
            tac = info.cellIdentity.lac.toIntOrNull(),
            mcc = info.cellIdentity.mccCompat(),
            mnc = info.cellIdentity.mncCompat(),
            networkType = "UMTS",
            rsrpDbm = null,
            rsrqDb = null,
            rssiDbm = info.cellSignalStrength.dbm.toIntOrNull(),
            sinrDb = null,
            rxQual = null,
            rscpDbm = info.cellSignalStrength.dbm.toIntOrNull(),
            // Android's public method is named getEcNo() -- the same
            // chip-energy-to-interference metric RAN engineers call Ec/Io
            // for WCDMA pilot quality; stored here as ecioDb/ecio_db to
            // match how this project's own drive-test tooling names it.
            ecioDb = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                info.cellSignalStrength.ecNo.toIntOrNull()
            } else {
                null
            },
        )
        // getBitErrorRate() (2026-09-03, "for 2g rx level and rx qual") --
        // TS 27.007 8.5's GSM bit error rate, 0-7, is the same TS 45.008
        // RXQUAL class a GSM handset itself reports -- but the method was
        // only added to CellSignalStrengthGsm in API 29 (Q), so like
        // WCDMA's ecNo above it sits behind an SDK_INT guard and rxQual is
        // null on API 26-28 devices. "Rx Level" for GSM is the plain signal
        // dBm value already captured as rssiDbm below -- GSM's classic
        // 0-63 RXLEV scale and this dBm figure are the same underlying
        // measurement, just different units; Android doesn't expose a
        // separate raw RXLEV integer, only the dBm conversion.
        is CellInfoGsm -> ParsedCell(
            cellId = info.cellIdentity.cid.cellIdToLongOrNull(),
            pci = null,
            tac = info.cellIdentity.lac.toIntOrNull(),
            mcc = info.cellIdentity.mccCompat(),
            mnc = info.cellIdentity.mncCompat(),
            networkType = "GSM",
            // BCCH ARFCN and BSIC identify the 2G serving cell (2026-10-04).
            // Both getters exist from API 24, below this app's minimum (26).
            bcch = info.cellIdentity.arfcn.toIntOrNull(),
            bsic = info.cellIdentity.bsic.toIntOrNull(),
            rsrpDbm = null,
            rsrqDb = null,
            rssiDbm = info.cellSignalStrength.dbm.toIntOrNull(),
            sinrDb = null,
            rxQual = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                info.cellSignalStrength.bitErrorRate.bitErrorRateOrNull()
            } else {
                null
            },
            rscpDbm = null,
            ecioDb = null,
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
        )
    }

    /**
     * Every cell the modem reports right now: the serving cell plus neighbours.
     * Empty when location permission is missing. Local read only; the caller
     * decides what, if anything, to do with the result.
     */
    @SuppressLint("MissingPermission") // guarded by hasLocationPermission() below
    fun readAllCells(): List<CellReading> {
        if (!hasLocationPermission()) return emptyList()
        val infos = readTelephonyCells().ifEmpty { CellInfoCache.fresh() }
        return dedupeCells(infos.mapNotNull { cellReadingFrom(it) })
    }

    /**
     * Collapses duplicate CellInfo entries for the exact same physical cell
     * (2026-10-08, "app is sometime displaying two serving in cells in
     * view, only one should be serving") -- some modems report the same
     * registered cell as two separate CellInfo entries from one
     * allCellInfo() call (sometimes with slightly different signal
     * snapshots a few hundred ms apart), both flagged isRegistered=true.
     * Real dual-connectivity (e.g. NR+LTE EN-DC) is a DIFFERENT physical
     * cell with its own identity, so it is never collapsed by this --
     * only entries whose network type + cell id + PCI + TAC all match
     * exactly, i.e. the same cell reported twice, ever merge. Within a
     * duplicate group, keeps only the strongest reading; the kept entry
     * is marked serving if ANY entry in its group was.
     */
    private fun dedupeCells(readings: List<CellReading>): List<CellReading> {
        val groups = LinkedHashMap<String, MutableList<CellReading>>()
        for (r in readings) {
            val key = "${r.networkType}|${r.cellId}|${r.pci}|${r.tac}"
            groups.getOrPut(key) { mutableListOf() }.add(r)
        }
        return groups.values.map { group ->
            if (group.size == 1) return@map group[0]
            val anyServing = group.any { it.isServing }
            val strongest = group.maxByOrNull { primaryDbmFor(it) ?: Int.MIN_VALUE } ?: group[0]
            if (anyServing && !strongest.isServing) strongest.copy(isServing = true) else strongest
        }
    }

    /** Same per-tech "which field is the real signal reading" rule CellsFragment.kt's own primaryDbm() uses. */
    private fun primaryDbmFor(c: CellReading): Int? = when (c.networkType) {
        "LTE" -> c.rsrpDbm ?: c.rssiDbm
        "UMTS" -> c.rscpDbm ?: c.rssiDbm
        else -> c.rssiDbm
    }

    /**
     * A direct cell read across every active SIM (2026-10-04). On dual-SIM
     * phones the default data SIM can have no registered cell while the other
     * SIM does, so the first SIM that reports cells wins. Empty when none does.
     */
    private fun readTelephonyCells(): List<CellInfo> {
        val managers = activeSimTelephonyManagers()
        for ((i, tm) in managers.withIndex()) {
            val cells = try {
                tm.allCellInfo
            } catch (e: SecurityException) {
                android.util.Log.d(TAG, "sim $i allCellInfo denied: ${e.message}")
                null
            }
            android.util.Log.d(TAG, "sim $i of ${managers.size}: ${cells?.size ?: -1} cells")
            if (!cells.isNullOrEmpty()) return cells
        }
        android.util.Log.d(TAG, "no SIM reported cells; cache size ${CellInfoCache.fresh().size}")
        return emptyList()
    }

    private fun activeSimTelephonyManagers(): List<TelephonyManager> {
        val base = telephonyManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                val subs = SubscriptionManager.from(context).getActiveSubscriptionInfoList().orEmpty()
                if (subs.isNotEmpty()) return subs.map { base.createForSubscriptionId(it.subscriptionId) }
            } catch (e: SecurityException) {
                // Phone-state permission not granted: use the plain manager.
            }
        }
        return listOf(base)
    }

    private fun cellReadingFrom(info: CellInfo): CellReading? = when (info) {
        is CellInfoLte -> {
            val id = info.cellIdentity
            val sig = info.cellSignalStrength
            CellReading(
                networkType = "LTE",
                isServing = info.isRegistered,
                mcc = id.mccCompat(),
                mnc = id.mncCompat(),
                cellId = id.ci.cellIdToLongOrNull(),
                pci = id.pci.toIntOrNull(),
                tac = id.tac.toIntOrNull(),
                earfcn = id.earfcn.toIntOrNull(),
                scramblingCode = null,
                bcch = null,
                bsic = null,
                rsrpDbm = sig.rsrp.toIntOrNull(),
                rsrqDb = sig.rsrq.toIntOrNull(),
                sinrDb = sig.rssnr.toIntOrNull(),
                rssiDbm = sig.dbm.toIntOrNull(),
                rscpDbm = null,
                ecioDb = null,
                cqi = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) sig.cqi.toIntOrNull() else null,
            )
        }
        is CellInfoWcdma -> {
            val id = info.cellIdentity
            val sig = info.cellSignalStrength
            CellReading(
                networkType = "UMTS",
                isServing = info.isRegistered,
                mcc = id.mccCompat(),
                mnc = id.mncCompat(),
                cellId = id.cid.cellIdToLongOrNull(),
                pci = null,
                tac = id.lac.toIntOrNull(),
                earfcn = id.uarfcn.toIntOrNull(),
                scramblingCode = id.psc.toIntOrNull(),
                bcch = null,
                bsic = null,
                rsrpDbm = null,
                rsrqDb = null,
                sinrDb = null,
                rssiDbm = sig.dbm.toIntOrNull(),
                rscpDbm = sig.dbm.toIntOrNull(),
                ecioDb = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    sig.ecNo.toIntOrNull()
                } else {
                    null
                },
            )
        }
        is CellInfoGsm -> {
            val id = info.cellIdentity
            val sig = info.cellSignalStrength
            CellReading(
                networkType = "GSM",
                isServing = info.isRegistered,
                mcc = id.mccCompat(),
                mnc = id.mncCompat(),
                cellId = id.cid.cellIdToLongOrNull(),
                pci = null,
                tac = id.lac.toIntOrNull(),
                earfcn = null,
                scramblingCode = null,
                bcch = id.arfcn.toIntOrNull(),
                bsic = id.bsic.toIntOrNull(),
                rsrpDbm = null,
                rsrqDb = null,
                sinrDb = null,
                rssiDbm = sig.dbm.toIntOrNull(),
                rscpDbm = null,
                ecioDb = null,
            )
        }
        else -> null // NR and anything else: not shown in this version
    }

    private fun readBatteryPct(): Int? {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return null
        val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return pct.takeIf { it in 0..100 }
    }

    private data class ParsedCell(
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
        // 2026-09-03 additions -- see the CellInfoGsm/CellInfoWcdma branches
        // above for what populates each: rxQual is GSM-only, rscpDbm/ecioDb
        // are WCDMA-only. Always null for LTE/NR, same nullable-by-RAT
        // pattern as rsrpDbm/rssiDbm etc. above.
        val rxQual: Int?,
        val rscpDbm: Int?,
        val ecioDb: Int?,
        // 2026-10-04 -- serving-cell identities for 3G (scrambling code) and
        // 2G (BCCH, BSIC). Null for every other RAT.
        val scramblingCode: Int? = null,
        val bcch: Int? = null,
        val bsic: Int? = null,
        // 2026-10-05 -- LTE CQI the modem reports (API 29+). Null for other RATs.
        val cqi: Int? = null,
    )
}

// Android's telephony APIs use Int.MAX_VALUE / CellInfo.UNAVAILABLE (also
// Int.MAX_VALUE) as an "unknown/unavailable" sentinel instead of throwing or
// returning null. Surfacing that as an actual Int.MAX_VALUE in uploaded data
// would look like a real, absurd reading -- these convert it to a proper
// null wherever such a field is read above.
private fun Int.toIntOrNull(): Int? = if (this == Int.MAX_VALUE || this == CellInfo.UNAVAILABLE) null else this
private fun Int.cellIdToLongOrNull(): Long? = this.toIntOrNull()?.toLong()

// getMccString()/getMncString() only exist from API 28 (P); calling them on
// an API 26-27 device throws NoSuchMethodError. Below P the only source is
// the deprecated Int getters, which drop leading zeros -- MCC is always 3
// digits so it pads back exactly, but MNC's width (2 or 3 digits) isn't
// recoverable from an Int, so it is padded to 2, which is correct for Nepal
// (429/01, 429/02) and every other 2-digit-MNC country.
@Suppress("DEPRECATION")
private fun CellIdentityLte.mccCompat(): String? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) mccString else mcc.legacyPlmnOrNull(3)
@Suppress("DEPRECATION")
private fun CellIdentityLte.mncCompat(): String? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) mncString else mnc.legacyPlmnOrNull(2)
@Suppress("DEPRECATION")
private fun CellIdentityWcdma.mccCompat(): String? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) mccString else mcc.legacyPlmnOrNull(3)
@Suppress("DEPRECATION")
private fun CellIdentityWcdma.mncCompat(): String? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) mncString else mnc.legacyPlmnOrNull(2)
@Suppress("DEPRECATION")
private fun CellIdentityGsm.mccCompat(): String? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) mccString else mcc.legacyPlmnOrNull(3)
@Suppress("DEPRECATION")
private fun CellIdentityGsm.mncCompat(): String? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) mncString else mnc.legacyPlmnOrNull(2)

private fun Int.legacyPlmnOrNull(width: Int): String? =
    this.toIntOrNull()?.takeIf { it >= 0 }?.toString()?.padStart(width, '0')

// getBitErrorRate()'s own "unknown" sentinel is 99, not Int.MAX_VALUE/
// CellInfo.UNAVAILABLE like every other field above -- per TS 27.007 8.5,
// a real RxQual/BER reading is always 0-7, so 99 needs its own check or it
// would be stored as a bogus "RxQual 99".
private fun Int.bitErrorRateOrNull(): Int? = if (this == 99) null else this.toIntOrNull()

// Dual-SIM phones (2026-10-04): the plain TelephonyManager can be bound to a SIM
// with no service. On Android 12+ bind to the default data SIM instead, which
// is the one carrying traffic. Falls back to the plain manager on older
// Android or when the default SIM can't be read.
private fun defaultDataTelephony(context: Context): TelephonyManager {
    val base = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        try {
            val subId = SubscriptionManager.getDefaultDataSubscriptionId()
            if (subId != SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
                return base.createForSubscriptionId(subId)
            }
        } catch (e: SecurityException) {
            // Phone-state permission not granted yet: use the plain manager.
        }
    }
    return base
}

