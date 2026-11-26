import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_KEY_LABEL,
  FAKE_NEW_KEY_LABEL,
  FAKE_PASSPHRASE,
  fakeCalls,
  fakeRecoveryKey,
  fakeSnapshot,
  fakeVaultWith,
  myRecords,
  sidebar,
} from "./support/vaultFake";

// Replacing a recovery key the vault already has, from Security: the dialog
// asks why (a kit that may have been lost or seen, or just a new key), the
// passphrase makes the new key, its kit is saved and it is typed back whole.
// A kit that may have been lost or seen still opens older backups, so
// Security then walks the patient through saving a new backup and deleting
// the older ones, and keeps those steps across a reload; a routine
// replacement leaves no such steps. The native side is faked
// (support/vaultFake.ts); the keys are derived at run time and are FAKE.

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

const GUIDE_STORAGE = "mycarlos.oldBackupsGuide.v1";
const BACKUP_NAME = `myCarlos backup FAKE ${FAKE_KEY_LABEL}.mycarlosbackup`;

async function openSecurity(page: Page) {
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("security.title"), level: 1 }),
  ).toBeVisible();
}

const storedGuide = (page: Page) =>
  page.evaluate((key) => window.localStorage.getItem(key), GUIDE_STORAGE);

/** From Security's Replace recovery key to the new key stored: the reason,
 * the passphrase, the key shown with its new label, the kit, the check. */
async function replaceKey(
  page: Page,
  key: string,
  reason: "recoveryKey.reason.exposed" | "recoveryKey.reason.routine",
) {
  const button = page.getByRole("button", {
    name: en("security.recoveryKey.replace"),
    exact: true,
  });
  await expect(page.getByText(FAKE_KEY_LABEL, { exact: true })).toBeVisible();
  await button.click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", {
      name: en("recoveryKey.title.replace"),
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByText(en("recoveryKey.about.replacing"), { exact: true }),
  ).toBeVisible();
  const passphrase = dialog.getByLabel(en("passphrase.label"), {
    exact: true,
  });
  const next = dialog.getByRole("button", {
    name: en("recoveryKey.continue"),
    exact: true,
  });
  await passphrase.fill(FAKE_PASSPHRASE);
  await next.click();
  // The reason is asked before anything is made.
  await expect(dialog.getByRole("alert")).toHaveText(
    en("recoveryKey.chooseReason"),
  );
  expect(await fakeCalls(page, "vault_recovery_key_begin")).toEqual([]);
  await dialog.getByRole("radio", { name: en(reason), exact: true }).check();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await passphrase.fill(FAKE_PASSPHRASE);
  await next.click();

  // The new key, under its new label; the kit; the whole key typed back.
  await expect(
    dialog.getByRole("heading", { name: en("recoveryKey.title.key") }),
  ).toBeVisible();
  const groups = key.split("-");
  const items = dialog
    .getByRole("list", { name: en("recover.key.label"), exact: true })
    .getByRole("listitem");
  await expect(items).toHaveCount(groups.length);
  for (const [index, group] of groups.entries())
    await expect(items.nth(index)).toContainText(group);
  await expect(dialog).toContainText(FAKE_NEW_KEY_LABEL);
  expect(await fakeCalls(page, "vault_recovery_key_begin")).toEqual([
    { request: { passphrase: FAKE_PASSPHRASE } },
  ]);
  await dialog
    .getByRole("button", { name: en("recoveryKey.saveKit"), exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText(
    en("recoveryKey.kitSaved"),
  );
  await dialog
    .getByRole("button", { name: en("recoveryKey.next"), exact: true })
    .click();
  await dialog
    .getByLabel(en("recoveryKey.check.label"), { exact: true })
    .fill(groups.join(" "));
  await dialog
    .getByRole("button", { name: en("recoveryKey.checkAndSave"), exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const confirms = await fakeCalls(page, "vault_recovery_key_confirm");
  expect(confirms).toHaveLength(1);
  expect(confirms[0].request).toEqual({
    groups: groups.map((value, index) => ({ index, value })),
  });
  const stored = await fakeSnapshot(page);
  expect(stored.recoveryKeyLabel).toBe(FAKE_NEW_KEY_LABEL);
  expect(stored.recoveryKeySetAtMs).not.toBeNull();
}

const olderBackups = (page: Page): Locator =>
  page.getByRole("region", {
    name: en("security.oldBackups.title"),
    exact: true,
  });

test("a key whose kit may have been lost or seen is replaced: the older backups' steps follow, from saving a new backup to deleting the rest, and survive a reload", async ({
  page,
}) => {
  const key = fakeRecoveryKey("replacement after a lost kit");
  await fakeVaultWith(page, { start: "unlocked", newRecoveryKey: key });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await openSecurity(page);
  await replaceKey(page, key, "recoveryKey.reason.exposed");

  // Said with what it means for older backups, and the steps are kept.
  await expect(
    page.getByText(
      en("interface.recovery.replaced", {
        backups: en("interface.oldBackups.yourOldKitCouldStillOpenBackups"),
      }),
      { exact: true },
    ),
  ).toBeVisible();
  expect(await storedGuide(page)).toBe(JSON.stringify({ step: "save" }));

  // Security: the new key's label, and the first step, a new backup.
  await openSecurity(page);
  await expect(
    page.getByText(FAKE_NEW_KEY_LABEL, { exact: true }),
  ).toBeVisible();
  const guide = olderBackups(page);
  await expect(guide).toBeVisible();
  await expect(guide).toContainText(en("security.oldBackups.saveNow"));
  await expect(guide).toContainText(en("security.oldBackups.thenDelete"));
  await expect(
    guide.getByRole("button", {
      name: en("security.oldBackups.none"),
      exact: true,
    }),
  ).toBeVisible();

  // A reload (the vault locked, as a restart leaves it) keeps the steps:
  // they are in webview storage, not in the vault.
  await page.reload();
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page
    .getByRole("button", { name: en("unlock.submit"), exact: true })
    .click();
  await expect(myRecords(page)).toBeVisible();
  await openSecurity(page);
  await expect(olderBackups(page)).toContainText(
    en("security.oldBackups.saveNow"),
  );

  // The backup saved: said as the new backup to keep, and the steps now
  // name the file and say to delete the older ones.
  await page
    .getByRole("button", { name: en("security.backup.save"), exact: true })
    .click();
  await expect(
    page.getByText(
      en("interface.VaultLibrary.encryptedBackupSavedThisIsYourNew"),
      { exact: true },
    ),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_backup_picked")).toHaveLength(1);
  await expect(olderBackups(page)).toContainText(BACKUP_NAME);
  await expect(olderBackups(page)).toContainText(
    en("security.oldBackups.deleteOlder"),
  );
  await expect(olderBackups(page)).not.toContainText(
    en("security.oldBackups.saveNow"),
  );
  const kept = JSON.parse((await storedGuide(page)) ?? "null") as {
    step: string;
    keep: string | null;
  };
  expect(kept).toMatchObject({ step: "delete", keep: BACKUP_NAME });

  // Done: the steps go, here and from storage.
  await olderBackups(page)
    .getByRole("button", { name: en("security.oldBackups.done"), exact: true })
    .click();
  await expect(olderBackups(page)).toHaveCount(0);
  expect(await storedGuide(page)).toBeNull();
  await expectOnlyFakedCommands(page);
});

test("a key replaced just for a new one leaves the older backups alone: no steps, nothing stored", async ({
  page,
}) => {
  const key = fakeRecoveryKey("routine replacement");
  await fakeVaultWith(page, { start: "unlocked", newRecoveryKey: key });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await openSecurity(page);
  await replaceKey(page, key, "recoveryKey.reason.routine");
  await expect(
    page.getByText(
      en("interface.recovery.replaced", {
        backups: en("interface.oldBackups.eachBackupYouSavedBeforeNowStill"),
      }),
      { exact: true },
    ),
  ).toBeVisible();
  expect(await storedGuide(page)).toBeNull();
  await openSecurity(page);
  await expect(
    page.getByText(FAKE_NEW_KEY_LABEL, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(FAKE_KEY_LABEL, { exact: true })).toHaveCount(0);
  await expect(olderBackups(page)).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});
