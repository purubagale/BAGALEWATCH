package np.nepaltelecom.telemetry.demo

import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.model.Sample
import java.util.Date

/**
 * Shows this phone's live cell, signal and location readings on screen, read
 * straight from the SDK (NetTelemetry.readLiveSample). Nothing shown here is
 * uploaded or queued -- it's the same data the background sampler collects,
 * just visible on the phone for inspection. The serving site, which the
 * server works out after upload, is not shown: the phone doesn't know it.
 */
class LiveParamsActivity : AppCompatActivity() {

    private lateinit var paramsText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_live_params)

        paramsText = findViewById(R.id.paramsText)
        findViewById<Button>(R.id.refreshParamsButton).setOnClickListener { read() }
        // This screen has no toolbar (Theme.NetTelemetryDemo is NoActionBar,
        // matching the rest of the app) and no bottom tab bar of its own --
        // it's a single-purpose detail view launched from Signal's own
        // "Details" button, not a peer destination to the tabs. Without this,
        // the system back gesture/button was the ONLY way out (2026-10-07
        // report: "only android back make possible to go to other page").
        findViewById<Button>(R.id.closeParamsButton).setOnClickListener { finish() }

        read()
    }

    private fun read() {
        paramsText.text = getString(R.string.live_params_reading)
        NetTelemetry.readLiveSample { sample ->
            runOnUiThread { paramsText.text = format(sample) }
        }
    }

    /**
     * Only the serving cell's technology is shown: the radio the phone is camped
     * on. Neighbour and other-RAT fields are left out, because they're empty for
     * the serving cell and only add dashes.
     */
    private fun format(s: Sample?): String {
        if (s == null) return getString(R.string.live_params_none)
        return buildString {
            section("Time", Date(s.timestampMs).toString())
            section("Trigger", s.triggerReason)
            section("Serving network", s.networkType)
            section("Operator (MCC / MNC)", "${s.mcc.orDash()} / ${s.mnc.orDash()}")
            when (s.networkType) {
                "LTE" -> {
                    section("Cell ID (ECI)", s.cellId.orDash())
                    section("eNB : sector", s.cellId?.let { "${it shr 8} : ${it and 0xFFL}" }.orDash())
                    section("PCI", s.pci.orDash())
                    section("TAC", s.tac.orDash())
                    section("RSRP", s.rsrpDbm.withUnit("dBm"))
                    section("RSRQ", s.rsrqDb.withUnit("dB"))
                    section("SINR", s.sinrDb.withUnit("dB"))
                    section("CQI (4G)", RfMath.cqiText(s.cqi, s.sinrDb))
                    section("RSSI", s.rssiDbm.withUnit("dBm"))
                }
                "UMTS" -> {
                    section("Cell ID", s.cellId.orDash())
                    section("Scrambling code (PSC)", s.scramblingCode.orDash())
                    section("LAC", s.tac.orDash())
                    section("RSCP", s.rscpDbm.withUnit("dBm"))
                    section("Ec/Io", s.ecioDb.withUnit("dB"))
                    section("RSSI", s.rssiDbm.withUnit("dBm"))
                }
                "GSM" -> {
                    section("Cell ID", s.cellId.orDash())
                    section("BCCH (ARFCN)", s.bcch.orDash())
                    section("BSIC", s.bsic.orDash())
                    section("LAC", s.tac.orDash())
                    section("RSSI", s.rssiDbm.withUnit("dBm"))
                    section("Rx quality", s.rxQual.orDash())
                }
                else -> section("Cell", "No serving cell reported on this network")
            }
            section("Latitude", s.lat.orDash())
            section("Longitude", s.lon.orDash())
            section("GPS accuracy", s.gpsAccuracyM.withUnit("m"))
            section("Battery", s.batteryPct.withUnit("%"))
        }
    }

    private fun StringBuilder.section(label: String, value: String) {
        append(label).append('\n').append(value).append("\n\n")
    }

    private fun Any?.orDash(): String = this?.toString() ?: "—"

    private fun Any?.withUnit(unit: String): String = this?.let { "$it $unit" } ?: "—"
}
