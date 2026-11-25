import { expect, test } from "@playwright/test";
import { expectNoAxeViolations } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  fakeCalls,
  fakePickFiles,
  fakeVaultWith,
  myRecords,
  sidebar,
} from "./support/vaultFake";

// The Add document menu at the top of the sidebar ("Today, decluttered"): the one way to put
// something in, by keyboard and by pointer. FAKE data only.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the sidebar is the desktop layout; a phone has its own tabs",
  );
});

test("Add document opens from the keyboard, names what can be added, and Escape puts the focus back", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const add = page.getByRole("button", {
    name: en("interface.AddMenu.addDocument"),
  });
  await add.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu", {
    name: en("interface.AddMenu.addDocument"),
  });
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: en("interface.AddMenu.importFile") }),
  ).toBeFocused();
  await expect(
    menu.getByRole("menuitem", {
      name: en("interface.VaultLibrary.newFolder"),
    }),
  ).toBeVisible();
  await expectNoAxeViolations(page, "the Add document menu, open");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(add).toBeFocused();
});

test("Import a file adds the chosen files into the open place, and a cancelled picker changes nothing", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const add = page.getByRole("button", {
    name: en("interface.AddMenu.addDocument"),
  });
  const importFile = () =>
    page.getByRole("menuitem", { name: en("interface.AddMenu.importFile") });
  // Cancelled: said, and nothing imported.
  await add.click();
  await importFile().click();
  await expect(
    page.getByText(en("interface.VaultLibrary.noFilesSelectedNothingChanged"), {
      exact: true,
    }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_import_picked")).toEqual([]);
  // Two files chosen.
  await fakePickFiles(page, ["FAKE Menu one.pdf", "FAKE Menu two.pdf"]);
  await add.click();
  await importFile().click();
  await expect(
    page.getByText(en("interface.notice.imported", { count: 2 }), {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "FAKE Menu one.pdf", exact: true }),
  ).toBeVisible();
});

test("New folder from the menu opens the folder form, also from another section", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const add = page.getByRole("button", {
    name: en("interface.AddMenu.addDocument"),
  });
  await add.click();
  await page
    .getByRole("menuitem", { name: en("interface.VaultLibrary.newFolder") })
    .click();
  await expect(
    page.getByRole("textbox", { name: /folder/i }).first(),
  ).toBeVisible();
  // From Preferences: the library's records come back, with the form.
  await sidebar(page)
    .getByRole("button", { name: en("sidebar.preferences") })
    .click();
  await add.click();
  await page
    .getByRole("menuitem", { name: en("interface.VaultLibrary.newFolder") })
    .click();
  await expect(myRecords(page)).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: /folder/i }).first(),
  ).toBeVisible();
});
