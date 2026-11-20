// myCarlos #359 spike (PR 0): runs the probe in a Chromium that Playwright launches.
// NOT SHIPPED. FAKE canvas and tone sources only; no camera, no microphone.
//
//   node chromium_runner.mjs --out result.json [--engine chromium|webkit|firefox] [--channel chrome|msedge]
//                            [--executable /path/to/browser] [--fixture file ...] [--reply-cap 262144]
//
// Playwright's own Chromium has no H.264, so MP4 recording shows as unsupported there; a Chrome with
// H.264 (the CI job on Windows, macOS and Linux) can be given with --executable. This is Chromium
// as a stand-in for WebView2 and Android WebView, not those webviews themselves. Playback is
// over plain http with ranges (a Playwright page cannot register the app's custom scheme).
import { chromium, webkit, firefox } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const probeDir = path.join(here, "..", "probe");
const argv = process.argv.slice(2);
const arg = (name, many = false) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name) out.push(argv[i + 1]);
  return many ? out : out[0];
};
const outPath = arg("--out");
const executable = arg("--executable");
const engine = arg("--engine") || "chromium";
const channel = arg("--channel");
const fixtures = arg("--fixture", true);
const sizes = (arg("--sizes") || "320x240,640x360,1280x720,1920x1080").split(",").map((s) => s.split("x").map(Number));
const bpsPerPixel = Number(arg("--bps-per-pixel") || 2.7);
// Answer an open-ended range with at most this many bytes, as the design's reply cap does (0 = no cap).
const replyCap = Number(arg("--reply-cap") || 0);

const clips = new Map();
const log = [];
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.split("?")[0].slice(1));
  if (name === "probe.html" || name === "probe.js") {
    res.writeHead(200, { "Content-Type": name.endsWith("html") ? "text/html" : "text/javascript" });
    res.end(fs.readFileSync(path.join(probeDir, name)));
    return;
  }
  const clip = clips.get(name);
  if (!clip) {
    res.writeHead(404).end();
    return;
  }
  const total = clip.data.length;
  const range = req.headers.range;
  let start = 0, end = total - 1, status = 200;
  if (range?.startsWith("bytes=")) {
    const [first, last] = range.slice(6).split("-");
    start = first ? Number(first) : Math.max(0, total - Number(last));
    end = first && last ? Math.min(Number(last), total - 1) : total - 1;
    if (replyCap && !last) end = Math.min(end, start + replyCap - 1);
    status = 206;
  }
  log.push({ path: name, range: range ?? null, status, from: start, to: end });
  const headers = { "Content-Type": clip.type, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
  res.writeHead(status, headers);
  res.end(clip.data.subarray(start, end + 1));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const launcher = { chromium, webkit, firefox }[engine];
const browser = await launcher.launch({
  headless: true,
  executablePath: executable || undefined,
  channel: channel || undefined,
  args: engine === "chromium" ? ["--autoplay-policy=no-user-gesture-required"] : [],
});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/probe.html`);
const result = { runner: "chromium_runner.mjs", engine, channel: channel || null, browser: browser.version(), executable: executable || "playwright " + engine };
result.support = await page.evaluate(() => window.spikeSupport());
const plan = [];
for (const mime of [result.support.firstMp4, result.support.firstWebm].filter(Boolean)) {
  sizes.forEach(([w, h], index) => {
    const bps = Math.round(bpsPerPixel * w * h);
    if (index === 0) plan.push([mime, w, h, bps, true, true]);
    plan.push([mime, w, h, bps, false, false]);
    if (w >= 1280) plan.push([mime, w, h, bps, true, false]);
  });
}
result.recordings = [];
for (const [mime, width, height, videoBps, withAudio, pause] of plan) {
  const params = { mime, width, height, videoBps, withAudio, seconds: 7, pauseAt: pause ? 2.5 : 0, pauseFor: 1.5 };
  const t0 = Date.now();
  const rec = await page.evaluate((p) => window.spikeRecordOne(p), params);
  rec.wallSeconds = (Date.now() - t0) / 1000;
  result.recordings.push(rec);
}
for (const name of await page.evaluate(() => window.spikeClipNames())) {
  const clip = await page.evaluate((n) => window.spikeClip(n), name);
  clips.set(name, { data: Buffer.from(clip.b64, "base64"), type: clip.type });
}
for (const file of fixtures) {
  clips.set("fixture-" + path.basename(file), { data: fs.readFileSync(file), type: file.endsWith(".webm") ? "video/webm" : "video/mp4" });
}
if (arg("--save-clips")) {
  fs.mkdirSync(arg("--save-clips"), { recursive: true });
  for (const [name, c] of clips) fs.writeFileSync(path.join(arg("--save-clips"), name + (c.type.includes("webm") ? ".webm" : ".mp4")), c.data);
}
const urls = Object.fromEntries([...clips.keys()].map((n) => [n, `http://127.0.0.1:${port}/${n}`]));
log.length = 0;
const clipsOut = await page.evaluate((u) => window.spikePlayback(u), urls);
result.playback = {
  http: {
    clips: clipsOut,
    requestCount: log.length,
    requestsWithNonZeroStart: log.filter((r) => r.from > 0).length,
    firstRequests: log.slice(0, 12),
  },
};
fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
await browser.close();
server.close();
console.log("wrote", outPath);
