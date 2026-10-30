import { expect, test } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  fakeCalls,
  fakeVaultWith,
  myRecords,
  openDetails,
  sidebar,
} from "./support/vaultFake";

// Folders: a new folder in My records, a folder inside it, several documents
// moved into a folder from the selection bar, one moved into the nested
// folder from its details, and the sidebar's counts following. The native
// side is faked (support/vaultFake.ts).

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

const folderButton = (page: import("@playwright/test").Page, name: string) =>
  sidebar(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });

async function newFolder(page: import("@playwright/test").Page, name: string) {
  await page
    .getByRole("button", {
      name: en("interface.VaultLibrary.newFolder"),
      exact: true,
    })
    .click();
  await page.getByLabel(en("rename.label.folder"), { exact: true }).fill(name);
  await page
    .getByRole("button", {
      name: en("interface.VaultLibrary.create"),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(en("interface.notice.folderCreated", { name }), {
      exact: true,
    }),
  ).toBeVisible();
}

test("a folder, a folder inside it, documents moved in from the selection bar and from details, and the counts", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();

  // A new folder in My records, then one inside it.
  await newFolder(page, "FAKE Imaging");
  await expect(folderButton(page, "FAKE Imaging")).toBeVisible();
  await folderButton(page, "FAKE Imaging").click();
  await expect(
    page.getByRole("heading", { name: "FAKE Imaging", level: 1 }),
  ).toBeVisible();
  await newFolder(page, "FAKE 2024");
  expect(await fakeCalls(page, "vault_create_folder")).toEqual([
    { request: { profileId: "profile", parentId: null, name: "FAKE Imaging" } },
    {
      request: {
        profileId: "profile",
        parentId: "folder-3",
        name: "FAKE 2024",
      },
    },
  ]);

  // The document in My records, selected and moved into the folder from
  // the selection bar (the other document is in FAKE Results).
  await sidebar(page)
    .getByRole("button", { name: new RegExp(`^${en("sidebar.myRecords")}\\b`) })
    .click();
  await expect(myRecords(page)).toBeVisible();
  await page
    .getByRole("button", {
      name: en("library.select", { name: "FAKE Letter.pdf" }),
      exact: true,
    })
    .click();
  await page
    .getByLabel(en("interface.VaultLibrary.moveSelectedTo"), { exact: true })
    .selectOption({ label: "FAKE Imaging" });
  await page
    .getByRole("button", {
      name: en("interface.RecordDetails.move"),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(en("interface.notice.moved", { count: 1 }), { exact: true }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_assign_folders_batch")).toEqual([
    { request: { recordIds: ["letter"], folderIds: ["folder-3"] } },
  ]);
  await expect(
    page.getByRole("button", { name: "FAKE Letter.pdf", exact: true }),
  ).toHaveCount(0);
  await expect(folderButton(page, "FAKE Imaging")).toHaveText(/1$/);

  // One of them on into the nested folder, from its details.
  await folderButton(page, "FAKE Imaging").click();
  const details = await openDetailsIn(page, "FAKE Imaging", "FAKE Letter.pdf");
  // One person: the move control is the plain folder select.
  await details.getByRole("combobox").first().selectOption({
    label: "FAKE 2024",
  });
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.move"),
      exact: true,
    })
    .click();
  expect((await fakeCalls(page, "vault_assign_folders")).at(-1)).toEqual({
    request: { recordId: "letter", folderIds: ["folder-4"] },
  });
  await expect(
    page.getByRole("button", { name: "FAKE Letter.pdf", exact: true }),
  ).toHaveCount(0);
  // The details stay open after a move.
  await page
    .getByRole("button", {
      name: en("interface.RecordDetails.closeDocumentDetails"),
      exact: true,
    })
    .click();
  await folderButton(page, "FAKE 2024").click();
  await expect(
    page.getByRole("heading", { name: "FAKE 2024", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "FAKE Letter.pdf", exact: true }),
  ).toBeVisible();

  // The storage line counts every document and folder.
  await expect(
    page.getByText(en("sidebar.documents", { count: 2 }), { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText(en("sidebar.folderCount", { count: 4 }), { exact: false }),
  ).toBeVisible();
  await expectOnlyFakedCommands(page);
});

/** Opens a document's details from the folder that is open. */
async function openDetailsIn(
  page: import("@playwright/test").Page,
  folder: string,
  name: string,
) {
  await expect(
    page.getByRole("heading", { name: folder, level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name, exact: true }).click();
  const details = page.getByRole("dialog", { name, exact: true });
  await expect(details).toBeVisible();
  return details;
}
// openDetails is kept for My records.
void openDetails;
