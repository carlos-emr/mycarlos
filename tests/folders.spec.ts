import { expect, test } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_IDS,
  fakeUuid,
  fakeCalls,
  fakeSnapshot,
  fakeVaultWith,
  myRecords,
  openDetails,
  refusal,
  scriptFake,
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
    {
      request: {
        profileId: FAKE_IDS.profile,
        parentId: null,
        name: "FAKE Imaging",
      },
    },
    {
      request: {
        profileId: FAKE_IDS.profile,
        parentId: fakeUuid(303),
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
    { request: { recordIds: [FAKE_IDS.letter], folderIds: [fakeUuid(303)] } },
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
    request: { recordId: FAKE_IDS.letter, folderIds: [fakeUuid(304)] },
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

test("a refused bulk move keeps both selections and the destination for an explicit keyboard retry", async ({
  page,
}, testInfo) => {
  // This exercises the browser UI and the stateful scripted bridge, not native
  // filesystem failure or transaction behavior.
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await newFolder(page, "FAKE Imaging");

  // Search includes documents in folders, so this is a two-document move
  // from different starting locations rather than a single selected row.
  const search = page.getByRole("searchbox", {
    name: en("interface.search.all", { location: en("sidebar.myRecords") }),
    exact: true,
  });
  await search.fill(".pdf");
  const names = ["FAKE Bloodwork.pdf", "FAKE Letter.pdf"];
  const selection = (name: string) =>
    page.getByRole("button", {
      name: en("library.select", { name }),
      exact: true,
    });
  for (const name of names) await selection(name).click();
  const destination = page.getByLabel(
    en("interface.VaultLibrary.moveSelectedTo"),
    { exact: true },
  );
  await destination.selectOption({ label: "FAKE Imaging" });
  const move = page.getByRole("button", {
    name: en("interface.RecordDetails.move"),
    exact: true,
  });
  const before = await fakeSnapshot(page);
  await scriptFake(page, "vault_assign_folders_batch", {
    reject: refusal("storage", "native.error.35"),
  });
  await move.click();
  const error = page.getByText(en("native.error.35"), { exact: true });
  await expect(error).toBeVisible();
  await expect(move).toBeEnabled();
  await expect(
    page.getByText(en("interface.count.selected", { count: 2 }), {
      exact: true,
    }),
  ).toBeVisible();
  await expect(destination).toHaveValue(fakeUuid(303));
  for (const name of names) {
    await expect(selection(name)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  expect((await fakeSnapshot(page)).records).toEqual(before.records);
  const request = {
    request: {
      recordIds: [FAKE_IDS.record, FAKE_IDS.letter],
      folderIds: [fakeUuid(303)],
    },
  };
  expect(await fakeCalls(page, "vault_assign_folders_batch")).toEqual([
    request,
  ]);
  await testInfo.attach("refused-move-selection-and-destination", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // The refusal does not schedule a retry. Tab from the retained destination
  // to Move and press Enter to make the second, identical request explicitly.
  await destination.focus();
  await page.keyboard.press("Tab");
  await expect(move).toBeFocused();
  expect(await fakeCalls(page, "vault_assign_folders_batch")).toEqual([
    request,
  ]);
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(en("interface.notice.moved", { count: 2 }), { exact: true }),
  ).toBeVisible();
  await expect(error).toHaveCount(0);
  await expect(destination).toHaveCount(0);
  expect(await fakeCalls(page, "vault_assign_folders_batch")).toEqual([
    request,
    request,
  ]);
  for (const name of names)
    await expect(selection(name)).toHaveAttribute("aria-pressed", "false");
  expect((await fakeSnapshot(page)).records).toEqual(
    before.records.map((record) => ({ ...record, folderIds: [fakeUuid(303)] })),
  );

  // Clearing the search shows the source is empty. Both matching rows must
  // then be present in the chosen folder, with no leftover selection.
  await search.fill("");
  for (const name of names)
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  await expect(folderButton(page, "FAKE Imaging")).toHaveText(/2$/);
  await expect(folderButton(page, "FAKE Results")).toHaveText(/0$/);
  await folderButton(page, "FAKE Imaging").click();
  for (const name of names) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    await expect(selection(name)).toHaveAttribute("aria-pressed", "false");
  }
  const details = await openDetailsIn(page, "FAKE Imaging", "FAKE Letter.pdf");
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.closeDocumentDetails"),
      exact: true,
    })
    .click();
  await expect(details).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "FAKE Letter.pdf", exact: true }),
  ).toBeFocused();
  await testInfo.attach("retried-move-destination-rows-and-returned-focus", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  expect(await fakeCalls(page, "vault_assign_folders_batch")).toEqual([
    request,
    request,
  ]);
  expect(await fakeCalls(page, "vault_lock")).toEqual([]);
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
