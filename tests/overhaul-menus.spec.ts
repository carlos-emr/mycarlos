import { expect, test, type Page } from "@playwright/test";
import { translate } from "./support/fluent";
import {
  FAKE_IDS,
  fakeCalls,
  fakeVaultWith,
  myRecords,
  sidebar,
} from "./support/vaultFake";
import { expectAnnounced, recordAnnouncements } from "./support/a11y";
import { addButton, toolbarButton } from "./support/menus";

// The overhaul's menus, by keyboard alone (Tab, Enter, arrows, Escape): the Add document menu's
// reach, the open folder's "…" menu (Rename, Move folder…), the person's "…" menu (Hide, with its
// confirmation), and the Sort and View menus. Pointer and unit coverage is in
// add-document-menu.spec.ts, people.spec.ts, hidden-people.spec.ts and VaultLibrary.test.tsx; the
// camera item is in camera-photo.spec.ts, and the video item needs the Record screen (#477),
// which this branch does not have. FAKE data only.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the sidebar and the menus' desktop layout; a phone has its own tabs",
  );
});

/** Presses Enter on the sidebar entry `name` (the way a keyboard user opens a place). */
async function openPlace(page: Page, name: RegExp) {
  await sidebar(page).getByRole("button", { name }).first().focus();
  await page.keyboard.press("Enter");
}

/** The "…" button of the heading's own row (what can be done to this person or folder). */
const headMore = (page: Page) =>
  page.locator(".head-title-row").getByRole("button", { name: /^More for / });

/** Focuses a menu button and opens it with ArrowDown: the first item has the focus. */
async function openMenu(page: Page, button: ReturnType<Page["getByRole"]>) {
  await button.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menu")).toBeVisible();
}

test("Add document: Down reaches every item and End the last, Escape closes it and puts the focus back", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const add = addButton(page);
  await openMenu(page, add);
  const items = page.getByRole("menu").getByRole("menuitem");
  const names = await items.allInnerTexts();
  // Import a file first, New folder last (Take a photo only where there is a camera).
  expect(names[0]).toContain(en("interface.AddMenu.importFile"));
  expect(names.at(-1)).toContain(en("interface.VaultLibrary.newFolder"));
  await expect(items.first()).toBeFocused();
  for (let index = 1; index < names.length; index += 1)
    await page.keyboard.press("ArrowDown");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(add).toBeFocused();
  // Enter on the last item (New folder) opens the folder form: its Create button (this form's
  // own control, not the rename dialog's label) is not there before, and is after.
  const create = page.getByRole("button", {
    name: en("interface.VaultLibrary.create"),
    exact: true,
  });
  await expect(create).toBeHidden();
  await openMenu(page, add);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(create).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: en("rename.label.folder") }),
  ).toBeVisible();
});

test("a folder's … menu: Move folder… opens the keyboard move with the folder chosen and the focus on Destination, and Move moves it", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await recordAnnouncements(page);
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await openPlace(page, /^FAKE Letters/);
  await expect(
    page.getByRole("heading", { name: "FAKE Letters", level: 1 }),
  ).toBeFocused();
  // In the head row (not any other "More for" button), and the name inside is wrapped in
  // invisible isolation marks: match only what precedes it.
  const more = headMore(page);
  await openMenu(page, more);
  const rename = page.getByRole("menuitem", {
    name: en("rename.title.folder"),
  });
  const move = page.getByRole("menuitem", {
    name: en("interface.VaultLibrary.moveFolderItem"),
  });
  await expect(rename).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(move).toBeFocused();
  await page.keyboard.press("Enter");
  // The Help panel is open and the button says so; the folder is chosen; Destination has the focus.
  const help = page.getByRole("button", {
    name: en("interface.VaultLibrary.helpButtonName"),
  });
  await expect(help).toHaveAttribute("aria-expanded", "true");
  const panel = page.getByRole("region", {
    name: en("interface.VaultLibrary.helpWithThisScreen"),
  });
  await expect(panel).toBeVisible();
  // The button points at this very panel.
  const panelId = await panel.getAttribute("id");
  expect(panelId).toBeTruthy();
  await expect(help).toHaveAttribute("aria-controls", panelId!);
  await expect(
    panel.getByRole("combobox", { name: "Folder", exact: true }),
  ).toHaveValue(FAKE_IDS.letters);
  const destination = panel.getByRole("combobox", { name: "Destination" });
  await expect(destination).toBeFocused();
  // Choose FAKE Results with selectOption (ArrowDown on a closed <select> opens its popup on
  // macOS instead of choosing), keeping the focus on Destination; Tab reaches Move folder,
  // Enter moves.
  await destination.selectOption(FAKE_IDS.folder);
  await expect(destination).toHaveValue(FAKE_IDS.folder);
  await expect(destination).toBeFocused();
  await page.keyboard.press("Tab");
  const moveButton = panel.getByRole("button", { name: "Move folder" });
  await expect(moveButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expectAnnounced(
    page,
    en("interface.notice.folderMovedNamed", {
      name: "FAKE Letters",
    }),
  );
  const calls = await fakeCalls(page, "vault_update_folder");
  expect(calls).toHaveLength(1);
  expect(calls[0].request).toMatchObject({
    folderId: FAKE_IDS.letters,
    parentId: FAKE_IDS.folder,
  });
});

test("a folder's … menu: Rename by keyboard, Escape cancels without a change", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await recordAnnouncements(page);
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await openPlace(page, /^FAKE Results/);
  const more = headMore(page);
  // Escape on the open menu changes nothing and returns the focus.
  await openMenu(page, more);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(more).toBeFocused();
  expect(await fakeCalls(page, "vault_update_folder")).toEqual([]);
  // Enter on Rename opens the dialog with the name; type, Enter saves.
  await openMenu(page, more);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: en("rename.title.folder") });
  const field = dialog.getByLabel(en("rename.label.folder"), { exact: true });
  await expect(field).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("FAKE Test results");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expectAnnounced(
    page,
    en("interface.notice.renamedFolder", { name: "FAKE Test results" }),
  );
  const calls = await fakeCalls(page, "vault_update_folder");
  expect(calls).toHaveLength(1);
  expect(calls[0].request).toMatchObject({
    folderId: FAKE_IDS.folder,
    name: "FAKE Test results",
  });
});

test("a person's … menu: Hide asks first; Escape sends nothing; Enter on Hide hides them", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "unlocked",
    people: [{ displayName: "FAKE Blake" }],
  });
  await page.goto("/");
  // With two people the heading is the first person's name, not "My records".
  await expect(sidebar(page)).toBeVisible();
  await openPlace(page, /^FAKE Blake/);
  await expect(
    page.getByRole("heading", { name: "FAKE Blake", level: 1 }),
  ).toBeFocused();
  const more = headMore(page);
  const hideItem = page.getByRole("menuitem", {
    name: en("hiddenPeople.hideFor", { name: "FAKE Blake" }),
  });
  // Rename, Edit details, Hide: Down twice reaches Hide.
  await openMenu(page, more);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(hideItem).toBeFocused();
  await page.keyboard.press("Enter");
  const ask = page.getByRole("alertdialog");
  await expect(
    ask.getByRole("heading", {
      name: en("hiddenPeople.confirm.title", { name: "FAKE Blake" }),
    }),
  ).toBeVisible();
  // The safe control has the focus when the question opens: Cancel, not Hide, so a stray Enter
  // cannot hide anyone. Checked before the test moves the focus itself.
  const cancel = ask.getByRole("button", { name: en("common.cancel") });
  const confirmHide = ask.getByRole("button", {
    name: en("hiddenPeople.confirm.hide", { name: "FAKE Blake" }),
    exact: true,
  });
  await expect(cancel).toBeFocused();
  await expect(confirmHide).not.toBeFocused();
  // Escape cancels: nothing is sent, and the focus comes back to the menu's button.
  await page.keyboard.press("Escape");
  await expect(ask).toBeHidden();
  expect(await fakeCalls(page, "vault_hide_profile")).toEqual([]);
  await expect(more).toBeFocused();
  // Open it again and press Enter at once, on whatever has the focus: that is Cancel, so
  // nothing is hidden.
  await openMenu(page, more);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(ask).toBeHidden();
  expect(await fakeCalls(page, "vault_hide_profile")).toEqual([]);
  // A third time: move to Hide on purpose, and confirm with the keyboard.
  await openMenu(page, more);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await ask
    .getByRole("button", {
      name: en("hiddenPeople.confirm.hide", { name: "FAKE Blake" }),
      exact: true,
    })
    .focus();
  await page.keyboard.press("Enter");
  await expect(ask).toBeHidden();
  const hidden = await fakeCalls(page, "vault_hide_profile");
  expect(hidden).toHaveLength(1);
  // FAKE Blake is in no list any more.
  await expect(
    sidebar(page).getByRole("button", { name: /^FAKE Blake/ }),
  ).toHaveCount(0);
});

test("Sort by and View by keyboard: Down and Enter choose, Escape closes and keeps the choice, the focus returns to the button", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const sort = toolbarButton(page, "Sort by");
  const view = toolbarButton(page, "View");
  await expect(sort).toHaveAccessibleName(
    `${en("interface.VaultLibrary.sortBy")}: ${en("interface.VaultLibrary.newestFirst")}`,
  );
  await expect(view).toHaveAccessibleName(
    `${en("interface.VaultLibrary.view")}: ${en("interface.VaultLibrary.list")}`,
  );
  // Tab order: the search box, Sort by, View.
  await sort.focus();
  await page.keyboard.press("Tab");
  await expect(view).toBeFocused();
  // Sort: Escape keeps Newest first.
  await openMenu(page, sort);
  const newest = page.getByRole("menuitemradio", {
    name: en("interface.VaultLibrary.newestFirst"),
  });
  const byName = page.getByRole("menuitemradio", {
    name: en("interface.VaultLibrary.nameAZ"),
  });
  await expect(newest).toHaveAttribute("aria-checked", "true");
  await expect(byName).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(sort).toBeFocused();
  await expect(sort).toHaveAccessibleName(
    `${en("interface.VaultLibrary.sortBy")}: ${en("interface.VaultLibrary.newestFirst")}`,
  );
  // Sort: Down to Name A-Z, Enter chooses it, and the button says so.
  await openMenu(page, sort);
  await page.keyboard.press("ArrowDown");
  await expect(byName).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(sort).toBeFocused();
  await expect(sort).toHaveAccessibleName(
    `${en("interface.VaultLibrary.sortBy")}: ${en("interface.VaultLibrary.nameAZ")}`,
  );
  // View: Down to Grid, Enter, and the button says so.
  await openMenu(page, view);
  const grid = page.getByRole("menuitemradio", {
    name: en("interface.VaultLibrary.grid"),
  });
  await page.keyboard.press("ArrowDown");
  await expect(grid).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(view).toBeFocused();
  await expect(view).toHaveAccessibleName(
    `${en("interface.VaultLibrary.view")}: ${en("interface.VaultLibrary.grid")}`,
  );
  // The choices stay when the menus are opened again.
  await openMenu(page, sort);
  await expect(byName).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
});
