package np.nepaltelecom.telemetry.demo

import android.Manifest
import android.content.Intent
import android.provider.Settings
import androidx.activity.result.contract.ActivityResultContracts
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import np.nepaltelecom.telemetry.NetTelemetry
import np.nepaltelecom.telemetry.collector.RouteTrail
import np.nepaltelecom.telemetry.model.DriveSession
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Marker
import org.osmdroid.views.overlay.OverlayWithIW
import org.osmdroid.views.overlay.infowindow.BasicInfoWindow
import org.osmdroid.views.overlay.infowindow.InfoWindow
import org.osmdroid.views.overlay.Polyline
import org.osmdroid.views.overlay.mylocation.GpsMyLocationProvider
import org.osmdroid.views.overlay.mylocation.MyLocationNewOverlay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The drive route on a map. It shows the live drive by default. "Past drives"
 * opens a saved drive from this phone, and "Live" returns to the current one.
 * Saved drives come from NetTelemetry's on-phone history and need no network.
 * Tower locations are not shown: the phone has no source for them.
 */
class MapFragment : Fragment(R.layout.fragment_map) {

    private val handler = Handler(Looper.getMainLooper())
    private val redraw = object : Runnable {
        override fun run() {
            drawRoute()
            handler.postDelayed(this, REDRAW_MS)
        }
    }

    private lateinit var map: MapView
    private lateinit var statusText: TextView
    private lateinit var deleteButton: Button
    private var centred = false

    /** Id of the saved drive on screen, or null for the live drive. */
    private var viewingId: String? = null

    /**
     * The route point whose popup is open, or null (2026-10-12). Only one popup
     * is open at a time. The route is redrawn every two seconds while a drive
     * runs, which replaces the line and the marker, so the popup is closed and
     * put back on each redraw from this.
     */
    private var popupPoint: RouteTrail.Point? = null

    /** True while the app itself closes popups, so that is not taken for the user closing one. */
    private var closingPopups = false

    private fun closePopups() {
        closingPopups = true
        InfoWindow.closeAllInfoWindowsOn(map)
        closingPopups = false
    }

    private fun popupWindow() = SignalInfoWindow(map) { if (!closingPopups) popupPoint = null }

    /** The phone's own position on the map (2026-10-12). Null until location is allowed. */
    private var myLocation: MyLocationNewOverlay? = null
    private var askedForLocation = false

    private val locationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) showMyLocation()
        }

    /** Asked from Start. Granted: carry on with the drive. Refused: a drive cannot be recorded. */
    private val drivePermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                showMyLocation()
                startDrive()
            } else {
                toast(getString(R.string.map_drive_needs_location))
            }
        }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        // OpenStreetMap asks apps to identify themselves in the tile request.
        Configuration.getInstance().userAgentValue = requireContext().packageName

        map = view.findViewById(R.id.mapView)
        map.setTileSource(TileSourceFactory.MAPNIK)
        map.setMultiTouchControls(true)
        map.controller.setZoom(16.0)
        map.controller.setCenter(GeoPoint(KATHMANDU_LAT, KATHMANDU_LNG))
        askForLocationOnce()

        statusText = view.findViewById(R.id.mapStatus)
        view.findViewById<TextView>(R.id.mapLegend).text = RouteColor.legend()
        deleteButton = view.findViewById(R.id.mapDeleteDrive)

        startButton = view.findViewById(R.id.mapDriveStart)
        stopButton = view.findViewById(R.id.mapDriveStop)
        startButton.setOnClickListener { startDrive() }
        stopButton.setOnClickListener {
            NetTelemetry.stopDriveTest(requireContext())
            val wasRunning = driveRunning
            driveRunning = false
            paintDriveButtons()
            toast(getString(
                when {
                    !wasRunning -> R.string.map_drive_stopped
                    driveShared -> R.string.map_drive_stopped_shared
                    else -> R.string.map_drive_stopped_local
                }
            ))
        }
        // Lets an employee who ticked "remember" be asked again.
        startButton.setOnLongClickListener {
            if (StaffMode.rememberedDriveShare(requireContext()) != null) {
                StaffMode.setRememberedDriveShare(requireContext(), null)
                toast(getString(R.string.map_share_forgotten))
            }
            true
        }
        paintDriveButtons()
        view.findViewById<Button>(R.id.mapDriveUpload).setOnClickListener {
            NetTelemetry.uploadNow()
            toast("Upload requested. Check Logcat for the result")
        }
        view.findViewById<Button>(R.id.mapClearRoute).setOnClickListener {
            NetTelemetry.clearRouteTrail()
            centred = false
            drawRoute()
        }
        view.findViewById<Button>(R.id.mapPastDrives).setOnClickListener { showPastDrives() }
        view.findViewById<Button>(R.id.mapSitePhoto).setOnClickListener {
            startActivity(Intent(requireContext(), SitePhotoActivity::class.java))
        }
        view.findViewById<Button>(R.id.mapLive).setOnClickListener { showLive() }
        deleteButton.setOnClickListener { confirmDeleteViewed() }
    }

    override fun onResume() {
        super.onResume()
        map.onResume()
        // Also picks up location that was switched on in system settings meanwhile.
        showMyLocation()
        handler.post(redraw)
    }

    override fun onPause() {
        handler.removeCallbacks(redraw)
        myLocation?.disableMyLocation()
        map.onPause()
        super.onPause()
    }

    /**
     * Asks once per visit for what the map needs to show the phone's position:
     * the location permission, then location switched on. A "no" to either is
     * accepted: the map then works without a position.
     */
    private fun askForLocationOnce() {
        if (askedForLocation) return
        askedForLocation = true
        val problems = PhoneChecks.problems(requireContext())
        when {
            PhoneChecks.Problem.PERMISSION_MISSING in problems ->
                locationPermission.launch(Manifest.permission.ACCESS_FINE_LOCATION)
            PhoneChecks.Problem.LOCATION_SERVICES_OFF in problems ->
                AlertDialog.Builder(requireContext())
                    .setTitle(R.string.map_location_off_title)
                    .setMessage(R.string.map_location_off_message)
                    .setPositiveButton(R.string.map_location_off_open) { _, _ ->
                        runCatching { startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)) }
                    }
                    .setNegativeButton(R.string.map_location_off_skip, null)
                    .show()
        }
    }

    /** Draws the phone's position and centres the map on the first fix. Does nothing without permission. */
    private fun showMyLocation() {
        val granted = ContextCompat.checkSelfPermission(
            requireContext(), Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) return
        val overlay = myLocation ?: MyLocationNewOverlay(GpsMyLocationProvider(requireContext()), map).also {
            myLocation = it
            it.runOnFirstFix {
                val here = it.myLocation ?: return@runOnFirstFix
                // A route on screen has already been centred on; do not pull the map away from it.
                handler.post { if (isAdded && !centred) map.controller.animateTo(here) }
            }
        }
        overlay.enableMyLocation()
        if (overlay !in map.overlays) map.overlays.add(overlay)
        map.invalidate()
    }

    private lateinit var startButton: Button
    private lateinit var stopButton: Button

    /** Start is green and Stop red while a drive runs. Both go back to their defaults when it stops. */
    private fun paintDriveButtons() {
        ButtonFeedback.paint(startButton, if (driveRunning) ButtonFeedback.GREEN else null)
        ButtonFeedback.paint(stopButton, if (driveRunning) ButtonFeedback.RED else null)
    }

    /**
     * Start (2026-10-12). A drive needs the location permission, so that is
     * asked for first. Then the user says whether this drive goes to NTC or
     * stays on the phone. Everyone is asked each time; an NTC employee may tick
     * "remember my answer" and is then not asked again.
     */
    private fun startDrive() {
        if (driveRunning) return
        val granted = ContextCompat.checkSelfPermission(
            requireContext(), Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            drivePermission.launch(Manifest.permission.ACCESS_FINE_LOCATION)
            return
        }
        val remembered = StaffMode.rememberedDriveShare(requireContext())
        if (remembered != null) {
            beginDrive(remembered)
            return
        }
        val employee = StaffMode.isEmployee(requireContext())
        val remember = CheckBox(requireContext()).apply {
            setText(R.string.map_share_remember)
            visibility = if (employee) View.VISIBLE else View.GONE
        }
        val pad = (resources.displayMetrics.density * 20).toInt()
        val holder = FrameLayout(requireContext()).apply {
            setPadding(pad, 0, pad, 0)
            addView(remember)
        }
        fun answer(share: Boolean) {
            if (employee && remember.isChecked) StaffMode.setRememberedDriveShare(requireContext(), share)
            beginDrive(share)
        }
        AlertDialog.Builder(requireContext())
            .setTitle(R.string.map_share_title)
            .setMessage(R.string.map_share_message)
            .setView(holder)
            .setPositiveButton(R.string.map_share_yes) { _, _ -> answer(true) }
            .setNegativeButton(R.string.map_share_no) { _, _ -> answer(false) }
            .setNeutralButton(R.string.map_share_cancel, null)
            .show()
    }

    private fun beginDrive(share: Boolean) {
        showLive()
        NetTelemetry.startDriveTest(requireContext(), share)
        driveRunning = true
        driveShared = share
        paintDriveButtons()
        toast(getString(if (share) R.string.map_drive_started_shared else R.string.map_drive_started_local))
    }

    private fun showLive() {
        viewingId = null
        centred = false
        popupPoint = null
        drawRoute()
    }

    private fun showPastDrives() {
        val sessions = NetTelemetry.driveSessions()
        if (sessions.isEmpty()) {
            toast(getString(R.string.map_no_past))
            return
        }
        val labels = sessions.map { describe(it) }.toTypedArray()
        AlertDialog.Builder(requireContext())
            .setTitle(R.string.map_past_title)
            .setItems(labels) { _, which ->
                viewingId = sessions[which].id
                centred = false
                drawRoute()
            }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun confirmDeleteViewed() {
        val id = viewingId ?: return
        AlertDialog.Builder(requireContext())
            .setTitle(R.string.map_delete_title)
            .setMessage(R.string.map_delete_message)
            .setPositiveButton("Delete") { _, _ ->
                NetTelemetry.deleteDriveSession(id)
                toast(getString(R.string.map_deleted))
                showLive()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun drawRoute() {
        val saved = viewingId
        deleteButton.visibility = if (saved == null) View.GONE else View.VISIBLE
        val rawPoints: List<RouteTrail.Point> =
            if (saved != null) NetTelemetry.driveSessionPoints(saved) else NetTelemetry.routeTrail()
        // Drop fixes whose own reported accuracy is too loose to place
        // reliably on a road (2026-10-07, "plot is not good and accurate")
        // -- a single bad fix mid-drive otherwise draws a visible kink/jump
        // in the line. Same threshold and "keep an unknown (<=0) reading
        // rather than guess it's bad" reasoning as the backend's own route
        // endpoint (core/telemetry_admin.py's ROUTE_MAX_ACCURACY_M).
        val points = rawPoints.filter { it.accuracyM <= 0f || it.accuracyM <= ROUTE_MAX_ACCURACY_M }

        // The overlays below are replaced, so close the popups that belong to the old ones.
        closePopups()
        map.overlays.clear()
        // The position marker is an overlay too; put it back after the clear.
        myLocation?.let { map.overlays.add(it) }
        if (points.isEmpty()) {
            statusText.text = getString(if (saved == null) R.string.map_no_trail else R.string.map_saved_empty)
            map.invalidate()
            return
        }

        val geo = points.map { GeoPoint(it.lat, it.lng) }
        val density = resources.displayMetrics.density
        // The whole route as one dark line underneath. It carries the popup, and
        // gives the coloured pieces drawn over it an edge on a light map.
        val line = Polyline(map).apply {
            setPoints(geo)
            outlinePaint.color = 0xFF0B1626.toInt()
            outlinePaint.strokeWidth = density * 8f
            infoWindow = popupWindow()
        }
        // Tapping the route shows the signal read at the nearest fix (2026-10-12).
        val onTap = Polyline.OnClickListener { _, _, where ->
            val nearest = points.minByOrNull { RfMath.distanceM(it.lat, it.lng, where.latitude, where.longitude) }
            if (nearest != null) {
                closePopups()
                popupPoint = nearest
                describe(line, nearest)
                line.infoWindowLocation = GeoPoint(nearest.lat, nearest.lng)
                line.showInfoWindow()
            }
            true
        }
        line.setOnClickListener(onTap)
        map.overlays.add(line)

        // The route coloured by signal level, on the same scale as the DT-WATCH
        // plots (2026-10-12). Each stretch takes the colour of the reading at its
        // end; a run of the same colour is one line, so a long drive stays light.
        var runStart = 0
        for (i in 1..points.size) {
            val ended = i == points.size || RouteColor.of(points[i].signal) != RouteColor.of(points[runStart + 1].signal)
            if (i > runStart + 1 && ended || i == points.size && i > runStart) {
                val run = geo.subList(runStart, i)
                if (run.size >= 2) {
                    map.overlays.add(Polyline(map).apply {
                        setPoints(run)
                        outlinePaint.color = RouteColor.of(points[runStart + 1].signal)
                        outlinePaint.strokeWidth = density * 5f
                        // No popup of its own: a tap goes to the one on the base line.
                        infoWindow = null
                        setOnClickListener(onTap)
                    })
                }
                runStart = i - 1
            }
        }

        val latest = geo.last()
        val marker = Marker(map).apply {
            position = latest
            setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_BOTTOM)
            describe(this, points.last())
            infoWindow = popupWindow()
            // Same popup as the line, at the last point, so the two never show together.
            setOnMarkerClickListener { _, _ ->
                closePopups()
                popupPoint = points.last()
                describe(line, points.last())
                line.infoWindowLocation = latest
                line.showInfoWindow()
                true
            }
        }
        map.overlays.add(marker)

        // Put the open popup back on the new line, at the same point.
        popupPoint?.let { open ->
            val still = points.firstOrNull { it.timeMs == open.timeMs }
            if (still == null) {
                popupPoint = null
            } else {
                describe(line, still)
                line.infoWindowLocation = GeoPoint(still.lat, still.lng)
                line.showInfoWindow()
            }
        }

        // Centre once per route, so panning isn't undone on every redraw.
        if (!centred) {
            map.controller.setCenter(latest)
            centred = true
        }
        map.invalidate()

        val metres = points.zipWithNext { a, b -> RfMath.distanceM(a.lat, a.lng, b.lat, b.lng) }.sum()
        val prefix = if (saved == null) "Live drive" else "Saved drive"
        statusText.text = "$prefix · ${points.size} fixes · ${"%.0f".format(metres)} m · " +
            "last accuracy ${"%.0f".format(points.last().accuracyM)} m"
    }

    private fun describe(s: DriveSession): String {
        val started = dateFormat.format(Date(s.startMs))
        val km = s.distanceM / 1000.0
        return "$started · ${"%.2f".format(km)} km · ${s.fixCount} fixes"
    }

    private fun toast(message: String) {
        Toast.makeText(requireContext(), message, Toast.LENGTH_SHORT).show()
    }

    companion object {
        private const val REDRAW_MS = 2_000L
        private const val KATHMANDU_LAT = 27.7172
        private const val KATHMANDU_LNG = 85.3240
        // Matches core/telemetry_admin.py's own ROUTE_MAX_ACCURACY_M -- see
        // that constant's comment for why 50 m is the cutoff.
        private const val ROUTE_MAX_ACCURACY_M = 50f
        private val dateFormat = SimpleDateFormat("d MMM HH:mm", Locale.getDefault())

        /** Kept for the whole app session, so the buttons keep their colours when the tab is re-entered. */
        private var driveRunning = false

        /** Whether the drive now running is being sent to NTC. */
        private var driveShared = true
    }
}

/**
 * A marker info window that is always legible, independent of the app's own
 * theme (see map_marker_bubble.xml's own comment for the bug this fixes).
 * Shows just the marker's title -- that's all drawRoute() ever sets.
 */
/**
 * Route colours by signal level (2026-10-12), the same cut-offs and colours
 * as the DT-WATCH web plots: RSRP for 4G and 5G, RSCP for 3G on the same
 * scale, and the separate RxLevel scale for 2G.
 */
private object RouteColor {
    private const val POOR = 0xFFDC2626.toInt()
    private const val MODERATE = 0xFFF97316.toInt()
    private const val FAIR = 0xFFEAB308.toInt()
    private const val GOOD = 0xFF84CC16.toInt()
    private const val EXCELLENT = 0xFF16A34A.toInt()
    private const val NO_DATA = 0xFF94A3B8.toInt()

    private fun band(dbm: Int, fair: Int, good: Int, excellent: Int): Int = when {
        dbm >= excellent -> EXCELLENT
        dbm >= good -> GOOD
        dbm >= fair -> FAIR
        dbm >= -105 -> MODERATE
        else -> POOR
    }

    fun of(s: RouteTrail.Signal?): Int = when (s?.networkType) {
        "LTE", "NR" -> s.rsrpDbm?.let { band(it, -95, -87, -77) } ?: NO_DATA
        "UMTS" -> s.rscpDbm?.let { band(it, -95, -87, -77) } ?: NO_DATA
        "GSM" -> s.rssiDbm?.let { band(it, -92, -82, -72) } ?: NO_DATA
        else -> NO_DATA
    }

    /** One line naming the colours, for under the map's status text. */
    fun legend(): CharSequence {
        val out = android.text.SpannableStringBuilder()
        for ((color, label) in listOf(
            EXCELLENT to "> -77", GOOD to "-87", FAIR to "-95", MODERATE to "-105", POOR to "lower", NO_DATA to "no reading",
        )) {
            val start = out.length
            out.append("\u25A0 ")
            out.setSpan(android.text.style.ForegroundColorSpan(color), start, start + 1, 0)
            out.append(label).append("   ")
        }
        return out
    }
}

/**
 * Fills a marker's or line's popup with the reading taken at [p]: the
 * technology and its main level as the title, the quality figures and the
 * cell under it, then the time. What is shown follows the technology, since a
 * 2G cell has no RSRP and a 4G one no Rx quality.
 */
private fun describe(target: OverlayWithIW, p: RouteTrail.Point) {
    fun Int?.unit(u: String) = this?.let { "$it $u" } ?: "—"
    val time = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(p.timeMs))
    target.subDescription =
        String.format(Locale.US, "%.5f, %.5f", p.lat, p.lng) + "<br>$time · GPS ±${p.accuracyM.toInt()} m"
    val s = p.signal
    if (s == null) {
        target.title = "No signal reading"
        target.snippet = "This point has a position only."
        return
    }
    when (s.networkType) {
        "LTE", "NR" -> {
            target.title = "${if (s.networkType == "NR") "5G" else "4G"} · RSRP ${s.rsrpDbm.unit("dBm")}"
            target.snippet = "RSRQ ${s.rsrqDb.unit("dB")} · SINR ${s.sinrDb.unit("dB")}" +
                (s.cqi?.let { " · CQI $it" } ?: "") + "<br>PCI ${s.pci ?: "—"}" +
                (s.cellId?.let { " · eNB:sector ${it shr 8}:${it and 0xFFL}" } ?: "")
        }
        "UMTS" -> {
            target.title = "3G · RSCP ${s.rscpDbm.unit("dBm")}"
            target.snippet = "Ec/Io ${s.ecioDb.unit("dB")} · RSSI ${s.rssiDbm.unit("dBm")}" +
                "<br>PSC ${s.scramblingCode ?: "—"}" + (s.cellId?.let { " · Cell $it" } ?: "")
        }
        "GSM" -> {
            target.title = "2G · RSSI ${s.rssiDbm.unit("dBm")}"
            target.snippet = "Rx quality ${s.rxQual ?: "—"}" +
                "<br>BCCH ${s.bcch ?: "—"} · BSIC ${s.bsic ?: "—"}" + (s.cellId?.let { " · Cell $it" } ?: "")
        }
        else -> {
            target.title = "No service"
            target.snippet = "The phone had no serving cell here."
        }
    }
}

/**
 * The map library's standard popup (title, text, small line), with its text
 * forced dark. Its bubble is white and it takes its text colour from the
 * app's theme, which is white for the dark screens, so it showed blank.
 */
private class SignalInfoWindow(mapView: MapView, private val onClosed: () -> Unit) :
    BasicInfoWindow(org.osmdroid.library.R.layout.bonuspack_bubble, mapView) {
    override fun onClose() {
        super.onClose()
        onClosed()
    }

    override fun onOpen(item: Any?) {
        super.onOpen(item)
        for (id in intArrayOf(
            org.osmdroid.library.R.id.bubble_title,
            org.osmdroid.library.R.id.bubble_description,
            org.osmdroid.library.R.id.bubble_subdescription,
        )) {
            (mView.findViewById<View>(id) as? TextView)?.setTextColor(0xFF111827.toInt())
        }
    }
}

private class LegibleInfoWindow(mapView: MapView) : InfoWindow(R.layout.map_marker_bubble, mapView) {
    override fun onOpen(item: Any?) {
        // Markers and route lines both carry a title; show whichever was tapped.
        (mView as? TextView)?.text = (item as? OverlayWithIW)?.title
    }

    override fun onClose() {}
}
