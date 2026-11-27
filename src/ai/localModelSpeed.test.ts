import { describe, expect, it, vi } from "vitest";
import { nativeLocalModel, notInstalledModel } from "./localModel";

// What the page does with the speed the native side measured (#305), and the placeholder model's
// stop. FAKE values only.

const bridge = (extra: Record<string, unknown> = {}) =>
  ({
    aiModelStatus: vi.fn(),
    aiSummarize: vi.fn(),
    aiExplain: vi.fn(),
    aiCancel: vi.fn().mockResolvedValue(undefined),
    ...extra,
  }) as unknown as Parameters<typeof nativeLocalModel>[0];

describe("the speed of the model on this computer", () => {
  it("is not offered when the native side cannot measure it", () => {
    expect(nativeLocalModel(bridge()).speed).toBeUndefined();
  });

  it("gives a measured rate that is in range, and nothing for one that is not or is not a rate", async () => {
    const answers: [unknown, unknown][] = [
      [
        { promptMilliTps: 40_000, answerMilliTps: 8_000 },
        { promptMilliTps: 40_000, answerMilliTps: 8_000 },
      ],
      // Below the least a measurement can mean, above the most, not a number, missing, not an object.
      [{ promptMilliTps: 9, answerMilliTps: 8_000 }, null],
      [{ promptMilliTps: 40_000, answerMilliTps: 5_000_001 }, null],
      [{ promptMilliTps: "fast", answerMilliTps: 8_000 }, null],
      [{ promptMilliTps: 40_000 }, null],
      [{ promptMilliTps: Number.NaN, answerMilliTps: 8_000 }, null],
      ["fast", null],
      [null, null],
    ];
    for (const [measured, expected] of answers) {
      const model = nativeLocalModel(
        bridge({ aiModelSpeed: vi.fn().mockResolvedValue(measured) }),
      );
      await expect(model.speed!()).resolves.toEqual(expected);
    }
  });

  it("says 'not measured' when asking fails, instead of failing the screen", async () => {
    const model = nativeLocalModel(
      bridge({
        aiModelSpeed: vi.fn().mockRejectedValue(new Error("FAKE no check yet")),
      }),
    );
    await expect(model.speed!()).resolves.toBeNull();
  });
});

describe("the model the app has until one is installed", () => {
  it("has nothing to stop, and stopping it changes nothing and throws nothing", () => {
    expect(notInstalledModel.cancel()).toBeUndefined();
  });
});
