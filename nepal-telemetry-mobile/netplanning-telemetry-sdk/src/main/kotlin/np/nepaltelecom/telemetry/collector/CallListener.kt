package np.nepaltelecom.telemetry.collector

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.telephony.PhoneStateListener
import android.telephony.SubscriptionManager
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import np.nepaltelecom.telemetry.model.CallPoint
import np.nepaltelecom.telemetry.model.CallRecord
import np.nepaltelecom.telemetry.storage.DeviceIdentity

/**
 * Records each phone call as an ordinary app can see it (2026-10-14): which
 * voice network it used, the data network just before, and the serving cell
 * and level at its start and end. Needs READ_PHONE_STATE and location, which
 * the SDK already asks for; no carrier privilege, no quality figures, no
 * number, no call direction.
 *
 * A call is the time the phone is off-hook: from dialling or answering to
 * hang-up (ringing alone, a missed call, is not a call). The voice network
 * is read every [POLL_MS] while off-hook, so a call that starts on 4G and
 * drops to 3G (SRVCC) shows both, and a CSFB call shows 3G/2G voice with 4G
 * data before it.
 *
 * Runs only while the app process is alive, like the cell-change listener:
 * calls made while the app is fully stopped are not seen. The Collector
 * edition keeps the process alive while sharing.
 */
internal class CallListener(
    private val context: Context,
    private val onCall: (CallRecord) -> Unit,
) {
    private val telephony: TelephonyManager = voiceTelephony(context)
    private val identity = DeviceIdentity(context)
    private val scope = CoroutineScope(Dispatchers.Default)
    private val main = Handler(Looper.getMainLooper())

    private var legacyListener: PhoneStateListener? = null
    private var modernCallback: TelephonyCallback? = null

    // Current call, touched on the main thread only.
    private var startedAtMs = 0L
    private var voiceNetworks = mutableListOf<String>()
    private var dataBefore: String? = null
    private var startPoint: Deferred<CallPoint?>? = null
    private var offHook = false
    // Data network while no call was up, to name what the phone was on before one.
    private var lastIdleData: String? = null
    private var lastIdleDataAtMs = 0L

    private val poll = object : Runnable {
        override fun run() {
            if (!offHook) return
            noteVoiceNetwork()
            main.postDelayed(this, POLL_MS)
        }
    }

    private fun hasPermission() =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) ==
            PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission") // guarded by hasPermission()
    fun start() {
        if (!hasPermission()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val callback = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                override fun onCallStateChanged(state: Int) = onState(state)
            }
            telephony.registerTelephonyCallback(context.mainExecutor, callback)
            modernCallback = callback
        } else {
            @Suppress("DEPRECATION")
            val listener = object : PhoneStateListener() {
                @Deprecated("Deprecated in Java")
                override fun onCallStateChanged(state: Int, phoneNumber: String?) = onState(state)
            }
            @Suppress("DEPRECATION")
            telephony.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
            legacyListener = listener
        }
    }

    fun stop() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            modernCallback?.let { telephony.unregisterTelephonyCallback(it) }
        }
        modernCallback = null
        legacyListener?.let {
            @Suppress("DEPRECATION")
            telephony.listen(it, PhoneStateListener.LISTEN_NONE)
        }
        legacyListener = null
        main.removeCallbacks(poll)
        offHook = false
    }

    private fun onState(state: Int) {
        when (state) {
            TelephonyManager.CALL_STATE_OFFHOOK -> if (!offHook) callStarted()
            TelephonyManager.CALL_STATE_IDLE -> {
                if (offHook) callEnded()
                rememberIdleData()
            }
            TelephonyManager.CALL_STATE_RINGING -> rememberIdleData()
        }
    }

    private fun callStarted() {
        offHook = true
        startedAtMs = System.currentTimeMillis()
        voiceNetworks = mutableListOf()
        val fresh = System.currentTimeMillis() - lastIdleDataAtMs < IDLE_DATA_FRESH_MS
        dataBefore = (if (fresh) lastIdleData else null) ?: dataNetworkName()
        noteVoiceNetwork()
        startPoint = if (identity.optedIn) scope.async { snapshot() } else null
        main.postDelayed(poll, POLL_MS)
    }

    private fun callEnded() {
        offHook = false
        main.removeCallbacks(poll)
        noteVoiceNetwork()
        val started = startedAtMs
        val ended = System.currentTimeMillis()
        val networks = voiceNetworks.toList()
        val before = dataBefore
        val startJob = startPoint
        startPoint = null
        // Recorded only while sharing, at both ends of the call.
        if (startJob == null || !identity.optedIn) return
        scope.launch {
            val record = CallRecord(
                deviceId = identity.deviceId,
                startedAtMs = started,
                endedAtMs = ended,
                voiceNetworks = networks,
                dataNetworkBefore = before,
                start = startJob.await(),
                end = snapshot(),
            )
            onCall(record)
        }
    }

    private suspend fun snapshot(): CallPoint? {
        val full = CellSampleCollector(context, identity).collect(triggerReason = "call")?.let { CallPoint.from(it) }
        if (full != null && (full.cellId != null || full.levelDbm != null)) return full
        // During a call the dialer is in front, and Android gives an app in the
        // background no cell list or position without background location
        // (2026-10-26: on prod only the Collector edition, which runs a
        // foreground service, had cell and level on its calls). The voice
        // network and the overall signal reading need neither, so they still
        // fill the call; the cell stays blank.
        val net = voiceNetworkName()?.takeIf { it != "UNKNOWN" }
        val level = signalLevel(net ?: full?.networkType)
        if (net == null && level == null) return full
        val base = full ?: CallPoint(null, null, net ?: "UNKNOWN", null, null, null, null, null, null)
        return base.copy(
            networkType = base.networkType.takeIf { it.isNotEmpty() && it != "UNKNOWN" } ?: (net ?: "UNKNOWN"),
            levelDbm = base.levelDbm ?: level,
        )
    }

    /** Level of the serving cell from getSignalStrength(), which needs no location permission. */
    private fun signalLevel(network: String?): Int? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val strengths = runCatching { telephony.signalStrength?.cellSignalStrengths }.getOrNull() ?: return null
        val found = strengths.mapNotNull { s ->
            when (s) {
                is android.telephony.CellSignalStrengthLte -> "4G" to s.rsrp
                is android.telephony.CellSignalStrengthNr -> "5G" to s.ssRsrp
                is android.telephony.CellSignalStrengthWcdma -> "3G" to s.dbm
                is android.telephony.CellSignalStrengthGsm -> "2G" to s.dbm
                else -> null
            }?.takeIf { it.second in -150..-20 }
        }
        val family = when (network) {
            "LTE" -> "4G"
            "NR" -> "5G"
            "UMTS", "HSDPA", "HSUPA", "HSPA", "HSPAP", "TD_SCDMA" -> "3G"
            "GSM", "EDGE", "GPRS" -> "2G"
            else -> null
        }
        return (found.firstOrNull { it.first == family } ?: found.firstOrNull())?.second
    }

    private fun noteVoiceNetwork() {
        val name = voiceNetworkName() ?: return
        if (name != "UNKNOWN" && voiceNetworks.lastOrNull() != name && voiceNetworks.size < MAX_NETWORKS) {
            voiceNetworks.add(name)
        }
    }

    private fun rememberIdleData() {
        dataNetworkName()?.let {
            lastIdleData = it
            lastIdleDataAtMs = System.currentTimeMillis()
        }
    }

    @SuppressLint("MissingPermission")
    private fun voiceNetworkName(): String? =
        if (hasPermission()) runCatching { networkName(telephony.voiceNetworkType) }.getOrNull() else null

    @SuppressLint("MissingPermission")
    private fun dataNetworkName(): String? =
        if (hasPermission()) runCatching { networkName(telephony.dataNetworkType) }.getOrNull() else null

    private companion object {
        const val POLL_MS = 3_000L
        const val IDLE_DATA_FRESH_MS = 10 * 60_000L
        const val MAX_NETWORKS = 20
    }
}

/** The telephony manager of the SIM that places calls, falling back to the default one. */
private fun voiceTelephony(context: Context): TelephonyManager {
    val base = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
    val subId = SubscriptionManager.getDefaultVoiceSubscriptionId()
    return if (subId != SubscriptionManager.INVALID_SUBSCRIPTION_ID) base.createForSubscriptionId(subId) else base
}

/** Android network type to the names the server expects. */
internal fun networkName(type: Int): String = when (type) {
    TelephonyManager.NETWORK_TYPE_LTE -> "LTE"
    TelephonyManager.NETWORK_TYPE_NR -> "NR"
    TelephonyManager.NETWORK_TYPE_IWLAN -> "IWLAN"
    TelephonyManager.NETWORK_TYPE_UMTS -> "UMTS"
    TelephonyManager.NETWORK_TYPE_HSDPA -> "HSDPA"
    TelephonyManager.NETWORK_TYPE_HSUPA -> "HSUPA"
    TelephonyManager.NETWORK_TYPE_HSPA -> "HSPA"
    TelephonyManager.NETWORK_TYPE_HSPAP -> "HSPAP"
    TelephonyManager.NETWORK_TYPE_TD_SCDMA -> "TD_SCDMA"
    TelephonyManager.NETWORK_TYPE_GSM -> "GSM"
    TelephonyManager.NETWORK_TYPE_EDGE -> "EDGE"
    TelephonyManager.NETWORK_TYPE_GPRS -> "GPRS"
    TelephonyManager.NETWORK_TYPE_CDMA -> "CDMA"
    TelephonyManager.NETWORK_TYPE_1xRTT -> "1XRTT"
    TelephonyManager.NETWORK_TYPE_EVDO_0, TelephonyManager.NETWORK_TYPE_EVDO_A,
    TelephonyManager.NETWORK_TYPE_EVDO_B -> "EVDO"
    else -> "UNKNOWN"
}
