package np.nepaltelecom.telemetry

import java.net.HttpURLConnection
import java.net.URL

/**
 * Signs the SDK's uploads with the phone's own key (2026-10-14), set by the
 * host app through [NetTelemetry.setRequestSigner]. The SDK holds no device
 * key itself: registration and the key live in the host app.
 *
 * When [headers] returns null (phone not registered, or not yet linked to
 * this SDK's device id) the upload falls back to the shared ingest key, so a
 * phone that never registers keeps working until that key is retired on the
 * server.
 */
interface RequestSigner {
    /** Headers that sign this exact request, or null to send it with the shared key. */
    fun headers(method: String, url: URL, body: ByteArray): Map<String, String>?

    /** Called when the server refused a signed request (401): the host app may stop signing until it links again. */
    fun onRejected() {}
}

/**
 * Applies the signer's headers to [connection], or the shared key when there
 * are none. Returns whether the request was signed.
 */
internal fun authorize(connection: HttpURLConnection, url: URL, method: String, body: ByteArray, apiKey: String?): Boolean {
    val signed = runCatching { requestSigner?.headers(method, url, body) }.getOrNull()
    if (signed != null) {
        signed.forEach { (name, value) -> connection.setRequestProperty(name, value) }
        return true
    }
    apiKey?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
    return false
}

/** Tells the signer a signed request was refused, so the next one falls back to the shared key. */
internal fun noteResponse(signed: Boolean, code: Int) {
    if (signed && code == 401) runCatching { requestSigner?.onRejected() }
}

@Volatile
internal var requestSigner: RequestSigner? = null
