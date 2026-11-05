import { expect, test } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_IDS,
  fakeUuid,
  FAKE_PAGE_COUNT,
  fakeCalls,
  fakePickFiles,
  fakeVaultWith,
  myRecords,
} from "./support/vaultFake";

// Adding documents the native way: the picker, the import of what it chose
// into the folder that is open, duplicates skipped and said, a cancelled
// picker changing nothing, and the new document opening in the reader. The
// native side is faked (support/vaultFake.ts): the test says what the picker
// "chooses". Rust tests cover the encryption and the duplicate check.

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

test("Add documents: a cancelled picker changes nothing, chosen files are added and said, a duplicate is skipped and said, into the open folder, and the new document opens", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const add = page.getByRole("button", {
    name: en("interface.VaultApp.chooseFilesToImport"),
    exact: true,
  });
  const row = (name: string) => page.getByRole("button", { name, exact: true });

  // Cancelled: said, and nothing imported.
  await add.click();
  await expect(
    page.getByText(en("interface.VaultLibrary.noFilesSelectedNothingChanged"), {
      exact: true,
    }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_import_picked")).toEqual([]);

  // Two files chosen: both added, into My records.
  await fakePickFiles(page, ["FAKE Scan one.pdf", "FAKE Scan two.pdf"]);
  await add.click();
  await expect(
    page.getByText(en("interface.notice.imported", { count: 2 }), {
      exact: true,
    }),
  ).toBeVisible();
  await expect(row("FAKE Scan one.pdf")).toBeVisible();
  await expect(row("FAKE Scan two.pdf")).toBeVisible();
  expect(await fakeCalls(page, "vault_import_picked")).toEqual([
    {
      request: {
        pickId: FAKE_IDS.importPick,
        profileId: FAKE_IDS.profile,
        folderIds: [],
      },
    },
  ]);

  // One of them again, with a new one: the duplicate is skipped and said.
  await fakePickFiles(page, ["FAKE Scan one.pdf", "FAKE Scan three.pdf"]);
  await add.click();
  await expect(
    page.getByText(
      `${en("interface.notice.imported", { count: 1 })} ${en("interface.notice.duplicates", { count: 1 })}`,
      { exact: true },
    ),
  ).toBeVisible();
  await expect(row("FAKE Scan three.pdf")).toBeVisible();
  await expect(row("FAKE Scan one.pdf")).toHaveCount(1);

  // Into the folder that is open.
  await page
    .getByRole("button", {
      name: en("library.folder.open", { name: "FAKE Results" }),
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "FAKE Results", level: 1 }),
  ).toBeVisible();
  await fakePickFiles(page, ["FAKE Scan four.pdf"]);
  await add.click();
  await expect(
    page.getByText(en("interface.notice.imported", { count: 1 }), {
      exact: true,
    }),
  ).toBeVisible();
  await expect(row("FAKE Scan four.pdf")).toBeVisible();
  expect((await fakeCalls(page, "vault_import_picked")).at(-1)).toEqual({
    request: {
      pickId: fakeUuid(1002),
      profileId: FAKE_IDS.profile,
      folderIds: [FAKE_IDS.folder],
    },
  });

  // The new document opens in the reader (from the folder, so not through
  // openDetails, which starts from My records).
  await row("FAKE Scan four.pdf").click();
  const details = page.getByRole("dialog", {
    name: "FAKE Scan four.pdf",
    exact: true,
  });
  await expect(details).toBeVisible();
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.read"),
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("img", {
      name: en("interface.reader.textFollows", {
        page: 1,
        total: FAKE_PAGE_COUNT,
      }),
      exact: true,
    }),
  ).toBeVisible();
  await expectOnlyFakedCommands(page);
});
