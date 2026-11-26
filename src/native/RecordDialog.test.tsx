import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride } from "../i18n";
import { humanText, visibleText } from "../test/humanText";
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
    // As the real one: the event follows the pause.
    this.dispatchEvent(new Event("pause"));
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
        space: "ok" as const,
        freeBytes: null,
      }),
    ),
    videoSpace: vi.fn(async () => ({
      freeBytes: 50 * 1024 ** 3,
      level: "ok" as const,
      canRecord: true,
    })),
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

  it("ends and saves the video once when Stop and save is pressed twice (a double click, or a second click while it stops)", async () => {
    let finish!: (saved: { recordId: string | null }) => void;
    const bridge = fakeBridge({
      videoStop: vi.fn(
        () =>
          new Promise<{ recordId: string | null }>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const { onSaved } = await recording(bridge);
    const stop = button("Stop and save");
    // The second click is the one that must not end the video again.
    fireEvent.click(stop);
    fireEvent.click(stop);
    await waitFor(() => expect(bridge.videoStop).toHaveBeenCalled());
    fireEvent.click(stop);
    await act(async () => finish({ recordId: "video-1" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(bridge.videoStop).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
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
    // The camera and microphone are open, and the picture stays on (the person can still see
    // themselves); the sound is silenced, and nothing is recorded: the recorder is paused.
    const tracks = streams[0]!.getTracks();
    expect(tracks.every((t) => t.readyState === "live")).toBe(true);
    expect(streams[0]!.getVideoTracks().every((t) => t.enabled)).toBe(true);
    expect(streams[0]!.getAudioTracks().every((t) => !t.enabled)).toBe(true);
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

  it("keeps the live camera preview on while paused, and goes back to the same picture on resume", async () => {
    const bridge = fakeBridge();
    await recording(bridge);
    const preview = () =>
      document.querySelector<HTMLVideoElement>("video.camera-view")!;
    expect(preview().srcObject).toBe(streams[0]);
    fireEvent.click(button("Pause recording"));
    await waitFor(() =>
      expect(bridge.videoPause).toHaveBeenCalledWith("recording-1"),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Recording paused."),
    );
    // The preview is the same stream, shown, and its picture is not switched off (a disabled
    // video track shows black).
    expect(preview().srcObject).toBe(streams[0]);
    expect(preview()).toBeVisible();
    for (const track of streams[0]!.getVideoTracks()) {
      expect(track.readyState).toBe("live");
      expect(track.enabled).toBe(true);
    }
    // Nothing was taken away from the recorder's stream either: the same tracks go on.
    expect(recorder().stream).toBe(streams[0]);
    fireEvent.click(button("Resume recording"));
    await waitFor(() =>
      expect(bridge.videoResume).toHaveBeenCalledWith("recording-1"),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Recording resumed.",
      ),
    );
    expect(preview().srcObject).toBe(streams[0]);
    expect(streams[0]!.getAudioTracks().every((t) => t.enabled)).toBe(true);
  });

  it("appends nothing while paused, takes only the piece cut at the pause, and goes on after resume", async () => {
    const bridge = fakeBridge();
    await recording(bridge);
    // A piece while recording is sent.
    recorder().emit(new Blob([new Uint8Array(5).fill(1)]));
    await waitFor(() => expect(bridge.videoAppend).toHaveBeenCalledTimes(1));
    fireEvent.click(button("Pause recording"));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Recording paused."),
    );
    // The piece cut at the pause went too (the recorder's requestData).
    expect(bridge.videoAppend).toHaveBeenCalledTimes(2);
    // A recorder that sends frames or sound anyway while paused is not heard.
    recorder().emit(new Blob([new Uint8Array(7).fill(2)]));
    recorder().emit(new Blob([new Uint8Array(7).fill(3)]));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(bridge.videoAppend).toHaveBeenCalledTimes(2);
    fireEvent.click(button("Resume recording"));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Recording resumed.",
      ),
    );
    // After the resume pieces are taken again, in the same recording and the next sequence.
    recorder().emit(new Blob([new Uint8Array(9).fill(4)]));
    await waitFor(() => expect(bridge.videoAppend).toHaveBeenCalledTimes(3));
    const sequences = vi
      .mocked(bridge.videoAppend)
      .mock.calls.map((call) => call[1]);
    expect(sequences).toEqual([0, 1, 2]);
    expect(
      vi
        .mocked(bridge.videoAppend)
        .mock.calls.every((call) => call[0] === "recording-1"),
    ).toBe(true);
  });

  it("keeps both a regular piece already queued and the piece cut at the pause, when both arrive after Pause", async () => {
    const bridge = fakeBridge();
    await recording(bridge);
    // A recorder that delivers late, as a real one does: requestData's piece comes after pause(),
    // behind a regular timeslice piece that was already on its way, and the recorder's "pause"
    // event follows them both.
    const late: Blob[] = [];
    const fake = recorder();
    fake.requestData = () => {
      fake.calls.push("requestData");
      late.push(new Blob([new Uint8Array(10).fill(9)]));
    };
    fake.pause = () => {
      fake.state = "paused";
      fake.calls.push("pause");
    };
    fireEvent.click(button("Pause recording"));
    await waitFor(() =>
      expect(bridge.videoPause).toHaveBeenCalledWith("recording-1"),
    );
    expect(fake.state).toBe("paused");
    // Both arrive now, already paused: the regular piece first, then the one cut at the pause.
    fake.emit(new Blob([new Uint8Array(5).fill(1)]));
    for (const blob of late) fake.emit(blob);
    await waitFor(() => expect(bridge.videoAppend).toHaveBeenCalledTimes(2));
    expect(
      vi.mocked(bridge.videoAppend).mock.calls.map((call) => call[1]),
    ).toEqual([0, 1]);
    // Once the recorder has said it is paused, a further piece is not kept.
    fake.dispatchEvent(new Event("pause"));
    fake.emit(new Blob([new Uint8Array(6).fill(2)]));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(bridge.videoAppend).toHaveBeenCalledTimes(2);
  });

  it("still saves the last piece when the recording is stopped while paused", async () => {
    const bridge = fakeBridge();
    await recording(bridge);
    fireEvent.click(button("Pause recording"));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Recording paused."),
    );
    const before = vi.mocked(bridge.videoAppend).mock.calls.length;
    fireEvent.click(button("Stop and save"));
    await waitFor(() => expect(bridge.videoStop).toHaveBeenCalled());
    // The recorder's last piece, at the stop, is kept.
    expect(vi.mocked(bridge.videoAppend).mock.calls.length).toBe(before + 1);
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
          space: "ok" as const,
          freeBytes: null,
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
        throw { code: "storage", message: "FAKE refused" };
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

  it("turns neither the camera nor the microphone on when there is not enough room, and says so", async () => {
    let room = 600 * 1024 ** 2;
    const bridge = fakeBridge({
      videoSpace: vi.fn(async () => ({
        freeBytes: room,
        level: "low" as const,
        canRecord: room >= 1024 ** 3,
      })),
    });
    const { onSaved } = open({}, bridge);
    fireEvent.click(button("Use the camera and microphone"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "There is not enough room to record a video. About 1 GB must be free.",
    );
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(bridge.videoStart).not.toHaveBeenCalled();
    expect(streams).toHaveLength(0);
    // Make room, and Try again goes on to the camera.
    room = 5 * 1024 ** 3;
    fireEvent.click(button("Try again"));
    await screen.findByRole("button", { name: "Start recording" });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("warns when room runs low while recording, and keeps recording", async () => {
    const bridge = fakeBridge({
      videoAppend: vi.fn(async () => ({
        storedBytes: 1,
        fragments: 1,
        hasVideo: true,
        hasAudio: true,
        nextSequence: 1,
        space: "low" as const,
        freeBytes: 400 * 1024 ** 2,
      })),
    });
    const { onSaved } = await recording(bridge);
    act(() => recorder().emit(piece(100)));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Running low on room.",
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(recorder().state).toBe("recording");
  });

  it("ends and saves the recording when the vault says the reserve is reached", async () => {
    const bridge = fakeBridge({
      videoAppend: vi.fn(async () => ({
        storedBytes: 1,
        fragments: 1,
        hasVideo: true,
        hasAudio: true,
        nextSequence: 1,
        space: "stop" as const,
        freeBytes: 100 * 1024 ** 2,
      })),
    });
    const { onSaved } = await recording(bridge);
    act(() => recorder().emit(piece(100)));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith("video-1", "space"),
    );
    expect(recorder().state).toBe("inactive");
    expect(
      streams.every((s) =>
        s.getTracks().every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
  });

  it("ends the recording when a piece is refused for want of room, and saves it when the vault can", async () => {
    const bridge = fakeBridge({
      videoAppend: vi.fn(async () => {
        throw { code: "no_space", message: "FAKE full" };
      }),
    });
    const { onSaved } = await recording(bridge);
    act(() => recorder().emit(piece(100)));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith("video-1", "space"),
    );
  });

  it("says nothing was kept when a piece was refused and the vault then had no complete video", async () => {
    // Stop itself did not fail: it answered that there is no video. That is not
    // "kept unfinished".
    const bridge = fakeBridge({
      videoAppend: vi.fn(async () => {
        throw { code: "no_space", message: "FAKE full" };
      }),
      videoStop: vi.fn(async () => ({ recordId: null })),
    });
    const { onSaved } = await recording(bridge);
    act(() => recorder().emit(piece(100)));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(null, "space"));
    expect(onSaved).not.toHaveBeenCalledWith(null, "unfinished");
  });

  it("says the video is kept unfinished, not saved, when the vault could not finish it for want of room", async () => {
    // A write the disk refused, or a recording cut off mid-fragment: ending it
    // needs room to finish it, which is not there. The vault refuses Stop with
    // no_space and keeps the recording; the page must not claim it was saved.
    const bridge = fakeBridge({
      videoAppend: vi.fn(async () => {
        throw { code: "no_space", message: "FAKE full" };
      }),
      videoStop: vi.fn(async () => {
        throw { code: "no_space", message: "FAKE full" };
      }),
    });
    const { onSaved } = await recording(bridge);
    act(() => recorder().emit(piece(100)));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(null, "unfinished"),
    );
    expect(onSaved).not.toHaveBeenCalledWith("video-1", expect.anything());
    expect(
      streams.every((s) =>
        s.getTracks().every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
  });

  it("looks at the room again on resume, and saves instead of recording into a full disk", async () => {
    let canRecord = true;
    const bridge = fakeBridge({
      videoSpace: vi.fn(async () => ({
        freeBytes: canRecord ? 5 * 1024 ** 3 : 100 * 1024 ** 2,
        level: canRecord ? ("ok" as const) : ("stop" as const),
        canRecord,
      })),
    });
    const { onSaved } = await recording(bridge);
    fireEvent.click(button("Pause recording"));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Recording paused."),
    );
    canRecord = false;
    fireEvent.click(button("Resume recording"));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith("video-1", "space"),
    );
    expect(bridge.videoResume).not.toHaveBeenCalled();
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

  // Gap tests (24 Nov): paths of the dialog that had no test. None touches the pause and the
  // camera preview, which are #439's.

  it("ends and saves the recording from the question Close asks, and a press inside the dialog does not close it", async () => {
    const bridge = fakeBridge();
    const { onSaved, onClose } = await recording(bridge);
    // A press on the dialog itself is not a press on the backdrop.
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("Stop and save the video?")).toBeNull();
    // A press on the backdrop asks, and never discards.
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    await screen.findByText("Stop and save the video?");
    expect(bridge.videoStop).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Stop and save",
      }),
    );
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith("video-1", "asked"),
    );
    expect(bridge.videoStop).toHaveBeenCalledWith("recording-1");
  });

  it("says so when the webview has no camera interface at all, and offers Try again", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {},
    });
    try {
      const { bridge } = open();
      fireEvent.click(button("Use the camera and microphone"));
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(button("Try again")).toBeEnabled();
      expect(bridge.videoStart).not.toHaveBeenCalled();
    } finally {
      // Back to the browser's own.
      Reflect.deleteProperty(navigator, "mediaDevices");
    }
  });

  it("asks for nothing when Cancel comes while the room is being looked at, or after the camera refuses", async () => {
    let looked!: (space: {
      freeBytes: number;
      level: "ok";
      canRecord: boolean;
    }) => void;
    const bridge = fakeBridge({
      videoSpace: vi.fn(
        () =>
          new Promise<{ freeBytes: number; level: "ok"; canRecord: boolean }>(
            (resolve) => (looked = resolve),
          ),
      ),
    });
    const { onClose } = open({}, bridge);
    fireEvent.click(button("Use the camera and microphone"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () =>
      looked({ freeBytes: 50 * 1024 ** 3, level: "ok", canRecord: true }),
    );
    // The camera and the microphone were never asked for.
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();

    // A refusal that comes after Cancel is not shown either.
    let refuse!: (error: unknown) => void;
    getUserMedia.mockImplementationOnce(
      () => new Promise<MediaStream>((_resolve, reject) => (refuse = reject)),
    );
    cleanup();
    const second = open();
    fireEvent.click(button("Use the camera and microphone"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await act(async () =>
      refuse(new DOMException("FAKE denied", "NotAllowedError")),
    );
    expect(second.onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the camera stopped when it ends, or the window is hidden, before recording; a visible window and an old camera's end change nothing", async () => {
    open();
    await readyToRecord();
    const first = streams[0]!;
    // The window being shown again, or any change that leaves it visible: nothing.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => {
      const track = first.getVideoTracks()[0]!;
      track.stop();
      track.dispatchEvent(new Event("ended"));
    });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start recording" }),
    ).toBeNull();
    // Try again opens a new camera; the first one ending again is not the new one's end.
    fireEvent.click(button("Try again"));
    await screen.findByRole("button", { name: "Start recording" });
    act(() => {
      first.getVideoTracks()[0]!.dispatchEvent(new Event("ended"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button("Start recording")).toBeEnabled();
    // Hidden while only the camera is on: it is turned off and the dialog says so.
    const hidden = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(
        streams[1]!.getTracks().every((t) => t.readyState === "ended"),
      ).toBe(true);
    } finally {
      hidden.mockRestore();
    }
  });

  it("keeps Standard when the webview refuses High, and goes back to Standard when asked", async () => {
    getUserMedia.mockImplementation(async () => {
      const stream = fakeCameraAndMicrophone({ width: 1920, height: 1080 });
      Object.assign(stream.getVideoTracks()[0]!, {
        applyConstraints: vi.fn(async () => {
          throw new Error("FAKE refused");
        }),
      });
      return stream;
    });
    open();
    await readyToRecord();
    fireEvent.click(screen.getByRole("radio", { name: /High \(1080p\)/ }));
    expect(screen.getByRole("radio", { name: /High/ })).toBeChecked();
    expect(window.localStorage.getItem("mycarlos.videoQuality.v1")).toBe(
      "high",
    );
    fireEvent.click(screen.getByRole("radio", { name: /Standard \(720p\)/ }));
    expect(screen.getByRole("radio", { name: /Standard/ })).toBeChecked();
    expect(window.localStorage.getItem("mycarlos.videoQuality.v1")).toBe(
      "standard",
    );
    // Both asks reached the camera, and neither left an unhandled refusal.
    const track = streams[0]!.getVideoTracks()[0]!;
    expect(track.applyConstraints).toHaveBeenCalledTimes(2);
    await act(async () => undefined);
  });

  it("sends nothing for an empty piece, and goes on with the next sequence number", async () => {
    const bridge = fakeBridge();
    await recording(bridge);
    act(() => {
      recorder().emit(new Blob([]));
    });
    // An empty piece is dropped where it arrives: nothing is queued, so nothing is waited for.
    await act(async () => undefined);
    expect(bridge.videoAppend).not.toHaveBeenCalled();
    act(() => {
      recorder().emit(piece(40));
    });
    await waitFor(() => expect(bridge.videoAppend).toHaveBeenCalledTimes(1));
    expect(vi.mocked(bridge.videoAppend).mock.calls[0]![1]).toBe(0);
  });

  it("still saves when the recorder will not stop, and ends the recording when it reports an error", async () => {
    const bridge = fakeBridge();
    const { onSaved } = await recording(bridge);
    recorder().stop = () => {
      throw new Error("FAKE already stopped");
    };
    fireEvent.click(button("Stop and save"));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith("video-1", "asked"),
    );
    cleanup();

    const second = await recording(fakeBridge());
    act(() => {
      recorder().dispatchEvent(new Event("error"));
    });
    await waitFor(() =>
      expect(second.onSaved).toHaveBeenCalledWith("video-1", "stopped"),
    );
  });

  it("shows why the vault could not finish the video, and reports nothing saved", async () => {
    const bridge = fakeBridge({
      videoStop: vi.fn(async () => {
        throw Object.assign(new Error("FAKE stop refused"), {
          code: "FAKE_stop",
        });
      }),
    });
    const { onSaved, onClose } = await recording(bridge);
    fireEvent.click(button("Stop and save"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      streams.every((s) =>
        s.getTracks().every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
  });

  it.each([
    ["finishes", "resolve"],
    ["is refused", "reject"],
  ] as const)(
    "reports nothing, and shows nothing, when the vault's stop %s after the dialog has gone",
    async (_name, how) => {
      let answer!: () => void;
      let fail!: (error: unknown) => void;
      const bridge = fakeBridge({
        videoStop: vi.fn(
          () =>
            new Promise<{ recordId: string | null }>((resolve, reject) => {
              answer = () => resolve({ recordId: "video-1" });
              fail = reject;
            }),
        ),
      });
      const { onSaved, unmount } = await recording(bridge);
      fireEvent.click(button("Stop and save"));
      await waitFor(() => expect(bridge.videoStop).toHaveBeenCalledTimes(1));
      unmount();
      await act(async () =>
        how === "resolve" ? answer() : fail(new Error("FAKE late")),
      );
      expect(onSaved).not.toHaveBeenCalled();
    },
  );

  it("does not close while the recording is being saved", async () => {
    let answer!: () => void;
    const bridge = fakeBridge({
      videoStop: vi.fn(
        () =>
          new Promise<{ recordId: string | null }>((resolve) => {
            answer = () => resolve({ recordId: "video-1" });
          }),
      ),
    });
    const { onClose, onSaved } = await recording(bridge);
    fireEvent.click(button("Stop and save"));
    await waitFor(() => expect(bridge.videoStop).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("Stop and save the video?")).toBeNull();
    await act(async () => answer());
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith("video-1", "asked"),
    );
  });

  it("says this device cannot record MP4, and starts nothing, when no MP4 type is supported", async () => {
    vi.stubGlobal(
      "MediaRecorder",
      class extends FakeRecorder {
        static override isTypeSupported = () => false;
      },
    );
    const bridge = fakeBridge();
    open({}, bridge);
    await readyToRecord();
    fireEvent.click(button("Start recording"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This device can't record video in a form myCarlos can save.",
    );
    expect(bridge.videoStart).not.toHaveBeenCalled();
    expect(FakeRecorder.all).toHaveLength(0);
  });

  it("is not stopped by a vault that also fails to end its recording, when the dialog was cancelled while starting or the recorder could not start", async () => {
    // Cancelled while the vault was starting; its stop then fails too.
    let began!: (value: { recordingId: string }) => void;
    const stopFails = vi.fn(async () => {
      throw new Error("FAKE stop failed");
    });
    const first = fakeBridge({
      videoStart: vi.fn(
        () =>
          new Promise<{ recordingId: string }>((resolve) => (began = resolve)),
      ),
      videoStop: stopFails,
    });
    open({}, first);
    await readyToRecord();
    fireEvent.click(button("Start recording"));
    await waitFor(() => expect(first.videoStart).toHaveBeenCalledTimes(1));
    fireEvent.click(button("Cancel"));
    await act(async () => began({ recordingId: "recording-1" }));
    await waitFor(() => expect(stopFails).toHaveBeenCalledTimes(1));
    cleanup();

    // The recorder could not start; the vault's stop fails too.
    class Throws extends FakeRecorder {
      constructor(stream: MediaStream, options: MediaRecorderOptions) {
        super(stream, options);
        throw new Error("FAKE no recorder");
      }
    }
    vi.stubGlobal("MediaRecorder", Throws);
    const secondStop = vi.fn(async () => {
      throw new Error("FAKE stop failed");
    });
    open({}, fakeBridge({ videoStop: secondStop }));
    await readyToRecord();
    fireEvent.click(button("Start recording"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await waitFor(() => expect(secondStop).toHaveBeenCalledTimes(1));
  });

  it("goes on with the resume when the room cannot be looked at, and keeps the pause when the vault refuses it", async () => {
    let lookable = true;
    const bridge = fakeBridge();
    const space = bridge.videoSpace;
    bridge.videoSpace = vi.fn(async () => {
      if (!lookable) throw new Error("FAKE cannot look");
      return space();
    });
    await recording(bridge);
    fireEvent.click(button("Pause recording"));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Recording paused."),
    );
    // Room could not be read: the resume goes on, as before.
    lookable = false;
    vi.mocked(bridge.videoResume).mockRejectedValueOnce(
      Object.assign(new Error("FAKE resume refused"), { code: "FAKE_resume" }),
    );
    fireEvent.click(button("Resume recording"));
    // The vault refused: the pause stays, it says why, and Resume can be tried again.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(bridge.videoResume).toHaveBeenCalledTimes(1);
    expect(recorder().state).toBe("paused");
    await waitFor(() => expect(button("Resume recording")).toBeEnabled());
    fireEvent.click(button("Resume recording"));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Recording resumed.",
      ),
    );
    expect(bridge.videoResume).toHaveBeenCalledTimes(2);
  });

  it("keeps the time recorded moving while recording, one tick at a time", async () => {
    // The clock reads performance.now, and the screen re-reads it on a timer of the dialog's own:
    // both are driven here, so nothing waits in real time.
    let now = 1_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const ticks: { run: () => void; delay: number }[] = [];
    const realInterval = window.setInterval.bind(window);
    const timer = vi.spyOn(window, "setInterval").mockImplementation(((
      run: () => void,
      delay?: number,
      ...rest: unknown[]
    ) => {
      ticks.push({ run, delay: delay ?? 0 });
      return realInterval(run, delay, ...rest);
    }) as typeof window.setInterval);
    try {
      await recording();
      // The timer is started by an effect, which runs after the screen shows Pause.
      await act(async () => undefined);
      const shown = () =>
        visibleText(
          screen.getByText(humanText(/^Recorded \d+:\d{2}$/)).textContent ?? "",
        );
      expect(shown()).toBe("Recorded 0:00");
      const tick = ticks.filter((entry) => entry.delay === 500).at(-1)!;
      expect(ticks.map((entry) => entry.delay)).toContain(500);
      now += 61_000;
      act(() => tick.run());
      expect(shown()).toBe("Recorded 1:01");
      now += 60_000;
      act(() => tick.run());
      expect(shown()).toBe("Recorded 2:01");
    } finally {
      clock.mockRestore();
      timer.mockRestore();
    }
  });
});
