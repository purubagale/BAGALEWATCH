package np.nepaltelecom.telemetry.demo

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View
import android.view.animation.DecelerateInterpolator
import androidx.core.content.ContextCompat
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.sin

/**
 * The signal dial (2026-10-31): a light, open arc a little wider than it is
 * tall, from -140 to -40 dBm in the app's quality bands, with ticks and
 * numbers outside it. The arc is lit and glows up to the reading, in the
 * colours of its bands. A small pointer inside the arc moves smoothly to each
 * new reading; the value and its quality word sit in the centre on a soft
 * glow in the reading's colour. Drawn on a canvas, so it needs no image assets.
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
    private val ink = ContextCompat.getColor(context, R.color.text_primary)
    private val muted = ContextCompat.getColor(context, R.color.text_secondary)
    private val brand = ContextCompat.getColor(context, R.color.brand_primary)

    private val arcRect = RectF()
    private val pointer = Path()
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val arcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val arcGlowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val tickPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeCap = Paint.Cap.ROUND; color = ink }
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = ink
        textAlign = Paint.Align.CENTER
    }
    private val pointerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ink }
    private val valuePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = ink
        textAlign = Paint.Align.CENTER
    }
    private val wordPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        isFakeBoldText = true
    }

    private var glowRadius = 0f
    private var value: Int? = null
    private var shown = MIN_DBM          // where the pointer is now
    private var motion: ValueAnimator? = null

    // The blur of the glow is drawn in software.
    init { setLayerType(LAYER_TYPE_SOFTWARE, null) }

    fun setValue(dbm: Int?) {
        value = dbm
        val target = (dbm?.toFloat() ?: MIN_DBM).coerceIn(MIN_DBM, MAX_DBM)
        motion?.cancel()
        motion = ValueAnimator.ofFloat(shown, target).apply {
            duration = MOVE_MS
            interpolator = DecelerateInterpolator()
            addUpdateListener { shown = it.animatedValue as Float; invalidate() }
            start()
        }
    }

    override fun onDetachedFromWindow() {
        motion?.cancel()
        super.onDetachedFromWindow()
    }

    /** Maps a dBm reading onto the arc, in canvas degrees. */
    private fun angleFor(dbm: Float): Float = START_DEG + (dbm - MIN_DBM) / (MAX_DBM - MIN_DBM) * SWEEP_DEG

    private fun bandColor(dbm: Float): Int = bands.firstOrNull { dbm < it.to }?.color ?: bands.last().color

    private fun dp(v: Float): Float = v * resources.displayMetrics.density

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val cx = width / 2f
        val hasReading = value != null
        val ry = height / HEIGHT_IN_RY
        val margin = ry * 0.33f                // ticks and numbers outside the arc
        val rx = min(width / 2f - margin * 1.5f, ry * WIDTH_RATIO)
        val cy = margin + ry
        val tone = if (hasReading) bandColor(shown) else brand

        glowPaint.shader = RadialGradient(
            cx, cy, ry * 0.46f,
            Color.argb(70, Color.red(tone), Color.green(tone), Color.blue(tone)),
            Color.argb(0, Color.red(tone), Color.green(tone), Color.blue(tone)),
            Shader.TileMode.CLAMP,
        )
        canvas.drawCircle(cx, cy, ry * 0.46f, glowPaint)

        val stroke = ry * 0.035f
        arcRect.set(cx - rx, cy - ry, cx + rx, cy + ry)
        arcPaint.strokeWidth = stroke
        arcGlowPaint.strokeWidth = stroke * 2.4f
        if (glowRadius != ry * 0.14f) {
            glowRadius = ry * 0.14f
            arcGlowPaint.maskFilter = BlurMaskFilter(glowRadius, BlurMaskFilter.Blur.NORMAL)
        }
        // Dim for all of the scale; lit and glowing up to the reading.
        for (band in bands) {
            val start = angleFor(band.from)
            arcPaint.color = band.color
            arcPaint.alpha = if (hasReading) 70 else 150
            canvas.drawArc(arcRect, start, angleFor(band.to) - start, false, arcPaint)
            if (!hasReading || shown <= band.from) continue
            val lit = angleFor(min(shown, band.to)) - start
            arcGlowPaint.color = band.color
            canvas.drawArc(arcRect, start, lit, false, arcGlowPaint)
            arcPaint.alpha = 255
            canvas.drawArc(arcRect, start, lit, false, arcPaint)
        }

        // A point `out` beyond the arc (negative: inside it).
        fun px(a: Double, out: Float) = cx + ((rx + out) * cos(a)).toFloat()
        fun py(a: Double, out: Float) = cy + ((ry + out) * sin(a)).toFloat()

        // Ticks every 2 dB, longer with a number every 10.
        labelPaint.textSize = ry * 0.1f
        var dbm = MIN_DBM.toInt()
        while (dbm <= MAX_DBM.toInt()) {
            val major = (dbm + 140) % 10 == 0
            val a = Math.toRadians(angleFor(dbm.toFloat()).toDouble())
            val from = stroke * 1.2f
            val to = from + (if (major) ry * 0.075f else ry * 0.035f)
            tickPaint.strokeWidth = if (major) dp(1.2f) else dp(0.7f)
            tickPaint.alpha = if (major) 220 else 110
            canvas.drawLine(px(a, from), py(a, from), px(a, to), py(a, to), tickPaint)
            if (major) {
                val r = to + ry * 0.12f
                canvas.drawText(dbm.toString(), px(a, r), py(a, r) + labelPaint.textSize / 3f, labelPaint)
            }
            dbm += 2
        }

        // The small pointer just inside the arc.
        val a = Math.toRadians(angleFor(shown).toDouble())
        val tipX = px(a, -stroke * 1.2f)
        val tipY = py(a, -stroke * 1.2f)
        val heelX = px(a, -ry * 0.16f)
        val heelY = py(a, -ry * 0.16f)
        val length = hypot(tipX - heelX, tipY - heelY)
        val half = ry * 0.05f
        val nx = -(tipY - heelY) / length * half
        val ny = (tipX - heelX) / length * half
        pointer.reset()
        pointer.moveTo(tipX, tipY)
        pointer.lineTo(heelX + nx, heelY + ny)
        pointer.lineTo(heelX - nx, heelY - ny)
        pointer.close()
        pointerPaint.alpha = if (hasReading) 255 else 70
        canvas.drawPath(pointer, pointerPaint)

        // The value and its quality word in the centre.
        val reading = value
        valuePaint.textSize = ry * 0.21f
        valuePaint.color = if (reading != null) ink else muted
        if (reading != null) valuePaint.setShadowLayer(ry * 0.09f, 0f, 0f, tone) else valuePaint.clearShadowLayer()
        canvas.drawText(if (reading != null) "$reading dBm" else "-- dBm", cx, cy + ry * 0.1f, valuePaint)
        wordPaint.textSize = ry * 0.12f
        wordPaint.color = ContextCompat.getColor(context, SignalQuality.colorRes(reading))
        canvas.drawText(SignalQuality.label(reading), cx, cy + ry * 0.3f, wordPaint)
    }

    companion object {
        private const val MIN_DBM = -140f
        private const val MAX_DBM = -40f
        private const val START_DEG = 160f
        private const val SWEEP_DEG = 220f
        private const val WIDTH_RATIO = 1.35f    // how much wider than tall the arc is
        private const val HEIGHT_IN_RY = 1.8f   // view height, in arc heights
        private const val MOVE_MS = 500L
    }
}
