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

        read()
    }

    private fun read() {
        paramsText.text = getString(R.string.live_params_reading)
        NetTelemetry.readLiveSample { sample ->
            runOnUiThread { paramsText.text = format(sample) }
        }
    }

    private fun format(s: Sample?): String {
        if (s == null) return getString(R.string.live_params_none)
        return buildString {
            section("Time", Date(s.timestampMs).toString())
            section("Trigger", s.triggerReason)
            section("Network", s.networkType)
            section("Operator (MCC / MNC)", "${s.mcc.orDash()} / ${s.mnc.orDash()}")
            section("Cell ID", s.cellId.orDash())
            section("PCI (LTE)", s.pci.orDash())
            section("TAC / LAC", s.tac.orDash())
            section("Scrambling code (3G)", s.scramblingCode.orDash())
            section("BCCH (2G)", s.bcch.orDash())
            section("BSIC (2G)", s.bsic.orDash())
            section("RSRP", s.rsrpDbm.withUnit("dBm"))
            section("RSRQ", s.rsrqDb.withUnit("dB"))
            section("SINR", s.sinrDb.withUnit("dB"))
            section("RSSI", s.rssiDbm.withUnit("dBm"))
            section("RSCP (3G)", s.rscpDbm.withUnit("dBm"))
            section("Ec/Io (3G)", s.ecioDb.withUnit("dB"))
            section("Rx quality (2G)", s.rxQual.orDash())
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
