package np.nepaltelecom.telemetry.storage

import android.content.Context
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.UUID

private const val TAG = "NetTelemetry.Identity"
private const val PREFS_FILE = "netplanning_telemetry_identity"
private const val KEY_DEVICE_ID = "pseudonymous_device_id"
private const val KEY_OPTED_IN = "opted_in"

/**
 * The pilot's one hard privacy rule, enforced in code rather than left to
 * policy: this ID is a locally generated UUID with no relationship to the
 * IMEI, Android ID, or the subscriber's MSISDN. Nobody holding just this ID
 * and the upload payload can resolve it back to a subscriber identity --
 * that correlation would have to happen (if ever) outside this SDK entirely,
 * by whoever operates the host app, under whatever legal process the pilot's
 * data-processing agreement specifies. This module deliberately has no API
 * that would let a caller substitute IMEI/Android ID/MSISDN in its place.
 *
 * Stored in EncryptedSharedPreferences (AES-256, key in the Android
 * Keystore) rather than plain SharedPreferences, since even a pseudonymous
 * per-device ID is worth protecting from casual access on a rooted or
 * compromised device.
 */
internal class DeviceIdentity(context: Context) {

    private val prefs = try {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            PREFS_FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (e: Exception) {
        // Keystore can fail on a handful of misbehaving OEM devices. Falling
        // back to plain prefs keeps the pilot from being dead in the water on
        // those devices, at the cost of weaker at-rest protection for the ID
        // alone -- never for the samples themselves, which don't live here.
        Log.w(TAG, "EncryptedSharedPreferences unavailable, falling back to plain prefs", e)
        context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
    }

    val deviceId: String
        // First-read generation is serialized on a process-wide lock and
        // committed synchronously. Without this, the periodic worker and the
        // handover listener firing within the same millisecond right after the
        // first optIn() -- before either apply() lands -- each mint their own
        // UUID, and a handful of the pilot's very first samples get attributed
        // to a ghost device. All DeviceIdentity instances in the process share
        // the same underlying prefs file (EncryptedSharedPreferences.create
        // returns a per-name singleton), so a static monitor is sufficient.
        get() = synchronized(ID_LOCK) {
            prefs.getString(KEY_DEVICE_ID, null) ?: UUID.randomUUID().toString().also {
                @Suppress("ApplySharedPref") // must be durable before this getter returns
                prefs.edit().putString(KEY_DEVICE_ID, it).commit()
            }
        }

    var optedIn: Boolean
        get() = prefs.getBoolean(KEY_OPTED_IN, false) // off by default -- never assume consent
        set(value) = prefs.edit().putBoolean(KEY_OPTED_IN, value).apply()

    private companion object {
        val ID_LOCK = Any()
    }
}
