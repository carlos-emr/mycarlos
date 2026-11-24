import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride } from "../i18n";
import { humanText, visibleText } from "../test/humanText";
import { RecordDialog, type RecordBridge } from "./RecordDialog";
import { readDeviceChoice } from "./mediaDevices";

const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
};
const KEY = "mycarlos.videoDevices.v1";

// A FAKE recorder: it records nothing.
class FakeRecorder extends EventTarget {
  static isTypeSupported = (type: string) => type.startsWith("video/mp4");
  state = "inactive";
  constructor(readonly stream: MediaStream) {
    super();
  }
  start() {
    this.state = "recording";
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }
}

type FakeDevice = { deviceId: string; label: string; kind: MediaDeviceKind };
const camera = (deviceId: string, label: string): FakeDevice => ({
  deviceId,
  label,
  kind: "videoinput",
});
const microphone = (deviceId: string, label: string): FakeDevice => ({
  deviceId,
  label,
  kind: "audioinput",
});
const LAPTOP = camera("cam-a", "FAKE Laptop camera");
const WEBCAM = camera("cam-b", "FAKE USB webcam");
const BUILT_IN = microphone("mic-a", "FAKE Built-in microphone");
const HEADSET = microphone("mic-b", "FAKE Headset microphone");

// FAKE media: a painted canvas and a quiet tone, each track saying which device it came from.
const streams: MediaStream[] = [];
const timers: number[] = [];
const contexts: AudioContext[] = [];
function fakeStream(cameraId: string, microphoneId: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const drawing = canvas.getContext("2d")!;
  const paint = () => {
    drawing.fillStyle = "#1d6fb8";
    drawing.fillRect(0, 0, 320, 240);
  };
  paint();
  timers.push(window.setInterval(paint, 40));
  const stream = canvas.captureStream(15);
  const audio = new AudioContext();
  contexts.push(audio);
  void audio.resume();
  const tone = audio.createOscillator();
  tone.frequency.value = 440;
  const destination = audio.createMediaStreamDestination();
  tone.connect(destination);
  tone.start();
  for (const track of destination.stream.getAudioTracks())
    stream.addTrack(track);
  Object.assign(stream.getVideoTracks()[0]!, {
    getSettings: () => ({ width: 1280, height: 720, deviceId: cameraId }),
    getCapabilities: () => ({ width: { max: 1280 }, height: { max: 720 } }),
  });
  Object.assign(stream.getAudioTracks()[0]!, {
    getSettings: () => ({ deviceId: microphoneId }),
  });
  streams.push(stream);
  return stream;
}

let connected: FakeDevice[];
let getUserMedia: ReturnType<typeof vi.spyOn>;
let enumerate: ReturnType<typeof vi.spyOn>;
/** The device id a constraint asks for exactly, if it does. */
const exact = (constraint: unknown): string | undefined =>
  typeof constraint === "object" && constraint !== null
    ? (constraint as { deviceId?: { exact?: string } }).deviceId?.exact
    : undefined;

beforeEach(() => {
  setLocaleOverride("en");
  window.localStorage.removeItem(KEY);
  window.localStorage.removeItem("mycarlos.videoQuality.v1");
  connected = [LAPTOP, WEBCAM, BUILT_IN, HEADSET];
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  enumerate = vi
    .spyOn(navigator.mediaDevices, "enumerateDevices")
    .mockImplementation(async () => connected as MediaDeviceInfo[]);
  // The first device of each kind is the system's default.
  getUserMedia = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockImplementation(async (constraints?: MediaStreamConstraints) => {
      const wantedCamera = exact(constraints?.video);
      const wantedMicrophone = exact(constraints?.audio);
      for (const id of [wantedCamera, wantedMicrophone])
        if (id && !connected.some((device) => device.deviceId === id))
          throw Object.assign(new Error("FAKE device is gone"), {
            name: "OverconstrainedError",
          });
      return fakeStream(
        wantedCamera ??
          connected.find((d) => d.kind === "videoinput")!.deviceId,
        wantedMicrophone ??
          connected.find((d) => d.kind === "audioinput")!.deviceId,
      );
    });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  getUserMedia.mockRestore();
  enumerate.mockRestore();
  for (const timer of timers.splice(0)) window.clearInterval(timer);
  for (const stream of streams.splice(0))
    for (const track of stream.getTracks()) track.stop();
  for (const context of contexts.splice(0)) void context.close();
  window.localStorage.removeItem(KEY);
});

function fakeBridge() {
  return {
    videoStart: vi.fn(async () => ({ recordingId: "recording-1" })),
    videoAppend: vi.fn(async () => ({
      storedBytes: 1,
      fragments: 0,
      hasVideo: true,
      hasAudio: true,
      nextSequence: 1,
      space: "ok" as const,
      freeBytes: null,
    })),
    videoSpace: vi.fn(async () => ({
      freeBytes: 50 * 1024 ** 3,
      level: "ok" as const,
      canRecord: true,
    })),
    videoPause: vi.fn(async () => undefined),
    videoResume: vi.fn(async () => undefined),
    videoStop: vi.fn(async () => ({ recordId: "video-1" })),
  } satisfies RecordBridge;
}

function open() {
  return render(
    <RecordDialog
      platform="windows"
      bridge={fakeBridge()}
      profileId="profile-1"
      folderIds={[]}
      holdLock={() => () => undefined}
      notice=""
      onSaved={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}
async function ready() {
  fireEvent.click(screen.getByRole("button", { name: /Use the camera/ }));
  await screen.findByRole("button", { name: "Start recording" });
}
const cameraList = () =>
  screen.getByRole("combobox", { name: "Camera" }) as HTMLSelectElement;
const microphoneList = () =>
  screen.getByRole("combobox", { name: "Microphone" }) as HTMLSelectElement;
const names = (select: HTMLSelectElement) =>
  [...select.options].map((option) => visibleText(option.textContent ?? ""));

describe("choosing the camera and the microphone", () => {
  it("lists them by name once they are allowed, with the one in use selected", async () => {
    open();
    // Nothing is asked of the devices, and nothing listed, before the patient chooses.
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox")).toBeNull();
    await ready();
    expect(names(cameraList())).toEqual([
      "FAKE Laptop camera",
      "FAKE USB webcam",
    ]);
    expect(names(microphoneList())).toEqual([
      "FAKE Built-in microphone",
      "FAKE Headset microphone",
    ]);
    // The system's default is used until a device is chosen: no exact device in the request.
    const first = getUserMedia.mock.calls[0]![0];
    expect(exact(first.video)).toBeUndefined();
    expect(first.audio).toBe(true);
    expect(cameraList().value).toBe("cam-a");
    expect(microphoneList().value).toBe("mic-a");
    expect(cameraList()).toBeEnabled();
    expect(microphoneList()).toBeEnabled();
  });

  it("restarts the preview on exactly the device chosen, stops the old stream and remembers it", async () => {
    open();
    await ready();
    const before = streams[0]!;
    fireEvent.change(microphoneList(), { target: { value: "mic-b" } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    const asked = getUserMedia.mock.calls[1]![0];
    // The headset exactly; the camera keeps the one that was in use, also exactly.
    expect(exact(asked.audio)).toBe("mic-b");
    expect(exact(asked.video)).toBe("cam-a");
    expect(
      before.getTracks().every((track) => track.readyState === "ended"),
    ).toBe(true);
    await screen.findByRole("button", { name: "Start recording" });
    expect(microphoneList().value).toBe("mic-b");
    expect(cameraList().value).toBe("cam-a");
    expect(readDeviceChoice()).toEqual({
      camera: "cam-a",
      microphone: "mic-b",
    });
    // The focus stays on the list that was used, not on Start recording.
    await waitFor(() => expect(document.activeElement).toBe(microphoneList()));
    fireEvent.change(cameraList(), { target: { value: "cam-b" } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(3));
    const third = getUserMedia.mock.calls[2]![0];
    expect(exact(third.video)).toBe("cam-b");
    expect(exact(third.audio)).toBe("mic-b");
  });

  it("uses the devices chosen last on this device, outside the vault", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ camera: "cam-b", microphone: "mic-b" }),
    );
    open();
    await ready();
    const first = getUserMedia.mock.calls[0]![0];
    expect(exact(first.video)).toBe("cam-b");
    expect(exact(first.audio)).toBe("mic-b");
    expect(cameraList().value).toBe("cam-b");
    expect(microphoneList().value).toBe("mic-b");
    expect(
      screen.queryByText(/is not connected, so the system's default/),
    ).toBeNull();
  });

  it("gives way only the remembered device that is gone, and says so", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ camera: "cam-gone", microphone: "mic-b" }),
    );
    open();
    await ready();
    // Both remembered, one gone: all together, then the camera alone (refused), then the
    // microphone alone with the default camera (opens).
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    expect(exact(getUserMedia.mock.calls[0]![0].video)).toBe("cam-gone");
    expect(exact(getUserMedia.mock.calls[1]![0].video)).toBe("cam-gone");
    const last = getUserMedia.mock.calls[2]![0];
    expect(exact(last.video)).toBeUndefined();
    // The microphone the patient chose is kept.
    expect(exact(last.audio)).toBe("mic-b");
    expect(
      screen.getByText(
        humanText(
          "The camera or microphone you used last is not connected, so the system's default is in use.",
        ),
      ),
    ).toBeVisible();
    expect(cameraList().value).toBe("cam-a");
    expect(microphoneList().value).toBe("mic-b");
    // The remembered choice is not overwritten by the fallback, so the camera is used again when
    // it is plugged back in.
    expect(readDeviceChoice()).toEqual({
      camera: "cam-gone",
      microphone: "mic-b",
    });
    // Nothing else was lost: the preview works, and a choice made now is remembered.
    fireEvent.change(cameraList(), { target: { value: "cam-b" } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(4));
    await waitFor(() =>
      expect(
        screen.queryByText(/is not connected, so the system's default/),
      ).toBeNull(),
    );
    expect(readDeviceChoice()).toEqual({
      camera: "cam-b",
      microphone: "mic-b",
    });
  });

  it("falls back to the default for both when both remembered devices are gone", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ camera: "cam-gone", microphone: "mic-gone" }),
    );
    open();
    await ready();
    const last = getUserMedia.mock.calls.at(-1)![0];
    expect(exact(last.video)).toBeUndefined();
    expect(last.audio).toBe(true);
    expect(cameraList().value).toBe("cam-a");
    expect(microphoneList().value).toBe("mic-a");
  });

  it("says a remembered device is gone even when the devices cannot be listed", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ camera: "cam-gone", microphone: null }),
    );
    enumerate.mockImplementation(async () => {
      throw new Error("FAKE enumerateDevices refused");
    });
    open();
    await ready();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(
      screen.getByText(
        humanText(
          "The camera or microphone you used last is not connected, so the system's default is in use.",
        ),
      ),
    ).toBeVisible();
  });

  it("remembers a device only once its stream has opened", async () => {
    open();
    await ready();
    getUserMedia.mockImplementationOnce(async () => {
      throw Object.assign(new Error("FAKE camera is busy"), {
        name: "NotReadableError",
      });
    });
    fireEvent.change(cameraList(), { target: { value: "cam-b" } });
    await screen.findByRole("button", { name: /Try again/ });
    // The busy camera was not saved, so "Try again" does not ask for it for ever.
    expect(readDeviceChoice()).toEqual({ camera: null, microphone: null });
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await screen.findByRole("button", { name: "Start recording" });
    expect(exact(getUserMedia.mock.calls.at(-1)![0].video)).toBeUndefined();
  });

  it("follows a camera or microphone being plugged in or unplugged", async () => {
    open();
    await ready();
    const extra = camera("cam-c", "FAKE Document camera");
    connected = [...connected, extra];
    await act(async () => {
      navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
    });
    await waitFor(() =>
      expect(names(cameraList())).toEqual([
        "FAKE Laptop camera",
        "FAKE USB webcam",
        "FAKE Document camera",
      ]),
    );
    // The preview was not restarted by a device appearing.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    connected = connected.filter((device) => device.deviceId !== "mic-b");
    await act(async () => {
      navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
    });
    // One microphone is left: plain text, so the patient still sees which one is in use.
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "Microphone" })).toBeNull(),
    );
    expect(screen.getByText("FAKE Built-in microphone")).toBeVisible();
  });

  it("shows a single device as plain text, with its name", async () => {
    connected = [LAPTOP, BUILT_IN];
    open();
    await ready();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("FAKE Laptop camera")).toBeVisible();
    expect(screen.getByText("FAKE Built-in microphone")).toBeVisible();
    expect(screen.getByText(humanText("Camera:"))).toBeVisible();
    expect(screen.getByText(humanText("Microphone:"))).toBeVisible();
  });

  it("names a device the browser gives no name to, by its place in the list", async () => {
    connected = [
      camera("cam-a", ""),
      camera("cam-b", ""),
      microphone("mic-a", ""),
    ];
    open();
    await ready();
    expect(names(cameraList())).toEqual(["Camera 1", "Camera 2"]);
    expect(screen.getByText(humanText("Microphone 1"))).toBeVisible();
  });

  it("cannot be switched while recording or paused, and the recording keeps its devices", async () => {
    open();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await screen.findByRole("button", { name: "Pause recording" });
    expect(cameraList()).toBeDisabled();
    expect(microphoneList()).toBeDisabled();
    fireEvent.change(cameraList(), { target: { value: "cam-b" } });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Pause recording" }));
    await screen.findByRole("button", { name: "Resume recording" });
    expect(cameraList()).toBeDisabled();
    expect(microphoneList()).toBeDisabled();
    // A device list changing during a recording changes the lists, not the recording.
    connected = [...connected, camera("cam-c", "FAKE Document camera")];
    await act(async () => {
      navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
    });
    await waitFor(() => expect(cameraList().options).toHaveLength(3));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(cameraList()).toBeDisabled();
  });

  it("tests the microphone with a level bar that is only on while testing and before recording", async () => {
    open();
    await ready();
    expect(screen.queryByRole("meter")).toBeNull();
    // A browser keeps audio suspended until a trusted click, which a test cannot make; the level
    // reading is checked against an analyser that reports a loud signal.
    const closed = vi.fn(async () => undefined);
    const resumed = vi.fn(async () => undefined);
    class LoudContext {
      destination = {};
      createAnalyser = () => ({
        fftSize: 0,
        connect: () => undefined,
        getByteTimeDomainData: (samples: Uint8Array) => samples.fill(192),
      });
      createGain = () => ({ gain: { value: 1 }, connect: () => undefined });
      createMediaStreamSource = () => ({ connect: () => undefined });
      resume = resumed;
      close = closed;
    }
    vi.stubGlobal("AudioContext", LoudContext);
    const test = screen.getByRole("button", { name: "Test microphone" });
    fireEvent.click(test);
    const meter = await screen.findByRole("meter", {
      name: "Microphone level",
    });
    // The fake microphone plays a tone, so the bar moves.
    await waitFor(
      () =>
        expect(Number((meter as HTMLMeterElement).value)).toBeGreaterThan(0),
      {
        timeout: 4000,
      },
    );
    expect(
      screen.getByRole("button", { name: "Stop testing" }),
    ).toHaveAttribute("aria-pressed", "true");
    // Half of full scale (192 against a centre of 128).
    expect(Number((meter as HTMLMeterElement).value)).toBeCloseTo(0.5, 1);
    expect(resumed).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop testing" }));
    expect(screen.queryByRole("meter")).toBeNull();
    // Stopping lets go of the audio context.
    expect(closed).toHaveBeenCalled();
    // Starting a recording ends the test and takes the button away.
    fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
    await screen.findByRole("meter");
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await screen.findByRole("button", { name: "Pause recording" });
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByRole("button", { name: /microphone$/ })).toBeNull();
  });

  it("has no accessibility violations and speaks the patient's language", async () => {
    open();
    await ready();
    expect(await axe.run(document.body, AXE)).toHaveProperty("violations", []);
    cleanup();
    setLocaleOverride("es");
    open();
    fireEvent.click(screen.getByRole("button", { name: /Usar la cámara/ }));
    expect(
      await screen.findByRole("combobox", { name: "Cámara" }),
    ).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Micrófono" })).toBeVisible();
  });
});
