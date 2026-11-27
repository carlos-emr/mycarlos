import {
  act,
  cleanup,
  configure,
  fireEvent,
  getConfig,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import axe from "axe-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { page } from "vitest/browser";
import { setLocaleOverride, translate } from "../i18n";
import { CameraDialog } from "./CameraDialog";
import { readDeviceChoice } from "./mediaDevices";

// Choosing the camera for a photo (the same chooser as the video recording dialog, #359). The
// cameras are FAKE: a painted canvas streamed as video, each track saying which device it came from.
const KEY = "mycarlos.videoDevices.v1";
const EXPLAINED_KEY = "mycarlos.cameraExplained.v1";
const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
};

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
const LAPTOP = camera("cam-a", "FAKE Laptop camera");
const WEBCAM = camera("cam-b", "FAKE USB webcam");
const MICROPHONE: FakeDevice = {
  deviceId: "mic-a",
  label: "FAKE Built-in microphone",
  kind: "audioinput",
};

const streams: MediaStream[] = [];
const painters: number[] = [];
function fakeStream(cameraId: string): MediaStream {
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
  Object.assign(stream.getVideoTracks()[0]!, {
    getSettings: () => ({ width: 320, height: 240, deviceId: cameraId }),
  });
  streams.push(stream);
  return stream;
}
const ended = (stream: MediaStream) =>
  stream.getTracks().every((track) => track.readyState === "ended");

const WAIT_MS = 10_000;
let defaultWaitMs = 1000;
beforeAll(() => {
  defaultWaitMs = getConfig().asyncUtilTimeout;
  configure({ asyncUtilTimeout: WAIT_MS });
});
afterAll(() => configure({ asyncUtilTimeout: defaultWaitMs }));

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
  window.localStorage.removeItem(EXPLAINED_KEY);
  connected = [LAPTOP, WEBCAM, MICROPHONE];
  enumerate = vi
    .spyOn(navigator.mediaDevices, "enumerateDevices")
    .mockImplementation(async () => connected as MediaDeviceInfo[]);
  // The first camera is the system's default; an exact id that is not connected is gone.
  getUserMedia = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockImplementation(async (constraints?: MediaStreamConstraints) => {
      const wanted = exact(constraints?.video);
      if (wanted && !connected.some((device) => device.deviceId === wanted))
        throw Object.assign(new Error("FAKE camera is gone"), {
          name: "OverconstrainedError",
        });
      return fakeStream(
        wanted ?? connected.find((d) => d.kind === "videoinput")!.deviceId,
      );
    });
});
afterEach(() => {
  cleanup();
  getUserMedia.mockRestore();
  enumerate.mockRestore();
  for (const timer of painters.splice(0)) window.clearInterval(timer);
  for (const stream of streams.splice(0))
    for (const track of stream.getTracks()) track.stop();
  window.localStorage.removeItem(KEY);
  window.localStorage.removeItem(EXPLAINED_KEY);
  document.documentElement.style.fontSize = "";
});

function open() {
  const onUse = vi.fn(async () => undefined);
  const onClose = vi.fn();
  const view = render(
    <CameraDialog
      platform="windows"
      notice=""
      saving={false}
      onUse={onUse}
      onClose={onClose}
    />,
  );
  return { ...view, onUse, onClose };
}
const button = (name: string) => screen.getByRole("button", { name });
const shutter = () => button("Take photo");
const cameraList = () =>
  screen.queryByRole("combobox", {
    name: "Camera",
  }) as HTMLSelectElement | null;
async function startCamera() {
  fireEvent.click(button("Use the camera"));
  await waitFor(() => expect(shutter()).toBeEnabled());
}
const FELL_BACK =
  "The camera you used last is not connected, so the system's default camera is in use.";

describe("CameraDialog: choosing the camera", () => {
  it("lists the cameras that are connected (and no microphone) once the camera is allowed", async () => {
    open();
    expect(cameraList()).toBeNull();
    await startCamera();
    const list = await waitFor(() => {
      const found = cameraList();
      expect(found).not.toBeNull();
      return found!;
    });
    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["FAKE Laptop camera", "FAKE USB webcam"]);
    // The camera in use (the system's default, the first one) is the one selected.
    expect(list.value).toBe("cam-a");
    expect(screen.queryByText("FAKE Built-in microphone")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Microphone" })).toBeNull();
    // A photo never listens: sound is never asked for.
    for (const [constraints] of getUserMedia.mock.calls)
      expect((constraints as MediaStreamConstraints).audio).toBe(false);
    expect((await axe.run(screen.getByRole("dialog"), AXE)).violations).toEqual(
      [],
    );
  });

  it("names the one camera when there is only one, with nothing to choose", async () => {
    connected = [LAPTOP, MICROPHONE];
    open();
    await startCamera();
    await screen.findByRole("option", { name: "FAKE Laptop camera" });
    expect(cameraList()).toBeDisabled();
    expect(cameraList()).toHaveValue(LAPTOP.deviceId);
  });

  it("names an unnamed camera by its place in the list", async () => {
    connected = [camera("cam-a", ""), camera("cam-b", ""), MICROPHONE];
    open();
    await startCamera();
    const list = await waitFor(() => {
      const found = cameraList();
      expect(found).not.toBeNull();
      return found!;
    });
    expect(
      within(list)
        .getAllByRole("option")
        // Fluent wraps the number it substitutes in invisible direction marks.
        .map((option) => (option.textContent ?? "").replace(/[⁨⁩]/g, "")),
    ).toEqual(["Camera 1", "Camera 2"]);
  });

  it("restarts the preview on the chosen camera, stops the old one and remembers the choice", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ camera: null, microphone: "mic-kept" }),
    );
    open();
    await startCamera();
    const list = await waitFor(() => {
      const found = cameraList();
      expect(found).not.toBeNull();
      return found!;
    });
    const first = streams[0]!;

    fireEvent.change(list, { target: { value: "cam-b" } });

    await waitFor(() => expect(ended(first)).toBe(true));
    await waitFor(() => expect(shutter()).toBeEnabled());
    const last = getUserMedia.mock.calls.at(-1)![0] as MediaStreamConstraints;
    // The chosen camera by its exact id, and no phone-style "back camera" preference beside it.
    expect(last.video).toMatchObject({ deviceId: { exact: "cam-b" } });
    expect(last.video).not.toHaveProperty("facingMode");
    expect(last.audio).toBe(false);
    await waitFor(() => expect(cameraList()!.value).toBe("cam-b"));
    // Remembered like the video dialog does it: the camera, with the microphone left as it was.
    expect(readDeviceChoice()).toEqual({
      camera: "cam-b",
      microphone: "mic-kept",
    });
    // The focus is back on the list that was used, not on the shutter.
    await waitFor(() => expect(cameraList()).toHaveFocus());
    expect(ended(streams[1]!)).toBe(false);
  });

  it("opens the remembered camera the next time", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ camera: "cam-b", microphone: null }),
    );
    window.localStorage.setItem(EXPLAINED_KEY, "1");
    open();
    await waitFor(() => expect(shutter()).toBeEnabled());
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const asked = getUserMedia.mock.calls[0]![0] as MediaStreamConstraints;
    expect(asked.video).toMatchObject({ deviceId: { exact: "cam-b" } });
    expect(cameraList()!.value).toBe("cam-b");
    expect(screen.queryByText(FELL_BACK)).toBeNull();
  });

  it("uses the system's default and says so when the remembered camera is gone", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ camera: "cam-unplugged", microphone: "mic-kept" }),
    );
    window.localStorage.setItem(EXPLAINED_KEY, "1");
    open();
    await waitFor(() => expect(shutter()).toBeEnabled());
    // First the remembered camera, then the default.
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(
      (getUserMedia.mock.calls[0]![0] as MediaStreamConstraints).video,
    ).toMatchObject({ deviceId: { exact: "cam-unplugged" } });
    expect(
      (getUserMedia.mock.calls[1]![0] as MediaStreamConstraints).video,
    ).not.toHaveProperty("deviceId");
    expect(await screen.findByText(FELL_BACK)).toBeInTheDocument();
    expect(cameraList()!.value).toBe("cam-a");
    // Nothing the patient did not choose is rewritten.
    expect(readDeviceChoice()).toEqual({
      camera: "cam-unplugged",
      microphone: "mic-kept",
    });
  });

  it("does not remember a camera picked from the list that vanished before it opened", async () => {
    open();
    await startCamera();
    const list = await waitFor(() => {
      const found = cameraList();
      expect(found).not.toBeNull();
      return found!;
    });
    // The webcam is unplugged after the list was made and before the pick is opened.
    connected = [LAPTOP, MICROPHONE];

    fireEvent.change(list, { target: { value: "cam-b" } });

    // The system's default opened instead, and said so; the gone camera is NOT the remembered one.
    expect(await screen.findByText(FELL_BACK)).toBeInTheDocument();
    await waitFor(() => expect(shutter()).toBeEnabled());
    expect(readDeviceChoice().camera).toBeNull();
  });

  it("says the same in each language", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ camera: "cam-unplugged", microphone: null }),
    );
    window.localStorage.setItem(EXPLAINED_KEY, "1");
    open();
    await screen.findByText(FELL_BACK);
    for (const locale of [
      "es",
      "fr",
      "pl",
      "pt-BR",
      "zh-CN",
      "zh-TW",
    ] as const) {
      act(() => setLocaleOverride(locale));
      const text = translate(locale, "interface.CameraDialog.cameraFellBack");
      expect(text).not.toBe(FELL_BACK);
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it("shows the failure and does not remember a chosen camera that is busy, and Try again opens the remembered one", async () => {
    open();
    await startCamera();
    const list = await waitFor(() => {
      const found = cameraList();
      expect(found).not.toBeNull();
      return found!;
    });
    getUserMedia.mockRejectedValueOnce(
      new DOMException("FAKE busy", "NotReadableError"),
    );

    fireEvent.change(list, { target: { value: "cam-b" } });

    // The failure is shown as for any camera, and the busy camera is NOT remembered.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(readDeviceChoice().camera).toBeNull();
    // Try again opens the camera that is remembered (the default), not the busy one.
    fireEvent.click(button("Try again"));
    await waitFor(() => expect(shutter()).toBeEnabled());
    expect(
      (getUserMedia.mock.calls.at(-1)![0] as MediaStreamConstraints).video,
    ).not.toHaveProperty("deviceId");
  });

  it("shows the permission message when the camera is refused, and no list", async () => {
    getUserMedia.mockRejectedValueOnce(
      new DOMException("FAKE denied", "NotAllowedError"),
    );
    open();
    fireEvent.click(button("Use the camera"));
    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(cameraList()).toBeNull();
    expect(readDeviceChoice().camera).toBeNull();
    // A refusal of the remembered camera is not "gone": the system's default is not tried.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when a remembered camera is refused permission", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ camera: "cam-b", microphone: null }),
    );
    window.localStorage.setItem(EXPLAINED_KEY, "1");
    getUserMedia.mockRejectedValueOnce(
      new DOMException("FAKE denied", "NotAllowedError"),
    );
    open();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(FELL_BACK)).toBeNull();
  });

  it("updates the list when a camera is plugged in or unplugged", async () => {
    connected = [LAPTOP, MICROPHONE];
    open();
    await startCamera();
    await screen.findByText("FAKE Laptop camera");
    expect(cameraList()).toBeNull();

    connected = [LAPTOP, WEBCAM, MICROPHONE];
    await act(async () => {
      navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
    });

    const list = await waitFor(() => {
      const found = cameraList();
      expect(found).not.toBeNull();
      return found!;
    });
    expect(within(list).getAllByRole("option")).toHaveLength(2);
  });

  it("fits a 320-pixel window at twice the text size, the list inside the dialog", async () => {
    await page.viewport(320, 640);
    document.documentElement.style.fontSize = "200%";
    try {
      connected = [
        camera("cam-a", "FAKE Integrated camera with a very long product name"),
        camera("cam-b", "FAKE External webcam with another very long name"),
        MICROPHONE,
      ];
      open();
      await startCamera();
      const list = await waitFor(() => {
        const found = cameraList();
        expect(found).not.toBeNull();
        return found!;
      });
      const dialog = screen.getByRole("dialog").getBoundingClientRect();
      const box = list.getBoundingClientRect();
      expect(dialog.right).toBeLessThanOrEqual(320);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.left).toBeGreaterThanOrEqual(dialog.left);
      expect(box.right).toBeLessThanOrEqual(dialog.right);
    } finally {
      await page.viewport(1100, 760);
    }
  });
});
