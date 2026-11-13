import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import {
  AI_COMMANDS,
  FAKE_MODEL,
  aiCalls,
  fakeAiWith,
  type FakeCapacity,
} from "./support/aiFake";
import { translate } from "./support/fluent";
import {
  FAKE_PAGE_COUNT,
  fakeVaultWith,
  myRecords,
  openDetails,
  sidebar,
} from "./support/vaultFake";

// #301: a document longer than the model reads at a time. The settings say
// how much each model reads; the reader asks before the model starts, and
// either summarizes the pages it can read or closes. The native side is faked
// (support/vaultFake.ts + support/aiFake.ts). FAKE data only.
//
// Screenshots for review are written only when AI_TOO_LONG_SHOTS names a
// folder (desktop and 560 px wide).

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

const LETTER = "FAKE Letter.pdf";
// The helper's room for a catalogue model (local_model.rs Capacity::HELPER).
const HELPER: FakeCapacity = { contextTokens: 8192, documentTokens: 6510 };
// Three dense FAKE pages of about 9,150 bytes: about 2,900 tokens each by the
// estimate (capacity.ts), so pages 1 to 2 fit the room and page 3 does not.
const LONG_PAGES = Array.from(
  { length: FAKE_PAGE_COUNT },
  (_, index) =>
    `FAKE page ${["one", "two", "three"][index]} of a long letter.\n` +
    "FAKE text of a long letter, written for this check only. ".repeat(160),
);
const SHOTS = process.env.AI_TOO_LONG_SHOTS;

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the AI helper runs on computers only (the PDF helper reads the text)",
  );
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

async function start(page: Page) {
  await fakeVaultWith(page, { start: "unlocked" });
  await fakeAiWith(page, {
    model: { state: "installed", model: FAKE_MODEL, capacity: HELPER },
    catalog: { capacity: HELPER },
    documents: { [LETTER]: LONG_PAGES },
    // As the helper's own count would: pages 1 to 2.
    readUpTo: 1,
  });
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

const button = (scope: Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });

/** Opens Summary; the first time in a session the notice comes first. */
async function openSummary(page: Page, reader: Locator) {
  await button(reader, en("ai.summary.button")).click();
  const notice = page.getByRole("dialog", {
    name: en("aiHelper.notice.title"),
    exact: true,
  });
  await button(notice, en("interface.AiHelperNotice.continue")).click();
  await expect(notice).toBeHidden();
}

const summaryPanel = (reader: Locator) =>
  reader.getByRole("region", { name: en("ai.summary.title"), exact: true });

const QUESTION = () => en("ai.summary.tooLong", { last: 2, total: 3 });

test("asks before summarizing a document too long to read at once, and summarizes the pages it can read", async ({
  page,
}) => {
  await start(page);
  const reader = await openReader(page);
  await openSummary(page, reader);
  const panel = summaryPanel(reader);
  await expect(panel.getByText(QUESTION(), { exact: true })).toBeVisible();
  await expect(
    panel.getByText(en("ai.summary.tooLongAfter"), { exact: true }),
  ).toBeVisible();
  // The first answer has the focus, described by the question.
  const read = button(panel, en("ai.summary.readPages", { last: 2 }));
  await expect(read).toBeFocused();
  await expect(read).toHaveAccessibleDescription(
    `${QUESTION()} ${en("ai.summary.tooLongAfter")}`,
  );
  // Nothing was asked of the model yet.
  expect(await aiCalls(page, AI_COMMANDS.summarize)).toHaveLength(0);
  await shot(page, "1-reader-question-desktop");

  await page.keyboard.press("Enter");
  await expect(panel.getByText(QUESTION(), { exact: true })).toHaveCount(0);
  await expect(button(reader, en("ai.summary.button"))).toBeFocused();
  // The answer says the pages the helper read, as before.
  await expect(
    panel.getByText(en("ai.summary.partial", { last: 2 }), { exact: true }),
  ).toBeVisible();
  expect(await aiCalls(page, AI_COMMANDS.summarize)).toHaveLength(1);
  await shot(page, "3-reader-after-summarize-desktop");
  await expectOnlyFakedCommands(page);
});

test("at 560 px wide the question fits without scrolling sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 560, height: 900 });
  await start(page);
  const reader = await openReader(page);
  await openSummary(page, reader);
  const panel = summaryPanel(reader);
  await expect(panel.getByText(QUESTION(), { exact: true })).toBeVisible();
  const read = button(panel, en("ai.summary.readPages", { last: 2 }));
  await expect(read).toBeFocused();
  await expect(button(panel, en("common.cancel"))).toBeInViewport();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await shot(page, "2-reader-question-560");
});

test("Cancel closes the panel, asks no model, and puts the focus back on Summary", async ({
  page,
}) => {
  await start(page);
  const reader = await openReader(page);
  await openSummary(page, reader);
  const panel = summaryPanel(reader);
  await expect(panel.getByText(QUESTION(), { exact: true })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(button(panel, en("common.cancel"))).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel).toBeHidden();
  const summary = button(reader, en("ai.summary.button"));
  await expect(summary).toBeFocused();
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  expect(await aiCalls(page, AI_COMMANDS.summarize)).toHaveLength(0);
  await expectOnlyFakedCommands(page);
});

test("the AI helper's settings say how much a model reads at a time", async ({
  page,
}) => {
  await start(page);
  await sidebar(page)
    .getByRole("button", { name: en("ai.preferences.title"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("ai.preferences.title"), level: 1 }),
  ).toBeVisible();
  const reads = page.getByText(
    en("ai.model.reads", { pages: 6, characters: 19000 }),
    { exact: true },
  );
  await expect(reads).toBeVisible();
  await reads.scrollIntoViewIfNeeded();
  await shot(page, "4-settings-desktop");
  await page.setViewportSize({ width: 560, height: 900 });
  await reads.scrollIntoViewIfNeeded();
  await shot(page, "5-settings-560");
  await expectOnlyFakedCommands(page);
});
