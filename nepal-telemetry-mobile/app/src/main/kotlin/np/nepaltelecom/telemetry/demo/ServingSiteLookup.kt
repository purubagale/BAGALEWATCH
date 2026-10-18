package np.nepaltelecom.telemetry.demo

import android.content.Context
import np.nepaltelecom.telemetry.device.DeviceApi
import np.nepaltelecom.telemetry.device.NetDevice
import np.nepaltelecom.telemetry.model.NtcCellName
import np.nepaltelecom.telemetry.model.Sample

/**
 * The site and sector serving the phone, asked from NTC's server
 * (2026-10-19). Asked once per serving cell; a cell the server cannot place
 * is asked again after [UNKNOWN_RETRY_MS], and after a failure (server not
 * reachable) nothing is asked for [FAILURE_WAIT_MS]. Needs a registered
 * phone, since the call is signed. When there is no answer the screens show
 * what they showed before.
 */
object ServingSiteLookup {
    private const val FAILURE_WAIT_MS = 30_000L
    private const val UNKNOWN_RETRY_MS = 10 * 60_000L

    private data class Entry(val site: DeviceApi.ServingSite?, val atMs: Long)

    private val cache = HashMap<String, Entry>()
    private var failedAtMs = 0L
    private var inFlight: String? = null

    private fun key(s: Sample): String? {
        if (s.cellId == null && s.pci == null && s.scramblingCode == null && s.bcch == null) return null
        return listOf(s.networkType, s.cellId, s.tac, s.pci, s.scramblingCode, s.bcch, s.bsic).joinToString("|")
    }

    /** The answer already held for this reading's cell, or null. */
    @Synchronized
    fun cached(s: Sample): DeviceApi.ServingSite? = key(s)?.let { cache[it]?.site }

    /**
     * What the screens show for this reading: the server's answer with the
     * site's name, else the site and sector read from the cell number
     * (NtcCellName), else null.
     */
    fun display(s: Sample): String? =
        cached(s)?.let { label(it) } ?: NtcCellName.of(s)?.let { "${it.siteId} · ${it.sector}" }

    /** "KTM856_BOHORATAR1 · J3"; the site list's names already start with the site ID. */
    fun label(site: DeviceApi.ServingSite): String {
        val name = if (site.siteName.startsWith(site.siteId)) site.siteName else "${site.siteId} ${site.siteName}"
        val sector = site.sector ?: site.cellName
        return listOfNotNull(name, sector).joinToString(" · ")
    }

    /**
     * Looks up this reading's cell in the background when it is not known
     * yet; [onFound] runs on that background thread with a new answer.
     */
    fun request(context: Context, s: Sample, onFound: (DeviceApi.ServingSite?) -> Unit) {
        val k = key(s) ?: return
        val now = System.currentTimeMillis()
        synchronized(this) {
            if (!NetDevice.isRegistered(context)) return
            if (now - failedAtMs < FAILURE_WAIT_MS || inFlight == k) return
            val held = cache[k]
            if (held != null && (held.site != null || now - held.atMs < UNKNOWN_RETRY_MS)) return
            inFlight = k
        }
        Thread {
            val result = runCatching { DeviceApi.servingSite(s) }
            synchronized(this) {
                inFlight = null
                if (result.isSuccess) cache[k] = Entry(result.getOrNull(), System.currentTimeMillis())
                else failedAtMs = System.currentTimeMillis()
            }
            if (result.isSuccess) onFound(result.getOrNull())
        }.start()
    }
}
