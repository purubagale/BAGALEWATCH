package np.nepaltelecom.telemetry.demo

import android.Manifest
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment

/**
 * First-run and re-prompt screen: shown on the first start after install,
 * and later whenever location permission is missing.
 *
 * It asks for what the app needs to work at all: location and phone state
 * (Android reports no cell without them) and, on Android 13 and later,
 * notifications (a request from NTC arrives as one). The camera is asked for
 * only when the site photo screen is opened.
 *
 * Allowing location here also shares for about one minute and then stops by
 * itself (see [FirstRunSample]); the screen's text says so. That holds on
 * every visit: first install, after an update, or whenever the permission
 * was missing. Lasting sharing is switched on in Settings, or per drive on
 * the Map tab (2026-10-13).
 */
class QuickSetupFragment : Fragment(R.layout.fragment_quick_setup) {

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        if (grants[Manifest.permission.ACCESS_FINE_LOCATION] != true) {
            Toast.makeText(requireContext(), R.string.quick_setup_denied, Toast.LENGTH_LONG).show()
        } else {
            FirstRunSample.start(requireContext())
        }
        finish()
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        view.findViewById<Button>(R.id.grantPermissionsButton).setOnClickListener {
            val wanted = mutableListOf(
                // Android 12+ needs both location permissions in one request.
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.READ_PHONE_STATE,
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                wanted += Manifest.permission.POST_NOTIFICATIONS
            }
            permissionLauncher.launch(wanted.toTypedArray())
        }
        view.findViewById<Button>(R.id.quickSetupLaterButton).setOnClickListener { finish() }
        view.findViewById<TextView>(R.id.quickSetupText).text = getString(R.string.quick_setup_body)
    }

    private fun finish() {
        (activity as? MainActivity)?.onSetupFinished()
    }
}
