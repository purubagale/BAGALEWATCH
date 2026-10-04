package np.nepaltelecom.telemetry.demo

import android.Manifest
import android.content.pm.PackageManager
import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
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
 * every integration point (init/optIn/optOut/sampleNow/getStatus) in one
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

        findViewById<Button>(R.id.driveTestConsentButton).setOnClickListener {
            showDriveTestConsentDialog()
        }

        findViewById<Button>(R.id.rescueEnrollButton).setOnClickListener {
            showRescueEnrollDialog()
        }

        findViewById<Button>(R.id.liveParamsButton).setOnClickListener {
            startActivity(Intent(this, LiveParamsActivity::class.java))
        }

        // Drive-test tracking (2026-10-04). Needs opt-in and location permission;
        // the service shows a notification with its own Stop button while it runs.
        findViewById<Button>(R.id.driveTestStartButton).setOnClickListener {
            if (!hasLocationPermission()) {
                Toast.makeText(this, "Opt in first, so location permission is granted", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            NetTelemetry.startDriveTest(this)
            Toast.makeText(this, "Drive test started", Toast.LENGTH_SHORT).show()
        }

        findViewById<Button>(R.id.driveTestStopButton).setOnClickListener {
            NetTelemetry.stopDriveTest(this)
            Toast.makeText(this, "Drive test stopped", Toast.LENGTH_SHORT).show()
        }

        refreshStatus()
    }

    /**
     * Fetches the backend's current, superadmin-editable consent message
     * (DriveTestConsentConfig -- Telemetry Admin page) and shows it in a
     * plain AlertDialog with Accept/Decline, then reports the subscriber's
     * answer via NetTelemetry.setDriveTestConsent(). This dialog itself is
     * demo-app UI, NOT part of the SDK -- exactly per TelemetryConfig's
     * "no UI of its own" design: a real host app is free to build its own
     * screen instead of this one, or to hardcode its own wording and skip
     * fetchDriveTestConsentMessage() entirely. Falls back to a bundled
     * string if the fetch fails (offline, backend down, or the message
     * endpoint isn't configured) so the button still works without a
     * live backend.
     */
    private fun showDriveTestConsentDialog() {
        NetTelemetry.fetchDriveTestConsentMessage { fetched ->
            val message = fetched ?: getString(R.string.drive_test_consent_fallback)
            AlertDialog.Builder(this)
                .setTitle(R.string.drive_test_consent)
                .setMessage(message)
                .setPositiveButton("Accept") { _, _ ->
                    NetTelemetry.setDriveTestConsent(true)
                    Toast.makeText(this, "Drive-test consent accepted", Toast.LENGTH_SHORT).show()
                }
                .setNegativeButton("Decline") { _, _ ->
                    NetTelemetry.setDriveTestConsent(false)
                    Toast.makeText(this, "Drive-test consent declined", Toast.LENGTH_SHORT).show()
                }
                .show()
        }
    }

    /**
     * "Register" collects a phone number and calls
     * NetTelemetry.enrollForRescue(msisdn) -- the ONLY place in this whole
     * demo app that a raw phone number is ever typed in, matching
     * core/rescue.py's own note that RescueEnrollView is the only place a
     * raw device id and a phone number are ever seen together, because the
     * device itself sent both. "Withdraw" calls optOutOfRescue(), which
     * erases the stored number/location outright under the default
     * 'mandatory' RescueConsentPolicy (see that model's docstring) -- so
     * withdrawing here isn't just "stop sending," it's "forget what was
     * already sent." Like showDriveTestConsentDialog() above, this dialog
     * is demo-app UI only, not part of the SDK: a real host app is free to
     * build its own registration screen instead.
     */
    private fun showRescueEnrollDialog() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_PHONE
            hint = "+977..."
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.rescue_enroll)
            .setMessage(R.string.rescue_enroll_prompt)
            .setView(input)
            .setPositiveButton("Register") { _, _ ->
                val msisdn = input.text?.toString()?.trim().orEmpty()
                if (msisdn.isEmpty()) {
                    Toast.makeText(this, "Enter a phone number to register", Toast.LENGTH_SHORT).show()
                } else {
                    NetTelemetry.enrollForRescue(msisdn)
                    Toast.makeText(this, "Rescue location registration requested", Toast.LENGTH_SHORT).show()
                }
            }
            .setNeutralButton("Withdraw") { _, _ ->
                NetTelemetry.optOutOfRescue()
                Toast.makeText(this, "Rescue location withdrawal requested", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Cancel", null)
            .show()
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
            append("Last sample at: ${status.lastSampleAtMs?.let { Date(it) } ?: "never"}")
        }
    }
}
