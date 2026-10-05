package np.nepaltelecom.telemetry.demo

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.wifi.ScanResult
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED
import androidx.fragment.app.Fragment

/**
 * Nearby Wi-Fi networks, for the user's own view on this phone. Nothing on
 * this screen is sent to the telemetry server. Android limits how often an app
 * may scan, so the list refreshes on a slow timer and on the Scan button.
 */
class WifiFragment : Fragment(R.layout.fragment_wifi) {

    private val handler = Handler(Looper.getMainLooper())
    private val rescan = object : Runnable {
        override fun run() {
            startScan()
            handler.postDelayed(this, RESCAN_MS)
        }
    }

    private lateinit var wifi: WifiManager
    private lateinit var list: LinearLayout
    private lateinit var status: TextView

    private val scanReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == WifiManager.SCAN_RESULTS_AVAILABLE_ACTION) {
                render(wifi.scanResults)
            }
        }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        wifi = requireContext().applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        list = view.findViewById(R.id.wifiList)
        status = view.findViewById(R.id.wifiStatus)
        view.findViewById<Button>(R.id.wifiScanButton).setOnClickListener { startScan() }
    }

    override fun onResume() {
        super.onResume()
        ContextCompat.registerReceiver(
            requireContext(),
            scanReceiver,
            IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION),
            RECEIVER_NOT_EXPORTED,
        )
        if (!hasLocationPermission()) {
            status.text = getString(R.string.wifi_need_location)
            return
        }
        render(wifi.scanResults)
        handler.post(rescan)
    }

    override fun onPause() {
        handler.removeCallbacks(rescan)
        requireContext().unregisterReceiver(scanReceiver)
        super.onPause()
    }

    private fun startScan() {
        if (!hasLocationPermission()) {
            status.text = getString(R.string.wifi_need_location)
            return
        }
        @Suppress("DEPRECATION") // startScan() is still the only scan call that works on API 26+
        val started = wifi.startScan()
        if (!started) status.text = getString(R.string.wifi_throttled)
    }

    private fun render(results: List<ScanResult>) {
        list.removeAllViews()
        if (!hasLocationPermission()) return
        status.text = getString(R.string.wifi_phone_only)
        if (results.isEmpty()) {
            list.addView(text("No networks found yet. Tap Scan again.", 14f, R.color.text_secondary))
            return
        }
        for (r in results.sortedByDescending { it.level }) list.addView(cardFor(r))
    }

    private fun cardFor(r: ScanResult): View {
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

        val name = r.SSID?.takeIf { it.isNotEmpty() } ?: "(hidden network)"
        card.addView(text(name, 16f, R.color.text_primary, bold = true))

        val band = if (r.frequency >= 4900) "5 GHz" else "2.4 GHz"
        card.addView(text("$band · channel ${channelFor(r.frequency)} · ${securityFor(r.capabilities)}", 13f, R.color.text_secondary))
        card.addView(text(r.BSSID ?: "", 12f, R.color.text_secondary))

        card.addView(signalRow(r.level))
        return card
    }

    private fun signalRow(level: Int): View {
        val ctx = requireContext()
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(8), 0, dp(2))
        }
        val colorRes = qualityColor(level)
        val value = text("$level dBm", 15f, colorRes, bold = true)
        value.layoutParams = LinearLayout.LayoutParams(dp(92), LinearLayout.LayoutParams.WRAP_CONTENT)
        row.addView(value)

        val frac = ((level + 100f) / 70f).coerceIn(0f, 1f)
        val filled = View(ctx).apply { setBackgroundColor(ContextCompat.getColor(ctx, colorRes)) }
        val empty = View(ctx).apply { setBackgroundColor(ContextCompat.getColor(ctx, R.color.surface_card_alt)) }
        row.addView(filled, LinearLayout.LayoutParams(0, dp(6), frac))
        row.addView(empty, LinearLayout.LayoutParams(0, dp(6), 1f - frac))
        return row
    }

    /** Wi-Fi bars use their own scale (-100 to -30 dBm), so the cell bands don't apply here. */
    private fun qualityColor(level: Int): Int = when {
        level >= -55 -> R.color.q_excellent
        level >= -67 -> R.color.q_good
        level >= -75 -> R.color.q_fair
        level >= -85 -> R.color.q_moderate
        else -> R.color.q_poor
    }

    private fun channelFor(freqMhz: Int): Int = when {
        freqMhz == 2484 -> 14
        freqMhz in 2412..2472 -> (freqMhz - 2407) / 5
        freqMhz >= 4900 -> (freqMhz - 5000) / 5
        else -> 0
    }

    private fun securityFor(capabilities: String): String = when {
        capabilities.contains("WPA3") -> "WPA3"
        capabilities.contains("WPA2") -> "WPA2"
        capabilities.contains("WPA") -> "WPA"
        capabilities.contains("WEP") -> "WEP"
        else -> "Open"
    }

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(
            requireContext(), Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED

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
        /** Android throttles scans to a few per two minutes, so this stays slow. */
        private const val RESCAN_MS = 30_000L
    }
}
