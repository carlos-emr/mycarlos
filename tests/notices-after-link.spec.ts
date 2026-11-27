import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations, expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import { fakeNoticesWith, noticeCalls } from "./support/noticeFake";
import {
  fakeCalls,
  fakeVaultWith,
  myRecords,
  sidebar,
} from "./support/vaultFake";

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

/** Unlocked, unlinked, notices supported and off; links the first clinic. `background` makes it a
 * computer that can keep myCarlos running in the background (the tray icon). */
async function linkFirstClinic(page: Page, background = false) {
  await fakeVaultWith(page, {
    start: "unlocked",
    portal: "unlinked",
    ...(background ? { background: "available" as const } : {}),
  });
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
  // A second clinic's link offers nothing. A clinic is linked now, so the
  // form opens from Link another clinic (#145); sending closes it.
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await page
    .getByRole("button", { name: en("portal.linkAnother"), exact: true })
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

// A computer with a background mode: the step also offers the two background choices (#235).
test("on a computer with a background mode, the step offers keeping myCarlos running and starting at sign-in, and what is ticked is on in Preferences", async ({
  page,
}) => {
  const dialog = await linkFirstClinic(page, true);
  const keep = dialog.getByRole("checkbox", {
    name: en("background.keepRunning"),
    exact: true,
  });
  const login = dialog.getByRole("checkbox", {
    name: en("background.startAtLogin"),
    exact: true,
  });
  await expect(keep).not.toBeChecked();
  await expect(login).not.toBeChecked();
  await expect(
    dialog.getByRole("heading", { name: en("background.title"), level: 3 }),
  ).toBeVisible();
  await expectNoAxeViolations(page);
  await keep.check();
  await expect(keep).toBeChecked();
  await login.check();
  await expect(login).toBeChecked();
  // A saved choice leaves only Done.
  await expect(
    dialog.getByRole("button", { name: en("noticesStep.notNow"), exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: en("noticesStep.done"), exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(await fakeCalls(page, "background_set_keep_running")).toEqual([
    { enabled: true },
  ]);
  expect(await fakeCalls(page, "background_set_start_at_login")).toEqual([
    { enabled: true },
  ]);
  await preferencesBoxes(page);
  await expect(
    page.getByRole("checkbox", {
      name: en("background.keepRunning"),
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", {
      name: en("background.startAtLogin"),
      exact: true,
    }),
  ).toBeChecked();
  await expectOnlyFakedCommands(page);
});

test("on a computer with a background mode, Not now leaves the background choices off too", async ({
  page,
}) => {
  const dialog = await linkFirstClinic(page, true);
  await dialog
    .getByRole("button", { name: en("noticesStep.notNow"), exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(await fakeCalls(page, "background_set_keep_running")).toEqual([]);
  expect(await fakeCalls(page, "background_set_start_at_login")).toEqual([]);
  await preferencesBoxes(page);
  await expect(
    page.getByRole("checkbox", {
      name: en("background.keepRunning"),
      exact: true,
    }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", {
      name: en("background.startAtLogin"),
      exact: true,
    }),
  ).not.toBeChecked();
});
