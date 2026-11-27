import { afterEach, describe, expect, it, vi } from "vitest";
import { openLevelReader } from "./mediaDevices";

// The microphone level meter, with a FAKE audio engine: what it measures, what it will not do,
// and that a webview that fails halfway leaves no meter and no error.

class FakeAudioContext {
  static samples = new Uint8Array(512).fill(128);
  static resumeRejects = true;
  static closeRejects = true;
  static failToStart = false;
  static made: FakeAudioContext[] = [];
  destination = { id: "FAKE-speakers" };
  connected: string[] = [];
  mutedGain = { value: 1 };
  closed = 0;
  constructor() {
    if (FakeAudioContext.failToStart) throw new Error("FAKE: no audio engine");
    FakeAudioContext.made.push(this);
  }
  createAnalyser() {
    const connected = this.connected;
    return {
      fftSize: 0,
      getByteTimeDomainData(into: Uint8Array) {
        into.set(FakeAudioContext.samples.subarray(0, into.length));
      },
      connect() {
        connected.push("analyser->gain");
      },
    };
  }
  createGain() {
    const connected = this.connected;
    const gain = this.mutedGain;
    return {
      gain,
      connect(target: unknown) {
        connected.push(target === undefined ? "gain->?" : "gain->destination");
      },
    };
  }
  createMediaStreamSource() {
    const connected = this.connected;
    return {
      connect() {
        connected.push("source->analyser");
      },
    };
  }
  resume() {
    return FakeAudioContext.resumeRejects
      ? Promise.reject(new Error("FAKE: suspended"))
      : Promise.resolve();
  }
  close() {
    this.closed += 1;
    return FakeAudioContext.closeRejects
      ? Promise.reject(new Error("FAKE: already closed"))
      : Promise.resolve();
  }
}

// Kept before any case replaces the global with the fake.
const RealAudioContext = AudioContext;

/** A stream with one real silent audio track, made with the browser's own engine, because the
 * meter wraps the track in a new stream of its own. */
function streamWithOneAudioTrack(): MediaStream {
  const engine = new RealAudioContext();
  const stream = engine.createMediaStreamDestination().stream;
  void engine.close();
  return stream;
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeAudioContext.samples = new Uint8Array(512).fill(128);
  FakeAudioContext.resumeRejects = true;
  FakeAudioContext.closeRejects = true;
  FakeAudioContext.failToStart = false;
  FakeAudioContext.made = [];
});

describe("the microphone level meter", () => {
  it("has no meter where the webview has no audio engine, or the stream has no sound", () => {
    const withSound = streamWithOneAudioTrack();
    vi.stubGlobal("AudioContext", undefined);
    expect(openLevelReader(withSound)).toBeNull();
    vi.stubGlobal("AudioContext", FakeAudioContext);
    expect(openLevelReader(new MediaStream())).toBeNull();
    // And none, without an error, when the engine itself will not start.
    FakeAudioContext.failToStart = true;
    expect(openLevelReader(withSound)).toBeNull();
  });

  it("reads silence as 0, half the peak as half, and anything at full scale as at most 1", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const meter = openLevelReader(streamWithOneAudioTrack());
    expect(meter).not.toBeNull();
    expect(meter!.read()).toBe(0);
    // 64 away from the middle of the range is half of the largest swing, in either direction.
    FakeAudioContext.samples = new Uint8Array(512).fill(128);
    FakeAudioContext.samples[10] = 128 + 64;
    expect(meter!.read()).toBe(0.5);
    FakeAudioContext.samples[20] = 128 - 64;
    expect(meter!.read()).toBe(0.5);
    // The lowest possible sample swings 128 below the middle: the top of the scale, never above.
    FakeAudioContext.samples[30] = 0;
    expect(meter!.read()).toBe(1);
  });

  it("is only listened to, never heard: the sound goes through a gain of zero", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    openLevelReader(streamWithOneAudioTrack());
    const [context] = FakeAudioContext.made;
    expect(context.mutedGain.value).toBe(0);
    expect(context.connected).toEqual([
      "source->analyser",
      "analyser->gain",
      "gain->destination",
    ]);
  });

  it("lets go of the engine when closed, and a refusal to suspend or to close is not an error", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const meter = openLevelReader(streamWithOneAudioTrack());
    const [context] = FakeAudioContext.made;
    expect(() => meter!.close()).not.toThrow();
    expect(context.closed).toBe(1);
    // The rejected promises of resume() and close() are caught inside the meter: let them settle
    // and fail the case if one escaped as an unhandled rejection.
    const unhandled: unknown[] = [];
    const record = (event: PromiseRejectionEvent) =>
      unhandled.push(event.reason);
    window.addEventListener("unhandledrejection", record);
    await new Promise((resolve) => setTimeout(resolve, 20));
    window.removeEventListener("unhandledrejection", record);
    expect(unhandled).toEqual([]);
  });
});
