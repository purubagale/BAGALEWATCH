package np.nepaltelecom.telemetry.demo

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.hardware.GeomagneticField
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.util.Base64
import android.view.Surface
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.model.Sample
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Site photo (2026-10-11). The engineer stands at a site, points the phone
 * along a sector and takes a photo. The photo goes to DT-WATCH with the
 * compass bearing, position, altitude and the signal reading at that moment,
 * so the sector's real direction can be compared with its planned azimuth.
 *
 * The screen is locked to portrait: the bearing is the direction the back
 * camera faces while the phone is held upright. A phone compass is usually
 * within 5 to 15 degrees and worse beside steel, so the bearing is a check
 * for a wrong sector, not a measurement for alignment.
 *
 * The server accepts a photo only from a registered phone that is within
 * 1 km of the site, and shows it only after an admin approves it. A photo
 * taken while a drive test is running is also tied to that drive, and then
 * needs no site: it marks a spot on the route (2026-10-12). A photo
 * that can't be sent is kept in this app's private storage and sent the next
 * time the screen opens.
 */
class SitePhotoActivity : AppCompatActivity(), SensorEventListener, LocationListener {

    private lateinit var preview: PreviewView
    private lateinit var bearingText: TextView
    private lateinit var overlayText: TextView
    private lateinit var statusText: TextView
    private lateinit var siteSpinner: Spinner
    private lateinit var directionSpinner: Spinner
    private lateinit var noteInput: EditText
    private lateinit var takeButton: Button

    private var imageCapture: ImageCapture? = null
    private var sensorManager: SensorManager? = null
    private var locationManager: LocationManager? = null

    private var location: Location? = null
    private var sitesFetchedAt: Location? = null
    private var sites: List<TraceApi.NearbySite> = emptyList()

    /** Smoothed bearing kept as a unit vector, so 359 and 1 average to 0, not 180. */
    private var bearingSin = 0.0
    private var bearingCos = 0.0
    private var hasBearing = false
    private var busy = false
    private var retryAfterMs = 0L

    private val cameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startCamera() else statusText.setText(R.string.site_photo_need_camera)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_site_photo)

        preview = findViewById(R.id.sitePhotoPreview)
        bearingText = findViewById(R.id.sitePhotoBearing)
        overlayText = findViewById(R.id.sitePhotoOverlay)
        statusText = findViewById(R.id.sitePhotoStatus)
        siteSpinner = findViewById(R.id.sitePhotoSite)
        directionSpinner = findViewById(R.id.sitePhotoDirection)
        noteInput = findViewById(R.id.sitePhotoNote)
        takeButton = findViewById(R.id.sitePhotoTake)

        findViewById<Button>(R.id.sitePhotoClose).setOnClickListener { finish() }
        takeButton.setOnClickListener { takePhoto() }
        siteSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) =
                fillDirections()

            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }

        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        statusText.setText(R.string.site_photo_hold_upright)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
        sendQueued()
    }

    @SuppressLint("MissingPermission")
    override fun onResume() {
        super.onResume()
        sensorManager?.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)?.let {
            sensorManager?.registerListener(this, it, SensorManager.SENSOR_DELAY_UI)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            statusText.setText(R.string.site_photo_need_location)
            return
        }
        val manager = locationManager ?: return
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            runCatching {
                if (manager.isProviderEnabled(provider)) {
                    manager.requestLocationUpdates(provider, 1000L, 0f, this)
                    manager.getLastKnownLocation(provider)?.let { last ->
                        if (System.currentTimeMillis() - last.time < 60_000) onLocationChanged(last)
                    }
                }
            }
        }
    }

    override fun onPause() {
        super.onPause()
        sensorManager?.unregisterListener(this)
        runCatching { locationManager?.removeUpdates(this) }
    }

    // ---- Camera ---------------------------------------------------------

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = runCatching { future.get() }.getOrNull() ?: return@addListener
            val previewUseCase = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
            val capture = ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .setTargetRotation(Surface.ROTATION_0)
                .build()
            runCatching {
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, previewUseCase, capture)
                imageCapture = capture
                refreshTakeButton()
            }.onFailure { statusText.text = friendlyErrorMessage(it) }
        }, ContextCompat.getMainExecutor(this))
    }

    // ---- Compass --------------------------------------------------------

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_ROTATION_VECTOR) return
        val rotation = FloatArray(9)
        val remapped = FloatArray(9)
        val orientation = FloatArray(3)
        SensorManager.getRotationMatrixFromVector(rotation, event.values)
        // Upright portrait: the back camera looks along the device's -Z axis,
        // so the heading is read with Z mapped to the vertical.
        SensorManager.remapCoordinateSystem(rotation, SensorManager.AXIS_X, SensorManager.AXIS_Z, remapped)
        SensorManager.getOrientation(remapped, orientation)
        var degrees = Math.toDegrees(orientation[0].toDouble())
        // The sensor gives magnetic north; the planned azimuths are true north.
        location?.let {
            degrees += GeomagneticField(
                it.latitude.toFloat(), it.longitude.toFloat(), it.altitude.toFloat(), System.currentTimeMillis(),
            ).declination
        }
        val radians = Math.toRadians(degrees)
        if (!hasBearing) {
            bearingSin = sin(radians)
            bearingCos = cos(radians)
            hasBearing = true
        } else {
            bearingSin += SMOOTHING * (sin(radians) - bearingSin)
            bearingCos += SMOOTHING * (cos(radians) - bearingCos)
        }
        showReadings()
        refreshTakeButton()
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private fun bearing(): Double? {
        if (!hasBearing) return null
        return (Math.toDegrees(atan2(bearingSin, bearingCos)) + 360.0) % 360.0
    }

    // ---- Location and nearby sites -------------------------------------

    override fun onLocationChanged(fix: Location) {
        val current = location
        // Keep the better of the two providers: a network fix does not replace a recent GPS one.
        if (current != null && fix.provider != LocationManager.GPS_PROVIDER &&
            current.provider == LocationManager.GPS_PROVIDER && fix.time - current.time < 10_000
        ) return
        location = fix
        showReadings()
        refreshTakeButton()
        val fetched = sitesFetchedAt
        // After a failed lookup, wait before trying again. Without the wait a new
        // fix arrives every second, the lookup repeats, and its "looking" text
        // hides the error from the user.
        val waiting = System.currentTimeMillis() < retryAfterMs
        if (!waiting && (fetched == null || fetched.distanceTo(fix) > REFETCH_DISTANCE_M)) fetchSites(fix)
    }

    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

    override fun onProviderEnabled(provider: String) = Unit

    override fun onProviderDisabled(provider: String) = Unit

    private fun fetchSites(at: Location) {
        sitesFetchedAt = at
        if (sites.isEmpty()) statusText.setText(R.string.site_photo_finding_sites)
        Thread {
            val result = runCatching { TraceApi.nearbySites(at.latitude, at.longitude) }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                result.onSuccess { found ->
                    val keep = selectedSite()?.id
                    sites = found
                    siteSpinner.adapter = adapter(found.map { "${it.id}  ${it.name}  (${it.distanceM} m)" })
                    found.indexOfFirst { it.id == keep }.takeIf { it >= 0 }?.let { siteSpinner.setSelection(it) }
                    fillDirections()
                    statusText.text = getString(
                        when {
                            found.isNotEmpty() -> R.string.site_photo_hold_upright
                            NetTelemetry.currentDriveSessionId() != null -> R.string.site_photo_drive_only
                            else -> R.string.site_photo_no_sites
                        }
                    )
                    refreshTakeButton()
                }.onFailure {
                    sitesFetchedAt = null
                    retryAfterMs = System.currentTimeMillis() + RETRY_WAIT_MS
                    statusText.text = messageFor(it)
                }
            }
        }.start()
    }

    private fun selectedSite(): TraceApi.NearbySite? = sites.getOrNull(siteSpinner.selectedItemPosition)

    private fun fillDirections() {
        val site = selectedSite()
        val labels = mutableListOf(getString(R.string.site_photo_direction_auto))
        site?.directions?.forEach { labels.add("${it.azimuth.roundToInt()}°  ${it.sectors}") }
        directionSpinner.adapter = adapter(labels)
    }

    /** The direction chosen in the list, or the planned one nearest to [bearing] when left on automatic. */
    private fun chosenDirection(bearing: Double): TraceApi.SiteDirection? {
        val directions = selectedSite()?.directions.orEmpty()
        val picked = directionSpinner.selectedItemPosition
        if (picked > 0) return directions.getOrNull(picked - 1)
        return directions.minByOrNull { angleBetween(bearing, it.azimuth) }
    }

    private fun adapter(items: List<String>): ArrayAdapter<String> =
        ArrayAdapter(this, android.R.layout.simple_spinner_item, items).apply {
            setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        }

    // ---- On-screen readings --------------------------------------------

    private fun showReadings() {
        val heading = bearing()
        bearingText.text =
            if (heading == null) getString(R.string.site_photo_no_compass)
            else "${heading.roundToInt() % 360}° ${compassPoint(heading)}"
        overlayText.text = readingLines(heading, Date()).joinToString("\n")
    }

    private fun readingLines(heading: Double?, time: Date): List<String> {
        val fix = location ?: return listOf(getString(R.string.site_photo_waiting_location))
        val lines = mutableListOf<String>()
        selectedSite()?.let { site ->
            var line = site.id
            if (heading != null) {
                chosenDirection(heading)?.let { dir ->
                    line += "  planned ${dir.azimuth.roundToInt()}° (${dir.sectors})" +
                        "  difference ${angleBetween(heading, dir.azimuth).roundToInt()}°"
                }
            }
            lines.add(line)
        }
        lines.add(
            String.format(Locale.US, "%.6f N  %.6f E  ±%d m", fix.latitude, fix.longitude, fix.accuracy.roundToInt())
        )
        val altitude = if (fix.hasAltitude()) "altitude ${fix.altitude.roundToInt()} m   " else ""
        lines.add(altitude + SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(time))
        return lines
    }

    private fun refreshTakeButton() {
        // A site is needed unless a drive test is running, which the photo can belong to instead.
        val hasTarget = selectedSite() != null || NetTelemetry.currentDriveSessionId() != null
        takeButton.isEnabled = !busy && imageCapture != null && hasBearing && location != null && hasTarget
    }

    // ---- Taking and sending --------------------------------------------

    private fun takePhoto() {
        val capture = imageCapture ?: return
        val heading = bearing() ?: return
        val fix = location ?: return
        val site = selectedSite()
        val driveSessionId = NetTelemetry.currentDriveSessionId()
        if (site == null && driveSessionId == null) return
        val direction = chosenDirection(heading)
        val note = noteInput.text.toString().trim()
        val takenAt = Date()
        val stamp = listOf("${heading.roundToInt() % 360}° ${compassPoint(heading)}") + readingLines(heading, takenAt)

        busy = true
        refreshTakeButton()
        statusText.setText(R.string.site_photo_sending)
        capture.takePicture(
            ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageCapturedCallback() {
                override fun onCaptureSuccess(image: ImageProxy) {
                    val jpeg = runCatching { toStampedJpeg(image, stamp) }.getOrNull()
                    image.close()
                    if (jpeg == null) {
                        finishSend(getString(R.string.site_photo_failed))
                        return
                    }
                    NetTelemetry.readLiveSample { sample ->
                        send(buildBody(site, driveSessionId, direction, heading, fix, takenAt, note, jpeg, sample))
                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    finishSend(getString(R.string.site_photo_failed))
                }
            },
        )
    }

    private fun buildBody(
        site: TraceApi.NearbySite?,
        driveSessionId: String?,
        direction: TraceApi.SiteDirection?,
        heading: Double,
        fix: Location,
        takenAt: Date,
        note: String,
        jpeg: ByteArray,
        sample: Sample?,
    ): String {
        val signal = JSONObject()
        sample?.let {
            signal.put("network_type", it.networkType)
            it.rsrpDbm?.let { v -> signal.put("rsrp", v) }
            it.rsrqDb?.let { v -> signal.put("rsrq", v) }
            it.sinrDb?.let { v -> signal.put("sinr", v) }
            it.pci?.let { v -> signal.put("pci", v) }
            it.cqi?.let { v -> signal.put("cqi", v) }
            it.cellId?.let { v -> signal.put("cell_id", v.toString()) }
        }
        val body = JSONObject()
            .put("bearing_deg", (heading * 10).roundToInt() / 10.0)
            .put("lat", fix.latitude)
            .put("lon", fix.longitude)
            .put("accuracy_m", fix.accuracy.toDouble())
            .put("taken_at", takenAt.time)
            .put("signal", signal)
            .put("note", note)
            .put("image_b64", Base64.encodeToString(jpeg, Base64.NO_WRAP))
        site?.let { body.put("site_id", it.id) }
        driveSessionId?.let { body.put("drive_session_id", it) }
        if (fix.hasAltitude()) body.put("altitude_m", fix.altitude)
        direction?.let {
            body.put("planned_azimuth", it.azimuth)
            body.put("sector_label", it.sectors)
        }
        return body.toString()
    }

    /** Sends on a background thread. A photo that can't reach the server is kept for later. */
    private fun send(body: String) {
        Thread {
            val result = runCatching { TraceApi.uploadSitePhoto(body) }
            val message = result.fold(
                onSuccess = { getString(R.string.site_photo_sent) },
                onFailure = { error ->
                    // A reply from the server is final. Only a photo the server never saw is kept.
                    if (error is TraceApi.ApiException) {
                        messageFor(error)
                    } else {
                        runCatching { File(queueDir(), "${System.currentTimeMillis()}.json").writeText(body) }
                        getString(R.string.site_photo_saved_for_later)
                    }
                },
            )
            runOnUiThread {
                if (result.isSuccess) noteInput.setText("")
                finishSend(message)
            }
        }.start()
    }

    private fun finishSend(message: String) {
        if (isFinishing || isDestroyed) return
        busy = false
        statusText.text = message
        refreshTakeButton()
    }

    /** Sends the photos an earlier visit could not. A photo the server refuses is dropped, not retried forever. */
    private fun sendQueued() {
        val files = queueDir().listFiles()?.sortedBy { it.name }.orEmpty()
        if (files.isEmpty()) return
        Thread {
            var sent = 0
            for (file in files) {
                val outcome = runCatching { TraceApi.uploadSitePhoto(file.readText()) }
                if (outcome.isSuccess) sent++
                if (outcome.isSuccess || outcome.exceptionOrNull() is TraceApi.ApiException) file.delete() else break
            }
            if (sent > 0) runOnUiThread {
                if (!isFinishing && !isDestroyed) statusText.text = getString(R.string.site_photo_queue_sent, sent)
            }
        }.start()
    }

    private fun queueDir(): File = File(filesDir, "site_photo_queue").apply { mkdirs() }

    private fun messageFor(error: Throwable): String {
        val code = (error as? TraceApi.ApiException)?.code
        return if (code == 401 || code == 403) getString(R.string.site_photo_need_registration)
        else friendlyErrorMessage(error)
    }

    /**
     * Turns the camera frame upright, shrinks it to [MAX_SIDE_PX] and writes
     * the readings along the bottom, so the picture still carries them when
     * it is saved or shared outside DT-WATCH.
     */
    private fun toStampedJpeg(image: ImageProxy, lines: List<String>): ByteArray {
        val buffer = image.planes[0].buffer
        val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_SIDE_PX) sample *= 2
        val decoded = BitmapFactory.decodeByteArray(
            bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample },
        )
        val scale = minOf(1f, MAX_SIDE_PX.toFloat() / maxOf(decoded.width, decoded.height))
        val matrix = Matrix().apply {
            postRotate(image.imageInfo.rotationDegrees.toFloat())
            postScale(scale, scale)
        }
        val upright = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
            .copy(Bitmap.Config.ARGB_8888, true)

        val canvas = Canvas(upright)
        val textSize = upright.width / 34f
        val pad = textSize * 0.6f
        val lineHeight = textSize * 1.35f
        val boxTop = upright.height - (lines.size * lineHeight + pad * 2)
        canvas.drawRect(
            0f, boxTop, upright.width.toFloat(), upright.height.toFloat(), Paint().apply { color = 0x99000000.toInt() },
        )
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            this.textSize = textSize
        }
        lines.forEachIndexed { i, line ->
            canvas.drawText(line, pad, boxTop + pad + textSize + i * lineHeight, paint)
        }
        return ByteArrayOutputStream().also { upright.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, it) }
            .toByteArray()
    }

    companion object {
        private const val SMOOTHING = 0.15
        private const val REFETCH_DISTANCE_M = 100f
        private const val RETRY_WAIT_MS = 30_000L
        private const val MAX_SIDE_PX = 1600
        private const val JPEG_QUALITY = 85
        private val POINTS = arrayOf("N", "NE", "E", "SE", "S", "SW", "W", "NW")

        fun compassPoint(degrees: Double): String = POINTS[((degrees % 360 + 360) % 360 / 45).roundToInt() % 8]

        /** Smallest angle between two compass directions, 0 to 180. */
        fun angleBetween(a: Double, b: Double): Double {
            val diff = abs(a - b) % 360
            return minOf(diff, 360 - diff)
        }
    }
}
