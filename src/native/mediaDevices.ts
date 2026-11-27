// Which camera and which microphone a recording uses (#359). Many computers have several of
// each (a laptop camera and a webcam, a headset and a built-in microphone), and the system's
// default is not always the one the patient means. The choice is remembered on this device,
// outside the vault, like the picture quality; it holds only the browser's own opaque device
// ids, never a name.

/** One camera or microphone as the dialog lists it: the browser's id and its name, which the
 * browser withholds until the camera and microphone have been allowed once. `group` is the
 * browser's group id ("" where it gives none): the physical device behind the id, which is how a
 * stream opened on the system's default is matched to the device that is really the default. */
export interface DeviceInfo {
  id: string;
  label: string;
  group: string;
}

export interface DeviceLists {
  cameras: DeviceInfo[];
  microphones: DeviceInfo[];
}

/** What the patient chose last, by the browser's device id; null is "the system's default". */
export interface DeviceChoice {
  camera: string | null;
  microphone: string | null;
}

export const NO_CHOICE: DeviceChoice = { camera: null, microphone: null };
export const NO_DEVICES: DeviceLists = { cameras: [], microphones: [] };

const DEVICE_KEY = "mycarlos.videoDevices.v1";
/** A device id is opaque and short; anything else read back is not one. */
const MAX_ID_LENGTH = 256;

const cleanId = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : null;

/** The devices chosen last on this device (outside the vault, like the picture quality). */
export function readDeviceChoice(): DeviceChoice {
  try {
    const saved: unknown = JSON.parse(
      window.localStorage.getItem(DEVICE_KEY) ?? "null",
    );
    if (typeof saved === "object" && saved !== null) {
      const record = saved as Record<string, unknown>;
      return {
        camera: cleanId(record.camera),
        microphone: cleanId(record.microphone),
      };
    }
  } catch {
    // The system's defaults are used.
  }
  return NO_CHOICE;
}

export function rememberDeviceChoice(choice: DeviceChoice): void {
  try {
    window.localStorage.setItem(DEVICE_KEY, JSON.stringify(choice));
  } catch {
    // The system's defaults are used next time.
  }
}

/** Browsers list the default device twice, once under an alias id; the alias is not a device. */
const ALIASES = new Set(["default", "communications"]);

/** The cameras and microphones now connected. Before the first permission the browser lists
 * entries with no id; they are not usable, so they are left out. Never throws. */
export async function listDevices(
  media: Pick<MediaDevices, "enumerateDevices"> | undefined,
): Promise<DeviceLists> {
  try {
    const all = (await media?.enumerateDevices()) ?? [];
    const pick = (kind: MediaDeviceKind): DeviceInfo[] =>
      all
        .filter(
          (device) =>
            device.kind === kind &&
            device.deviceId !== "" &&
            !ALIASES.has(device.deviceId),
        )
        .map((device) => ({
          id: device.deviceId,
          label: device.label,
          group: device.groupId ?? "",
        }));
    return { cameras: pick("videoinput"), microphones: pick("audioinput") };
  } catch {
    return NO_DEVICES;
  }
}

/** The picture constraints for a chosen camera: its exact id, and no facing mode (a phone's
 * "back camera" preference is for when nothing was chosen). */
export function cameraConstraints(
  base: MediaTrackConstraints,
  camera: string | null,
): MediaTrackConstraints {
  if (!camera) return base;
  const { facingMode: _facing, ...rest } = base;
  return { ...rest, deviceId: { exact: camera } };
}

/** The sound constraints for a chosen microphone: its exact id, or any. */
export function microphoneConstraints(
  microphone: string | null,
): true | MediaTrackConstraints {
  return microphone ? { deviceId: { exact: microphone } } : true;
}

/** Whether an error from asking for an exact device means that device is not there. */
export function deviceIsGone(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "OverconstrainedError" || name === "NotFoundError";
}

/** The ids, among the listed devices, that the open tracks really use, for showing which device is
 * in use. A stream opened with no device chosen reports the system's default under an alias id
 * (Chromium says "default" for a microphone), which is not in the lists; it is matched to the
 * listed device with the same group id. A device that cannot be matched is null ("the system's
 * default", never the first one listed). */
export function devicesInUse(
  stream: MediaStream,
  lists: DeviceLists,
): DeviceChoice {
  const id = (
    track: MediaStreamTrack | undefined,
    devices: DeviceInfo[],
  ): string | null => {
    try {
      const settings = track?.getSettings();
      const reported = cleanId(settings?.deviceId);
      if (reported && devices.some((device) => device.id === reported))
        return reported;
      const group = settings?.groupId;
      if (group)
        return devices.find((device) => device.group === group)?.id ?? null;
    } catch {
      // Nothing is known about the device in use.
    }
    return null;
  };
  return {
    camera: id(stream.getVideoTracks()[0], lists.cameras),
    microphone: id(stream.getAudioTracks()[0], lists.microphones),
  };
}

/** A reading of how loud the microphone is now, between 0 and 1, and how to let go of it. */
export interface LevelReader {
  read(): number;
  close(): void;
}

/** Listens to the audio track of an open stream, only to measure it: nothing is recorded, kept
 * or sent. Null where the webview has no audio analysis. */
export function openLevelReader(stream: MediaStream): LevelReader | null {
  const Context: typeof AudioContext | undefined =
    typeof AudioContext === "undefined" ? undefined : AudioContext;
  if (!Context || stream.getAudioTracks().length === 0) return null;
  try {
    const context = new Context();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    // A context made outside a click can start suspended; the patient's click on the test button
    // is what lets it run.
    void context.resume().catch(() => undefined);
    // Pulled through a muted gain, so the analyser is always processed but nothing reaches the
    // speakers: no echo.
    const muted = context.createGain();
    muted.gain.value = 0;
    context
      .createMediaStreamSource(new MediaStream(stream.getAudioTracks()))
      .connect(analyser);
    analyser.connect(muted);
    muted.connect(context.destination);
    const samples = new Uint8Array(analyser.fftSize);
    return {
      read() {
        analyser.getByteTimeDomainData(samples);
        let peak = 0;
        for (const sample of samples)
          peak = Math.max(peak, Math.abs(sample - 128));
        // 0 is silence, 1 is as loud as the signal gets.
        return Math.min(1, peak / 128);
      },
      close() {
        void context.close().catch(() => undefined);
      },
    };
  } catch {
    return null;
  }
}
