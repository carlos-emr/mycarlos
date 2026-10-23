import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLibraryFocus } from "./useLibraryFocus";

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
  useLibraryFocus(root, heading, busy || covered || modal, location);
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

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
  });
});
afterEach(() => vi.useRealTimers());

describe("library focus recovery", () => {
  it("focuses the heading on entry only when focus is lost", () => {
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
