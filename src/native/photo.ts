// Taking a photo with the camera (CameraDialog) and showing one (PhotoViewer).

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** A new photo's name, on the patient's own clock, such as "Photo, 17 Oct
 * 2026, 3.05 PM.jpg". The vault refuses ":" in a document name, as Windows
 * does in a file name, so the time is written with a dot. */
export function photoName(now: Date): string {
  const hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `Photo, ${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}, ${hours % 12 || 12}.${minutes} ${hours < 12 ? "AM" : "PM"}.jpg`;
}

/** The longest side a photo is saved at; a larger camera frame is scaled
 * down. The vault refuses more than 8192 pixels a side (photo.rs). */
export const MAX_PHOTO_SIDE_PX = 4096;
/** The JPEG quality a photo is encoded at. */
export const PHOTO_QUALITY = 0.9;

/** The size to draw a camera frame at: its own, or scaled down so that its
 * long side is at most MAX_PHOTO_SIDE_PX. */
export function photoSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const scale = Math.min(1, MAX_PHOTO_SIDE_PX / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Whether a document is named as a PDF. The photo view does not try those;
 * any other document is shown as a photo when its file is a JPEG, whatever
 * it is called, as the vault decides by the file's first bytes. */
export const namedAsPdf = (name: string) => /\.pdf$/i.test(name.trim());

/** Where the camera dialog is offered: the computers (#83) and, since D97,
 * the phones. */
export const CAMERA_PLATFORMS: ReadonlySet<string> = new Set([
  "windows",
  "macos",
  "linux",
  "android",
  "ios",
]);

/** Phones: their own words for where the camera is allowed, and the system's
 * permission question can hide the app while it is asked. */
export const isPhone = (platform: string) =>
  platform === "android" || platform === "ios";

/** Why the camera could not be used. */
export type CameraFailure = "denied" | "missing" | "busy" | "stopped" | "other";

export function cameraFailure(error: unknown): CameraFailure {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "missing";
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  return "other";
}

/** What to tell the patient, with where to look on their computer or phone
 * when the camera was refused. */
export function cameraFailureMessage(
  failure: CameraFailure,
  platform: string,
): string {
  switch (failure) {
    case "denied":
      return `myCarlos can't use the camera. ${
        platform === "windows"
          ? "In Windows Settings, open Privacy & security, then Camera, and turn on camera access for desktop apps."
          : platform === "macos"
            ? "In System Settings, open Privacy & Security, then Camera, and turn on myCarlos."
            : platform === "android"
              ? "Open your phone's Settings, then Apps, then myCarlos, then Permissions, and allow Camera."
              : platform === "ios"
                ? "Open your phone's Settings, then myCarlos, and turn on Camera."
                : "Check your computer's camera privacy settings and let myCarlos use the camera."
      } Then choose Try again.`;
    case "missing":
      // A phone's camera is built in: nothing to connect.
      return isPhone(platform)
        ? "This phone's camera could not be found. Choose Try again."
        : "No camera was found. Connect a camera, then choose Try again.";
    case "busy":
      return "The camera is in use by another app. Close it, then choose Try again.";
    case "stopped":
      return isPhone(platform)
        ? "The camera stopped. Choose Try again."
        : "The camera stopped. Check that it is connected, then choose Try again.";
    case "other":
      return "The camera could not be started. Choose Try again.";
  }
}

// After the camera has worked once, the dialog opens straight on it.
const EXPLAINED_STORAGE_KEY = "mycarlos.cameraExplained.v1";

export function cameraExplained(): boolean {
  try {
    return window.localStorage.getItem(EXPLAINED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberCameraExplained(): void {
  try {
    window.localStorage.setItem(EXPLAINED_STORAGE_KEY, "1");
  } catch {
    // The explanation is shown again next time.
  }
}
