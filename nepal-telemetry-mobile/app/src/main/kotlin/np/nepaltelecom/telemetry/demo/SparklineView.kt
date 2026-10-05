package np.nepaltelecom.telemetry.demo

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat

/**
 * Scrolling history line of recent readings, newest on the right. A filled
 * area sits under the line in the brand accent colour.
 */
class SparklineView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    private val readings = ArrayList<Int>()
    private val accent = ContextCompat.getColor(context, R.color.brand_accent)
    private val linePath = Path()
    private val fillPath = Path()
    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = accent
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
        strokeWidth = resources.displayMetrics.density * 2.5f
    }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val gridPaint = Paint().apply {
        color = Color.argb(45, 255, 255, 255)
        strokeWidth = 1f
    }

    fun add(dbm: Int) {
        if (readings.size >= MAX_POINTS) readings.removeAt(0)
        readings.add(dbm)
        invalidate()
    }

    fun clear() {
        readings.clear()
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()

        for (i in 1..2) {
            val y = h * i / 3f
            canvas.drawLine(0f, y, w, y, gridPaint)
        }
        if (readings.size < 2) return

        // Pad the range by 2 dB each side, with at least 6 dB of spread so a
        // flat run doesn't blow up into noise.
        val low = (readings.minOrNull() ?: return) - 2f
        var high = (readings.maxOrNull() ?: return) + 2f
        if (high - low < 6f) high = low + 6f

        fun xFor(index: Int): Float = w * index / (MAX_POINTS - 1).toFloat()
        fun yFor(dbm: Int): Float = h - (dbm - low) / (high - low) * h

        linePath.reset()
        fillPath.reset()
        readings.forEachIndexed { i, dbm ->
            val px = xFor(i)
            val py = yFor(dbm)
            if (i == 0) {
                linePath.moveTo(px, py)
                fillPath.moveTo(px, h)
                fillPath.lineTo(px, py)
            } else {
                linePath.lineTo(px, py)
                fillPath.lineTo(px, py)
            }
        }
        fillPath.lineTo(xFor(readings.size - 1), h)
        fillPath.close()

        fillPaint.shader = LinearGradient(
            0f, 0f, 0f, h,
            Color.argb(110, Color.red(accent), Color.green(accent), Color.blue(accent)),
            Color.TRANSPARENT,
            Shader.TileMode.CLAMP,
        )
        canvas.drawPath(fillPath, fillPaint)
        canvas.drawPath(linePath, linePaint)
    }

    companion object {
        /** About 3 minutes of readings at the 3-second poll. */
        const val MAX_POINTS = 60
    }
}
