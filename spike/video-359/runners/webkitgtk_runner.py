#!/usr/bin/env python3
"""myCarlos #359 spike (PR 0): runs the probe in WebKitGTK, headless, with a custom URI
scheme that serves the recorded bytes the way the app's playback address will.

NOT SHIPPED. FAKE canvas and tone sources only; no camera, no microphone.

    xvfb-run -a python3 -I webkitgtk_runner.py --out result.json

Needs gir1.2-webkit2-4.1. For MP4 recording on Linux the GStreamer packages
gstreamer1.0-plugins-bad and -ugly must be on GST_PLUGIN_PATH (or installed).

Each scheme request is logged (range asked, status given), so the result says whether
WebKitGTK's media pipeline asked for ranges and whether seeking made new range requests.
"""
import argparse
import base64
import json
import os
import sys
import http.server
import threading
import time

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
gi.require_version("Soup", "3.0")
from gi.repository import Gio, GLib, Gtk, Soup, WebKit2  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE_DIR = os.path.join(HERE, "..", "probe")
SCHEME = "mcspike"


def descendants_cpu_seconds(root_pid):
    """User + system CPU seconds of this process and all its descendants."""
    ticks = os.sysconf("SC_CLK_TCK")
    children = {}
    stats = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/stat") as handle:
                fields = handle.read().rsplit(")", 1)[1].split()
        except OSError:
            continue
        pid = int(name)
        ppid = int(fields[1])
        children.setdefault(ppid, []).append(pid)
        stats[pid] = (int(fields[11]) + int(fields[12])) / ticks
    total = 0.0
    todo = [root_pid]
    while todo:
        pid = todo.pop()
        total += stats.get(pid, 0.0)
        todo.extend(children.get(pid, []))
    return total


class RangeServer:
    """A control only: the same bytes over plain http on 127.0.0.1, with ranges, so that a
    failure of the custom scheme can be told from a failure to decode. The app must never
    serve playback this way (Ben, Q5): this is not a design option."""

    def __init__(self, clips):
        self.clips = clips
        self.log = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                name = self.path.lstrip("/").split("?", 1)[0]
                clip = outer.clips.get(name)
                if not clip:
                    self.send_error(404)
                    return
                data, ctype = clip
                total = len(data)
                rng = self.headers.get("Range")
                start, end, status = 0, total - 1, 200
                if rng and rng.startswith("bytes="):
                    first, _, last = rng[6:].partition("-")
                    start = int(first) if first else max(0, total - int(last))
                    end = min(int(last), total - 1) if (first and last) else total - 1
                    status = 206
                body = data[start : end + 1]
                outer.log.append({"path": name, "range": rng, "status": status, "from": start, "to": end})
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(len(body)))
                if status == 206:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()


class Spike:
    def __init__(self, args):
        self.args = args
        self.clips = {}  # name -> (bytes, content type)
        self.requests = []  # request log for the playback phase
        self.honour_range = True
        self.window = Gtk.OffscreenWindow()
        self.context = WebKit2.WebContext.new_ephemeral()
        self.context.register_uri_scheme(SCHEME, self.on_request, None)
        # As wry does for an app's own scheme: the page is a secure context and the scheme may be fetched.
        security = self.context.get_security_manager()
        security.register_uri_scheme_as_secure(SCHEME)
        security.register_uri_scheme_as_cors_enabled(SCHEME)
        policies = WebKit2.WebsitePolicies(autoplay=WebKit2.AutoplayPolicy.ALLOW)
        self.view = WebKit2.WebView(web_context=self.context, website_policies=policies)
        settings = self.view.get_settings()
        settings.set_enable_media_stream(True)
        settings.set_enable_mediasource(True)
        settings.set_media_playback_requires_user_gesture(False)
        settings.set_media_playback_allows_inline(True)
        self.view.connect("permission-request", lambda _w, r: (r.deny(), True)[1])
        self.window.set_default_size(480, 320)
        self.window.add(self.view)
        self.window.show_all()
        self.loop = GLib.MainLoop()

    # ---- the custom scheme ---------------------------------------------------
    def on_request(self, request, _data):
        uri = request.get_uri()
        path = uri.split("://", 1)[1].split("/", 1)[1] if "/" in uri.split("://", 1)[1] else ""
        headers = request.get_http_headers()
        range_header = headers.get_one("Range") if headers else None
        if path in ("probe.html", "probe.js"):
            with open(os.path.join(PROBE_DIR, path), "rb") as handle:
                body = handle.read()
            ctype = "text/html" if path.endswith("html") else "text/javascript"
            self.finish(request, body, ctype, 200, None, None)
            return
        name = path.split("?", 1)[0]
        clip = self.clips.get(name)
        if clip is None:
            self.requests.append({"path": name, "range": range_header, "status": 404})
            self.finish(request, b"not found", "text/plain", 404, None, None)
            return
        data, ctype = clip
        total = len(data)
        start, end, status = 0, total - 1, 200
        if self.honour_range and range_header and range_header.startswith("bytes="):
            first, _, last = range_header[6:].partition("-")
            start = int(first) if first else max(0, total - int(last))
            end = min(int(last), total - 1) if (first and last) else total - 1
            # An open-ended range is answered with at most 1 MiB, as the design's reply cap does.
            if not last:
                end = min(end, start + 1024 * 1024 - 1)
            status = 206
        body = data[start : end + 1]
        self.requests.append(
            {"path": name, "range": range_header, "status": status, "from": start, "to": end, "sent": len(body)}
        )
        self.finish(request, body, ctype, status, (start, end, total) if status == 206 else None, total)

    def finish(self, request, body, ctype, status, content_range, total):
        stream = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(body))
        response = WebKit2.URISchemeResponse.new(stream, len(body))
        response.set_status(status, {200: "OK", 206: "Partial Content", 404: "Not Found"}[status])
        response.set_content_type(ctype)
        head = Soup.MessageHeaders.new(Soup.MessageHeadersType.RESPONSE)
        head.append("Accept-Ranges", "bytes" if self.honour_range else "none")
        head.append("Cache-Control", "no-store")
        if content_range:
            head.append("Content-Range", f"bytes {content_range[0]}-{content_range[1]}/{content_range[2]}")
        response.set_http_headers(head)
        request.finish_with_response(response)

    # ---- driving the page ----------------------------------------------------
    def eval_string(self, script):
        """Evaluate a script that returns a string (or null) and give back that value."""
        box = {}

        def done(view, result, _data):
            try:
                value = view.evaluate_javascript_finish(result)
                box["v"] = None if (value.is_null() or value.is_undefined()) else value.to_string()
            except GLib.Error as error:
                box["error"] = error.message
            self.loop.quit()

        self.view.evaluate_javascript(script, -1, None, None, None, done, None)
        self.loop.run()
        return box

    def js(self, script, timeout_s=120):
        """Run `script` (an expression that returns JSON-able data, or a Promise) and return
        {"ok": True, "v": value} or {"ok": False, "e": reason}. A Promise is polled for, because
        WebKitGTK hands back the Promise itself, not what it resolves to."""
        self.counter = getattr(self, "counter", 0) + 1
        key = f"__r{self.counter}"
        start = (
            f"window.{key} = null; (async () => {{ try {{ const v = await ({script}); "
            f"window.{key} = JSON.stringify({{ok: true, v}}); }} catch (e) {{ "
            f"window.{key} = JSON.stringify({{ok: false, e: String(e && e.stack || e)}}); }} }})(); 'started'"
        )
        started = self.eval_string(start)
        if "error" in started:
            return {"ok": False, "e": started["error"]}
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            got = self.eval_string(f"window.{key}")
            if got.get("v"):
                return json.loads(got["v"])
            # Let the page run: a short GLib wait without blocking the main loop.
            wait = GLib.MainLoop()
            GLib.timeout_add(300, lambda w=wait: (w.quit(), False)[1])
            wait.run()
        return {"ok": False, "e": "timeout"}

    def load(self):
        done = {}

        def changed(view, event):
            if event == WebKit2.LoadEvent.FINISHED:
                done["ok"] = True
                self.loop.quit()

        handler = self.view.connect("load-changed", changed)
        self.view.load_uri(f"{SCHEME}://app/probe.html")
        GLib.timeout_add_seconds(30, lambda: (self.loop.quit(), False)[1])
        self.loop.run()
        self.view.disconnect(handler)
        return done.get("ok", False)

    def run(self):
        result = {
            "runner": "webkitgtk_runner.py",
            "webkitgtk": "%d.%d.%d"
            % (
                WebKit2.get_major_version(),
                WebKit2.get_minor_version(),
                WebKit2.get_micro_version(),
            ),
            "gstPluginPath": os.environ.get("GST_PLUGIN_PATH", ""),
        }
        if not self.load():
            result["error"] = "page did not load"
            return result
        support = self.js("spikeSupport()")
        result["support"] = support.get("v") if support.get("ok") else support
        sup = result["support"] if isinstance(result["support"], dict) else {}
        mp4 = sup.get("firstMp4")
        webm = sup.get("firstWebm")
        result["recordings"] = []
        plan = []
        sizes = [tuple(int(n) for n in size.split("x")) for size in self.args.sizes.split(",")]
        for mime in [m for m in (mp4, webm) if m]:
            for index, (width, height) in enumerate(sizes):
                bps = int(self.args.bps_per_pixel * width * height)
                if index == 0:
                    plan.append((mime, width, height, bps, True, True))  # audio + video, with a pause
                plan.append((mime, width, height, bps, False, False))  # video only
                if width >= 1280:
                    plan.append((mime, width, height, bps, True, False))  # audio + video
        if self.args.no_record:
            plan = []
        for mime, width, height, bps, audio, pause in plan:
            params = {
                "mime": mime, "width": width, "height": height, "videoBps": bps,
                "withAudio": audio, "seconds": 7, "pauseAt": 2.5 if pause else 0, "pauseFor": 1.5,
            }
            cpu0, t0 = descendants_cpu_seconds(os.getpid()), time.time()
            outcome = self.js("spikeRecordOne(" + json.dumps(params) + ")", timeout_s=90)
            wall = time.time() - t0
            cpu = descendants_cpu_seconds(os.getpid()) - cpu0
            rec = outcome.get("v") if outcome.get("ok") else {"error": outcome}
            rec["cpuSecondsDuringRecording"] = round(cpu, 2)
            rec["wallSeconds"] = round(wall, 2)
            rec["cpuPercentOfOneCore"] = round(100 * cpu / wall, 1) if wall else None
            result["recordings"].append(rec)
        # Pull the clips out of the page.
        names = self.js("spikeClipNames()").get("v") or []
        for name in names:
            clip = self.js(f"spikeClip({json.dumps(name)})", timeout_s=60)
            if clip.get("ok"):
                self.clips[name] = (base64.b64decode(clip["v"]["b64"]), clip["v"]["type"])
        for path in self.args.fixture or []:
            name = "fixture-" + os.path.basename(path)
            with open(path, "rb") as handle:
                self.clips[name] = (handle.read(), "video/webm" if path.endswith(".webm") else "video/mp4")
        if self.args.save_clips:
            os.makedirs(self.args.save_clips, exist_ok=True)
            for name, (data, ctype) in self.clips.items():
                ext = "webm" if "webm" in ctype else "mp4"
                with open(os.path.join(self.args.save_clips, name + "." + ext), "wb") as handle:
                    handle.write(data)
        # Playback, with ranges honoured and then with ranges ignored.
        result["playback"] = {}
        for label, honour in (("rangeHonoured", True), ("rangeIgnored", False)):
            self.honour_range = honour
            self.requests = []
            urls = {name: f"{SCHEME}://app/{name}" for name in self.clips}
            outcome = self.js("spikePlayback(" + json.dumps(urls) + ")", timeout_s=240)
            result["playback"][label] = {
                "clips": outcome.get("v") if outcome.get("ok") else outcome,
                "requestCount": len(self.requests),
                "requestsWithNonZeroStart": sum(1 for r in self.requests if r.get("from", 0) > 0),
                "firstRequests": self.requests[:12],
            }
        # Control: the same clips over plain http with ranges.
        server = RangeServer(self.clips)
        urls = {name: f"http://127.0.0.1:{server.port}/{name}" for name in self.clips}
        outcome = self.js("spikePlayback(" + json.dumps(urls) + ")", timeout_s=240)
        result["playback"]["httpControl"] = {
            "clips": outcome.get("v") if outcome.get("ok") else outcome,
            "requestCount": len(server.log),
            "requestsWithNonZeroStart": sum(1 for r in server.log if r.get("from", 0) > 0),
            "firstRequests": server.log[:12],
        }
        server.httpd.shutdown()
        return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--fixture", action="append", help="a media file to serve and play as well (FAKE or public CC0 content only)")
    parser.add_argument("--save-clips", help="write the recorded clips here for analysis")
    parser.add_argument("--no-record", action="store_true", help="skip recording; play the fixtures only")
    parser.add_argument("--sizes", default="320x240,640x360,1280x720,1920x1080")
    parser.add_argument("--bps-per-pixel", type=float, default=2.7, help="target video bits/s per pixel (2.7 is 2.5 Mbit/s at 720p)")
    args = parser.parse_args()
    spike = Spike(args)
    result = spike.run()
    with open(args.out, "w") as handle:
        json.dump(result, handle, indent=1)
    print("wrote", args.out)


if __name__ == "__main__":
    main()
