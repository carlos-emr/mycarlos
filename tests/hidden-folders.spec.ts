import { expect, test, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_IDS,
  fakeCalls,
  fakeUuid,
  fakeVaultWith,
  myRecords,
} from "./support/vaultFake";

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);
const RESULTS = "FAKE Results";
const CHILD = "FAKE Imaging";
const BLOODWORK = "FAKE Bloodwork.pdf";
const OWNER = "FAKE Patient";

const folder = (page: Page, name: string) =>
  page.getByRole("button", {
    name: en("library.folder.open", { name }),
    exact: true,
  });

const hideFolder = (page: Page) =>
  page.getByRole("button", { name: en("hiddenFolders.hide"), exact: true });
const restoreFolder = (page: Page, name: string, location: string) =>
  page.getByRole("button", {
    name: en("hiddenFolders.restoreFor", { name, location }),
    exact: true,
  });
const hiddenFolders = (page: Page) =>
  page.getByRole("list", { name: en("hiddenFolders.title"), exact: true });
const security = (page: Page) =>
  page.getByRole("button", { name: en("security.title"), exact: true });

async function addFolder(page: Page, name: string) {
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
  await expect(folder(page, name)).toBeVisible();
}

async function hideOpenFolder(page: Page) {
  await hideFolder(page).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", {
      name: en("hiddenFolders.hide"),
      exact: true,
    })
    .click();
}

async function expectNoSidewaysScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test("hides a folder with its contents and restores it from Security at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await folder(page, RESULTS).click();
  const heading = page.getByRole("heading", { level: 1, name: RESULTS });
  await expect(heading).toBeVisible();
  const document = page.getByRole("button", { name: BLOODWORK, exact: true });
  await expect(document).toBeVisible();

  await addFolder(page, CHILD);

  const hide = hideFolder(page);
  const confirmation = page.getByRole("alertdialog", {
    name: en("hiddenFolders.confirm", { name: RESULTS }),
    exact: true,
  });
  await hide.focus();
  await page.keyboard.press("Enter");
  await expect(confirmation).toHaveAccessibleDescription(
    en("hiddenFolders.confirmBody"),
  );
  await expect(
    confirmation.getByRole("button", {
      name: en("common.cancel"),
      exact: true,
    }),
  ).toBeFocused();
  await expectNoSidewaysScroll(page);
  await page.keyboard.press("Escape");
  await expect(hide).toBeFocused();
  expect(await fakeCalls(page, "vault_hide_folder")).toEqual([]);
  await page.keyboard.press("Enter");
  await confirmation
    .getByRole("button", { name: en("hiddenFolders.hide"), exact: true })
    .press("Enter");

  await expect(myRecords(page)).toBeFocused();
  await expect(folder(page, RESULTS)).toHaveCount(0);
  const search = page.getByRole("searchbox");
  await search.fill("FAKE");
  await expect(
    page.getByRole("button", { name: "FAKE Letter.pdf", exact: true }),
  ).toBeVisible();
  await expect(document).toHaveCount(0);
  await expect(folder(page, CHILD)).toHaveCount(0);
  await search.clear();

  const tabs = page.getByRole("navigation", {
    name: en("interface.VaultLibrary.section"),
    exact: true,
  });
  await security(page).click();
  const list = hiddenFolders(page);
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByRole("listitem")).toContainText(
    en("hiddenPeople.documents", { count: 1 }),
  );
  await expectNoSidewaysScroll(page);

  await restoreFolder(page, RESULTS, OWNER).press("Enter");
  await expect(list).toHaveCount(0);
  await tabs
    .getByRole("button", {
      name: en("interface.VaultLibrary.records"),
      exact: true,
    })
    .click();
  await folder(page, RESULTS).click();
  await expect(heading).toBeVisible();
  await expect(folder(page, CHILD)).toBeVisible();
  await expect(document).toBeVisible();
  for (const command of ["vault_hide_folder", "vault_restore_folder"])
    expect(await fakeCalls(page, command)).toEqual([
      { request: { folderId: FAKE_IDS.folder } },
    ]);
  await expectOnlyFakedCommands(page);
});

test("restores the intended same-name folder by person and visible parent", async ({
  page,
}) => {
  const secondPerson = "FAKE Second Patient";
  await page.setViewportSize({ width: 320, height: 720 });
  await fakeVaultWith(page, {
    start: "unlocked",
    people: [{ displayName: secondPerson }],
    hiddenFolders: [RESULTS],
  });
  await page.goto("/");
  await page.getByRole("button", { name: secondPerson, exact: true }).click();
  await addFolder(page, CHILD);
  await folder(page, CHILD).click();
  await addFolder(page, RESULTS);
  await folder(page, RESULTS).click();
  await hideOpenFolder(page);
  await expect(
    page.getByRole("heading", { name: CHILD, level: 1 }),
  ).toBeFocused();
  await hideOpenFolder(page);
  await expect(
    page.getByRole("heading", { name: secondPerson, level: 1 }),
  ).toBeFocused();

  await security(page).click();
  const firstPersonFolder = restoreFolder(page, RESULTS, OWNER);
  const secondPersonFolder = restoreFolder(
    page,
    RESULTS,
    `${secondPerson} / ${CHILD}`,
  );
  await expect(firstPersonFolder).toBeVisible();
  await expect(secondPersonFolder).toHaveCount(0);
  await restoreFolder(page, CHILD, secondPerson).click();
  await expect(hiddenFolders(page).getByRole("listitem")).toHaveCount(2);
  await expect(secondPersonFolder).toBeVisible();
  await secondPersonFolder.click();
  await expect(hiddenFolders(page).getByRole("listitem")).toHaveCount(1);
  await expect(firstPersonFolder).toBeVisible();
  expect(await fakeCalls(page, "vault_restore_folder")).toEqual([
    { request: { folderId: fakeUuid(303) } },
    { request: { folderId: fakeUuid(304) } },
  ]);
  await expectOnlyFakedCommands(page);
});

test("counts a missing document in a hidden folder without naming it", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "unlocked",
    hiddenFolders: [RESULTS],
    missingFiles: [BLOODWORK],
  });
  await page.goto("/");
  const banner = page.getByRole("alert").filter({
    hasText: en("interface.VaultLibrary.changesArePaused"),
  });
  await banner
    .getByRole("button", {
      name: en("interface.VaultLibrary.hideDamagedDocuments"),
      exact: true,
    })
    .click();
  const confirmation = page.getByRole("alertdialog", {
    name: en("interface.hideDamaged.title", { count: 1 }),
    exact: true,
  });
  await expect(confirmation).toContainText(
    en("hiddenFolders.damagedToo", { count: 1 }),
  );
  await expect(confirmation).not.toContainText(BLOODWORK);
  await expect(confirmation).not.toContainText(RESULTS);
  await confirmation
    .getByRole("button", {
      name: en("interface.RecordDetails.hide"),
      exact: true,
    })
    .click();
  await expect(banner).toHaveCount(0);
  expect(await fakeCalls(page, "vault_hide_unavailable_records")).toEqual([
    {
      request: {
        confirmed: [],
        hiddenPeopleDocuments: 0,
        hiddenFolderDocuments: 1,
      },
    },
  ]);
  await expectOnlyFakedCommands(page);
});

test("discloses that hidden folders stay hidden before saving a handover", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", hiddenFolders: [RESULTS] });
  await page.goto("/");
  await page
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await page
    .getByRole("button", { name: en("handover.export.button"), exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const next = dialog.getByRole("button", {
    name: en("handover.export.continue"),
    exact: true,
  });
  await next.click();
  await dialog.getByLabel(en("handover.export.keySaved")).check();
  await next.click();
  await expect(dialog).toContainText(
    en("hiddenFolders.handover", { count: 1 }),
  );
  await expect(dialog).not.toContainText(RESULTS);
  await expect(
    dialog.getByRole("button", { name: en("handover.export.chooseWhere") }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_profile_export_pick")).toEqual([]);
  await expectOnlyFakedCommands(page);
});
