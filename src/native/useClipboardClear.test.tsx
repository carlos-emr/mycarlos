import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIPBOARD_CLEAR_MS, useClipboardClear } from "./useClipboardClear";

/** A clipboard that remembers what was written, as a real one does. */
function installClipboard(
  options: { readable?: boolean; writeFails?: boolean } = {},
) {
  const state = { text: "" };
  const writeText = vi.fn(async (value: string) => {
    if (options.writeFails) throw new Error("FAKE: blocked");
    state.text = value;
  });
  const readText = vi.fn(async () => {
    if (options.readable === false) throw new Error("FAKE: unreadable");
    return state.text;
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText, readText },
  });
  return { state, writeText, readText };
}

let copyFn: (text: string) => Promise<void>;
let clearFn: () => void;
function Probe() {
  const { copy, clear } = useClipboardClear();
  copyFn = copy;
  clearFn = clear;
  return null;
}

/** Lets the read-then-write promise chain finish. */
const settle = () => act(async () => void (await Promise.resolve()));

describe("useClipboardClear", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("takes the copy off the clipboard after a minute, and not a second before", async () => {
    vi.useFakeTimers();
    const clip = installClipboard();
    render(<Probe />);
    await act(() => copyFn("FAKE secret text"));
    expect(clip.state.text).toBe("FAKE secret text");
    await act(async () => void vi.advanceTimersByTime(CLIPBOARD_CLEAR_MS - 1));
    await settle();
    expect(clip.state.text).toBe("FAKE secret text");
    await act(async () => void vi.advanceTimersByTime(1));
    await settle();
    expect(clip.state.text).toBe("");
  });

  it("leaves the clipboard alone when something else was copied since", async () => {
    vi.useFakeTimers();
    const clip = installClipboard();
    render(<Probe />);
    await act(() => copyFn("FAKE secret text"));
    clip.state.text = "something the patient copied after";
    await act(async () => void vi.advanceTimersByTime(CLIPBOARD_CLEAR_MS));
    await settle();
    expect(clip.state.text).toBe("something the patient copied after");
    // Only our own write ever happened: it never wrote an empty string over theirs.
    expect(clip.writeText).toHaveBeenCalledTimes(1);
  });

  it("takes the copy off when the screen that copied it goes away", async () => {
    const clip = installClipboard();
    const { unmount } = render(<Probe />);
    await act(() => copyFn("FAKE secret text"));
    unmount();
    await settle();
    await settle();
    expect(clip.state.text).toBe("");
  });

  it("clears on demand, once, and not again at the timer", async () => {
    vi.useFakeTimers();
    const clip = installClipboard();
    const { unmount } = render(<Probe />);
    await act(() => copyFn("FAKE secret text"));
    act(() => clearFn());
    await settle();
    await settle();
    expect(clip.state.text).toBe("");
    clip.state.text = "FAKE secret text";
    await act(async () => void vi.advanceTimersByTime(CLIPBOARD_CLEAR_MS * 2));
    await settle();
    // The copy was forgotten when it was cleared: a later identical text is not touched, by the
    // timer or when the screen goes away.
    expect(clip.state.text).toBe("FAKE secret text");
    unmount();
    await settle();
    await settle();
    expect(clip.state.text).toBe("FAKE secret text");
  });

  it("restarts the minute with a newer copy, which is the one cleared", async () => {
    vi.useFakeTimers();
    const clip = installClipboard();
    render(<Probe />);
    await act(() => copyFn("FAKE first"));
    await act(async () => void vi.advanceTimersByTime(40_000));
    await act(() => copyFn("FAKE second"));
    await act(async () => void vi.advanceTimersByTime(40_000));
    await settle();
    // 80 s after the first copy, 40 s after the second: still there.
    expect(clip.state.text).toBe("FAKE second");
    await act(async () => void vi.advanceTimersByTime(20_000));
    await settle();
    expect(clip.state.text).toBe("");
  });

  it("leaves a clipboard that cannot be read alone, and never throws", async () => {
    vi.useFakeTimers();
    const clip = installClipboard({ readable: false });
    const { unmount } = render(<Probe />);
    await act(() => copyFn("FAKE secret text"));
    await act(async () => void vi.advanceTimersByTime(CLIPBOARD_CLEAR_MS));
    await settle();
    expect(clip.state.text).toBe("FAKE secret text");
    expect(clip.writeText).toHaveBeenCalledTimes(1);
    // A clipboard with no read side at all (it throws before any promise) is left alone too.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clip.writeText },
    });
    await act(() => copyFn("FAKE again"));
    expect(() => unmount()).not.toThrow();
  });

  it("rejects when the write is refused, and clears nothing later", async () => {
    vi.useFakeTimers();
    const clip = installClipboard({ writeFails: true });
    const { unmount } = render(<Probe />);
    await expect(copyFn("FAKE secret text")).rejects.toThrow("FAKE: blocked");
    await act(async () => void vi.advanceTimersByTime(CLIPBOARD_CLEAR_MS));
    await settle();
    unmount();
    await settle();
    expect(clip.readText).not.toHaveBeenCalled();
  });
});
