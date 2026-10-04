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

        if (savedInstanceState == null) {
            if (hasLocation()) showSignal() else show(QuickSetupFragment())
        }
    }

    /** Opens the Signal tab. Called by Quick Setup once location is answered. */
    fun showSignal() {
        bottomNav.selectedItemId = R.id.nav_signal
        show(SignalFragment())
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
