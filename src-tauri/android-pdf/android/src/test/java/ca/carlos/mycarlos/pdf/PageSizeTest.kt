package ca.carlos.mycarlos.pdf

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Hostile and ordinary page shapes: FAKE numbers only. */
class PageSizeTest {
    private val cap = PdfReaderDialog.MAX_PIXELS

    @Test
    fun anOrdinaryPageKeepsItsShapeWithinTheCap() {
        val (w, h) = PageSize.of(1080, 1f, 612, 792, cap)!!
        assertEquals(1080, w)
        assertTrue(Math.abs(h - 1080 * 792 / 612) <= 1)
        val (zw, zh) = PageSize.of(1080, 4f, 612, 792, cap)!!
        assertTrue(zw.toLong() * zh <= cap)
    }

    @Test
    fun aDegenerateTallMediaBoxIsRefusedNotAllocated() {
        // [0 0 1 2e9]: one pixel wide, two billion high.
        assertNull(PageSize.of(1080, 1f, 1, 2_000_000_000, cap))
        assertNull(PageSize.of(1080, 4f, 1, 1_000_000, cap))
        assertNull(PageSize.of(1080, 1f, 2_000_000_000, 1, cap))
        assertNull(PageSize.of(1080, 1f, 0, 792, cap))
        assertNull(PageSize.of(1080, 1f, 612, -5, cap))
    }

    @Test
    fun aTallButPlausiblePageIsDrawnSmallerNeverOverTheCapOrBeyondItsSide() {
        // A 1:60 strip is allowed, at the cap.
        val (w, h) = PageSize.of(1080, 4f, 10, 600, cap)!!
        assertTrue(w.toLong() * h <= cap)
        assertTrue(h < 2_000_000)
        assertNotNull(PageSize.of(1, 1f, 1, 64, cap))
        assertNull(PageSize.of(1, 1f, 1, 65, cap))
    }

    @Test
    fun noShapeEverGivesMoreThanTheCap() {
        for (pageWidth in listOf(1, 7, 100, 612, 5000)) {
            for (pageHeight in listOf(1, 7, 100, 792, 5000, 100_000)) {
                for (zoom in listOf(1f, 1.5f, 2f, 3f, 4f)) {
                    val size = PageSize.of(1440, zoom, pageWidth, pageHeight, cap) ?: continue
                    assertTrue("$pageWidth x $pageHeight at $zoom", size.first.toLong() * size.second <= cap)
                    assertTrue(size.first >= 1 && size.second >= 1)
                }
            }
        }
    }

    @Test
    fun noSideIsLongerThanTheTextureLimit() {
        for (pageWidth in listOf(1, 10, 612, 5000)) {
            for (pageHeight in listOf(10, 792, 5000, 100_000)) {
                for (zoom in listOf(1f, 2f, 4f)) {
                    val size = PageSize.of(1440, zoom, pageWidth, pageHeight, cap) ?: continue
                    assertTrue("$pageWidth x $pageHeight at $zoom", size.first <= PageSize.MAX_SIDE && size.second <= PageSize.MAX_SIDE)
                }
            }
        }
        val (w, h) = PageSize.of(1080, 4f, 10, 600, cap)!!
        assertEquals(PageSize.MAX_SIDE, h)
        assertTrue(w >= 1)
    }
}
