import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  checkArchive,
  checkElf,
  checkPath,
  zipEntries,
} from "./check-android-page-alignment.mjs";

/** A tiny little-endian ELF64 with the given PT_LOAD alignments (made-up bytes, no code). */
function elf64(aligns, { bits = 2, little = true } = {}) {
  const phentsize = 56;
  const bytes = Buffer.alloc(64 + phentsize * aligns.length);
  bytes.writeUInt32BE(0x7f454c46, 0);
  bytes[4] = bits;
  bytes[5] = little ? 1 : 2;
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(phentsize, 54);
  bytes.writeUInt16LE(aligns.length, 56);
  aligns.forEach((align, i) => {
    const at = 64 + i * phentsize;
    bytes.writeUInt32LE(1, at); // PT_LOAD
    bytes.writeBigUInt64LE(BigInt(align), at + 48);
  });
  return bytes;
}

/** A zip with the given entries; `stored` entries are padded so their data starts at `alignTo`. */
function zip(entries, alignTo = 0) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data, stored } of entries) {
    const nameBytes = Buffer.from(name);
    const body = stored ? data : deflateRawSync(data);
    let extra = 0;
    if (stored && alignTo) {
      const start = offset + 30 + nameBytes.length;
      extra = (alignTo - (start % alignTo)) % alignTo;
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(extra, 28);
    const piece = Buffer.concat([local, nameBytes, Buffer.alloc(extra), body]);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(stored ? 0 : 8, 10);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, nameBytes]));
    parts.push(piece);
    offset += piece.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const READY = elf64([16384, 16384]);
const OLD = elf64([4096, 16384]);

test("an ELF segment aligned below 16 KB is refused, at 16 KB or more it is accepted", () => {
  assert.deepEqual(checkElf(READY, "a.so"), []);
  assert.deepEqual(checkElf(elf64([65536]), "a.so"), []);
  assert.match(checkElf(OLD, "a.so").join(), /aligned to 4096/);
  assert.match(checkElf(elf64([]), "a.so").join(), /no PT_LOAD/);
});

test("a 32-bit library is not subject to the rule, and a non-ELF file is refused", () => {
  assert.deepEqual(checkElf(elf64([4096], { bits: 1 }), "a.so"), []);
  assert.match(
    checkElf(
      Buffer.from("not an elf file at all, nope, really not".repeat(3)),
      "a.so",
    ).join(),
    /not an ELF/,
  );
});

test("a truncated program header table is refused", () => {
  assert.match(
    checkElf(READY.subarray(0, 100), "a.so").join(),
    /outside the file/,
  );
});

test("the entries of a zip are listed with where their data starts", () => {
  const entries = zipEntries(
    zip([{ name: "lib/arm64-v8a/libx.so", data: READY, stored: true }], 16384),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "lib/arm64-v8a/libx.so");
  assert.equal(entries[0].dataStart % 16384, 0);
  assert.throws(() => zipEntries(Buffer.from("PK nothing")), /not a zip/);
});

test("an APK passes only with aligned storage and 16 KB segments, for both 64-bit ABIs", () => {
  const good = zip(
    [
      { name: "lib/arm64-v8a/libmycarlos.so", data: READY, stored: true },
      { name: "lib/x86_64/libmycarlos.so", data: READY, stored: true },
      {
        name: "lib/armeabi-v7a/libold.so",
        data: elf64([4096], { bits: 1 }),
        stored: true,
      },
    ],
    16384,
  );
  assert.deepEqual(checkArchive(good, "app.apk", { zipAligned: true }), []);
  const unaligned = zip([
    { name: "lib/arm64-v8a/libmycarlos.so", data: READY, stored: true },
  ]);
  assert.match(
    checkArchive(unaligned, "app.apk", { zipAligned: true }).join(),
    /not a multiple of 16384/,
  );
  const oldElf = zip(
    [{ name: "lib/arm64-v8a/libmycarlos.so", data: OLD, stored: true }],
    16384,
  );
  assert.match(
    checkArchive(oldElf, "app.apk", { zipAligned: true }).join(),
    /aligned to 4096/,
  );
});

test("a compressed library is checked by its ELF only, and an AAB ignores zip alignment", () => {
  const compressed = zip([
    { name: "lib/arm64-v8a/libmycarlos.so", data: READY, stored: false },
  ]);
  assert.deepEqual(
    checkArchive(compressed, "app.apk", { zipAligned: true }),
    [],
  );
  const aab = zip([
    { name: "base/lib/arm64-v8a/libmycarlos.so", data: READY, stored: true },
  ]);
  assert.deepEqual(checkArchive(aab, "app.aab", { zipAligned: false }), []);
  const badCompressed = zip([
    { name: "lib/x86_64/libmycarlos.so", data: OLD, stored: false },
  ]);
  assert.match(
    checkArchive(badCompressed, "app.apk", { zipAligned: true }).join(),
    /aligned to 4096/,
  );
});

test("an archive with no 64-bit library is refused rather than passed", () => {
  const none = zip(
    [{ name: "lib/armeabi-v7a/libold.so", data: OLD, stored: true }],
    16384,
  );
  assert.match(
    checkArchive(none, "app.apk", { zipAligned: true }).join(),
    /no 64-bit native library/,
  );
});

test("checkPath reads an APK, an AAB, a single library and a folder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-page-alignment-"));
  try {
    const entries = [
      { name: "lib/arm64-v8a/libmycarlos.so", data: READY, stored: true },
    ];
    await writeFile(join(directory, "a.apk"), zip(entries, 16384));
    await writeFile(join(directory, "a.aab"), zip(entries));
    await writeFile(join(directory, "lib.so"), READY);
    await writeFile(join(directory, "bad.so"), OLD);
    await writeFile(join(directory, "notes.txt"), "x");
    assert.deepEqual(await checkPath(join(directory, "a.apk")), []);
    assert.deepEqual(await checkPath(join(directory, "a.aab")), []);
    assert.deepEqual(await checkPath(join(directory, "lib.so")), []);
    assert.match((await checkPath(join(directory, "bad.so"))).join(), /4096/);
    assert.match(
      (await checkPath(join(directory, "notes.txt"))).join(),
      /expected an .apk/,
    );
    await mkdir(join(directory, "jni/arm64-v8a"), { recursive: true });
    await mkdir(join(directory, "jni/armeabi-v7a"), { recursive: true });
    await writeFile(join(directory, "jni/arm64-v8a/libz.so"), READY);
    await writeFile(join(directory, "jni/armeabi-v7a/libz.so"), OLD);
    assert.deepEqual(await checkPath(join(directory, "jni")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
