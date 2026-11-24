import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "./support/a11y";
import { fakeNoticesWith } from "./support/noticeFake";
import { translate } from "./support/fluent";
import { fakeVaultWith } from "./support/vaultFake";

// Preferences: the notices and background sections read at body size, with one short summary each
// and the long explanation folded under "More about this". FAKE data only.

const en = (key: Parameters<typeof translate>[1]) => translate("en", key);

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Windows desktop settings");
});

async function preferences(page: Page) {
  await fakeVaultWith(page, { start: "unlocked", background: "available" });
  await fakeNoticesWith(page, {
    supported: true,
    available: true,
    enabled: true,
    permission: "allowed",
    automaticChecksSupported: true,
    automaticChecksEnabled: true,
    automaticChecksPaused: false,
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: en("sidebar.preferences"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("background.title") }),
  ).toBeVisible();
}

const fontSize = (page: Page, text: string) =>
  page
    .getByText(text, { exact: true })
    .first()
    .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));

test("the explanations and the tick-box labels are at body size", async ({
  page,
}) => {
  await preferences(page);
  for (const text of [
    en("notifications.helpAutomatic"),
    en("notifications.autoSummary"),
    en("background.keepRunningSummary"),
    en("background.startAtLoginSummary"),
    en("notifications.allow"),
    en("notifications.autoAllow"),
    en("background.keepRunning"),
    en("background.startAtLogin"),
  ]) {
    expect(await fontSize(page, text), text).toBeGreaterThanOrEqual(16);
  }
});

test("the long text is folded at first, opens from the keyboard and closes again", async ({
  page,
}) => {
  await preferences(page);
  await expect(page.getByText(en("notifications.autoHelp"))).toBeHidden();
  await expect(page.getByText(en("background.keepRunningHelp"))).toBeHidden();
  // The key facts are in view without opening anything.
  await expect(page.getByText(en("notifications.autoSummary"))).toBeVisible();
  await expect(
    page.getByText(en("background.keepRunningSummary")),
  ).toBeVisible();
  // Two disclosures, told apart by name, the same open or closed.
  const automatic = page.getByText(en("preferences.moreAutomatic"), {
    exact: true,
  });
  const background = page.getByText(en("preferences.moreBackground"), {
    exact: true,
  });
  await expect(automatic).toHaveCount(1);
  await expect(background).toHaveCount(1);
  const first = automatic;
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(en("notifications.autoHelp"))).toBeVisible();
  await expect(automatic).toHaveCount(1);
  await page.keyboard.press("Space");
  await expect(page.getByText(en("notifications.autoHelp"))).toBeHidden();
  await expect(automatic).toHaveCount(1);
  // The text is never swapped for "Less".
  await expect(page.getByText("Less", { exact: true })).toHaveCount(0);
});

test("a screen reader finds each disclosure as a collapsed or expanded group, and the page has no violations", async ({
  page,
}) => {
  await preferences(page);
  const summaries = page.locator("details.more-about > summary");
  await expect(summaries).toHaveCount(2);
  for (const index of [0, 1]) {
    const details = page.locator("details.more-about").nth(index);
    await expect(details).not.toHaveAttribute("open", "");
    await summaries.nth(index).click();
    await expect(details).toHaveAttribute("open", "");
  }
  await expectNoAxeViolations(page, "preferences with the text opened");
});

test("each disclosure has a drawn chevron: right when closed, down when open, in the text colour", async ({
  page,
}) => {
  await preferences(page);
  const summary = page.locator("details.more-about > summary").first();
  const marker = () =>
    summary.evaluate((element) => {
      const style = getComputedStyle(element, "::before");
      return {
        width: parseFloat(style.width),
        height: parseFloat(style.height),
        border: style.borderBottomStyle,
        transform: style.transform,
        color: style.borderBottomColor,
        text: getComputedStyle(element).color,
      };
    });
  const closed = await marker();
  // A real box with a border, not a glyph the browser may drop or a font may lack.
  expect(closed.width).toBeGreaterThan(4);
  expect(closed.height).toBeGreaterThan(4);
  expect(closed.border).toBe("solid");
  expect(closed.color).toBe(closed.text);
  await summary.click();
  const open = await marker();
  expect(open.transform).not.toBe(closed.transform);
  expect(open.border).toBe("solid");
  // The focus ring stays visible on the keyboard.
  await summary.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const outline = await summary.evaluate(
    (element) => getComputedStyle(element).outlineStyle,
  );
  expect(outline).not.toBe("none");
});
