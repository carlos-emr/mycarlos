import { afterEach, describe, expect, it } from "vitest";
import { setLocaleOverride } from "../i18n";
import {
  MP4_TYPES,
  QUALITIES,
  RecordedClock,
  STOP_RESERVE_BYTES,
  isNoSpace,
  minutesLeft,
  deliveredHeight,
  formatClock,
  highQualityAvailable,
  namedAsVideo,
  pickMp4Type,
  readVideoQuality,
  rememberVideoQuality,
  videoConstraints,
  videoName,
} from "./video";

afterEach(() => {
  window.localStorage.removeItem("mycarlos.videoQuality.v1");
  setLocaleOverride("en");
});

describe("which MP4 the webview records", () => {
  it("takes the first type it accepts, in the order that prefers baseline H.264", () => {
    const accepted = new Set<string>([MP4_TYPES[2], MP4_TYPES[4]]);
    expect(pickMp4Type({ isTypeSupported: (t) => accepted.has(t) })).toBe(
      MP4_TYPES[2],
    );
    expect(pickMp4Type({ isTypeSupported: () => true })).toBe(MP4_TYPES[0]);
    expect(pickMp4Type({ isTypeSupported: (t) => t === "video/mp4" })).toBe(
      "video/mp4",
    );
  });

  it("records nothing but MP4: a webview that only records WebM has no Record", () => {
    expect(
      pickMp4Type({ isTypeSupported: (t) => t.startsWith("video/webm") }),
    ).toBeNull();
    expect(pickMp4Type({ isTypeSupported: () => false })).toBeNull();
    expect(pickMp4Type(undefined)).not.toBe("video/webm");
    expect(MP4_TYPES.every((t) => t.startsWith("video/mp4"))).toBe(true);
  });

  it("treats a recorder that throws for a type as not recording it", () => {
    expect(
      pickMp4Type({
        isTypeSupported: (t) => {
          if (t !== "video/mp4") throw new Error("FAKE unsupported");
          return true;
        },
      }),
    ).toBe("video/mp4");
  });
});

describe("the quality choice", () => {
  it("offers High only where the camera reports 1920 by 1080 or more", () => {
    const camera = (width?: number, height?: number) => ({
      getCapabilities: () => ({
        ...(width === undefined ? {} : { width: { max: width } }),
        ...(height === undefined ? {} : { height: { max: height } }),
      }),
    });
    expect(highQualityAvailable(camera(1920, 1080))).toBe(true);
    expect(highQualityAvailable(camera(3840, 2160))).toBe(true);
    expect(highQualityAvailable(camera(1280, 720))).toBe(false);
    expect(highQualityAvailable(camera(1920, 720))).toBe(false);
    expect(highQualityAvailable(camera(1280, 1080))).toBe(false);
    expect(highQualityAvailable(camera())).toBe(false);
    expect(highQualityAvailable({})).toBe(false);
    expect(highQualityAvailable(undefined)).toBe(false);
    expect(
      highQualityAvailable({
        getCapabilities: () => {
          throw new Error("FAKE");
        },
      }),
    ).toBe(false);
  });

  it("is Standard 720p until High is chosen, remembered on the device only", () => {
    expect(readVideoQuality()).toBe("standard");
    rememberVideoQuality("high");
    expect(readVideoQuality()).toBe("high");
    window.localStorage.setItem("mycarlos.videoQuality.v1", "4k");
    expect(readVideoQuality()).toBe("standard");
    expect(QUALITIES.standard.height).toBe(720);
    expect(QUALITIES.high.height).toBe(1080);
    // No 4K, and a target bitrate for each.
    expect(Object.keys(QUALITIES)).toEqual(["standard", "high"]);
    expect(QUALITIES.high.videoBitsPerSecond).toBeGreaterThan(
      QUALITIES.standard.videoBitsPerSecond,
    );
  });

  it("asks for the back camera on a phone and for no particular one on a computer", () => {
    expect(videoConstraints("standard", true).facingMode).toBe("environment");
    expect(videoConstraints("standard", false).facingMode).toBeUndefined();
    expect(videoConstraints("high", false)).toMatchObject({
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    });
  });

  it("reads back the picture the webview actually delivered", () => {
    expect(deliveredHeight({ getSettings: () => ({ height: 719.6 }) })).toBe(
      720,
    );
    expect(deliveredHeight({ getSettings: () => ({}) })).toBeNull();
    expect(deliveredHeight({ getSettings: () => ({ height: 0 }) })).toBeNull();
    expect(deliveredHeight(undefined)).toBeNull();
  });
});

describe("the room left", () => {
  const MIB = 1024 * 1024;
  it("is told in minutes from how fast this recording fills the disk, less the reserve", () => {
    // 1 MiB a second for a minute: 60 MiB stored. 256 MiB is kept back.
    expect(minutesLeft(256 * MIB + 600 * MIB, 60 * MIB, 60_000)).toBe(10);
    expect(minutesLeft(256 * MIB + 59 * MIB, 60 * MIB, 60_000)).toBe(0);
    expect(minutesLeft(100 * MIB, 60 * MIB, 60_000)).toBe(0);
    expect(STOP_RESERVE_BYTES).toBe(256 * MIB);
  });

  it("says nothing until enough has been recorded to say, or when the room is not known", () => {
    expect(minutesLeft(null, 60 * MIB, 60_000)).toBeNull();
    expect(minutesLeft(10 ** 12, 60 * MIB, 4_999)).toBeNull();
    expect(minutesLeft(10 ** 12, 0, 60_000)).toBeNull();
  });

  it("knows a refusal for want of room by its code", () => {
    expect(isNoSpace({ code: "no_space", message: "x" })).toBe(true);
    expect(isNoSpace({ code: "storage" })).toBe(false);
    expect(isNoSpace(null)).toBe(false);
    expect(isNoSpace("no_space")).toBe(false);
  });
});

describe("the recorded time", () => {
  it("counts only while it runs, so pauses are left out", () => {
    let now = 1000;
    const clock = new RecordedClock(() => now);
    expect(clock.elapsed()).toBe(0);
    clock.start();
    now += 12_000;
    expect(clock.elapsed()).toBe(12_000);
    clock.stop(); // paused
    now += 600_000; // ten minutes of pause
    expect(clock.elapsed()).toBe(12_000);
    clock.start(); // resumed
    now += 3_000;
    expect(clock.elapsed()).toBe(15_000);
    clock.stop();
    clock.stop(); // stopping twice changes nothing
    now += 5_000;
    expect(clock.elapsed()).toBe(15_000);
    expect(clock.running).toBe(false);
    clock.start();
    clock.start(); // starting twice changes nothing
    now += 1_000;
    expect(clock.elapsed()).toBe(16_000);
  });

  it("never goes backwards if the clock does", () => {
    let now = 5_000;
    const clock = new RecordedClock(() => now);
    clock.start();
    now = 4_000;
    expect(clock.elapsed()).toBe(0);
  });

  it("is shown as digits, m:ss and then h:mm:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(999)).toBe("0:00");
    expect(formatClock(1_000)).toBe("0:01");
    expect(formatClock(12 * 60_000 + 3_000)).toBe("12:03");
    expect(formatClock(59 * 60_000 + 59_999)).toBe("59:59");
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(3_600_000 + 61_000)).toBe("1:01:01");
    expect(formatClock(-5)).toBe("0:00");
  });
});

describe("a video's name", () => {
  it("is made once, in the language of the moment, as an .mp4 with no colons", () => {
    setLocaleOverride("en");
    const name = videoName(new Date(2026, 10, 20, 15, 5));
    expect(name).toMatch(/^Video, .*2026.*, 3\.05 PM\.mp4$/);
    expect(name).not.toContain(":");
    setLocaleOverride("es");
    expect(videoName(new Date(2026, 10, 20, 15, 5))).toMatch(
      /^Video, .*2026.*\.mp4$/,
    );
    setLocaleOverride("fr");
    expect(videoName(new Date(2026, 10, 20, 15, 5))).toMatch(/^Vidéo, /);
  });

  it("is recognised by its extension, whatever the case", () => {
    expect(namedAsVideo("Video, 20 Nov 2026, 3.05 PM.mp4")).toBe(true);
    expect(namedAsVideo(" clip.MP4 ")).toBe(true);
    expect(namedAsVideo("note.pdf")).toBe(false);
    expect(namedAsVideo("mp4")).toBe(false);
  });
});
