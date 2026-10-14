package np.nepaltelecom.telemetry.demo

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.google.android.material.bottomnavigation.BottomNavigationView

/**
 * Hosts the main screens behind a bottom bar. Everyone gets Signal, Wi-Fi and
 * Settings. Cells and Map are added for a user who ticked "I am an NTC
 * employee" in Settings.
 *
 * The first start after install shows Quick Setup, which asks for the
 * permissions, and then the pop-up to register the phone's number. The first
 * start after an update checks registration: it asks for the number if the
 * phone is not registered, and says so if it already is (2026-10-13). Each
 * screen is a fragment, so switching tabs keeps the app's state.
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
            when (AppLaunch.kind(this)) {
                // Permissions first; the number is asked when setup closes.
                AppLaunch.Kind.FIRST_INSTALL -> show(QuickSetupFragment())
                // Permission is checked first. If it is missing, setup asks for
                // it and the registration check follows when setup closes.
                AppLaunch.Kind.UPDATED -> {
                    openFirstScreen()
                    if (hasLocation()) checkRegistrationAfterUpdate()
                }
                AppLaunch.Kind.NORMAL -> openFirstScreen()
            }
        }
    }

    private fun openFirstScreen() {
        if (hasLocation()) showSignal() else show(QuickSetupFragment())
    }

    /**
     * Quick Setup closed, with the permissions answered or put off. On the
     * first start after install or after an update, registration comes next.
     */
    fun onSetupFinished() {
        showSignal()
        when (AppLaunch.kind(this)) {
            AppLaunch.Kind.FIRST_INSTALL -> {
                AppLaunch.markHandled(this)
                if (!Registration.isRegistered(this)) RegisterPrompt.ask(this)
            }
            AppLaunch.Kind.UPDATED -> checkRegistrationAfterUpdate()
            AppLaunch.Kind.NORMAL -> Unit
        }
    }

    /** After an update: ask for the number if the phone is not registered, else say it is. */
    private fun checkRegistrationAfterUpdate() {
        AppLaunch.markHandled(this)
        if (Registration.isRegistered(this)) RegisterPrompt.alreadyRegistered(this) else RegisterPrompt.ask(this)
    }

    /** The pop-up registered the phone: let an open Settings screen show it. */
    fun onRegistrationChanged() {
        (supportFragmentManager.findFragmentById(R.id.fragmentContainer) as? SettingsFragment)?.onRegistrationChanged()
    }

    override fun onResume() {
        super.onResume()
        Collector.resumeIfSharing(this)
        // A request was accepted from its notification: ask for unrestricted battery now, once.
        if (BatteryAccess.takePendingPrompt(this)) {
            runCatching { startActivity(BatteryAccess.requestUnrestrictedIntent(this)) }
        }
    }

    /** Opens the Signal tab. */
    fun showSignal() {
        bottomNav.selectedItemId = R.id.nav_signal
        show(SignalFragment())
    }

    /**
     * Cells and Map are for NTC employees. Until the box in Settings is
     * ticked they are taken off the bar, not greyed out, so the bar holds
     * Signal, Wi-Fi and Settings only (2026-10-13).
     */
    fun applyStaffGate() {
        val employee = StaffMode.isEmployee(this)
        listOf(R.id.nav_cells, R.id.nav_map).forEach { id ->
            bottomNav.menu.findItem(id).isVisible = employee
        }
    }

    /** Called by Settings when the employee box changes. The user stays on Settings. */
    fun onStaffModeChanged() {
        applyStaffGate()
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
