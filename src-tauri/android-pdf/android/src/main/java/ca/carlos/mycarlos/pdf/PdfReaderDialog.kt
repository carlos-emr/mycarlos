package ca.carlos.mycarlos.pdf

import android.app.Activity
import android.app.Dialog
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The reader window: one page at a time, drawn with PdfRenderer from the in-memory document.
 *
 * - Its own Dialog (screenshots are allowed, by the owner's decision); the app's
 *   WebView is not involved, and nothing here reaches the network or a JavaScript bridge.
 * - At most the current page and its two neighbours are kept as bitmaps; the rest are recycled.
 *   The current page is drawn again, from a capped scale, when the person zooms.
 * - A single worker thread draws (PdfRenderer allows one open page at a time) and is the only
 *   thread that touches the renderer; it also closes it.
 * - Pages are pictures, so TalkBack can say which page it is but cannot read the letter's text:
 *   each page image says "Page n of N, picture of the letter".
 */
class PdfReaderDialog(
    private val activity: Activity,
    document: ParcelFileDescriptor,
    val generation: Long,
    private val title: String,
    private val labels: LabelArgs,
    private val events: (String) -> Unit,
    private val onClosed: (PdfReaderDialog, String) -> Unit,
) {
    private val renderer: PdfRenderer
    private val pageCount: Int
    private val worker: ExecutorService = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val dialog: Dialog
    private val imageView: ZoomImageView
    private val status: TextView
    private val previous: Button
    private val next: Button
    private val zoomIn: Button
    private val zoomOut: Button

    /** Bumped for every draw request: a late result of an older one is thrown away. */
    @Volatile private var drawId = 0
    private var page = 0
    private var zoomIndex = 0
    @Volatile private var closed = false
    private var firstShown = false
    private var lastActivity = 0L

    /** The bitmaps kept: the current page and its neighbours, at the base scale. */
    private val kept = LinkedHashMap<Int, Bitmap>()

    init {
        try {
            renderer = PdfRenderer(document)
        } catch (error: Exception) {
            try {
                document.close()
            } catch (ignored: Exception) {
            }
            throw error
        }
        pageCount = renderer.pageCount
        if (pageCount < 1 || pageCount > MAX_PAGES) {
            renderer.close()
            throw IllegalArgumentException("page count out of bounds")
        }

        dialog = object : Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar) {
            override fun dispatchTouchEvent(event: MotionEvent): Boolean {
                reportActivity()
                return super.dispatchTouchEvent(event)
            }

            override fun dispatchKeyEvent(event: KeyEvent): Boolean {
                reportActivity()
                return super.dispatchKeyEvent(event)
            }
        }
        // No FLAG_SECURE, on purpose: screenshots and the recent-apps picture are the patient's
        // choice (owner decision, 20 Nov 2026; THREAT_MODEL.md, "Android PDF reader boundary").
        dialog.setCancelable(true)
        dialog.setOnCancelListener { dismissFor("closed") }

        val root = LinearLayout(activity)
        root.orientation = LinearLayout.VERTICAL
        root.setBackgroundColor(Color.rgb(32, 33, 36))

        val header = LinearLayout(activity)
        header.orientation = LinearLayout.HORIZONTAL
        header.gravity = Gravity.CENTER_VERTICAL
        header.setPadding(dp(16), dp(8), dp(8), dp(8))
        val heading = TextView(activity)
        heading.text = title
        heading.setTextColor(Color.WHITE)
        heading.textSize = 18f
        heading.maxLines = 2
        if (Build.VERSION.SDK_INT >= 28) heading.isAccessibilityHeading = true
        header.addView(heading, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val close = button(labels.close) { dismissFor("closed") }
        header.addView(close)
        root.addView(header)

        imageView = ZoomImageView(activity)
        root.addView(imageView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        val footer = LinearLayout(activity)
        footer.orientation = LinearLayout.HORIZONTAL
        footer.gravity = Gravity.CENTER
        footer.setPadding(dp(8), dp(4), dp(8), dp(8))
        previous = button(labels.previous) { goTo(page - 1) }
        next = button(labels.next) { goTo(page + 1) }
        zoomOut = button(labels.zoomOut) { zoomBy(-1) }
        zoomIn = button(labels.zoomIn) { zoomBy(1) }
        status = TextView(activity)
        status.setTextColor(Color.WHITE)
        status.gravity = Gravity.CENTER
        status.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        footer.addView(previous)
        footer.addView(status, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        footer.addView(next)
        root.addView(footer)
        val zoomRow = LinearLayout(activity)
        zoomRow.orientation = LinearLayout.HORIZONTAL
        zoomRow.gravity = Gravity.CENTER
        zoomRow.setPadding(dp(8), 0, dp(8), dp(8))
        zoomRow.addView(zoomOut)
        zoomRow.addView(zoomIn)
        root.addView(zoomRow)

        dialog.setContentView(root)
        imageView.onPinch = { factor -> pinch(factor) }
        imageView.onDoubleTap = { if (zoomIndex == 0) zoomTo(2) else zoomTo(0) }
        imageView.onSwipe = { forward -> goTo(if (forward) page + 1 else page - 1) }
    }

    fun show() {
        dialog.show()
        dialog.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        // The size of the picture area is known after layout.
        imageView.post { draw(page) }
    }

    /** Closes the reader, once, for the reason given: "closed", "background", "cancelled"... */
    fun dismissFor(reason: String) {
        if (closed) return
        closed = true
        drawId += 1
        try {
            dialog.dismiss()
        } catch (ignored: Exception) {
        }
        synchronized(kept) {
            for (bitmap in kept.values) bitmap.recycle()
            kept.clear()
        }
        imageView.setImageBitmap(null)
        // The renderer is closed by the worker that uses it, after any draw in progress.
        worker.execute {
            try {
                renderer.close()
            } catch (ignored: Exception) {
            }
        }
        worker.shutdown()
        events("closed")
        onClosed(this, reason)
    }

    private fun reportActivity() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastActivity < ACTIVITY_INTERVAL_MS) return
        lastActivity = now
        events("activity")
    }

    private fun goTo(target: Int) {
        if (closed || target < 0 || target >= pageCount) return
        page = target
        zoomIndex = 0
        draw(page)
    }

    private fun zoomBy(step: Int) = zoomTo((zoomIndex + step).coerceIn(0, ZOOMS.size - 1))

    private fun zoomTo(index: Int) {
        if (closed || index == zoomIndex) return
        zoomIndex = index
        draw(page)
    }

    private fun pinch(factor: Float) {
        // The nearest zoom step to the pinched factor, drawn again at that scale.
        val target = ZOOMS[zoomIndex] * factor
        var best = 0
        for (index in ZOOMS.indices) {
            if (Math.abs(ZOOMS[index] - target) < Math.abs(ZOOMS[best] - target)) best = index
        }
        zoomTo(best)
    }

    private fun updateControls() {
        val label = labels.pageStatus.fill(page + 1, pageCount)
        status.text = label
        previous.isEnabled = page > 0
        next.isEnabled = page < pageCount - 1
        zoomOut.isEnabled = zoomIndex > 0
        zoomIn.isEnabled = zoomIndex < ZOOMS.size - 1
        imageView.contentDescription = labels.page.fill(page + 1, pageCount)
    }

    /** Draws `index` at the current zoom, then its neighbours at the base scale. */
    private fun draw(index: Int) {
        if (closed) return
        val viewWidth = imageView.width
        val viewHeight = imageView.height
        if (viewWidth <= 0 || viewHeight <= 0) {
            imageView.post { draw(index) }
            return
        }
        updateControls()
        val id = ++drawId
        val zoom = ZOOMS[zoomIndex]
        worker.execute {
            if (isStale(id)) return@execute
            // Throwable, not Exception: a bitmap that does not fit is an OutOfMemoryError, and on
            // an older phone even an ordinary tall page can be one. It is the recoverable error.
            val bitmap = try {
                render(index, viewWidth, zoom)
            } catch (error: Throwable) {
                null
            }
            main.post {
                if (closed || id != drawId) {
                    if (zoom != 1f) bitmap?.recycle()
                    return@post
                }
                if (bitmap == null) {
                    if (!firstShown) dismissFor("failed")
                    return@post
                }
                firstShown = true
                if (zoom == 1f) keep(index, bitmap)
                imageView.show(bitmap, zoom != 1f)
            }
            if (zoom == 1f) prefetch(id, index - 1, viewWidth)
            if (zoom == 1f) prefetch(id, index + 1, viewWidth)
        }
    }

    private fun isStale(id: Int) = closed || id != drawId

    private fun prefetch(id: Int, index: Int, viewWidth: Int) {
        if (index < 0 || index >= pageCount || isStale(id)) return
        val have = synchronized(kept) { kept.containsKey(index) }
        if (have) return
        val bitmap = try {
            render(index, viewWidth, 1f)
        } catch (error: Throwable) {
            return
        }
        main.post {
            if (closed || id != drawId) bitmap.recycle() else keep(index, bitmap)
        }
    }

    /** Keeps `bitmap` for `index` and recycles every page farther than one from the current. */
    private fun keep(index: Int, bitmap: Bitmap) {
        synchronized(kept) {
            kept.put(index, bitmap)?.let { if (it !== bitmap && !isShown(it)) it.recycle() }
            val iterator = kept.entries.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                if (Math.abs(entry.key - page) > 1 && !isShown(entry.value)) {
                    entry.value.recycle()
                    iterator.remove()
                }
            }
        }
    }

    private fun isShown(bitmap: Bitmap) = imageView.shows(bitmap)

    /** One page as a bitmap `viewWidth * zoom` wide, within the pixel cap. Worker thread only. */
    private fun render(index: Int, viewWidth: Int, zoom: Float): Bitmap {
        val cached = synchronized(kept) { kept[index] }
        if (zoom == 1f && cached != null && !cached.isRecycled) return cached
        val pdfPage = renderer.openPage(index)
        try {
            // Never more than MAX_PIXELS, and an extreme shape is refused (the caller shows the
            // recoverable error): a MediaBox of [0 0 1 2e9] must not become a bitmap.
            val (width, height) = PageSize.of(viewWidth, zoom, pdfPage.width, pdfPage.height, MAX_PIXELS)
                ?: throw IllegalArgumentException("page shape")
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(Color.WHITE)
            pdfPage.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            return bitmap
        } finally {
            pdfPage.close()
        }
    }

    private fun button(text: String, action: () -> Unit): Button {
        val button = Button(activity)
        button.text = text
        button.minimumHeight = dp(48)
        button.minimumWidth = dp(48)
        button.setOnClickListener { action() }
        return button
    }

    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()

    /** The text with {page} and {total} filled in; the isolation marks Fluent adds are dropped. */
    private fun String.fill(page: Int, total: Int) =
        replace("⁨", "").replace("⁩", "")
            .replace("{page}", page.toString()).replace("{total}", total.toString())

    /** A page picture that is panned when it is bigger than the view, and pinched or tapped. */
    class ZoomImageView(activity: Activity) : ImageView(activity) {
        var onPinch: (Float) -> Unit = {}
        var onDoubleTap: () -> Unit = {}
        var onSwipe: (Boolean) -> Unit = {}
        private var shown: Bitmap? = null
        private var scale = 1f
        private var tx = 0f
        private var ty = 0f
        private val matrix = Matrix()
        private var downX = 0f
        private var downY = 0f
        private var lastX = 0f
        private var lastY = 0f
        private var lastTap = 0L
        private var pinching = false
        private val scaleDetector = ScaleGestureDetector(
            activity,
            object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
                override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
                    pinching = true
                    return true
                }

                override fun onScale(detector: ScaleGestureDetector): Boolean = true

                override fun onScaleEnd(detector: ScaleGestureDetector) {
                    onPinch(detector.scaleFactor)
                    pinching = false
                }
            },
        )

        init {
            scaleType = ScaleType.MATRIX
            setBackgroundColor(Color.rgb(32, 33, 36))
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }

        fun shows(bitmap: Bitmap) = shown === bitmap

        /** Shows `bitmap`: a base-scale page is fitted to the width, a zoomed one is shown as drawn. */
        fun show(bitmap: Bitmap, zoomed: Boolean) {
            shown = bitmap
            setImageBitmap(bitmap)
            scale = if (zoomed) 1f else width.toFloat() / bitmap.width
            tx = 0f
            ty = 0f
            apply()
        }

        private fun apply() {
            val bitmap = shown ?: return
            val shownWidth = bitmap.width * scale
            val shownHeight = bitmap.height * scale
            tx = if (shownWidth <= width) (width - shownWidth) / 2f else tx.coerceIn(width - shownWidth, 0f)
            ty = if (shownHeight <= height) 0f else ty.coerceIn(height - shownHeight, 0f)
            matrix.setScale(scale, scale)
            matrix.postTranslate(tx, ty)
            imageMatrix = matrix
        }

        private fun widerThanView() = (shown?.let { it.width * scale } ?: 0f) > width

        override fun onTouchEvent(event: MotionEvent): Boolean {
            scaleDetector.onTouchEvent(event)
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.x
                    downY = event.y
                    lastX = event.x
                    lastY = event.y
                }
                MotionEvent.ACTION_MOVE -> if (!pinching && event.pointerCount == 1) {
                    tx += event.x - lastX
                    ty += event.y - lastY
                    lastX = event.x
                    lastY = event.y
                    apply()
                }
                MotionEvent.ACTION_UP -> {
                    val movedX = event.x - downX
                    val movedY = event.y - downY
                    val now = SystemClock.elapsedRealtime()
                    if (!pinching && !widerThanView() && Math.abs(movedX) > SWIPE_PIXELS &&
                        Math.abs(movedX) > 2 * Math.abs(movedY)
                    ) {
                        onSwipe(movedX < 0)
                    } else if (!pinching && Math.abs(movedX) < TAP_SLOP_PIXELS &&
                        Math.abs(movedY) < TAP_SLOP_PIXELS
                    ) {
                        if (now - lastTap < DOUBLE_TAP_MS) {
                            onDoubleTap()
                            lastTap = 0
                        } else {
                            lastTap = now
                        }
                    }
                }
            }
            return true
        }
    }

    companion object {
        /** The most pages a document may have (a larger one is refused, not partly shown). */
        const val MAX_PAGES = 1000
        /** The most pixels one drawn page may have (about 48 MB as ARGB_8888). */
        const val MAX_PIXELS = 12_000_000L
        /** Zoom steps as a multiple of the width of the view. */
        val ZOOMS = floatArrayOf(1f, 1.5f, 2f, 3f, 4f)
        const val ACTIVITY_INTERVAL_MS = 5_000L
        const val SWIPE_PIXELS = 160f
        const val TAP_SLOP_PIXELS = 20f
        const val DOUBLE_TAP_MS = 300L
    }
}
