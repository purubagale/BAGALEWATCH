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
        get() = prefs.getString(KEY_DEVICE_ID, null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString(KEY_DEVICE_ID, it).apply()
        }

    var optedIn: Boolean
        get() = prefs.getBoolean(KEY_OPTED_IN, false) // off by default -- never assume consent
        set(value) = prefs.edit().putBoolean(KEY_OPTED_IN, value).apply()

    /**
     * Whether this device has ANY stored opt-in choice yet -- distinct
     * from [optedIn] itself, which can't tell "explicitly opted out"
     * apart from "never asked" (both read back as false). Lets
     * `NetTelemetry.init()` seed a first-run default (see
     * [TelemetryConfig.defaultOptIn]) exactly once, without ever
     * overwriting a choice the subscriber -- or a prior [init] call on
     * this same device -- already made.
     */
    val hasExplicitOptInState: Boolean
        get() = prefs.contains(KEY_OPTED_IN)
}
