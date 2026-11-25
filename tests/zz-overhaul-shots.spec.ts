import { test } from "@playwright/test";
import { fakeVaultWith, openDetails } from "./support/vaultFake";

// Screenshots for the overhaul PR (not part of the suite: run by hand with OUT set).
const OUT = process.env.SHOTS_OUT ?? "/tmp/shots";
test.use({ viewport: { width: 1280, height: 800 } });

test("unlock", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await fakeVaultWith(page, { start: "locked" });
  await page.goto("/");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/1-unlock.png` });
});

test("library, security, preferences, ai, reader", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/2-library.png` });
  const nav = page.getByRole("navigation", { name: "Record library" });
  await nav.getByRole("button", { name: "Security", exact: true }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/3-security.png`, fullPage: true });
  await nav.getByRole("button", { name: "Preferences", exact: true }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/4-preferences.png`, fullPage: true });
  await nav.getByRole("button", { name: "AI helper", exact: true }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/5-ai-helper.png`, fullPage: true });
  await nav.getByRole("button", { name: /^My records/ }).click();
  const details = await openDetails(page, "FAKE Letter.pdf");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/6-details.png` });
  await details.getByRole("button", { name: "Read", exact: true }).click();
  await page.locator(".native-reader-page img").waitFor({ timeout: 60000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/7-reader.png` });
});

test("library on a phone", async ({ page }, info) => {
  test.skip(info.project.name !== "phone");
  await page.setViewportSize({ width: 390, height: 844 });
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/8-library-phone.png` });
});
