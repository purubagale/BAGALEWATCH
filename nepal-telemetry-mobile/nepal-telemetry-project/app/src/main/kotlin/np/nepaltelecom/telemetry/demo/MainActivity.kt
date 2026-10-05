package np.nepaltelecom.telemetry.demo

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import np.nepaltelecom.telemetry.NetTelemetry
import java.util.Date

/**
 * A minimal demo/test harness for netplanning-telemetry-sdk -- NOT the
 * pilot's real UI (the opt-in screen, signal-quality view, and dashboard
 * are a separate front-end effort, per this project's own task split).
 * This exists only so the SDK is something a developer can press buttons
 * on and watch behave, both to sanity-check a real build/run and to show
 * every integration point (init/optIn/optOut/sampleNow/uploadNow/getStatus) in one
 * place, exactly as documented in the SDK's own README.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var statusText: TextView

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val fineLocationGranted = grants[Manifest.permission.ACCESS_FINE_LOCATION] == true
        if (fineLocationGranted) {
            NetTelemetry.optIn()
            refreshStatus()
        } else {
            Toast.makeText(
                this,
                "Location permission is required for telemetry sampling",
                Toast.LENGTH_LONG,
            ).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)

        findViewById<Button>(R.id.optInButton).setOnClickListener {
            if (hasLocationPermission()) {
                NetTelemetry.optIn()
                refreshStatus()
            } else {
                permissionLauncher.launch(
                    arrayOf(
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.READ_PHONE_STATE,
                    )
                )
            }
        }

        findViewById<Button>(R.id.optOutButton).setOnClickListener {
            NetTelemetry.optOut()
            refreshStatus()
        }

        findViewById<Button>(R.id.sampleNowButton).setOnClickListener {
            NetTelemetry.sampleNow()
            Toast.makeText(this, "Sample requested -- refresh status in a moment", Toast.LENGTH_SHORT).show()
        }

        findViewById<Button>(R.id.refreshStatusButton).setOnClickListener {
            refreshStatus()
        }

        findViewById<Button>(R.id.uploadNowButton).setOnClickListener {
            NetTelemetry.uploadNow()
            Toast.makeText(
                this,
                "Upload requested -- check Logcat for tag NetTelemetry.Upload for the real result",
                Toast.LENGTH_LONG,
            ).show()
        }

        refreshStatus()
    }

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED

    private fun refreshStatus() {
        val status = NetTelemetry.getStatus()
        statusText.text = buildString {
            append("Opted in: ${status.optedIn}\n")
            append("Queued samples: ${status.queuedSampleCount}\n")
            append("Last sample at: ${status.lastSampleAtMs?.let { Date(it) } ?: "never"}\n")
            append("Last GPS fix: ")
            if (status.lastLat != null && status.lastLon != null) {
                append("%.5f, %.5f".format(status.lastLat, status.lastLon))
                status.lastFixAccuracyM?.let { append(" (±%.0f m)".format(it)) }
                status.lastFixAtMs?.let { append(" at ${Date(it)}") }
            } else {
                append("none")
            }
        }
    }
}
