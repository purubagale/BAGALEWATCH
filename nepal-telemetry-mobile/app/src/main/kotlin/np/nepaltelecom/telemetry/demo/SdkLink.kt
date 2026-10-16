package np.nepaltelecom.telemetry.demo

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import np.nepaltelecom.telemetry.device.NetDevice

/**
 * The app's part of registration at process start (2026-10-16). Signing the
 * SDK's uploads and the SDK link are in the SDK now (`NetDevice`,
 * `DeviceSignerProvider`). What stays here is app-specific: after each
 * registration, here or in the SDK's background retry, upload the Firebase
 * push token. A provider runs on every process start, including one
 * WorkManager starts in the background, so the hook is always in place.
 */
class SdkSignerProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        NetDevice.setOnRegistered { app -> FcmToken.fetchAndUpload(app) }
        return true
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
