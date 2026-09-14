import type { IconName } from "../Icon";

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function recordKind(name: string): { icon: IconName; label: string } {
  const normalized = name.toLocaleLowerCase();
  if (
    normalized.includes("blood") ||
    normalized.includes("test") ||
    normalized.includes("lab")
  ) {
    return { icon: "flask", label: "Test result" };
  }
  if (
    normalized.includes("image") ||
    normalized.includes("x-ray") ||
    normalized.includes("scan")
  ) {
    return { icon: "image", label: "Imaging" };
  }
  if (
    normalized.includes("prescription") ||
    normalized.includes("medication")
  ) {
    return { icon: "pill", label: "Prescription" };
  }
  return { icon: "letter", label: "Document" };
}
