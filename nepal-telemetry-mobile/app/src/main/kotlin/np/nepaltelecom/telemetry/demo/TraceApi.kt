package np.nepaltelecom.telemetry.demo

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom

/**
 * Calls to the dtwatch device endpoints (2026-10-05): registration, identity,
 * the trace request inbox, trace samples, and the trace speed test. Blocking.
 * Call it from a background thread.
 */
object TraceApi {
    private const val HOST = "https://dtwatch.ntc.net.np"
    private const val BASE = "/api/telemetry/v1/"

    data class TraceRequestItem(
        val id: String,
        val status: String,
        val operatorAttested: Boolean,
        val expiresAt: String?,
    )

    class ApiException(message: String, val code: Int) : IOException(message)

    /** A one-time challenge the server checks at registration. */
    fun challenge(): String =
        JSONObject(request("GET", "device/challenge/", null, signed = false)).getString("challenge")

    /**
     * Registers this phone's key with its number. No integrity token in this
     * build, so the server must have PLAY_INTEGRITY_REQUIRED=false.
     */
    fun register(msisdn: String, challenge: String, appVersion: String) {
        val body = JSONObject()
            .put("public_key", DeviceKeys.publicKeyPem())
            .put("challenge", challenge)
            .put("play_integrity_token", "")
            .put("msisdn", msisdn)
            .put("app_version", appVersion)
        request("POST", "device/register/", body.toString(), signed = false)
    }

    /** Sends this phone's model and declared user type. Needs a registered device. */
    fun uploadIdentity(phoneModel: String, manufacturer: String, userType: String) {
        val body = JSONObject()
            .put("phone_model", phoneModel)
            .put("manufacturer", manufacturer)
            .put("user_type", userType)
        request("POST", "device-identity/", body.toString(), signed = true)
    }

    /** Open trace requests for this phone (pending or accepted). */
    fun openRequests(): List<TraceRequestItem> {
        val array = JSONArray(request("GET", "device/trace-requests/", null, signed = true))
        return (0 until array.length()).map { i ->
            val o = array.getJSONObject(i)
            TraceRequestItem(
                id = o.getString("id"),
                status = o.getString("status"),
                operatorAttested = o.optBoolean("operator_attested", false),
                expiresAt = o.optString("expires_at", "").takeIf { it.isNotEmpty() },
            )
        }
    }

    /** Posts one batch of fixes to an accepted trace. The server keeps only those inside the window. */
    fun postSamples(id: String, items: JSONArray) {
        request("POST", "device/trace-requests/$id/samples/", items.toString(), signed = true)
    }

    /** Stores this phone's push token on the server. Needs a registered device. */
    fun putFcmToken(token: String) {
        request("PUT", "device/fcm-token/", JSONObject().put("fcm_token", token).toString(), signed = true)
    }

    /** Accept or reject a pending request. The server refuses any other move. */
    fun respond(id: String, action: String) {
        request("POST", "device/trace-requests/$id/respond/", JSONObject().put("action", action).toString(), signed = true)
    }

    /** One ping round trip to the trace's speed test. Throws if the trace is no longer accepted. */
    fun speedPing(id: String) {
        call("GET", "device/trace-requests/$id/speedtest/ping/", null, "application/json", signed = true) { }
    }

    /** Downloads [bytes] from the trace's speed test. Returns how many bytes were read. */
    fun speedDownloadBytes(id: String, bytes: Int): Long =
        call("GET", "device/trace-requests/$id/speedtest/download/?bytes=$bytes", null, "application/json", signed = true) { input ->
            val buffer = ByteArray(CHUNK)
            var total = 0L
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                total += n
            }
            total
        }

    /** Uploads [payload] to the trace's speed test. */
    fun speedUpload(id: String, payload: ByteArray) {
        call("POST", "device/trace-requests/$id/speedtest/upload/", payload, "application/octet-stream", signed = true) { }
    }

    /** Stores one speed test run on the trace. */
    fun postSpeedResult(id: String, result: JSONObject) {
        request("POST", "device/trace-requests/$id/speedtest/result/", result.toString(), signed = true)
    }

    private fun request(method: String, path: String, body: String?, signed: Boolean): String =
        call(method, path, body?.toByteArray(Charsets.UTF_8), "application/json", signed) {
            it.bufferedReader().use { reader -> reader.readText() }
        }

    /**
     * Sends one call and reads the response with [read]. Signed calls carry the
     * device headers. The signature covers the exact path and body bytes the
     * server will see. A non-2xx reply throws [ApiException] with the server's detail.
     */
    private fun <T> call(
        method: String,
        path: String,
        body: ByteArray?,
        contentType: String,
        signed: Boolean,
        read: (InputStream) -> T,
    ): T {
        val url = URL(HOST + BASE + path)
        val payload = body ?: ByteArray(0)
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 30_000
            useCaches = false
            setRequestProperty("Accept", "application/json")
        }
        try {
            if (signed) {
                val ts = (System.currentTimeMillis() / 1000).toString()
                val nonce = newNonce()
                val canonical = "${method.uppercase()}|${url.path}|$ts|$nonce|${DeviceKeys.sha256Hex(payload)}"
                conn.setRequestProperty("X-Device-Id", DeviceKeys.deviceId())
                conn.setRequestProperty("X-Timestamp", ts)
                conn.setRequestProperty("X-Nonce", nonce)
                conn.setRequestProperty("X-Signature", DeviceKeys.sign(canonical.toByteArray(Charsets.UTF_8)))
            }
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", contentType)
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
            }
            val code = conn.responseCode
            if (code !in 200..299) {
                val text = conn.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                val detail = runCatching { JSONObject(text).optString("detail") }.getOrNull()
                throw ApiException(detail?.takeIf { it.isNotEmpty() } ?: "HTTP $code", code)
            }
            return conn.inputStream.use(read)
        } finally {
            conn.disconnect()
        }
    }

    private fun newNonce(): String {
        val bytes = ByteArray(18)
        SecureRandom().nextBytes(bytes)
        return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    private const val CHUNK = 64 * 1024
}
