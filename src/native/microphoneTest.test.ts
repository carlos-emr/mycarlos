import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MICROPHONE_TEST_BITS_PER_SECOND,
  MICROPHONE_TEST_MS,
  startMicrophoneTest,
} from "./microphoneTest";

// FAKE media: a recorder that records nothing but says what it was given, a player that plays
// nothing, and an address maker that can be asked what it made and what was revoked.
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
class FakePlayer {
  static made: FakePlayer[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  played = 0;
  paused = 0;
  loaded = 0;
  removed: string[] = [];
  // Not the element's own defaults (1 and false): the test proves the code sets them.
  volume = 0.3;
  muted = true;
  static refuse = false;
  constructor(readonly src: string) {
    FakePlayer.made.push(this);
  }
  play() {
    this.played += 1;
    return FakePlayer.refuse
      ? Promise.reject(new Error("FAKE: not allowed to play"))
      : Promise.resolve();
  }
  pause() {
    this.paused += 1;
  }
  load() {
    this.loaded += 1;
  }
  removeAttribute(name: string) {
    this.removed.push(name);
  }
}

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

let created: string[];
let revoked: string[];
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
  FakePlayer.made = [];
  FakePlayer.refuse = false;
  created = [];
  revoked = [];
  events = { phases: [], done: [] };
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("MediaStream", FakeStream);
  vi.stubGlobal("Audio", FakePlayer);
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    const address = `blob:fake/${created.length + 1}`;
    created.push(address);
    return address;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((address) => {
    revoked.push(address);
  });
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
    // Playing back: one address, one player, one play.
    expect(events.phases).toEqual(["recording", "playing"]);
    expect(created).toEqual(["blob:fake/1"]);
    expect(FakePlayer.made).toHaveLength(1);
    expect(FakePlayer.made[0].src).toBe("blob:fake/1");
    expect(FakePlayer.made[0].played).toBe(1);
    expect(revoked).toEqual([]);
    // When it ends the address is revoked and the player let go; the test says it went well.
    FakePlayer.made[0].onended!();
    expect(revoked).toEqual(["blob:fake/1"]);
    expect(FakePlayer.made[0].removed).toEqual(["src"]);
    expect(FakePlayer.made[0].loaded).toBe(1);
    expect(events.done).toEqual([true]);
    // The preview's tracks are the preview's: the test never stops one.
    for (const each of audio) expect(each.stop).not.toHaveBeenCalled();
    // Told twice, nothing more happens.
    test!.stop();
    expect(events.done).toEqual([true]);
    expect(revoked).toEqual(["blob:fake/1"]);
  });

  it("records at a high quality and plays the clip back as it is, at full volume", () => {
    const { test, recorder } = begin();
    // The recorder is asked for Opus at 128 kbps or more (Opus runs at 48 kHz), never the
    // recorder's default or the real recording's 96 kbps AAC.
    expect(recorder.options?.mimeType).toMatch(/^audio\/.*opus/);
    expect(recorder.options?.audioBitsPerSecond).toBeGreaterThanOrEqual(
      128_000,
    );
    expect(MICROPHONE_TEST_BITS_PER_SECOND).toBeGreaterThanOrEqual(128_000);
    // The capture rate the track reports is handed on (48 kHz here).
    expect(test!.captureRate).toBe(48_000);
    recorder.give("heard");
    vi.advanceTimersByTime(MICROPHONE_TEST_MS);
    // Played through a plain audio element, at full volume and not muted: nothing else is in the
    // path (the level meter is not, and is off by then).
    const player = FakePlayer.made[0];
    expect(player.volume).toBe(1);
    expect(player.muted).toBe(false);
    test!.stop();
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
    expect(created).toEqual([]);
    expect(FakePlayer.made).toEqual([]);
    expect(events.phases).toEqual(["recording"]);
  });

  it("stops on request while playing: the player is let go and the address revoked at once", () => {
    const { test, recorder } = begin();
    recorder.give("heard");
    vi.advanceTimersByTime(MICROPHONE_TEST_MS);
    const player = FakePlayer.made[0];
    test!.stop();
    expect(player.paused).toBeGreaterThan(0);
    expect(player.removed).toEqual(["src"]);
    expect(revoked).toEqual(["blob:fake/1"]);
    expect(events.done).toEqual([true]);
    // A player that fires after the stop changes nothing.
    player.onended?.();
    expect(events.done).toEqual([true]);
    expect(revoked).toEqual(["blob:fake/1"]);
  });

  it("is a failure, with nothing kept, when the player will not play", async () => {
    FakePlayer.refuse = true;
    const { recorder } = begin();
    recorder.give("heard");
    vi.advanceTimersByTime(MICROPHONE_TEST_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.done).toEqual([false]);
    expect(revoked).toEqual(["blob:fake/1"]);
    expect(FakePlayer.made[0].removed).toEqual(["src"]);
  });

  it("is a failure when the player fails or the recorder fails or hears nothing", () => {
    const first = begin();
    first.recorder.give("heard");
    vi.advanceTimersByTime(MICROPHONE_TEST_MS);
    FakePlayer.made[0].onerror!();
    expect(events.done).toEqual([false]);
    expect(revoked).toEqual(["blob:fake/1"]);

    const second = begin();
    second.recorder.dispatchEvent(new Event("error"));
    expect(events.done).toEqual([false, false]);
    expect(second.recorder.state).toBe("inactive");

    // Nothing was picked up: no clip, no address, no player.
    const third = begin();
    vi.advanceTimersByTime(MICROPHONE_TEST_MS);
    expect(events.done).toEqual([false, false, false]);
    expect(created).toEqual(["blob:fake/1"]);
    expect(third.recorder.state).toBe("inactive");
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

  it("lets the device choose the type when it names none, and keeps it all in memory", () => {
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
    FakePlayer.made[0].onended!();
    // Not stored, not sent, not logged.
    expect(store).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});
