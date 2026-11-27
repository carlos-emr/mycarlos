import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { generateFakeDevData } from "./generate-fake-dev-data.mjs";

const committedDirectory = fileURLToPath(
  new URL("../dev-data", import.meta.url),
);

async function withGeneratedData(check) {
  const outputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "mycarlos-fake-data-"),
  );
  try {
    const generated = await generateFakeDevData(outputDirectory);
    await check(outputDirectory, generated);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

// Every xref entry and startxref must point at the object or table it names.
function assertPdfStructure(name, bytes) {
  const text = bytes.toString("latin1");
  assert.match(text, /^%PDF-1\.4\n/, name);
  assert.match(text, /%%EOF\n$/, name);
  const startxref = Number(text.match(/startxref\n(\d+)\n%%EOF\n$/)?.[1]);
  assert.equal(
    text.slice(startxref, startxref + 5),
    "xref\n",
    `${name}: startxref`,
  );
  const [, count, entries] = text
    .slice(startxref)
    .match(/^xref\n0 (\d+)\n((?:\d{10} \d{5} [fn] \n)+)/);
  const offsets = entries
    .trimEnd()
    .split(" \n")
    .slice(1)
    .map((entry) => Number(entry.slice(0, 10)));
  assert.equal(offsets.length, Number(count) - 1, `${name}: xref size`);
  offsets.forEach((offset, index) => {
    assert.ok(
      text.startsWith(`${index + 1} 0 obj\n`, offset),
      `${name}: object ${index + 1} offset`,
    );
  });
  const stream = text.match(/<< \/Length (\d+) >>\nstream\n/);
  const contentStart = stream.index + stream[0].length;
  assert.equal(
    text.slice(
      contentStart + Number(stream[1]),
      contentStart + Number(stream[1]) + 10,
    ),
    "\nendstream",
    `${name}: content length`,
  );
}

test("generates clearly prefixed valid PDF fixtures and an exact duplicate", async () => {
  await withGeneratedData(async (outputDirectory, generated) => {
    assert.equal(generated.length, 9);
    assert.ok(generated.every((name) => name.startsWith("FAKE")));

    const manifest = JSON.parse(
      await readFile(path.join(outputDirectory, "FAKE_MANIFEST.json"), "utf8"),
    );
    assert.equal("suggestedPassphrase" in manifest, false);
    assert.ok(
      manifest.profiles.every((profile) => profile.name.startsWith("FAKE ")),
    );
    assert.ok(
      manifest.profiles
        .flatMap((profile) => profile.folders)
        .every((folder) => folder.startsWith("FAKE ")),
    );

    assert.deepEqual(
      manifest.documents.map((document) => document.fileName).sort(),
      generated.filter((name) => name.endsWith(".pdf")).sort(),
    );
    for (const document of manifest.documents) {
      const bytes = await readFile(
        path.join(outputDirectory, document.fileName),
      );
      assertPdfStructure(document.fileName, bytes);
      assert.match(
        bytes.toString("latin1"),
        new RegExp(`\\(Patient: ${document.profileName}\\) Tj`),
        document.fileName,
      );
    }

    const original = await readFile(
      path.join(outputDirectory, "FAKE_Avery_Patient_Bloodwork.pdf"),
    );
    const duplicate = await readFile(
      path.join(outputDirectory, "FAKE_Avery_Patient_Bloodwork_DUPLICATE.pdf"),
    );
    assert.deepEqual(duplicate, original);
  });
});

test("committed dev-data matches the generator byte for byte", async () => {
  await withGeneratedData(async (outputDirectory, generated) => {
    assert.deepEqual(
      (await readdir(committedDirectory)).sort(),
      [...generated].sort(),
      "Run npm run dev:data to refresh dev-data/",
    );
    for (const name of generated) {
      assert.deepEqual(
        await readFile(path.join(committedDirectory, name)),
        await readFile(path.join(outputDirectory, name)),
        `dev-data/${name} is stale; run npm run dev:data`,
      );
    }
  });
});

function boxes(bytes, start = 0, end = bytes.length) {
  const found = [];
  for (let at = start; at < end;) {
    const size = bytes.readUInt32BE(at);
    assert.ok(size >= 8 && at + size <= end, "box size");
    found.push({
      kind: bytes.toString("latin1", at + 4, at + 8),
      start: at + 8,
      end: at + size,
    });
    at += size;
  }
  return found;
}

test("the demo pictures are valid, carry FAKE metadata and are listed in the manifest", async () => {
  await withGeneratedData(async (outputDirectory) => {
    const manifest = JSON.parse(
      await readFile(path.join(outputDirectory, "FAKE_MANIFEST.json"), "utf8"),
    );
    assert.deepEqual(
      manifest.media.map((item) => item.fileName),
      [
        "FAKE_Picture_with_location.jpg",
        "FAKE_Picture_with_details.png",
        "FAKE_demo_clip.mp4",
      ],
    );
    assert.ok(
      manifest.media.every(
        (item) =>
          item.fileName.startsWith("FAKE_") &&
          item.profileName.startsWith("FAKE ") &&
          item.folders.every((folder) => folder.startsWith("FAKE ")),
      ),
    );

    const jpeg = await readFile(
      path.join(outputDirectory, "FAKE_Picture_with_location.jpg"),
    );
    assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
    assert.deepEqual([...jpeg.subarray(-2)], [0xff, 0xd9]);
    const exifAt = jpeg.indexOf("Exif\0\0", 0, "latin1");
    assert.ok(exifAt > 0 && exifAt < 40, "EXIF in the first segments");
    const tiff = jpeg.subarray(exifAt + 6);
    // GPS IFD: latitude reference N, longitude reference E.
    assert.equal(tiff.toString("latin1", 0, 2), "MM");
    const gpsAt = tiff.readUInt32BE(18); // IFD0's one entry: the GPS pointer
    assert.equal(tiff.readUInt16BE(gpsAt), 4);
    assert.equal(tiff[gpsAt + 2 + 8], 0x4e);
    assert.equal(tiff[gpsAt + 2 + 12 * 2 + 8], 0x45);
    assert.ok(jpeg.length < 4096);

    const png = await readFile(
      path.join(outputDirectory, "FAKE_Picture_with_details.png"),
    );
    assert.deepEqual(
      [...png.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
    const { crc32, inflateSync } = await import("node:zlib");
    const kinds = [];
    let rows;
    for (let at = 8; at < png.length;) {
      const length = png.readUInt32BE(at);
      const body = png.subarray(at + 4, at + 8 + length);
      if (crc32) {
        assert.equal(
          png.readUInt32BE(at + 8 + length),
          crc32(body),
          "chunk CRC",
        );
      }
      kinds.push(body.toString("latin1", 0, 4));
      if (kinds.at(-1) === "IDAT") {
        rows = inflateSync(body.subarray(4));
      }
      at += 12 + length;
    }
    assert.deepEqual(kinds, [
      "IHDR",
      "tEXt",
      "tEXt",
      "tEXt",
      "eXIf",
      "IDAT",
      "IEND",
    ]);
    assert.equal(rows.length, 64 * (1 + 96 * 3));
    assert.match(png.toString("latin1"), /Title\0FAKE /);
  });
});

test("the demo clip is a plain, small, all-keyframe MP4 the video import accepts", async () => {
  await withGeneratedData(async (outputDirectory) => {
    const clip = await readFile(
      path.join(outputDirectory, "FAKE_demo_clip.mp4"),
    );
    // Well under 1 MB for the repository; the importer's own rules (movie box before the media
    // data, plain file, all keyframes, no fragments) are checked by the Rust test
    // `the_committed_fake_demo_clip_passes_the_import_analysis`.
    assert.ok(clip.length < 1_000_000, `${clip.length} bytes`);
    const top = boxes(clip);
    assert.deepEqual(
      top.map((box) => box.kind),
      ["ftyp", "moov", "mdat"],
    );
    assert.equal(
      clip.toString("latin1", top[0].start, top[0].start + 4),
      "isom",
    );
    const stsz = clip.indexOf("stsz", 0, "latin1");
    const samples = clip.readUInt32BE(stsz + 4 + 4 + 4);
    assert.equal(samples, 16);
    // The chunk offset points at the first sample, which starts with an IDR slice (NAL type 5).
    const stco = clip.indexOf("stco", 0, "latin1");
    const offset = clip.readUInt32BE(stco + 4 + 4 + 4);
    assert.equal(offset, top[2].start);
    assert.equal(clip[offset + 4] & 0x1f, 5);
  });
});
