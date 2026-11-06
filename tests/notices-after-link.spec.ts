import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations, expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import { fakeNoticesWith, noticeCalls } from "./support/noticeFake";
import { fakeVaultWith, myRecords, sidebar } from "./support/vaultFake";

// The notices step right after the first clinic link (#235): the existing
// Notices setting, offered once in a dialog, nothing ticked. What is ticked
// there is what Settings > Preferences shows afterwards. The native side is
// faked (support/vaultFake.ts + support/noticeFake.ts). FAKE data only.
const en = (key: Parameters<typeof translate>[1]) => translate("en", key);

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the notices are Windows desktop notices",
  );
});

/** Unlocked, unlinked, notices supported and off; links the first clinic. */
async function linkFirstClinic(page: Page) {
  await fakeVaultWith(page, { start: "unlocked", portal: "unlinked" });
  await fakeNoticesWith(page, {});
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await page
    .getByLabel(en("portal.address"), { exact: true })
    .fill("https://fake-clinic.example.com");
  await page.getByLabel(en("portal.code"), { exact: true }).fill("FAKE-CODE");
  await page
    .getByRole("button", { name: en("portal.link"), exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: en("noticesStep.title") });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function preferencesBoxes(page: Page) {
  await sidebar(page)
    .getByRole("button", { name: en("sidebar.preferences"), exact: true })
    .click();
  const row = page.locator("section.setting-row").filter({
    has: page.getByRole("heading", { name: en("notifications.title") }),
  });
  return {
    notices: row.getByRole("checkbox", {
      name: en("notifications.allow"),
      exact: true,
    }),
    checks: row.getByRole("checkbox", {
      name: en("notifications.autoAllow"),
      exact: true,
    }),
  };
}

test("after the first clinic link, what is ticked in the step is on in Preferences", async ({
  page,
}) => {
  const dialog = await linkFirstClinic(page);
  await expect(dialog).toBeFocused();
  const notices = dialog.getByRole("checkbox", {
    name: en("notifications.allow"),
    exact: true,
  });
  const checks = dialog.getByRole("checkbox", {
    name: en("notifications.autoAllow"),
    exact: true,
  });
  await expect(notices).not.toBeChecked();
  await expect(checks).not.toBeChecked();
  await expectNoAxeViolations(page);
  await notices.check();
  await expect(checks).toBeEnabled();
  await checks.check();
  await expect(checks).toBeChecked();
  await dialog
    .getByRole("button", { name: en("noticesStep.done"), exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(await noticeCalls(page)).toEqual(
    expect.arrayContaining([
      { command: "vault_set_notifications", args: { enabled: true } },
      {
        command: "vault_set_automatic_document_checks",
        args: { enabled: true },
      },
    ]),
  );
  const boxes = await preferencesBoxes(page);
  await expect(boxes.notices).toBeChecked();
  await expect(boxes.checks).toBeChecked();
  await expectOnlyFakedCommands(page);
});

test("Not now leaves both off, and the step is not offered again", async ({
  page,
}) => {
  const dialog = await linkFirstClinic(page);
  await dialog
    .getByRole("button", { name: en("noticesStep.notNow"), exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(
    (await noticeCalls(page)).filter(({ command }) =>
      command.startsWith("vault_set_"),
    ),
  ).toEqual([]);
  const boxes = await preferencesBoxes(page);
  await expect(boxes.notices).not.toBeChecked();
  await expect(boxes.checks).not.toBeChecked();
  // A second clinic's link offers nothing.
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await page
    .getByLabel(en("portal.address"), { exact: true })
    .fill("https://second-fake-clinic.example.com");
  await page.getByLabel(en("portal.code"), { exact: true }).fill("FAKE-CODE-2");
  await page
    .getByRole("button", { name: en("portal.link"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("portal.title"), exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("Escape is Not now", async ({ page }) => {
  const dialog = await linkFirstClinic(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  const boxes = await preferencesBoxes(page);
  await expect(boxes.notices).not.toBeChecked();
});
