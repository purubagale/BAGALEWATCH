package np.nepaltelecom.telemetry.demo

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * Half-circle signal gauge from -140 to -40 dBm. The arc is coloured by
 * quality band, and a needle points at the current reading. Drawn directly
 * on a canvas, so it needs no image assets and matches the brand palette.
 */
class GaugeView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    private data class Band(val from: Float, val to: Float, val color: Int)

    private val bands = listOf(
        Band(MIN_DBM, -105f, ContextCompat.getColor(context, R.color.q_poor)),
        Band(-105f, -95f, ContextCompat.getColor(context, R.color.q_moderate)),
        Band(-95f, -87f, ContextCompat.getColor(context, R.color.q_fair)),
        Band(-87f, -77f, ContextCompat.getColor(context, R.color.q_good)),
        Band(-77f, MAX_DBM, ContextCompat.getColor(context, R.color.q_excellent)),
    )

    private val arcRect = RectF()
    private val arcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val needlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        strokeCap = Paint.Cap.ROUND
    }
    private val hubPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = ContextCompat.getColor(context, R.color.brand_accent)
    }
    private val valuePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textAlign = Paint.Align.CENTER
        isFakeBoldText = true
    }
    private val unitPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = ContextCompat.getColor(context, R.color.text_secondary)
        textAlign = Paint.Align.CENTER
    }

    private var value: Int? = null

    fun setValue(dbm: Int?) {
        value = dbm
        invalidate()
    }

    /** Maps a dBm reading onto the top half-circle, in canvas degrees. */
    private fun angleFor(dbm: Float): Float = 180f + (dbm - MIN_DBM) / (MAX_DBM - MIN_DBM) * 180f

    private fun dp(v: Float): Float = v * resources.displayMetrics.density

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val stroke = dp(14f)
        val cx = width / 2f
        val cy = height - dp(28f)
        val radius = min(width / 2f - stroke, cy - stroke)

        arcRect.set(cx - radius, cy - radius, cx + radius, cy + radius)
        arcPaint.strokeWidth = stroke
        for (band in bands) {
            arcPaint.color = band.color
            val start = angleFor(band.from)
            canvas.drawArc(arcRect, start, angleFor(band.to) - start, false, arcPaint)
        }

        val reading = value
        if (reading != null) {
            val clamped = reading.coerceIn(MIN_DBM.toInt(), MAX_DBM.toInt()).toFloat()
            val a = Math.toRadians(angleFor(clamped).toDouble())
            val length = radius - stroke / 2 - dp(4f)
            needlePaint.strokeWidth = dp(3f)
            canvas.drawLine(
                cx, cy,
                cx + (length * cos(a)).toFloat(),
                cy + (length * sin(a)).toFloat(),
                needlePaint,
            )
        }
        canvas.drawCircle(cx, cy, dp(7f), hubPaint)

        valuePaint.textSize = radius * 0.42f
        // Value and unit sit above the needle hub, so neither overlaps it.
        canvas.drawText(reading?.toString() ?: "--", cx, cy - radius * 0.38f, valuePaint)
        unitPaint.textSize = radius * 0.14f
        canvas.drawText("dBm", cx, cy - radius * 0.16f, unitPaint)
    }

    companion object {
        private const val MIN_DBM = -140f
        private const val MAX_DBM = -40f
    }
}
