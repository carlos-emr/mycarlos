import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  expectAnnounced,
  expectOnlyFakedCommands,
  recordAnnouncements,
  screenReaderSmoke,
  walk,
} from "./support/a11y";
import {
  AI_COMMANDS,
  FAKE_MODEL,
  answerAi,
  fakeAiWith,
  holdAi,
  refuseAi,
  releaseAi,
  type FakeAiSetup,
} from "./support/aiFake";
import { translate } from "./support/fluent";
import {
  FAKE_PAGE_COUNT,
  fakeVaultWith,
  myRecords,
  openDetails,
} from "./support/vaultFake";

// The AI helper's new screens (#72) for people who use a keyboard, a screen
// reader or large text: the reader's Summary and Explain panel, the notice
// over it, and the model's row on its Settings page (Download, Cancel, Add,
// Remove). Each checks axe (WCAG 2.2 AA), that every control is named and
// reached by Tab with its focus shown, where the focus goes after an action,
// what live regions read out, and 200% text in a 320 px window. The native
// side is faked (support/vaultFake.ts + support/aiFake.ts). FAKE data only.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

const LETTER = "FAKE Letter.pdf";
const INSTALLED: FakeAiSetup["model"] = {
  state: "installed",
  model: FAKE_MODEL,
};
const MB = (bytes: number) =>
  Math.round(bytes / 1_000_000).toLocaleString("en");
const TOTAL = 2_500_000_000;

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the AI helper runs on computers only",
  );
});

async function openLibrary(page: Page, setup: FakeAiSetup = {}) {
  await recordAnnouncements(page);
  await fakeVaultWith(page, { start: "unlocked" });
  await fakeAiWith(page, setup);
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
}

async function openReader(page: Page) {
  const details = await openDetails(page, LETTER);
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.read"),
      exact: true,
    })
    .click();
  const reader = page.getByRole("dialog", { name: LETTER, exact: true });
  await expect(
    reader.getByRole("img", {
      name: en("interface.reader.textFollows", {
        page: 1,
        total: FAKE_PAGE_COUNT,
      }),
      exact: true,
    }),
  ).toBeVisible();
  return reader;
}

async function openAiSettings(page: Page) {
  // The AI helper's own Settings page (#242): in the sidebar, or, in a
  // narrow window, among the section tabs.
  await page
    .getByRole("button", { name: en("ai.preferences.title"), exact: true })
    .locator("visible=true")
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: en("ai.preferences.title"), level: 1 }),
  ).toBeVisible();
  return page.locator("section.setting-row").filter({
    has: page.getByRole("heading", { name: en("ai.preferences.title") }),
  });
}

const button = (scope: Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });

/** Presses Enter on a control, as a keyboard user does. */
async function press(control: Locator) {
  await control.focus();
  await expect(control).toBeFocused();
  await control.page().keyboard.press("Enter");
}

/** The focus is inside `scope`, not lost to the page. */
async function expectFocusIn(scope: Locator, where: string) {
  await expect
    .poll(
      () =>
        scope.evaluate((element) => {
          const focused = document.activeElement;
          return Boolean(
            focused && focused !== document.body && element.contains(focused),
          );
        }),
      { message: `${where}: the focus stays in it` },
    )
    .toBe(true);
}

test("the reader's Summary by keyboard: the notice takes and gives back the focus, and the work and the answer are read out", async ({
  page,
}) => {
  await openLibrary(page, { model: INSTALLED });
  const reader = await openReader(page);
  const summary = button(reader, en("ai.summary.button"));
  await press(summary);

  const notice = page.getByRole("dialog", {
    name: en("aiHelper.notice.title"),
    exact: true,
  });
  const go = button(notice, en("interface.AiHelperNotice.continue"));
  await expect(go).toBeFocused();
  await screenReaderSmoke(page, "the notice over the reader", notice);
  await page.keyboard.press("Enter");
  await expect(notice).toBeHidden();
  // Back on the button that opened it.
  await expect(summary).toBeFocused();

  const panel = reader.getByRole("region", {
    name: en("ai.summary.title"),
    exact: true,
  });
  await expect(panel).toContainText(en("aiHelper.resultLabel"));
  await expectAnnounced(page, en("ai.working"));
  // That the answer came is read out, not only shown.
  await expectAnnounced(page, en("ai.summary.ready"));

  await screenReaderSmoke(page, "the reader with a summary", reader);
  await walk(page, "the reader with a summary", '[role="dialog"]');
  await expectOnlyFakedCommands(page);
});

test("Explain by keyboard: the box is labelled, Enter asks, and the answer is read out", async ({
  page,
}) => {
  await openLibrary(page, {
    model: INSTALLED,
    explanation: "FAKE: a word from the letter, in plain words.",
  });
  const reader = await openReader(page);
  await press(button(reader, en("ai.explain.title")));
  await page.keyboard.press("Enter"); // Continue, on the notice
  const panel = reader.getByRole("region", {
    name: en("ai.explain.title"),
    exact: true,
  });
  const box = panel.getByRole("textbox", {
    name: en("ai.explain.box"),
    exact: true,
  });
  await expect(box).toHaveAccessibleDescription(en("ai.explain.hint"));
  await box.focus();
  await page.keyboard.type("FAKE term");
  await page.keyboard.press("Enter");
  await expect(panel).toContainText(
    "FAKE: a word from the letter, in plain words.",
  );
  await expectAnnounced(page, en("ai.explain.ready"));
  await screenReaderSmoke(page, "the reader with an explanation", reader);
  await expectOnlyFakedCommands(page);
});

test("a run that could not finish is an alert, and no model leads on by keyboard", async ({
  page,
}) => {
  await openLibrary(page, { model: INSTALLED });
  await refuseAi(page, AI_COMMANDS.summarize, "aiFailed");
  let reader = await openReader(page);
  await press(button(reader, en("ai.summary.button")));
  await page.keyboard.press("Enter"); // Continue, on the notice
  await expectAnnounced(page, en("ai.failed"));
  await screenReaderSmoke(page, "the reader, the run failed", reader);
  await press(button(reader, en("photo.close")));
  await expect(reader).toBeHidden();

  // A model file that failed its check reads as none: Open AI helper settings.
  await refuseAi(page, AI_COMMANDS.summarize, "aiDamaged");
  reader = await openReader(page);
  await press(button(reader, en("ai.summary.button")));
  const panel = reader.getByRole("region", {
    name: en("ai.summary.title"),
    exact: true,
  });
  const preferences = button(panel, en("ai.notInstalled.openPreferences"));
  await expect(preferences).toBeVisible();
  await screenReaderSmoke(page, "the reader, no model to use", reader);
  await press(preferences);
  await expect(
    page.getByRole("heading", { name: en("ai.preferences.title"), level: 1 }),
  ).toBeVisible();
  await expectOnlyFakedCommands(page);
});

test("Download by keyboard: the focus stays in the AI helper row through the progress, Cancel and the end, which are read out", async ({
  page,
}) => {
  await openLibrary(page);
  const row = await openAiSettings(page);
  await screenReaderSmoke(page, "AI helper settings, no model");

  // Started, then cancelled.
  await holdAi(page, AI_COMMANDS.download);
  await press(button(row, en("ai.model.download")));
  await expectAnnounced(
    page,
    en("ai.model.downloading", { done: MB(TOTAL / 2), total: MB(TOTAL) }),
  );
  await expectFocusIn(row, "the row while it downloads");
  await screenReaderSmoke(page, "AI helper settings, downloading");
  const cancel = button(row, en("common.cancel"));
  await press(cancel);
  await expect(button(row, en("ai.model.download"))).toBeEnabled();
  await expectFocusIn(row, "the row after Cancel");

  // Started again, to the end.
  await holdAi(page, AI_COMMANDS.download);
  await press(button(row, en("ai.model.download")));
  await expectFocusIn(row, "the row while it downloads");
  await releaseAi(page, AI_COMMANDS.download);
  await expectAnnounced(page, en("ai.model.added"));
  await expect(row).toContainText(
    en("ai.model.installed", { name: FAKE_MODEL.name }),
  );
  await expectFocusIn(row, "the row once the model is added");
  await screenReaderSmoke(page, "AI helper settings, a model added");
  await expectOnlyFakedCommands(page);
});

test("a refused download is an alert, and the focus stays in the row", async ({
  page,
}) => {
  await openLibrary(page);
  const row = await openAiSettings(page);
  await answerAi(page, AI_COMMANDS.download, { outcome: "network" });
  await press(button(row, en("ai.model.download")));
  await expectAnnounced(page, en("ai.model.refusedNetwork"));
  await expectFocusIn(row, "the row after a refusal");
  await expectOnlyFakedCommands(page);
});

test("Remove by keyboard: the question takes the focus, Cancel gives it back, and after removing the focus stays in the row", async ({
  page,
}) => {
  await openLibrary(page, { model: INSTALLED });
  const row = await openAiSettings(page);
  const remove = button(row, en("ai.model.remove"));
  await press(remove);
  const question = page.getByRole("alertdialog");
  await expectFocusIn(question, "the question");
  await screenReaderSmoke(page, "Remove the model?", question);
  await press(button(question, en("common.cancel")));
  await expect(question).toBeHidden();
  await expect(remove).toBeFocused();

  await press(remove);
  await press(button(page.getByRole("alertdialog"), en("ai.model.remove")));
  await expect(button(row, en("ai.model.download"))).toBeVisible();
  await expectFocusIn(row, "the row once the model is removed");
  await expectOnlyFakedCommands(page);
});

test("the row's other states are named and pass axe: damaged, and a computer that cannot run the model", async ({
  page,
}) => {
  await openLibrary(page, { model: { state: "damaged" } });
  await openAiSettings(page);
  await screenReaderSmoke(page, "AI helper settings, a damaged model");
  // A page of its own: the fakes are installed once per page.
  const other = await page.context().newPage();
  await openLibrary(other, { model: { state: "unsupported", reason: "ram" } });
  await openAiSettings(other);
  await screenReaderSmoke(other, "AI helper settings, not enough memory");
});

/** Nothing scrolls sideways, and no control's words spill out or are cut. */
async function expectReflow(page: Page, where: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    `${where}: scrolls sideways`,
  ).toBe(true);
  const cut = await page.evaluate(() =>
    Array.from(
      document.body.querySelectorAll<HTMLElement>("button, a[href], summary"),
    )
      .filter((control) => control.checkVisibility())
      .filter(
        (control) =>
          control.scrollWidth > control.clientWidth + 1 ||
          control.scrollHeight > control.clientHeight + 1,
      )
      .map((control) => (control.textContent ?? "").trim().slice(0, 40)),
  );
  expect(cut, `${where}: controls cut off`).toEqual([]);
}

test("at 200% text in a 320 px window: the reader's panel and the model's row, with a long address, all reflow", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 320, height: 720 },
  });
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32 } });
    await openLibrary(page, { model: INSTALLED });
    const reader = await openReader(page);
    await button(reader, en("ai.summary.button")).click();
    await button(
      page.getByRole("dialog", { name: en("aiHelper.notice.title") }),
      en("interface.AiHelperNotice.continue"),
    ).click();
    await expect(reader).toContainText(en("aiHelper.resultLabel"));
    await expectReflow(page, "the reader with a summary");
    await button(reader, en("ai.explain.title")).click();
    await expectReflow(page, "the reader's Explain");
    await button(reader, en("photo.close")).click();

    // The row, with the model's real-length address and a refusal shown,
    // on a page of its own (the fakes are installed once per page).
    const second = await context.newPage();
    await (
      await context.newCDPSession(second)
    ).send("Page.setFontSizes", {
      fontSizes: { standard: 32 },
    });
    await openLibrary(second);
    await answerAi(second, AI_COMMANDS.catalog, [
      {
        name: FAKE_MODEL.name,
        fileName: "FAKE-model-name-instruct-Q4_K_M.gguf",
        sizeBytes: TOTAL,
        sha256: FAKE_MODEL.sha256,
        licence: "FAKE licence",
        notices: [],
        sourceUrl:
          "https://huggingface.co/FAKE-organisation/FAKE-model-name-instruct-GGUF/resolve/FAKE-revision/FAKE-model-name-instruct-Q4_K_M.gguf",
      },
    ]);
    const row = await openAiSettings(second);
    // The address itself (the download note names its host too).
    await expect(
      row.locator("code", { hasText: "huggingface.co" }),
    ).toBeVisible();
    await answerAi(second, AI_COMMANDS.download, { outcome: "unavailable" });
    await button(row, en("ai.model.download")).click();
    await expect(row.getByRole("alert")).toBeVisible();
    await expectReflow(second, "AI helper settings, the model's row");
  } finally {
    await context.close();
  }
});
