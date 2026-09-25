// Names Windows reserves for devices: a file whose name before its first dot is
// one of these cannot be created, so the vault refuses them as document names.
// Keep this list the same as RESERVED_DEVICE_NAMES in src-tauri/src/vault.rs; a
// test there checks that every quoted name here is exactly one of those.
const RESERVED_DEVICE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  "COM¹",
  "COM²",
  "COM³",
  "LPT¹",
  "LPT²",
  "LPT³",
  "COM0",
  "LPT0",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

// As the vault judges it: the name before the first dot, without the spaces
// Windows ignores before the dot, compared with ASCII letters uppercased.
export const isReservedDeviceName = (name: string) =>
  RESERVED_DEVICE_NAMES.has(
    name
      .split(".")[0]
      .replace(/ +$/, "")
      .replace(/[a-z]/g, (letter) => letter.toUpperCase()),
  );
