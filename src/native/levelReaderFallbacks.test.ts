import { afterEach, describe, expect, it, vi } from "vitest";
import { openLevelReader } from "./mediaDevices";

// The microphone level meter, with a FAKE audio engine: what it measures, what it will not do,
// and that a webview that fails halfway leaves no meter and no error.

/** A node of the fake engine. `connect` records "from->to" from the REAL argument it is given, so
 * a wire to the wrong node shows as a different line, not as the same line with another target. */
class FakeNode {
  constructor(
    readonly id: string,
    private readonly wires: string[],
  ) {}
  connect(target: FakeNode) {
    this.wires.push(`${this.id}->${target.id}`);
  }
}

class FakeAudioContext {
  static samples = new Uint8Array(512).fill(128);
  static resumeRejects = true;
  static closeRejects = true;
  static failToStart = false;
  static made: FakeAudioContext[] = [];
  wires: string[] = [];
  destination = new FakeNode("speakers", this.wires);
  mutedGain = { value: 1 };
  closed = 0;
  constructor() {
    if (FakeAudioContext.failToStart) throw new Error("FAKE: no audio engine");
    FakeAudioContext.made.push(this);
  }
  createAnalyser() {
    const node = new FakeNode("analyser", this.wires);
    return Object.assign(node, {
      fftSize: 0,
      getByteTimeDomainData(into: Uint8Array) {
        into.set(FakeAudioContext.samples.subarray(0, into.length));
      },
    });
  }
  createGain() {
    return Object.assign(new FakeNode("gain", this.wires), {
      gain: this.mutedGain,
    });
  }
  createMediaStreamSource() {
    return new FakeNode("source", this.wires);
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

/** Two turns of the event loop: enough for a rejection nobody handled to be reported. */
const twoMacrotasks = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

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

  it("is only listened to, never heard: the sound reaches the speakers only through a gain of zero", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    openLevelReader(streamWithOneAudioTrack());
    const [context] = FakeAudioContext.made;
    expect(context.mutedGain.value).toBe(0);
    // Each wire is named from the node it really goes to: a microphone wired straight to the
    // speakers would show as "analyser->speakers" or "source->speakers", and fail here.
    expect(context.wires).toEqual([
      "source->analyser",
      "analyser->gain",
      "gain->speakers",
    ]);
  });

  it("lets go of the engine when closed, and a refusal to suspend or to close is not an error", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    // The rejected promises of resume() and close() are caught inside the meter. The listener is
    // on before they are made; a rejection nobody handled would be reported by the time two
    // turns of the event loop have passed.
    const unhandled: unknown[] = [];
    const record = (event: PromiseRejectionEvent) =>
      unhandled.push(event.reason);
    window.addEventListener("unhandledrejection", record);
    try {
      const meter = openLevelReader(streamWithOneAudioTrack());
      const [context] = FakeAudioContext.made;
      expect(() => meter!.close()).not.toThrow();
      expect(context.closed).toBe(1);
      await twoMacrotasks();
    } finally {
      window.removeEventListener("unhandledrejection", record);
    }
    expect(unhandled).toEqual([]);
  });
});
