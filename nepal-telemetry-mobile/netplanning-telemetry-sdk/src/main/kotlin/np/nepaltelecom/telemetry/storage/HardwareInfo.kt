package np.nepaltelecom.telemetry.storage

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.provider.Settings
import java.security.MessageDigest

/**
 * What the server needs to tell one phone from another when a number is
 * linked to a device (rescue enrolment, phone registration): the make and
 * model to show an operator, and an id that stays the same across a
 * reinstall.
 *
 * [DeviceIdentity]'s id is created per installation, so reinstalling the app
 * makes the same phone look like a new device, and the registration key
 * gives the phone yet another id. [hardwareId] is what ties those together.
 * It is a SHA-256 of the Android ID, so the Android ID itself never leaves
 * the phone; the server salts and hashes it again before storing it. It is
 * sent only with an enrolment or registration the user has asked for, never
 * with ordinary signal samples.
 */
object HardwareInfo {
    fun manufacturer(): String = Build.MANUFACTURER.orEmpty()

    fun model(): String = Build.MODEL.orEmpty()

    fun appVersion(context: Context): String = try {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName.orEmpty()
    } catch (e: Exception) {
        ""
    }

    /** Empty when the Android ID is unavailable; the server treats that as "not sent". */
    @SuppressLint("HardwareIds")
    fun hardwareId(context: Context): String {
        val androidId = try {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
        } catch (e: Exception) {
            null
        }
        if (androidId.isNullOrBlank()) return ""
        val digest = MessageDigest.getInstance("SHA-256").digest("dtwatch-hw:$androidId".toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }
}
