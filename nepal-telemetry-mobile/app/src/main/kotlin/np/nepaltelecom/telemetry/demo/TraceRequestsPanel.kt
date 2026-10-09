package np.nepaltelecom.telemetry.demo

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.work.BackoffPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import androidx.work.workDataOf
import np.nepaltelecom.telemetry.storage.HardwareInfo
import com.google.android.material.button.MaterialButton
import java.util.concurrent.TimeUnit

/**
 * The "Requests from NTC" card in Settings (2026-10-05). It registers this
 * phone with its mobile number and lists the trace requests the server holds
 * for it. Accept and Reject go to the server, which decides what happens next.
 *
 * The mobile number is typed in for now, since this build can't read it from
 * the SIM. That's a development step, not the final design.
 */
class TraceRequestsPanel(private val root: View, private val fragment: Fragment) {

    private val context: Context get() = fragment.requireContext()
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val msisdnInput: EditText = root.findViewById(R.id.devMsisdn)
    private val registerButton: Button = root.findViewById(R.id.registerDeviceButton)
    private val registrationForm: View = root.findViewById(R.id.registrationForm)
    private val registeredAsText: TextView = root.findViewById(R.id.registeredAsText)
    private val statusText: TextView = root.findViewById(R.id.deviceStatus)
    private val list: LinearLayout = root.findViewById(R.id.requestList)

    private val handler = Handler(Looper.getMainLooper())
    private val poll = object : Runnable {
        override fun run() {
            // Picks up a registration the WorkManager retry worker finished
            // in the background since the last tick -- see
            // refreshRegistrationUi()'s own doc comment.
            refreshRegistrationUi()
            refreshRequests()
            handler.postDelayed(this, POLL_MS)
        }
    }

    fun bind() {
        msisdnInput.setText(prefs.getString(KEY_MSISDN, ""))
        registerButton.setOnClickListener { register() }
        refreshRegistrationUi()
    }

    /** Starts polling while the Settings screen is open. Already-registered
     * installs (2026-10-08, "if already installed... update details only")
     * get a lightweight details refresh instead of ever showing the form
     * again -- re-pushes the FCM token and identity, never re-runs the
     * key/challenge handshake itself, which a device that's already
     * registered doesn't need to repeat. */
    fun start() {
        refreshRegistrationUi()
        if (prefs.getBoolean(KEY_REGISTERED, false)) updateDeviceDetails()
        handler.removeCallbacks(poll)
        handler.post(poll)
    }

    /** Shows the editable number + Register button only for an install that
     * has never registered; an already-registered install just shows its
     * own number instead -- see this class's own KEY_REGISTERED doc comment
     * for why a BACKGROUND retry success (not just this panel's own button)
     * also needs to flip this, which is why it's called from the poll loop
     * too, not only right after register() returns. */
    private fun refreshRegistrationUi() {
        val registered = prefs.getBoolean(KEY_REGISTERED, false)
        registrationForm.visibility = if (registered) View.GONE else View.VISIBLE
        if (registered) {
            registeredAsText.text = context.getString(R.string.req_registered_as, prefs.getString(KEY_MSISDN, "") ?: "")
            registeredAsText.visibility = View.VISIBLE
        } else {
            registeredAsText.visibility = View.GONE
        }
    }

    /** Re-pushes the FCM token and identity for an install that's already
     * registered -- not a re-registration, just keeping the server's record
     * of this device current (a reinstalled/updated app can get a new FCM
     * token, for one). Silent: no status text, no error surfaced -- this is
     * routine upkeep, not a user-initiated action. */
    private fun updateDeviceDetails() {
        Thread {
            FcmToken.fetchAndUpload(context)
            val userType = if (StaffMode.isEmployee(context)) "employee" else "general"
            runCatching { TraceApi.uploadIdentity(Build.MODEL, Build.MANUFACTURER, userType, HardwareInfo.hardwareId(context)) }
        }.start()
    }

    fun stop() {
        handler.removeCallbacks(poll)
    }

    private fun register() {
        val msisdn = msisdnInput.text.toString().trim()
        if (msisdn.isEmpty()) {
            setStatus(context.getString(R.string.req_need_number))
            return
        }
        prefs.edit().putString(KEY_MSISDN, msisdn).apply()
        setStatus(context.getString(R.string.req_registering))
        Thread {
            val message = try {
                DeviceKeys.ensureKey()
                TraceApi.register(msisdn, TraceApi.challenge(), APP_VERSION, HardwareInfo.hardwareId(context))
                prefs.edit().putBoolean(KEY_REGISTERED, true).apply()
                FcmToken.fetchAndUpload(context)
                // Best effort: identity is recorded when the device is registered.
                val userType = if (StaffMode.isEmployee(context)) "employee" else "general"
                runCatching { TraceApi.uploadIdentity(Build.MODEL, Build.MANUFACTURER, userType, HardwareInfo.hardwareId(context)) }
                context.getString(R.string.req_registered)
            } catch (e: Exception) {
                // Immediate attempt failed -- fall back to a WorkManager
                // retry (2026-10-08) so a transient network/VPN miss at
                // this exact moment doesn't need the user to notice and
                // tap the button again themselves, same reliability as
                // every other request this app already queues.
                enqueueRegisterRetry(msisdn)
                context.getString(R.string.req_failed_retrying, friendlyErrorMessage(e))
            }
            onMain {
                setStatus(message)
                refreshRegistrationUi()
            }
            refreshRequests()
        }.start()
    }

    /** Unique, REPLACE-enqueued so retrying again (e.g. the user taps Register
     * a second time before the first retry has landed) never stacks up more
     * than one pending attempt -- only the most recently typed number is ever
     * the one that eventually gets sent. */
    private fun enqueueRegisterRetry(msisdn: String) {
        val data = workDataOf(
            TraceRegisterWorker.KEY_MSISDN to msisdn,
            TraceRegisterWorker.KEY_APP_VERSION to APP_VERSION,
        )
        val request = OneTimeWorkRequestBuilder<TraceRegisterWorker>()
            .setInputData(data)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            TraceRegisterWorker.WORK_NAME, ExistingWorkPolicy.REPLACE, request,
        )
    }

    private fun refreshRequests() {
        if (!prefs.getBoolean(KEY_REGISTERED, false)) return
        Thread {
            val items = try {
                TraceApi.openRequests()
            } catch (e: Exception) {
                null
            }
            onMain { showRequests(items) }
        }.start()
    }

    private fun showRequests(items: List<TraceApi.TraceRequestItem>?) {
        list.removeAllViews()
        addBatteryControls()
        if (items == null) {
            setStatus(context.getString(R.string.req_offline))
            return
        }
        if (items.isEmpty()) {
            list.addView(text(context.getString(R.string.req_none)))
            return
        }
        items.forEach { item ->
            list.addView(text(context.getString(R.string.req_status, item.status)))
            if (item.operatorAttested) list.addView(text(context.getString(R.string.req_attested)))
            if (item.status == STATUS_PENDING) {
                val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
                row.addView(actionButton(context.getString(R.string.req_accept)) { respond(item.id, "accept") })
                row.addView(actionButton(context.getString(R.string.req_reject)) { respond(item.id, "reject") })
                list.addView(row)
            } else if (item.status == STATUS_ACCEPTED) {
                val expiresMs = item.expiresAt?.let { parseIso(it) } ?: 0L
                if (expiresMs > System.currentTimeMillis()) {
                    TraceSharingService.start(context, item.id, expiresMs)
                    val until = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(expiresMs))
                    list.addView(text(context.getString(R.string.req_sharing, until)))
                    list.addView(actionButton(context.getString(R.string.req_stop_sharing)) {
                        TraceSharingService.stop(context)
                        handler.postDelayed({ refreshRequests() }, STOP_REFRESH_MS)
                    })
                }
            }
        }
    }

    private fun respond(id: String, action: String) {
        Thread {
            val message = try {
                TraceApi.respond(id, action)
                context.getString(R.string.req_done)
            } catch (e: Exception) {
                context.getString(R.string.req_failed, friendlyErrorMessage(e))
            }
            onMain {
                setStatus(message)
                // Accepting is when the phone needs to stay reachable, so ask for unrestricted battery now.
                if (action == "accept" && !BatteryAccess.isUnrestricted(context)) {
                    openIntent(BatteryAccess.requestUnrestrictedIntent(context))
                }
                refreshRequests()
            }
        }.start()
    }

    /** Battery status for the card, with the two fixes: the system prompt and Huawei's startup screen. */
    private fun addBatteryControls() {
        if (BatteryAccess.isUnrestricted(context)) {
            list.addView(text(context.getString(R.string.battery_ok)))
            return
        }
        list.addView(text(context.getString(R.string.battery_restricted)))
        list.addView(fullButton(context.getString(R.string.battery_allow)) {
            openIntent(BatteryAccess.requestUnrestrictedIntent(context))
        })
        list.addView(fullButton(context.getString(R.string.battery_huawei)) {
            if (!openIntent(BatteryAccess.huaweiStartupIntent())) openIntent(BatteryAccess.appDetailsIntent(context))
        })
    }

    private fun openIntent(intent: Intent): Boolean = try {
        fragment.startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        false
    }

    private fun fullButton(label: String, onClick: () -> Unit): Button =
        MaterialButton(context, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = label
            setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(8)
            }
        }

    private fun parseIso(value: String): Long? =
        runCatching { java.time.OffsetDateTime.parse(value).toInstant().toEpochMilli() }.getOrNull()

    private fun setStatus(message: String) {
        statusText.text = message
    }

    private fun onMain(block: () -> Unit) {
        fragment.activity?.runOnUiThread {
            if (fragment.isAdded) block()
        }
    }

    private fun text(message: String): TextView = TextView(context).apply {
        text = message
        textSize = 14f
        setTextColor(context.getColor(R.color.text_secondary))
        setPadding(0, dp(6), 0, dp(6))
    }

    private fun actionButton(label: String, onClick: () -> Unit): Button =
        MaterialButton(context, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = label
            setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = dp(8)
            }
        }

    private fun dp(value: Int): Int = (value * context.resources.displayMetrics.density).toInt()

    companion object {
        // PREFS/KEY_REGISTERED (2026-10-08): package-visible, not private --
        // TraceRegisterWorker writes KEY_REGISTERED=true on the SAME
        // SharedPreferences file once a background retry finally succeeds,
        // so this panel's own poll loop (gated on that same flag) picks it
        // up on its next tick without needing a separate observer.
        internal const val PREFS = "dtwatch_device"
        private const val KEY_MSISDN = "msisdn"
        internal const val KEY_REGISTERED = "registered"
        private const val STATUS_PENDING = "PENDING"
        private const val STATUS_ACCEPTED = "ACCEPTED"
        private const val POLL_MS = 30_000L
        private const val STOP_REFRESH_MS = 2_000L
        private const val APP_VERSION = "1.0"
    }
}
