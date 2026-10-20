import { describe, expect, it } from "vitest";
import {
  CAMERA_PLATFORMS,
  MAX_PHOTO_SIDE_PX,
  cameraFailure,
  cameraFailureMessage,
  isPhone,
  namedAsPdf,
  photoName,
  photoSize,
} from "./photo";

describe("photo names", () => {
  it.each([
    [new Date(2026, 9, 17, 15, 5), "Photo, 17 Oct 2026, 3.05 PM.jpg"],
    [new Date(2026, 0, 1, 0, 0), "Photo, 1 Jan 2026, 12.00 AM.jpg"],
    [new Date(2026, 11, 31, 12, 30), "Photo, 31 Dec 2026, 12.30 PM.jpg"],
    [new Date(2027, 4, 9, 9, 7), "Photo, 9 May 2027, 9.07 AM.jpg"],
    [new Date(2027, 4, 9, 23, 59), "Photo, 9 May 2027, 11.59 PM.jpg"],
  ])("names a photo taken at %s %j", (taken, name) => {
    expect(photoName(taken)).toBe(name);
  });

  it("uses no character the vault refuses in a document name", () => {
    for (let hour = 0; hour < 24; hour++) {
      const name = photoName(new Date(2026, 9, 17, hour, 5));
      expect(name).not.toMatch(/[<>:"|?*/\\]/);
      expect(name).toMatch(/^Photo, .+\.jpg$/);
    }
  });
});

describe("photo size", () => {
  it("keeps a camera frame's size up to the cap", () => {
    expect(photoSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(photoSize(MAX_PHOTO_SIDE_PX, 10)).toEqual({
      width: MAX_PHOTO_SIDE_PX,
      height: 10,
    });
  });

  it("scales a larger frame down so its long side is the cap", () => {
    expect(photoSize(8000, 6000)).toEqual({ width: 4096, height: 3072 });
    expect(photoSize(3000, 9000)).toEqual({ width: 1365, height: 4096 });
    expect(photoSize(20000, 1)).toEqual({ width: 4096, height: 1 });
  });
});

describe("which documents the photo view tries", () => {
  it.each([
    ["Results.pdf", true],
    ["Results.PDF", true],
    ["Results.pdf ", true],
    ["Photo, 17 Oct 2026, 3.05 PM.jpg", false],
    ["FAKE insurance card", false],
    ["Scan.pdf.jpg", false],
  ])("%j named as a PDF: %s", (name, pdf) => {
    expect(namedAsPdf(name)).toBe(pdf);
  });
});

describe("camera failures", () => {
  it.each([
    ["NotAllowedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "missing"],
    ["OverconstrainedError", "missing"],
    ["NotReadableError", "busy"],
    ["AbortError", "busy"],
    ["TypeError", "other"],
  ])("%s is %s", (name, failure) => {
    expect(cameraFailure(new DOMException("FAKE", name))).toBe(failure);
  });

  it("treats anything without a name as another failure", () => {
    expect(cameraFailure("FAKE")).toBe("other");
    expect(cameraFailure(null)).toBe("other");
  });

  it("says where to allow the camera on each computer", () => {
    expect(cameraFailureMessage("denied", "windows")).toBe(
      "myCarlos can't use the camera. In Windows Settings, open Privacy & security, then Camera, and turn on camera access for desktop apps. Then choose Try again.",
    );
    expect(cameraFailureMessage("denied", "macos")).toBe(
      "myCarlos can't use the camera. In System Settings, open Privacy & Security, then Camera, and turn on myCarlos. Then choose Try again.",
    );
    expect(cameraFailureMessage("denied", "linux")).toBe(
      "myCarlos can't use the camera. Check your computer's camera privacy settings and let myCarlos use the camera. Then choose Try again.",
    );
    expect(cameraFailureMessage("missing", "windows")).toBe(
      "No camera was found. Connect a camera, then choose Try again.",
    );
    expect(cameraFailureMessage("busy", "windows")).toBe(
      "The camera is in use by another app. Close it, then choose Try again.",
    );
  });

  it("says where to allow the camera on each phone, and asks no one to connect one (D97)", () => {
    expect(cameraFailureMessage("denied", "android")).toBe(
      "myCarlos can't use the camera. Open your phone's Settings, then Apps, then myCarlos, then Permissions, and allow Camera. Then choose Try again.",
    );
    expect(cameraFailureMessage("denied", "ios")).toBe(
      "myCarlos can't use the camera. Open your phone's Settings, then myCarlos, and turn on Camera. Then choose Try again.",
    );
    for (const phone of ["android", "ios"]) {
      expect(cameraFailureMessage("missing", phone)).toBe(
        "This phone's camera could not be found. Choose Try again.",
      );
      expect(cameraFailureMessage("stopped", phone)).toBe(
        "The camera stopped. Choose Try again.",
      );
      expect(cameraFailureMessage("busy", phone)).toBe(
        "The camera is in use by another app. Close it, then choose Try again.",
      );
    }
    // A computer's stays as it was.
    expect(cameraFailureMessage("stopped", "linux")).toBe(
      "The camera stopped. Check that it is connected, then choose Try again.",
    );
  });
});

describe("where the camera is offered (D97)", () => {
  it("is offered on the computers and the phones", () => {
    for (const platform of ["windows", "macos", "linux", "android", "ios"])
      expect(CAMERA_PLATFORMS.has(platform), platform).toBe(true);
    expect(CAMERA_PLATFORMS.has("freebsd")).toBe(false);
    expect(CAMERA_PLATFORMS.has("")).toBe(false);
  });

  it("knows a phone from a computer", () => {
    expect(isPhone("android")).toBe(true);
    expect(isPhone("ios")).toBe(true);
    for (const computer of ["windows", "macos", "linux", ""])
      expect(isPhone(computer), computer).toBe(false);
  });
});
