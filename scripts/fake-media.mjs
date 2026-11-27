// FAKE demo picture and video generators for dev-data/ (standard library only, deterministic).
//
// - A JPEG with FAKE GPS in its EXIF, and a PNG with FAKE text and EXIF details: test patterns that
//   show the app's metadata cleaning on a picture. The JPEG is a baseline DC-only encoding (each
//   8x8 block one flat colour), so there is no image library and the file is a few hundred bytes.
// - A 2 s, 160x112 clip: H.264 baseline made of I_PCM macroblocks (uncompressed, every frame a
//   keyframe) in a plain, non-fragmented MP4 with the movie box first, the shape the video import
//   (`video_import::analyse`) accepts. About 0.5 MB.
// Nothing here is real content: colour bars, the word FAKE and made-up coordinates.
import { Buffer } from "node:buffer";

// ---------- shared: a tiny pixel font ----------
const FONT = {
  F: ["11111", "10000", "11110", "10000", "10000", "10000", "10000"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  E: ["11111", "10000", "11110", "10000", "10000", "10000", "11111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  9: ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
};

/** Calls `plot(x, y)` for each lit pixel of `string`, each font pixel `scale` pixels square. */
function drawText(string, x0, y0, scale, plot) {
  let x = x0;
  for (const character of string) {
    FONT[character].forEach((row, gy) => {
      [...row].forEach((bit, gx) => {
        if (bit !== "1") return;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            plot(x + gx * scale + sx, y0 + gy * scale + sy);
          }
        }
      });
    });
    x += 6 * scale;
  }
}

// ---------- EXIF with FAKE GPS ----------
const be16 = (value) => Buffer.from([(value >> 8) & 255, value & 255]);
const be32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
};

/** A big-endian TIFF block: IFD0 holding only a GPS pointer, and a GPS IFD with a latitude and a
 * longitude in whole degrees (N and E). The values are made up, in the Gulf of Guinea. */
export function fakeGpsTiff(latitude, longitude) {
  const entry = (tag, type, count, value) =>
    Buffer.concat([be16(tag), be16(type), be32(count), value]);
  const ascii = (letter) =>
    Buffer.concat([Buffer.from(letter), Buffer.from([0, 0, 0])]);
  const gpsAt = 8 + 2 + 12 + 4; // after the header and IFD0
  const ratAt = gpsAt + 2 + 4 * 12 + 4; // after the GPS IFD
  const rationals = (degrees) =>
    Buffer.concat([be32(degrees), be32(1), be32(0), be32(1), be32(0), be32(1)]);
  return Buffer.concat([
    Buffer.from("MM"),
    be16(42),
    be32(8),
    be16(1),
    entry(0x8825, 4, 1, be32(gpsAt)),
    be32(0),
    be16(4),
    entry(1, 2, 2, ascii("N")),
    entry(2, 5, 3, be32(ratAt)),
    entry(3, 2, 2, ascii("E")),
    entry(4, 5, 3, be32(ratAt + 24)),
    be32(0),
    rationals(latitude),
    rationals(longitude),
  ]);
}

// ---------- JPEG (baseline, DC only) ----------
const DC_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_COUNTS = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const AC_VALUES = [0]; // only end-of-block: every block is one flat colour

function canonicalCodes(counts, values) {
  const codes = new Map();
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length++) {
    for (let n = 0; n < counts[length - 1]; n++) {
      codes.set(values[index++], { code, length });
      code++;
    }
    code <<= 1;
  }
  return codes;
}

class BitSink {
  constructor() {
    this.bytes = [];
    this.accumulator = 0;
    this.count = 0;
  }
  put(value, length) {
    for (let bit = length - 1; bit >= 0; bit--) {
      this.accumulator = (this.accumulator << 1) | ((value >> bit) & 1);
      if (++this.count === 8) {
        this.bytes.push(this.accumulator);
        if (this.accumulator === 0xff) this.bytes.push(0);
        this.accumulator = 0;
        this.count = 0;
      }
    }
  }
  finish() {
    while (this.count !== 0) this.put(1, 1);
    return Buffer.from(this.bytes);
  }
}

const segment = (marker, payload) =>
  Buffer.concat([
    Buffer.from([0xff, marker]),
    be16(payload.length + 2),
    payload,
  ]);

const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
function yCbCr([r, g, b]) {
  return [
    0.299 * r + 0.587 * g + 0.114 * b,
    128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
    128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
  ].map(clamp);
}

/** `blocks[row][column]` is an [r, g, b] colour for each 8x8 block; returns a JPEG whose APP1 holds `exif`. */
export function encodeBlockJpeg(blocks, exif, comment) {
  const rows = blocks.length;
  const columns = blocks[0].length;
  const dc = canonicalCodes(DC_COUNTS, DC_VALUES);
  const ac = canonicalCodes(AC_COUNTS, AC_VALUES);
  const sink = new BitSink();
  const previous = [0, 0, 0];
  for (const row of blocks) {
    for (const colour of row) {
      yCbCr(colour).forEach((level, component) => {
        // The quantiser is 8 and the block flat, so the DC coefficient is the level minus 128.
        const value = level - 128;
        const difference = value - previous[component];
        previous[component] = value;
        const magnitude = Math.abs(difference);
        const category =
          magnitude === 0 ? 0 : Math.floor(Math.log2(magnitude)) + 1;
        const { code, length } = dc.get(category);
        sink.put(code, length);
        if (category > 0) {
          const bits =
            difference > 0 ? difference : difference + (1 << category) - 1;
          sink.put(bits, category);
        }
        const eob = ac.get(0);
        sink.put(eob.code, eob.length);
      });
    }
  }
  const table = (id, counts, values) =>
    segment(
      0xc4,
      Buffer.concat([
        Buffer.from([id]),
        Buffer.from(counts),
        Buffer.from(values),
      ]),
    );
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(
      0xe0,
      Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ),
    segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), exif])),
    segment(0xfe, Buffer.from(comment, "latin1")),
    segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 8)])),
    segment(
      0xc0,
      Buffer.concat([
        Buffer.from([8]),
        be16(rows * 8),
        be16(columns * 8),
        Buffer.from([3]),
        Buffer.from([1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
      ]),
    ),
    table(0x00, DC_COUNTS, DC_VALUES),
    table(0x10, AC_COUNTS, AC_VALUES),
    segment(0xda, Buffer.from([3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0])),
    sink.finish(),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** FAKE in pixel letters (one font pixel per 8x8 block) over a dark blue field and a colour-bar row. */
export function fakePictureWithLocation() {
  const rows = 8;
  const columns = 24;
  const blocks = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => [20, 30, 90]),
  );
  drawText("FAKE", 0, 0, 1, (x, y) => {
    if (y < rows && x < columns) blocks[y][x] = [245, 245, 245];
  });
  const bars = [
    [230, 40, 40],
    [240, 150, 30],
    [240, 220, 40],
    [50, 170, 70],
    [40, 120, 220],
    [130, 60, 190],
  ];
  for (let x = 0; x < columns; x++)
    blocks[7][x] = bars[Math.floor((x * bars.length) / columns)];
  return encodeBlockJpeg(
    blocks,
    fakeGpsTiff(2, 3),
    "FAKE picture with a FAKE location; synthetic test pattern, no real content",
  );
}

// ---------- PNG ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(kind, data) {
  const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
  return Buffer.concat([be32(data.length), body, be32(crc32(body))]);
}
const textChunk = (key, value) =>
  pngChunk("tEXt", Buffer.from(`${key}\0${value}`, "latin1"));

/** A 96x64 RGB picture: FAKE in light pixels on dark red with a gradient strip, plus FAKE text
 * chunks and EXIF (with FAKE GPS). */
export async function fakePictureWithDetails() {
  const { deflateSync } = await import("node:zlib");
  const width = 96;
  const height = 64;
  const pixels = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) =>
      y >= 52 ? [40 + x * 2, 200 - x, 60 + y] : [110, 25, 35],
    ),
  );
  drawText("FAKE", 4, 8, 4, (x, y) => {
    if (x < width && y < height) pixels[y][x] = [250, 240, 230];
  });
  const raw = Buffer.concat(
    pixels.map((row) =>
      Buffer.concat([Buffer.from([0]), Buffer.from(row.flat())]),
    ),
  );
  const header = Buffer.concat([
    be32(width),
    be32(height),
    Buffer.from([8, 2, 0, 0, 0]),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    textChunk("Title", "FAKE Avery Patient wound photo"),
    textChunk("Author", "FAKE Clinic Nurse"),
    textChunk("Comment", "FAKE location 2 N 3 E, FAKE camera model"),
    pngChunk("eXIf", fakeGpsTiff(2, 3)),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- H.264 I_PCM clip in MP4 ----------
export const CLIP = { width: 160, height: 112, fps: 8, seconds: 2 };

class Bits {
  constructor() {
    this.bytes = [];
    this.current = 0;
    this.count = 0;
  }
  bit(value) {
    this.current = (this.current << 1) | value;
    if (++this.count === 8) {
      this.bytes.push(this.current);
      this.current = 0;
      this.count = 0;
    }
  }
  u(value, bits) {
    for (let i = bits - 1; i >= 0; i--) this.bit((value >> i) & 1);
  }
  ue(value) {
    const v = value + 1;
    const length = 32 - Math.clz32(v);
    this.u(0, length - 1);
    this.u(v, length);
  }
  se(value) {
    this.ue(value > 0 ? 2 * value - 1 : -2 * value);
  }
  alignZero() {
    while (this.count) this.bit(0);
  }
  trailing() {
    this.bit(1);
    this.alignZero();
  }
  raw(data) {
    this.bytes.push(...data);
  }
  result() {
    return Buffer.from(this.bytes);
  }
}

function escapeRbsp(rbsp) {
  const out = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}
const nal = (refIdc, kind, rbsp) =>
  Buffer.concat([Buffer.from([(refIdc << 5) | kind]), escapeRbsp(rbsp)]);

function sps() {
  const { width, height } = CLIP;
  const w = new Bits();
  w.u(66, 8);
  w.u(0xc0, 8);
  w.u(30, 8); // baseline, constraint set 0 and 1, level 3.0
  w.ue(0);
  w.ue(0); // sps id, log2_max_frame_num_minus4
  w.ue(2); // pic_order_cnt_type 2
  w.ue(1);
  w.u(0, 1); // max_num_ref_frames, gaps
  w.ue(width / 16 - 1);
  w.ue(height / 16 - 1);
  w.u(1, 1);
  w.u(1, 1);
  w.u(0, 1);
  w.u(0, 1); // frame_mbs_only, direct_8x8, no cropping, no vui
  w.trailing();
  return nal(3, 7, w.result());
}

function pps() {
  const w = new Bits();
  w.ue(0);
  w.ue(0);
  w.u(0, 1);
  w.u(0, 1); // ids, CAVLC, bottom_field_pic_order
  w.ue(0);
  w.ue(0);
  w.ue(0); // slice groups, reference index defaults
  w.u(0, 1);
  w.u(0, 2);
  w.se(0);
  w.se(0);
  w.se(0);
  w.u(1, 1);
  w.u(0, 1);
  w.u(0, 1); // deblocking control present, constrained intra, redundant
  w.trailing();
  return nal(3, 8, w.result());
}

/** One picture as planar YCbCr 4:2:0: a drifting colour field, a bouncing disc, a bar, text. */
function frame(t, frames) {
  const { width: W, height: H } = CLIP;
  const Y = new Uint8Array(W * H);
  const Cb = new Uint8Array((W / 2) * (H / 2));
  const Cr = new Uint8Array((W / 2) * (H / 2));
  const chroma = (x, y, cb, cr) => {
    Cb[(y >> 1) * (W / 2) + (x >> 1)] = cb;
    Cr[(y >> 1) * (W / 2) + (x >> 1)] = cr;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++)
      Y[y * W + x] =
        60 + Math.trunc(70 * (0.5 + 0.5 * Math.sin((x + 5 * t) / 29 + y / 41)));
  }
  for (let y = 0; y < H / 2; y++) {
    for (let x = 0; x < W / 2; x++) {
      Cb[y * (W / 2) + x] = 128 + Math.trunc(70 * Math.sin((x + 3 * t) / 25));
      Cr[y * (W / 2) + x] =
        128 + Math.trunc(70 * Math.cos((y + 2 * t) / 19 + x / 60));
    }
  }
  const cx =
    20 +
    ((t * 7) % 240 < 120 ? (t * 7) % 240 : 240 - ((t * 7) % 240)) *
      ((W - 40) / 120);
  const cy = 94 + 4 * Math.sin(t / 2);
  for (
    let y = Math.max(0, Math.trunc(cy) - 9);
    y < Math.min(H, Math.trunc(cy) + 10);
    y++
  ) {
    for (
      let x = Math.max(0, Math.trunc(cx) - 9);
      x < Math.min(W, Math.trunc(cx) + 10);
      x++
    ) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= 81) {
        Y[y * W + x] = 215;
        chroma(x, y, 90, 200);
      }
    }
  }
  for (let y = 106; y < 110; y++) {
    for (let x = 6; x < 6 + Math.trunc(((W - 12) * (t + 1)) / frames); x++) {
      Y[y * W + x] = 235;
      chroma(x, y, 128, 128);
    }
  }
  for (let y = 4; y < 84; y++) {
    for (let x = 4; x < W - 4; x++) {
      Y[y * W + x] = 24;
      chroma(x, y, 128, 128);
    }
  }
  const plot = (level) => (x, y) => {
    if (x >= 0 && x < W && y >= 0 && y < H) Y[y * W + x] = level;
  };
  drawText("FAKE", 10, 8, 4, plot(235));
  drawText("DEMO CLIP", 10, 44, 2, plot(235));
  drawText(
    `${String(t + 1).padStart(2, "0")}/${String(frames).padStart(2, "0")}`,
    10,
    62,
    2,
    plot(180),
  );
  return { Y, Cb, Cr };
}

function idrSlice({ Y, Cb, Cr }, n) {
  const { width: W, height: H } = CLIP;
  const w = new Bits();
  w.ue(0);
  w.ue(7);
  w.ue(0); // first_mb, slice_type I (all), pps
  w.u(0, 4); // frame_num
  w.ue(n % 2); // idr_pic_id differs from the previous IDR
  w.u(0, 1);
  w.u(0, 1); // no_output_of_prior_pics, long_term_reference
  w.se(0); // slice_qp_delta
  w.ue(1); // disable_deblocking_filter_idc
  for (let my = 0; my < H / 16; my++) {
    for (let mx = 0; mx < W / 16; mx++) {
      w.ue(25); // mb_type I_PCM
      w.alignZero();
      for (let yy = 0; yy < 16; yy++)
        w.raw(
          Y.subarray(
            (my * 16 + yy) * W + mx * 16,
            (my * 16 + yy) * W + mx * 16 + 16,
          ),
        );
      for (const plane of [Cb, Cr]) {
        for (let yy = 0; yy < 8; yy++)
          w.raw(
            plane.subarray(
              (my * 8 + yy) * (W / 2) + mx * 8,
              (my * 8 + yy) * (W / 2) + mx * 8 + 8,
            ),
          );
      }
    }
  }
  w.trailing();
  return nal(3, 5, w.result());
}

const box = (kind, ...payload) => {
  const body = Buffer.concat(payload);
  return Buffer.concat([
    be32(8 + body.length),
    Buffer.from(kind, "latin1"),
    body,
  ]);
};
const fullBox = (kind, version, flags, ...payload) =>
  box(
    kind,
    Buffer.from([
      version,
      (flags >> 16) & 255,
      (flags >> 8) & 255,
      flags & 255,
    ]),
    ...payload,
  );
const u32s = (...values) => Buffer.concat(values.map(be32));

function buildMp4(samples) {
  const { width: W, height: H, fps: FPS } = CLIP;
  const frames = samples.length;
  const spsNal = sps();
  const ppsNal = pps();
  const durationMs = Math.trunc((frames * 1000) / FPS);
  const avcc = Buffer.concat([
    Buffer.from([1, 66, 0xc0, 30, 0xff, 0xe1]),
    be16(spsNal.length),
    spsNal,
    Buffer.from([1]),
    be16(ppsNal.length),
    ppsNal,
  ]);
  const avc1 = Buffer.concat([
    Buffer.alloc(6),
    be16(1),
    Buffer.alloc(16),
    be16(W),
    be16(H),
    u32s(0x00480000, 0x00480000),
    Buffer.alloc(4),
    be16(1),
    Buffer.from([8]),
    Buffer.from("AVC Coding".padEnd(31, "\0"), "latin1"),
    be16(0x18),
    be16(0xffff),
    box("avcC", avcc),
  ]);
  const stsd = fullBox("stsd", 0, 0, be32(1), box("avc1", avc1));
  const stts = fullBox("stts", 0, 0, u32s(1, frames, 1));
  const stss = fullBox(
    "stss",
    0,
    0,
    be32(frames),
    u32s(...Array.from({ length: frames }, (_, i) => i + 1)),
  );
  const stsc = fullBox("stsc", 0, 0, u32s(1, 1, frames, 1));
  const stsz = fullBox(
    "stsz",
    0,
    0,
    u32s(0, frames, ...samples.map((s) => s.length)),
  );
  const matrix = u32s(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
  const moov = (offset) => {
    const stco = fullBox("stco", 0, 0, u32s(1, offset));
    const stbl = box("stbl", stsd, stts, stss, stsc, stsz, stco);
    const dinf = box(
      "dinf",
      fullBox("dref", 0, 0, be32(1), fullBox("url ", 0, 1)),
    );
    const minf = box(
      "minf",
      fullBox("vmhd", 0, 1, Buffer.alloc(8)),
      dinf,
      stbl,
    );
    const mdhd = fullBox(
      "mdhd",
      0,
      0,
      u32s(0, 0, FPS, frames),
      be16(0x55c4),
      be16(0),
    );
    const hdlr = fullBox(
      "hdlr",
      0,
      0,
      Buffer.alloc(4),
      Buffer.from("vide"),
      Buffer.alloc(12),
      Buffer.from("VideoHandler\0"),
    );
    const mdia = box("mdia", mdhd, hdlr, minf);
    const tkhd = fullBox(
      "tkhd",
      0,
      3,
      u32s(0, 0, 1, 0, durationMs),
      Buffer.alloc(8),
      Buffer.alloc(8),
      matrix,
      u32s(W << 16, H << 16),
    );
    const mvhd = fullBox(
      "mvhd",
      0,
      0,
      u32s(0, 0, 1000, durationMs),
      be32(0x10000),
      be16(0x100),
      Buffer.alloc(10),
      matrix,
      Buffer.alloc(24),
      be32(2),
    );
    return box("moov", mvhd, box("trak", tkhd, mdia));
  };
  const ftyp = box(
    "ftyp",
    Buffer.from("isom"),
    be32(512),
    Buffer.from("isomiso2avc1mp41"),
  );
  const dataOffset = ftyp.length + moov(0).length + 8;
  return Buffer.concat([ftyp, moov(dataOffset), box("mdat", ...samples)]);
}

/** The clip's bytes. */
export function fakeDemoClip() {
  const frames = CLIP.fps * CLIP.seconds;
  const samples = Array.from({ length: frames }, (_, t) => {
    const unit = idrSlice(frame(t, frames), t);
    return Buffer.concat([be32(unit.length), unit]);
  });
  return buildMp4(samples);
}
