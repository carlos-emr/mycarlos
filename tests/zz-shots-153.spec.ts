// Screenshots for Ben's look at #153 (never committed). FAKE data, the e2e fake native side.
// SHOTS_SIDE=before|after, SHOTS_DIR=<folder>.
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import * as path from "node:path";
import { translate } from "./support/fluent";
import { fakeVaultWith } from "./support/vaultFake";

const SIDE = process.env.SHOTS_SIDE === "after" ? "after" : "before";
const DIR = process.env.SHOTS_DIR ?? "shots";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tr = (locale: string, key: string) => translate(locale as any, key as any);

async function shot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  // Viewport shots only: a full-page shot resets the default text size.
  await page.screenshot({
    path: path.join(DIR, SIDE, `${name}-${info.project.name}.png`),
    animations: "disabled",
    caret: "hide",
  });
}

async function open(page: Page, locale: string, portal: "linked" | "unlinked") {
  await page.addInitScript((locale) => localStorage.setItem("mycarlos.language.v1", locale), locale);
  await fakeVaultWith(page, { start: "unlocked", portal });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: tr(locale, "sidebar.myRecords"), exact: true })).toBeVisible();
  const security = tr(locale, "security.title");
  const picker = page.getByRole("combobox", { name: tr(locale, "interface.VaultLibrary.section") });
  const button = page.getByRole("button", { name: new RegExp(`^${security}`) });
  await expect(picker.or(button).first()).toBeVisible();
  if (await picker.isVisible()) await picker.selectOption({ label: security });
  else {
    await button.filter({ visible: true }).first().click();
  }
  const title = page.getByRole("heading", { name: tr(locale, "portal.title"), exact: true });
  await expect(title).toBeVisible();
  return title;
}

for (const locale of ["en", "fr"])
  test(`device name offered when linking, ${locale}`, async ({ page }, info) => {
    test.skip(info.project.name === "narrow", "desktop and phone are enough");
    await open(page, locale, "unlinked");
    const field = page.getByLabel(tr(locale, "portal.deviceName"), { exact: true });
    await expect(field).toBeVisible();
    await field.evaluate((input) => input.scrollIntoView({ block: "center" }));
    console.log(`${SIDE} ${info.project.name} ${locale} device name: ${await field.inputValue()}`);
    await shot(page, info, `01-device-name-${locale}`);
  });

for (const text of [16, 32])
  test(`Clinic documents heading at 360 px, ${text} px default text`, async ({ page, context }, info) => {
    test.skip(info.project.name !== "desktop", "sets its own viewport");
    await page.setViewportSize({ width: 360, height: 800 });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.setFontSizes", { fontSizes: { standard: text } });
    const title = await open(page, "en", "linked");
    const sizes = await page.evaluate(() => {
      const size = (element: Element | null) => (element ? getComputedStyle(element).fontSize : "none");
      return {
        root: getComputedStyle(document.documentElement).fontSize,
        clinicDocuments: size(document.getElementById("portal-title")),
        otherSecurityHeading: size(document.querySelector(".setting-row h2")),
        clinicName: size(document.querySelector(".portal-link h3")),
      };
    });
    console.log(`${SIDE} 360px text ${text}: ${JSON.stringify(sizes)}`);
    await title.evaluate((h) => h.scrollIntoView({ block: "start" }));
    await shot(page, info, `02-heading-360-text-${text === 16 ? "100" : "200"}pct`);
    await page.locator(".portal-link h3").first().evaluate((h) => h.scrollIntoView({ block: "center" }));
    await shot(page, info, `03-clinic-card-360-text-${text === 16 ? "100" : "200"}pct`);
  });

test("Clinic documents heading, desktop", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  const title = await open(page, "en", "linked");
  await title.evaluate((h) => h.scrollIntoView({ block: "start" }));
  await shot(page, info, "04-heading-desktop");
});

