// A small, dependency-free zip reader for the release safety gate: the central directory, and the
// bytes of one entry (stored or deflated). It reads the whole archive into memory, which the gate
// accepts for an APK, AAB or IPA of a few hundred MB.
import { inflateRawSync } from "node:zlib";

/** The most one entry may inflate to (1 GiB). */
export const MAX_ENTRY_BYTES = 1 << 30;

export function readZip(bytes, { maxEntryBytes = MAX_ENTRY_BYTES } = {}) {
  let end = -1;
  for (
    let i = bytes.length - 22;
    i >= Math.max(0, bytes.length - 22 - 65535);
    i--
  ) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0)
    throw new Error("not a zip file (no end-of-central-directory record)");
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50)
      throw new Error("damaged zip central directory");
    const method = bytes.readUInt16LE(at + 10);
    const compressed = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) {
      throw new Error(`${name}: damaged zip local header`);
    }
    const localName = bytes.readUInt16LE(local + 26);
    const localExtra = bytes.readUInt16LE(local + 28);
    entries.set(name, {
      name,
      method,
      compressed,
      dataStart: local + 30 + localName + localExtra,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    /** The entry's bytes, or null when it is not there. */
    read(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      const raw = bytes.subarray(
        entry.dataStart,
        entry.dataStart + entry.compressed,
      );
      if (entry.method === 0) return raw;
      if (entry.method === 8) {
        // Bounded: an entry that inflates past this is refused, not allowed to fill memory.
        return inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
      }
      throw new Error(`${name}: unsupported zip method ${entry.method}`);
    },
  };
}
