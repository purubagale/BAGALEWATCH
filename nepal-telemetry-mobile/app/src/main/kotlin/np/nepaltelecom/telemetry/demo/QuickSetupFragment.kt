package np.nepaltelecom.telemetry.demo

import android.Manifest
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import np.nepaltelecom.telemetry.NetTelemetry

/**
 * First-run and re-prompt screen, shown when location permission is missing.
 *
 * Granting location is also the opt-in for uploads: the SDK only sends data
 * after opt-in, and Settings has an Opt out switch. Denying leaves uploads
 * off. Live readings on the Signal, Cells, and Map screens still need location,
 * since Android won't report cells without it.
 */
class QuickSetupFragment : Fragment(R.layout.fragment_quick_setup) {

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        if (grants[Manifest.permission.ACCESS_FINE_LOCATION] == true) {
            NetTelemetry.startShare()
            finish()
        } else {
            Toast.makeText(requireContext(), R.string.quick_setup_denied, Toast.LENGTH_LONG).show()
        }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        view.findViewById<Button>(R.id.grantPermissionsButton).setOnClickListener {
            permissionLauncher.launch(
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.READ_PHONE_STATE,
                )
            )
        }
        view.findViewById<Button>(R.id.quickSetupLaterButton).setOnClickListener { finish() }
        view.findViewById<TextView>(R.id.quickSetupText).text = getString(R.string.quick_setup_body)
    }

    private fun finish() {
        (activity as? MainActivity)?.showSignal()
    }
}
