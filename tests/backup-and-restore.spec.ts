import { expect, test } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_IDS,
  FAKE_PASSPHRASE,
  fakeCalls,
  fakeCommands,
  fakeVaultWith,
  myRecords,
  scriptFake,
  sidebar,
} from "./support/vaultFake";

// The two halves of keeping a vault safe: saving an encrypted backup from
// Security, and restoring one at the unlock screen. The native side is faked
// (support/vaultFake.ts): the fake's backup is what the restore picker
// chooses, and a restore puts the backup's documents in the vault's place,
// locked, as the native side does. Rust tests cover the files themselves.

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

const BACKUP_PASSPHRASE = "FAKE passphrase the backup was made with";

async function openSecurity(page: import("@playwright/test").Page) {
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("security.title"), level: 1 }),
  ).toBeVisible();
}

async function lockNow(page: import("@playwright/test").Page) {
  await page
    .getByRole("button", {
      name: en("interface.VaultLibrary.unlockedLockNow"),
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: en("unlock.title") }),
  ).toBeVisible();
}

async function unlockWith(
  page: import("@playwright/test").Page,
  passphrase: string,
) {
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(passphrase);
  await page.getByRole("button", { name: en("unlock.submit") }).click();
}

test("Save a backup saves where the patient chose and says so, and a cancelled picker changes nothing", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await openSecurity(page);
  const save = page.getByRole("button", {
    name: en("security.backup.save"),
    exact: true,
  });
  await expect(
    page.getByText(en("security.backup.body"), { exact: true }),
  ).toBeVisible();

  // The picker cancelled: said, and no backup written.
  await scriptFake(page, "vault_backup_pick", { resolve: null });
  await save.click();
  await expect(
    page.getByText(
      en("interface.VaultLibrary.noLocationChosenNothingChanged"),
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    (await fakeCommands(page)).filter((c) => c.startsWith("vault_backup_")),
  ).toEqual(["vault_backup_pick"]);

  // Saved: the picker, then the backup to what was picked, then said.
  await save.click();
  await expect(
    page.getByText(
      en("interface.VaultLibrary.encryptedBackupSavedKeepItSomewhereOther"),
      { exact: true },
    ),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_backup_picked")).toEqual([
    { request: { pickId: FAKE_IDS.backupPick } },
  ]);
  // The vault itself is untouched by a backup.
  await expect(save).toBeEnabled();
  await expectOnlyFakedCommands(page);
});

test("Restore from a backup: a wrong passphrase is said, the check says what restoring replaces, and the restored vault opens with the backup's passphrase", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "unlocked",
    backup: {
      replaces: "sameVault",
      documents: ["FAKE Restored letter.pdf", "FAKE Restored results.pdf"],
      passphrase: BACKUP_PASSPHRASE,
    },
  });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await lockNow(page);

  // The restore form is folded under the unlock form.
  await page.getByText(en("restore.summary"), { exact: true }).click();
  const form = page.locator("form.restore-backup");
  await expect(
    form.getByText(en("restore.intro"), { exact: true }),
  ).toBeVisible();
  await form
    .getByRole("button", { name: en("restore.choose"), exact: true })
    .click();
  await expect(form.getByRole("status")).toHaveText(en("restore.chosen"));
  const secret = form.getByLabel(en("restore.passphrase.label"), {
    exact: true,
  });
  const check = form.getByRole("button", {
    name: en("restore.check"),
    exact: true,
  });

  // The vault's own passphrase is not the backup's: refused, in the form.
  await secret.fill(FAKE_PASSPHRASE);
  await check.click();
  await expect(form.getByRole("alert")).toHaveText(en("native.error.08"));
  await expect(
    form.getByRole("button", { name: en("restore.submit"), exact: true }),
  ).toHaveCount(0);

  // The backup's passphrase: the check says what it holds and what restoring
  // does; the same vault's backup needs no further agreement.
  await secret.fill(BACKUP_PASSPHRASE);
  await check.click();
  const status = form.getByRole("status");
  await expect(status).toContainText(en("restore.consequence.same"));
  await expect(form.getByRole("checkbox")).toHaveCount(0);
  const restore = form.getByRole("button", {
    name: en("restore.submit"),
    exact: true,
  });
  await expect(restore).toBeEnabled();
  expect(await fakeCalls(page, "vault_restore_inspect")).toHaveLength(2);

  // Restored: back to the unlock screen, which says so; the pick is used up.
  await restore.click();
  await expect(
    page.getByText(en("notice.restored"), { exact: true }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_restore")).toEqual([
    {
      locale: "en",
      request: {
        pickId: FAKE_IDS.restorePick,
        passphrase: BACKUP_PASSPHRASE,
        replace: true,
      },
    },
  ]);
  await expect(
    form.getByRole("button", { name: en("restore.choose"), exact: true }),
  ).toBeVisible();

  // The old passphrase no longer opens it; the backup's does, on the
  // backup's documents.
  await unlockWith(page, FAKE_PASSPHRASE);
  await expect(
    page.getByText(en("native.error.16"), { exact: true }),
  ).toBeVisible();
  await unlockWith(page, BACKUP_PASSPHRASE);
  await expect(myRecords(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "FAKE Restored letter.pdf", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "FAKE Restored results.pdf",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "FAKE Letter.pdf", exact: true }),
  ).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("restoring another vault's backup needs the patient's agreement first, and a restore refused natively folds the form back to choosing a file", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "locked",
    backup: { replaces: "otherVault", documents: ["FAKE Other.pdf"] },
  });
  await page.goto("/");
  await page.getByText(en("restore.summary"), { exact: true }).click();
  const form = page.locator("form.restore-backup");
  await form
    .getByRole("button", { name: en("restore.choose"), exact: true })
    .click();
  await form
    .getByLabel(en("restore.passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await form
    .getByRole("button", { name: en("restore.check"), exact: true })
    .click();
  await expect(form.getByRole("status")).toContainText(
    en("restore.consequence.otherVault"),
  );
  const agree = form.getByRole("checkbox", {
    name: en("restore.agree.erase"),
    exact: true,
  });
  const restore = form.getByRole("button", {
    name: en("restore.submit"),
    exact: true,
  });
  await expect(agree).toBeVisible();
  await expect(restore).toBeDisabled();
  await agree.check();
  await expect(restore).toBeEnabled();

  // The native side refuses (the file changed since the check): said in the
  // form, which starts again from choosing a file; nothing restored.
  await scriptFake(page, "vault_restore", {
    reject: {
      code: "changed",
      message: en("native.error.42"),
      messageKey: "native.error.42",
    },
  });
  await restore.click();
  await expect(form.getByRole("alert")).toHaveText(en("native.error.42"));
  await expect(
    form.getByRole("button", { name: en("restore.choose"), exact: true }),
  ).toBeFocused();
  await expect(restore).toHaveCount(0);
  await expect(
    page.getByText(en("notice.restored"), { exact: true }),
  ).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});
