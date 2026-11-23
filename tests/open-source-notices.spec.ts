import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations, expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import { fakeVaultWith, myRecords } from "./support/vaultFake";

// Settings > Preferences > About > Open-source notices: the real generated notices file, on a
// computer and on a phone. The native side is faked (support/vaultFake.ts). FAKE data only.

const en = (key: Parameters<typeof translate>[1]) => translate("en", key);

async function openNotices(page: Page) {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  // The sidebar on a computer, the tab bar on a phone: one of them is on screen.
  await page
    .getByRole("button", { name: en("sidebar.preferences"), exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: en("notices.open"), exact: true })
    .click();
  const heading = page.getByRole("heading", {
    name: en("notices.title"),
    level: 1,
  });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
}

test("lists the libraries with their licences and names myCarlos's own licence and source", async ({
  page,
}) => {
  await openNotices(page);
  await expect(
    page.getByText(/GNU Affero General Public License, version 3/).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: en("notices.source.title") }),
  ).toBeVisible();
  await expect(
    page.getByText("https://github.com/carlos-emr/mycarlos"),
  ).toBeVisible();
  // The list is the generated file: React is in the app, and llama.cpp in the AI helper's build.
  const entries = page.locator("li.notice-entry");
  await expect(entries.first()).toBeVisible();
  await expect(entries.filter({ hasText: "react-dom" }).first()).toBeVisible();
  await expect(entries.filter({ hasText: "llama.cpp and ggml" })).toHaveCount(1);
  await expectOnlyFakedCommands(page);
});

test("searches the list and opens a library's licence text", async ({
  page,
}) => {
  await openNotices(page);
  const search = page.getByRole("searchbox", { name: en("notices.search") });
  await search.fill("llama.cpp and ggml");
  const entries = page.locator("li.notice-entry");
  await expect(entries).toHaveCount(1);
  await entries.first().locator("summary").click();
  await expect(
    entries.first().locator("pre.notice-text").first(),
  ).toContainText("Permission is hereby granted");
  await search.fill("zzzz no such library");
  await expect(page.getByText(en("notices.none"))).toBeVisible();
  await expect(entries).toHaveCount(0);
});

test("has no accessibility violations, and does not scroll sideways", async ({
  page,
}) => {
  await openNotices(page);
  await page.locator("li.notice-entry summary").first().click();
  await expectNoAxeViolations(page, "open-source notices");
  const sideways = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  expect(sideways, "horizontal scroll").toBe(false);
});

test("goes back to Preferences", async ({ page }) => {
  await openNotices(page);
  await page
    .getByRole("button", { name: en("notices.back"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("sidebar.preferences"), level: 1 }),
  ).toBeVisible();
});
