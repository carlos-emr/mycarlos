import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Chromium's fake camera stands in for a real one. The headless shell
// Playwright uses by default has no camera support at all (getUserMedia fails
// with NotSupportedError), so this runs on the full Chromium build, which
// `playwright install chromium` also installs. The native side is faked as in
// native-rename.spec.ts: Rust tests check the cleaning, encryption and
// storage of a photo; this checks the dialog, the IPC wiring and the view.
test.use({
  channel: "chromium",
  launchOptions: { args: ["--use-fake-device-for-media-stream"] },
});

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function fakeVault(page: Page) {
  await page.addInitScript(() => {
    const snapshot = {
      profiles: [
        { id: "profile", displayName: "FAKE Patient", createdAtMs: 1 },
      ],
      folders: [] as unknown[],
      records: [] as Record<string, unknown>[],
      recovery: null,
    };
    let photoUrl = "";
    Reflect.set(window, "__TAURI_INTERNALS__", {
      invoke: async (
        command: string,
        args?: unknown,
        options?: { headers?: Record<string, string> },
      ) => {
        if (command === "vault_status") return "unlocked";
        if (command === "vault_snapshot") return structuredClone(snapshot);
        if (command === "runtime_info") return { platform: "windows" };
        if (command === "vault_touch" || command === "vault_set_auto_lock")
          return;
        if (command === "vault_save_photo" && args instanceof Uint8Array) {
          // The vault's framing: the target's length, the target, the JPEG.
          const length = new DataView(args.buffer, args.byteOffset).getUint32(
            0,
          );
          const target = JSON.parse(
            new TextDecoder().decode(args.slice(4, 4 + length)),
          );
          const jpeg = args.slice(4 + length);
          let binary = "";
          for (const byte of jpeg) binary += String.fromCharCode(byte);
          photoUrl = `data:image/jpeg;base64,${btoa(binary)}`;
          Reflect.set(window, "__savedPhoto", {
            start: Array.from(jpeg.slice(0, 3)),
            target,
            headers: options?.headers ?? null,
          });
          snapshot.records.push({
            id: "photo",
            profileId: target.profileId,
            folderIds: target.folderIds,
            displayName: target.name,
            sourceLabel: "Manual import — unverified",
            mediaType: "application/octet-stream",
            plaintextSize: jpeg.length,
            importedAtMs: Date.now(),
            available: true,
          });
          return { imported: ["photo"], skippedDuplicates: [] };
        }
        if (command === "vault_is_photo") return Boolean(photoUrl);
        if (command === "vault_view_photo" && photoUrl) return photoUrl;
        throw new Error(`Unexpected IPC command: ${command}`);
      },
    });
  });
}

test("takes a photo with the camera, saves it and shows it", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["camera"]);
  await fakeVault(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Take a photo" }).click();
  const camera = page.getByRole("dialog", { name: "Take a photo" });
  await expect(
    camera.getByText(
      "myCarlos uses the camera to save photos of your health documents. Photos stay locked in myCarlos.",
    ),
  ).toBeVisible();
  await camera.getByRole("button", { name: "Use the camera" }).click();
  const shutter = camera.getByRole("button", { name: "Take photo" });
  await expect(shutter).toBeEnabled();
  await expect(shutter).toBeFocused();
  await expect(camera.getByLabel("Camera view")).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("camera-live.png") });

  await shutter.click();
  await expect(
    camera.getByRole("img", { name: "The photo you took" }),
  ).toBeVisible();
  await expect(camera.getByRole("button", { name: "Use photo" })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("camera-preview.png") });
  await camera.getByRole("button", { name: "Use photo" }).click();

  const details = page.getByRole("dialog", { name: /^Photo, .+\.jpg$/ });
  await expect(details).toBeVisible();
  await expect(details.getByRole("status")).toHaveText(
    /^Photo saved as Photo, \d{1,2} [A-Z][a-z]{2} \d{4}, \d{1,2}\.\d{2} [AP]M\.jpg\.$/,
  );
  const saved = await page.evaluate(() => Reflect.get(window, "__savedPhoto"));
  expect(saved.start).toEqual([0xff, 0xd8, 0xff]);
  expect(saved.target).toEqual({
    profileId: "profile",
    folderIds: [],
    name: expect.stringMatching(/^Photo, .+\.jpg$/),
  });
  // Nothing rides in custom headers, which WebView2 does not pass on.
  expect(saved.headers).toBeNull();

  await details.getByRole("button", { name: "View photo" }).click();
  const viewer = page.getByRole("dialog", { name: /^Photo, .+\.jpg$/ });
  const photo = viewer.getByRole("img", { name: /^Photo: Photo, / });
  await expect(photo).toBeVisible();
  expect(
    await photo.evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).toBeGreaterThan(0);
  expect(
    (await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("photo-view.png") });
  await viewer.getByRole("button", { name: "Close" }).click();
  await expect(
    details.getByRole("button", { name: "View photo" }),
  ).toBeVisible();
});

test("says how to allow the camera when it is refused", async ({
  page,
}, testInfo) => {
  // No camera permission is granted, so Chromium refuses the request.
  await fakeVault(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Take a photo" }).click();
  const camera = page.getByRole("dialog", { name: "Take a photo" });
  await camera.getByRole("button", { name: "Use the camera" }).click();
  await expect(camera.getByRole("alert")).toHaveText(
    "myCarlos can't use the camera. In Windows Settings, open Privacy & security, then Camera, and turn on camera access for desktop apps. Then choose Try again.",
  );
  await expect(camera.getByRole("button", { name: "Try again" })).toBeFocused();
  expect(
    (await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("camera-refused.png") });
  await camera.getByRole("button", { name: "Close" }).click();
  await expect(
    page.getByRole("button", { name: "Take a photo" }),
  ).toBeFocused();
});
