// myCarlos #359 spike: how much of a LONG clip does the engine read before it can play and show a length?
// FAKE sources only. Records one clip of --seconds, serves it with ranges (capped replies), and counts the
// bytes served up to the moment loadedmetadata fires. If that is close to the file size, opening a multi-GB
// video would decrypt the whole file first; if it is small, the design's "decrypt only what is watched" holds.
import { chromium, webkit } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const seconds = Number(arg("--seconds", 45));
const engine = arg("--engine", "chromium");
const cap = Number(arg("--reply-cap", 262144));
const clips = new Map();
const log = [];
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.split("?")[0].slice(1));
  if (name === "probe.html" || name === "probe.js") {
    res.writeHead(200, { "Content-Type": name.endsWith("html") ? "text/html" : "text/javascript" });
    return res.end(fs.readFileSync(path.join(here, "..", "probe", name)));
  }
  const clip = clips.get(name);
  if (!clip) return res.writeHead(404).end();
  const total = clip.data.length;
  const range = req.headers.range;
  let start = 0, end = total - 1, status = 200;
  if (range?.startsWith("bytes=")) {
    const [f, l] = range.slice(6).split("-");
    start = f ? Number(f) : Math.max(0, total - Number(l));
    end = f && l ? Math.min(Number(l), total - 1) : total - 1;
    if (cap && !l) end = Math.min(end, start + cap - 1);
    status = 206;
  }
  log.push({ from: start, to: end, n: end - start + 1 });
  const h = { "Content-Type": clip.type, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 };
  if (status === 206) h["Content-Range"] = `bytes ${start}-${end}/${total}`;
  res.writeHead(status, h);
  res.end(clip.data.subarray(start, end + 1));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await { chromium, webkit }[engine].launch({ headless: true, channel: arg("--channel"), args: engine === "chromium" ? ["--autoplay-policy=no-user-gesture-required"] : [] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/probe.html`);
const support = await page.evaluate(() => window.spikeSupport());
const mime = support.firstMp4 || support.firstWebm;
const rec = await page.evaluate((p) => window.spikeRecordOne(p), { mime, width: 1280, height: 720, videoBps: 2500000, withAudio: true, seconds, pauseAt: 0 });
const clip = await page.evaluate((n) => window.spikeClip(n), rec.clipName);
clips.set(rec.clipName, { data: Buffer.from(clip.b64, "base64"), type: clip.type });
log.length = 0;
const out = await page.evaluate((u) => window.spikePlayback(u, true), { [rec.clipName]: `http://127.0.0.1:${port}/${rec.clipName}` });
const served = log.reduce((a, r) => a + r.n, 0);
const total = clips.get(rec.clipName).data.length;
const result = {
  engine, browser: browser.version(), mime: rec.recorderMimeType, recordedSeconds: seconds, fileBytes: total,
  metadata: out[0].metadata, metadataMs: out[0].metadataMs, duration: out[0].duration,
  requestsBeforeMetadata: log.length, bytesServedBeforeMetadata: served, fractionOfFile: Number((served / total).toFixed(3)),
  firstRequests: log.slice(0, 10),
};
console.log(JSON.stringify(result, null, 1));
fs.writeFileSync(arg("--out", "long-clip.json"), JSON.stringify(result, null, 1));
await browser.close(); server.close();
