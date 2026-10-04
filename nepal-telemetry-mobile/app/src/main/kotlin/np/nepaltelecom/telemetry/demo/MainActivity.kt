package np.nepaltelecom.telemetry.demo

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import com.google.android.material.bottomnavigation.BottomNavigationView

/**
 * Hosts the five main screens behind a bottom bar: Signal, Cells, Map, Wi-Fi,
 * and Settings. Each screen is a fragment, so switching tabs keeps the app's state.
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

        // Signal is the first tab, so it's already selected and the listener won't
        // fire for it. Load it directly on first start.
        if (savedInstanceState == null) {
            show(SignalFragment())
        }
    }

    private fun show(fragment: Fragment) {
        supportFragmentManager.beginTransaction()
            .replace(R.id.fragmentContainer, fragment)
            .commit()
    }
}
