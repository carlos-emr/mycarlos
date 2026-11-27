import { expect, test, type Page } from "@playwright/test";
import { translate } from "./support/fluent";
import { fakeVaultWith } from "./support/vaultFake";

// Ben, after trying the phone: on the first-setup page the line saying that text size follows the
// phone's settings "is unneeded, it just takes up more space"; it can stay in Preferences. So a
// phone's setup page (comfort settings) shows no text-size row and no such line, and Preferences
// still has it. Run on the phone project at its own width and, in the second journey, at 320 px.
// The native side is faked (support/vaultFake.ts) with the "android" platform, which has no App
// zoom of its own (the text size follows the device), as the app's phone builds do.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

const FOLLOWS = en("textSize.followsDevice");

// A computer has the app's own zoom (its setup page keeps that row); this is for a phone.
test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "phone",
    "the desktop's setup page has the app's own zoom row; this is the phone's",
  );
});

const comfortHeading = (page: Page) =>
  page.getByRole("heading", { name: en("comfort.title"), level: 1 });

test("a phone's first-setup page says nothing about the text size following the device, and loses no setting", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "absent",
    platform: "android",
    recoveryKey: null,
  });
  await page.goto("/");
  await expect(comfortHeading(page)).toBeVisible();
  // Nothing about text size, neither the line nor its empty "App zoom" row.
  await expect(page.getByText(FOLLOWS, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: en("textSize.title") }),
  ).toHaveCount(0);
  // The settings that ARE here are still here.
  await expect(
    page.getByRole("heading", { name: en("security.autoLock.title") }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: en("appearance.title") }),
  ).toBeVisible();
  // And nothing sideways.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("the same page at 320 px has no sideways scroll and no such line", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await fakeVaultWith(page, {
    start: "absent",
    platform: "android",
    recoveryKey: null,
  });
  await page.goto("/");
  await expect(comfortHeading(page)).toBeVisible();
  await expect(page.getByText(FOLLOWS, { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("Preferences still carries the sentence on a phone", async ({ page }) => {
  await fakeVaultWith(page, { start: "unlocked", platform: "android" });
  await page.goto("/");
  await page
    .getByRole("navigation", {
      name: en("interface.VaultLibrary.section"),
      exact: true,
    })
    .getByRole("button", { name: en("sidebar.preferences"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("sidebar.preferences"), level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(FOLLOWS, { exact: true })).toBeVisible();
});
