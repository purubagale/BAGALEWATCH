package np.nepaltelecom.telemetry.demo

import android.content.Context

/**
 * Tells a first start after install from a first start after an update
 * (2026-10-13). The app shows its setup and the registration pop-up on the
 * first, and checks registration on the second.
 *
 * Android stamps the package with the time it was last installed or updated.
 * The stamp handled last time is kept here; a different one means the app
 * was updated since. With nothing kept yet, the install and update times
 * decide: equal on a fresh install, different when this version arrived as
 * an update over one that kept no stamp.
 */
object AppLaunch {

    enum class Kind { FIRST_INSTALL, UPDATED, NORMAL }

    private const val PREFS = "dtwatch_launch"
    private const val KEY_HANDLED = "handled_update_time"

    private fun times(context: Context): Pair<Long, Long> {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return info.firstInstallTime to info.lastUpdateTime
    }

    fun kind(context: Context): Kind {
        val (installed, updated) = times(context)
        val handled = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_HANDLED, 0L)
        return when {
            handled == updated -> Kind.NORMAL
            handled == 0L && installed == updated -> Kind.FIRST_INSTALL
            else -> Kind.UPDATED
        }
    }

    /** Call once the first-install or update steps have been shown. */
    fun markHandled(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putLong(KEY_HANDLED, times(context).second).apply()
    }
}
