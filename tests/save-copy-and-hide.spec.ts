import { expect, test } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_PASSPHRASE,
  escapeRegExp,
  fakeCalls,
  fakeCommands,
  fakeVaultWith,
  myRecords,
  openDetails,
  scriptFake,
  sidebar,
} from "./support/vaultFake";

// Two things a patient does with a document every week: save a readable copy
// to the computer (asked first, as it leaves the vault), and hide it (#71:
// nothing is ever deleted), then find it under Security > Hidden and restore
// it. The native side is faked (support/vaultFake.ts), keeping the vault
// across a reload as the native side does; Rust tests cover what it writes.

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

const LETTER = "FAKE Letter.pdf";

test("Save a copy asks first, then saves the document where the patient chose, and a cancelled picker changes nothing", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  const details = await openDetails(page, LETTER);
  const saveCopy = details.getByRole("button", {
    name: en("interface.RecordDetails.saveACopyToThisComputer"),
    exact: true,
  });
  const confirm = page.getByRole("alertdialog", {
    name: en("interface.VaultLibrary.saveAReadableCopy"),
    exact: true,
  });
  const exports = async () =>
    (await fakeCommands(page)).filter((command) =>
      command.startsWith("vault_export_"),
    );

  // Cancel in the question: nothing is asked of the native side.
  await saveCopy.click();
  await expect(confirm).toBeVisible();
  await expect(
    confirm.getByText(
      en("interface.VaultLibrary.savingCreatesAReadableFileOutsideThe"),
      { exact: true },
    ),
  ).toBeVisible();
  await confirm
    .getByRole("button", { name: en("common.cancel"), exact: true })
    .click();
  await expect(confirm).toBeHidden();
  await expect(saveCopy).toBeVisible();
  expect(await exports()).toEqual([]);

  // Save a copy: the picker, then the copy to what was picked, then said.
  await saveCopy.click();
  await confirm
    .getByRole("button", {
      name: en("interface.VaultLibrary.saveACopy"),
      exact: true,
    })
    .click();
  await expect(confirm).toBeHidden();
  await expect(details.getByRole("status")).toHaveText(
    en("interface.notice.copySaved"),
  );
  expect(await exports()).toEqual(["vault_export_pick", "vault_export_picked"]);
  expect(await fakeCalls(page, "vault_export_pick")).toEqual([
    { request: { recordId: "letter" } },
  ]);
  expect(await fakeCalls(page, "vault_export_picked")).toEqual([
    { request: { pickId: "FAKE-export-pick", recordId: "letter" } },
  ]);

  // The picker cancelled: said, and no copy is written.
  await scriptFake(page, "vault_export_pick", { resolve: null });
  await saveCopy.click();
  await confirm
    .getByRole("button", {
      name: en("interface.VaultLibrary.saveACopy"),
      exact: true,
    })
    .click();
  await expect(details.getByRole("status")).toHaveText(
    en("interface.VaultLibrary.saveCancelledNothingChanged"),
  );
  expect(await exports()).toEqual([
    "vault_export_pick",
    "vault_export_picked",
    "vault_export_pick",
  ]);
  await expectOnlyFakedCommands(page);
});

test("Hide takes a document out of view, Security > Hidden keeps it across a reload, and Restore puts it back", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  const details = await openDetails(page, LETTER);
  const row = page.getByRole("button", { name: LETTER, exact: true });

  // Hidden at once, with no question: said, and gone from My records.
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.hide"),
      exact: true,
    })
    .click();
  await expect(details).toBeHidden();
  const hiddenNotice = en("interface.notice.hidden", { name: LETTER });
  await expect(page.getByText(hiddenNotice, { exact: true })).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(await fakeCalls(page, "vault_hide_record")).toEqual([
    { request: { recordId: "letter" } },
  ]);

  // Still hidden after the vault is locked and the window reloads: it is the
  // vault's state, not the page's. (The folders show that My records has been
  // drawn from the vault again.)
  await page
    .getByRole("button", {
      name: en("interface.VaultLibrary.unlockedLockNow"),
      exact: true,
    })
    .click();
  await page.reload();
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page
    .getByRole("button", { name: en("unlock.submit"), exact: true })
    .click();
  await expect(myRecords(page)).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: en("library.folder.open", { name: "FAKE Results" }),
      exact: true,
    }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);

  // Security > Hidden lists it, with where it was.
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  // Its button says how many are hidden, and from where.
  const hiddenLabel = en("interface.HiddenDocuments.hidden");
  const entry = (count: number) =>
    page.getByRole("button", {
      name: new RegExp(
        `^${escapeRegExp(hiddenLabel)}\\s+${count}\\s+${escapeRegExp(en("sidebar.myRecords"))}$`,
      ),
    });
  await entry(1).click();
  await expect(
    page.getByRole("heading", { name: hiddenLabel, exact: true, level: 1 }),
  ).toBeVisible();
  const listed = page.getByRole("article", {
    name: en("interface.hidden.record", { name: LETTER }),
    exact: true,
  });
  await expect(listed).toBeVisible();
  await expect(listed).toContainText(en("sidebar.myRecords"));

  // Restore: said, the list is empty, and Security counts none.
  await listed
    .getByRole("button", {
      name: en("interface.hidden.restore", { name: LETTER }),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(en("interface.notice.restored", { name: LETTER }), {
      exact: true,
    }),
  ).toBeVisible();
  await expect(listed).toHaveCount(0);
  await expect(
    page.getByText(en("interface.HiddenDocuments.nothingIsHidden"), {
      exact: true,
    }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_unhide_record")).toEqual([
    { request: { recordId: "letter" } },
  ]);
  await page
    .getByRole("button", { name: en("hidden.backToSecurity"), exact: true })
    .click();
  await expect(entry(0)).toBeVisible();

  // Back where it was, in My records.
  await sidebar(page)
    .getByRole("button", {
      name: new RegExp(`^${escapeRegExp(en("sidebar.myRecords"))}\\b`),
    })
    .click();
  await expect(myRecords(page)).toBeVisible();
  await expect(row).toBeVisible();
  await expectOnlyFakedCommands(page);
});
