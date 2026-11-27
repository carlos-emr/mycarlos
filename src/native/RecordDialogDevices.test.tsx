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
  static made: FakeRecorder[] = [];
  state = "inactive";
  mimeType = "audio/webm";
  constructor(
    readonly stream: MediaStream,
    readonly options?: MediaRecorderOptions,
  ) {
    super();
    FakeRecorder.made.push(this);
  }
  /** A piece of what the microphone picked up (a test clip is made of these). */
  give(text: string) {
    this.dispatchEvent(
      Object.assign(new Event("dataavailable"), { data: new Blob([text]) }),
    );
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

type FakeDevice = {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  groupId?: string;
};
const camera = (deviceId: string, label: string): FakeDevice => ({
  deviceId,
  label,
  kind: "videoinput",
});
const microphone = (
  deviceId: string,
  label: string,
  groupId?: string,
): FakeDevice => ({
  deviceId,
  label,
  kind: "audioinput",
  ...(groupId && { groupId }),
});
const LAPTOP = camera("cam-a", "FAKE Laptop camera");
const WEBCAM = camera("cam-b", "FAKE USB webcam");
const BUILT_IN = microphone("mic-a", "FAKE Built-in microphone");
const HEADSET = microphone("mic-b", "FAKE Headset microphone");

// FAKE media: a painted canvas and a quiet tone, each track saying which device it came from.
const streams: MediaStream[] = [];
const timers: number[] = [];
const contexts: AudioContext[] = [];
/** What a stream opened on the system's default microphone says about it, when a test needs the
 * browser's real habit: Chromium reports the ALIAS id "default" (not in the lists), with the
 * group id of the physical device it stands for. */
let defaultMicrophoneReport: { deviceId: string; groupId?: string } | null;
function fakeStream(
  cameraId: string,
  microphoneId: string,
  microphoneReport?: { deviceId: string; groupId?: string },
) {
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
    getSettings: () => microphoneReport ?? { deviceId: microphoneId },
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
  defaultMicrophoneReport = null;
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
        wantedMicrophone ? undefined : (defaultMicrophoneReport ?? undefined),
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

function open(bridge: RecordBridge = fakeBridge()) {
  return render(
    <RecordDialog
      platform="windows"
      bridge={bridge}
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
    expect(exact(first.audio)).toBeUndefined();
    expect(first.audio).toEqual({ sampleRate: { ideal: 48000 } });
    expect(cameraList().value).toBe("cam-a");
    expect(microphoneList().value).toBe("mic-a");
    expect(cameraList()).toBeEnabled();
    expect(microphoneList()).toBeEnabled();
  });

  it("switches only the device chosen: the other one keeps running and the choice is remembered", async () => {
    open();
    await ready();
    const stream = streams[0]!;
    const picture = document.querySelector("video")!;
    const cameraTrack = stream.getVideoTracks()[0]!;
    const oldMicrophone = stream.getAudioTracks()[0]!;
    // The dialog puts the keyboard on Start when the preview comes up; the patient then moves to
    // the list (wait for that, so it cannot take the focus back).
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Start recording" }),
      ),
    );
    microphoneList().focus();
    fireEvent.change(microphoneList(), { target: { value: "mic-b" } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    // The headset only, exactly: no camera in the request, so the camera is not asked again.
    const asked = getUserMedia.mock.calls[1]![0];
    expect(exact(asked.audio)).toBe("mic-b");
    expect(asked.video).toBeUndefined();
    await waitFor(() => expect(microphoneList().value).toBe("mic-b"));
    expect(cameraList().value).toBe("cam-a");
    // The same stream is still on the preview, with the same camera track still live; only the
    // sound track was swapped, and the old one let go of.
    expect(picture.srcObject).toBe(stream);
    expect(stream.getVideoTracks()).toHaveLength(1);
    expect(stream.getVideoTracks()[0]).toBe(cameraTrack);
    expect(cameraTrack.readyState).toBe("live");
    expect(oldMicrophone.readyState).toBe("ended");
    expect(stream.getAudioTracks()).toHaveLength(1);
    expect(stream.getAudioTracks()[0]).not.toBe(oldMicrophone);
    expect(stream.getAudioTracks()[0]!.readyState).toBe("live");
    // The dialog never left the ready state: Start is still there, and the keyboard is still on
    // the list that was used.
    expect(
      screen.getByRole("button", { name: "Start recording" }),
    ).toBeVisible();
    expect(document.activeElement).toBe(microphoneList());
    // Only the microphone, which was chosen, is remembered: the camera in use was not chosen, so
    // it stays "the system's default" (nothing stored) rather than being pinned.
    expect(readDeviceChoice()).toEqual({
      camera: null,
      microphone: "mic-b",
    });
    // And the other way round: a camera switch leaves the microphone track alone.
    const microphoneNow = stream.getAudioTracks()[0]!;
    fireEvent.change(cameraList(), { target: { value: "cam-b" } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(3));
    const third = getUserMedia.mock.calls[2]![0];
    expect(exact(third.video)).toBe("cam-b");
    expect(third.audio).toBeUndefined();
    await waitFor(() => expect(cameraList().value).toBe("cam-b"));
    expect(stream.getAudioTracks()).toHaveLength(1);
    expect(stream.getAudioTracks()[0]).toBe(microphoneNow);
    expect(microphoneNow.readyState).toBe("live");
    expect(cameraTrack.readyState).toBe("ended");
    expect(stream.getVideoTracks()).toHaveLength(1);
    expect(stream.getVideoTracks()[0]!.readyState).toBe("live");
    expect(picture.srcObject).toBe(stream);
    expect(readDeviceChoice()).toEqual({
      camera: "cam-b",
      microphone: "mic-b",
    });
  });

  it("lets go of anything extra a device request hands back", async () => {
    open();
    await ready();
    // A stub (like this test's own) may answer a sound-only request with a camera track too.
    microphoneList().focus();
    fireEvent.change(microphoneList(), { target: { value: "mic-b" } });
    await waitFor(() => expect(microphoneList().value).toBe("mic-b"));
    const spare = streams[1]!.getVideoTracks()[0]!;
    expect(spare.readyState).toBe("ended");
  });

  it("stops what it opened when the dialog is closed while the device is still opening", async () => {
    const view = open();
    await ready();
    let release: (() => void) | undefined;
    let opened: MediaStream | undefined;
    const real = getUserMedia.getMockImplementation()!;
    getUserMedia.mockImplementationOnce(
      async (constraints?: MediaStreamConstraints) => {
        await new Promise<void>((resolve) => (release = resolve));
        opened = await real(constraints);
        return opened;
      },
    );
    fireEvent.change(microphoneList(), { target: { value: "mic-b" } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    // Closed while the headset is still being asked for.
    view.unmount();
    release!();
    // The microphone that answers late is not wanted: no track of it is left on.
    await waitFor(() => expect(opened).toBeDefined());
    await waitFor(() =>
      expect(
        opened!.getTracks().every((track) => track.readyState === "ended"),
      ).toBe(true),
    );
    // And nothing was remembered for a device that never joined the preview.
    expect(readDeviceChoice()).toEqual({ camera: null, microphone: null });
  });

  it("refuses a switch while the recording is starting, and keeps the devices in use", async () => {
    // Start is pressed and the vault has not answered yet: the dialog is "starting".
    const bridge: RecordBridge = {
      ...fakeBridge(),
      videoStart: vi.fn(() => new Promise<never>(() => undefined)),
    };
    open(bridge);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(bridge.videoStart).toHaveBeenCalled());
    // The lists stay on the screen, but cannot be used meanwhile.
    expect(cameraList()).toBeDisabled();
    expect(microphoneList()).toBeDisabled();
    fireEvent.change(cameraList(), { target: { value: "cam-b" } });
    fireEvent.change(microphoneList(), { target: { value: "mic-b" } });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(cameraList().value).toBe("cam-a");
    expect(microphoneList().value).toBe("mic-a");
    expect(readDeviceChoice()).toEqual({ camera: null, microphone: null });
  });

  it("two change events in the same instant open one device, not two", async () => {
    open();
    await ready();
    let release: (() => void) | undefined;
    const real = getUserMedia.getMockImplementation()!;
    getUserMedia.mockImplementationOnce(
      async (constraints?: MediaStreamConstraints) => {
        await new Promise<void>((resolve) => (release = resolve));
        return real(constraints);
      },
    );
    // Both events are dispatched before React has drawn anything in between.
    act(() => {
      fireEvent.change(microphoneList(), { target: { value: "mic-b" } });
      fireEvent.change(cameraList(), { target: { value: "cam-b" } });
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    release!();
    await waitFor(() => expect(microphoneList().value).toBe("mic-b"));
    expect(cameraList().value).toBe("cam-a");
  });

  it("stops the clip when switching microphones, including a failed switch, and keeps it on a camera switch", async () => {
    // The real audio context, with an analyser that reports a loud signal (the fake devices of this
    // file also make their tone with it, so it must stay a real one).
    const Real = AudioContext;
    class LoudContext extends Real {
      override createAnalyser() {
        const analyser = super.createAnalyser();
        analyser.getByteTimeDomainData = (samples: Uint8Array<ArrayBuffer>) =>
          void samples.fill(192);
        return analyser;
      }
    }
    vi.stubGlobal("AudioContext", LoudContext);
    open();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
    await screen.findByRole("meter", { name: "Microphone level" });
    // Switching microphones discards the clip.
    fireEvent.change(microphoneList(), { target: { value: "mic-b" } });
    await waitFor(() => expect(microphoneList().value).toBe("mic-b"));
    expect(screen.queryByRole("meter")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
    await screen.findByRole("meter");
    // A failed microphone switch also discards the old clip.
    getUserMedia.mockImplementationOnce(async () => {
      throw Object.assign(new Error("FAKE microphone is busy"), {
        name: "NotReadableError",
      });
    });
    fireEvent.change(microphoneList(), { target: { value: "mic-a" } });
    await screen.findByText(
      humanText(
        "The camera or microphone you chose could not be opened, so the one in use is still on.",
      ),
    );
    expect(microphoneList().value).toBe("mic-b");
    expect(screen.queryByRole("meter")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
    await screen.findByRole("meter");
    // A camera switch never turns the test off.
    fireEvent.change(cameraList(), { target: { value: "cam-b" } });
    await waitFor(() => expect(cameraList().value).toBe("cam-b"));
    expect(
      screen.getByRole("meter", { name: "Microphone level" }),
    ).toBeVisible();
  });

  it("does not switch the microphone test on again behind the patient's back after the camera stopped during a switch", async () => {
    const Real = AudioContext;
    class LoudContext extends Real {
      override createAnalyser() {
        const analyser = super.createAnalyser();
        analyser.getByteTimeDomainData = (samples: Uint8Array<ArrayBuffer>) =>
          void samples.fill(192);
        return analyser;
      }
    }
    vi.stubGlobal("AudioContext", LoudContext);
    open();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
    await screen.findByRole("meter", { name: "Microphone level" });
    let release: (() => void) | undefined;
    const real = getUserMedia.getMockImplementation()!;
    getUserMedia.mockImplementationOnce(
      async (constraints?: MediaStreamConstraints) => {
        await new Promise<void>((resolve) => (release = resolve));
        return real(constraints);
      },
    );
    fireEvent.change(microphoneList(), { target: { value: "mic-b" } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    // The camera stops while the headset is still opening: the dialog says so and goes to failed.
    streams[0]!.getVideoTracks()[0]!.dispatchEvent(new Event("ended"));
    await screen.findByRole("button", { name: /Try again/ });
    release!();
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await screen.findByRole("button", { name: "Start recording" });
    // Back at ready, the test is off until the patient turns it on.
    expect(screen.queryByRole("meter")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Test microphone" }),
    ).toBeEnabled();
  });

  it("ignores a second choice while the first is still opening", async () => {
    open();
    await ready();
    let release: (() => void) | undefined;
    const real = getUserMedia.getMockImplementation()!;
    getUserMedia.mockImplementationOnce(
      async (constraints?: MediaStreamConstraints) => {
        await new Promise<void>((resolve) => (release = resolve));
        return real(constraints);
      },
    );
    fireEvent.change(microphoneList(), { target: { value: "mic-b" } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    // Start waits for it too (it is not pressed while the devices change under it).
    expect(
      screen.getByRole("button", { name: "Start recording" }),
    ).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(cameraList(), { target: { value: "cam-b" } });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    release!();
    await waitFor(() => expect(microphoneList().value).toBe("mic-b"));
    expect(cameraList().value).toBe("cam-a");
    expect(
      screen.getByRole("button", { name: "Start recording" }),
    ).toHaveAttribute("aria-disabled", "false");
  });

  it("remembers only the device chosen: choosing a camera leaves the microphone as it was stored", async () => {
    // Nothing stored: the microphone in use is the system's default and stays so.
    open();
    await ready();
    fireEvent.change(cameraList(), { target: { value: "cam-b" } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    await screen.findByRole("button", { name: "Start recording" });
    expect(readDeviceChoice()).toEqual({ camera: "cam-b", microphone: null });
    cleanup();
    // A stored microphone stays as it was, and is not replaced by the one in use.
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ camera: null, microphone: "mic-b" }),
    );
    open();
    await ready();
    fireEvent.change(cameraList(), { target: { value: "cam-b" } });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(4));
    await screen.findByRole("button", { name: "Start recording" });
    expect(readDeviceChoice()).toEqual({
      camera: "cam-b",
      microphone: "mic-b",
    });
  });

  it("shows the system's default microphone as the device it really is when the stream calls it 'default'", async () => {
    // Chromium's habit: no device chosen, the track says "default" (not listed), with the group
    // of the headset that is the system's default; the built-in one is listed first.
    connected = [
      LAPTOP,
      WEBCAM,
      microphone("mic-a", "FAKE Built-in microphone", "group-built-in"),
      microphone("mic-b", "FAKE Headset microphone", "group-headset"),
      microphone(
        "default",
        "Default - FAKE Headset microphone",
        "group-headset",
      ),
    ];
    defaultMicrophoneReport = { deviceId: "default", groupId: "group-headset" };
    open();
    await ready();
    // The alias is not a device of its own.
    expect(names(microphoneList())).toEqual([
      "FAKE Built-in microphone",
      "FAKE Headset microphone",
    ]);
    expect(microphoneList().value).toBe("mic-b");
    // Nothing was chosen, so nothing is stored.
    expect(readDeviceChoice()).toEqual({ camera: null, microphone: null });
  });

  it("says 'System default' rather than guessing the first device when the one in use cannot be matched", async () => {
    connected = [
      LAPTOP,
      WEBCAM,
      microphone("mic-a", "FAKE Built-in microphone", "group-built-in"),
      microphone("mic-b", "FAKE Headset microphone", "group-headset"),
    ];
    // The stream says "default" with a group that matches no listed device (or none at all).
    for (const report of [
      { deviceId: "default", groupId: "group-unknown" },
      { deviceId: "default" },
    ]) {
      defaultMicrophoneReport = report;
      const view = open();
      await ready();
      expect(microphoneList().value).toBe("");
      const shown = microphoneList().selectedOptions[0]!;
      expect(visibleText(shown.textContent ?? "")).toBe("System default");
      // It is a label for the state, not a choice: it cannot be picked again.
      expect(shown).toBeDisabled();
      // The real devices are still all there to choose.
      expect(names(microphoneList()).slice(1)).toEqual([
        "FAKE Built-in microphone",
        "FAKE Headset microphone",
      ]);
      view.unmount();
    }
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
    expect(last.audio).toEqual({ sampleRate: { ideal: 48000 } });
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

  it("keeps one standing status region for the fallback line, empty until needed", async () => {
    open();
    const region = document.querySelector(".record-device-note")!;
    // Present from the start and empty, so a screen reader is already watching it.
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("");
    await ready();
    expect(document.querySelector(".record-device-note")).toBe(region);
    expect(region).toHaveTextContent("");
  });

  it("remembers a device only once its stream has opened", async () => {
    open();
    await ready();
    getUserMedia.mockImplementationOnce(async () => {
      throw Object.assign(new Error("FAKE camera is busy"), {
        name: "NotReadableError",
      });
    });
    const stream = streams[0]!;
    const cameraTrack = stream.getVideoTracks()[0]!;
    fireEvent.change(cameraList(), { target: { value: "cam-b" } });
    // The camera that is busy does not open: the preview that was running stays (it is not torn
    // down for a camera that did not answer), the list shows the camera still in use, and the
    // dialog says the other one could not be opened.
    expect(
      await screen.findByText(
        humanText(
          "The camera or microphone you chose could not be opened, so the one in use is still on.",
        ),
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Start recording" }),
    ).toBeVisible();
    expect(cameraTrack.readyState).toBe("live");
    expect(stream.getVideoTracks()[0]).toBe(cameraTrack);
    expect(cameraList().value).toBe("cam-a");
    // The busy camera was not saved, so it is not asked for every time.
    expect(readDeviceChoice()).toEqual({ camera: null, microphone: null });
    // A later switch, to a device that does open, takes it back and clears the message.
    fireEvent.change(cameraList(), { target: { value: "cam-b" } });
    await waitFor(() => expect(cameraList().value).toBe("cam-b"));
    expect(
      screen.queryByText(/could not be opened, so the one in use is still on/),
    ).toBeNull();
    expect(readDeviceChoice()).toEqual({ camera: "cam-b", microphone: null });
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
    // One microphone is left: the list stays, disabled, with that one device in it.
    await waitFor(() => expect(microphoneList().options).toHaveLength(1));
    expect(microphoneList()).toBeDisabled();
    expect(names(microphoneList())).toEqual(["FAKE Built-in microphone"]);
  });

  it("shows a single device as a disabled list with that device, so it is clear where the choice is", async () => {
    connected = [LAPTOP, BUILT_IN];
    open();
    await ready();
    for (const [list, only] of [
      [cameraList(), "FAKE Laptop camera"],
      [microphoneList(), "FAKE Built-in microphone"],
    ] as const) {
      // Still a labelled list, the one device selected in it, and nothing to choose.
      expect(list.tagName).toBe("SELECT");
      expect(list).toBeDisabled();
      expect(list.options).toHaveLength(1);
      expect(names(list)).toEqual([only]);
      expect(list.selectedOptions[0]?.textContent).toBe(only);
    }
    // Both stay in the tab order's world: the labels are the visible words Camera and Microphone.
    expect(screen.getByText(humanText("Camera"))).toBeVisible();
    expect(screen.getByText(humanText("Microphone"))).toBeVisible();
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
    expect(names(microphoneList())).toEqual(["Microphone 1"]);
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
    // The bar says what to do with it.
    expect(
      screen.getByText(humanText("Say something: the bar should move.")),
    ).toBeVisible();
    // The fake microphone plays a tone, so the bar moves.
    await waitFor(
      () =>
        expect(Number((meter as HTMLMeterElement).value)).toBeGreaterThan(0),
      {
        timeout: 4000,
      },
    );
    expect(screen.getByRole("button", { name: "Stop testing" })).toBeVisible();
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

  describe("hearing the microphone back", () => {
    // FAKE player and addresses: nothing is played, and every address is accounted for.
    class FakePlayer {
      static made: FakePlayer[] = [];
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly src: string) {
        FakePlayer.made.push(this);
      }
      play = vi.fn(async () => undefined);
      pause = vi.fn();
      load = vi.fn();
      removeAttribute = vi.fn();
    }
    let created: string[];
    let revoked: string[];
    beforeEach(() => {
      FakeRecorder.made = [];
      FakePlayer.made = [];
      created = [];
      revoked = [];
      vi.stubGlobal("Audio", FakePlayer);
      vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
        created.push(`blob:fake/${created.length + 1}`);
        return created.at(-1)!;
      });
      vi.spyOn(URL, "revokeObjectURL").mockImplementation((address) => {
        revoked.push(address);
      });
    });
    /** The recorder the test made: the only one with no picture in its stream. */
    const clipRecorder = () =>
      FakeRecorder.made.find(
        (recorder) => recorder.stream.getVideoTracks().length === 0,
      )!;
    const startTest = () =>
      fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));

    it("records from the chosen microphone, plays it back once and drops it, with the state said", async () => {
      const bridge = fakeBridge();
      render(
        <RecordDialog
          platform="windows"
          bridge={bridge}
          profileId="profile-1"
          folderIds={[]}
          holdLock={() => () => undefined}
          notice=""
          onSaved={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      await ready();
      // The note to use headphones is there before anything starts.
      expect(screen.getByText(/headphones/i)).toBeVisible();
      fireEvent.change(microphoneList(), { target: { value: "mic-b" } });
      await waitFor(() => expect(microphoneList().value).toBe("mic-b"));
      await screen.findByRole("button", { name: "Test microphone" });
      startTest();
      // Recording: the state is said and Stop is offered, from the microphone chosen in the list.
      expect(await screen.findByText("Recording…")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Stop testing" }),
      ).toBeVisible();
      const recorder = clipRecorder();
      expect(recorder.stream.getAudioTracks()).toHaveLength(1);
      expect(recorder.stream.getAudioTracks()[0].getSettings().deviceId).toBe(
        "mic-b",
      );
      // About three seconds later the clip is played back once.
      recorder.give("what the microphone picked up");
      recorder.stop();
      expect(await screen.findByText("Playing back…")).toBeVisible();
      expect(created).toEqual(["blob:fake/1"]);
      expect(FakePlayer.made).toHaveLength(1);
      expect(FakePlayer.made[0].play).toHaveBeenCalledTimes(1);
      expect(revoked).toEqual([]);
      // When it ends the state clears, the address is revoked, and the button is back.
      act(() => FakePlayer.made[0].onended!());
      await screen.findByRole("button", { name: "Test microphone" });
      expect(screen.queryByText("Playing back…")).toBeNull();
      expect(revoked).toEqual(["blob:fake/1"]);
      // Nothing went to the vault: no recording was begun, and nothing was appended.
      expect(bridge.videoStart).not.toHaveBeenCalled();
      expect(bridge.videoAppend).not.toHaveBeenCalled();
    });

    it("asks for 48 kHz or more from the microphone and a bitrate of 128 kbps or more for the clip, on the stream the recording uses", async () => {
      open();
      await ready();
      // The one stream is the preview, the clip's source and the real recording's: sound is asked
      // for at 48 kHz in the one getUserMedia call.
      const audio = getUserMedia.mock.calls[0]![0].audio as {
        sampleRate?: { ideal?: number };
      };
      expect(audio.sampleRate?.ideal).toBeGreaterThanOrEqual(48_000);
      startTest();
      await screen.findByText("Recording…");
      const clip = clipRecorder();
      expect(clip.options?.audioBitsPerSecond).toBeGreaterThanOrEqual(128_000);
      // The same microphone track the real recording would use, not a copy or a second capture.
      const preview = streams[0].getAudioTracks()[0];
      expect(clip.stream.getAudioTracks()[0]).toBe(preview);
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    it("says so when the microphone captures at a low rate, and not when it does not", async () => {
      open();
      await ready();
      const track = streams[0].getAudioTracks()[0];
      Object.assign(track, {
        getSettings: () => ({ deviceId: "mic-a", sampleRate: 16_000 }),
      });
      startTest();
      await screen.findByText("Recording…");
      expect(
        screen.getByText(humanText(/records at 16 kHz.*sounds thin/)),
      ).toBeVisible();
      // Another microphone: the note is not shown beside it.
      fireEvent.change(microphoneList(), { target: { value: "mic-b" } });
      await waitFor(() =>
        expect(screen.queryByText(humanText(/sounds thin/))).toBeNull(),
      );
    });

    it("can be stopped while recording, and is not left running when the device is switched", async () => {
      open();
      await ready();
      startTest();
      await screen.findByText("Recording…");
      const recorder = clipRecorder();
      fireEvent.click(screen.getByRole("button", { name: "Stop testing" }));
      expect(recorder.state).toBe("inactive");
      expect(screen.queryByText("Recording…")).toBeNull();
      expect(created).toEqual([]);
      // Switching the microphone mid-test ends it too.
      startTest();
      await screen.findByText("Recording…");
      const second = FakeRecorder.made.at(-1)!;
      fireEvent.change(microphoneList(), { target: { value: "mic-b" } });
      await waitFor(() => expect(second.state).toBe("inactive"));
      expect(screen.queryByText("Recording…")).toBeNull();
    });

    // The clip has an address only while it plays back, so what is dropped on a switch or on Start
    // recording is shown only by doing them THEN.
    const playBack = async () => {
      startTest();
      await screen.findByText("Recording…");
      const recorder = clipRecorder();
      recorder.give("heard");
      recorder.stop();
      await screen.findByText("Playing back…");
      expect(created).toEqual(["blob:fake/1"]);
      expect(revoked).toEqual([]);
    };

    it("drops the clip and its address when the microphone is switched during playback, and shows no old failure", async () => {
      open();
      await ready();
      await playBack();
      fireEvent.change(microphoneList(), { target: { value: "mic-b" } });
      await waitFor(() => expect(revoked).toEqual(["blob:fake/1"]));
      expect(FakePlayer.made[0].removeAttribute).toHaveBeenCalledWith("src");
      expect(screen.queryByText("Playing back…")).toBeNull();
      expect(
        screen.queryByText("The microphone test did not work on this device."),
      ).toBeNull();
    });

    it("drops the clip and its address when a real recording starts during playback", async () => {
      open();
      await ready();
      await playBack();
      fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
      await screen.findByRole("button", { name: "Pause recording" });
      expect(revoked).toEqual(["blob:fake/1"]);
      expect(FakePlayer.made[0].removeAttribute).toHaveBeenCalledWith("src");
      expect(screen.queryByText("Playing back…")).toBeNull();
    });

    it("clears a failure of the old microphone's test when the microphone is switched", async () => {
      open();
      await ready();
      startTest();
      await screen.findByText("Recording…");
      // Nothing was picked up: the test says it did not work.
      clipRecorder().stop();
      await screen.findByText(
        "The microphone test did not work on this device.",
      );
      fireEvent.change(microphoneList(), { target: { value: "mic-b" } });
      await waitFor(() =>
        expect(
          screen.queryByText(
            "The microphone test did not work on this device.",
          ),
        ).toBeNull(),
      );
    });

    it("cannot run while a real recording is in progress, and a recording ends a test that is running", async () => {
      open();
      await ready();
      startTest();
      await screen.findByText("Recording…");
      const recorder = clipRecorder();
      fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
      await screen.findByRole("button", { name: "Pause recording" });
      // The test ended before the real recorder began, and there is no way to start another.
      expect(recorder.state).toBe("inactive");
      expect(
        screen.queryByRole("button", { name: "Test microphone" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Stop testing" })).toBeNull();
      expect(screen.queryByText("Recording…")).toBeNull();
      expect(screen.queryByText(/headphones/i)).toBeNull();
    });

    it("drops the clip and its address when the dialog closes during playback", async () => {
      const onClose = vi.fn();
      render(
        <RecordDialog
          platform="windows"
          bridge={fakeBridge()}
          profileId="profile-1"
          folderIds={[]}
          holdLock={() => () => undefined}
          notice=""
          onSaved={vi.fn()}
          onClose={onClose}
        />,
      );
      await ready();
      startTest();
      await screen.findByText("Recording…");
      const recorder = clipRecorder();
      recorder.give("heard");
      recorder.stop();
      await screen.findByText("Playing back…");
      expect(revoked).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onClose).toHaveBeenCalled();
      expect(revoked).toEqual(["blob:fake/1"]);
      expect(FakePlayer.made[0].removeAttribute).toHaveBeenCalledWith("src");
    });

    it("says so, with nothing kept, when nothing could be recorded", async () => {
      open();
      await ready();
      startTest();
      await screen.findByText("Recording…");
      // The recorder ends without a single piece.
      clipRecorder().stop();
      expect(
        await screen.findByText(
          "The microphone test did not work on this device.",
        ),
      ).toBeVisible();
      expect(created).toEqual([]);
      expect(screen.queryByText("Recording…")).toBeNull();
      // Trying again clears the note.
      startTest();
      await screen.findByText("Recording…");
      expect(
        screen.queryByText("The microphone test did not work on this device."),
      ).toBeNull();
    });
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
