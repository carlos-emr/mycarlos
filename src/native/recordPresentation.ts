import {
  LOCALES,
  t as translateNow,
  translate,
  formatNumber,
  type MessageKey,
} from "../i18n";
import type { IconName } from "../Icon";

export function formatBytes(value: number): string {
  if (value < 1024) return `${formatNumber(value)} B`;
  const kilobytes = Math.round(value / 1024);
  if (kilobytes < 1024) return `${formatNumber(kilobytes)} KB`;
  return `${formatNumber(value / (1024 * 1024), undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

/** The selected app locale formats sizes; the platform still determines
 * whether its file app counts in 1000s or 1024s. */
export function formatFileSize(value: number, in1024s: boolean): string {
  const exact = translateNow("interface.size.bytes", { count: value });
  if (in1024s) return value < 1024 ? exact : `${formatBytes(value)}, ${exact}`;
  if (value < 1000) return exact;
  const kilobytes = Math.round(value / 1000);
  if (kilobytes < 1000) return `${formatNumber(kilobytes)} kB, ${exact}`;
  return `${formatNumber(value / 1_000_000, undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB, ${exact}`;
}

// A kind is only a hint drawn from the file name, so it must not fire on a
// fragment of another word: "Latest" is not a test, "Collaboration" is not a lab
// and "Prescan" is not a scan. Words are compared from their start, which still
// accepts "Bloodwork", "tests" and "scanned".
const KIND_RULES: {
  icon: IconName;
  label: MessageKey;
  stems: string[];
  exact?: string[];
}[] = [
  {
    icon: "flask",
    label: "interface.recordPresentation.testResult",
    stems: ["blood", "test", "laboratory"],
    // "lab" as a stem would also claim "label".
    exact: ["lab", "labs"],
  },
  {
    icon: "image",
    label: "interface.recordPresentation.imaging",
    stems: ["imag", "xray", "scan"],
  },
  {
    icon: "pill",
    label: "interface.recordPresentation.prescription",
    stems: ["prescri", "medicat"],
  },
];

export function recordKind(name: string): { icon: IconName; label: string } {
  // A photo saved from the camera, or any JPEG by its name. (Whether a file
  // can be shown as a photo is decided by its bytes, in the vault.)
  if (/\.jpe?g$/i.test(name.trim()))
    return { icon: "camera", label: translateNow("photo.eyebrow") };
  // Not the locale's lower case: under a Turkish locale "IMAGING" becomes
  // "ımagıng", which matches none of the ASCII stems below.
  const words = name
    .toLowerCase()
    .replace(/x-ray/g, "xray")
    .split(/[^\p{L}\p{N}]+/u);
  for (const { icon, label, stems, exact = [] } of KIND_RULES) {
    const matches = (word: string) =>
      exact.includes(word) || stems.some((stem) => word.startsWith(stem));
    if (words.some(matches)) return { icon, label: translateNow(label) };
  }
  return { icon: "letter", label: translateNow("record.kind.document") };
}

// The vault allows profile and folder names of at most this many characters
// (Unicode code points) once trimmed. An input's `maxLength` counts UTF-16
// units, in which one character can take two, so inputs are capped at twice
// this and the name itself is checked here.
export const MAX_NAME_CHARS = 120;
export const NAME_INPUT_MAX_LENGTH = 2 * MAX_NAME_CHARS;
export const nameTooLong = (name: string) =>
  [...name.trim()].length > MAX_NAME_CHARS;

/** "Shared with me" is the folder shared files go into (#61), shown in the
 * app's language, so no person may be called it in any of them. Case, space
 * around it and how its accents are typed don't matter. The native side
 * refuses the same names, read from the same catalogues. */
const sharedKey = (name: string) => name.trim().normalize("NFC").toLowerCase();
const SHARED_NAMES = new Set(
  LOCALES.map((locale) =>
    sharedKey(translate(locale, "interface.LibrarySidebar.sharedWithMe")),
  ),
);
export const nameIsShared = (name: string) => SHARED_NAMES.has(sharedKey(name));

// Search compares text in one form whatever the device's locale: with a
// Turkish default locale, toLocaleLowerCase() turns "I" into a dotless "ı",
// so "imaging" would not find "Imaging". NFC makes an accent typed as a
// separate mark match the same letter typed precomposed.
export const searchKey = (value: string) =>
  value.normalize("NFC").toLowerCase();

// The ".pdf" at the end of a document name, in the case the name uses, after
// a non-empty stem; otherwise "". Imports are offered as PDFs, so no other
// suffix is treated as a file type. The vault refuses a rename that removes,
// recases or adds it (vault.rs `file_extension` uses the same rule).
export const fileExtension = (name: string) =>
  // [\s\S], not ".", so the stem matches line and paragraph separators too.
  /^[\s\S]+(\.pdf)$/i.exec(name)?.[1] ?? "";
