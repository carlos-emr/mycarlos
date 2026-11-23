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

    /** The longest side of a bitmap: many phones' GPU texture limit is 8192, and a taller bitmap
     * is drawn blank. */
    const val MAX_SIDE = 8192

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
        if (height > MAX_SIDE) {
            height = MAX_SIDE
            width = (height / aspect).toInt().coerceAtLeast(1)
        }
        if (width > MAX_SIDE) {
            width = MAX_SIDE
            height = (width * aspect).toInt().coerceAtLeast(1)
        }
        // Rounding never leaves it over the cap or a side beyond MAX_SIDE.
        while ((width.toLong() * height > maxPixels || height > MAX_SIDE || width > MAX_SIDE) && width > 1) {
            width -= 1
            height = (width * aspect).toInt().coerceAtLeast(1)
        }
        return if (width.toLong() * height > maxPixels || width > MAX_SIDE || height > MAX_SIDE) null else Pair(width, height)
    }
}
