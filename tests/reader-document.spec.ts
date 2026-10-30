import { expect, test, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { messagePattern, translate } from "./support/fluent";
import {
  FAKE_IDS,
  FAKE_DOCUMENT_PASSWORD,
  FAKE_PAGE_COUNT,
  fakeCalls,
  fakeCommands,
  fakePageText,
  fakeViewDraws,
  fakeVaultWith,
  lockedOriginalName,
  openDetails,
  scriptFake,
} from "./support/vaultFake";

// Reading a document in myCarlos (#48), what the app is opened for most: Read
// in a document's details, page by page, zoom, the page's text, and Close; a
// document locked with its own password (#54), in the reader and with
// Unlock; and the reader closing when the vault locks. The native side is
// faked (support/vaultFake.ts): Rust tests cover drawing pages in the PDF
// helper, and this covers what the screens ask it for and show. The reader's
// layout at large text sizes is reader-layout.spec.ts (#158).

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
const LOCKED = "FAKE Locked.pdf";
const WRONG_PASSWORD = "FAKE wrong document password";

/** The reader's parts, for the document `name`. */
function readerOf(page: Page, name: string) {
  const reader = page.getByRole("dialog", { name, exact: true });
  return {
    reader,
    button: (key: Parameters<typeof translate>[1]) =>
      reader.getByRole("button", { name: en(key), exact: true }),
    picture: (n: number) =>
      reader.getByRole("img", {
        name: en("interface.reader.textFollows", {
          page: n,
          total: FAKE_PAGE_COUNT,
        }),
        exact: true,
      }),
    pageArea: (n: number) =>
      reader.getByRole("region", {
        name: en("interface.reader.page", { page: n }),
        exact: true,
      }),
    where: (n: number) =>
      en("interface.reader.where", { page: n, total: FAKE_PAGE_COUNT }),
    zoom: (percent: number) =>
      reader.getByText(en("interface.reader.zoom", { percent }), {
        exact: true,
      }),
  };
}

/** As when the window is minimized: the page is hidden, and myCarlos locks. */
async function minimize(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test("reads a document page by page, with zoom and the page's text, and Close goes back to it", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  const details = await openDetails(page, LETTER);
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.read"),
      exact: true,
    })
    .click();

  // Page 1, drawn by the native side for the reader's width.
  const { reader, button, picture, pageArea, where, zoom } = readerOf(
    page,
    LETTER,
  );
  await expect(picture(1)).toBeVisible();
  await expect(pageArea(1)).toBeVisible();
  await expect(reader.getByRole("status")).toHaveText(where(1));
  await expect(button("interface.DocumentReader.previousPage")).toBeDisabled();
  await expect(button("interface.DocumentReader.nextPage")).toBeEnabled();
  await expect(zoom(100)).toBeVisible();
  const first = (await fakeCalls(page, "vault_view_page"))[0];
  expect(first).toEqual({
    request: {
      recordId: FAKE_IDS.letter,
      page: 0,
      width: expect.any(Number),
      password: null,
    },
  });
  expect(Number(first.request?.width)).toBeGreaterThan(0);

  // The next page: another picture, and its own text.
  await button("interface.DocumentReader.nextPage").click();
  await expect(picture(2)).toBeVisible();
  await expect(pageArea(2)).toBeVisible();
  await expect(reader.getByRole("status")).toHaveText(where(2));
  await expect(button("interface.DocumentReader.previousPage")).toBeEnabled();
  expect(await fakeCalls(page, "vault_view_page")).toContainEqual({
    request: {
      recordId: FAKE_IDS.letter,
      page: 1,
      width: expect.any(Number),
      password: null,
    },
  });
  await reader
    .getByText(en("interface.DocumentReader.textOnThisPage"), { exact: true })
    .click();
  await expect(
    reader.getByText(fakePageText(LETTER, 2), { exact: true }),
  ).toBeVisible();
  await expect(
    reader.getByText(fakePageText(LETTER, 1), { exact: true }),
  ).toHaveCount(0);

  // Larger draws the page again, wider by the zoom step, in picture pixels
  // (CSS pixels times the screen's pixel ratio); Fit width goes back to the
  // drawn page.
  const ratio = await page.evaluate(() => window.devicePixelRatio);
  const fitted = Number(
    (await fakeCalls(page, "vault_view_page"))
      .filter((call) => call.request?.page === 1)
      .at(-1)?.request?.width,
  );
  await button("interface.DocumentReader.larger").click();
  await expect(zoom(125)).toBeVisible();
  await expect
    .poll(async () => (await fakeCalls(page, "vault_view_page")).at(-1))
    .toEqual({
      request: {
        recordId: FAKE_IDS.letter,
        page: 1,
        width: Math.round(Math.round((fitted / ratio) * 1.25) * ratio),
        password: null,
      },
    });
  await expect(picture(2)).toBeVisible();
  await button("interface.DocumentReader.fitWidth").click();
  await expect(zoom(100)).toBeVisible();
  await expect(button("interface.DocumentReader.fitWidth")).toBeDisabled();
  // Check the rendered page, not just the zoom label: it fills the page
  // area's content box without leaving a horizontal scrollbar.
  await expect
    .poll(async () =>
      picture(2).evaluate((image) => {
        const area = image.parentElement!;
        const style = getComputedStyle(area);
        const available =
          area.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight);
        return Math.abs(image.getBoundingClientRect().width - available);
      }),
    )
    .toBeLessThanOrEqual(1);
  expect(await pageArea(2).evaluate((area) => area.clientWidth)).toBeGreaterThan(
    200,
  );
  expect(
    await pageArea(2).evaluate((area) => area.scrollWidth <= area.clientWidth),
  ).toBe(true);

  await button("interface.DocumentReader.previousPage").click();
  await expect(picture(1)).toBeVisible();
  await expect(reader.getByRole("status")).toHaveText(where(1));

  // Close: the reader is gone, a page still being drawn is stopped, and the
  // focus is back on the document it was opened from.
  await button("photo.close").click();
  await expect(reader).toBeHidden();
  await expect(
    page.getByRole("button", { name: LETTER, exact: true }),
  ).toBeFocused();
  expect(await fakeCommands(page)).toContain("vault_view_cancel");
  await expectOnlyFakedCommands(page);
});

test("a document locked with its own password asks for it in the reader, says when it is wrong, and keeps it for the next pages", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", lockedPdf: true });
  await page.goto("/");
  const details = await openDetails(page, LOCKED);
  await expect(
    details.getByText(
      en("interface.RecordDetails.lockedWithAPasswordUnlockAddsA"),
      { exact: true },
    ),
  ).toBeVisible();
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.read"),
      exact: true,
    })
    .click();

  const { reader, button, picture } = readerOf(page, LOCKED);
  const password = reader.getByLabel(
    en("interface.DocumentReader.documentPassword"),
    { exact: true },
  );
  await expect(
    reader.getByText(
      en("interface.DocumentReader.thisDocumentIsLockedWithItsOwn"),
      { exact: true },
    ),
  ).toBeVisible();
  await expect(password).toBeVisible();
  await expect(password).not.toHaveAttribute("aria-invalid", "true");
  await expect(reader.getByRole("img")).toHaveCount(0);
  const asked = await fakeCalls(page, "vault_view_page");
  expect(asked.length).toBeGreaterThan(0);
  for (const call of asked)
    expect(call).toEqual({
      request: {
        recordId: FAKE_IDS.locked,
        page: 0,
        width: expect.any(Number),
        password: null,
      },
    });

  // A wrong password: said, and the box is emptied for the next try.
  await password.fill(WRONG_PASSWORD);
  await button("interface.DocumentReader.open").click();
  const wrong = en(
    "interface.DocumentReader.thatPasswordDidNotOpenTheDocument",
  );
  await expect(reader.getByRole("alert")).toHaveText(wrong);
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(password).toHaveValue("");
  await expect(password).toHaveAccessibleDescription(
    messagePattern(
      "en",
      "interface.DocumentReader.thatPasswordDidNotOpenTheDocument",
    ),
  );
  await expect(reader.getByRole("img")).toHaveCount(0);
  expect(await fakeCalls(page, "vault_view_page")).toContainEqual({
    request: {
      recordId: FAKE_IDS.locked,
      page: 0,
      width: expect.any(Number),
      password: WRONG_PASSWORD,
    },
  });

  // The right one opens it; the next page is asked for with it too.
  await password.fill(FAKE_DOCUMENT_PASSWORD);
  await button("interface.DocumentReader.open").click();
  await expect(picture(1)).toBeVisible();
  await expect(password).toHaveCount(0);
  await expect(reader.getByRole("alert")).toHaveCount(0);
  await button("interface.DocumentReader.nextPage").click();
  await expect(picture(2)).toBeVisible();
  expect(await fakeCalls(page, "vault_view_page")).toContainEqual({
    request: {
      recordId: FAKE_IDS.locked,
      page: 1,
      width: expect.any(Number),
      password: FAKE_DOCUMENT_PASSWORD,
    },
  });
  // No box on the page holds it.
  expect(
    await page
      .locator("input")
      .evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).value),
      ),
  ).not.toContain(FAKE_DOCUMENT_PASSWORD);

  await button("photo.close").click();
  await expect(reader).toBeHidden();
  expect(await fakeCommands(page)).toContain("vault_view_cancel");
  await expectOnlyFakedCommands(page);
});

test("Unlock in a locked document's details adds a copy that opens without the password, and keeps the original", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", lockedPdf: true });
  await page.goto("/");
  const details = await openDetails(page, LOCKED);
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.unlock"),
      exact: true,
    })
    .click();

  const dialog = page.getByRole("dialog", {
    name: `${en("unlock.submit")} ${LOCKED}`,
    exact: true,
  });
  const password = dialog.getByLabel(
    en("interface.DocumentReader.documentPassword"),
    { exact: true },
  );
  const unlock = dialog.getByRole("button", {
    name: en("unlock.submit"),
    exact: true,
  });
  await expect(password).toBeFocused();

  await password.fill(WRONG_PASSWORD);
  await unlock.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    en("interface.DocumentReader.thatPasswordDidNotOpenTheDocument"),
  );
  await expect(password).toHaveValue("");
  await expect(password).toHaveAttribute("aria-invalid", "true");

  await password.fill(FAKE_DOCUMENT_PASSWORD);
  await unlock.click();
  await expect(dialog).toBeHidden();
  expect(await fakeCalls(page, "vault_unlock_pdf")).toEqual([
    { request: { recordId: FAKE_IDS.locked, password: WRONG_PASSWORD } },
    {
      request: { recordId: FAKE_IDS.locked, password: FAKE_DOCUMENT_PASSWORD },
    },
  ]);

  // The details now show the copy, which has the name and no lock; they say
  // what the original is called now.
  const original = lockedOriginalName(LOCKED);
  const copy = page.getByRole("dialog", { name: LOCKED, exact: true });
  await expect(copy.getByRole("status")).toHaveText(
    en("interface.notice.pdfUnlocked", { name: original }),
  );
  await expect(
    copy.getByRole("button", {
      name: en("interface.RecordDetails.unlock"),
      exact: true,
    }),
  ).toHaveCount(0);

  // The copy reads without a password.
  await copy
    .getByRole("button", {
      name: en("interface.RecordDetails.read"),
      exact: true,
    })
    .click();
  const { reader, picture } = readerOf(page, LOCKED);
  await expect(picture(1)).toBeVisible();
  expect((await fakeCalls(page, "vault_view_page")).at(-1)).toEqual({
    request: {
      recordId: FAKE_IDS.unlocked,
      page: 0,
      width: expect.any(Number),
      password: null,
    },
  });
  await reader
    .getByRole("button", { name: en("photo.close"), exact: true })
    .click();
  await expect(reader).toBeHidden();

  // Both are in My records: the copy, and the original under its new name.
  await expect(
    page.getByRole("button", { name: LOCKED, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: original, exact: true }),
  ).toBeVisible();
  await expectOnlyFakedCommands(page);
});

test("the reader closes, and stops the page being drawn, when the vault locks as myCarlos is minimized", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  const details = await openDetails(page, LETTER);
  // The PDF helper is still drawing page 1 when the lock comes (twice, in
  // case the reader asks again for a width that settled late).
  await scriptFake(page, "vault_view_page", { pending: true });
  await scriptFake(page, "vault_view_page", { pending: true });
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.read"),
      exact: true,
    })
    .click();
  const { reader } = readerOf(page, LETTER);
  await expect(reader.getByRole("status")).toHaveText(
    en("interface.reader.opening", { page: 1 }),
  );

  // The first page's draw is actually pending, not merely logged as asked for.
  await expect
    .poll(async () => (await fakeViewDraws(page)).pending)
    .toBeGreaterThan(0);
  const pendingBeforeLock = (await fakeViewDraws(page)).pending;

  await minimize(page);
  await expect(
    page.getByRole("heading", { name: en("unlock.title"), exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByLabel(en("passphrase.label"), { exact: true }),
  ).toHaveAccessibleDescription(messagePattern("en", "notice.lockedHidden"));
  const commands = await fakeCommands(page);
  expect(commands).toContain("vault_lock");
  expect(commands.lastIndexOf("vault_view_cancel")).toBeGreaterThan(
    commands.indexOf("vault_view_page"),
  );
  // The native cancellation has settled the in-flight draw(s). A cancel
  // command that merely logs a call while leaving the promise pending fails.
  await expect
    .poll(async () => (await fakeViewDraws(page)).pending)
    .toBe(0);
  expect((await fakeViewDraws(page)).cancelled).toBeGreaterThanOrEqual(
    pendingBeforeLock,
  );
  await expectOnlyFakedCommands(page);
});
