/** The microphone test of the video recorder: a short clip from the microphone the preview already
 * has open (so it is the one chosen in the list, with the permission already given), played back
 * once, so the patient hears what the microphone picks up.
 *
 * MEMORY ONLY. The clip is pieces in an array and, while it plays, a `blob:` address. Nothing is
 * written to the vault or the disk, nothing is sent, nothing goes to a log or the history, and
 * everything is dropped (the pieces emptied, the player unloaded, the address revoked) when the
 * playback ends, when the patient stops it, on an error, and when the dialog closes or a real
 * recording begins (the caller stops the test then). It never stops a track of the stream: the
 * preview and a later recording keep them. */

/** About three seconds of sound is enough to hear the microphone and short enough to repeat. */
export const MICROPHONE_TEST_MS = 3000;

/**
 * The clip is encoded at a high bitrate, so that what comes back is the microphone and not the
 * encoder: 192 kbps Opus (Opus always runs at 48 kHz) is transparent for a voice, far above the
 * 32 to 64 kbps a speech clip needs. A recorder's default, or the 96 kbps AAC of the real
 * recording, would hide or add to what the patient is trying to judge. The sample rate is the
 * capture's (`CAPTURE_SAMPLE_RATE` in mediaDevices.ts asks the microphone for 48 kHz), not an
 * option of the recorder.
 */
export const MICROPHONE_TEST_BITS_PER_SECOND = 192_000;

export type MicrophoneTestPhase = "recording" | "playing";

export interface MicrophoneTest {
  /** Ends the test now, wherever it is, and drops the clip. Safe to call again. */
  stop: () => void;
  /** The rate the microphone really captures at, in hertz, as its track reports it (a headset in
   * call mode, for one, gives 16 000 or 8 000), or `undefined` when the track does not say. */
  captureRate: number | undefined;
}

/** The first type this device records for sound only; none named lets the device choose. */
function soundOnlyType(): string | undefined {
  const supported = (type: string) =>
    typeof MediaRecorder.isTypeSupported === "function" &&
    MediaRecorder.isTypeSupported(type);
  return ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find(
    supported,
  );
}

/**
 * Starts the test on the microphone track(s) of `stream`. `phase` is told "recording" and then
 * "playing"; `done` is told once, with whether it went well, when it is over for any reason (the
 * patient's stop counts as well). Returns `null`, having started nothing, when the device cannot
 * record sound or the stream has no live microphone.
 */
export function startMicrophoneTest(
  stream: MediaStream,
  on: {
    phase: (phase: MicrophoneTestPhase) => void;
    done: (ok: boolean) => void;
  },
): MicrophoneTest | null {
  if (typeof MediaRecorder === "undefined") return null;
  const tracks = stream
    .getAudioTracks()
    .filter((track) => track.readyState === "live");
  if (tracks.length === 0) return null;

  const pieces: Blob[] = [];
  let recorder: MediaRecorder;
  try {
    const mimeType = soundOnlyType();
    // A stream of the sound tracks only: the clip has no picture, and stopping the recorder does
    // not stop the tracks it was given.
    recorder = new MediaRecorder(new MediaStream(tracks), {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: MICROPHONE_TEST_BITS_PER_SECOND,
    });
  } catch {
    return null;
  }
  let finished = false;
  let timer: number | undefined;
  let player: HTMLAudioElement | null = null;
  let address: string | null = null;

  const drop = () => {
    window.clearTimeout(timer);
    pieces.length = 0;
    if (player) {
      player.onended = null;
      player.onerror = null;
      player.pause();
      player.removeAttribute("src");
      player.load();
      player = null;
    }
    if (address) {
      URL.revokeObjectURL(address);
      address = null;
    }
  };
  const finish = (ok: boolean) => {
    if (finished) return;
    finished = true;
    drop();
    if (recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Already stopped: nothing is left to end.
      }
    }
    on.done(ok);
  };

  recorder.addEventListener("dataavailable", (event) => {
    // A piece that arrives after the test ended is dropped, not kept.
    const data = (event as BlobEvent).data;
    if (!finished && data && data.size > 0) pieces.push(data);
  });
  recorder.addEventListener("error", () => finish(false));
  recorder.addEventListener("stop", () => {
    window.clearTimeout(timer);
    if (finished) return;
    if (pieces.length === 0) {
      finish(false);
      return;
    }
    address = URL.createObjectURL(
      new Blob(pieces, { type: recorder.mimeType || "audio/webm" }),
    );
    // The pieces are not needed once the clip is one address.
    pieces.length = 0;
    // Played as it was recorded, through a plain audio element: full volume, not muted, nothing
    // between the clip and the speaker (the level meter taps the live microphone only while the
    // clip is being taken, and is off by now). A mono clip is played from both sides by the
    // browser's own up-mixing.
    player = new Audio(address);
    player.volume = 1;
    player.muted = false;
    player.onended = () => finish(true);
    player.onerror = () => finish(false);
    on.phase("playing");
    // A refusal to play (a web view that wants a touch first) ends the test as a failure. This
    // play() comes about three seconds after the click: desktop Chromium and WebView2 allow it
    // (sticky user activation), but Android's WebView and iOS's WKWebView may refuse, and the
    // test then says it did not work on that device. Check it on the Android build; the usual
    // remedy is to start the player inside the click on a silent source and give it the clip later.
    void player.play().catch(() => finish(false));
  });

  try {
    recorder.start();
  } catch {
    drop();
    return null;
  }
  on.phase("recording");
  timer = window.setTimeout(() => {
    if (recorder.state === "recording") recorder.stop();
  }, MICROPHONE_TEST_MS);
  const rate = tracks[0].getSettings?.().sampleRate;
  return { stop: () => finish(true), captureRate: rate };
}
