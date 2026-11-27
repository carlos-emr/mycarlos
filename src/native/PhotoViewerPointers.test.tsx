import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { humanText } from "../test/humanText";
import { PhotoViewer } from "./PhotoViewer";

// Which pointers move a zoomed photo, and which presses close the viewer. FAKE photo drawn here.

function photoUrl() {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 900;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#6a8";
  context.fillRect(0, 0, 1200, 900);
  return canvas.toDataURL("image/png");
}

async function open(onClose = vi.fn()) {
  render(
    <PhotoViewer name="FAKE photo.jpg" url={photoUrl()} onClose={onClose} />,
  );
  const image = screen.getByRole("img", {
    name: humanText("Photo: FAKE photo.jpg"),
  });
  await vi.waitFor(() =>
    expect((image as HTMLImageElement).complete).toBe(true),
  );
  const frame = screen.getByRole("region", { name: humanText(/^Photo\./) });
  for (let press = 0; press < 2; press++)
    fireEvent.click(screen.getByRole("button", { name: humanText("Zoom in") }));
  frame.scrollLeft = 200;
  frame.scrollTop = 200;
  return { frame, onClose };
}

afterEach(cleanup);

describe("PhotoViewer pointers", () => {
  it("is not dragged by a secondary button, which is left to the browser's own menu", async () => {
    const { frame } = await open();
    fireEvent.pointerDown(frame, {
      pointerId: 3,
      pointerType: "mouse",
      button: 2,
      buttons: 2,
      clientX: 300,
      clientY: 300,
    });
    expect(frame).not.toHaveClass("dragging");
    fireEvent.pointerMove(frame, {
      pointerId: 3,
      pointerType: "mouse",
      button: 2,
      buttons: 2,
      clientX: 100,
      clientY: 100,
    });
    expect([frame.scrollLeft, frame.scrollTop]).toEqual([200, 200]);
  });

  it("follows only the pointer that started the drag: another pointer neither moves nor ends it", async () => {
    const { frame } = await open();
    const mine = { pointerId: 7, pointerType: "mouse", button: 0, buttons: 1 };
    const other = { pointerId: 8, pointerType: "pen", button: 0, buttons: 1 };
    fireEvent.pointerDown(frame, { ...mine, clientX: 300, clientY: 300 });
    expect(frame).toHaveClass("dragging");
    // A second pointer moving over the photo does not drag it...
    fireEvent.pointerMove(frame, { ...other, clientX: 100, clientY: 100 });
    expect([frame.scrollLeft, frame.scrollTop]).toEqual([200, 200]);
    // ...and lifting it does not end the first pointer's drag.
    fireEvent.pointerUp(frame, { ...other, clientX: 100, clientY: 100 });
    expect(frame).toHaveClass("dragging");
    fireEvent.pointerMove(frame, { ...mine, clientX: 250, clientY: 260 });
    expect([frame.scrollLeft, frame.scrollTop]).toEqual([250, 240]);
    fireEvent.pointerUp(frame, { ...mine, clientX: 250, clientY: 260 });
    expect(frame).not.toHaveClass("dragging");
  });

  it("closes on a press outside the viewer, and not on a press inside it", async () => {
    const { frame, onClose } = await open();
    // A press on the photo, the dialog around it or its buttons stays in the viewer.
    fireEvent.mouseDown(frame);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    // A press on the dimmed page behind it closes.
    const backdrop = screen.getByRole("dialog").parentElement!;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
