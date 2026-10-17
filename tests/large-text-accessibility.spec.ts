import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// WCAG 2.0, 2.1 and 2.2 A and AA, as in smoke.spec.ts.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoViolations(page: Page, where: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations, where).toEqual([]);
}

// Large text can change the layout: the narrow layout swaps the side buttons for a Section menu.
async function openSection(page: Page, value: string, label: string) {
  const menu = page.getByRole("combobox", { name: "Section" });
  if (await menu.isVisible()) await menu.selectOption(value);
  else
    await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
}

// The screens smoke.spec.ts checks, each checked again here.
async function walkTheApp(page: Page) {
  await page.goto("/");
  await expectNoViolations(page, "library");
  await openSection(page, "security", "Security & backup");
  await expectNoViolations(page, "Security & backup");
  await openSection(page, "health", "Health data");
  await expectNoViolations(page, "Health data");
  await openSection(page, "records", "My records");
  await page
    .getByRole("button", {
      name: "More options for Prescription — ramipril 5mg",
    })
    .click();
  await expectNoViolations(page, "a record's More options menu");
}

test("has no automatically detectable WCAG violations with the app's text size at 200%", async ({
  browser,
}, testInfo) => {
  // The app's Text size (Settings > Preferences) zooms the whole webview, which a browser shows as page
  // zoom: at 200% the page lays out in half the CSS width and height, drawn with twice the pixels.
  test.skip(
    testInfo.project.name === "phone",
    "a phone scales text by its own settings (nativeZoom.ts); the reader's default text test covers it",
  );
  const use = testInfo.project.use;
  const viewport = use.viewport ?? { width: 1280, height: 720 };
  const scale = use.deviceScaleFactor ?? 1;
  const context = await browser.newContext({
    baseURL: use.baseURL,
    userAgent: use.userAgent,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    viewport: {
      width: Math.round(viewport.width / 2),
      height: Math.round(viewport.height / 2),
    },
    deviceScaleFactor: scale * 2,
  });
  try {
    const page = await context.newPage();
    await walkTheApp(page);
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(scale * 2);
  } finally {
    await context.close();
  }
});

test("has no automatically detectable WCAG violations with the reader's default text at 200%", async ({
  page,
}) => {
  // A reader's larger default text (the browser's, or the phone's text size): 32px instead of 16px.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32 } });
  await walkTheApp(page);
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    ),
  ).toBe("32px");
});
