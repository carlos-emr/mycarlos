#!/usr/bin/env node
// Checks that native libraries support 16 KB memory pages (#422).
//
//   node scripts/check-android-page-alignment.mjs <apk|aab|folder> [more...]
//
// Google Play refuses updates that do not support 16 KB pages from 1 February 2027 (apps
// targeting Android 15 or newer, on 64-bit devices). Two things must hold for every 64-bit
// `lib/<abi>/*.so` (arm64-v8a and x86_64):
//
// 1. ELF: every PT_LOAD segment is aligned to at least 16 KB (`p_align >= 0x4000`). An NDK from r28
//    does this by default; an older one, or a prebuilt library, may not.
// 2. ZIP: a library stored uncompressed in an APK starts at a multiple of 16 KB, so it can be
//    mapped straight from the file (zipalign -P 16). A compressed entry has no such rule, and the
//    check says so rather than failing it. An AAB is checked for the ELF alignment only: Play
//    aligns the APKs it builds from it.
//
// 32-bit ABIs (armeabi-v7a, x86) are not subject to the rule and are skipped.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

export const PAGE = 16384;
const CHECKED_ABIS = new Set(["arm64-v8a", "x86_64"]);

/** Problems with one ELF image's program headers (empty when it is 16 KB ready). */
export function checkElf(bytes, name) {
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46) {
    return [`${name}: not an ELF file`];
  }
  if (bytes[4] !== 2) return []; // 32-bit: not subject to the rule
  const little = bytes[5] === 1;
  const u16 = (at) =>
    little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);
  const u32 = (at) =>
    little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
  const u64 = (at) =>
    Number(little ? bytes.readBigUInt64LE(at) : bytes.readBigUInt64BE(at));
  const phoff = u64(32);
  const phentsize = u16(54);
  const phnum = u16(56);
  if (phoff + phentsize * phnum > bytes.length || phentsize < 56) {
    return [`${name}: the program header table is outside the file`];
  }
  const problems = [];
  let loads = 0;
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize;
    if (u32(at) !== 1) continue; // PT_LOAD
    loads++;
    const align = u64(at + 48);
    if (align < PAGE) {
      problems.push(
        `${name}: a PT_LOAD segment is aligned to ${align} bytes; it must be at least ${PAGE}`,
      );
    }
  }
  if (loads === 0) problems.push(`${name}: no PT_LOAD segment`);
  return problems;
}

/** The entries of a zip file: name, method, and where the data starts in the file. */
export function zipEntries(zip) {
  let end = -1;
  for (
    let i = zip.length - 22;
    i >= Math.max(0, zip.length - 22 - 65535);
    i--
  ) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0)
    throw new Error("not a zip file: no end-of-central-directory record");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50)
      throw new Error("damaged zip central directory");
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    const localName = zip.readUInt16LE(local + 26);
    const localExtra = zip.readUInt16LE(local + 28);
    entries.push({
      name,
      method,
      compressed,
      dataStart: local + 30 + localName + localExtra,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// Where a library sits tells its ABI: `lib/<abi>/` in an archive, `jniLibs/<abi>/`, or a Rust
// `target/<triple>/` folder. 32-bit ABIs map to themselves and are skipped by the callers.
const ABI_BY_SEGMENT = new Map([
  ["arm64-v8a", "arm64-v8a"],
  ["x86_64", "x86_64"],
  ["armeabi-v7a", "armeabi-v7a"],
  ["x86", "x86"],
  ["aarch64-linux-android", "arm64-v8a"],
  ["x86_64-linux-android", "x86_64"],
  ["armv7-linux-androideabi", "armeabi-v7a"],
  ["i686-linux-android", "x86"],
]);

function abiOf(name) {
  const segments = name.split("/");
  segments.pop();
  for (const segment of segments.reverse()) {
    if (ABI_BY_SEGMENT.has(segment)) return ABI_BY_SEGMENT.get(segment);
  }
  return null;
}

/** Problems with the native libraries inside an APK or AAB. */
export function checkArchive(zip, label, { zipAligned }) {
  const problems = [];
  let checked = 0;
  for (const entry of zipEntries(zip)) {
    if (!/(?:^|\/)lib\/[^/]+\/[^/]+\.so$/.test(entry.name)) continue;
    const abi = abiOf(entry.name);
    if (!abi || !CHECKED_ABIS.has(abi)) continue;
    checked++;
    const where = `${label}!${entry.name}`;
    const raw = zip.subarray(
      entry.dataStart,
      entry.dataStart + entry.compressed,
    );
    if (entry.method === 0) {
      if (zipAligned && entry.dataStart % PAGE !== 0) {
        problems.push(
          `${where}: stored at offset ${entry.dataStart}, not a multiple of ${PAGE} (zipalign -P 16)`,
        );
      }
      problems.push(...checkElf(raw, where));
    } else if (entry.method === 8) {
      problems.push(...checkElf(inflateRawSync(raw), where));
    } else {
      problems.push(`${where}: unsupported zip method ${entry.method}`);
    }
  }
  if (checked === 0) problems.push(`${label}: no 64-bit native library found`);
  return problems;
}

async function* sharedObjects(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sharedObjects(path);
    else if (entry.name.endsWith(".so")) yield path;
  }
}

/** Problems with one path: an .apk, an .aab, a single .so, or a folder of libraries. */
export async function checkPath(path) {
  const info = await stat(path);
  if (info.isDirectory()) {
    const problems = [];
    let checked = 0;
    for await (const file of sharedObjects(path)) {
      const abi = abiOf(file.split("\\").join("/"));
      if (abi && !CHECKED_ABIS.has(abi)) continue;
      checked++;
      problems.push(...checkElf(await readFile(file), file));
    }
    if (checked === 0) problems.push(`${path}: no 64-bit native library found`);
    return problems;
  }
  const bytes = await readFile(path);
  if (path.endsWith(".so")) return checkElf(bytes, path);
  if (path.endsWith(".apk"))
    return checkArchive(bytes, path, { zipAligned: true });
  if (path.endsWith(".aab"))
    return checkArchive(bytes, path, { zipAligned: false });
  return [`${path}: expected an .apk, .aab, .so or a folder`];
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error(
      "usage: check-android-page-alignment.mjs <apk|aab|so|folder>...",
    );
    process.exit(2);
  }
  const problems = [];
  for (const path of paths) {
    try {
      problems.push(...(await checkPath(path)));
    } catch (error) {
      problems.push(`${path}: ${error.message}`);
    }
  }
  if (problems.length) {
    for (const problem of problems)
      console.error(`16 KB page alignment: ${problem}`);
    process.exit(1);
  }
  console.log("16 KB page alignment: every 64-bit native library is ready.");
}
