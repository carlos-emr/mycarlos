import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { CameraDialog } from "./CameraDialog";

const EXPLAINED_KEY = "mycarlos.cameraExplained.v1";
const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
};

// A fake camera: a canvas painted one colour, streamed as video. Each stream
// handed out is kept, so a test can check that its track was stopped.
const streams: MediaStream[] = [];
const painters: number[] = [];
function fakeCamera(): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d")!;
  const paint = () => {
    context.fillStyle = "#1d6fb8";
    context.fillRect(0, 0, 320, 240);
  };
  paint();
  const stream = canvas.captureStream(15);
  // A captured canvas sends a frame when it is drawn on.
  painters.push(window.setInterval(paint, 40));
  streams.push(stream);
  return stream;
}
const ended = (stream: MediaStream) =>
  stream.getTracks().every((track) => track.readyState === "ended");

let getUserMedia: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  window.localStorage.removeItem(EXPLAINED_KEY);
  streams.length = 0;
  getUserMedia = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockImplementation(async () => fakeCamera());
});
afterEach(() => {
  getUserMedia.mockRestore();
  for (const timer of painters.splice(0)) window.clearInterval(timer);
  for (const stream of streams)
    for (const track of stream.getTracks()) track.stop();
  window.localStorage.removeItem(EXPLAINED_KEY);
  document.documentElement.style.fontSize = "";
});

function open(overrides: Partial<Parameters<typeof CameraDialog>[0]> = {}) {
  const saved: Uint8Array[] = [];
  const onUse = vi.fn(async (jpeg: Uint8Array) => {
    saved.push(jpeg.slice());
  });
  const onClose = vi.fn();
  const props = {
    platform: "windows",
    notice: "",
    saving: false,
    onUse,
    onClose,
    ...overrides,
  };
  const view = render(<CameraDialog {...props} />);
  return { ...view, props, onUse, onClose, saved };
}

const button = (name: string) => screen.getByRole("button", { name });
const shutter = () => button("Take photo");
async function startCamera() {
  fireEvent.click(button("Use the camera"));
  await waitFor(() => expect(shutter()).toBeEnabled());
}

describe("CameraDialog", () => {
  it("explains first, asks for video only after the tap, and saves a JPEG", async () => {
    const { onUse, saved } = open();
    const dialog = screen.getByRole("dialog", { name: "Take a photo" });
    expect(dialog).toHaveAccessibleDescription(
      "myCarlos uses the camera to save photos of your health documents. Photos stay locked in myCarlos. The camera is on only while you take the photo. It turns off when you take it, close this window, or myCarlos locks.",
    );
    expect(button("Use the camera")).toHaveFocus();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect((await axe.run(dialog, AXE)).violations).toEqual([]);

    await startCamera();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: expect.objectContaining({ facingMode: "environment" }),
      audio: false,
    });
    expect(screen.getByLabelText("Camera view")).toBeVisible();
    await waitFor(() => expect(shutter()).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("Camera ready.");
    expect((await axe.run(dialog, AXE)).violations).toEqual([]);

    fireEvent.click(shutter());
    // The live view stops once the photo is taken.
    expect(ended(streams[0])).toBe(true);
    expect(
      screen.getByRole("img", { name: "The photo you took" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Camera view")).not.toBeVisible();
    await waitFor(() => expect(button("Use photo")).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Photo taken. Retake or use the photo.",
    );
    expect((await axe.run(dialog, AXE)).violations).toEqual([]);

    fireEvent.click(button("Retake"));
    await waitFor(() => expect(shutter()).toBeEnabled());
    expect(streams).toHaveLength(2);
    fireEvent.click(shutter());
    expect(ended(streams[1])).toBe(true);
    fireEvent.click(button("Use photo"));
    await waitFor(() => expect(onUse).toHaveBeenCalledTimes(1));

    const jpeg = saved[0];
    expect([...jpeg.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect([...jpeg.slice(-2)]).toEqual([0xff, 0xd9]);
    const picture = await createImageBitmap(
      new Blob([jpeg as BlobPart], { type: "image/jpeg" }),
    );
    expect([picture.width, picture.height]).toEqual([320, 240]);
    // The bytes handed over are overwritten once the save settles.
    await waitFor(() =>
      expect(onUse.mock.calls[0][0].every((byte) => byte === 0)).toBe(true),
    );
  });

  it("opens straight on the camera once the camera has worked", async () => {
    const first = open();
    await startCamera();
    first.unmount();
    expect(ended(streams[0])).toBe(true);

    open();
    expect(screen.queryByRole("button", { name: "Use the camera" })).toBeNull();
    await waitFor(() => expect(shutter()).toBeEnabled());
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Cancel", () => fireEvent.click(button("Cancel"))],
    ["Escape", () => fireEvent.keyDown(window, { key: "Escape" })],
  ])("stops the camera and closes on %s", async (_, leave) => {
    const { onClose } = open();
    await startCamera();
    leave();
    expect(ended(streams[0])).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stops the camera when the vault locks, which closes the dialog", async () => {
    const { unmount } = open();
    await startCamera();
    unmount();
    expect(ended(streams[0])).toBe(true);
  });

  it("stops the camera when the window is hidden", async () => {
    open();
    await startCamera();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
    expect(ended(streams[0])).toBe(true);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The camera stopped. Check that it is connected, then choose Try again.",
    );
    fireEvent.click(button("Try again"));
    await waitFor(() => expect(shutter()).toBeEnabled());
  });

  it("stops a camera that answers after the dialog was cancelled", async () => {
    let answer: (stream: MediaStream) => void = () => undefined;
    getUserMedia.mockImplementationOnce(
      () => new Promise<MediaStream>((resolve) => (answer = resolve)),
    );
    const { onClose } = open();
    fireEvent.click(button("Use the camera"));
    fireEvent.click(button("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    const late = fakeCamera();
    answer(late);
    await waitFor(() => expect(ended(late)).toBe(true));
  });

  it.each([
    [
      "NotAllowedError",
      "windows",
      "myCarlos can't use the camera. In Windows Settings, open Privacy & security, then Camera, and turn on camera access for desktop apps. Then choose Try again.",
    ],
    [
      "NotAllowedError",
      "macos",
      "myCarlos can't use the camera. In System Settings, open Privacy & Security, then Camera, and turn on myCarlos. Then choose Try again.",
    ],
    [
      "NotFoundError",
      "linux",
      "No camera was found. Connect a camera, then choose Try again.",
    ],
    [
      "NotReadableError",
      "windows",
      "The camera is in use by another app. Close it, then choose Try again.",
    ],
  ])("says what to do after %s on %s", async (name, platform, message) => {
    getUserMedia.mockRejectedValueOnce(new DOMException("FAKE", name));
    const { onClose } = open({ platform });
    fireEvent.click(button("Use the camera"));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    await waitFor(() => expect(button("Try again")).toHaveFocus());
    expect((await axe.run(screen.getByRole("dialog"), AXE)).violations).toEqual(
      [],
    );
    // The camera was never on, so trying again asks again.
    fireEvent.click(button("Try again"));
    await waitFor(() => expect(shutter()).toBeEnabled());
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    fireEvent.click(button("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close or retake while the photo is being saved, and shows the result", async () => {
    const { rerender, props, onClose } = open();
    await startCamera();
    fireEvent.click(shutter());
    button("Use photo").focus();
    rerender(<CameraDialog {...props} saving />);
    // Not disabled, so the focus stays in the dialog; they do nothing.
    expect(button("Saving…")).toHaveAttribute("aria-disabled", "true");
    expect(button("Saving…")).toHaveFocus();
    expect(button("Retake")).toHaveAttribute("aria-disabled", "true");
    const asked = getUserMedia.mock.calls.length;
    fireEvent.click(button("Retake"));
    fireEvent.click(button("Saving…"));
    expect(getUserMedia).toHaveBeenCalledTimes(asked);
    expect(props.onUse).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    rerender(
      <CameraDialog {...props} notice="FAKE The photo was not saved." />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "FAKE The photo was not saved.",
    );
    expect(button("Use photo")).toHaveAttribute("aria-disabled", "false");
  });

  it("on a phone, says the phone asks once, and holds the lock while it asks (D97)", async () => {
    const asked: Promise<unknown>[] = [];
    const holds = vi.fn();
    const whileAsking = <T,>(question: Promise<T>) => {
      holds();
      asked.push(question);
      return question;
    };
    open({ platform: "android", whileAsking });
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      /Your phone asks once whether myCarlos may use the camera\. The camera is on only while you take the photo\. It turns off when you take it, cancel, or myCarlos locks\./,
    );
    expect(holds).not.toHaveBeenCalled();
    await startCamera();
    // The very request for the camera went through it, and nothing else.
    expect(holds).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(await asked[0]).toBe(streams[0]);
  });

  it("tells a phone where to allow the camera after it was refused (D97)", async () => {
    getUserMedia.mockRejectedValueOnce(
      new DOMException("FAKE", "NotAllowedError"),
    );
    open({ platform: "ios" });
    fireEvent.click(button("Use the camera"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "myCarlos can't use the camera. Open your phone's Settings, then myCarlos, and turn on Camera. Then choose Try again.",
    );
    await waitFor(() => expect(button("Try again")).toHaveFocus());
  });

  it("fits a phone-width window at twice the text size, with 44-pixel controls", async () => {
    await page.viewport(390, 844);
    document.documentElement.style.fontSize = "200%";
    try {
      open();
      await startCamera();
      const dialog = screen.getByRole("dialog").getBoundingClientRect();
      expect(dialog.right).toBeLessThanOrEqual(390);
      for (const control of screen.getAllByRole("button")) {
        const box = control.getBoundingClientRect();
        expect(box.height).toBeGreaterThanOrEqual(44);
        // Every control is inside the dialog, none cut off at either side.
        expect(box.left).toBeGreaterThanOrEqual(dialog.left);
        expect(box.right).toBeLessThanOrEqual(dialog.right);
      }
      expect(shutter().getBoundingClientRect().height).toBeGreaterThanOrEqual(
        56,
      );
    } finally {
      await page.viewport(1100, 760);
    }
  });
});
