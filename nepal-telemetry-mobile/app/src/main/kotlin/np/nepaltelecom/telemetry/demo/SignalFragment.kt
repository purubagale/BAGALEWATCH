package np.nepaltelecom.telemetry.demo

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.model.Sample
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The main signal screen: a live gauge, a three-minute history, and the
 * serving cell's details. It polls the phone's cell state every few seconds,
 * without waiting for a GPS fix, and only while it's on screen.
 */
class SignalFragment : Fragment(R.layout.fragment_signal) {

    private val handler = Handler(Looper.getMainLooper())
    private val poll = object : Runnable {
        override fun run() {
            readCell()
            handler.postDelayed(this, POLL_MS)
        }
    }

    private lateinit var gauge: GaugeView
    private lateinit var sparkline: SparklineView
    private lateinit var qualityText: TextView
    private lateinit var valOperator: TextView
    private lateinit var valNetwork: TextView
    private lateinit var valCell: TextView
    private lateinit var valTac: TextView
    private lateinit var valPci: TextView
    private lateinit var valRsrq: TextView
    private lateinit var valSinr: TextView
    private lateinit var valUpdated: TextView

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        gauge = view.findViewById(R.id.gauge)
        sparkline = view.findViewById(R.id.sparkline)
        qualityText = view.findViewById(R.id.qualityText)
        valOperator = view.findViewById(R.id.valOperator)
        valNetwork = view.findViewById(R.id.valNetwork)
        valCell = view.findViewById(R.id.valCell)
        valTac = view.findViewById(R.id.valTac)
        valPci = view.findViewById(R.id.valPci)
        valRsrq = view.findViewById(R.id.valRsrq)
        valSinr = view.findViewById(R.id.valSinr)
        valUpdated = view.findViewById(R.id.valUpdated)

        view.findViewById<Button>(R.id.detailsButton).setOnClickListener {
            startActivity(Intent(requireContext(), LiveParamsActivity::class.java))
        }
    }

    override fun onResume() {
        super.onResume()
        handler.post(poll)
    }

    override fun onPause() {
        handler.removeCallbacks(poll)
        super.onPause()
    }

    private fun readCell() {
        NetTelemetry.readLiveCell { sample ->
            activity?.runOnUiThread {
                if (isAdded && view != null) render(sample)
            }
        }
    }

    private fun render(s: Sample?) {
        if (s == null) {
            gauge.setValue(null)
            qualityText.text = getString(R.string.signal_no_reading)
            qualityText.setTextColor(ContextCompat.getColor(requireContext(), R.color.q_nodata))
            listOf(valOperator, valNetwork, valCell, valTac, valPci, valRsrq, valSinr, valUpdated)
                .forEach { it.text = DASH }
            return
        }

        val primary = primaryDbm(s)
        gauge.setValue(primary)
        qualityText.text = SignalQuality.label(primary)
        qualityText.setTextColor(ContextCompat.getColor(requireContext(), SignalQuality.colorRes(primary)))
        primary?.let { sparkline.add(it) }

        valOperator.text = if (s.mcc == null && s.mnc == null) DASH else "${s.mcc ?: "?"} / ${s.mnc ?: "?"}"
        valNetwork.text = s.networkType
        valCell.text = cellLabel(s)
        valTac.text = s.tac?.toString() ?: DASH
        valPci.text = s.pci?.toString() ?: DASH
        valRsrq.text = s.rsrqDb?.let { "$it dB" } ?: DASH
        valSinr.text = s.sinrDb?.let { "$it dB" } ?: DASH
        valUpdated.text = timeFormat.format(Date())
    }

    /** The reading the gauge shows: RSRP for LTE, and the closest equivalent for 3G and 2G. */
    private fun primaryDbm(s: Sample): Int? = when (s.networkType) {
        "LTE", "NR" -> s.rsrpDbm ?: s.rssiDbm
        "UMTS" -> s.rscpDbm ?: s.rssiDbm
        "GSM" -> s.rssiDbm
        else -> s.rsrpDbm ?: s.rssiDbm
    }

    /**
     * For LTE, the cell identity is split into eNB and sector, which is how
     * the operator's own tools show it: ECI 475137 becomes 1856:1.
     */
    private fun cellLabel(s: Sample): String {
        val id = s.cellId ?: return DASH
        return if (s.networkType == "LTE") "${id shr 8}:${id and 0xFFL}" else id.toString()
    }

    companion object {
        private const val POLL_MS = 3_000L
        private const val DASH = "—"
        private val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
    }
}
