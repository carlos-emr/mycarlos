import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import axe from "axe-core";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride } from "../i18n";
import { humanText } from "../test/humanText";
import { RecordDialog, type RecordBridge } from "./RecordDialog";
import "../styles.css";

// The layout of the Record video dialog (the RestRecord design): the picture and Start in one
// column, the settings in a column of their own, beside it on a wide window and below it on a
// narrow one. These tests read the real stylesheet and the real geometry in the browser. Synthetic
// devices only: a painted canvas and a quiet tone, nothing real is recorded.

const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
};

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

const streams: MediaStream[] = [];
const timers: number[] = [];
const contexts: AudioContext[] = [];
function fakeStream() {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const drawing = canvas.getContext("2d")!;
  const paint = () => {
    drawing.fillStyle = "#1d6fb8";
    drawing.fillRect(0, 0, 640, 360);
  };
  paint();
  timers.push(window.setInterval(paint, 40));
  const stream = canvas.captureStream(15);
  const audio = new AudioContext();
  contexts.push(audio);
  const tone = audio.createOscillator();
  const destination = audio.createMediaStreamDestination();
  tone.connect(destination);
  tone.start();
  for (const track of destination.stream.getAudioTracks())
    stream.addTrack(track);
  streams.push(stream);
  return stream;
}

type Device = { deviceId: string; label: string; kind: MediaDeviceKind };
let connected: Device[];
let getUserMedia: ReturnType<typeof vi.spyOn>;
let enumerate: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setLocaleOverride("en");
  window.localStorage.removeItem("mycarlos.videoDevices.v1");
  connected = [
    { deviceId: "cam-a", label: "FAKE Laptop camera", kind: "videoinput" },
    { deviceId: "cam-b", label: "FAKE USB webcam", kind: "videoinput" },
    {
      deviceId: "mic-a",
      label: "FAKE Built-in microphone",
      kind: "audioinput",
    },
    { deviceId: "mic-b", label: "FAKE Headset microphone", kind: "audioinput" },
  ];
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  enumerate = vi
    .spyOn(navigator.mediaDevices, "enumerateDevices")
    .mockImplementation(async () => connected as MediaDeviceInfo[]);
  getUserMedia = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockImplementation(async () => fakeStream());
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  getUserMedia.mockRestore();
  enumerate.mockRestore();
  for (const timer of timers.splice(0)) window.clearInterval(timer);
  for (const stream of streams.splice(0))
    for (const track of stream.getTracks()) track.stop();
  for (const context of contexts.splice(0)) void context.close();
  document.documentElement.style.fontSize = "";
  window.localStorage.removeItem("mycarlos.videoDevices.v1");
  await page.viewport(1100, 760);
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

function open(profileName?: string) {
  return render(
    <RecordDialog
      platform="windows"
      bridge={fakeBridge()}
      profileId="profile-1"
      profileName={profileName}
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
const dialog = () => screen.getByRole("dialog");
const settings = () =>
  screen.getByRole("complementary", { name: "Recording settings" });
const preview = () => dialog().querySelector<HTMLElement>(".record-preview")!;
const main = () => dialog().querySelector<HTMLElement>(".record-main")!;
const box = (element: Element) => element.getBoundingClientRect();
const centre = (element: Element) => box(element).left + box(element).width / 2;

describe("the Record video dialog's layout", () => {
  it("shows a title with the person's name and Close on the right, and no Cancel", async () => {
    open("FAKE Sam Example");
    expect(
      screen.getByRole("heading", {
        name: humanText("Record a video for FAKE Sam Example"),
      }),
    ).toBeVisible();
    const close = screen.getByRole("button", { name: "Close" });
    const title = screen.getByRole("heading");
    expect(box(close).left).toBeGreaterThan(box(title).left);
    expect(
      Math.abs(
        box(close).top +
          box(close).height / 2 -
          (box(title).top + box(title).height / 2),
      ),
    ).toBeLessThan(box(close).height);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    // Without a name the title stays as it was.
    cleanup();
    open();
    expect(
      screen.getByRole("heading", { name: "Record a video" }),
    ).toBeVisible();
  });

  it("has no settings column before the devices are allowed, and the one button is in the column", async () => {
    await page.viewport(1280, 800);
    open("FAKE Sam Example");
    expect(
      screen.queryByRole("complementary", { name: "Recording settings" }),
    ).toBeNull();
    expect(dialog().querySelector(".record-layout")).not.toHaveClass(
      "has-settings",
    );
    expect(
      screen.getByRole("button", { name: /Use the camera and microphone/ }),
    ).toBeVisible();
  });

  it("puts the settings in a 320px column to the right of the picture on a wide window, with the picture and Start centred in their own column", async () => {
    await page.viewport(1280, 800);
    open("FAKE Sam Example");
    await ready();
    expect(dialog().querySelector(".record-layout")).toHaveClass(
      "has-settings",
    );
    const aside = settings();
    // Two columns: the settings to the right of the picture, not below it.
    expect(box(aside).left).toBeGreaterThanOrEqual(box(preview()).right - 1);
    expect(box(aside).width).toBeCloseTo(320, 0);
    expect(box(aside).right).toBeLessThanOrEqual(box(dialog()).right + 1);
    expect(box(aside).top).toBeLessThanOrEqual(box(preview()).top + 1);
    // The picture fills its column, and Start is centred under it, in that column, not in the
    // dialog.
    const start = screen.getByRole("button", { name: "Start recording" });
    expect(Math.abs(centre(start) - centre(main()))).toBeLessThan(2);
    expect(Math.abs(centre(preview()) - centre(main()))).toBeLessThan(2);
    expect(centre(start)).toBeLessThan(box(aside).left);
    expect(box(start).top).toBeGreaterThanOrEqual(box(preview()).bottom - 1);
    expect(
      screen.getAllByRole("button", { name: "Start recording" }),
    ).toHaveLength(1);
    // What the aside holds: both lists, the microphone test, the quality and the note.
    expect(aside.querySelector("#record-device-camera")).not.toBeNull();
    expect(aside.querySelector("#record-device-microphone")).not.toBeNull();
    expect(aside.querySelector("button[aria-pressed]")).toHaveTextContent(
      "Test microphone",
    );
    expect(aside.querySelector(".record-quality")).not.toBeNull();
    expect(aside).toHaveTextContent(
      "The video is saved encrypted. myCarlos remembers these choices on this device.",
    );
    // The dialog does not scroll sideways.
    expect(dialog().scrollWidth).toBeLessThanOrEqual(dialog().clientWidth);
  });

  for (const [width, size] of [
    [820, "16px"],
    [640, "16px"],
    [640, "32px"],
    [360, "16px"],
    [320, "32px"],
  ] as const)
    it(`stacks the settings below the picture at ${width}px with ${size} text, with the picture and Start centred and nothing cut off`, async () => {
      await page.viewport(width, 3000);
      document.documentElement.style.fontSize = size;
      open("FAKE Sam Example");
      await ready();
      const aside = settings();
      // One column: the settings start below the end of the picture's column.
      expect(box(aside).top).toBeGreaterThanOrEqual(box(main()).bottom - 1);
      expect(Math.abs(centre(aside) - centre(main()))).toBeLessThan(2);
      const start = screen.getByRole("button", { name: "Start recording" });
      expect(Math.abs(centre(start) - centre(main()))).toBeLessThan(2);
      expect(Math.abs(centre(preview()) - centre(main()))).toBeLessThan(2);
      // Nothing runs out of the dialog's sides.
      expect(dialog().scrollWidth).toBeLessThanOrEqual(dialog().clientWidth);
      for (const element of [
        start,
        aside.querySelector<HTMLElement>("#record-device-camera")!,
        aside.querySelector<HTMLElement>("#record-device-microphone")!,
        screen.getByRole("button", { name: "Close" }),
      ]) {
        expect(box(element).left).toBeGreaterThanOrEqual(
          box(dialog()).left - 1,
        );
        expect(box(element).right).toBeLessThanOrEqual(box(dialog()).right + 1);
      }
    });

  it("reads and tabs in one order that follows the picture: Close, Start, the lists, the microphone test, the quality", async () => {
    await page.viewport(1280, 800);
    open("FAKE Sam Example");
    await ready();
    const order = [
      ...dialog().querySelectorAll<HTMLElement>(
        "button, select, input, [tabindex='0']",
      ),
    ].map(
      (element) =>
        element.getAttribute("aria-label") ??
        (element.id ? `#${element.id}` : (element.textContent ?? "").trim()),
    );
    expect(order.slice(0, 5)).toEqual([
      "Close",
      "Start recording",
      "#record-device-camera",
      "#record-device-microphone",
      "Test microphone",
    ]);
    // The two quality choices come last, after everything above.
    const radios = [...dialog().querySelectorAll("input[type='radio']")];
    expect(radios.length).toBeGreaterThan(0);
    const lastButton = screen.getByRole("button", { name: "Test microphone" });
    for (const radio of radios)
      expect(
        lastButton.compareDocumentPosition(radio) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    // The same order on a narrow window: it is the markup's, not the stylesheet's.
    await page.viewport(360, 3000);
    expect(
      screen
        .getByRole("button", { name: "Start recording" })
        .compareDocumentPosition(settings()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("puts the elapsed time on the picture, top left, while recording, and the controls under it", async () => {
    await page.viewport(1280, 800);
    open("FAKE Sam Example");
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await screen.findByRole("button", { name: "Pause recording" });
    const clock = screen.getByText(/^Recorded /);
    expect(preview().contains(clock)).toBe(true);
    expect(box(clock).left - box(preview()).left).toBeLessThan(40);
    expect(box(clock).top - box(preview()).top).toBeLessThan(40);
    // Pause and Stop are one row under the picture, centred in its column; the lists wait.
    const pause = screen.getByRole("button", { name: "Pause recording" });
    const stop = screen.getByRole("button", { name: "Stop and save" });
    expect(box(pause).top).toBeGreaterThanOrEqual(box(preview()).bottom - 1);
    expect(Math.abs(box(pause).top - box(stop).top)).toBeLessThan(4);
    const middle = (box(pause).left + box(stop).right) / 2;
    expect(Math.abs(middle - centre(main()))).toBeLessThan(2);
    expect(
      settings().querySelector<HTMLSelectElement>("#record-device-camera"),
    ).toBeDisabled();
  });

  it("has no accessibility violations on a wide window, a narrow one and at 200% text", async () => {
    for (const [width, size] of [
      [1280, "16px"],
      [360, "16px"],
      [640, "32px"],
    ] as const) {
      await page.viewport(width, 3000);
      document.documentElement.style.fontSize = size;
      open("FAKE Sam Example");
      await ready();
      expect(await axe.run(document.body, AXE)).toHaveProperty(
        "violations",
        [],
      );
      cleanup();
    }
  });

  it("keeps the picture's column and the settings on the same line at the width where the columns begin", async () => {
    // 52em is the breakpoint: just below it the settings stack, at it they sit beside the picture.
    await page.viewport(831, 900);
    open("FAKE Sam Example");
    await ready();
    expect(box(settings()).top).toBeGreaterThanOrEqual(box(main()).bottom - 1);
    cleanup();
    await page.viewport(832, 900);
    open("FAKE Sam Example");
    await ready();
    await waitFor(() =>
      expect(box(settings()).left).toBeGreaterThanOrEqual(
        box(preview()).right - 1,
      ),
    );
  });
});
