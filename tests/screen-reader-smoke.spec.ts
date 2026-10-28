import { expect, test, type Page } from "@playwright/test";
import {
  expectAnnounced,
  expectOnlyFakedCommands,
  fakeVault,
  recordAnnouncements,
  screenReaderSmoke,
} from "./support/a11y";

// Screen-reader smoke (#70 step 3): on each vault screen and dialog, axe finds
// nothing, every control has a name in the browser's accessibility tree, and
// the headings go down in order (screenReaderSmoke in support/a11y.ts); and
// the key events are read out: unlocking, the lock warning, locking, files
// arriving by import, and moves. This stands in for a person with NVDA or VoiceOver only as far
// as a browser can tell; the hands-on review in TESTING.md still applies.
//
// Not covered yet: "Shared with me" (#61), which is not on main.

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the vault screens' phone layout is checked by large-text-accessibility.spec.ts",
  );
});

async function openSection(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

test("first setup is named and ordered for a screen reader", async ({
  page,
}) => {
  await fakeVault(page, "absent", { recoveryKey: false });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Make myCarlos comfortable for you" }),
  ).toBeVisible();
  await screenReaderSmoke(page, "comfort settings");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Set up myCarlos on this computer" }),
  ).toBeVisible();
  await screenReaderSmoke(page, "create the vault");

  await page
    .getByRole("textbox", { name: "Whose records" })
    .fill("FAKE Patient");
  await page
    .getByRole("textbox", { name: "Passphrase", exact: true })
    .fill("FAKE correct horse battery staple");
  await page
    .getByRole("textbox", { name: "Confirm passphrase" })
    .fill("FAKE correct horse battery staple");
  await page.getByRole("button", { name: "Create vault" }).click();
  const setup = page.getByRole("dialog");
  await expect(setup).toBeVisible();
  await screenReaderSmoke(page, "recovery key setup", setup);
  await expectOnlyFakedCommands(page);
});

test("unlocking, the library and its dialogs are named, ordered and read out", async ({
  page,
}) => {
  await fakeVault(page, "locked");
  await recordAnnouncements(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Unlock your vault" }),
  ).toBeVisible();
  await screenReaderSmoke(page, "unlock");

  await page
    .getByLabel("Passphrase", { exact: true })
    .fill("FAKE passphrase for the fake");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("heading", { name: "My records" })).toBeVisible();
  await expectAnnounced(page, "Vault unlocked.");
  await screenReaderSmoke(page, "library");

  // Files arriving: an import's result.
  await page.getByRole("button", { name: "Choose files to import" }).click();
  await expect(
    page.getByRole("button", { name: "FAKE Scan.pdf", exact: true }),
  ).toBeVisible();
  await expectAnnounced(page, "1 file(s) encrypted and imported.");

  // A document's details, and a move from there.
  await page
    .getByRole("button", { name: "FAKE Letter.pdf", exact: true })
    .click();
  const details = page.getByRole("dialog", { name: "FAKE Letter.pdf" });
  await expect(details).toBeVisible();
  await expect(details).toHaveAccessibleDescription(/stays encrypted/);
  await screenReaderSmoke(page, "document details", details);
  await details
    .getByRole("combobox", { name: "Move to" })
    .selectOption({ label: "FAKE Letters" });
  await details.getByRole("button", { name: "Move", exact: true }).click();
  await expectAnnounced(page, "Document moved.");
  await details.getByRole("button", { name: "Close document details" }).click();

  // A folder's rename dialog, and a folder's own view.
  await page
    .getByRole("button", { name: "Rename folder FAKE Results" })
    .click();
  const rename = page.getByRole("dialog", { name: /Rename/ });
  await expect(rename).toBeVisible();
  await screenReaderSmoke(page, "rename a folder", rename);
  await rename.press("Escape");
  await page.getByRole("button", { name: "Open FAKE Results" }).click();
  await expect(
    page.getByRole("heading", { name: "FAKE Results", level: 1 }),
  ).toBeVisible();
  await screenReaderSmoke(page, "a folder");

  // Locking: the unlock screen says so as the description of the field that
  // has focus (VaultAuth.tsx), as it opens with it.
  await page
    .getByRole("button", { name: /Lock now/ })
    .first()
    .click();
  const passphrase = page.getByLabel("Passphrase", { exact: true });
  await expect(passphrase).toBeFocused();
  await expect(passphrase).toHaveAccessibleDescription(/Vault locked\./);
  await expectOnlyFakedCommands(page);
});

test("a vault without a recovery key offers one in a named dialog", async ({
  page,
}) => {
  await fakeVault(page, "locked", { recoveryKey: false });
  await page.goto("/");
  await page
    .getByLabel("Passphrase", { exact: true })
    .fill("FAKE passphrase for the fake");
  await page.getByRole("button", { name: "Unlock" }).click();
  const offer = page.getByRole("dialog");
  await expect(offer).toBeVisible();
  await screenReaderSmoke(page, "recovery key offer", offer);
  await expectOnlyFakedCommands(page);
});

test("Settings are named and ordered for a screen reader", async ({ page }) => {
  await fakeVault(page, "unlocked");
  await recordAnnouncements(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "My records" })).toBeVisible();
  await openSection(page, "Security");
  await screenReaderSmoke(page, "Security");
  await page.getByRole("button", { name: "Longer delay" }).click();
  await expectAnnounced(page, "6 minutes");
  await openSection(page, "Preferences");
  await screenReaderSmoke(page, "Preferences");
  await page.getByRole("button", { name: "Larger text" }).click();
  await expectAnnounced(page, "Text size 110%");
  await expectOnlyFakedCommands(page);
});

// #92: announce settled search results without moving focus or reading every
// keystroke. This browser check observes live-region changes, not real speech.
test("a search's result is read out (#92)", async ({ page }) => {
  // Load normally before the captured pause target. This two-minute head start
  // exceeds the 90-second test budget and stays below the five-minute idle lock,
  // so controller/browser scheduling cannot make pauseAt move backwards.
  const pauseTarget = Date.now();
  await page.clock.install({ time: pauseTarget - 120_000 });
  await fakeVault(page, "unlocked");
  await recordAnnouncements(page);
  await page.goto("/");
  const search = page.getByRole("searchbox", {
    name: "Search everything in My records",
  });
  const status = page.locator("[data-search-status]");
  await expect(search).toBeVisible();
  await page.clock.pauseAt(pauseTarget);
  await page.clock.runFor(600);
  await expect(status).toBeEmpty();
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveAttribute("aria-atomic", "true");
  await search.fill("Letter");
  await page.clock.runFor(300);
  await expect(status).toBeEmpty();
  await search.fill("Letter.pdf");
  await page.clock.runFor(499);
  await expect(status).toBeEmpty();
  await page.clock.runFor(1);
  await expect(page.getByRole("article")).toHaveCount(1);
  await expectAnnounced(page, "Search results. Folders: 0. Documents: 1.");
  await expect(search).toBeFocused();

  // A different query with the same count still changes the live region.
  await search.fill("Bloodwork.pdf");
  await expect(status).toBeEmpty();
  await page.clock.runFor(500);
  const messages = () =>
    page.evaluate(() =>
      (Reflect.get(window, "__announced") as string[]).filter((text) =>
        text.startsWith("Search results."),
      ),
    );
  await expect.poll(messages).toHaveLength(2);
  await search.fill("FAKE nothing like this");
  await page.clock.runFor(500);
  await expect(page.locator(".empty-state strong")).toHaveText(
    "No matching records",
  );
  await expectAnnounced(page, "No matching records");
  await expect(search).toBeFocused();

  await search.fill("");
  await page.clock.runFor(500);
  await expectAnnounced(
    page,
    "Search cleared. Folders in this location: 2. Documents: 1.",
  );
  await expect(search).toBeFocused();
  await expectOnlyFakedCommands(page);
});

test("pending search announcements stop when leaving the location (#92)", async ({
  page,
}) => {
  // Load normally before the captured pause target. This two-minute head start
  // exceeds the 90-second test budget and stays below the five-minute idle lock,
  // so controller/browser scheduling cannot make pauseAt move backwards.
  const pauseTarget = Date.now();
  await page.clock.install({ time: pauseTarget - 120_000 });
  await fakeVault(page, "unlocked");
  await recordAnnouncements(page);
  await page.goto("/");
  const search = page.getByRole("searchbox", {
    name: "Search everything in My records",
  });
  await expect(search).toBeVisible();
  await page.clock.pauseAt(pauseTarget);
  await search.fill("Results");
  await page.getByRole("button", { name: "Open FAKE Results" }).click();
  await page.clock.runFor(600);
  await expect(
    page.getByRole("heading", { name: "FAKE Results", level: 1 }),
  ).toBeVisible();
  await expect(page.locator("[data-search-status]")).toBeEmpty();
  await expect(
    page.evaluate(() => Reflect.get(window, "__announced") as string[]),
  ).resolves.not.toContainEqual(
    expect.stringMatching(/Search results|Search cleared/),
  );
  await expectOnlyFakedCommands(page);
});

test("the lock warning is named, read once, and the lock says why", async ({
  page,
}) => {
  await page.clock.install();
  await fakeVault(page, "unlocked");
  await recordAnnouncements(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "My records" })).toBeVisible();
  await page.clock.runFor(4.5 * 60 * 1000 + 1000);
  const warning = page.getByRole("alertdialog", {
    name: "myCarlos will lock in 30 seconds to keep your records private.",
  });
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAccessibleDescription(
    "To keep it open, press Keep open, or any key.",
  );
  await screenReaderSmoke(page, "lock warning", warning);
  // The heading counts down on screen only; a status says once that 10
  // seconds are left.
  await page.clock.runFor(21 * 1000);
  await expectAnnounced(page, "10 seconds left.");
  await expect(warning).toHaveAccessibleName(
    "myCarlos will lock in 30 seconds to keep your records private.",
  );
  await page.clock.runFor(10 * 1000);
  const passphrase = page.getByLabel("Passphrase", { exact: true });
  await expect(passphrase).toBeFocused();
  await expect(passphrase).toHaveAccessibleDescription(
    /Locked after 5 minutes without use\./,
  );
  await expectOnlyFakedCommands(page);
});
