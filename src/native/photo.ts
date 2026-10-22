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

/** The JPEG suffix of a photo name, with its stored case, after a nonempty name. */
export const photoExtension = (name: string) =>
  /^[\s\S]+(\.jpe?g)$/i.exec(name)?.[1] ?? "";

/** The longest side a photo is saved at; a larger camera frame is scaled
 * down. The vault refuses more than 8192 pixels a side (photo.rs). */
export const MAX_PHOTO_SIDE_PX = 4096;
/** The JPEG quality a photo is encoded at. */
export const PHOTO_QUALITY = 0.9;

/** The most a camera photo's JPEG may weigh. The vault takes up to 25 MB, but
 * where Tauri sends a call by postMessage (always on Android, and on Windows
 * once its custom protocol has failed) its own parsed copy is a JSON array
 * several times the photo's size, neither overwritten nor limited by the app
 * (THREAT_MODEL CAM-01). A photo is kept well under that. */
export const MAX_CAMERA_JPEG_BYTES = 4 * 1024 * 1024;
/** The qualities tried, in order, before a photo is made smaller. */
const PHOTO_QUALITIES = [PHOTO_QUALITY, 0.8, 0.7, 0.6];
/** The long side a photo is never scaled below to fit. */
const MIN_PHOTO_SIDE_PX = 1024;

const jpegOf = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality),
  );

/** The photo on `canvas` as a JPEG of at most `maxBytes`: at PHOTO_QUALITY
 * when that fits, else at a lower quality, else scaled down a quarter at a
 * time, not below MIN_PHOTO_SIDE_PX on its long side. Null when the browser
 * cannot encode it, or it cannot be made to fit. `canvas` is not changed; a
 * smaller copy made here is cleared once it is encoded. */
export async function encodePhoto(
  canvas: HTMLCanvasElement,
  maxBytes = MAX_CAMERA_JPEG_BYTES,
): Promise<Blob | null> {
  let source = canvas;
  try {
    for (;;) {
      for (const quality of PHOTO_QUALITIES) {
        const jpeg = await jpegOf(source, quality);
        if (!jpeg || jpeg.size <= maxBytes) return jpeg;
      }
      const longest = Math.max(source.width, source.height);
      if (longest <= MIN_PHOTO_SIDE_PX) return null;
      const scale = Math.max(0.75, MIN_PHOTO_SIDE_PX / longest);
      const smaller = document.createElement("canvas");
      smaller.width = Math.max(1, Math.round(source.width * scale));
      smaller.height = Math.max(1, Math.round(source.height * scale));
      const context = smaller.getContext("2d");
      // Out of canvas memory, as a phone can be: a blank copy would encode
      // as a black photo that fits, so the photo is not prepared at all.
      if (!context) {
        smaller.width = 0;
        smaller.height = 0;
        return null;
      }
      try {
        context.drawImage(source, 0, 0, smaller.width, smaller.height);
      } catch {
        // Out of memory while drawing, for one: nothing is prepared, and the
        // dialog says so.
        clear(smaller);
        return null;
      }
      if (source !== canvas) clear(source);
      source = smaller;
    }
  } finally {
    if (source !== canvas) clear(source);
  }
}

/** Overwrites a canvas's pixels and frees them. */
function clear(canvas: HTMLCanvasElement) {
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 0;
  canvas.height = 0;
}

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
