import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHideWhenAway } from "./useHideWhenAway";

// What makes a shown passphrase or key go back to dots. The screens' own tests (VaultAuth,
// RestoreBackup) drive it through a form; these pin the hook itself: which events, the latest
// function, and nothing after the screen is gone.

afterEach(() => vi.restoreAllMocks());

const hiddenPage = () =>
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

describe("useHideWhenAway", () => {
  it("hides when the window loses the focus, the page is put away, the app is frozen, or the page is reported hidden", () => {
    const hide = vi.fn();
    renderHook(() => useHideWhenAway(hide));
    fireEvent(window, new Event("blur"));
    expect(hide).toHaveBeenCalledTimes(1);
    fireEvent(window, new Event("pagehide"));
    expect(hide).toHaveBeenCalledTimes(2);
    fireEvent(document, new Event("freeze"));
    expect(hide).toHaveBeenCalledTimes(3);
    const spy = hiddenPage();
    fireEvent(document, new Event("visibilitychange"));
    expect(hide).toHaveBeenCalledTimes(4);
    spy.mockRestore();
  });

  it("does nothing when the page becomes visible again", () => {
    const hide = vi.fn();
    renderHook(() => useHideWhenAway(hide));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(hide).not.toHaveBeenCalled();
  });

  it("does nothing when only the focus moves between elements of the page", () => {
    const hide = vi.fn();
    renderHook(() => useHideWhenAway(hide));
    const box = document.createElement("input");
    const button = document.createElement("button");
    document.body.append(box, button);
    box.focus();
    // An element's blur does not bubble to the window: pressing Show must not hide what it shows.
    fireEvent.blur(box);
    fireEvent.focusOut(box);
    button.focus();
    fireEvent.blur(button);
    expect(hide).not.toHaveBeenCalled();
    box.remove();
    button.remove();
  });

  it("calls the latest function it was given, without listening again", () => {
    const first = vi.fn();
    const second = vi.fn();
    const add = vi.spyOn(window, "addEventListener");
    const { rerender } = renderHook(({ hide }) => useHideWhenAway(hide), {
      initialProps: { hide: first },
    });
    const added = add.mock.calls.length;
    rerender({ hide: second });
    // No new listeners for the new function.
    expect(add.mock.calls.length).toBe(added);
    fireEvent(window, new Event("blur"));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops listening when its screen goes away", () => {
    const hide = vi.fn();
    const { unmount } = renderHook(() => useHideWhenAway(hide));
    unmount();
    fireEvent(window, new Event("blur"));
    fireEvent(window, new Event("pagehide"));
    fireEvent(document, new Event("freeze"));
    hiddenPage();
    fireEvent(document, new Event("visibilitychange"));
    expect(hide).not.toHaveBeenCalled();
  });
});
