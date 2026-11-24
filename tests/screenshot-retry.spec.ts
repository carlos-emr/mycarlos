import { expect, test } from "@playwright/test";
import { screenshotClip } from "./support/a11y";

// The walk's screenshots are asked again when Chromium cannot capture one just yet, and only then.
// A fake page stands in: no browser is used.

const CLIP = { x: 0, y: 0, width: 10, height: 10 };
const REFUSED = () =>
  new Error(
    "page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot",
  );

function pageThatFails(failures: Error[]) {
  const calls: unknown[] = [];
  return {
    calls,
    page: {
      screenshot: async (options?: unknown) => {
        calls.push(options);
        const failure = failures.shift();
        if (failure) throw failure;
        return Buffer.from("png");
      },
    },
  };
}

test("a refused capture is asked again and the picture is used", async () => {
  const fake = pageThatFails([REFUSED(), REFUSED()]);
  const picture = await screenshotClip(fake.page, CLIP, { waitMs: 1 });
  expect(picture.toString()).toBe("png");
  expect(fake.calls).toHaveLength(3);
  expect(fake.calls[0]).toEqual({ clip: CLIP, animations: "disabled" });
});

test("a capture refused every time is thrown after the last try", async () => {
  const fake = pageThatFails([REFUSED(), REFUSED(), REFUSED(), REFUSED()]);
  await expect(screenshotClip(fake.page, CLIP, { waitMs: 1 })).rejects.toThrow(
    /Unable to capture screenshot/,
  );
  expect(fake.calls).toHaveLength(3);
});

test("any other error is thrown at once, without another try", async () => {
  const fake = pageThatFails([
    new Error("Target page, context or browser has been closed"),
  ]);
  await expect(screenshotClip(fake.page, CLIP, { waitMs: 1 })).rejects.toThrow(
    /has been closed/,
  );
  expect(fake.calls).toHaveLength(1);
});
