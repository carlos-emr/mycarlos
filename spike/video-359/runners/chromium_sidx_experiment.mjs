// myCarlos #359 spike: does a small index in front of the fragments let the engine open a long clip
// without reading it all? Records one FAKE clip, then serves two versions of the same bytes:
//   as recorded                    (ftyp moov moof mdat ...)
//   with a sidx after the moov     (ftyp moov sidx moof mdat ...), the "synthetic head" of design 4.3 B
// and counts the bytes served before loadedmetadata for each. FAKE sources only.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const seconds = Number(arg("--seconds", 60));
const cap = Number(arg("--reply-cap", 262144));

function boxes(buf) {
  const out = [];
  let p = 0;
  while (p + 8 <= buf.length) {
    const size = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    if (size < 8) break;
    out.push({ type, pos: p, size });
    p += size;
  }
  return out;
}
function child(buf, box, type) {
  let p = box.pos + 8;
  while (p + 8 <= box.pos + box.size) {
    const s = buf.readUInt32BE(p);
    if (buf.toString("latin1", p + 4, p + 8) === type) return { type, pos: p, size: s };
    p += s;
  }
  return null;
}
function fragmentsOf(buf, trackId) {
  const top = boxes(buf);
  const out = [];
  for (const b of top) {
    if (b.type !== "moof") continue;
    let tfdt = null;
    let p = b.pos + 8;
    while (p + 8 <= b.pos + b.size) {
      const s = buf.readUInt32BE(p);
      if (buf.toString("latin1", p + 4, p + 8) === "traf") {
        let q = p + 8, id = 0;
        while (q + 8 <= p + s) {
          const rs = buf.readUInt32BE(q);
          const rt = buf.toString("latin1", q + 4, q + 8);
          if (rt === "tfhd") id = buf.readUInt32BE(q + 12);
          if (rt === "tfdt" && id === trackId) tfdt = buf[q + 8] === 1 ? Number(buf.readBigUInt64BE(q + 12)) : buf.readUInt32BE(q + 12);
          q += rs;
        }
      }
      p += s;
    }
    out.push({ moofPos: b.pos, tfdt });
  }
  return out;
}
// The trailing index of design 4.3 A: an mfra box (tfra per track, then mfro) at the end of the file.
function addMfra(buf) {
  const top = boxes(buf);
  const moov = top.find((b) => b.type === "moov");
  const trak = child(buf, moov, "trak");
  const tkhd = child(buf, trak, "tkhd");
  const trackId = buf.readUInt32BE(tkhd.pos + (buf[tkhd.pos + 8] === 1 ? 28 : 20));
  const frags = fragmentsOf(buf, trackId);
  const tfra = Buffer.alloc(16 + 4 + frags.length * 11 + 4);
  // tfra: size, type, version/flags, track_ID, length sizes (all 0 = one byte each), entry count, entries
  let o = 0;
  tfra.writeUInt32BE(tfra.length - 0, o); o += 4;
  tfra.write("tfra", o, "latin1"); o += 4;
  tfra.writeUInt32BE(0, o); o += 4; // version 0
  tfra.writeUInt32BE(trackId, o); o += 4;
  tfra.writeUInt32BE(0, o); o += 4; // reserved + length_size_of_traf/trun/sample (0 = 1 byte)
  tfra.writeUInt32BE(frags.length, o); o += 4;
  for (const f of frags) {
    tfra.writeUInt32BE(f.tfdt, o); o += 4;
    tfra.writeUInt32BE(f.moofPos, o); o += 4;
    tfra[o++] = 1; tfra[o++] = 1; tfra[o++] = 1;
  }
  const tfraBox = tfra.subarray(0, o);
  tfraBox.writeUInt32BE(tfraBox.length, 0);
  const mfro = Buffer.alloc(16);
  mfro.writeUInt32BE(16, 0);
  mfro.write("mfro", 4, "latin1");
  mfro.writeUInt32BE(0, 8);
  const mfraSize = 8 + tfraBox.length + 16;
  mfro.writeUInt32BE(mfraSize, 12);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(mfraSize, 0);
  head.write("mfra", 4, "latin1");
  return { data: Buffer.concat([buf, head, tfraBox, mfro]), mfraBytes: mfraSize };
}
function addSidx(buf) {
  const top = boxes(buf);
  const moov = top.find((b) => b.type === "moov");
  // timescale of the first track
  const trak = child(buf, moov, "trak");
  const mdia = child(buf, trak, "mdia");
  const mdhd = child(buf, mdia, "mdhd");
  const ver = buf[mdhd.pos + 8];
  const timescale = buf.readUInt32BE(mdhd.pos + (ver === 1 ? 28 : 20));
  const tkhd = child(buf, trak, "tkhd");
  const trackId = buf.readUInt32BE(tkhd.pos + (buf[tkhd.pos + 8] === 1 ? 28 : 20));
  const frags = [];
  for (let i = 0; i < top.length; i++) {
    if (top[i].type !== "moof") continue;
    const mdat = top[i + 1];
    let tfdt = null;
    let p = top[i].pos + 8;
    while (p + 8 <= top[i].pos + top[i].size) {
      const s = buf.readUInt32BE(p);
      if (buf.toString("latin1", p + 4, p + 8) === "traf") {
        let q = p + 8;
        let id = 0;
        while (q + 8 <= p + s) {
          const rs = buf.readUInt32BE(q);
          const rt = buf.toString("latin1", q + 4, q + 8);
          if (rt === "tfhd") id = buf.readUInt32BE(q + 12);
          if (rt === "tfdt" && id === trackId) tfdt = buf[q + 8] === 1 ? Number(buf.readBigUInt64BE(q + 12)) : buf.readUInt32BE(q + 12);
          q += rs;
        }
      }
      p += s;
    }
    frags.push({ size: top[i].size + mdat.size, tfdt });
  }
  const refs = frags.map((f, i) => {
    const next = frags[i + 1] ? frags[i + 1].tfdt : f.tfdt + (frags[i - 1] ? f.tfdt - frags[i - 1].tfdt : timescale);
    return { size: f.size, duration: next - f.tfdt };
  });
  const sidx = Buffer.alloc(32 + refs.length * 12);
  sidx.writeUInt32BE(sidx.length, 0);
  sidx.write("sidx", 4, "latin1");
  sidx.writeUInt32BE(0, 8); // version 0, flags 0
  sidx.writeUInt32BE(trackId, 12);
  sidx.writeUInt32BE(timescale, 16);
  sidx.writeUInt32BE(frags[0].tfdt, 20); // earliest presentation time
  sidx.writeUInt32BE(0, 24); // first offset: the first fragment follows the sidx
  sidx.writeUInt16BE(0, 28);
  sidx.writeUInt16BE(refs.length, 30);
  refs.forEach((r, i) => {
    sidx.writeUInt32BE(r.size & 0x7fffffff, 32 + i * 12); // reference type 0 = media
    sidx.writeUInt32BE(r.duration, 36 + i * 12);
    sidx.writeUInt32BE(0x90000000, 40 + i * 12); // starts with SAP, type 1
  });
  const at = moov.pos + moov.size;
  return { data: Buffer.concat([buf.subarray(0, at), sidx, buf.subarray(at)]), fragments: frags.length, sidxBytes: sidx.length };
}

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
  log.push({ n: end - start + 1 });
  const h = { "Content-Type": clip.type, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 };
  if (status === 206) h["Content-Range"] = `bytes ${start}-${end}/${total}`;
  res.writeHead(status, h);
  res.end(clip.data.subarray(start, end + 1));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await chromium.launch({ headless: true, channel: arg("--channel"), args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/probe.html`);
const support = await page.evaluate(() => window.spikeSupport());
const rec = await page.evaluate((p) => window.spikeRecordOne(p), { mime: support.firstMp4, width: 1280, height: 720, videoBps: 2500000, withAudio: true, seconds, pauseAt: 0 });
const clip = await page.evaluate((n) => window.spikeClip(n), rec.clipName);
const original = Buffer.from(clip.b64, "base64");
const indexed = addSidx(original);
clips.set("as-recorded", { data: original, type: clip.type });
clips.set("with-sidx", { data: indexed.data, type: clip.type });
const withMfra = addMfra(original);
clips.set("with-mfra", { data: withMfra.data, type: clip.type });
const result = { browser: browser.version(), mime: rec.recorderMimeType, seconds, fragments: indexed.fragments, sidxBytes: indexed.sidxBytes, variants: {} };
for (const name of ["as-recorded", "with-sidx", "with-mfra"]) {
  log.length = 0;
  const out = await page.evaluate((u) => window.spikePlayback(u, false), { [name]: `http://127.0.0.1:${port}/${name}` });
  const served = log.reduce((a, r) => a + r.n, 0);
  const c = out[0];
  result.variants[name] = {
    fileBytes: clips.get(name).data.length, metadata: c.metadata, metadataMs: c.metadataMs, duration: c.duration, error: c.error ?? null,
    seeks: (c.seeks || []).map((s) => [s.target, s.seeked, s.landed, s.ms]), playedSeconds: c.playedSeconds,
    requestsTotal: log.length, bytesServedTotal: served,
  };
}
// And the metadata-only cost of each (fresh page state is not needed: the cache is per element).
for (const name of ["as-recorded", "with-sidx", "with-mfra"]) {
  log.length = 0;
  const out = await page.evaluate((u) => window.spikePlayback(u, true), { [name]: `http://127.0.0.1:${port}/${name}?m=${Math.random()}` });
  const served = log.reduce((a, r) => a + r.n, 0);
  result.variants[name].bytesBeforeMetadata = served;
  result.variants[name].fractionBeforeMetadata = Number((served / clips.get(name).data.length).toFixed(3));
  result.variants[name].metadataMs2 = out[0].metadataMs;
}
console.log(JSON.stringify(result, null, 1));
fs.writeFileSync(arg("--out", "sidx.json"), JSON.stringify(result, null, 1));
await browser.close(); server.close();
