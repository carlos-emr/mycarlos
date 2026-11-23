import { getLocale } from "../i18n";
import { formatDate, formatVideoName } from "../i18n/core";

/** MP4 is the one container myCarlos records (#359), H.264 video and AAC sound.
 * The first the webview's recorder accepts is used. */
export const MP4_TYPES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4;codecs=avc1",
  "video/mp4",
] as const;

/** The recorder as far as this module needs it: the pieces a test can stand in
 * for with a fake. */
export interface RecorderApi {
  isTypeSupported(type: string): boolean;
}

/** The first MP4 type the recorder accepts, or null. */
export function pickMp4Type(
  api: RecorderApi | undefined = typeof MediaRecorder === "undefined"
    ? undefined
    : MediaRecorder,
): string | null {
  if (!api?.isTypeSupported) return null;
  for (const type of MP4_TYPES) {
    try {
      if (api.isTypeSupported(type)) return type;
    } catch {
      // A recorder that throws for a type does not record it.
    }
  }
  return null;
}

/** Whether Record video is offered here: the webview can record MP4 with sound
 * and the camera interface exists. Where it cannot, a line says so (the add
 * menu) instead of a button. */
export function videoRecordingAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    pickMp4Type() !== null
  );
}

export type VideoQuality = "standard" | "high";

export interface QualitySpec {
  width: number;
  height: number;
  /** A target: a webview may deliver less. */
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
}

export const QUALITIES: Readonly<Record<VideoQuality, QualitySpec>> = {
  standard: {
    width: 1280,
    height: 720,
    videoBitsPerSecond: 2_500_000,
    audioBitsPerSecond: 96_000,
  },
  high: {
    width: 1920,
    height: 1080,
    videoBitsPerSecond: 7_000_000,
    audioBitsPerSecond: 96_000,
  },
};

/** What a track says its camera can do, as far as it matters. */
export interface TrackCapabilities {
  width?: { max?: number };
  height?: { max?: number };
}

/** High (1080p) is offered only where the camera reports it can deliver it. A
 * webview that cannot say shows Standard only. */
export function highQualityAvailable(
  track: { getCapabilities?: () => TrackCapabilities } | undefined,
): boolean {
  let capabilities: TrackCapabilities | undefined;
  try {
    capabilities = track?.getCapabilities?.();
  } catch {
    return false;
  }
  return (
    (capabilities?.width?.max ?? 0) >= QUALITIES.high.width &&
    (capabilities?.height?.max ?? 0) >= QUALITIES.high.height
  );
}

const QUALITY_KEY = "mycarlos.videoQuality.v1";

/** The quality chosen last on this device (outside the vault, like the other
 * preferences); Standard until then. */
export function readVideoQuality(): VideoQuality {
  try {
    return window.localStorage.getItem(QUALITY_KEY) === "high"
      ? "high"
      : "standard";
  } catch {
    return "standard";
  }
}

export function rememberVideoQuality(quality: VideoQuality): void {
  try {
    window.localStorage.setItem(QUALITY_KEY, quality);
  } catch {
    // Standard is chosen again next time.
  }
}

/** The camera's picture as the recorder will have it, for the constraints. */
export function videoConstraints(
  quality: VideoQuality,
  phone: boolean,
): MediaTrackConstraints {
  const spec = QUALITIES[quality];
  return {
    ...(phone ? { facingMode: "environment" } : {}),
    width: { ideal: spec.width },
    height: { ideal: spec.height },
    frameRate: { ideal: 30 },
  };
}

/** The time recorded, without the pauses, from a clock that only counts while
 * it runs. `now` is a monotonic clock in milliseconds. */
export class RecordedClock {
  private total = 0;
  private since: number | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  get running(): boolean {
    return this.since !== null;
  }

  start(): void {
    if (this.since === null) this.since = this.now();
  }

  /** Stops counting (a pause or the end). */
  stop(): void {
    if (this.since === null) return;
    this.total += Math.max(0, this.now() - this.since);
    this.since = null;
  }

  /** Milliseconds recorded so far. */
  elapsed(): number {
    return (
      this.total +
      (this.since === null ? 0 : Math.max(0, this.now() - this.since))
    );
  }
}

/** `m:ss`, or `h:mm:ss` from an hour. Digits only, so every language reads it. */
export function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** A new video gets a localized name once, as a photo does: colons are not
 * valid in Windows file names, so the clock uses dots. */
export function videoName(now: Date): string {
  const date = formatDate(now, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const time = formatDate(now, { hour: "numeric", minute: "2-digit" }).replace(
    /:/g,
    ".",
  );
  const filenameText = (value: string) => value.replace(/[‎‏‪-‮⁦-⁩]/g, "");
  return formatVideoName(getLocale(), filenameText(date), filenameText(time));
}

/** What is kept back from the room that is left so that a recording can be
 * finished: the last frame, the check, the manifest and the history. Matches
 * the vault's own reserve. */
export const STOP_RESERVE_BYTES = 256 * 1024 * 1024;

/** About how many whole minutes of recording the room left will hold, from how
 * fast this recording has been filling it; `null` until enough has been
 * recorded to say. */
export function minutesLeft(
  freeBytes: number | null,
  storedBytes: number,
  elapsedMs: number,
): number | null {
  if (freeBytes === null || elapsedMs < 5_000 || storedBytes <= 0) return null;
  const perSecond = storedBytes / (elapsedMs / 1000);
  const usable = Math.max(0, freeBytes - STOP_RESERVE_BYTES);
  return Math.max(0, Math.floor(usable / perSecond / 60));
}

/** Whether the vault refused for want of room. */
export function isNoSpace(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "no_space"
  );
}

/** The most unsent video the page keeps: past it the recording ends and what
 * was recorded is saved, so a stalled save cannot fill the webview's memory. */
export const MAX_UNSENT_BYTES = 16 * 1024 * 1024;

/** The picture actually delivered, as `getSettings()` reports it, as the
 * nearest standard height (a webview may give less than was asked). */
export function deliveredHeight(
  track: { getSettings?: () => { height?: number } } | undefined,
): number | null {
  const height = track?.getSettings?.().height;
  return typeof height === "number" && height > 0 ? Math.round(height) : null;
}

/** Whether a document name looks like a stored video's (by name only; the
 * vault decides from the file's first bytes). */
export const namedAsVideo = (name: string) => /\.mp4$/i.test(name.trim());
