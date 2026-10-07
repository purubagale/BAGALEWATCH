package np.nepaltelecom.telemetry.demo

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/**
 * Battery settings that decide whether a locked or idle phone still gets trace
 * requests (2026-10-06). Android lets an app ask for "unrestricted" battery with
 * one system prompt, which the user answers. Huawei's own app-launch and
 * power settings have no public API, so the app opens that screen and the user
 * changes the switches there. The app can't change either setting on its own.
 */
object BatteryAccess {
    /** Set when a request is accepted, so the battery prompt shows the next time the app opens. */
    const val PREFS = "dtwatch_device"
    const val KEY_PROMPT_PENDING = "battery_prompt_pending"

    fun isUnrestricted(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

    /** Android's standard one-tap prompt to allow unrestricted battery use. */
    fun requestUnrestrictedIntent(context: Context): Intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))

    /** Huawei's startup manager, where auto-launch and background run are set. */
    fun huaweiStartupIntent(): Intent = Intent().setComponent(
        ComponentName(
            "com.huawei.systemmanager",
            "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
        )
    )

    /** This app's own settings page, the fallback when the Huawei screen isn't there. */
    fun appDetailsIntent(context: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))

    fun markPromptPending(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_PROMPT_PENDING, true).apply()
    }

    /** Returns true once, if a prompt was waiting and the app isn't unrestricted yet. Clears the flag. */
    fun takePendingPrompt(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_PROMPT_PENDING, false)) return false
        prefs.edit().putBoolean(KEY_PROMPT_PENDING, false).apply()
        return !isUnrestricted(context)
    }
}
