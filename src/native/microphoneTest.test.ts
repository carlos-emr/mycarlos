import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MICROPHONE_TEST_BITS_PER_SECOND,
  MICROPHONE_TEST_MS,
  startMicrophoneTest,
} from "./microphoneTest";

class FakeRecorder extends EventTarget {
  static made: FakeRecorder[] = [];
  static isTypeSupported(type: string): boolean {
    return type === "audio/webm;codecs=opus";
  }
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm;codecs=opus";
  stops = 0;
  constructor(
    readonly stream: { tracks: unknown[] },
    readonly options?: { mimeType?: string; audioBitsPerSecond?: number },
  ) {
    super();
    FakeRecorder.made.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.stops += 1;
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }
  give(text: string) {
    this.dispatchEvent(
      Object.assign(new Event("dataavailable"), { data: new Blob([text]) }),
    );
  }
}
class FakeStream {
  constructor(readonly tracks: unknown[]) {}
}
const decoded = {} as AudioBuffer;
const playback = {
  buffer: null as AudioBuffer | null,
  onended: null as (() => void) | null,
  connect: vi.fn(),
  disconnect: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};
class FakeContext {
  destination = {};
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  decodeAudioData = vi.fn(async (_bytes: ArrayBuffer) => decoded);
  createBufferSource = vi.fn(() => playback);
  constructor() {
    context = this;
  }
}
let context: FakeContext;

const track = (
  readyState: "live" | "ended" = "live",
  sampleRate: number | null = 48_000,
) => ({
  kind: "audio",
  readyState,
  stop: vi.fn(),
  // null: a track that does not say its rate.
  getSettings: () => (sampleRate === null ? {} : { sampleRate }),
});
const videoTrack = () => ({ kind: "video", readyState: "live", stop: vi.fn() });
function streamOf(audio: ReturnType<typeof track>[]) {
  return {
    getAudioTracks: () => audio,
    getVideoTracks: () => [videoTrack()],
    getTracks: () => audio,
  } as unknown as MediaStream;
}

let events: { phases: string[]; done: boolean[] };
function begin(audio = [track()]) {
  const stream = streamOf(audio);
  const test = startMicrophoneTest(stream, {
    phase: (phase) => events.phases.push(phase),
    done: (ok) => events.done.push(ok),
  });
  return { test, audio, recorder: FakeRecorder.made.at(-1)! };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeRecorder.made = [];
  vi.clearAllMocks();
  playback.buffer = null;
  playback.onended = null;
  events = { phases: [], done: [] };
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("MediaStream", FakeStream);
  vi.stubGlobal("AudioContext", FakeContext);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the microphone test", () => {
  it("records about three seconds from the microphone track only, then plays it back once", async () => {
    const { test, audio, recorder } = begin();
    expect(test).not.toBeNull();
    // The clip is made from the stream's sound tracks, never its picture, in a sound-only type.
    expect(recorder.stream.tracks).toEqual(audio);
    expect(recorder.options).toEqual({
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 192_000,
    });
    expect(recorder.state).toBe("recording");
    expect(events.phases).toEqual(["recording"]);
    recorder.give("first");
    recorder.give("second");
    // Nothing ends it early, and it ends by itself at about three seconds.
    vi.advanceTimersByTime(MICROPHONE_TEST_MS - 1);
    expect(recorder.state).toBe("recording");
    vi.advanceTimersByTime(1);
    expect(recorder.state).toBe("inactive");
    await vi.waitFor(() => expect(playback.start).toHaveBeenCalledTimes(1));
    expect(events.phases).toEqual(["recording", "playing"]);
    expect(context.resume).toHaveBeenCalledTimes(1);
    const [[bytes]] = context.decodeAudioData.mock.calls;
    expect(new TextDecoder().decode(bytes)).toBe("firstsecond");
    expect(playback.buffer).toBe(decoded);
    expect(playback.connect).toHaveBeenCalledWith(context.destination);
    playback.onended!();
    expect(playback.buffer).toBeNull();
    expect(playback.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(events.done).toEqual([true]);
    // The preview's tracks are the preview's: the test never stops one.
    for (const each of audio) expect(each.stop).not.toHaveBeenCalled();
    // Told twice, nothing more happens.
    test!.stop();
    expect(events.done).toEqual([true]);
    expect(context.close).toHaveBeenCalledOnce();
    expect(test!.captureRate).toBe(48_000);
    expect(recorder.options?.audioBitsPerSecond).toBe(
      MICROPHONE_TEST_BITS_PER_SECOND,
    );
  });

  it("says nothing of a rate the track does not report, and reports a low one as it is", () => {
    expect(begin([track("live", null)]).test!.captureRate).toBeUndefined();
    expect(begin([track("live", 16_000)]).test!.captureRate).toBe(16_000);
  });

  it("stops on request while recording, makes no address and ignores a late piece", () => {
    const { test, recorder } = begin();
    recorder.give("heard");
    test!.stop();
    expect(recorder.state).toBe("inactive");
    expect(events.done).toEqual([true]);
    // A piece the recorder hands over after the stop is dropped, and nothing is played.
    recorder.give("late");
    vi.advanceTimersByTime(MICROPHONE_TEST_MS * 2);
    expect(context.createBufferSource).not.toHaveBeenCalled();
    expect(events.phases).toEqual(["recording"]);
  });

  it("stops and disconnects playback when cancelled, ignoring a late end", async () => {
    const { test, recorder } = begin();
    recorder.give("heard");
    recorder.stop();
    await vi.waitFor(() => expect(playback.start).toHaveBeenCalledOnce());
    const lateEnd = playback.onended!;
    test!.stop();
    expect(playback.stop).toHaveBeenCalledOnce();
    expect(playback.disconnect).toHaveBeenCalledOnce();
    expect(playback.buffer).toBeNull();
    expect(context.close).toHaveBeenCalledOnce();
    lateEnd();
    expect(events.done).toEqual([true]);
  });

  it("cannot play a late decode after cancellation", async () => {
    const { test, recorder } = begin();
    let release!: (value: AudioBuffer) => void;
    context.decodeAudioData.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    recorder.give("heard");
    recorder.stop();
    await vi.waitFor(() => expect(release).toBeDefined());
    test!.stop();
    release(decoded);
    await Promise.resolve();
    expect(events.phases).toEqual(["recording"]);
    expect(context.createBufferSource).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
    expect(events.done).toEqual([true]);
  });

  it("closes the output and reports a failure when decoding fails", async () => {
    const { recorder } = begin();
    context.decodeAudioData.mockRejectedValue(
      new Error("FAKE unsupported clip"),
    );
    recorder.give("heard");
    recorder.stop();
    await vi.waitFor(() => expect(events.done).toEqual([false]));
    expect(context.close).toHaveBeenCalledOnce();
    expect(playback.start).not.toHaveBeenCalled();
  });

  it("releases the decoded samples if the output cannot start", async () => {
    playback.start.mockImplementationOnce(() => {
      throw new Error("FAKE output refused");
    });
    const { recorder } = begin();
    recorder.give("heard");
    recorder.stop();
    await vi.waitFor(() => expect(events.done).toEqual([false]));
    expect(playback.buffer).toBeNull();
    expect(playback.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(events.phases).toEqual(["recording"]);
  });

  it("stops the recorder when the device refuses to resume audio", async () => {
    vi.stubGlobal(
      "AudioContext",
      class extends FakeContext {
        resume = vi.fn(async () => {
          throw new Error("FAKE resume refused");
        });
      },
    );
    const { recorder } = begin();
    await vi.waitFor(() => expect(events.done).toEqual([false]));
    expect(recorder.state).toBe("inactive");
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.createBufferSource).not.toHaveBeenCalled();
  });

  it("reports a recorder error or an empty clip and closes the output", () => {
    const first = begin();
    first.recorder.dispatchEvent(new Event("error"));
    expect(context.close).toHaveBeenCalledOnce();
    expect(first.recorder.state).toBe("inactive");
    const second = begin();
    vi.advanceTimersByTime(MICROPHONE_TEST_MS);
    expect(second.recorder.state).toBe("inactive");
    expect(events.done).toEqual([false, false]);
    expect(context.close).toHaveBeenCalledOnce();
    expect(playback.start).not.toHaveBeenCalled();
  });

  it("starts nothing when the device cannot record or has no live microphone", () => {
    expect(begin([track("ended")]).test).toBeNull();
    expect(begin([]).test).toBeNull();
    expect(FakeRecorder.made).toEqual([]);
    vi.stubGlobal("MediaRecorder", undefined);
    expect(
      startMicrophoneTest(streamOf([track()]), {
        phase: () => undefined,
        done: () => undefined,
      }),
    ).toBeNull();
    // A recorder that cannot be made, or started, leaves nothing behind.
    class Refusing extends FakeRecorder {
      constructor() {
        super({ tracks: [] });
        throw new Error("FAKE: cannot record this");
      }
    }
    vi.stubGlobal("MediaRecorder", Refusing);
    expect(begin().test).toBeNull();
    expect(events.phases).toEqual([]);
  });

  it("lets the device choose the type when it names none, and keeps it all in memory", async () => {
    vi.stubGlobal(
      "MediaRecorder",
      class extends FakeRecorder {
        static isTypeSupported = () => false;
      },
    );
    const store = vi.spyOn(Storage.prototype, "setItem");
    const send = vi.spyOn(window, "fetch").mockResolvedValue(new Response());
    const logs = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    const { recorder } = begin();
    // No type named: the device chooses, still at the full bitrate.
    expect(recorder.options).toEqual({ audioBitsPerSecond: 192_000 });
    recorder.give("heard");
    vi.advanceTimersByTime(MICROPHONE_TEST_MS);
    await vi.waitFor(() => expect(playback.start).toHaveBeenCalledOnce());
    playback.onended!();
    // Not stored, not sent, not logged.
    expect(store).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});
