package np.nepaltelecom.telemetry.demo

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.location.Location
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.model.CellReading
import np.nepaltelecom.telemetry.model.RadioBand
import np.nepaltelecom.telemetry.model.Sample

/**
 * Every cell the modem can see: the serving cell first, then neighbours by
 * strength. Each row shows the band, the identity the network uses for the
 * cell, and a signal bar. Refreshes every few seconds while on screen.
 */
class CellsFragment : Fragment(R.layout.fragment_cells) {

    private val handler = Handler(Looper.getMainLooper())
    private val poll = object : Runnable {
        override fun run() {
            readCells()
            handler.postDelayed(this, POLL_MS)
        }
    }
    private lateinit var cellList: LinearLayout

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        cellList = view.findViewById(R.id.cellList)
    }

    override fun onResume() {
        super.onResume()
        handler.post(poll)
    }

    override fun onPause() {
        handler.removeCallbacks(poll)
        super.onPause()
    }

    private fun readCells() {
        NetTelemetry.readCellsNow { cells ->
            activity?.runOnUiThread {
                if (isAdded && view != null) render(cells)
            }
        }
    }

    // Site and sector names from NTC's server (2026-10-27), as on the Signal
    // tab. The serving cell is matched by its cell number; a neighbour known
    // only by PCI or code is placed by the phone's last known position. A cell
    // the server has not answered for (not reachable, not registered, or not
    // known) shows as before, with no site line.
    private var lastCells: List<CellReading> = emptyList()

    @SuppressLint("MissingPermission") // checked just above the call
    private fun lastFix(): Location? {
        val ctx = context ?: return null
        val fine = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (fine != PackageManager.PERMISSION_GRANTED && coarse != PackageManager.PERMISSION_GRANTED) return null
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
        return runCatching {
            lm.getProviders(true).mapNotNull { lm.getLastKnownLocation(it) }.maxByOrNull { it.time }
        }.getOrNull()
    }

    /** The lookup's reading for one cell: its identity, and the position only for a cell with no cell number. */
    private fun lookupSample(c: CellReading, fix: Location?): Sample? {
        if (c.cellId == null && fix == null) return null
        return Sample(
            deviceId = "", timestampMs = 0L,
            lat = if (c.cellId == null) fix?.latitude else null,
            lon = if (c.cellId == null) fix?.longitude else null,
            gpsAccuracyM = null, cellId = c.cellId, pci = c.pci, tac = c.tac, mcc = c.mcc, mnc = c.mnc,
            networkType = c.networkType, rsrpDbm = null, rsrqDb = null, rssiDbm = null, sinrDb = null,
            rxQual = null, rscpDbm = null, ecioDb = null, scramblingCode = c.scramblingCode,
            bcch = c.bcch, bsic = c.bsic, batteryPct = null, triggerReason = "manual",
        )
    }

    private fun siteName(c: CellReading, fix: Location?): String? {
        val s = lookupSample(c, fix) ?: return null
        ServingSiteLookup.cached(s)?.let { return ServingSiteLookup.label(it) }
        ServingSiteLookup.request(requireContext().applicationContext, s) { found ->
            if (found == null) return@request
            activity?.runOnUiThread { if (isAdded && view != null) render(lastCells) }
        }
        return null
    }

    private fun render(cells: List<CellReading>) {
        lastCells = cells
        cellList.removeAllViews()
        if (cells.isEmpty()) {
            cellList.addView(text(getString(R.string.cells_empty), 14f, R.color.text_secondary))
            return
        }
        val sorted = cells.sortedWith(
            compareByDescending<CellReading> { it.isServing }
                .thenByDescending { primaryDbm(it) ?: Int.MIN_VALUE },
        )
        val fix = lastFix()
        for (cell in sorted) cellList.addView(cardFor(cell, fix))
    }

    private fun cardFor(c: CellReading, fix: Location?): View {
        val ctx = requireContext()
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = ContextCompat.getDrawable(ctx, R.drawable.bg_card)
            setPadding(dp(14), dp(12), dp(14), dp(12))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = dp(10) }
        }

        val band = RadioBand.label(c.networkType, c.band, if (c.networkType == "GSM") c.bcch else c.earfcn)
        val title = buildString {
            append(c.networkType)
            band?.let { append(" · $it") }
            if (c.isServing) append("  ·  SERVING")
        }
        card.addView(text(title, 16f, if (c.isServing) R.color.brand_accent else R.color.text_primary, bold = true))
        siteName(c, fix)?.let { card.addView(text(it, 14f, R.color.text_primary, bold = true)) }
        card.addView(text(detailLine(c), 13f, R.color.text_secondary))

        val dbm = primaryDbm(c)
        card.addView(signalRow(dbm))

        val quality = qualityLine(c)
        if (quality.isNotEmpty()) card.addView(text(quality, 13f, R.color.text_secondary))
        return card
    }

    /** The strongest signal value for a cell, in the unit its network reports. */
    private fun primaryDbm(c: CellReading): Int? = when (c.networkType) {
        "LTE" -> c.rsrpDbm ?: c.rssiDbm
        "UMTS" -> c.rscpDbm ?: c.rssiDbm
        else -> c.rssiDbm
    }

    /** The identity fields the network uses for this cell, in the form operators read them. */
    private fun detailLine(c: CellReading): String = when (c.networkType) {
        "LTE" -> {
            val eci = c.cellId?.let { "${it shr 8}:${it and 0xFFL}" } ?: DASH
            "PCI ${c.pci ?: DASH} · eNB:sector $eci · TAC ${c.tac ?: DASH}"
        }
        "UMTS" -> "PSC ${c.scramblingCode ?: DASH} · Cell ${c.cellId ?: DASH} · LAC ${c.tac ?: DASH}"
        else -> "BCCH ${c.bcch ?: DASH} · BSIC ${c.bsic ?: DASH} · LAC ${c.tac ?: DASH}"
    }

    private fun qualityLine(c: CellReading): String = when (c.networkType) {
        "LTE" -> "RSRQ ${c.rsrqDb?.let { "$it dB" } ?: DASH} · SINR ${c.sinrDb?.let { "$it dB" } ?: DASH} · CQI ${RfMath.cqiText(c.cqi, c.sinrDb)}"
        "UMTS" -> c.ecioDb?.let { "Ec/Io $it dB" } ?: ""
        else -> ""
    }

    private fun signalRow(dbm: Int?): View {
        val ctx = requireContext()
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(8), 0, dp(2))
        }
        val valueView = text(dbm?.let { "$it dBm" } ?: DASH, 15f, SignalQuality.colorRes(dbm), bold = true)
        valueView.layoutParams = LinearLayout.LayoutParams(dp(92), LinearLayout.LayoutParams.WRAP_CONTENT)
        row.addView(valueView)

        val frac = RfMath.barFraction(dbm)
        val filled = View(ctx).apply { setBackgroundColor(ContextCompat.getColor(ctx, SignalQuality.colorRes(dbm))) }
        val empty = View(ctx).apply { setBackgroundColor(ContextCompat.getColor(ctx, R.color.surface_card_alt)) }
        row.addView(filled, LinearLayout.LayoutParams(0, dp(6), frac))
        row.addView(empty, LinearLayout.LayoutParams(0, dp(6), 1f - frac))
        return row
    }

    private fun text(label: String, sizeSp: Float, colorRes: Int, bold: Boolean = false): TextView =
        TextView(requireContext()).apply {
            this.text = label
            textSize = sizeSp
            setTextColor(ContextCompat.getColor(context, colorRes))
            if (bold) setTypeface(null, Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(2) }
        }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val POLL_MS = 5_000L
        private const val DASH = "—"
    }
}
