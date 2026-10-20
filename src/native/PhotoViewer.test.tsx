import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhotoViewer } from "./PhotoViewer";

/** A FAKE photo, 1200 by 900, drawn here. */
function photoUrl() {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 900;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#6a8";
  context.fillRect(0, 0, 1200, 900);
  context.fillStyle = "#246";
  context.fillRect(500, 350, 200, 200);
  return canvas.toDataURL("image/png");
}

async function open() {
  render(
    <PhotoViewer name="FAKE photo.jpg" url={photoUrl()} onClose={vi.fn()} />,
  );
  const image = screen.getByRole("img", { name: "Photo: FAKE photo.jpg" });
  await vi.waitFor(() =>
    expect((image as HTMLImageElement).complete).toBe(true),
  );
  return screen.getByRole("region", { name: /^Photo\./ });
}

const centre = (frame: HTMLElement) => ({
  x: (frame.scrollLeft + frame.clientWidth / 2) / frame.scrollWidth,
  y: (frame.scrollTop + frame.clientHeight / 2) / frame.scrollHeight,
});

afterEach(cleanup);

describe("PhotoViewer (#73)", () => {
  it("keeps the middle of the view where it was when zooming in and out", async () => {
    const frame = await open();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await vi.waitFor(() =>
      expect(frame.scrollWidth).toBeGreaterThan(frame.clientWidth),
    );
    // Somewhere off the middle, then in and out again.
    frame.scrollLeft = frame.scrollWidth * 0.6 - frame.clientWidth / 2;
    frame.scrollTop = frame.scrollHeight * 0.3 - frame.clientHeight / 2;
    const before = centre(frame);
    for (const button of ["Zoom in", "Zoom in", "Zoom out"]) {
      fireEvent.click(screen.getByRole("button", { name: button }));
      const after = centre(frame);
      expect(after.x).toBeCloseTo(before.x, 2);
      expect(after.y).toBeCloseTo(before.y, 2);
    }
  });

  it("moves around when the zoomed photo is dragged with a mouse", async () => {
    const frame = await open();
    for (let press = 0; press < 2; press++)
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    frame.scrollLeft = 200;
    frame.scrollTop = 200;
    const pointer = {
      pointerId: 7,
      pointerType: "mouse",
      button: 0,
      buttons: 1,
    };
    fireEvent.pointerDown(frame, { ...pointer, clientX: 300, clientY: 300 });
    expect(frame).toHaveClass("dragging");
    fireEvent.pointerMove(frame, { ...pointer, clientX: 250, clientY: 260 });
    // Dragged left and up: the view moves right and down, as on paper.
    expect([frame.scrollLeft, frame.scrollTop]).toEqual([250, 240]);
    fireEvent.pointerUp(frame, { ...pointer, clientX: 250, clientY: 260 });
    expect(frame).not.toHaveClass("dragging");
    fireEvent.pointerMove(frame, { ...pointer, clientX: 100, clientY: 100 });
    expect([frame.scrollLeft, frame.scrollTop]).toEqual([250, 240]);
  });

  it("stops dragging when the button is no longer held, even if the release was missed", async () => {
    const frame = await open();
    for (let press = 0; press < 2; press++)
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    frame.scrollLeft = 200;
    frame.scrollTop = 200;
    const pointer = { pointerId: 9, pointerType: "mouse", button: 0 };
    fireEvent.pointerDown(frame, {
      ...pointer,
      buttons: 1,
      clientX: 300,
      clientY: 300,
    });
    // The release happened outside the window and never arrived; the mouse
    // comes back over the photo with no button held.
    fireEvent.pointerMove(frame, {
      ...pointer,
      buttons: 0,
      clientX: 250,
      clientY: 260,
    });
    expect([frame.scrollLeft, frame.scrollTop]).toEqual([200, 200]);
    expect(frame).not.toHaveClass("dragging");
    // Losing the pointer (a window switch) ends a drag too.
    fireEvent.pointerDown(frame, {
      ...pointer,
      buttons: 1,
      clientX: 300,
      clientY: 300,
    });
    fireEvent.lostPointerCapture(frame, pointer);
    expect(frame).not.toHaveClass("dragging");
  });

  it("leaves a finger to pan as on any page, and does not drag at fitted size", async () => {
    const frame = await open();
    fireEvent.pointerDown(frame, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 300,
      clientY: 300,
    });
    expect(frame).not.toHaveClass("dragging");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.pointerDown(frame, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 300,
      clientY: 300,
    });
    expect(frame).not.toHaveClass("dragging");
  });

  it("still scrolls with the arrow keys", async () => {
    const frame = await open();
    for (let press = 0; press < 2; press++)
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    frame.scrollLeft = 0;
    frame.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    await vi.waitFor(() => expect(frame.scrollLeft).toBeGreaterThan(0));
  });
});
