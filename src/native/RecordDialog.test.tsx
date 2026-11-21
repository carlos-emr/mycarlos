import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride } from "../i18n";
import { humanText } from "../test/humanText";
import { MAX_UNSENT_BYTES } from "./video";
import { RecordDialog, type RecordBridge } from "./RecordDialog";

const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
};

// A FAKE recorder: it makes no video. A test hands it pieces, and it ends as the
// real one does, with a last piece and then a stop event.
class FakeRecorder extends EventTarget {
  static all: FakeRecorder[] = [];
  static isTypeSupported = (type: string) => type.startsWith("video/mp4");
  state: "inactive" | "recording" | "paused" = "inactive";
  timeslice: number | undefined;
  calls: string[] = [];
  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions,
  ) {
    super();
    FakeRecorder.all.push(this);
  }
  start(timeslice?: number) {
    this.timeslice = timeslice;
    this.state = "recording";
    this.calls.push("start");
  }
  pause() {
    this.state = "paused";
    this.calls.push("pause");
  }
  resume() {
    this.state = "recording";
    this.calls.push("resume");
  }
  requestData() {
    this.calls.push("requestData");
    this.emit(new Blob([new Uint8Array(10).fill(9)]));
  }
  stop() {
    this.calls.push("stop");
    this.emit(new Blob([new Uint8Array(20).fill(8)]));
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }
  emit(blob: Blob) {
    const event = new Event("dataavailable") as Event & { data: Blob };
    event.data = blob;
    this.dispatchEvent(event);
  }
}
const recorder = () => FakeRecorder.all[FakeRecorder.all.length - 1]!;

// FAKE media: a canvas painted one colour as the picture and a quiet sine tone
// as the sound. Nothing real is recorded or heard.
const streams: MediaStream[] = [];
const painters: number[] = [];
const contexts: AudioContext[] = [];
function fakeCameraAndMicrophone(highest = { width: 1280, height: 720 }) {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d")!;
  const paint = () => {
    context.fillStyle = "#1d6fb8";
    context.fillRect(0, 0, 320, 240);
  };
  paint();
  painters.push(window.setInterval(paint, 40));
  const stream = canvas.captureStream(15);
  const audio = new AudioContext();
  contexts.push(audio);
  const tone = audio.createOscillator();
  tone.frequency.value = 440;
  const destination = audio.createMediaStreamDestination();
  tone.connect(destination);
  tone.start();
  for (const track of destination.stream.getAudioTracks())
    stream.addTrack(track);
  const video = stream.getVideoTracks()[0]!;
  Object.assign(video, {
    getCapabilities: () => ({
      width: { max: highest.width },
      height: { max: highest.height },
    }),
    getSettings: () => ({ width: 1280, height: 720 }),
  });
  streams.push(stream);
  return stream;
}

let getUserMedia: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  setLocaleOverride("en");
  window.localStorage.removeItem("mycarlos.videoQuality.v1");
  FakeRecorder.all = [];
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  getUserMedia = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockImplementation(async () => fakeCameraAndMicrophone());
});
afterEach(() => {
  vi.unstubAllGlobals();
  getUserMedia.mockRestore();
  for (const timer of painters.splice(0)) window.clearInterval(timer);
  for (const stream of streams.splice(0))
    for (const track of stream.getTracks()) track.stop();
  for (const context of contexts.splice(0)) void context.close();
  window.localStorage.removeItem("mycarlos.videoQuality.v1");
});

function fakeBridge(overrides: Partial<RecordBridge> = {}) {
  let next = 0;
  const bridge = {
    videoStart: vi.fn(async () => ({ recordingId: "recording-1" })),
    videoAppend: vi.fn(
      async (_id: string, _sequence: number, _piece: Uint8Array) => ({
        storedBytes: 1,
        fragments: 0,
        hasVideo: true,
        hasAudio: true,
        nextSequence: ++next,
      }),
    ),
    videoPause: vi.fn(async () => undefined),
    videoResume: vi.fn(async () => undefined),
    videoStop: vi.fn(async () => ({ recordId: "video-1" })),
    ...overrides,
  } satisfies RecordBridge;
  return bridge;
}

function open(
  overrides: Partial<Parameters<typeof RecordDialog>[0]> = {},
  bridge: RecordBridge = fakeBridge(),
) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const released = vi.fn();
  const holdLock = vi.fn(() => released);
  const view = render(
    <RecordDialog
      platform="windows"
      bridge={bridge}
      profileId="profile-1"
      folderIds={["folder-1"]}
      holdLock={holdLock}
      notice=""
      onSaved={onSaved}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { ...view, bridge, onSaved, onClose, holdLock, released };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });
async function readyToRecord() {
  fireEvent.click(button("Use the camera and microphone"));
  await screen.findByRole("button", { name: "Start recording" });
}
async function recording(
  bridge: RecordBridge = fakeBridge(),
  overrides: Partial<Parameters<typeof RecordDialog>[0]> = {},
) {
  const view = open(overrides, bridge);
  await readyToRecord();
  fireEvent.click(button("Start recording"));
  await screen.findByRole("button", { name: "Pause recording" });
  return view;
}
const piece = (size = 100) => new Blob([new Uint8Array(size).fill(7)]);

describe("RecordDialog", () => {
  it("asks for neither the camera nor the microphone until the patient chooses to use them", async () => {
    const { bridge } = open();
    expect(
      screen.getByText(
        "The video is recorded with sound. People near you may be heard. Only you can open it.",
      ),
    ).toBeVisible();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(bridge.videoStart).not.toHaveBeenCalled();
    fireEvent.click(button("Use the camera and microphone"));
    await screen.findByRole("button", { name: "Start recording" });
    // Video and sound together, once; nothing is recorded or started yet.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0]![0]).toMatchObject({ audio: true });
    expect(bridge.videoStart).not.toHaveBeenCalled();
    expect(FakeRecorder.all).toHaveLength(0);
    expect(
      screen.getByText(/nothing is recorded until you choose Start recording/),
    ).toBeVisible();
  });

  it("shows Standard alone where the camera cannot do 1080p, and High where it reports it", async () => {
    const first = open();
    await readyToRecord();
    expect(
      screen.getByRole("radio", { name: /Standard \(720p\)/ }),
    ).toBeChecked();
    expect(screen.queryByRole("radio", { name: /High/ })).toBeNull();
    first.unmount();

    getUserMedia.mockImplementation(async () =>
      fakeCameraAndMicrophone({ width: 1920, height: 1080 }),
    );
    open();
    await readyToRecord();
    expect(screen.getByRole("radio", { name: /High \(1080p\)/ })).toBeVisible();
    expect(screen.getByText("About 2.5 to 4 GB an hour")).toBeVisible();
    fireEvent.click(screen.getByRole("radio", { name: /High \(1080p\)/ }));
    expect(window.localStorage.getItem("mycarlos.videoQuality.v1")).toBe(
      "high",
    );
  });

  it("sends each piece to the vault in order with the sequence number it asked for, then saves on Stop", async () => {
    const bridge = fakeBridge();
    const { onSaved, onClose } = await recording(bridge);
    expect(bridge.videoStart).toHaveBeenCalledWith(
      "profile-1",
      ["folder-1"],
      expect.stringMatching(/^Video, .*\.mp4$/),
    );
    expect(recorder().timeslice).toBe(1000);
    expect(recorder().options.mimeType).toMatch(/^video\/mp4/);
    act(() => {
      recorder().emit(piece(100));
      recorder().emit(piece(200));
      recorder().emit(piece(300));
    });
    await waitFor(() => expect(bridge.videoAppend).toHaveBeenCalledTimes(3));
    expect(
      vi
        .mocked(bridge.videoAppend)
        .mock.calls.map(([id, sequence, bytes]) => [
          id,
          sequence,
          bytes.length,
        ]),
    ).toEqual([
      ["recording-1", 0, 100],
      ["recording-1", 1, 200],
      ["recording-1", 2, 300],
    ]);
    fireEvent.click(button("Stop and save"));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith("video-1", "asked"),
    );
    // The recorder's last piece went before the video was ended.
    expect(bridge.videoAppend).toHaveBeenCalledTimes(4);
    expect(bridge.videoStop).toHaveBeenCalledWith("recording-1");
    expect(recorder().state).toBe("inactive");
    // Every track is stopped.
    expect(
      streams.every((s) =>
        s.getTracks().every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("pauses without ending the video, says so aloud, and the camera and microphone stay on", async () => {
    const bridge = fakeBridge();
    await recording(bridge);
    const status = screen.getByRole("status");
    expect(
      screen.getByText("Recording", { selector: ".record-badge span" }),
    ).toBeVisible();
    fireEvent.click(button("Pause recording"));
    await waitFor(() =>
      expect(bridge.videoPause).toHaveBeenCalledWith("recording-1"),
    );
    expect(recorder().calls).toEqual(["start", "requestData", "pause"]);
    // The badge says Paused in words (not colour alone), and the status line,
    // a live region, announces it.
    expect(
      screen.getByText("Paused", { selector: ".record-badge span" }),
    ).toBeVisible();
    expect(
      screen.getByText("Paused. Camera and microphone are still on."),
    ).toBeVisible();
    await waitFor(() => expect(status).toHaveTextContent("Recording paused."));
    // The tracks are open but disabled: nothing flows while paused.
    const tracks = streams[0]!.getTracks();
    expect(tracks.every((t) => t.readyState === "live" && !t.enabled)).toBe(
      true,
    );
    // Stop is still there.
    expect(button("Stop and save")).toBeVisible();

    fireEvent.click(button("Resume recording"));
    await waitFor(() =>
      expect(bridge.videoResume).toHaveBeenCalledWith("recording-1"),
    );
    await waitFor(() => expect(status).toHaveTextContent("Recording resumed."));
    expect(recorder().calls).toEqual([
      "start",
      "requestData",
      "pause",
      "resume",
    ]);
    expect(tracks.every((t) => t.enabled)).toBe(true);
    expect(button("Pause recording")).toBeVisible();
    // The piece cut at the pause went to the vault, so it can be kept safe.
    expect(bridge.videoAppend).toHaveBeenCalledTimes(1);
  });

  it("shows the time recorded as text that is not a live region", async () => {
    await recording();
    const clock = screen.getByText(humanText(/^Recorded \d+:\d{2}$/));
    expect(clock).toBeVisible();
    expect(clock).toHaveAttribute("tabindex", "0");
    expect(clock.closest("[aria-live]")).toBeNull();
    expect(clock.closest("[role=status]")).toBeNull();
    expect(screen.getByText(humanText("Recording at 720p"))).toBeVisible();
  });

  it("holds the automatic lock while recording and lets go the moment it is paused", async () => {
    const { holdLock, released } = await recording();
    await waitFor(() => expect(holdLock).toHaveBeenCalledTimes(1));
    expect(released).not.toHaveBeenCalled();
    fireEvent.click(button("Pause recording"));
    await waitFor(() => expect(released).toHaveBeenCalledTimes(1));
    // The pause is done once the status says so; only then can it be undone.
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Recording paused."),
    );
    fireEvent.click(button("Resume recording"));
    await waitFor(() => expect(holdLock).toHaveBeenCalledTimes(2));
  });

  it("never discards on Close: it asks, and only Stop and save ends the recording", async () => {
    const bridge = fakeBridge();
    const { onSaved, onClose } = await recording(bridge);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    const question = await screen.findByText("Stop and save the video?");
    expect(question).toBeVisible();
    await waitFor(() => expect(button("Keep recording")).toHaveFocus());
    fireEvent.click(button("Keep recording"));
    expect(screen.queryByText("Stop and save the video?")).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(bridge.videoStop).not.toHaveBeenCalled();
    expect(recorder().state).toBe("recording");
  });

  it("ends and saves what there is when the window is hidden", async () => {
    const bridge = fakeBridge();
    const { onSaved } = await recording(bridge);
    act(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith("video-1", "hidden"),
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    expect(
      streams.every((s) =>
        s.getTracks().every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
  });

  it("ends the recording when a track ends, keeping what there is", async () => {
    const bridge = fakeBridge();
    const { onSaved } = await recording(bridge);
    act(() => {
      const track = streams[0]!.getVideoTracks()[0]!;
      track.stop();
      track.dispatchEvent(new Event("ended"));
    });
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith("video-1", "stopped"),
    );
  });

  it("stops the recording and keeps what was saved when the vault cannot keep up", async () => {
    let release: () => void = () => undefined;
    const first = new Promise<void>((resolve) => (release = resolve));
    const bridge = fakeBridge({
      videoAppend: vi.fn(async () => {
        await first;
        return {
          storedBytes: 1,
          fragments: 0,
          hasVideo: true,
          hasAudio: true,
          nextSequence: 1,
        };
      }),
    });
    const { onSaved } = await recording(bridge);
    // A piece that never gets through, then more than the page will hold.
    act(() => {
      recorder().emit(piece(100));
      recorder().emit(new Blob([new Uint8Array(MAX_UNSENT_BYTES + 1)]));
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Saving the video"),
    );
    release();
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith("video-1", "slow"),
    );
    expect(recorder().state).toBe("inactive");
  });

  it("stops at once, not at Stop, when the vault refuses a piece, and keeps what was saved", async () => {
    const bridge = fakeBridge({
      videoAppend: vi.fn(async () => {
        throw { code: "no_space", message: "FAKE full" };
      }),
    });
    const { onSaved } = await recording(bridge);
    // The patient does nothing: a piece goes, is refused, and that ends it.
    act(() => recorder().emit(piece(100)));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith("video-1", "failed"),
    );
    expect(recorder().state).toBe("inactive");
    expect(bridge.videoStop).toHaveBeenCalledWith("recording-1");
    expect(bridge.videoAppend).toHaveBeenCalledTimes(1);
    expect(
      streams.every((s) =>
        s.getTracks().every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
  });

  it("turns the camera and microphone off and ends the vault's recording when the recorder cannot start", async () => {
    class Throws extends FakeRecorder {
      constructor(stream: MediaStream, options: MediaRecorderOptions) {
        super(stream, options);
        throw new Error("FAKE no recorder");
      }
    }
    vi.stubGlobal("MediaRecorder", Throws);
    const bridge = fakeBridge();
    open({}, bridge);
    await readyToRecord();
    fireEvent.click(button("Start recording"));
    await screen.findByRole("alert");
    expect(bridge.videoStart).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(bridge.videoStop).toHaveBeenCalledWith("recording-1"),
    );
    expect(
      streams.every((s) =>
        s.getTracks().every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
  });

  it("can be cancelled while starting, and a camera that answers late is turned off", async () => {
    let answer!: (stream: MediaStream) => void;
    getUserMedia.mockImplementationOnce(
      () => new Promise<MediaStream>((resolve) => (answer = resolve)),
    );
    const { onClose } = open();
    fireEvent.click(button("Use the camera and microphone"));
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalled();
    // The camera answers after the dialog has gone: it is stopped at once.
    const late = fakeCameraAndMicrophone();
    await act(async () => answer(late));
    expect(late.getTracks().every((t) => t.readyState === "ended")).toBe(true);
  });

  it("does not announce a pause the vault refused, and says why", async () => {
    const bridge = fakeBridge({
      videoPause: vi.fn(async () => {
        throw { code: "storage", message: "FAKE refused" };
      }),
    });
    await recording(bridge);
    fireEvent.click(button("Pause recording"));
    await waitFor(() => expect(bridge.videoPause).toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "Recording paused.",
    );
  });

  it("does not announce a pause when a piece sent during it was refused", async () => {
    const bridge = fakeBridge({
      videoAppend: vi.fn(async () => {
        throw { code: "storage", message: "FAKE refused" };
      }),
    });
    const { onSaved } = await recording(bridge);
    // The piece cut at the pause is the one the vault refuses.
    fireEvent.click(button("Pause recording"));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith("video-1", "failed"),
    );
    expect(bridge.videoPause).not.toHaveBeenCalled();
    expect(screen.queryByText("Recording paused.")).toBeNull();
  });

  it("ends the vault's recording, and does not report one, when Cancel comes while it is starting", async () => {
    let began!: (value: { recordingId: string }) => void;
    const bridge = fakeBridge({
      videoStart: vi.fn(
        () =>
          new Promise<{ recordingId: string }>((resolve) => (began = resolve)),
      ),
    });
    const { onClose, onSaved } = open({}, bridge);
    await readyToRecord();
    fireEvent.click(button("Start recording"));
    await waitFor(() => expect(bridge.videoStart).toHaveBeenCalledTimes(1));
    fireEvent.click(button("Cancel"));
    expect(onClose).toHaveBeenCalled();
    // The vault answers after the dialog has gone.
    await act(async () => began({ recordingId: "recording-1" }));
    await waitFor(() =>
      expect(bridge.videoStop).toHaveBeenCalledWith("recording-1"),
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(FakeRecorder.all).toHaveLength(0);
    expect(
      streams.every((s) =>
        s.getTracks().every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
  });

  it("waits for a pause that is on its way before it will resume, and does not send it twice", async () => {
    let finish!: () => void;
    const bridge = fakeBridge({
      videoPause: vi.fn(
        () => new Promise<void>((resolve) => (finish = resolve)),
      ),
    });
    await recording(bridge);
    fireEvent.click(button("Pause recording"));
    const toggle = await screen.findByRole("button", {
      name: "Resume recording",
    });
    await waitFor(() => expect(bridge.videoPause).toHaveBeenCalledTimes(1));
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(bridge.videoResume).not.toHaveBeenCalled();
    expect(bridge.videoPause).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-disabled", "false"),
    );
    fireEvent.click(toggle);
    await waitFor(() => expect(bridge.videoResume).toHaveBeenCalledTimes(1));
  });

  it("shows the library's notice beside what it is saying about the recording, not instead of it", async () => {
    await recording(fakeBridge(), { notice: "A leftover notice." });
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Recording");
    expect(status).toHaveTextContent("A leftover notice.");
    fireEvent.click(button("Pause recording"));
    await waitFor(() => expect(status).toHaveTextContent("Recording paused."));
  });

  it("says nothing was saved when the vault has no complete video", async () => {
    const bridge = fakeBridge({
      videoStop: vi.fn(async () => ({ recordId: null })),
    });
    const { onSaved } = await recording(bridge);
    fireEvent.click(button("Stop and save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(null, "asked"));
  });

  it("turns the camera and microphone off when it closes without recording", async () => {
    const { onClose } = open();
    await readyToRecord();
    fireEvent.click(button("Cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(
      streams.every((s) =>
        s.getTracks().every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
    expect(FakeRecorder.all).toHaveLength(0);
  });

  it("turns them off, and ends the recorder, when the dialog goes away mid-recording (a lock)", async () => {
    const { unmount } = await recording();
    const live = recorder();
    unmount();
    expect(live.state).toBe("inactive");
    expect(
      streams.every((s) =>
        s.getTracks().every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
  });

  it("says where to look when the camera or microphone is refused, and offers Try again", async () => {
    getUserMedia.mockRejectedValueOnce(
      new DOMException("FAKE denied", "NotAllowedError"),
    );
    const { bridge } = open({ platform: "windows" });
    fireEvent.click(button("Use the camera and microphone"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/myCarlos can't use the camera/);
    expect(alert).toHaveTextContent(
      "A video needs both the camera and the microphone.",
    );
    expect(bridge.videoStart).not.toHaveBeenCalled();
    fireEvent.click(button("Try again"));
    await screen.findByRole("button", { name: "Start recording" });
  });

  it("does not offer Pause where the recorder cannot pause", async () => {
    class NoPause extends FakeRecorder {}
    // @ts-expect-error a recorder without pause, as an older webview has
    NoPause.prototype.pause = undefined;
    vi.stubGlobal("MediaRecorder", NoPause);
    open();
    await readyToRecord();
    fireEvent.click(button("Start recording"));
    await screen.findByRole("button", { name: "Stop and save" });
    expect(
      screen.queryByRole("button", { name: /Pause recording/ }),
    ).toBeNull();
  });

  it("has no accessibility violations while ready and while recording", async () => {
    open();
    await readyToRecord();
    expect(await axe.run(document.body, AXE)).toHaveProperty("violations", []);
    fireEvent.click(button("Start recording"));
    await screen.findByRole("button", { name: "Pause recording" });
    expect(await axe.run(document.body, AXE)).toHaveProperty("violations", []);
    fireEvent.click(button("Pause recording"));
    await screen.findByRole("button", { name: "Resume recording" });
    expect(await axe.run(document.body, AXE)).toHaveProperty("violations", []);
  });

  it("is in the patient's language, with the time as digits", async () => {
    setLocaleOverride("fr");
    open();
    expect(
      screen.getByRole("button", {
        name: "Utiliser l’appareil photo et le microphone",
      }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Utiliser l’appareil photo et le microphone",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Démarrer l’enregistrement" }),
    );
    await screen.findByRole("button", {
      name: "Mettre l’enregistrement en pause",
    });
    expect(
      screen.getByText(humanText(/^Enregistré : \d+:\d{2}$/)),
    ).toBeVisible();
    setLocaleOverride("en");
  });
});
