import { humanText } from "../test/humanText";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { CameraDialog } from "./CameraDialog";
import { setLocaleOverride, translate } from "../i18n";

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
  it("rewords a permission refusal and phone help without asking for the camera again", async () => {
    setLocaleOverride("en");
    getUserMedia.mockRejectedValueOnce(
      new DOMException("FAKE denied", "NotAllowedError"),
    );
    const { onClose, onUse } = open({ platform: "ios" });
    fireEvent.click(button("Use the camera"));
    const alert = await screen.findByRole("alert");
    const retry = button("Try again");
    await waitFor(() => expect(retry).toHaveFocus());

    act(() => setLocaleOverride("pl"));
    expect(screen.getByRole("alert")).toBe(alert);
    expect(alert).toHaveHumanTextContent(
      "myCarlos nie może używać aparatu. Proszę otworzyć Ustawienia telefonu, następnie myCarlos i włączyć Aparat. Następnie proszę wybrać Spróbuj ponownie.",
    );
    expect(button("Spróbuj ponownie")).toBe(retry);
    expect(retry).toHaveFocus();

    act(() => setLocaleOverride("pt-BR"));
    expect(alert).toHaveHumanTextContent(
      "O myCarlos não pode usar a câmera. Abra os Ajustes do celular, depois myCarlos, e ative a Câmera. Depois, escolha Tentar de novo.",
    );
    expect(retry).toHaveFocus();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(onUse).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the captured pixels and stopped camera while translating the preview", async () => {
    setLocaleOverride("en");
    const { onUse, onClose } = open();
    await startCamera();
    fireEvent.click(shutter());
    const photo = screen.getByRole("img", {
      name: humanText("The photo you took"),
    }) as HTMLCanvasElement;
    const pixels = photo.toDataURL();
    const use = button("Use photo");
    await waitFor(() => expect(use).toHaveFocus());
    expect(ended(streams[0])).toBe(true);

    for (const locale of ["pl", "pt-BR", "en"] as const) {
      act(() => setLocaleOverride(locale));
      expect(
        screen.getByRole("img", {
          name: translate(locale, "interface.CameraDialog.thePhotoYouTook"),
        }),
      ).toBe(photo);
      expect(photo).toBeVisible();
      expect(photo.toDataURL()).toBe(pixels);
      expect(screen.getByRole("status")).toHaveHumanTextContent(
        translate(
          locale,
          "interface.CameraDialog.photoTakenRetakeOrUseThePhoto",
        ),
      );
      expect(button(translate(locale, "interface.CameraDialog.usePhoto"))).toBe(
        use,
      );
      expect(use).toHaveFocus();
      expect(ended(streams[0])).toBe(true);
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    }
    expect(onUse).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("explains first, asks for video only after the tap, and saves a JPEG", async () => {
    const { onUse, saved } = open();
    const dialog = screen.getByRole("dialog", {
      name: humanText("Take a photo"),
    });
    expect(dialog).toHaveHumanAccessibleDescription(
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
    expect(screen.getByLabelText(humanText("Camera view"))).toBeVisible();
    await waitFor(() => expect(shutter()).toHaveFocus());
    expect(screen.getByRole("status")).toHaveHumanTextContent("Camera ready.");
    expect((await axe.run(dialog, AXE)).violations).toEqual([]);

    fireEvent.click(shutter());
    // The live view stops once the photo is taken.
    expect(ended(streams[0])).toBe(true);
    expect(
      screen.getByRole("img", { name: humanText("The photo you took") }),
    ).toBeVisible();
    expect(screen.getByLabelText(humanText("Camera view"))).not.toBeVisible();
    await waitFor(() => expect(button("Use photo")).toHaveFocus());
    expect(screen.getByRole("status")).toHaveHumanTextContent(
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
    expect(
      screen.queryByRole("button", { name: humanText("Use the camera") }),
    ).toBeNull();
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

  it("does not save a photo still being prepared when the vault locks", async () => {
    const { onUse, unmount } = open();
    await startCamera();
    fireEvent.click(shutter());
    // The JPEG is made, but handed back only after the lock.
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    let handBack: (() => void) | undefined;
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation(function (
        this: HTMLCanvasElement,
        callback: BlobCallback,
        type?: string,
        quality?: number,
      ) {
        toBlob.call(
          this,
          (blob) => {
            handBack = () => callback(blob);
          },
          type,
          quality,
        );
      });
    try {
      fireEvent.click(button("Use photo"));
      await waitFor(() => expect(handBack).toBeDefined());
      unmount();
      handBack!();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(onUse).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("clears a handed-off JPEG after saving settles even if the dialog already closed", async () => {
    let finishSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const handoff = vi
      .fn<(jpeg: Uint8Array) => Promise<void>>()
      .mockReturnValue(pendingSave);
    const { unmount, onClose } = open({ onUse: handoff });
    try {
      await startCamera();
      fireEvent.click(shutter());
      fireEvent.click(button("Use photo"));
      await waitFor(() => expect(handoff).toHaveBeenCalledOnce());
      const jpeg = handoff.mock.calls[0][0];
      const original = jpeg.slice();
      expect(original.byteLength).toBeGreaterThan(3);
      expect([...original.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      // The consumer already has these bytes when a lock closes the dialog.
      await act(async () => unmount());
      expect(screen.queryByRole("dialog")).toBeNull();
      // Do not erase the consumer's in-flight input before it finishes reading.
      expect(jpeg).toEqual(original);
      await act(async () => finishSave());
      // Cleanup still runs after the producing component has gone away.
      expect(jpeg.byteLength).toBe(original.byteLength);
      expect(jpeg.every((byte) => byte === 0)).toBe(true);
      expect(handoff).toHaveBeenCalledOnce();
      expect(onClose).not.toHaveBeenCalled();
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(ended(streams[0])).toBe(true);
    } finally {
      await act(async () => finishSave());
    }
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
    expect(await screen.findByRole("alert")).toHaveHumanTextContent(
      "The camera stopped. Check that it is connected, then choose Try again.",
    );
    fireEvent.click(button("Try again"));
    await waitFor(() => expect(shutter()).toBeEnabled());
  });

  it("recovers from a disconnected camera and saves from the replacement stream", async () => {
    const { onUse } = open();
    await startCamera();
    const disconnected = streams[0];
    await act(async () => {
      // Canvas tracks do not emulate hardware disconnection. End the track
      // and deliver the event a disconnected camera would send.
      const track = disconnected.getVideoTracks()[0];
      track.stop();
      track.dispatchEvent(new Event("ended"));
    });
    expect(await screen.findByRole("alert")).toHaveHumanTextContent(
      "The camera stopped. Check that it is connected, then choose Try again.",
    );
    await waitFor(() => expect(button("Try again")).toHaveFocus());
    expect(onUse).not.toHaveBeenCalled();

    fireEvent.click(button("Try again"));
    await waitFor(() => expect(shutter()).toBeEnabled());
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(streams).toHaveLength(2);
    expect(ended(streams[1])).toBe(false);
    expect(screen.getByLabelText(humanText("Camera view"))).toHaveProperty(
      "srcObject",
      streams[1],
    );
    fireEvent.click(shutter());
    expect(ended(streams[1])).toBe(true);
    fireEvent.click(button("Use photo"));
    await waitFor(() => expect(onUse).toHaveBeenCalledOnce());
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
    expect(await screen.findByRole("alert")).toHaveHumanTextContent(message);
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
    expect(screen.getByRole("status")).toHaveHumanTextContent(
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
    expect(screen.getByRole("dialog")).toHaveHumanAccessibleDescription(
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
    expect(await screen.findByRole("alert")).toHaveHumanTextContent(
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
