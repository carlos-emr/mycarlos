import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectOnlyFakedCommands, fakeVault } from "./support/a11y";

// #90 puts focus back for keyboard users (keyboard-walk.spec.ts). A click or
// tap in WebKit (macOS, iOS) does not focus the button pressed and takes focus
// from whatever had it, so after a pointer action focus is on the page itself.
// It must stay there, and the page must not scroll: no jump to the heading or
// to a control used earlier. Chromium focuses what it clicks, so the WebKit
// rule is put in before each real click (desktop) or tap (phone).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener(
      "mousedown",
      (event) => {
        const field =
          "textarea, input:not([type=button], [type=checkbox], [type=radio], [type=submit], [type=file])";
        if (event.target instanceof Element && event.target.closest(field))
          return;
        event.preventDefault();
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
      },
      true,
    );
  });
});

const press = (target: Locator) =>
  test.info().project.use.hasTouch ? target.tap() : target.click();

/** Long enough for a recovery frame, and a scroll, to have happened. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setTimeout(resolve, 400)),
        ),
      ),
  );

const focusOnPage = async (page: Page) =>
  expect(
    await page.evaluate(() => {
      const focused = document.activeElement;
      return !focused || focused === document.body
        ? "the page"
        : `${focused.tagName} ${focused.getAttribute("aria-label") ?? focused.textContent?.trim()}`;
    }),
    "focus after the pointer action",
  ).toBe("the page");

test("closing a document's details far down a long list keeps the place (#90)", async ({
  page,
}) => {
  await fakeVault(page, "unlocked");
  await page.addInitScript(() => {
    const internals = Reflect.get(window, "__TAURI_INTERNALS__");
    const invoke = internals.invoke;
    internals.invoke = async (command: string, args?: unknown) => {
      const result = await invoke(command, args);
      if (command === "vault_snapshot")
        for (let i = 0; i < 40; i++)
          result.records.push({
            id: `many${i}`,
            profileId: "profile",
            folderIds: [],
            displayName: `FAKE Many ${String(i).padStart(2, "0")}.pdf`,
            sourceLabel: "Manual import — unverified",
            mediaType: "application/pdf",
            plaintextSize: 10,
            importedAtMs: 100 + i,
            available: true,
          });
      return result;
    };
  });
  await page.goto("/");
  const heading = page.getByRole("heading", { name: "My records", level: 1 });
  await expect(heading).toBeVisible();
  const documents = page.getByRole("button", { name: /^FAKE Many \d+\.pdf$/ });
  await expect(documents).toHaveCount(40);
  const target = documents.last();
  await target.scrollIntoViewIfNeeded();
  await settle(page);
  await expect(heading).not.toBeInViewport();
  const before = (await target.boundingBox())?.y;

  await press(target);
  const details = page.getByRole("dialog");
  await expect(details).toBeVisible();
  await press(details.getByRole("button", { name: "Close document details" }));
  await expect(details).toBeHidden();
  await settle(page);

  expect(
    (await target.boundingBox())?.y,
    "where the document is on screen",
  ).toBeCloseTo(before ?? NaN, 0);
  await expect(heading).not.toBeInViewport();
  await focusOnPage(page);
  await expectOnlyFakedCommands(page);
});

test("after typing in Search, pointer actions leave focus on the page (#90)", async ({
  page,
}) => {
  await fakeVault(page, "unlocked");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "My records", level: 1 }),
  ).toBeVisible();
  const search = page.getByRole("searchbox", {
    name: "Search everything in My records",
  });
  await press(search);
  await expect(search).toBeFocused();
  await page.keyboard.type("Letter");

  const importer = page.getByRole("button", { name: "Choose files to import" });
  await press(importer);
  await expect(
    page.getByText("1 file(s) encrypted and imported."),
  ).toBeVisible();
  await expect(importer).toBeEnabled();
  await settle(page);
  await focusOnPage(page);

  await press(
    page.getByRole("button", { name: "FAKE Letter.pdf", exact: true }),
  );
  const details = page.getByRole("dialog", { name: "FAKE Letter.pdf" });
  await expect(details).toBeVisible();
  await press(details.getByRole("button", { name: "Close document details" }));
  await expect(details).toBeHidden();
  await settle(page);
  await focusOnPage(page);
  await expectOnlyFakedCommands(page);
});

test("opening a folder with a pointer leaves focus on the page (#90)", async ({
  page,
}) => {
  await fakeVault(page, "unlocked");
  await page.goto("/");
  await press(page.getByRole("button", { name: "Open FAKE Letters" }));
  await expect(
    page.getByRole("heading", { name: "FAKE Letters", level: 1 }),
  ).toBeVisible();
  await settle(page);
  await focusOnPage(page);
  await expectOnlyFakedCommands(page);
});
