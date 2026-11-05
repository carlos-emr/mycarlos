import { expect, test } from "@playwright/test";
import { translate } from "./support/fluent";
import { fakeCalls, fakeVaultWith } from "./support/vaultFake";

// Preferences > Running in the background (M2): two separate choices, both off, saved by the
// native side, which is faked (support/vaultFake.ts). The tray icon, the lock on close and the
// login entry are native and covered by the Rust tests; this covers what the screen asks and shows.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === "phone", "a computer setting");
});

async function openPreferences(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: en("sidebar.preferences"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("sidebar.preferences"), exact: true }),
  ).toBeVisible();
}
const keep = (page: import("@playwright/test").Page) =>
  page.getByRole("checkbox", {
    name: en("background.keepRunning"),
    exact: true,
  });
const login = (page: import("@playwright/test").Page) =>
  page.getByRole("checkbox", {
    name: en("background.startAtLogin"),
    exact: true,
  });

test("the two background choices are off by default, separate, and say what waits while locked", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", background: "available" });
  await openPreferences(page);
  await expect(keep(page)).not.toBeChecked();
  await expect(login(page)).not.toBeChecked();
  await expect(page.getByText(en("background.keepRunningHelp"))).toBeVisible();
  // Start at login on its own.
  await login(page).check();
  await expect(login(page)).toBeChecked();
  await expect(keep(page)).not.toBeChecked();
  await expect(page.getByText(en("background.paused"))).toHaveCount(0);
  expect(await fakeCalls(page, "background_set_start_at_login")).toEqual([
    { enabled: true },
  ]);
  // Keep running: checks wait for the vault.
  await keep(page).check();
  await expect(keep(page)).toBeChecked();
  await expect(page.getByText(en("background.paused"))).toBeVisible();
  expect(await fakeCalls(page, "background_set_keep_running")).toEqual([
    { enabled: true },
  ]);
  await keep(page).uncheck();
  await expect(keep(page)).not.toBeChecked();
  await expect(page.getByText(en("background.paused"))).toHaveCount(0);
  await expect(login(page)).toBeChecked();
});

test("with no tray icon to be had, keeping it running stays off and says so", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", background: "noIcon" });
  await openPreferences(page);
  // A click, not check(): the box is refused and must stay off.
  await keep(page).click();
  await expect(page.getByRole("alert")).toHaveText(
    en("background.unavailable"),
  );
  await expect(keep(page)).not.toBeChecked();
  // Start at login does not need the icon.
  await login(page).check();
  await expect(login(page)).toBeChecked();
});

test("a computer with no background mode shows neither choice", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await openPreferences(page);
  await expect(page.getByText(en("background.title"))).toHaveCount(0);
  await expect(keep(page)).toHaveCount(0);
});
