package np.nepaltelecom.telemetry.collector

import android.telephony.CellInfo

/**
 * The last cell list Android pushed to the handover listener (2026-10-04).
 *
 * Some phones return nothing from a direct cell read even while the modem has
 * a registered cell (seen on an Android 15 OPPO with two SIMs). The listener
 * still receives those cells, so when a direct read comes back empty, the
 * collector uses this copy. Only used for a short time, so a stale list never
 * stands in for a live one for long.
 */
internal object CellInfoCache {

    @Volatile private var latest: List<CellInfo> = emptyList()
    @Volatile private var updatedAtMs: Long = 0L

    /** Stores a non-empty list from the listener. Null and empty lists are ignored. */
    fun update(cells: List<CellInfo>?) {
        if (cells.isNullOrEmpty()) return
        latest = cells.toList()
        updatedAtMs = System.currentTimeMillis()
    }

    /** The stored cells if they are at most [maxAgeMs] old, otherwise an empty list. */
    fun fresh(maxAgeMs: Long = 60_000L): List<CellInfo> =
        if (System.currentTimeMillis() - updatedAtMs <= maxAgeMs) latest else emptyList()
}
