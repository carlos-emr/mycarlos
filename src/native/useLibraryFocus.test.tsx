import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLibraryFocus } from "./useLibraryFocus";

let focusIfLost = () => {};

function Library({
  busy = false,
  covered = false,
  modal = false,
  showTrigger = true,
  location = "First folder",
}: {
  busy?: boolean;
  covered?: boolean;
  modal?: boolean;
  showTrigger?: boolean;
  location?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  focusIfLost = useLibraryFocus(
    root,
    heading,
    busy || covered || modal,
    location,
  );
  return (
    <>
      <button>Elsewhere</button>
      <div ref={root} inert={covered}>
        <h1 ref={heading} tabIndex={-1}>
          {location}
        </h1>
        {showTrigger && <button disabled={busy}>Import</button>}
        {modal && (
          <section role="dialog" aria-modal="true" aria-label="Recovery setup">
            <button>Continue setup</button>
          </section>
        )}
      </div>
    </>
  );
}

const frame = () => act(() => vi.advanceTimersToNextFrame());
// A key pressed on the control that has focus, as a keyboard user's is. A key
// pressed with nothing focused (on the page itself) is no keyboard use.
const keyPress = (key = "Enter", on: Element = document.activeElement!) =>
  on.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
// As in WebKit (macOS, iOS): a click or tap does not focus the button pressed,
// and takes focus from whatever had it.
const webkitPress = (element: Element) => {
  element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  if (document.activeElement instanceof HTMLElement)
    document.activeElement.blur();
};

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
  });
  // Resets the hook's input record: a keyboard user's journeys, unless a test
  // presses with a pointer. The key is pressed on a focused control, as only
  // that counts as keyboard use.
  const control = document.createElement("button");
  document.body.append(control);
  control.focus();
  keyPress("Enter", control);
  control.remove();
});
afterEach(() => vi.useRealTimers());

describe("library focus recovery", () => {
  it("focuses the heading on entry only when focus is lost", () => {
    // Like the unlock field: the browser document has focus, but its focused
    // control is removed as the library opens. An unfocused window must not
    // have its focus changed by recovery.
    const previous = document.createElement("input");
    document.body.append(previous);
    previous.focus();
    previous.remove();
    render(<Library />);
    frame();
    expect(screen.getByRole("heading")).toHaveFocus();
  });

  it("returns to a retained trigger after its operation enables it", () => {
    const { rerender } = render(<Library />);
    frame();
    const trigger = screen.getByRole("button", { name: "Import" });
    trigger.focus();
    rerender(<Library busy />);
    expect(trigger).not.toHaveFocus();
    rerender(<Library />);
    frame();
    expect(trigger).toHaveFocus();
  });

  it("uses the new heading when navigation removes the trigger", () => {
    const { rerender } = render(<Library />);
    frame();
    screen.getByRole("button", { name: "Import" }).focus();
    rerender(<Library location="Second folder" showTrigger={false} />);
    frame();
    expect(
      screen.getByRole("heading", { name: "Second folder" }),
    ).toHaveFocus();
  });

  it("keeps deliberate focus elsewhere when an operation ends", () => {
    const { rerender } = render(<Library />);
    frame();
    screen.getByRole("button", { name: "Import" }).focus();
    rerender(<Library busy />);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    rerender(<Library />);
    frame();
    expect(elsewhere).toHaveFocus();
  });

  it("does not take focus from a recovery setup that opens as busy ends", () => {
    const { rerender } = render(<Library busy />);
    rerender(<Library modal />);
    const setup = screen.getByRole("button", { name: "Continue setup" });
    setup.focus();
    frame();
    expect(setup).toHaveFocus();
  });

  it("cancels a pending recovery when the library becomes covered", () => {
    const { rerender } = render(<Library busy />);
    rerender(<Library />);
    rerender(<Library covered />);
    frame();
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus on the page after a pointer press ends an operation", () => {
    const { rerender } = render(<Library />);
    frame();
    const trigger = screen.getByRole("button", { name: "Import" });
    // Used earlier from the keyboard, then pressed with a pointer.
    trigger.focus();
    webkitPress(trigger);
    rerender(<Library busy />);
    rerender(<Library />);
    frame();
    expect(document.activeElement).toBe(document.body);
  });

  // A dialog opened with a pointer, its first control focused as a dialog does.
  const openWithPointer = () => {
    const { rerender } = render(<Library />);
    frame();
    webkitPress(screen.getByRole("button", { name: "Import" }));
    rerender(<Library modal />);
    const setup = screen.getByRole("button", { name: "Continue setup" });
    setup.focus();
    return { rerender, setup };
  };

  it("leaves focus on the page when a pointer press closes a dialog", () => {
    const { rerender, setup } = openWithPointer();
    webkitPress(setup);
    rerender(<Library />);
    frame();
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus on the page when a key closes a dialog opened with a pointer", () => {
    const { rerender } = openWithPointer();
    keyPress("Escape");
    rerender(<Library />);
    frame();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not count a key pressed with nothing focused as keyboard use", () => {
    const { rerender } = render(<Library />);
    frame();
    webkitPress(screen.getByRole("button", { name: "Import" }));
    // Scrolling or copying after a click: the page itself has the key.
    keyPress("PageDown", document.body);
    keyPress("c", document.documentElement);
    rerender(<Library busy />);
    rerender(<Library />);
    frame();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not count a modifier key alone as keyboard use", () => {
    const { rerender } = render(<Library />);
    frame();
    webkitPress(screen.getByRole("button", { name: "Import" }));
    keyPress("Shift");
    rerender(<Library busy />);
    rerender(<Library />);
    frame();
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus on the page on entry after a pointer unlock", () => {
    const unlock = document.createElement("button");
    document.body.append(unlock);
    webkitPress(unlock);
    unlock.remove();
    render(<Library />);
    frame();
    expect(document.activeElement).toBe(document.body);
  });

  it("recovers after a pointer press when asked to", () => {
    const { rerender, setup } = openWithPointer();
    webkitPress(setup);
    focusIfLost();
    rerender(<Library />);
    frame();
    expect(screen.getByRole("heading")).toHaveFocus();
  });

  it("cancels a pending recovery when locking unmounts the library", () => {
    const { rerender, unmount } = render(<Library busy />);
    rerender(<Library />);
    unmount();
    const unlock = document.createElement("input");
    unlock.setAttribute("aria-label", "Unlock passphrase");
    document.body.append(unlock);
    try {
      unlock.focus();
      frame();
      expect(unlock).toHaveFocus();
    } finally {
      unlock.remove();
    }
  });
});
