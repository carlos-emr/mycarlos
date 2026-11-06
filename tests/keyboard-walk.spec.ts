import { messagePattern, translate } from "./support/fluent";
import { expect, test, type Locator } from "@playwright/test";
import {
  dialogByKeyboard,
  expectAnnounced,
  expectOnlyFakedCommands,
  fakeVault,
  recordAnnouncements,
  screenReaderSmoke,
  tabRound,
  walk,
} from "./support/a11y";

// Keyboard only (#70 step 3): first setup, unlock, the library (open, move,
// search) and Settings, with Tab, Shift+Tab, Enter, Space, the arrow keys
// and Escape. On each screen Tab reaches every control in page order, each
// shows its focus and is not hidden behind anything, and Tab and Shift+Tab go
// all the way round (walk() in support/a11y.ts). Dialogs keep focus inside,
// and Escape closes them and gives focus back. The native side is faked.
//
// Not covered yet: "Shared with me" (#61), which is not on main.

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "a phone has no keyboard Tab order to walk",
  );
});

test("first setup works from the keyboard alone", async ({ page }) => {
  await fakeVault(page, "absent", { recoveryKey: false });
  await recordAnnouncements(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Make myCarlos comfortable for you" }),
  ).toBeVisible();
  await walk(page, "comfort settings");

  const size = page.getByRole("textbox", { name: "Text size in percent" });
  await page.getByRole("button", { name: "Larger text" }).focus();
  await page.keyboard.press("Enter");
  await expect(size).not.toHaveValue("100");
  await expectAnnounced(page, `Text size ${await size.inputValue()}%`);

  await page.getByRole("button", { name: "Longer delay" }).focus();
  await page.keyboard.press("Space");
  await expectAnnounced(page, "6 minutes");

  await page.getByRole("button", { name: "Continue" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Set up myCarlos on this computer" }),
  ).toBeVisible();
  await walk(page, "create the vault");

  await page.getByRole("textbox", { name: "Whose records" }).focus();
  await page.keyboard.type("FAKE Patient");
  await page.keyboard.press("Tab");
  await page.keyboard.type("FAKE correct horse battery staple");
  await page.getByRole("textbox", { name: "Confirm passphrase" }).focus();
  await page.keyboard.type("FAKE correct horse battery staple");
  await page.keyboard.press("Enter");

  // A new vault opens on setting up its recovery key, in a dialog that asks
  // before it is left: Escape asks, and Escape again goes back to it.
  const setup = page.getByRole("dialog");
  await expect(setup).toBeVisible();
  await walk(page, "recovery key setup", "[role=dialog]");
  await page.keyboard.press("Escape");
  await expect(setup).toBeVisible();
  await expect
    .poll(() =>
      setup.evaluate((dialog) => dialog.contains(document.activeElement)),
    )
    .toBe(true);
  await walk(page, "leaving the recovery key setup", "[role=dialog]");
  await page.keyboard.press("Escape");
  await expect(setup).toBeVisible();
  await expectOnlyFakedCommands(page);
});

test("unlocking works from the keyboard alone", async ({ page }) => {
  await fakeVault(page, "locked");
  await recordAnnouncements(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Unlock your vault" }),
  ).toBeVisible();
  await walk(page, "unlock");

  // The other ways in open from the keyboard too.
  for (const section of ["Forgot your passphrase?", "Restore from a backup"]) {
    await page.getByText(section).focus();
    await page.keyboard.press("Enter");
    await walk(page, `unlock, "${section}" open`);
    await page.getByText(section).focus();
    await page.keyboard.press("Enter");
  }

  await page.getByLabel("Passphrase", { exact: true }).focus();
  await page.keyboard.type("FAKE passphrase for the fake");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "My records" })).toBeVisible();
  await expectAnnounced(page, "Vault unlocked.");
  await expectOnlyFakedCommands(page);
});

test("a vault without a recovery key offers one, and Escape puts it off", async ({
  page,
}) => {
  await fakeVault(page, "locked", { recoveryKey: false });
  await page.goto("/");
  await page.getByLabel("Passphrase", { exact: true }).focus();
  await page.keyboard.type("FAKE passphrase for the fake");
  await page.keyboard.press("Enter");
  const offer = page.getByRole("dialog");
  await expect(offer).toBeVisible();
  await walk(page, "recovery key offer", "[role=dialog]");
  await page.keyboard.press("Escape");
  await expect(offer).toBeHidden();
  await expect(page.getByRole("heading", { name: "My records" })).toBeVisible();
  await expectOnlyFakedCommands(page);
});

test("the library works from the keyboard alone: open, move and search", async ({
  page,
}) => {
  await fakeVault(page, "unlocked");
  await recordAnnouncements(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "My records" })).toBeVisible();
  await walk(page, "library");

  // Open a document's details, and close them with Escape.
  const letter = page.getByRole("button", {
    name: "FAKE Letter.pdf",
    exact: true,
  });
  await dialogByKeyboard(page, letter, "FAKE Letter.pdf");
  await dialogByKeyboard(
    page,
    page.getByRole("button", {
      name: translate("en", "library.folder.rename", { name: "FAKE Results" }),
    }),
    /Rename/,
  );

  // A confirmation takes the place of the details: Escape cancels it, and the
  // details come back with focus on their Close button. Hiding a document
  // asks nothing (#71), so this walks the readable-copy confirmation.
  await letter.focus();
  await page.keyboard.press("Enter");
  const letterDetails = page.getByRole("dialog", { name: "FAKE Letter.pdf" });
  await letterDetails
    .getByRole("button", { name: "Save a copy to this computer" })
    .focus();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("alertdialog", {
    name: "Save a readable copy?",
  });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await walk(page, "copy confirmation", "[role=alertdialog]");
  await screenReaderSmoke(page, "copy confirmation", confirm);
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(
    letterDetails.getByRole("button", { name: "Close document details" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(letterDetails).toBeHidden();
  await expect(letter).toBeFocused();

  // Move it from its details: choose in "Move to" with the arrow keys, then
  // Tab to Move. Focus goes back to "Move to" once the move is done.
  await letter.focus();
  await page.keyboard.press("Enter");
  const details = page.getByRole("dialog", { name: "FAKE Letter.pdf" });
  const moveTo = details.getByRole("combobox", { name: "Move to" });
  await moveTo.focus();
  await page.keyboard.press("ArrowDown");
  await expect(moveTo).toHaveValue("folder");
  await page.keyboard.press("Tab");
  await expect(
    details.getByRole("button", { name: "Move", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expectAnnounced(page, "Document moved.");
  await expect(
    details.getByRole("definition").filter({ hasText: /^FAKE Results$/ }),
  ).toBeVisible();
  await expect(moveTo).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();

  // Open the folder, and move a document out with the selection bar.
  await page
    .getByRole("button", {
      name: translate("en", "library.folder.open", { name: "FAKE Results" }),
    })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "FAKE Results", level: 1 }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: translate("en", "library.select", { name: "FAKE Bloodwork.pdf" }),
    })
    .focus();
  await page.keyboard.press("Space");
  const moveSelected = page.getByRole("combobox", { name: "Move selected to" });
  await expect(moveSelected).toBeVisible();
  await walk(page, "a folder, with a document selected");
  await moveSelected.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(moveSelected).toHaveValue("letters");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expectAnnounced(page, "1 document moved.");

  // A new folder, named with the keyboard.
  await page.getByRole("button", { name: "New folder" }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type("FAKE Older");
  await page.keyboard.press("Enter");
  await expectAnnounced(page, "FAKE Older was created.");

  // Back to the top level, and move a folder into another one.
  await page
    .getByRole("button", { name: /^My records/ })
    .first()
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "My records", level: 1 }),
  ).toBeVisible();
  await page.getByText("Move a folder with the keyboard").focus();
  await page.keyboard.press("Enter");
  await walk(page, "library, folder move shown");
  await page.getByRole("combobox", { name: "Folder", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("combobox", { name: "Destination" }).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("button", { name: "Move folder" }).focus();
  await page.keyboard.press("Enter");
  await expectAnnounced(page, "FAKE Results moved.");

  // Search, and Escape to clear it.
  const search = page.getByRole("searchbox", {
    name: translate("en", "interface.search.all", { location: "My records" }),
  });
  await search.focus();
  await page.keyboard.type("Letters");
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(
    page.getByRole("button", {
      name: translate("en", "library.folder.open", { name: "FAKE Letters" }),
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expectOnlyFakedCommands(page);
});

// #90: actions retain their usable trigger or focus the new location heading.
// #75's details Move -> Move to remains a positive control in this journey.
test("focus is never left on the page itself after an action (#90)", async ({
  page,
}) => {
  await fakeVault(page, "locked");
  await page.goto("/");
  const after = (what: string, target: Locator) =>
    expect(target, `focus after ${what}`).toBeFocused();
  const heading = page.getByRole("heading", {
    name: "My records",
    exact: true,
  });

  await page.getByLabel("Passphrase", { exact: true }).focus();
  await page.keyboard.type("FAKE passphrase for the fake");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "My records" })).toBeVisible();
  await after("unlocking", heading);

  await page.getByRole("button", { name: "Choose files to import" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "FAKE Scan.pdf", exact: true }),
  ).toBeVisible();
  await after(
    "an import",
    page.getByRole("button", { name: "Choose files to import" }),
  );

  await page
    .getByRole("button", { name: "FAKE Letter.pdf", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  const details = page.getByRole("dialog", { name: "FAKE Letter.pdf" });
  await details.getByRole("combobox", { name: "Move to" }).focus();
  await page.keyboard.press("ArrowDown");
  await details.getByRole("button", { name: "Move", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    details.getByRole("definition").filter({ hasText: /^FAKE Results$/ }),
  ).toBeVisible();
  await after(
    "a move with Move in the details",
    details.getByRole("combobox", { name: "Move to" }),
  );
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await after("closing details whose document moved away", heading);

  await page
    .getByRole("button", {
      name: translate("en", "library.select", { name: "FAKE Scan.pdf" }),
    })
    .focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Move", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("combobox", { name: "Move selected to" }),
  ).toBeHidden();
  await after("a move with the selection bar", heading);

  await page.getByText("Move a folder with the keyboard").focus();
  await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: "Folder", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("button", { name: "Move folder" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Move folder" })).toBeEnabled();
  await after("Move folder", page.getByRole("button", { name: "Move folder" }));

  await page
    .getByRole("button", {
      name: translate("en", "library.folder.open", { name: "FAKE Letters" }),
    })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "FAKE Letters", level: 1 }),
  ).toBeVisible();
  await after(
    "opening a folder",
    page.getByRole("heading", { name: "FAKE Letters", exact: true }),
  );
  await expectOnlyFakedCommands(page);
});

test("library focus recovery leaves the unlock recovery offer in control (#90)", async ({
  page,
}) => {
  await fakeVault(page, "locked", { recoveryKey: false });
  await page.goto("/");
  await page
    .getByLabel("Passphrase", { exact: true })
    .fill("FAKE passphrase for the fake");
  await page.keyboard.press("Enter");
  const offer = page.getByRole("dialog");
  await expect(offer).toBeVisible();
  await expect(offer.locator(":focus")).toHaveCount(1);
  await page.locator(".native-lock-button").focus();
  // The library behind the offer is inert, so it cannot take that focus.
  await expect(offer.locator(":focus")).toHaveCount(1);
  await expectOnlyFakedCommands(page);
});

// #91 (fixed by #75): "Move to" used to move the document as soon as its
// value changed, so with the keyboard the first arrow press moved it into the
// next folder. Now the list only chooses, and Move moves, once.
test("Move to in a document's details moves it only where the patient chooses (#91)", async ({
  page,
}) => {
  await fakeVault(page, "unlocked");
  await recordAnnouncements(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "FAKE Letter.pdf", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  const details = page.getByRole("dialog", { name: "FAKE Letter.pdf" });
  const moveTo = details.getByRole("combobox", { name: "Move to" });
  const moves = () =>
    page.evaluate(
      () =>
        (Reflect.get(window, "__ipcCalls") as string[]).filter(
          (command) => command === "vault_assign_folders",
        ).length,
    );
  await moveTo.focus();
  // Down to the second folder, FAKE Letters, past FAKE Results.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(moveTo).toHaveValue("letters");
  expect(await moves(), "moves before the patient presses Move").toBe(0);

  await page.keyboard.press("Tab");
  await expect(
    details.getByRole("button", { name: "Move", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expectAnnounced(page, "Document moved.");
  expect(await moves(), "moves after Move is pressed once").toBe(1);
  await expect(
    details.getByRole("definition").filter({ hasText: /^FAKE Letters$/ }),
  ).toBeVisible();
  // Move is disabled once the document is there; focus goes back to the list.
  await expect(moveTo).toBeFocused();
});

test("the keyboard walk handles native date parts and still detects a trapped date", async ({
  page,
}) => {
  await page.setContent(`
    <style>:focus { outline: 3px solid blue; }</style>
    <button>Before</button>
    <label>Birth date <input type="date"></label>
    <button>After</button>
  `);
  expect((await tabRound(page)).problems).toEqual([]);
  await page.locator('input[type="date"]').evaluate((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Tab") event.preventDefault();
    });
  });
  expect((await tabRound(page)).problems).toContain(
    'focus came back to input type="date" before going round',
  );
  await page.locator('input[type="date"]').evaluate((input) => {
    const date = input.cloneNode(true);
    input.replaceWith(date);
    date.addEventListener("keydown", (event) => {
      if (
        (event as KeyboardEvent).key === "Tab" &&
        (event as KeyboardEvent).shiftKey
      )
        event.preventDefault();
    });
  });
  expect((await tabRound(page)).problems).toContain(
    "Shift+Tab did not come round in 150 presses",
  );
});

test("Settings work from the keyboard alone", async ({ page }) => {
  await fakeVault(page, "unlocked");
  await recordAnnouncements(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "My records" })).toBeVisible();

  await page.getByRole("button", { name: "Security", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Security" })).toBeVisible();
  await walk(page, "Security");
  await page.getByRole("button", { name: "Shorter delay" }).focus();
  await page.keyboard.press("Enter");
  await expectAnnounced(page, "4 minutes");

  await page.getByRole("button", { name: "Preferences", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Preferences" }),
  ).toBeVisible();
  await walk(page, "Preferences");
  // The appearance radios: one Tab stop, the arrow keys choose.
  await page
    .getByRole("group", { name: "Appearance", exact: true })
    .getByRole("radio", { name: "System", exact: true })
    .focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: "Light" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Light" })).toBeFocused();
  await expectOnlyFakedCommands(page);
});

test("locking, by hand or automatically, leaves focus where unlocking starts", async ({
  page,
}) => {
  await page.clock.install();
  await fakeVault(page, "unlocked");
  await recordAnnouncements(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "My records" })).toBeVisible();

  await page
    .getByRole("button", { name: /Lock now/ })
    .first()
    .focus();
  await page.keyboard.press("Enter");
  const passphrase = page.getByLabel("Passphrase", { exact: true });
  await expect(passphrase).toBeFocused();
  // Said as the field's description: the screen opens with it (VaultAuth.tsx).
  await expect(passphrase).toHaveAccessibleDescription(/Vault locked\./);

  await page.keyboard.type("FAKE passphrase for the fake");
  await page.keyboard.press("Enter");
  const search = page.getByRole("searchbox", {
    name: translate("en", "interface.search.all", { location: "My records" }),
  });
  await expect(search).toBeVisible();
  await search.focus();

  // 30 seconds before the automatic lock, a warning takes focus on Keep
  // open. Any key keeps myCarlos open, Tab too, so there is nothing to walk.
  const warning = page.getByRole("alertdialog", { name: /will lock in/ });
  for (const key of ["Escape", "Tab"]) {
    await page.clock.runFor(4.5 * 60 * 1000 + 1000);
    await expect(warning).toBeVisible();
    await expect(
      warning.getByRole("button", { name: "Keep open" }),
    ).toBeFocused();
    await page.keyboard.press(key);
    await expect(warning, `${key} keeps myCarlos open`).toBeHidden();
    await expect(search).toBeVisible();
  }

  // Left alone, it locks, and says why.
  await page.clock.runFor(5 * 60 * 1000 + 1000);
  await expect(passphrase).toBeFocused();
  await expect(passphrase).toHaveAccessibleDescription(
    messagePattern("en", "notice.lockedIdle", { count: 5 }),
  );
  await expectOnlyFakedCommands(page);
});
