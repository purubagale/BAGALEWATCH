package np.nepaltelecom.telemetry.collector

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.PhoneStateListener
import android.telephony.SignalStrength
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat

/**
 * Captures a sample opportunistically when the serving cell or signal
 * strength changes, rather than waiting for the next periodic tick -- this
 * is the "event-triggered on handover" mitigation from the scoping brief's
 * risk table, and it only runs while the host app process is alive (it is
 * not, and cannot be, a way to sample while the app is fully killed --
 * that's what the periodic WorkManager job is for).
 *
 * Android replaced the old [PhoneStateListener] callback style with
 * [TelephonyCallback] in API 31 and deprecated the former; this class picks
 * whichever the running device supports so the SDK works correctly all the
 * way down to minSdk 26 without carrying dead code on newer devices.
 */
internal class HandoverListener(
    private val context: Context,
    private val onCellOrSignalChanged: () -> Unit,
) {
    private val telephonyManager =
        context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager

    private var legacyListener: PhoneStateListener? = null
    // A nullable field typed as an API-31+ class, only ever instantiated
    // inside the SDK_INT-gated branch in start() below. Field *type*
    // references don't force ART to eagerly resolve the class the way
    // instantiating or invoking it would, so this is safe on API 26-30
    // devices as long as the field is never assigned there -- the same
    // reasoning behind isolating CellInfoNr in its own gated function in
    // CellSampleCollector.kt.
    private var modernCallback: TelephonyCallback? = null

    private fun hasPermission() =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) ==
            PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission") // guarded by hasPermission()
    fun start() {
        if (!hasPermission()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val callback = object : TelephonyCallback(),
                TelephonyCallback.SignalStrengthsListener,
                TelephonyCallback.CellInfoListener {
                override fun onSignalStrengthsChanged(signalStrength: SignalStrength) = onCellOrSignalChanged()
                override fun onCellInfoChanged(cellInfo: MutableList<android.telephony.CellInfo>) = onCellOrSignalChanged()
            }
            telephonyManager.registerTelephonyCallback(context.mainExecutor, callback)
            modernCallback = callback
        } else {
            @Suppress("DEPRECATION")
            // Parameters are nullable on purpose: the legacy callbacks carry
            // no nullability contract, and some OEM modems (seen on Huawei
            // EMUI 8.0 / API 26) deliver onCellInfoChanged(null). A non-null
            // Kotlin parameter makes the compiler-inserted null check throw
            // on the main thread and kill the host app.
            val listener = object : PhoneStateListener() {
                @Deprecated("Deprecated in Java")
                override fun onSignalStrengthsChanged(signalStrength: SignalStrength?) = onCellOrSignalChanged()
                @Deprecated("Deprecated in Java")
                override fun onCellInfoChanged(cellInfo: MutableList<android.telephony.CellInfo>?) = onCellOrSignalChanged()
            }
            @Suppress("DEPRECATION")
            telephonyManager.listen(
                listener,
                PhoneStateListener.LISTEN_SIGNAL_STRENGTHS or PhoneStateListener.LISTEN_CELL_INFO,
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
    }
}
