import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_NEW_KEY_LABEL,
  FAKE_PASSPHRASE,
  fakeCalls,
  fakeRecoveryKey,
  fakeSnapshot,
  fakeVaultWith,
  mistypedKey,
  myRecords,
} from "./support/vaultFake";

// Setting up a recovery key to the end, which every new patient does once and
// which decides whether a forgotten passphrase loses their documents: the key
// shown in 7 groups, its kit saved, the whole key typed back (a key too short
// is caught on screen; three typos send the patient back to the key), and
// Security showing the key that works. Also the setup offered at unlock to a
// vault without a key. The native side is faked (support/vaultFake.ts); Rust
// tests cover making, checking and storing keys. The key is derived at run
// time from a seed text, and is FAKE.

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

const stepHeading = (dialog: Locator, key: Parameters<typeof translate>[1]) =>
  dialog.getByRole("heading", { name: en(key), exact: true });

/** The key's groups, as the dialog lists them for a screen reader too. */
async function expectKeyShown(dialog: Locator, key: string) {
  const items = dialog
    .getByRole("list", { name: en("recover.key.label"), exact: true })
    .getByRole("listitem");
  const groups = key.split("-");
  await expect(items).toHaveCount(groups.length);
  for (const [index, group] of groups.entries()) {
    await expect(items.nth(index)).toContainText(group);
    await expect(items.nth(index)).toContainText(
      en("recoveryKey.group", {
        number: index + 1,
        characters: group.split("").join(" "),
      }),
    );
  }
}

/** Types the key back and presses Check and save. */
async function typeBack(dialog: Locator, typed: string) {
  await dialog
    .getByLabel(en("recoveryKey.check.label"), { exact: true })
    .fill(typed);
  await dialog
    .getByRole("button", { name: en("recoveryKey.checkAndSave"), exact: true })
    .click();
}

/** Security's recovery key heading says when the key that works was set up. */
async function expectSecurityShowsKey(page: Page) {
  await page
    .getByRole("navigation", { name: en("sidebar.label"), exact: true })
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  const setAtMs = (await fakeSnapshot(page)).recoveryKeySetAtMs;
  expect(setAtMs).not.toBeNull();
  // As Security writes the date (printedDate in src/native/KeyLabel.tsx), in
  // the browser's own locale.
  const date = await page.evaluate(
    (ms) =>
      new Date(ms).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    setAtMs ?? 0,
  );
  await expect(
    page.getByRole("heading", {
      name: `${en("security.recoveryKey.title")} ${en("security.recoveryKey.setUpOn", { date })}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(FAKE_NEW_KEY_LABEL, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: en("security.recoveryKey.replace"),
      exact: true,
    }),
  ).toBeVisible();
}

test("first setup: the key is shown, its kit saved, and it must be typed back whole before Security shows it", async ({
  page,
}) => {
  const key = fakeRecoveryKey("first setup");
  const groups = key.split("-");
  await fakeVaultWith(page, { start: "absent", newRecoveryKey: key });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: en("comfort.title"), exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: en("comfort.continue"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("create.title"), exact: true }),
  ).toBeVisible();
  await page
    .getByLabel(en("create.profile.label"), { exact: true })
    .fill("FAKE Patient");
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page
    .getByLabel(en("passphrase.confirm.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page
    .getByRole("button", { name: en("create.submit"), exact: true })
    .click();

  // The new vault opens on its key, made with the passphrase just typed.
  const dialog = page.getByRole("dialog");
  await expect(stepHeading(dialog, "recoveryKey.title.key")).toBeVisible();
  await expectKeyShown(dialog, key);
  await expect(dialog).toContainText(FAKE_NEW_KEY_LABEL);
  expect(await fakeCalls(page, "vault_create")).toEqual([
    {
      request: {
        passphrase: FAKE_PASSPHRASE,
        initialProfileName: "FAKE Patient",
      },
    },
  ]);
  expect(await fakeCalls(page, "vault_recovery_key_begin")).toEqual([
    { request: { passphrase: FAKE_PASSPHRASE } },
  ]);

  // Its kit, saved where the patient chose.
  await dialog
    .getByRole("button", { name: en("recoveryKey.saveKit"), exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText(
    en("recoveryKey.kitSaved"),
  );
  expect(await fakeCalls(page, "vault_recovery_kit_save")).toEqual([
    { locale: "en" },
  ]);

  // Typed back: a key too short is said on screen, and not sent.
  await dialog
    .getByRole("button", { name: en("recoveryKey.next"), exact: true })
    .click();
  await expect(stepHeading(dialog, "recoveryKey.title.check")).toBeVisible();
  await typeBack(dialog, groups.slice(0, 3).join(" "));
  await expect(dialog.getByRole("alert")).toHaveText(
    en("recoveryKey.typedCount", { count: 12, total: 28 }),
  );
  expect(await fakeCalls(page, "vault_recovery_key_confirm")).toEqual([]);

  // Three typos: each said, and the third goes back to the key, to look at
  // it again.
  let typo = key;
  for (const tries of [1, 2, 3]) {
    typo = mistypedKey(typo);
    await typeBack(dialog, typo.split("-").join(" "));
    await expect
      .poll(
        async () =>
          (await fakeCalls(page, "vault_recovery_key_confirm")).length,
      )
      .toBe(tries);
    if (tries < 3) {
      await expect(dialog.getByRole("alert")).toHaveText(en("native.error.41"));
      await expect(
        stepHeading(dialog, "recoveryKey.title.check"),
      ).toBeVisible();
    }
  }
  await expect(stepHeading(dialog, "recoveryKey.title.key")).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveText(
    en("recoveryKey.threeMisses"),
  );
  await expectKeyShown(dialog, key);

  // The whole key, with spaces between its groups: stored, and said.
  await dialog
    .getByRole("button", { name: en("recoveryKey.next"), exact: true })
    .click();
  await typeBack(dialog, groups.join(" "));
  await expect(dialog).toBeHidden();
  await expect(myRecords(page)).toBeVisible();
  await expect(
    page.getByText(
      en("interface.VaultLibrary.recoveryKeySavedKeepYourKitSomewhere"),
      { exact: true },
    ),
  ).toBeVisible();
  const confirms = await fakeCalls(page, "vault_recovery_key_confirm");
  expect(confirms).toHaveLength(4);
  expect(confirms.at(-1)).toEqual({
    locale: "en",
    request: { groups: groups.map((value, index) => ({ index, value })) },
  });

  await expectSecurityShowsKey(page);

  // Locked and unlocked again: the vault has its key, so none is offered.
  await page
    .getByRole("button", {
      name: en("interface.VaultLibrary.unlockedLockNow"),
      exact: true,
    })
    .click();
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page
    .getByRole("button", { name: en("unlock.submit"), exact: true })
    .click();
  await expect(myRecords(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("a vault without a recovery key is offered one at unlock, which asks for the passphrase before making it", async ({
  page,
}) => {
  const key = fakeRecoveryKey("offered at unlock");
  await fakeVaultWith(page, {
    start: "locked",
    recoveryKey: null,
    newRecoveryKey: key,
  });
  await page.goto("/");
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page
    .getByRole("button", { name: en("unlock.submit"), exact: true })
    .click();

  // Offered, with no key made until the patient asks.
  const dialog = page.getByRole("dialog");
  await expect(stepHeading(dialog, "recoveryKey.title.setUp")).toBeVisible();
  await expect(
    dialog.getByText(en("recoveryKey.about.offered"), { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: en("recoveryKey.leave.offered"),
      exact: true,
    }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_recovery_key_begin")).toEqual([]);

  // A wrong passphrase is said in the dialog, and no key is shown.
  const passphrase = dialog.getByLabel(en("passphrase.label"), { exact: true });
  const proceed = dialog.getByRole("button", {
    name: en("recoveryKey.continue"),
    exact: true,
  });
  await passphrase.fill("FAKE wrong passphrase");
  await proceed.click();
  await expect(dialog.getByRole("alert")).toHaveText(en("native.error.16"));
  await expect(stepHeading(dialog, "recoveryKey.title.setUp")).toBeVisible();
  await expect(passphrase).toHaveValue("");

  // The right one shows the key; typed back at once, it is stored.
  await passphrase.fill(FAKE_PASSPHRASE);
  await proceed.click();
  await expect(stepHeading(dialog, "recoveryKey.title.key")).toBeVisible();
  await expectKeyShown(dialog, key);
  expect(await fakeCalls(page, "vault_recovery_key_begin")).toEqual([
    { request: { passphrase: "FAKE wrong passphrase" } },
    { request: { passphrase: FAKE_PASSPHRASE } },
  ]);
  await dialog
    .getByRole("button", { name: en("recoveryKey.next"), exact: true })
    .click();
  await typeBack(dialog, key);
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText(
      en("interface.VaultLibrary.recoveryKeySavedKeepYourKitSomewhere"),
      { exact: true },
    ),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_recovery_key_confirm")).toEqual([
    {
      locale: "en",
      request: {
        groups: key.split("-").map((value, index) => ({ index, value })),
      },
    },
  ]);

  await expectSecurityShowsKey(page);
  await expectOnlyFakedCommands(page);
});
