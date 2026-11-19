import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { createVaultBridge } from "./vault";

// The summary's progress is for show (#72): a listener that cannot be
// attached must never fail the summary. FAKE data only.

const pages = [{ index: 0, text: "FAKE text." }];
const summary = {
  sentences: [],
  model: { name: "FAKE", sha256: "ab".repeat(32) },
};

describe("the summary's progress listener", () => {
  const unhandled = vi.fn();
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
    unhandled.mockReset();
    window.addEventListener("unhandledrejection", unhandled);
  });
  afterEach(() => {
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("still gives the summary, with no progress, when listening is refused", async () => {
    listen.mockRejectedValue(new Error("FAKE: not allowed"));
    invoke.mockResolvedValue(summary);
    const onProgress = vi.fn();
    const result = await createVaultBridge().aiSummarize(
      pages,
      "en",
      undefined,
      "FAKE-answer",
      onProgress,
    );
    expect(result).toEqual(summary);
    expect(invoke).toHaveBeenCalledWith("ai_summarize", expect.anything());
    expect(onProgress).not.toHaveBeenCalled();
    // Let any stray rejection surface before looking.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("still gives the summary when listen throws at once", async () => {
    listen.mockImplementation(() => {
      throw new Error("FAKE: no events");
    });
    invoke.mockResolvedValue(summary);
    await expect(
      createVaultBridge().aiSummarize(
        pages,
        "en",
        undefined,
        "FAKE-answer",
        vi.fn(),
      ),
    ).resolves.toEqual(summary);
  });

  it("passes only this answer's events on and stops listening when the summary ends", async () => {
    const unlisten = vi.fn();
    let deliver: (event: { payload: unknown }) => void = () => undefined;
    listen.mockImplementation(async (_name, handler) => {
      deliver = handler;
      return unlisten;
    });
    invoke.mockImplementation(async () => {
      deliver({
        payload: { answerId: "OTHER", stage: "reading", done: 1, total: 2 },
      });
      deliver({
        payload: {
          answerId: "FAKE-answer",
          stage: "reading",
          done: 2,
          total: 2,
        },
      });
      return summary;
    });
    const onProgress = vi.fn();
    await createVaultBridge().aiSummarize(
      pages,
      "en",
      undefined,
      "FAKE-answer",
      onProgress,
    );
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls[0][0]).toMatchObject({
      answerId: "FAKE-answer",
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("stops listening when the summary fails, and does not listen without a listener", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    invoke.mockRejectedValue(new Error("FAKE: failed"));
    await expect(
      createVaultBridge().aiSummarize(
        pages,
        "en",
        undefined,
        "FAKE-answer",
        vi.fn(),
      ),
    ).rejects.toThrow("FAKE: failed");
    expect(unlisten).toHaveBeenCalledTimes(1);
    listen.mockClear();
    invoke.mockResolvedValue(summary);
    await createVaultBridge().aiSummarize(
      pages,
      "en",
      undefined,
      "FAKE-answer",
    );
    expect(listen).not.toHaveBeenCalled();
  });
});
