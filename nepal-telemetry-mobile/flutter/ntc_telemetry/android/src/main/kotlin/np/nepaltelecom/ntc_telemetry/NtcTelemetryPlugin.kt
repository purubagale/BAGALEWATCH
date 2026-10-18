package np.nepaltelecom.ntc_telemetry

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.model.CellReading
import np.nepaltelecom.telemetry.model.RadioBand
import np.nepaltelecom.telemetry.model.Sample
import np.nepaltelecom.telemetry.device.DeviceApi
import np.nepaltelecom.telemetry.device.NetDevice
import np.nepaltelecom.telemetry.device.NetProblem
import np.nepaltelecom.telemetry.device.ProblemHints
import np.nepaltelecom.telemetry.device.SpeedTest
import np.nepaltelecom.telemetry.device.friendlyErrorMessage
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The Android side of the ntc_telemetry Flutter plugin (2026-10-16). Each
 * Dart call is forwarded to the NTC telemetry SDK. Calls that touch the
 * network or wait for a reading run on a background thread and answer on
 * the main thread.
 *
 * Errors reach Dart as PlatformException codes: "not_initialized" (call
 * init first), "unsupported" (Android 7: the SDK is off below 8.0), "api"
 * (the server refused; message is its reason, safe to show), "failed"
 * (anything else; message is safe to show).
 */
class NtcTelemetryPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {

    private lateinit var channel: MethodChannel
    private lateinit var context: Context
    private val worker = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL)
        channel.setMethodCallHandler(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            // Android 7: the plugin installs, but every feature is off.
            if (call.method !in ALWAYS_AVAILABLE && !NetTelemetry.isSupported()) {
                result.error("unsupported", NetDevice.UNSUPPORTED_MESSAGE, null)
                return
            }
            if (call.method != "init" && call.method != "capabilities" && !StoredConfig.isInitialized()) {
                result.error("not_initialized", "Call NtcTelemetry.init first.", null)
                return
            }
            handle(call, result)
        } catch (e: Exception) {
            fail(result, e)
        }
    }

    private fun handle(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "init" -> {
                StoredConfig.save(context, call.arguments as Map<*, *>)
                StoredConfig.initSdk(context)
                result.success(null)
            }
            "capabilities" -> result.success(capabilities())
            "missingPermissions" -> result.success(missingPermissions())

            // Sharing
            "optIn" -> { NetTelemetry.optIn(); result.success(null) }
            "optOut" -> { NetTelemetry.optOut(call.argument<Boolean>("wipeQueued") ?: true); result.success(null) }
            "isOptedIn" -> result.success(NetTelemetry.isOptedIn())
            "startShare" -> result.success(NetTelemetry.startShare(call.argument<Int>("minutes") ?: 60))
            "stopShare" -> { NetTelemetry.stopShare(); result.success(null) }
            "shareExpiresAt" -> result.success(NetTelemetry.shareExpiresAtMs())
            "status" -> {
                val s = NetTelemetry.getStatus()
                result.success(mapOf(
                    "optedIn" to s.optedIn,
                    "queuedSamples" to s.queuedSampleCount,
                    "lastSampleAt" to s.lastSampleAtMs,
                    "lastUploadAttemptAt" to s.lastUploadAttemptAtMs,
                ))
            }
            "sampleNow" -> { NetTelemetry.sampleNow(); result.success(null) }
            "uploadNow" -> { NetTelemetry.uploadNow(); result.success(null) }
            "sdkDeviceId" -> result.success(NetTelemetry.sdkDeviceId())

            // Readings
            "readLiveSample" -> NetTelemetry.readLiveSample { s -> main.post { result.success(s?.let(::sampleMap)) } }
            "readCells" -> NetTelemetry.readCellsNow { cells -> main.post { result.success(cells.map(::cellMap)) } }

            // Drive test
            "startDriveTest" -> {
                NetTelemetry.startDriveTest(context, call.argument<Boolean>("share") ?: false)
                result.success(null)
            }
            "stopDriveTest" -> { NetTelemetry.stopDriveTest(context); result.success(null) }
            "currentDriveSessionId" -> result.success(NetTelemetry.currentDriveSessionId())

            // Push (reading requests from NTC)
            "setPushToken" -> { NetTelemetry.setPushToken(call.argument<String>("token")); result.success(null) }
            "answerSampleRequest" -> { NetTelemetry.answerSampleRequest(); result.success(null) }

            // Registration and number
            "register" -> {
                val msisdn = call.argument<String>("msisdn") ?: return result.error("failed", "msisdn is required", null)
                NetDevice.register(context, msisdn, call.argument<String>("userType") ?: "general") { ok, error ->
                    result.success(mapOf("registered" to ok, "error" to error, "retrying" to !ok))
                }
            }
            "registration" -> result.success(registrationMap())
            "refreshNumberStatus" -> background(result) { NetDevice.refreshNumberStatus(context); registrationMap() }
            "sendNumberCode" -> background(result) { NetDevice.sendNumberCode(context) }
            "confirmNumberCode" -> {
                val code = call.argument<String>("code").orEmpty()
                background(result) { NetDevice.confirmNumberCode(context, code) }
            }

            // Speed test and problem report
            "speedTest" -> {
                val bearer = call.argument<String>("bearer") ?: "mobile"
                val fallback = call.argument<Boolean>("fallback") ?: false
                val report = call.argument<Boolean>("report") ?: true
                background(result) {
                    val r = if (bearer == "wifi") SpeedTest.runOnWifi(context)
                    else SpeedTest.runOnMobileData(context, fallback)
                    // Sent to NTC like the reference app does: only a finished test,
                    // and the SDK itself sends only while sharing is on.
                    if (r != null && r.error == null && report) {
                        val s = readSampleBlocking()
                        NetTelemetry.reportSpeedTest(
                            pingMedianMs = r.pingMedianMs, jitterMs = r.jitterMs,
                            downloadMbps = r.downloadMbps, uploadMbps = r.uploadMbps,
                            networkType = s?.networkType, rsrpDbm = s?.rsrpDbm ?: s?.rscpDbm ?: s?.rssiDbm,
                            packetLossPct = r.packetLossPct, bearer = r.bearer,
                        )
                    }
                    r?.let(::speedMap)
                }
            }
            "problemCategories" -> result.success(NetProblem.CATEGORIES.map { mapOf("code" to it.first, "label" to it.second) })
            "reportProblem" -> {
                val category = call.argument<String>("category").orEmpty()
                val note = call.argument<String>("note").orEmpty()
                val withSpeed = call.argument<Boolean>("withSpeedTest") ?: true
                background(result) {
                    val o = NetProblem.send(context, category, note, withSpeed)
                    mapOf(
                        "sent" to o.sent,
                        "notRegistered" to o.notRegistered,
                        "noLocation" to o.noLocation,
                        "error" to o.error,
                        "hint" to o.hint,
                        "reading" to o.sample?.let(::sampleMap),
                        "speed" to o.speed?.let(::speedMap),
                    )
                }
            }
            "explain" -> {
                // Hint for the latest reading and an optional speed result, without sending anything.
                background(result) { ProblemHints.explain(readSampleBlocking(), null) }
            }
            else -> result.notImplemented()
        }
    }

    /** The current reading, waiting up to 30 s for a position. Off the main thread only. */
    private fun readSampleBlocking(): Sample? {
        val latch = CountDownLatch(1)
        var sample: Sample? = null
        NetTelemetry.readLiveSample { sample = it; latch.countDown() }
        latch.await(30, TimeUnit.SECONDS)
        return sample
    }

    private fun <T> background(result: MethodChannel.Result, block: () -> T) {
        worker.execute {
            try {
                val value = block()
                main.post { result.success(value) }
            } catch (e: Exception) {
                main.post { fail(result, e) }
            }
        }
    }

    private fun fail(result: MethodChannel.Result, e: Exception) {
        val code = when (e) {
            is DeviceApi.ApiException -> "api"
            is IllegalStateException -> "not_initialized"
            else -> "failed"
        }
        result.error(code, friendlyErrorMessage(e), (e as? DeviceApi.ApiException)?.code)
    }

    private fun capabilities(): Map<String, Any> {
        val on = NetTelemetry.isSupported()
        return mapOf(
            "platform" to "android",
            // False on Android 7: hide the telemetry screens.
            "supported" to on,
            "signal" to on,
            "cells" to on,
            "driveTest" to on,
            "speedTest" to on,
            "reportProblem" to on,
            "numberVerification" to on,
            "readNumberFromSim" to false,
        "sdkVersion" to SDK_VERSION,
            "androidSdk" to Build.VERSION.SDK_INT,
        )
    }

    /** Android permissions the readings need and the app has not been given yet. */
    private fun missingPermissions(): List<String> {
        // Both location permissions: Android 12+ needs them in one request.
        val wanted = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.READ_PHONE_STATE,
        )
        if (Build.VERSION.SDK_INT >= 33) wanted += Manifest.permission.POST_NOTIFICATIONS
        return wanted.filter { ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED }
    }

    private fun registrationMap(): Map<String, Any?> = mapOf(
        "registered" to NetDevice.isRegistered(context),
        "number" to NetDevice.number(context).ifEmpty { null },
        "numberVerified" to NetDevice.isNumberVerified(context),
        "verificationNeeded" to NetDevice.numberVerificationNeeded(context),
        "linked" to NetDevice.isLinked(context),
    )

    private fun sampleMap(s: Sample): Map<String, Any?> = mapOf(
        "timestamp" to s.timestampMs,
        "lat" to s.lat,
        "lon" to s.lon,
        "accuracyM" to s.gpsAccuracyM?.toDouble(),
        "networkType" to s.networkType,
        "band" to RadioBand.label(s.networkType, s.band, if (s.networkType == "GSM") s.bcch ?: s.arfcn else s.arfcn),
        "levelDbm" to ProblemHints.level(s),
        "rsrpDbm" to s.rsrpDbm,
        "rsrqDb" to s.rsrqDb,
        "sinrDb" to s.sinrDb,
        "rssiDbm" to s.rssiDbm,
        "rscpDbm" to s.rscpDbm,
        "ecioDb" to s.ecioDb,
        "rxQual" to s.rxQual,
        "cqi" to s.cqi,
        "cellId" to s.cellId,
        "pci" to s.pci,
        "tac" to s.tac,
        "mcc" to s.mcc,
        "mnc" to s.mnc,
        "arfcn" to s.arfcn,
    )

    private fun cellMap(c: CellReading): Map<String, Any?> = mapOf(
        "networkType" to c.networkType,
        "serving" to c.isServing,
        "band" to RadioBand.label(c.networkType, c.band, if (c.networkType == "GSM") c.bcch else c.earfcn),
        "cellId" to c.cellId,
        "pci" to c.pci,
        "tac" to c.tac,
        "channel" to (c.earfcn ?: c.bcch),
        "scramblingCode" to c.scramblingCode,
        "bsic" to c.bsic,
        "rsrpDbm" to c.rsrpDbm,
        "rsrqDb" to c.rsrqDb,
        "sinrDb" to c.sinrDb,
        "rssiDbm" to c.rssiDbm,
        "rscpDbm" to c.rscpDbm,
        "ecioDb" to c.ecioDb,
        "cqi" to c.cqi,
        "mcc" to c.mcc,
        "mnc" to c.mnc,
    )

    private fun speedMap(r: SpeedTest.Result): Map<String, Any?> = mapOf(
        "downloadMbps" to r.downloadMbps,
        "uploadMbps" to r.uploadMbps,
        "pingMs" to r.pingMedianMs,
        "jitterMs" to r.jitterMs,
        "packetLossPct" to r.packetLossPct,
        "bearer" to r.bearer.ifEmpty { null },
        "error" to r.error,
    )

    companion object {
        const val CHANNEL = "np.nepaltelecom/ntc_telemetry"
        const val SDK_VERSION = "1.1.0"

        /** Calls answered on every Android version; all others need Android 8.0. */
        private val ALWAYS_AVAILABLE = setOf("init", "capabilities", "missingPermissions", "registration")
    }
}
