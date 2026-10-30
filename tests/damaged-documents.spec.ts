import { expect, test } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  escapeRegExp,
  fakeCalls,
  fakeVaultWith,
  myRecords,
  openDetails,
  scriptFake,
  sidebar,
} from "./support/vaultFake";

// A vault whose encrypted files are partly missing opens in recovery mode:
// changes are paused, the damaged document is marked and cannot be read, and
// hiding the damaged documents (asked first, naming them) lets the vault take
// changes again; the hidden list keeps them as damaged, without Restore until
// the file is back. The native side is faked (support/vaultFake.ts).

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

test("a missing file pauses changes and marks the document; hiding it is asked first, said, and lets changes resume; Hidden keeps it as damaged without Restore", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", missingFiles: [LETTER] });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();

  // Recovery mode: the banner, the marked row, nothing can be added.
  const banner = page.getByRole("alert").filter({
    hasText: en("interface.VaultLibrary.changesArePaused"),
  });
  await expect(banner).toContainText(
    en("interface.VaultLibrary.someEncryptedFilesAreMissingFromThis"),
  );
  // The document's row (its container carries the document's label).
  const row = page.getByLabel(en("library.document.label", { name: LETTER }), {
    exact: true,
  });
  await expect(row).toContainText(
    en("interface.VaultLibrary.damagedFileMissing"),
  );
  await expect(
    page.getByRole("button", {
      name: en("interface.VaultApp.chooseFilesToImport"),
      exact: true,
    }),
  ).toBeDisabled();
  const details = await openDetails(page, LETTER);
  await expect(details.getByRole("alert")).toContainText(
    en("interface.RecordDetails.thisDocumentIsDamaged"),
  );
  await expect(details.getByRole("alert")).toContainText(
    en("interface.RecordDetails.itsEncryptedFileIsMissingFromThis"),
  );
  await expect(
    details.getByRole("button", {
      name: en("interface.RecordDetails.read"),
      exact: true,
    }),
  ).toBeDisabled();
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.closeDocumentDetails"),
      exact: true,
    })
    .click();

  // Hide the damaged documents: asked first, naming them; a refusal (the
  // list changed) is said and leaves the vault paused.
  const hide = banner.getByRole("button", {
    name: en("interface.VaultLibrary.hideDamagedDocuments"),
    exact: true,
  });
  await hide.click();
  const confirm = page.getByRole("alertdialog", {
    name: en("interface.hideDamaged.title", { count: 1 }),
    exact: true,
  });
  await expect(confirm).toBeVisible();
  await expect(
    confirm.getByRole("list", {
      name: en("interface.VaultLibrary.documentsToHide"),
      exact: true,
    }),
  ).toContainText(LETTER);
  await scriptFake(page, "vault_hide_unavailable_records", {
    reject: {
      code: "list_changed",
      message: en("native.error.38"),
      messageKey: "native.error.38",
    },
  });
  await confirm
    .getByRole("button", {
      name: en("interface.RecordDetails.hide"),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(en("native.error.38"), { exact: true }),
  ).toBeVisible();
  await expect(banner).toBeVisible();

  // Hidden: said, with changes resumed; the banner goes; the native side was
  // told exactly which documents this screen showed as damaged.
  await hide.click();
  await confirm
    .getByRole("button", {
      name: en("interface.RecordDetails.hide"),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      en("interface.notice.changesResumed", {
        outcome: en("interface.notice.damagedHidden", { count: 1 }),
      }),
      { exact: true },
    ),
  ).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect(row).toHaveCount(0);
  expect(await fakeCalls(page, "vault_hide_unavailable_records")).toEqual([
    { request: { confirmed: ["letter"] } },
    { request: { confirmed: ["letter"] } },
  ]);
  await expect(
    page.getByRole("button", {
      name: en("interface.VaultApp.chooseFilesToImport"),
      exact: true,
    }),
  ).toBeEnabled();

  // Security > Hidden lists it as damaged, with no Restore while its file is
  // missing.
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await page
    .getByRole("button", {
      name: new RegExp(
        `^${escapeRegExp(en("interface.HiddenDocuments.hidden"))}\\s+1\\s+`,
      ),
    })
    .click();
  const listed = page.getByRole("article", {
    name: en("interface.hidden.record", { name: LETTER }),
    exact: true,
  });
  await expect(listed).toBeVisible();
  await expect(listed).toContainText(en("interface.hidden.fileMissing"));
  await expect(
    listed.getByRole("button", {
      name: en("interface.hidden.restore", { name: LETTER }),
      exact: true,
    }),
  ).toHaveCount(0);
  expect(await fakeCalls(page, "vault_unhide_record")).toEqual([]);
  await expectOnlyFakedCommands(page);
});
