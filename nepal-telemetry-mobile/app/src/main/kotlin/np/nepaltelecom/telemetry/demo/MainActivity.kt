package np.nepaltelecom.telemetry.demo

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.google.android.material.bottomnavigation.BottomNavigationView

/**
 * Hosts the five main screens behind a bottom bar: Signal, Cells, Map, Wi-Fi,
 * and Settings. When location isn't granted yet, the first screen is Quick
 * Setup, which asks for it. Each screen is a fragment, so switching tabs keeps
 * the app's state.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var bottomNav: BottomNavigationView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        // Keeps the push token on hand, so a later "Start sharing" can register it.
        FcmToken.fetchAndUpload(this)

        bottomNav = findViewById(R.id.bottomNav)
        bottomNav.setOnItemSelectedListener { item ->
            show(
                when (item.itemId) {
                    R.id.nav_cells -> CellsFragment()
                    R.id.nav_map -> MapFragment()
                    R.id.nav_wifi -> WifiFragment()
                    R.id.nav_settings -> SettingsFragment()
                    else -> SignalFragment()
                }
            )
            true
        }

        applyStaffGate()
        if (savedInstanceState == null) {
            if (!StaffMode.isEmployee(this)) {
                bottomNav.selectedItemId = R.id.nav_settings
            } else if (hasLocation()) {
                showSignal()
            } else {
                show(QuickSetupFragment())
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // A request was accepted from its notification: ask for unrestricted battery now, once.
        if (BatteryAccess.takePendingPrompt(this)) {
            runCatching { startActivity(BatteryAccess.requestUnrestrictedIntent(this)) }
        }
    }

    /** Opens the Signal tab. Called by Quick Setup once location is answered. */
    fun showSignal() {
        bottomNav.selectedItemId = R.id.nav_signal
        show(SignalFragment())
    }

    /**
     * Until "I am an NTC employee" is ticked in Settings, only Settings is
     * usable. Signal, Cells, Map and Wi-Fi are disabled (2026-10-05).
     */
    fun applyStaffGate() {
        val employee = StaffMode.isEmployee(this)
        val menu = bottomNav.menu
        listOf(R.id.nav_signal, R.id.nav_cells, R.id.nav_map, R.id.nav_wifi).forEach { id ->
            menu.findItem(id).isEnabled = employee
        }
    }

    /** Called by Settings when the employee box changes. */
    fun onStaffModeChanged() {
        applyStaffGate()
        if (!StaffMode.isEmployee(this)) {
            bottomNav.selectedItemId = R.id.nav_settings
            return
        }
        // The Signal listener shows the screen. Quick Setup replaces it if location is still missing.
        bottomNav.selectedItemId = R.id.nav_signal
        if (!hasLocation()) show(QuickSetupFragment())
    }

    private fun hasLocation(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun show(fragment: Fragment) {
        supportFragmentManager.beginTransaction()
            .replace(R.id.fragmentContainer, fragment)
            .commit()
    }
}
