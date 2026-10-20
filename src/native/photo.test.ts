import { describe, expect, it } from "vitest";
import {
  MAX_CAMERA_JPEG_BYTES,
  MAX_PHOTO_SIDE_PX,
  PHOTO_QUALITY,
  cameraFailure,
  cameraFailureMessage,
  namedAsPdf,
  photoName,
  encodePhoto,
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

describe("a camera photo's weight", () => {
  /** A photo-sized canvas: one colour, or a fixed noise that JPEG cannot
   * squeeze, so that its weight is the same on every run. */
  const canvasOf = (width: number, height: number, noisy: boolean) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    if (noisy) {
      const image = context.createImageData(width, height);
      let seed = 1;
      for (let index = 0; index < image.data.length; index += 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        image.data[index] = index % 4 === 3 ? 255 : seed >> 16;
      }
      context.putImageData(image, 0, 0);
    } else {
      context.fillStyle = "#3a7";
      context.fillRect(0, 0, width, height);
    }
    return canvas;
  };
  const jpeg = (canvas: HTMLCanvasElement, quality: number) =>
    new Promise<Blob>((resolve) =>
      canvas.toBlob((blob) => resolve(blob!), "image/jpeg", quality),
    );
  const sizeOf = async (blob: Blob) => {
    const bitmap = await createImageBitmap(blob);
    const size = [bitmap.width, bitmap.height];
    bitmap.close();
    return size;
  };

  it("keeps a camera photo under 4 MB", () => {
    expect(MAX_CAMERA_JPEG_BYTES).toBe(4 * 1024 * 1024);
  });

  it("leaves a photo that fits as it was taken", async () => {
    const canvas = canvasOf(640, 480, false);
    const photo = (await encodePhoto(canvas))!;
    expect(photo.size).toBe((await jpeg(canvas, PHOTO_QUALITY)).size);
    expect(await sizeOf(photo)).toEqual([640, 480]);
  });

  it("lowers the quality first, then the size, until a photo fits", async () => {
    const canvas = canvasOf(2048, 1536, true);
    const best = await jpeg(canvas, PHOTO_QUALITY);
    const lowest = await jpeg(canvas, 0.6);
    expect(lowest.size).toBeLessThan(best.size);
    // Between the two: a lower quality is enough, at the full size.
    const between = Math.floor((best.size + lowest.size) / 2);
    const lower = (await encodePhoto(canvas, between))!;
    expect(lower.size).toBeLessThanOrEqual(between);
    expect(await sizeOf(lower)).toEqual([2048, 1536]);
    // Under even the lowest quality: it is made smaller, in proportion.
    const half = Math.floor(lowest.size / 2);
    const smaller = (await encodePhoto(canvas, half))!;
    expect(smaller.size).toBeLessThanOrEqual(half);
    const [width, height] = await sizeOf(smaller);
    expect(width).toBeLessThan(2048);
    expect(width / height).toBeCloseTo(4 / 3, 2);
    // The photo taken is not changed.
    expect([canvas.width, canvas.height]).toEqual([2048, 1536]);
  }, 60_000);

  it("gives up rather than shrink a photo below 1024 pixels", async () => {
    expect(await encodePhoto(canvasOf(1200, 900, true), 100)).toBeNull();
  }, 60_000);
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
});
