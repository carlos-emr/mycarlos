import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUALITIES,
  highQualityAvailable,
  pickMp4Type,
  readVideoQuality,
  rememberVideoQuality,
} from "./video";

// What the video helpers do where the webview cannot say what it can record. FAKE webview
// answers only; every stub is restored after each case.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.removeItem("mycarlos.videoQuality.v1");
});

describe("a webview that cannot say what it records", () => {
  it("records nothing where there is no recorder, or a recorder that cannot name its types", () => {
    // Called with no argument, the default is the webview's own recorder: stub it away.
    vi.stubGlobal("MediaRecorder", undefined);
    expect(pickMp4Type()).toBeNull();
    // A recorder object without the question it should answer is no recorder either.
    expect(pickMp4Type({} as never)).toBeNull();
  });

  it("offers High only when the camera reports both the width and the height of 1080p", () => {
    const track = (capabilities: object) => ({
      getCapabilities: () => capabilities,
    });
    expect(
      highQualityAvailable(
        track({
          width: { max: QUALITIES.high.width },
          height: { max: QUALITIES.high.height },
        }),
      ),
    ).toBe(true);
    // The width alone, or the height alone, is not enough; a webview that gives neither says nothing.
    expect(
      highQualityAvailable(track({ width: { max: QUALITIES.high.width } })),
    ).toBe(false);
    expect(
      highQualityAvailable(track({ height: { max: QUALITIES.high.height } })),
    ).toBe(false);
    expect(highQualityAvailable(track({}))).toBe(false);
    expect(highQualityAvailable(undefined)).toBe(false);
  });

  it("falls back to Standard when the device cannot read or keep the chosen quality", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("FAKE: storage is blocked");
    });
    // Reading a blocked store is Standard, not an error out of the recording dialog.
    expect(readVideoQuality()).toBe("standard");
    vi.restoreAllMocks();

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("FAKE: storage is full");
    });
    // Keeping a choice that cannot be kept is silent; the next start reads Standard again.
    expect(() => rememberVideoQuality("high")).not.toThrow();
    vi.restoreAllMocks();
    expect(readVideoQuality()).toBe("standard");
  });
});
