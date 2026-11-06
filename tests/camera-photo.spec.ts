import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_IDS,
  fakeCalls,
  fakeSnapshot,
  fakeVaultWith,
} from "./support/vaultFake";

// Chromium's fake camera stands in for a real one. The headless shell
// Playwright uses by default has no camera support at all (getUserMedia fails
// with NotSupportedError), so this runs on the full Chromium build, which
// `playwright install chromium` also installs. The native side is faked
// (support/vaultFake.ts, which keeps the JPEG and gives it back to the
// viewer): Rust tests check the cleaning, encryption and storage of a photo;
// this checks the dialog, the IPC wiring and the view.
test.use({
  channel: "chromium",
  launchOptions: { args: ["--use-fake-device-for-media-stream"] },
});

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** What the vault was sent for the photo: the JPEG's first bytes, the
 * target and any custom headers, as the fake recorded the one call. */
async function savedPhoto(page: Page) {
  const calls = await fakeCalls(page, "vault_save_photo");
  expect(calls).toHaveLength(1);
  return calls[0].photo as {
    start: number[];
    target: { profileId: string; folderIds: string[]; name: string };
    headers: Record<string, string> | null;
  };
}

for (const [computerLocale, expectedName] of [
  ["en-US", "Photo, Oct 17, 2026, 3.05 PM.jpg"],
  ["en-GB", "Photo, 17 Oct 2026, 15.05.jpg"],
] as const) {
  test.describe(`computer locale ${computerLocale}`, () => {
    test.use({ locale: computerLocale, timezoneId: "UTC" });
    test("takes a photo with the camera, saves it and shows it", async ({
      page,
      context,
    }, testInfo) => {
      await context.grantPermissions(["camera"]);
      // Fix Date without pausing media/timers. The stored name is a machine value:
      // use the fixed computer locale and check its exact bytes.
      await page.clock.setFixedTime(
        await page.evaluate(() => new Date(2026, 9, 17, 15, 5).getTime()),
      );
      await fakeVaultWith(page, { start: "unlocked" });
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
      await expect(
        camera.getByRole("button", { name: "Use photo" }),
      ).toBeFocused();
      await page.screenshot({
        path: testInfo.outputPath("camera-preview.png"),
      });
      await camera.getByRole("button", { name: "Use photo" }).click();

      // Saving encodes the JPEG and stores it: longer than a click's worth
      // on a loaded machine.
      const details = page.getByRole("dialog", { name: /^Photo, .+\.jpg$/ });
      await expect(details).toBeVisible({ timeout: 20_000 });
      const saved = await savedPhoto(page);
      expect(saved.start).toEqual([0xff, 0xd8, 0xff]);
      expect(saved.target).toEqual({
        profileId: FAKE_IDS.profile,
        folderIds: [],
        name: expectedName,
      });
      expect(saved.target.name).not.toMatch(/[\u2066-\u2069]/u);
      await expect(details).toHaveAccessibleName(expectedName);
      await expect(details.getByRole("status")).toHaveText(
        translate("en", "interface.notice.photoSaved", { name: expectedName }),
      );
      // Nothing rides in custom headers, which WebView2 does not pass on.
      expect(saved.headers).toBeNull();

      await details.getByRole("button", { name: "View photo" }).click();
      const viewer = page.getByRole("dialog", { name: /^Photo, .+\.jpg$/ });
      const photo = viewer.getByRole("img", {
        name: translate("en", "photo.alt", { name: expectedName }),
      });
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
      expect(await fakeCalls(page, "vault_view_photo")).toHaveLength(1);

      // The history's newest event: the photo, added with the camera.
      await page.keyboard.press("Escape");
      await expect(details).toBeHidden();
      // The sidebar on a computer, the section tabs on a phone.
      await page
        .getByRole("navigation", {
          name: new RegExp(
            `^(${translate("en", "sidebar.label")}|${translate("en", "interface.VaultLibrary.section")})$`,
          ),
        })
        .getByRole("button", {
          name: translate("en", "security.title"),
          exact: true,
        })
        .click();
      await page
        .getByRole("button", {
          name: translate("en", "interface.history.title"),
          exact: true,
        })
        .click();
      const newest = page.locator("ol.audit-history-list > li").first();
      await expect(newest.locator("h2")).toHaveText(
        translate("en", "interface.history.event.imported"),
      );
      await expect(newest).toContainText(expectedName);
      await expect(newest).toContainText(
        translate("en", "interface.history.how.camera"),
      );
      await expectOnlyFakedCommands(page);
    });
  });
}

test("says how to allow the camera when it is refused", async ({
  page,
}, testInfo) => {
  // No camera permission is granted, so Chromium refuses the request.
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await page.getByRole("button", { name: "Take a photo" }).click();
  const camera = page.getByRole("dialog", { name: "Take a photo" });
  await camera.getByRole("button", { name: "Use the camera" }).click();
  await expect(camera.getByRole("alert")).toHaveText(
    translate("en", "interface.camera.denied", {
      help: translate(
        "en",
        "interface.photo.inWindowsSettingsOpenPrivacySecurityThen",
      ),
    }),
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
  expect(await fakeCalls(page, "vault_save_photo")).toEqual([]);
  await expectOnlyFakedCommands(page);
});

test("on a phone, says the phone asks once, takes a photo and says where to allow the camera (D97)", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "a phone's own words");
  await context.grantPermissions(["camera"]);
  await fakeVaultWith(page, { start: "unlocked", platform: "android" });
  await page.goto("/");
  await page.getByRole("button", { name: "Take a photo" }).click();
  const camera = page.getByRole("dialog", { name: "Take a photo" });
  await expect(
    camera.getByText(
      "Your phone asks once whether myCarlos may use the camera. The camera is on only while you take the photo. It turns off when you take it, cancel, or myCarlos locks.",
    ),
  ).toBeVisible();
  await camera.getByRole("button", { name: "Use the camera" }).click();
  const shutter = camera.getByRole("button", { name: "Take photo" });
  await expect(shutter).toBeFocused();
  expect(
    (await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("phone-camera-live.png") });
  await shutter.click();
  await camera.getByRole("button", { name: "Use photo" }).click();
  await expect(
    page.getByRole("dialog", { name: /^Photo, .+\.jpg$/ }),
  ).toBeVisible();
  expect((await savedPhoto(page)).start).toEqual([0xff, 0xd8, 0xff]);

  // Refused: where to allow it on the phone.
  await context.clearPermissions();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Take a photo" }).click();
  await expect(camera.getByRole("alert")).toHaveText(
    translate("en", "interface.camera.denied", {
      help: translate(
        "en",
        "interface.photo.openYourPhonesSettingsThenAppsThen",
      ),
    }),
  );
  await expectOnlyFakedCommands(page);
});

test.describe("computer locale en-US, twice", () => {
  test.use({ locale: "en-US", timezoneId: "UTC" });
  const NAME = "Photo, Oct 17, 2026, 3.05 PM.jpg";

  test("the same photo taken twice is not saved twice: the second is said to be in the vault already, and nothing changes", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["camera"]);
    // The same instant for both photos, so they get the same name, as the
    // vault names a photo by when it was taken.
    await page.clock.setFixedTime(
      await page.evaluate(() => new Date(2026, 9, 17, 15, 5).getTime()),
    );
    await fakeVaultWith(page, { start: "unlocked" });
    await page.goto("/");
    const take = async (again: boolean) => {
      await page.getByRole("button", { name: "Take a photo" }).click();
      const camera = page.getByRole("dialog", { name: "Take a photo" });
      const use = camera.getByRole("button", { name: "Use the camera" });
      // Once the camera is allowed, the next time it goes live at once.
      if (again) await expect(use).toHaveCount(0);
      else await use.click();
      const shutter = camera.getByRole("button", { name: "Take photo" });
      await expect(shutter).toBeEnabled();
      await shutter.click();
      await camera.getByRole("button", { name: "Use photo" }).click();
      await expect(camera).toBeHidden({ timeout: 20_000 });
    };

    // The first is saved, and its details open.
    await take(false);
    const details = page.getByRole("dialog", { name: NAME, exact: true });
    await expect(details).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();

    // The second, the same: said, no details, and still one photo.
    await take(true);
    await expect(
      page.getByText(
        translate("en", "interface.VaultLibrary.thisPhotoIsAlreadyInTheVault"),
        { exact: true },
      ),
    ).toBeVisible();
    await expect(details).toHaveCount(0);
    expect(await fakeCalls(page, "vault_save_photo")).toHaveLength(2);
    expect(
      (await fakeSnapshot(page)).records.filter(
        (record) => record.displayName === NAME,
      ),
    ).toHaveLength(1);
    await expect(
      page.getByRole("button", { name: NAME, exact: true }),
    ).toHaveCount(1);
    await expectOnlyFakedCommands(page);
  });
});
