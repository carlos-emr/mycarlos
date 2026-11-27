import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlatformBridge } from "./platform";

// The browser preview's bridge (the native app never uses it: its files are chosen by Rust-owned
// pickers, never through renderer file paths).

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the browser preview's platform bridge", () => {
  it("says it is the preview and not the native app", async () => {
    const info = await createPlatformBridge().getRuntimeInfo();
    expect(info.native).toBe(false);
    expect(info.platform).toBe("Browser preview");
  });

  /** Runs the preview's picker with the input it makes, and lets the test answer it. */
  function pick(answer: (input: HTMLInputElement) => void) {
    let made: HTMLInputElement | undefined;
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
      this: HTMLInputElement,
    ) {
      made = this;
      queueMicrotask(() => answer(this));
    });
    const result = createPlatformBridge().selectPdf();
    return { result, input: () => made! };
  }

  it("offers PDFs only, and answers with the chosen file's name and size", async () => {
    const { result, input } = pick((field) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["FAKE pdf"], "FAKE.pdf", { type: "application/pdf" }),
      );
      field.files = transfer.files;
      field.dispatchEvent(new Event("change"));
    });
    await expect(result).resolves.toEqual({ name: "FAKE.pdf", sizeBytes: 8 });
    expect(input().type).toBe("file");
    expect(input().accept).toBe("application/pdf,.pdf");
  });

  it("answers nothing when the picker is closed with no file, or cancelled", async () => {
    const empty = pick((field) => field.dispatchEvent(new Event("change")));
    await expect(empty.result).resolves.toBeNull();
    const cancelled = pick((field) => field.dispatchEvent(new Event("cancel")));
    await expect(cancelled.result).resolves.toBeNull();
  });
});
