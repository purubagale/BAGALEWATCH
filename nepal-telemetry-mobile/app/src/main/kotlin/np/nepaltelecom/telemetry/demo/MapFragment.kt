package np.nepaltelecom.telemetry.demo

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
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
import org.osmdroid.views.overlay.Polyline
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

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        // OpenStreetMap asks apps to identify themselves in the tile request.
        Configuration.getInstance().userAgentValue = requireContext().packageName

        map = view.findViewById(R.id.mapView)
        map.setTileSource(TileSourceFactory.MAPNIK)
        map.setMultiTouchControls(true)
        map.controller.setZoom(16.0)
        map.controller.setCenter(GeoPoint(KATHMANDU_LAT, KATHMANDU_LNG))

        statusText = view.findViewById(R.id.mapStatus)
        deleteButton = view.findViewById(R.id.mapDeleteDrive)

        startButton = view.findViewById(R.id.mapDriveStart)
        stopButton = view.findViewById(R.id.mapDriveStop)
        startButton.setOnClickListener { startDrive() }
        stopButton.setOnClickListener {
            NetTelemetry.stopDriveTest(requireContext())
            driveRunning = false
            paintDriveButtons()
            toast("Drive test stopped")
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
        view.findViewById<Button>(R.id.mapLive).setOnClickListener { showLive() }
        deleteButton.setOnClickListener { confirmDeleteViewed() }
    }

    override fun onResume() {
        super.onResume()
        map.onResume()
        handler.post(redraw)
    }

    override fun onPause() {
        handler.removeCallbacks(redraw)
        map.onPause()
        super.onPause()
    }

    private lateinit var startButton: Button
    private lateinit var stopButton: Button

    /** Start is green and Stop red while a drive runs. Both go back to their defaults when it stops. */
    private fun paintDriveButtons() {
        ButtonFeedback.paint(startButton, if (driveRunning) ButtonFeedback.GREEN else null)
        ButtonFeedback.paint(stopButton, if (driveRunning) ButtonFeedback.RED else null)
    }

    private fun startDrive() {
        val granted = ContextCompat.checkSelfPermission(
            requireContext(), Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            toast("Opt in first, so location permission is granted")
            return
        }
        showLive()
        NetTelemetry.startDriveTest(requireContext())
        driveRunning = true
        paintDriveButtons()
        toast("Drive test started")
    }

    private fun showLive() {
        viewingId = null
        centred = false
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
        val points: List<RouteTrail.Point> =
            if (saved != null) NetTelemetry.driveSessionPoints(saved) else NetTelemetry.routeTrail()

        map.overlays.clear()
        if (points.isEmpty()) {
            statusText.text = getString(if (saved == null) R.string.map_no_trail else R.string.map_saved_empty)
            map.invalidate()
            return
        }

        val geo = points.map { GeoPoint(it.lat, it.lng) }
        val line = Polyline(map).apply {
            setPoints(geo)
            outlinePaint.color = ContextCompat.getColor(requireContext(), R.color.brand_accent)
            outlinePaint.strokeWidth = resources.displayMetrics.density * 5f
        }
        map.overlays.add(line)

        val latest = geo.last()
        val marker = Marker(map).apply {
            position = latest
            setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_BOTTOM)
            title = if (saved == null) "Latest fix" else "Last fix"
        }
        map.overlays.add(marker)

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
        private val dateFormat = SimpleDateFormat("d MMM HH:mm", Locale.getDefault())

        /** Kept for the whole app session, so the buttons keep their colours when the tab is re-entered. */
        private var driveRunning = false
    }
}
