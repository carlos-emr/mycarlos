import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoAxeViolations, expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  NOTICE_COMMANDS,
  failNextNoticeSave,
  fakeNoticesWith,
  noticeCalls,
  setTestNoticeResult,
  type FakeNoticeStatus,
} from "./support/noticeFake";
import { fakeVaultWith, myRecords, sidebar } from "./support/vaultFake";

// Settings > Preferences > Checking for documents: the Windows
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

test("the automatic checks and the notices are two choices, each saved on its own", async ({
  page,
}) => {
  const row = await preferences(page, {});
  await expect(row.getByText(en("notifications.helpAutomatic"))).toBeVisible();
  const notices = box(row, "notifications.allow");
  const checks = box(row, "notifications.autoAllow");
  await expect(notices).not.toBeChecked();
  await expect(checks).not.toBeChecked();
  // The automatic check does not wait for the notices, and says what it contacts.
  await expect(checks).toBeEnabled();
  await expect(row.getByText(en("notifications.autoConsent"))).toBeVisible();
  await checks.check();
  await expect(checks).toBeChecked();
  await expect(notices).not.toBeChecked();
  await notices.check();
  await expect(notices).toBeChecked();
  await expect(checks).toBeChecked();
  const saved = (await noticeCalls(page)).filter(
    (call) => call.command !== NOTICE_COMMANDS.status,
  );
  expect(saved).toEqual([
    { command: NOTICE_COMMANDS.setChecks, args: { enabled: true } },
    { command: NOTICE_COMMANDS.setNotices, args: { enabled: true } },
  ]);
  // The language goes along with each status, for a later notice's words.
  const asked = (await noticeCalls(page)).find(
    (call) => call.command === NOTICE_COMMANDS.status,
  );
  expect(asked?.args).toEqual({ locale: "en" });
  await expectNoAxeViolations(page, "Preferences with the notices");
  await expectOnlyFakedCommands(page);
});

test("turning the notices off leaves the automatic checks on", async ({
  page,
}) => {
  const row = await preferences(page, {
    enabled: true,
    automaticChecksEnabled: true,
  });
  const checks = box(row, "notifications.autoAllow");
  await expect(checks).toBeChecked();
  await box(row, "notifications.allow").uncheck();
  await expect(checks).toBeChecked();
  await expect(checks).toBeEnabled();
});

test("where no notice can be shown, only the automatic check is offered", async ({
  page,
}) => {
  const row = await preferences(page, {
    noticesSupported: false,
    permission: "unavailable",
  });
  await expect(box(row, "notifications.autoAllow")).toBeEnabled();
  await expect(row.getByRole("checkbox")).toHaveCount(1);
  await expect(testButton(row)).toHaveCount(0);
  await expectNoAxeViolations(page, "Preferences without notices");
});

for (const [permission, key] of [
  ["blocked", "notifications.blocked"],
  ["unknown", "notifications.unknown"],
  ["not_yet_asked", "notifications.notYetAsked"],
] as const) {
  test(`a ${permission} Windows permission is said, and read with each box`, async ({
    page,
  }) => {
    const row = await preferences(page, { permission });
    await expect(row.getByText(en(key))).toBeVisible();
    // The permission line belongs to the notice box (the automatic check does not need it).
    await expect(box(row, "notifications.allow")).toHaveAccessibleDescription(
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

const testButton = (row: Locator) =>
  row.getByRole("button", {
    name: en("notifications.testButton"),
    exact: true,
  });

test("Show a test notice is off until notices are allowed, then shows what happened", async ({
  page,
}) => {
  const row = await preferences(page, { enabled: false });
  await expect(testButton(row)).toBeDisabled();
  await box(row, "notifications.allow").check();
  await expect(testButton(row)).toBeEnabled();
  await testButton(row).click();
  await expect(row.getByText(en("notifications.testSent"))).toBeVisible();
  expect(
    (await noticeCalls(page)).filter(
      (call) => call.command === "vault_send_test_notice",
    ),
  ).toEqual([{ command: "vault_send_test_notice", args: {} }]);
  // The result is told to a screen reader as a polite live region.
  await expect(
    row.locator("[aria-live=polite]", {
      hasText: en("notifications.testSent"),
    }),
  ).toBeVisible();
  await expectOnlyFakedCommands(page);
});

test("Show a test notice says when Windows is blocking notices, and when to wait or that it failed", async ({
  page,
}) => {
  const row = await preferences(page, { enabled: true });
  await setTestNoticeResult(page, "blocked");
  await testButton(row).click();
  await expect(row.getByText(en("notifications.blocked"))).toBeVisible();
  await setTestNoticeResult(page, "tooSoon");
  await testButton(row).click();
  await expect(row.getByText(en("notifications.testWait"))).toBeVisible();
  await setTestNoticeResult(page, "notAllowed");
  await testButton(row).click();
  await expect(row.getByText(en("notifications.testOff"))).toBeVisible();
  await setTestNoticeResult(page, "failed");
  await testButton(row).click();
  await expect(row.getByText(en("notifications.testFailed"))).toBeVisible();
});
