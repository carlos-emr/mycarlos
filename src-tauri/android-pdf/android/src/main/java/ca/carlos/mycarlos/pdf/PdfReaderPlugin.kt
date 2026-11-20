package ca.carlos.mycarlos.pdf

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.ParcelFileDescriptor
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class LabelArgs {
    var close: String = ""
    var previous: String = ""
    var next: String = ""
    var zoomIn: String = ""
    var zoomOut: String = ""
    var page: String = ""
    var pageStatus: String = ""
}

@InvokeArg
class OpenArgs {
    var generation: Long = 0
    var epoch: Long = 0
    var fd: Int = -1
    var size: Long = 0
    var title: String = ""
    lateinit var labels: LabelArgs
    lateinit var activity: Channel
}

@InvokeArg
class CloseArgs {
    var generation: Long = 0
}

/**
 * The native PDF reader (#358). The document is a sealed in-memory file of this process, handed
 * over as a descriptor number: it is duplicated here and drawn with PdfRenderer in a dialog of
 * its own (no WebView, no JavaScript bridge, no network, FLAG_SECURE). Nothing is written to any
 * path. Backgrounding the app closes the reader, and so do the app's own close and lock
 * commands, through `close(generation)`.
 *
 * `epoch` changes whenever the app goes to the background, so an export that began before cannot
 * show a reader after the person has returned. `minGeneration` is the newest cancel the app has
 * sent: an open older than it is refused, and so cannot reappear from a queue.
 */
@TauriPlugin
class PdfReaderPlugin(private val activity: Activity) : Plugin(activity) {
    private val lock = Any()
    private var epoch = 0L
    private var minGeneration = 0L
    private var current: PdfReaderDialog? = null

    init {
        activity.application.registerActivityLifecycleCallbacks(
            object : Application.ActivityLifecycleCallbacks {
                override fun onActivityPaused(paused: Activity) = background(paused)
                override fun onActivityStopped(stopped: Activity) = background(stopped)
                override fun onActivityCreated(a: Activity, state: Bundle?) {}
                override fun onActivityStarted(a: Activity) {}
                override fun onActivityResumed(a: Activity) {}
                override fun onActivitySaveInstanceState(a: Activity, state: Bundle) {}
                override fun onActivityDestroyed(a: Activity) {}
            },
        )
    }

    private fun background(changed: Activity) {
        if (changed !== activity) return
        val open: PdfReaderDialog?
        synchronized(lock) {
            epoch += 1
            open = current
            current = null
        }
        open?.let { reader -> activity.runOnUiThread { reader.dismissFor("background") } }
    }

    @Command
    fun begin(invoke: Invoke) {
        val result = JSObject()
        synchronized(lock) { result.put("epoch", epoch) }
        invoke.resolve(result)
    }

    @Command
    fun open(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(OpenArgs::class.java)
        } catch (error: Exception) {
            invoke.reject("bad arguments")
            return
        }
        if (args.fd < 0 || args.size <= 0 || args.size > MAX_BYTES) {
            invoke.reject("bad document")
            return
        }
        activity.runOnUiThread {
            // Checked on the UI thread, where a reader is shown and dismissed.
            val duplicate: ParcelFileDescriptor
            synchronized(lock) {
                if (args.generation < minGeneration || args.epoch != epoch) {
                    invoke.reject("cancelled")
                    return@runOnUiThread
                }
                duplicate = try {
                    ParcelFileDescriptor.fromFd(args.fd)
                } catch (error: Exception) {
                    invoke.reject("cannot adopt the document")
                    return@runOnUiThread
                }
                current?.dismissFor("replaced")
                current = null
            }
            val reader = try {
                PdfReaderDialog(
                    activity = activity,
                    document = duplicate,
                    generation = args.generation,
                    title = args.title,
                    labels = args.labels,
                    events = { event ->
                        val message = JSObject()
                        message.put("event", event)
                        args.activity.send(message)
                    },
                    onClosed = { reader, reason ->
                        synchronized(lock) {
                            if (current === reader) current = null
                        }
                        if (reason == "failed") invoke.reject("cannot show the document")
                        else invoke.resolve()
                    },
                )
            } catch (error: Exception) {
                // PdfRenderer refused it (a password, damage): the duplicate is already closed.
                invoke.reject("cannot show the document")
                return@runOnUiThread
            }
            synchronized(lock) {
                if (args.generation < minGeneration || args.epoch != epoch) {
                    reader.dismissFor("cancelled")
                    return@runOnUiThread
                }
                current = reader
            }
            reader.show()
        }
    }

    @Command
    fun close(invoke: Invoke) {
        val args = invoke.parseArgs(CloseArgs::class.java)
        val open: PdfReaderDialog?
        synchronized(lock) {
            if (args.generation > minGeneration) minGeneration = args.generation
            // A reader of this generation or an older one; a newer one (opened after this cancel
            // was sent) stays.
            open = current?.takeIf { it.generation < args.generation }
            if (open != null) current = null
        }
        activity.runOnUiThread { open?.dismissFor("cancelled") }
        invoke.resolve()
    }

    companion object {
        /** The same bound as the Rust side (`android_pdf::MAX_BYTES`). */
        const val MAX_BYTES = 20L * 1024 * 1024
    }
}
