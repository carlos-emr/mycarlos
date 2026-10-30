import { expect, test } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_PASSPHRASE,
  fakeCalls,
  fakeVaultWith,
  myRecords,
  sidebar,
} from "./support/vaultFake";

// The automatic lock (#68): the delay is set in Security, a warning comes
// 30 seconds before the lock and Keep open puts it off, and the lock comes
// when nothing is done, saying why on the unlock screen. Time is
// Playwright's clock, not real waiting. The native side is faked.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "these flows are checked on the desktop project only; the vault screens' phone layout is covered by large-text-accessibility.spec.ts",
  );
});

test("the lock delay is set in Security; the warning comes before the lock, Keep open puts it off, and the vault locks after the delay without use, saying why", async ({
  page,
}) => {
  await page.clock.install();
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();

  // Security: the delay goes from the default 5 minutes down to 1.
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  const delay = page.getByRole("group", {
    name: en("security.autoLock.label"),
    exact: true,
  });
  await expect(delay).toContainText(
    en("security.autoLock.minutes", { count: 5 }),
  );
  const shorter = delay.getByRole("button", {
    name: en("security.autoLock.shorter"),
    exact: true,
  });
  for (let i = 0; i < 4; i += 1) await shorter.click();
  await expect(delay).toContainText(
    en("security.autoLock.minutes", { count: 1 }),
  );
  await expect(
    page.getByText(en("notice.autoLockSet", { count: 1 }), { exact: true }),
  ).toBeVisible();
  expect((await fakeCalls(page, "vault_set_auto_lock")).at(-1)).toEqual({
    request: { minutes: 1 },
  });

  // Thirty seconds before the lock, the warning; Keep open puts it off and
  // tells the native side.
  // The name carries Fluent's isolation marks around the number.
  const warning = page.getByRole("alertdialog", {
    name: /^myCarlos will lock in .+ to keep your records private\.$/,
  });
  await page.clock.fastForward(31_000);
  await expect(warning).toBeVisible();
  await expect(
    warning.getByText(
      en("lockWarning.help", { keepOpen: en("lockWarning.keepOpen") }),
      { exact: true },
    ),
  ).toBeVisible();
  const touchesBefore = (await fakeCalls(page, "vault_touch")).length;
  await warning
    .getByRole("button", { name: en("lockWarning.keepOpen"), exact: true })
    .click();
  await expect(warning).toBeHidden();
  expect((await fakeCalls(page, "vault_touch")).length).toBeGreaterThan(
    touchesBefore,
  );
  expect(await fakeCalls(page, "vault_lock")).toEqual([]);

  // Left alone: the warning again, then the lock, said on the unlock screen.
  await page.clock.fastForward(31_000);
  await expect(warning).toBeVisible();
  await page.clock.fastForward(31_000);
  await expect(
    page.getByRole("heading", { name: en("unlock.title") }),
  ).toBeVisible();
  await expect(
    page.getByText(en("notice.lockedIdle", { count: 1 }), { exact: true }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_lock")).toHaveLength(1);

  // Unlocking opens the library again.
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page.getByRole("button", { name: en("unlock.submit") }).click();
  await expect(myRecords(page)).toBeVisible();
  await expectOnlyFakedCommands(page);
});
