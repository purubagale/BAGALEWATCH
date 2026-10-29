package np.nepaltelecom.telemetry.device

import android.os.Build
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom

/**
 * Calls to the dtwatch device endpoints (2026-10-05; in the SDK since
 * 2026-10-16): registration, number check, identity, the trace request inbox,
 * trace samples and speed test, site photos and problem reports. Blocking.
 * Call it from a background thread.
 *
 * The address comes from [np.nepaltelecom.telemetry.TelemetryConfig]: its
 * `deviceApiUrl`, or else the part of `endpointUrl` up to and including
 * `/api/telemetry/v1/`. [np.nepaltelecom.telemetry.NetTelemetry.init] sets it.
 */
object DeviceApi {
    private const val API_ROOT = "/api/telemetry/v1/"

    @Volatile
    private var base: String? = null

    /** Sets the base address of the device endpoints, ending in "/". */
    fun configure(deviceApiUrl: String?, endpointUrl: String) {
        base = deviceApiUrl?.let { if (it.endsWith("/")) it else "$it/" } ?: run {
            val i = endpointUrl.indexOf(API_ROOT)
            if (i >= 0) endpointUrl.substring(0, i + API_ROOT.length)
            else endpointUrl.trimEnd('/').substringBeforeLast('/') + "/"
        }
    }

    /** The base address, e.g. https://dtwatch.ntc.net.np/api/telemetry/v1/. */
    fun baseUrl(): String = base ?: throw IllegalStateException("NetTelemetry.init() must be called first")

    data class TraceRequestItem(
        val id: String,
        val status: String,
        val operatorAttested: Boolean,
        val expiresAt: String?,
    )

    /** A non-2xx answer. For a 4xx, [message] is the server's short reason, written to be shown. */
    class ApiException(message: String, val code: Int) : IOException(message)

    /** A one-time challenge the server checks at registration. */
    fun challenge(): String =
        JSONObject(request("GET", "device/challenge/", null, signed = false)).getString("challenge")

    /**
     * Registers this phone's key with its number. No integrity token in this
     * build, so the server must have PLAY_INTEGRITY_REQUIRED=false.
     *
     * The make, model and [hardwareId] (2026-10-09) let the server show which
     * phone a number is on and recognise this phone after a reinstall. The
     * answer says whether the number still needs proving by SMS code.
     */
    fun register(msisdn: String, challenge: String, appVersion: String, hardwareId: String): JSONObject {
        val body = JSONObject()
            .put("public_key", DeviceKeys.publicKeyPem())
            .put("challenge", challenge)
            .put("play_integrity_token", "")
            .put("msisdn", msisdn)
            .put("app_version", appVersion)
            .put("manufacturer", Build.MANUFACTURER.orEmpty())
            .put("phone_model", Build.MODEL.orEmpty())
            .put("hardware_id", hardwareId)
        return JSONObject(request("POST", "device/register/", body.toString(), signed = false))
    }

    /** Whether this phone's number is verified and whether it can be (2026-10-15). */
    fun numberStatus(): JSONObject = JSONObject(request("GET", "device/verify-number/", null, signed = true))

    /** Asks the server to send a code by SMS to the registered number. */
    fun sendNumberCode(): JSONObject = JSONObject(request("POST", "device/verify-number/start/", "{}", signed = true))

    /** Sends back the code from the SMS. Throws [ApiException] with the server's reason when wrong. */
    fun confirmNumberCode(code: String): JSONObject =
        JSONObject(request("POST", "device/verify-number/confirm/", JSONObject().put("code", code).toString(), signed = true))

    /** Sends this phone's model and declared user type. Needs a registered device. */
    fun uploadIdentity(phoneModel: String, manufacturer: String, userType: String, hardwareId: String = "") {
        val body = JSONObject()
            .put("phone_model", phoneModel)
            .put("manufacturer", manufacturer)
            .put("user_type", userType)
        // Lets a phone registered before 2026-10-09 be recognised without registering again.
        if (hardwareId.isNotEmpty()) body.put("hardware_id", hardwareId)
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

    /**
     * Ties this registered phone to the SDK's device id (2026-10-14), so the
     * server files the SDK's signed uploads under the identity its earlier
     * shared-key uploads had.
     */
    fun linkSdk(sdkDeviceId: String) {
        request("POST", "device/sdk-link/", JSONObject().put("sdk_device_id", sdkDeviceId).toString(), signed = true)
    }

    /**
     * The headers that sign one request (2026-10-14): the same format the
     * device endpoints use, over the exact [path] and [body] bytes the server
     * will see. Also used to sign the SDK's uploads (see [NetDevice]).
     */
    fun signedHeaders(method: String, path: String, body: ByteArray): Map<String, String> {
        val ts = (System.currentTimeMillis() / 1000).toString()
        val nonce = newNonce()
        val canonical = "${method.uppercase()}|$path|$ts|$nonce|${DeviceKeys.sha256Hex(body)}"
        return mapOf(
            "X-Device-Id" to DeviceKeys.deviceId(),
            "X-Timestamp" to ts,
            "X-Nonce" to nonce,
            "X-Signature" to DeviceKeys.sign(canonical.toByteArray(Charsets.UTF_8)),
        )
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

    /** One planned antenna direction of a site, with the sectors that point that way. */
    data class SiteDirection(val azimuth: Double, val sectors: String)

    data class NearbySite(val id: String, val name: String, val distanceM: Int, val directions: List<SiteDirection>)

    /** The sites close to this position, nearest first. Empty when none is near. Needs a registered device. */
    fun nearbySites(lat: Double, lon: Double): List<NearbySite> {
        val text = request("GET", "device/nearby-sites/?lat=$lat&lon=$lon", null, signed = true)
        val sites = JSONObject(text).optJSONArray("sites") ?: JSONArray()
        return (0 until sites.length()).map { i ->
            val site = sites.getJSONObject(i)
            val dirs = site.optJSONArray("directions") ?: JSONArray()
            NearbySite(
                id = site.getString("id"),
                name = site.optString("name"),
                distanceM = site.optInt("distance_m"),
                directions = (0 until dirs.length()).map { d ->
                    val dir = dirs.getJSONObject(d)
                    SiteDirection(dir.getDouble("azimuth"), dir.optString("sectors"))
                },
            )
        }
    }

    /** The site and sector serving the phone, as the site list names them. */
    data class ServingSite(val siteId: String, val siteName: String, val sector: String?, val cellName: String?)

    /**
     * The site serving this reading (2026-10-19), or null when the server
     * cannot place it. Needs a registered device. Throws when the server
     * cannot be reached.
     */
    fun servingSite(s: np.nepaltelecom.telemetry.model.Sample): ServingSite? {
        val params = buildList {
            add("network=${s.networkType}")
            s.cellId?.let { add("cell_id=$it") }
            s.pci?.let { add("pci=$it") }
            s.tac?.let { add("tac=$it") }
            s.scramblingCode?.let { add("psc=$it") }
            s.bcch?.let { add("bcch=$it") }
            s.bsic?.let { add("bsic=$it") }
            if (s.lat != null && s.lon != null) {
                add("lat=${s.lat}")
                add("lon=${s.lon}")
            }
        }.joinToString("&")
        val site = JSONObject(request("GET", "device/serving-site/?$params", null, signed = true)).optJSONObject("site")
            ?: return null
        return ServingSite(
            siteId = site.getString("site_id"),
            siteName = site.optString("site_name").ifBlank { site.getString("site_id") },
            sector = site.optString("sector").takeIf { it.isNotBlank() && it != "null" },
            cellName = site.optString("cell_name").takeIf { it.isNotBlank() && it != "null" },
        )
    }

    /** Sends one site photo. [body] is the JSON the server's site-photo endpoint expects. */
    fun uploadSitePhoto(body: String) {
        request("POST", "device/site-photos/", body, signed = true)
    }

    /**
     * Rescue beacon on or off for this registered phone (2026-10-23). Signed;
     * the server takes the number from the registration, never from here.
     */
    fun rescueConsent(consent: Boolean, appVersion: String) {
        val body = JSONObject().put("consent", consent).put("app_version", appVersion).toString()
        request("POST", "device/rescue-consent/", body, signed = true)
    }

    /** "Report a problem" (2026-10-14): one report with the phone's reading and speed test. */
    /** Sends one problem report; returns the server's answer (JSON). */
    fun reportProblem(body: String): String =
        request("POST", "device/problem-reports/", body, signed = true)

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
        val url = URL(baseUrl() + path)
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
                signedHeaders(method, url.path, payload).forEach { (name, value) -> conn.setRequestProperty(name, value) }
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

/**
 * A short message safe to show a user for any failure (2026-10-08). Never the
 * raw exception text, which can hold host names, addresses and ports. A 4xx
 * [DeviceApi.ApiException] carries the server's own short reason, written to
 * be shown; a 5xx gets the general message.
 */
fun friendlyErrorMessage(e: Throwable): String {
    val apiException = e as? DeviceApi.ApiException
    if (apiException != null && apiException.code in 400..499) {
        return apiException.message?.takeIf { it.isNotBlank() } ?: GENERIC_MESSAGE
    }
    return when (e) {
        is IOException -> "Could not reach the server. Check your connection and try again."
        else -> GENERIC_MESSAGE
    }
}

private const val GENERIC_MESSAGE = "Something went wrong. Please try again."
