package np.nepaltelecom.telemetry.collector

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.CallAttributes
import android.telephony.CallQuality
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import np.nepaltelecom.telemetry.model.VolteSample
import np.nepaltelecom.telemetry.storage.DeviceIdentity
import java.util.concurrent.atomic.AtomicReference

/**
 * VoLTE/VoNR call-quality collection (mobile integration guide §12).
 *
 * VERIFICATION STATUS -- read before relying on this: like the rest of this
 * SDK (see README, "Verification status"), this was written without access
 * to a real Android SDK/compiler in this environment. The RF-sample code
 * elsewhere here uses only long-stable APIs; this file is different -- it's
 * built on android.telephony.CallAttributes/CallQuality, a narrower and
 * newer surface this environment could not compile-check. Treat the method
 * names on [CallQuality] used in [buildAndEmitSample] below (getCallDuration,
 * getCodecType, getDownlinkCallQualityLevel/getUplinkCallQualityLevel,
 * getNumRtpPacketsReceived/getNumRtpPacketsLost, getAverageRelativeJitter,
 * getAverageRoundTripTime) as the part most likely to need a real-device/
 * real-compileSdk check before this ships, even though the surrounding
 * call-state logic (plain CALL_STATE_IDLE/OFFHOOK) is solid, long-standing
 * API and not in question.
 *
 * Requires carrier-privileged app status -- without it, READ_PRECISE_PHONE_STATE
 * is silently denied and [start] below simply never registers anything. There
 * is no "permission silently ignored" signal on this API surface; the absence
 * of errors does NOT mean this is working. Confirm carrier-privileged status
 * against a real device/build, not against this code compiling or running
 * without exceptions.
 *
 * Design: a plain CALL_STATE listener (IDLE/OFFHOOK -- stable since API 1)
 * detects "a call just ended," decoupled from a separate CallAttributes
 * listener that just remembers the most recent CallQuality seen while a call
 * was active. This split exists because the integration guide describes
 * CallAttributes/CallQuality as delivered "during an active call" with no
 * documented explicit end-of-call event of its own -- rather than guess at
 * what a final CallAttributes callback looks like, call end is detected the
 * well-established way and the last known quality snapshot is reported at
 * that point.
 */
internal class VolteCallQualityListener(
    private val context: Context,
    private val identity: DeviceIdentity,
    private val onSampleReady: (VolteSample) -> Unit,
) {
    private val telephonyManager =
        context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
    private val cellCollector = CellSampleCollector(context, identity)
    private val scope = CoroutineScope(Dispatchers.Default)

    private var legacyListener: PhoneStateListener? = null
    private var modernCallback: TelephonyCallback? = null

    private val lastAttributes = AtomicReference<CallAttributes?>(null)
    @Volatile private var wasActive = false

    private fun hasPermission() =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PRECISE_PHONE_STATE) ==
            PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission") // guarded by hasPermission() below
    fun start() {
        // CallAttributes/CallQuality don't exist as public API below this --
        // see the mobile guide's §12.2, which names API 29 as the floor via
        // PhoneStateListener.LISTEN_CALL_ATTRIBUTES_CHANGED.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        if (!hasPermission()) return // silently inert without carrier-privileged status -- see class doc above

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val callback = object : TelephonyCallback(),
                TelephonyCallback.CallStateListener,
                TelephonyCallback.CallAttributesListener {
                override fun onCallStateChanged(state: Int) = handleCallState(state)
                override fun onCallAttributesChanged(callAttributes: CallAttributes) {
                    lastAttributes.set(callAttributes)
                }
            }
            telephonyManager.registerTelephonyCallback(context.mainExecutor, callback)
            modernCallback = callback
        } else {
            @Suppress("DEPRECATION")
            val listener = object : PhoneStateListener() {
                @Deprecated("Deprecated in Java")
                override fun onCallStateChanged(state: Int, phoneNumber: String?) = handleCallState(state)
                @Deprecated("Deprecated in Java")
                override fun onCallAttributesChanged(callAttributes: CallAttributes) {
                    lastAttributes.set(callAttributes)
                }
            }
            @Suppress("DEPRECATION")
            telephonyManager.listen(
                listener,
                PhoneStateListener.LISTEN_CALL_STATE or PhoneStateListener.LISTEN_CALL_ATTRIBUTES_CHANGED,
            )
            legacyListener = listener
        }
    }

    fun stop() {
        modernCallback?.let { telephonyManager.unregisterTelephonyCallback(it) }
        modernCallback = null
        legacyListener?.let {
            @Suppress("DEPRECATION")
            telephonyManager.listen(it, PhoneStateListener.LISTEN_NONE)
        }
        legacyListener = null
        lastAttributes.set(null)
        wasActive = false
    }

    private fun handleCallState(state: Int) {
        val isActive = state == TelephonyManager.CALL_STATE_OFFHOOK
        if (!isActive && wasActive) {
            // Just transitioned out of an active call -- report whatever
            // CallAttributes/CallQuality we last saw while it was up, not
            // anything that might arrive after (there shouldn't be any, but
            // clearing it below means a stale snapshot can never leak into
            // a later, unrelated call either).
            if (!identity.optedIn) {
                lastAttributes.set(null) // still clear it -- see defense-in-depth note in CellSampleCollector
            } else {
                lastAttributes.getAndSet(null)?.let { attributes ->
                    scope.launch { buildAndEmitSample(attributes) }
                }
            }
        }
        wasActive = isActive
    }

    private suspend fun buildAndEmitSample(attributes: CallAttributes) {
        val quality = attributes.callQuality ?: return // nothing usable without this
        val snapshot = cellCollector.readCellAndLocation()
        onSampleReady(
            VolteSample(
                deviceId = identity.deviceId,
                timestampMs = System.currentTimeMillis(),
                callDurationS = (quality.callDuration / 1000),
                codec = quality.codecType.toCodecStringOrNull(),
                packetLossPct = quality.downlinkPacketLossPctOrNull(),
                jitterMs = quality.averageRelativeJitter.toFloat(),
                rttMs = quality.averageRoundTripTime.toFloat(),
                qualityLevel = quality.overallLevelString(),
                networkType = attributes.networkType.toCallNetworkTypeString(),
                lat = snapshot.location?.latitude,
                lon = snapshot.location?.longitude,
                cellId = snapshot.cell?.cellId,
                pci = snapshot.cell?.pci,
                tac = snapshot.cell?.tac,
                mcc = snapshot.cell?.mcc,
                mnc = snapshot.cell?.mnc,
            )
        )
    }
}

/** Downlink loss -- packets this device actually knows it failed to receive, the most directly measurable of the two directions. */
private fun CallQuality.downlinkPacketLossPctOrNull(): Float? {
    val received = numRtpPacketsReceived
    val lost = numRtpPacketsLost
    val total = received + lost
    return if (total > 0) (lost.toFloat() / total.toFloat()) * 100f else null
}

/**
 * CallQuality reports downlink/uplink quality separately; the backend's
 * single `quality_level` field (mobile guide §12.2/field reference §2) wants
 * one value -- report whichever direction is worse (CallQuality's own level
 * constants order best-to-worst as EXCELLENT..BAD, so a plain max() picks the
 * worse one), falling back to whichever side is actually available if the
 * other wasn't measured.
 */
private fun CallQuality.overallLevelString(): String {
    val dl = downlinkCallQualityLevel
    val ul = uplinkCallQualityLevel
    val chosen = when {
        dl == CallQuality.CALL_QUALITY_NOT_AVAILABLE -> ul
        ul == CallQuality.CALL_QUALITY_NOT_AVAILABLE -> dl
        else -> maxOf(dl, ul)
    }
    return when (chosen) {
        CallQuality.CALL_QUALITY_EXCELLENT -> "EXCELLENT"
        CallQuality.CALL_QUALITY_GOOD -> "GOOD"
        CallQuality.CALL_QUALITY_FAIR -> "FAIR"
        CallQuality.CALL_QUALITY_POOR -> "POOR"
        CallQuality.CALL_QUALITY_BAD -> "BAD"
        else -> "NOT_AVAILABLE"
    }
}

/** Maps CallQuality's codec constant to the exact strings the backend's §2a codec-coverage table recognizes; anything else is honestly reported as null rather than guessed. */
private fun Int.toCodecStringOrNull(): String? = when (this) {
    CallQuality.CODEC_AMR_WB -> "AMR-WB"
    CallQuality.CODEC_AMR -> "AMR-NB"
    CallQuality.CODEC_EVS -> "EVS"
    CallQuality.CODEC_G711U, CallQuality.CODEC_G711A, CallQuality.CODEC_G711AB -> "G.711"
    CallQuality.CODEC_G729 -> "G.729"
    else -> null
}

/** The call's own network type (LTE = VoLTE, NR = VoNR) -- narrower allowed set than RF samples' network_type (field reference §2). */
private fun Int.toCallNetworkTypeString(): String = when (this) {
    TelephonyManager.NETWORK_TYPE_LTE -> "LTE"
    TelephonyManager.NETWORK_TYPE_NR -> "NR"
    else -> "UNKNOWN"
}
