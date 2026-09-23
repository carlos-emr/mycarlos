import type { IconName } from "../Icon";

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  // Compare the rounded figure, so a size just under 1 MB is not "1024 KB".
  const kilobytes = Math.round(value / 1024);
  if (kilobytes < 1024) return `${kilobytes} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

// A kind is only a hint drawn from the file name, so it must not fire on a
// fragment of another word: "Latest" is not a test, "Collaboration" is not a lab
// and "Prescan" is not a scan. Words are compared from their start, which still
// accepts "Bloodwork", "tests" and "scanned".
const KIND_RULES: {
  icon: IconName;
  label: string;
  stems: string[];
  exact?: string[];
}[] = [
  {
    icon: "flask",
    label: "Test result",
    stems: ["blood", "test", "laboratory"],
    // "lab" as a stem would also claim "label".
    exact: ["lab", "labs"],
  },
  { icon: "image", label: "Imaging", stems: ["imag", "xray", "scan"] },
  { icon: "pill", label: "Prescription", stems: ["prescri", "medicat"] },
];

export function recordKind(name: string): { icon: IconName; label: string } {
  // Not the locale's lower case: under a Turkish locale "IMAGING" becomes
  // "ımagıng", which matches none of the ASCII stems below.
  const words = name
    .toLowerCase()
    .replace(/x-ray/g, "xray")
    .split(/[^\p{L}\p{N}]+/u);
  for (const { icon, label, stems, exact = [] } of KIND_RULES) {
    const matches = (word: string) =>
      exact.includes(word) || stems.some((stem) => word.startsWith(stem));
    if (words.some(matches)) return { icon, label };
  }
  return { icon: "letter", label: "Document" };
}

// The vault allows profile and folder names of at most this many characters
// (Unicode code points) once trimmed. An input's `maxLength` counts UTF-16
// units, in which one character can take two, so inputs are capped at twice
// this and the name itself is checked here.
export const MAX_NAME_CHARS = 120;
export const NAME_INPUT_MAX_LENGTH = 2 * MAX_NAME_CHARS;
export const nameTooLong = (name: string) =>
  [...name.trim()].length > MAX_NAME_CHARS;

// Search compares text in one form whatever the device's locale: with a
// Turkish default locale, toLocaleLowerCase() turns "I" into a dotless "ı",
// so "imaging" would not find "Imaging". NFC makes an accent typed as a
// separate mark match the same letter typed precomposed.
export const searchKey = (value: string) =>
  value.normalize("NFC").toLowerCase();

// The extension of a document name, such as ".pdf": a final dot and one to
// ten ASCII letters or digits, after a non-empty stem. The vault refuses a
// rename that changes it (vault.rs `file_extension` uses the same rule).
export const fileExtension = (name: string) =>
  /^.+(\.[A-Za-z0-9]{1,10})$/.exec(name)?.[1] ?? "";
