import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations, expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  fakeCalls,
  fakeVaultWith,
  myRecords,
  sidebar,
  type FakeVaultSetup,
} from "./support/vaultFake";

// The iPhone Settings switch for notices when myCarlos is closed: shown only where the native side
// says it is an iPhone, off by default, and honest about why notices are not coming. The native side
// is faked (support/vaultFake.ts); the real permission question and Apple's token are not.

const en = (key: Parameters<typeof translate>[1]) => translate("en", key);

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the setting is the same on the phone layout; the desktop project drives it",
  );
});

async function preferences(page: Page, setup: Partial<FakeVaultSetup>) {
  await fakeVaultWith(page, { start: "unlocked", ...setup });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await sidebar(page)
    .getByRole("button", { name: en("sidebar.preferences"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("sidebar.preferences"), level: 1 }),
  ).toBeVisible();
  return page.locator("section.setting-row").filter({
    has: page.getByRole("heading", { name: en("iphonePush.title") }),
  });
}

test("is not shown where this is not an iPhone", async ({ page }) => {
  const row = await preferences(page, {});
  await expect(row).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("on an iPhone it is off, says what Apple sees, and turns on with one command", async ({
  page,
}) => {
  const row = await preferences(page, { iphonePush: {} });
  const box = row.getByRole("checkbox", {
    name: en("iphonePush.allow"),
    exact: true,
  });
  await expect(box).not.toBeChecked();
  await expect(row.getByText(/Apple sees when a push is sent/)).toBeVisible();
  // Reading the status asked the system nothing.
  expect(await fakeCalls(page, "vault_iphone_push_set")).toEqual([]);
  await expectNoAxeViolations(page, "the iPhone push setting");
  // The box follows the system's answer, so click it and wait, instead of `check()`, which expects
  // the state to change at once.
  await box.click();
  await expect(box).toBeChecked();
  expect(await fakeCalls(page, "vault_iphone_push_set")).toEqual([
    { enabled: true },
  ]);
  await expectOnlyFakedCommands(page);
});

test("says where to allow notices when the patient said no", async ({
  page,
}) => {
  const row = await preferences(page, { iphonePush: { state: "refused" } });
  await row
    .getByRole("checkbox", { name: en("iphonePush.allow"), exact: true })
    .click();
  await expect(row.getByText(en("iphonePush.refused"))).toBeVisible();
  await expectNoAxeViolations(page, "the iPhone push setting");
  await expectOnlyFakedCommands(page);
});
