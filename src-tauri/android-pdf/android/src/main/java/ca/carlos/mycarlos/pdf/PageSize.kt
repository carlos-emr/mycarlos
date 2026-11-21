package ca.carlos.mycarlos.pdf

import kotlin.math.sqrt

/**
 * The size of the bitmap a page is drawn into. Pure arithmetic, so it can be tested without a
 * device: a page is never drawn into more than `maxPixels`, and a page of an extreme shape (a
 * MediaBox a pixel wide and a billion high, or the other way round) is refused rather than drawn
 * into a bitmap of one side beyond reason, which would be an out-of-memory error.
 */
object PageSize {
    /** The most a page may be taller than wide, or wider than tall. */
    const val MAX_ASPECT = 64.0

    /** Width and height in pixels for a page of `pageWidth` by `pageHeight` points, `viewWidth *
     * zoom` wide at most, or null when the page's shape is not one to draw. */
    fun of(viewWidth: Int, zoom: Float, pageWidth: Int, pageHeight: Int, maxPixels: Long): Pair<Int, Int>? {
        if (pageWidth <= 0 || pageHeight <= 0 || viewWidth <= 0) return null
        val aspect = pageHeight.toDouble() / pageWidth.toDouble()
        if (aspect > MAX_ASPECT || aspect < 1.0 / MAX_ASPECT) return null
        var width = (viewWidth * zoom).toInt().coerceAtLeast(1)
        var height = (width * aspect).toInt().coerceAtLeast(1)
        if (width.toLong() * height > maxPixels) {
            val scale = sqrt(maxPixels.toDouble() / (width.toDouble() * height))
            width = (width * scale).toInt().coerceAtLeast(1)
            height = (width * aspect).toInt().coerceAtLeast(1)
        }
        // Rounding never leaves it over the cap.
        while (width.toLong() * height > maxPixels && width > 1) {
            width -= 1
            height = (width * aspect).toInt().coerceAtLeast(1)
        }
        return if (width.toLong() * height > maxPixels) null else Pair(width, height)
    }
}
