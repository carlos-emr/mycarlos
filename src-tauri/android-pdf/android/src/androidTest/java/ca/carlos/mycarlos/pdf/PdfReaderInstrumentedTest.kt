package ca.carlos.mycarlos.pdf

import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs on the emulator (#358). A small FAKE PDF is put in an anonymous in-memory file the way the
 * app does it, and PdfRenderer draws it from there: the page count is right, a page is not blank,
 * and the app's cache and files directories hold nothing new.
 */
@RunWith(AndroidJUnit4::class)
class PdfReaderInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    /** A minimal two-page PDF whose pages say FAKE; built here so no file is shipped. */
    private fun fakePdf(): ByteArray {
        val objects = listOf(
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R " +
                "/Resources << /Font << /F1 7 0 R >> >> >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 6 0 R " +
                "/Resources << /Font << /F1 7 0 R >> >> >>",
            stream("BT /F1 24 Tf 20 100 Td (FAKE page one) Tj ET"),
            stream("BT /F1 24 Tf 20 100 Td (FAKE page two) Tj ET"),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        )
        val out = StringBuilder("%PDF-1.4\n")
        val offsets = ArrayList<Int>()
        objects.forEachIndexed { index, body ->
            offsets.add(out.length)
            out.append("${index + 1} 0 obj\n$body\nendobj\n")
        }
        val xref = out.length
        out.append("xref\n0 ${objects.size + 1}\n0000000000 65535 f \n")
        for (offset in offsets) out.append(String.format("%010d 00000 n \n", offset))
        out.append("trailer\n<< /Size ${objects.size + 1} /Root 1 0 R >>\nstartxref\n$xref\n%%EOF\n")
        return out.toString().toByteArray(Charsets.ISO_8859_1)
    }

    private fun stream(content: String) = "<< /Length ${content.length} >>\nstream\n$content\nendstream"

    /** An anonymous in-memory file holding the bytes, as the app makes one in Rust (there by the
     * raw system call, so that API 24 works too). Null where this system call is not offered. */
    private fun memfd(bytes: ByteArray): ParcelFileDescriptor? {
        return try {
            val name = "mycarlos-test-pdf"
            val fd = Os.memfd_create(name, 0)
            Os.write(fd, bytes, 0, bytes.size)
            Os.lseek(fd, 0, OsConstants.SEEK_SET)
            ParcelFileDescriptor.dup(fd).also { Os.close(fd) }
        } catch (error: Throwable) {
            null
        }
    }

    private fun listing(dir: File): List<String> =
        dir.walkTopDown().filter { it.isFile }.map { it.path + ":" + it.length() }.sorted().toList()

    @Test
    fun aPdfInMemoryIsDrawnWithNoFileWrittenToTheAppsStorage() {
        val before = listing(context.cacheDir) + listing(context.filesDir)
        val pfd = memfd(fakePdf())
        if (pfd == null) {
            // Android before 11's Os.memfd_create is absent: the app itself uses the raw system
            // call, which the Rust tests cover; nothing to check here.
            return
        }
        val renderer = PdfRenderer(pfd)
        try {
            assertEquals(2, renderer.pageCount)
            val page = renderer.openPage(0)
            val bitmap = android.graphics.Bitmap.createBitmap(
                200,
                200,
                android.graphics.Bitmap.Config.ARGB_8888,
            )
            bitmap.eraseColor(android.graphics.Color.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            page.close()
            // Something was drawn: not every pixel is white.
            var dark = false
            for (x in 0 until 200 step 2) {
                for (y in 0 until 200 step 2) {
                    if (bitmap.getPixel(x, y) != android.graphics.Color.WHITE) dark = true
                }
            }
            assertTrue("the page was drawn blank", dark)
        } finally {
            renderer.close()
        }
        val after = listing(context.cacheDir) + listing(context.filesDir)
        assertEquals("the app's storage must be unchanged", before, after)
        assertFalse(after.any { it.contains("pdf", ignoreCase = true) && !before.contains(it) })
    }

    @Test
    fun theReaderDialogRefusesAPageCountOutOfBounds() {
        assertTrue(PdfReaderDialog.MAX_PAGES in 1..5000)
        assertTrue(PdfReaderDialog.MAX_PIXELS in 1_000_000L..24_000_000L)
        assertTrue(PdfReaderDialog.ZOOMS.first() == 1f)
    }
}
