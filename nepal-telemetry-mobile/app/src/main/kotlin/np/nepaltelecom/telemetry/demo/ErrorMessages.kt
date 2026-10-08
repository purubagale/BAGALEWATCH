package np.nepaltelecom.telemetry.demo

import java.io.IOException

/**
 * Turns any exception into a short, user-safe message -- never the raw
 * exception text, which can contain server hostnames, IP addresses, port
 * numbers, and other internal/debugging detail that means nothing to a
 * subscriber and should never leave the device (2026-10-08 report: a
 * connection failure showed "failed to connect to dtwatch.ntc.net.np/
 * 172.16.41.201 (port 443) from /10.109.155.239 (port 41372) after
 * 10000ms" directly on screen -- Java/OkHttp's own ConnectException
 * message, verbatim).
 *
 * The one exception: [TraceApi.ApiException]'s own message, for a 4xx
 * response, is the SERVER's own short validation detail (e.g. "msisdn is
 * required") -- authored by this app's own backend specifically to be
 * shown to a user, the same way a form field's own validation error
 * would be. A 5xx still gets the generic message below: a server-side
 * failure detail is an internal-debugging string on that end too, not
 * something written for a subscriber to read either.
 */
fun friendlyErrorMessage(e: Throwable): String {
    val apiException = e as? TraceApi.ApiException
    if (apiException != null && apiException.code in 400..499) {
        return apiException.message?.takeIf { it.isNotBlank() } ?: GENERIC_MESSAGE
    }
    return when (e) {
        is IOException -> "Could not reach the server. Check your connection and try again."
        else -> GENERIC_MESSAGE
    }
}

private const val GENERIC_MESSAGE = "Something went wrong. Please try again."
