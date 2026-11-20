// myCarlos #359 spike (PR 0): a probe that runs inside any webview.
//
// NOT SHIPPED. FAKE data only: the picture is a drawn canvas and the sound is a
// generated tone. No camera, no microphone, no real person, nothing is logged
// that names anyone. Every result is a plain JSON value.
//
// Two phases, so that a runner can serve the recorded bytes to the webview the
// way the app will (a custom scheme or a local server) before playback is tried:
//   phase 1  window.spikeRecord(options)  -> support, recordings (bytes in window.__clips)
//   phase 2  window.spikePlayback(urls)   -> metadata, duration, seeking per clip

(function () {
  const MP4_TYPES = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4;codecs=avc1",
    "video/mp4",
  ];
  const WEBM_TYPES = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hex = (u8, n) =>
    Array.from(u8.slice(0, n))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const fourcc = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);

  // ---- MP4 (ISO BMFF) reading: top-level boxes, and per-fragment times --------
  function topBoxes(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out = [];
    let p = 0;
    while (p + 8 <= u8.length) {
      let size = dv.getUint32(p);
      const type = fourcc(u8, p + 4);
      let header = 8;
      if (size === 1 && p + 16 <= u8.length) {
        size = Number(dv.getBigUint64(p + 8));
        header = 16;
      } else if (size === 0) size = u8.length - p;
      if (size < header) break;
      out.push({ type, pos: p, size, header });
      p += size;
    }
    return { boxes: out, trailingBytes: u8.length - p };
  }
  function children(u8, pos, size, header) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out = [];
    let p = pos + header;
    const end = pos + size;
    while (p + 8 <= end) {
      const s = dv.getUint32(p);
      if (s < 8) break;
      out.push({ type: fourcc(u8, p + 4), pos: p, size: s, header: 8 });
      p += s;
    }
    return out;
  }
  function parseMp4(u8) {
    const { boxes, trailingBytes } = topBoxes(u8);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const info = {
      topLevel: boxes.slice(0, 14).map((b) => b.type + ":" + b.size),
      boxCount: boxes.length,
      ftypCount: boxes.filter((b) => b.type === "ftyp").length,
      moovCount: boxes.filter((b) => b.type === "moov").length,
      moofCount: boxes.filter((b) => b.type === "moof").length,
      mdatCount: boxes.filter((b) => b.type === "mdat").length,
      mfraAtEnd: boxes.length > 0 && boxes[boxes.length - 1].type === "mfra",
      trailingBytes,
      tracks: [],
      fragments: [],
      orphanMoofs: 0,
      repeatedSequence: 0,
    };
    for (const b of boxes) {
      if (b.type !== "moov") continue;
      for (const trak of children(u8, b.pos, b.size, b.header).filter((c) => c.type === "trak")) {
        const t = {};
        for (const k of children(u8, trak.pos, trak.size, 8)) {
          if (k.type === "tkhd") {
            const ver = u8[k.pos + 8];
            t.id = dv.getUint32(k.pos + (ver === 1 ? 28 : 20));
          }
          if (k.type === "mdia") {
            for (const m of children(u8, k.pos, k.size, 8)) {
              if (m.type === "mdhd") {
                const ver = u8[m.pos + 8];
                t.timescale = dv.getUint32(m.pos + (ver === 1 ? 28 : 20));
              }
              if (m.type === "hdlr") t.kind = fourcc(u8, m.pos + 16);
            }
          }
        }
        info.tracks.push(t);
      }
    }
    let lastSeq = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.type !== "moof") continue;
      if (!boxes[i + 1] || boxes[i + 1].type !== "mdat") info.orphanMoofs++;
      const f = { moofPos: b.pos, tracks: {} };
      for (const k of children(u8, b.pos, b.size, b.header)) {
        if (k.type === "mfhd") f.seq = dv.getUint32(k.pos + 12);
        if (k.type !== "traf") continue;
        const tr = {};
        let trackId = 0;
        for (const r of children(u8, k.pos, k.size, 8)) {
          if (r.type === "tfhd") trackId = dv.getUint32(r.pos + 12);
          if (r.type === "tfdt") {
            const ver = u8[r.pos + 8];
            tr.tfdt = ver === 1 ? Number(dv.getBigUint64(r.pos + 12)) : dv.getUint32(r.pos + 12);
          }
          if (r.type === "trun") {
            tr.samples = dv.getUint32(r.pos + 12);
            const flags = (u8[r.pos + 9] << 8) | u8[r.pos + 10];
            tr.durationInTrun = (flags & 0x100) !== 0;
            if (tr.durationInTrun) {
              let o = r.pos + 16 + ((u8[r.pos + 11] & 1) ? 4 : 0) + ((u8[r.pos + 11] & 4) ? 4 : 0);
              let sum = 0;
              for (let n = 0; n < tr.samples; n++) {
                sum += dv.getUint32(o);
                o += 4 + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
              }
              tr.durationSum = sum;
            }
          }
        }
        f.tracks[trackId] = tr;
      }
      if (f.seq !== undefined) {
        if (f.seq === lastSeq) info.repeatedSequence++;
        lastSeq = f.seq;
      }
      info.fragments.push(f);
    }
    // Per track: samples, the span of times, and the largest jump between one
    // fragment and the next (a pause that left a gap shows as a large jump).
    info.perTrack = {};
    for (const t of info.tracks) {
      const frs = info.fragments
        .filter((f) => f.tracks[t.id] && f.tracks[t.id].tfdt !== undefined)
        .map((f) => f.tracks[t.id]);
      let samples = 0;
      let maxJump = 0;
      for (let i = 0; i < frs.length; i++) {
        samples += frs[i].samples || 0;
        if (i > 0 && t.timescale) {
          const expected =
            frs[i - 1].durationSum !== undefined ? frs[i - 1].durationSum : null;
          const jump = frs[i].tfdt - frs[i - 1].tfdt;
          const over = expected === null ? jump : jump - expected;
          maxJump = Math.max(maxJump, Math.abs(over) / t.timescale);
        }
      }
      info.perTrack[t.kind || t.id] = {
        timescale: t.timescale,
        fragments: frs.length,
        samples,
        firstTfdt: frs.length ? frs[0].tfdt : null,
        lastTfdt: frs.length ? frs[frs.length - 1].tfdt : null,
        // seconds; null when the trun carries no per-sample durations
        maxGapOrOverlapSeconds: Number(maxJump.toFixed(3)),
      };
    }
    delete info.fragments;
    return info;
  }
  function findBytes(u8, pattern) {
    outer: for (let i = 0; i + pattern.length <= u8.length; i++) {
      for (let j = 0; j < pattern.length; j++) if (u8[i + j] !== pattern[j]) continue outer;
      return true;
    }
    return false;
  }
  function parseWebm(u8) {
    const has = (...b) => findBytes(u8, b);
    return {
      ebmlHeader: hex(u8, 4) === "1a45dfa3",
      clusters: (() => {
        let n = 0;
        for (let i = 0; i + 4 <= u8.length; i++)
          if (u8[i] === 0x1f && u8[i + 1] === 0x43 && u8[i + 2] === 0xb6 && u8[i + 3] === 0x75) n++;
        return n;
      })(),
      hasDuration: has(0x44, 0x89),
      hasCues: has(0x1c, 0x53, 0xbb, 0x6b),
      hasSeekHead: has(0x11, 0x4d, 0x9b, 0x74),
    };
  }

  // ---- fake sources -----------------------------------------------------------
  async function makeSources(width, height, fps) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.style.cssText = "position:fixed;left:0;top:0;width:160px;height:90px;opacity:.01";
    document.body.appendChild(canvas);
    const cx = canvas.getContext("2d");
    const state = { drawn: 0, paused: false, drawnWhilePaused: 0 };
    const draw = () => {
      cx.fillStyle = "hsl(" + ((state.drawn * 5) % 360) + ",55%,45%)";
      cx.fillRect(0, 0, width, height);
      // Detail that is hard to compress, so the encoder works as it would on a real picture.
      for (let i = 0; i < 160; i++) {
        cx.fillStyle = "rgba(" + ((i * 37 + state.drawn * 11) & 255) + "," + ((i * 91) & 255) + "," + ((i * 53 + state.drawn * 3) & 255) + ",0.7)";
        cx.fillRect(((i * 97 + state.drawn * 13) % width) | 0, ((i * 61 + state.drawn * 7) % height) | 0, 48, 28);
      }
      cx.fillStyle = "#fff";
      cx.font = Math.round(height / 12) + "px sans-serif";
      cx.fillText("FAKE " + state.drawn, 24, Math.round(height / 6));
      state.drawn++;
      if (state.paused) state.drawnWhilePaused++;
    };
    draw();
    const timer = setInterval(draw, 1000 / fps);
    const videoStream = canvas.captureStream(fps);
    let audioStream = null;
    let audio = { state: "none" };
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ac.createOscillator();
      osc.frequency.value = 440;
      const gain = ac.createGain();
      gain.gain.value = 0.05;
      const dest = ac.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      audio = { state: ac.state };
      if (ac.state === "suspended") {
        await Promise.race([ac.resume().catch(() => {}), sleep(1500)]);
        audio.stateAfterResume = ac.state;
      }
      audioStream = dest.stream;
      audio.tracks = audioStream.getAudioTracks().length;
    } catch (e) {
      audio.error = String(e);
    }
    return {
      state,
      videoStream,
      audioStream,
      audio,
      stop() {
        clearInterval(timer);
        canvas.remove();
        for (const t of videoStream.getTracks()) t.stop();
      },
    };
  }

  // ---- phase 1: recording -----------------------------------------------------
  async function recordOne({ mime, width, height, fps, videoBps, audioBps, seconds, pauseAt, pauseFor, withAudio, timeslice }) {
    const result = { mime, width, height, fps, requestedVideoBps: videoBps, withAudio };
    const src = await makeSources(width, height, fps);
    result.audioSource = src.audio;
    try {
      const tracks = [...src.videoStream.getVideoTracks()];
      if (withAudio && src.audioStream) tracks.push(...src.audioStream.getAudioTracks());
      const stream = new MediaStream(tracks);
      result.streamAudioTracks = stream.getAudioTracks().length;
      let rec;
      try {
        rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: videoBps, audioBitsPerSecond: audioBps });
      } catch (e) {
        result.constructError = String(e);
        return result;
      }
      result.recorderMimeType = rec.mimeType;
      const chunks = [];
      const pieces = [];
      const events = [];
      const t0 = performance.now();
      const at = () => Math.round(performance.now() - t0);
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) {
          chunks.push(e.data);
          pieces.push([at(), e.data.size]);
        }
      };
      rec.onerror = (e) => events.push("error@" + at() + ":" + String(e.error || e.type));
      rec.onpause = () => events.push("pause@" + at());
      rec.onresume = () => events.push("resume@" + at());
      const stopped = new Promise((r) => (rec.onstop = r));
      try {
        rec.start(timeslice);
      } catch (e) {
        result.startError = String(e);
        return result;
      }
      events.push("start@" + at());
      let activeMs = 0;
      let lastActive = at();
      const wait = async (ms) => sleep(ms);
      if (pauseAt > 0) {
        await wait(pauseAt * 1000);
        activeMs += at() - lastActive;
        src.state.paused = true;
        try {
          rec.pause();
          result.stateAfterPause = rec.state;
        } catch (e) {
          result.pauseError = String(e);
        }
        const tracksToToggle = stream.getTracks();
        for (const t of tracksToToggle) t.enabled = false; // Q10: open but switched off
        await wait(pauseFor * 1000);
        for (const t of tracksToToggle) t.enabled = true;
        src.state.paused = false;
        try {
          rec.resume();
          result.stateAfterResume = rec.state;
        } catch (e) {
          result.resumeError = String(e);
        }
        lastActive = at();
        await wait((seconds - pauseAt) * 1000);
        activeMs += at() - lastActive;
      } else {
        await wait(seconds * 1000);
        activeMs = at();
      }
      rec.stop();
      await Promise.race([stopped, sleep(8000)]);
      events.push("stop@" + at());
      result.events = events;
      result.pieces = pieces;
      result.pieceCount = pieces.length;
      result.firstPieceMs = pieces.length ? pieces[0][0] : null;
      result.pieceGapsMs = pieces.slice(1).map((p, i) => p[0] - pieces[i][0]);
      result.activeSeconds = Number((activeMs / 1000).toFixed(2));
      result.framesDrawn = src.state.drawn;
      result.framesDrawnWhilePaused = src.state.drawnWhilePaused;
      const blob = new Blob(chunks, { type: rec.mimeType || mime });
      result.bytes = blob.size;
      result.achievedVideoPlusAudioMbps = Number(((blob.size * 8) / Math.max(1, activeMs / 1000) / 1e6).toFixed(2));
      const u8 = new Uint8Array(await blob.arrayBuffer());
      result.firstBytes = hex(u8, 16);
      result.firstPieceTopLevel = chunks.length ? topBoxes(new Uint8Array(await chunks[0].arrayBuffer())).boxes.slice(0, 6).map((b) => b.type + ":" + b.size) : [];
      try {
        result.container = /mp4/.test(rec.mimeType || mime) ? parseMp4(u8) : parseWebm(u8);
        if (result.container.perTrack && result.container.perTrack.vide) {
          const v = result.container.perTrack.vide;
          result.videoFramesInFile = v.samples;
          result.expectedFrames = Math.round(fps * result.activeSeconds);
          result.droppedFramesApprox = Math.max(0, result.expectedFrames - v.samples);
        }
      } catch (e) {
        result.parseError = String(e);
      }
      // Hand the bytes to the runner (base64), under a name.
      const name = ["clip", width + "x" + height, (rec.mimeType || mime).split(";")[0].split("/")[1], withAudio ? "av" : "v"].join("-") + (pauseAt > 0 ? "-paused" : "");
      let bin = "";
      const step = 0x8000;
      for (let i = 0; i < u8.length; i += step) bin += String.fromCharCode.apply(null, u8.subarray(i, i + step));
      window.__clips = window.__clips || {};
      window.__clips[name] = { b64: btoa(bin), type: (rec.mimeType || mime).split(";")[0] };
      result.clipName = name;
      return result;
    } finally {
      src.stop();
    }
  }

  // One combination at a time, so that a runner can measure each (CPU, battery).
  window.spikeSupport = function () {
    const support = {};
    if (typeof MediaRecorder === "undefined") return { hasMediaRecorder: "undefined", support };
    for (const m of [...MP4_TYPES, ...WEBM_TYPES]) {
      try {
        support[m] = MediaRecorder.isTypeSupported(m);
      } catch (e) {
        support[m] = "error " + e;
      }
    }
    const firstOf = (list) => list.find((m) => support[m] === true) || null;
    return {
      userAgent: navigator.userAgent,
      hasMediaRecorder: typeof MediaRecorder,
      hasMediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      support,
      firstMp4: firstOf(MP4_TYPES),
      firstWebm: firstOf(WEBM_TYPES),
    };
  };
  window.spikeRecordOne = function (params) {
    const p = Object.assign(
      { fps: 30, audioBps: 96000, seconds: 6, pauseAt: 0, pauseFor: 1.5, timeslice: 1000, withAudio: true },
      params
    );
    return recordOne(p);
  };

  window.spikeRecord = async function (options) {
    const o = Object.assign(
      {
        sizes: [[1280, 720, 2500000], [1920, 1080, 7000000]],
        fps: 30,
        seconds: 6,
        pauseAt: 2.5,
        pauseFor: 1.5,
        audioBps: 96000,
        timeslice: 1000,
        types: null, // null = every type the webview says it supports, one per container
        withAudio: true,
      },
      options || {}
    );
    const out = {
      userAgent: navigator.userAgent,
      hasMediaRecorder: typeof MediaRecorder,
      hasMediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      support: {},
      recordings: [],
    };
    window.__out = out;
    if (typeof MediaRecorder === "undefined") return out;
    for (const m of [...MP4_TYPES, ...WEBM_TYPES]) {
      try {
        out.support[m] = MediaRecorder.isTypeSupported(m);
      } catch (e) {
        out.support[m] = "error " + e;
      }
    }
    const firstOf = (list) => list.find((m) => out.support[m] === true);
    const chosen = o.types || [firstOf(MP4_TYPES), firstOf(WEBM_TYPES)].filter(Boolean);
    for (const mime of chosen) {
      for (const [width, height, videoBps] of o.sizes) {
        for (const withAudio of o.withAudio ? [true, false] : [false]) {
          // Audio + video with a pause is the case that matters; the others are short.
          const full = withAudio && width === o.sizes[0][0];
          const r = await recordOne({
            mime, width, height, fps: o.fps, videoBps, audioBps: o.audioBps,
            seconds: full ? o.seconds : Math.min(o.seconds, 4),
            pauseAt: full ? o.pauseAt : 0,
            pauseFor: o.pauseFor,
            withAudio,
            timeslice: o.timeslice,
          });
          out.recordings.push(r);
        }
      }
    }
    return out;
  };

  // ---- phase 2: playback and seeking ------------------------------------------
  async function playOne(name, url) {
    const r = { name, url: url.replace(/^(\w+:\/\/[^/]*).*/, "$1/…") };
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.style.cssText = "position:fixed;right:0;bottom:0;width:160px;height:90px";
    document.body.appendChild(v);
    const t0 = performance.now();
    r.canPlay = {
      mp4: v.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
      webm: v.canPlayType('video/webm; codecs="vp8, opus"'),
    };
    r.mediaEvents = [];
    for (const e of ["loadstart", "suspend", "stalled", "error", "emptied", "abort", "loadeddata", "canplay", "waiting"])
      v.addEventListener(e, () => r.mediaEvents.push(e + "@" + Math.round(performance.now() - t0)));
    const waitFor = (event, ms) =>
      new Promise((res) => {
        const done = (ok) => {
          v.removeEventListener(event, onEvent);
          res(ok);
        };
        const onEvent = () => done(true);
        v.addEventListener(event, onEvent, { once: true });
        setTimeout(() => done(false), ms);
      });
    try {
      v.src = url;
      const meta = await Promise.race([
        waitFor("loadedmetadata", 12000),
        new Promise((res) => v.addEventListener("error", () => res(false), { once: true })),
      ]);
      r.metadata = meta;
      r.metadataMs = Math.round(performance.now() - t0);
      r.networkState = v.networkState;
      r.readyState = v.readyState;
      r.pageVisibility = document.visibilityState;
      if (v.error) r.error = { code: v.error.code, message: v.error.message };
      if (!meta) return r;
      r.duration = v.duration;
      r.durationFinite = Number.isFinite(v.duration);
      r.size = [v.videoWidth, v.videoHeight];
      r.seekable = v.seekable.length ? [v.seekable.start(0), v.seekable.end(v.seekable.length - 1)] : null;
      const total = Number.isFinite(v.duration) ? v.duration : r.seekable ? r.seekable[1] : 0;
      r.seeks = [];
      for (const target of [total * 0.5, total * 0.9, total * 0.1, Math.max(0, total - 0.4)]) {
        if (!(total > 0)) break;
        const s = { target: Number(target.toFixed(2)) };
        const started = performance.now();
        v.currentTime = target;
        s.seeked = await waitFor("seeked", 8000);
        s.ms = Math.round(performance.now() - started);
        s.landed = Number(v.currentTime.toFixed(2));
        s.readyState = v.readyState;
        r.seeks.push(s);
      }
      // Play a moment: does time move?
      v.currentTime = 0;
      await waitFor("seeked", 4000);
      const before = v.currentTime;
      try {
        await v.play();
      } catch (e) {
        r.playError = String(e);
      }
      await sleep(1500);
      r.playedSeconds = Number((v.currentTime - before).toFixed(2));
      v.pause();
      if (v.error) r.error = { code: v.error.code, message: v.error.message };
    } catch (e) {
      r.exception = String(e);
    } finally {
      v.removeAttribute("src");
      v.load();
      v.remove();
    }
    return r;
  }
  window.spikePlayback = async function (urls) {
    const out = [];
    for (const [name, url] of Object.entries(urls)) out.push(await playOne(name, url));
    return out;
  };
  window.spikeClipNames = () => Object.keys(window.__clips || {});
  window.spikeClip = (name) => window.__clips[name];
})();
