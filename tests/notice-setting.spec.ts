import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoAxeViolations, expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  NOTICE_COMMANDS,
  failNextNoticeSave,
  fakeNoticesWith,
  noticeCalls,
  type FakeNoticeStatus,
} from "./support/noticeFake";
import { fakeVaultWith, myRecords, sidebar } from "./support/vaultFake";

// Settings > Preferences > Notices after document checks: the Windows
// document-arrival notices and the automatic checks while unlocked (#193).
// Until now only the unit tests covered them: the e2e vault fake says they
// are unsupported, so the row never showed. The native side is faked
// (support/vaultFake.ts + support/noticeFake.ts). FAKE data only.

const en = (key: Parameters<typeof translate>[1]) => translate("en", key);

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the notices are Windows desktop notices",
  );
});

async function preferences(page: Page, status: Partial<FakeNoticeStatus>) {
  await fakeVaultWith(page, { start: "unlocked" });
  await fakeNoticesWith(page, status);
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await sidebar(page)
    .getByRole("button", { name: en("sidebar.preferences"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("sidebar.preferences"), level: 1 }),
  ).toBeVisible();
  return page.locator("section.setting-row").filter({
    has: page.getByRole("heading", { name: en("notifications.title") }),
  });
}

const box = (row: Locator, key: Parameters<typeof translate>[1]) =>
  row.getByRole("checkbox", { name: en(key), exact: true });

test("is not shown where the notices are not supported", async ({ page }) => {
  const row = await preferences(page, { supported: false });
  await expect(row).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("allowing the notices, then the automatic checks, saves each choice", async ({
  page,
}) => {
  const row = await preferences(page, {});
  await expect(row.getByText(en("notifications.helpAutomatic"))).toBeVisible();
  const notices = box(row, "notifications.allow");
  const checks = box(row, "notifications.autoAllow");
  await expect(notices).not.toBeChecked();
  // The automatic checks need the notices first.
  await expect(checks).toBeDisabled();
  await notices.check();
  await expect(notices).toBeChecked();
  await expect(checks).toBeEnabled();
  await checks.check();
  await expect(checks).toBeChecked();
  const saved = (await noticeCalls(page)).filter(
    (call) => call.command !== NOTICE_COMMANDS.status,
  );
  expect(saved).toEqual([
    { command: NOTICE_COMMANDS.setNotices, args: { enabled: true } },
    { command: NOTICE_COMMANDS.setChecks, args: { enabled: true } },
  ]);
  // The language goes along with each status, for a later notice's words.
  const asked = (await noticeCalls(page)).find(
    (call) => call.command === NOTICE_COMMANDS.status,
  );
  expect(asked?.args).toEqual({ locale: "en" });
  await expectNoAxeViolations(page, "Preferences with the notices");
  await expectOnlyFakedCommands(page);
});

test("turning the notices off turns the automatic checks off too", async ({
  page,
}) => {
  const row = await preferences(page, {
    enabled: true,
    automaticChecksEnabled: true,
  });
  const checks = box(row, "notifications.autoAllow");
  await expect(checks).toBeChecked();
  await box(row, "notifications.allow").uncheck();
  await expect(checks).not.toBeChecked();
  await expect(checks).toBeDisabled();
});

for (const [permission, key] of [
  ["blocked", "notifications.blocked"],
  ["unknown", "notifications.unknown"],
] as const) {
  test(`a ${permission} Windows permission is said, and read with each box`, async ({
    page,
  }) => {
    const row = await preferences(page, { permission });
    await expect(row.getByText(en(key))).toBeVisible();
    for (const each of [
      "notifications.allow",
      "notifications.autoAllow",
    ] as const)
      await expect(box(row, each)).toHaveAccessibleDescription(
        new RegExp(en(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
  });
}

test("notices that are unavailable say so, and the box cannot be turned on", async ({
  page,
}) => {
  const row = await preferences(page, { available: false });
  await expect(row.getByRole("alert")).toHaveText(
    en("notifications.unavailable"),
  );
  await expect(box(row, "notifications.allow")).toBeDisabled();
});

test("a choice that could not be saved says so, and the notices are off for this session", async ({
  page,
}) => {
  const row = await preferences(page, {});
  await failNextNoticeSave(page);
  // A click, not check(): the box rightly stays off.
  await box(row, "notifications.allow").click();
  await expect(row.getByRole("alert")).toHaveText(en("notifications.error"));
  await expect(box(row, "notifications.allow")).not.toBeChecked();
});

test("paused automatic checks say how to start them again", async ({
  page,
}) => {
  const row = await preferences(page, {
    enabled: true,
    automaticChecksEnabled: true,
    automaticChecksPaused: true,
  });
  await expect(row.getByRole("status")).toHaveText(
    en("notifications.autoPaused"),
  );
});
