package np.nepaltelecom.telemetry.demo

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import np.nepaltelecom.telemetry.NetTelemetry
import java.util.Date

/**
 * Opt-in, consent, and upload controls, plus the SDK status. These moved here
 * from the old single-screen layout so the signal and drive screens can be
 * the first thing a user sees.
 */
class SettingsFragment : Fragment(R.layout.fragment_settings) {

    private lateinit var statusText: TextView

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        if (grants[Manifest.permission.ACCESS_FINE_LOCATION] == true) {
            NetTelemetry.optIn()
            refresh()
        } else {
            toast("Location permission is required for telemetry sampling")
        }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        statusText = view.findViewById(R.id.statusText)

        view.findViewById<Button>(R.id.optInButton).setOnClickListener {
            if (hasLocationPermission()) {
                NetTelemetry.optIn()
                refresh()
            } else {
                permissionLauncher.launch(
                    arrayOf(
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.READ_PHONE_STATE,
                    )
                )
            }
        }

        val employeeBox = view.findViewById<CheckBox>(R.id.employeeCheck)
        employeeBox.isChecked = StaffMode.isEmployee(requireContext())
        employeeBox.setOnCheckedChangeListener { _, checked ->
            StaffMode.setEmployee(requireContext(), checked)
            (activity as? MainActivity)?.onStaffModeChanged()
        }

        view.findViewById<Button>(R.id.optOutButton).setOnClickListener {
            NetTelemetry.optOut()
            refresh()
        }

        view.findViewById<Button>(R.id.sampleNowButton).setOnClickListener {
            NetTelemetry.sampleNow()
            toast("Sample requested. Refresh status in a moment")
        }

        view.findViewById<Button>(R.id.refreshStatusButton).setOnClickListener { refresh() }

        view.findViewById<Button>(R.id.uploadNowButton).setOnClickListener {
            NetTelemetry.uploadNow()
            toast("Upload requested. Check Logcat for the real result")
        }

        view.findViewById<Button>(R.id.driveTestConsentButton).setOnClickListener {
            showDriveTestConsentDialog()
        }

        view.findViewById<Button>(R.id.rescueEnrollButton).setOnClickListener {
            showRescueEnrollDialog()
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    /**
     * Fetches the backend's current consent message and asks the subscriber to
     * accept or decline. Falls back to a bundled string when the fetch fails.
     */
    private fun showDriveTestConsentDialog() {
        NetTelemetry.fetchDriveTestConsentMessage { fetched ->
            val message = fetched ?: getString(R.string.drive_test_consent_fallback)
            activity?.runOnUiThread {
                if (!isAdded) return@runOnUiThread
                AlertDialog.Builder(requireContext())
                    .setTitle(R.string.drive_test_consent)
                    .setMessage(message)
                    .setPositiveButton("Accept") { _, _ ->
                        NetTelemetry.setDriveTestConsent(true)
                        toast("Drive-test consent accepted")
                    }
                    .setNegativeButton("Decline") { _, _ ->
                        NetTelemetry.setDriveTestConsent(false)
                        toast("Drive-test consent declined")
                    }
                    .show()
            }
        }
    }

    /**
     * Registers or withdraws the rescue-location beacon. This is the only place
     * a raw phone number is typed in. Withdrawing erases what was already sent.
     */
    private fun showRescueEnrollDialog() {
        val input = EditText(requireContext()).apply {
            inputType = InputType.TYPE_CLASS_PHONE
            hint = "+977..."
        }
        AlertDialog.Builder(requireContext())
            .setTitle(R.string.rescue_enroll)
            .setMessage(R.string.rescue_enroll_prompt)
            .setView(input)
            .setPositiveButton("Register") { _, _ ->
                val msisdn = input.text?.toString()?.trim().orEmpty()
                if (msisdn.isEmpty()) {
                    toast("Enter a phone number to register")
                } else {
                    NetTelemetry.enrollForRescue(msisdn)
                    toast("Rescue location registration requested")
                }
            }
            .setNeutralButton("Withdraw") { _, _ ->
                NetTelemetry.optOutOfRescue()
                toast("Rescue location withdrawal requested")
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(
            requireContext(), Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED

    private fun refresh() {
        val status = NetTelemetry.getStatus()
        statusText.text = buildString {
            append("Opted in: ${status.optedIn}\n")
            append("Queued samples: ${status.queuedSampleCount}\n")
            append("Last sample at: ${status.lastSampleAtMs?.let { Date(it) } ?: "never"}")
        }
    }

    private fun toast(message: String) {
        Toast.makeText(requireContext(), message, Toast.LENGTH_SHORT).show()
    }
}
