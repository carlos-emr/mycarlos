import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import {
  AI_COMMANDS,
  FAKE_MODEL,
  aiCalls,
  aiKept,
  answerAi,
  fakeAiWith,
  refuseAi,
} from "./support/aiFake";
import { translate } from "./support/fluent";
import { AI_EXPLAIN_ENABLED } from "../src/ai/features";
import {
  FAKE_IDS,
  FAKE_PAGE_COUNT,
  fakePageText,
  fakeVaultWith,
  myRecords,
  openDetails,
} from "./support/vaultFake";

// The AI helper's answers kept with the document (#212): a summary shown
// again from the vault without asking the model, Summarize again showing the
// newer answer while the older one stays in the vault, hidden, never deleted
// (Ben's D3), an explanation kept under the term as asked, and a failed keep
// said with the answer left on screen. The native side is faked
// (support/vaultFake.ts + support/aiFake.ts, whose vault keeps answers in
// memory as the real one does). FAKE data only.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

const LETTER = "FAKE Letter.pdf";

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the AI helper runs on computers only (the PDF helper reads the text)",
  );
});

async function start(page: Page) {
  await fakeVaultWith(page, { start: "unlocked" });
  await fakeAiWith(page, {
    model: { state: "installed", model: FAKE_MODEL },
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

/** Opens a tool; the first time in a session the notice comes first. */
async function open(page: Page, reader: Locator, tool: string, first = false) {
  await button(reader, tool).click();
  if (!first) return;
  const notice = page.getByRole("dialog", {
    name: en("aiHelper.notice.title"),
    exact: true,
  });
  await button(notice, en("interface.AiHelperNotice.continue")).click();
  await expect(notice).toBeHidden();
}

async function close(reader: Locator) {
  await button(reader, en("photo.close")).click();
  await expect(reader).toBeHidden();
}

const summaryPanel = (reader: Locator) =>
  reader.getByRole("region", { name: en("ai.summary.title"), exact: true });

const sentences = (panel: Locator) =>
  panel.getByRole("listitem").locator("span[id^='reader-ai-sentence-']");

test("a kept summary is shown again without the model, and Summarize again hides the older one", async ({
  page,
}) => {
  await start(page);
  let reader = await openReader(page);
  await open(page, reader, en("ai.summary.button"), true);
  let panel = summaryPanel(reader);
  await expect(sentences(panel)).toHaveCount(FAKE_PAGE_COUNT);
  const first = await sentences(panel).allTextContents();
  await expect(button(panel, en("ai.summary.again"))).toHaveCount(0);
  // Kept once, for the letter, as a summary in English.
  await expect.poll(() => aiKept(page)).toHaveLength(1);
  expect(await aiKept(page)).toMatchObject([
    { recordId: FAKE_IDS.letter, tool: "summary", lang: "en", hidden: false },
  ]);
  await close(reader);

  // Again: the kept summary, the model not asked.
  reader = await openReader(page);
  await open(page, reader, en("ai.summary.button"));
  panel = summaryPanel(reader);
  await expect(sentences(panel)).toHaveText(first);
  await expect(
    panel.getByText(en("aiHelper.resultLabel"), { exact: true }),
  ).toBeVisible();
  expect(await aiCalls(page, AI_COMMANDS.summarize)).toHaveLength(1);

  // Summarize again: the model's newer answer is shown and kept; the older
  // one stays in the vault, hidden, never deleted. Hiding it is the vault's
  // rule, which the fake copies; the native one is tested in
  // src-tauri/src/vault/ai_results.rs.
  await answerAi(page, AI_COMMANDS.summarize, {
    sentences: [
      { text: "FAKE: the newer summary.", quote: fakePageText(LETTER, 1) },
    ],
    model: FAKE_MODEL,
    lastPage: FAKE_PAGE_COUNT - 1,
    lastPageCut: false,
  });
  await button(panel, en("ai.summary.again")).click();
  await expect(sentences(panel)).toHaveText(["FAKE: the newer summary."]);
  expect(await aiCalls(page, AI_COMMANDS.summarize)).toHaveLength(2);
  await expect.poll(() => aiKept(page)).toHaveLength(2);
  const kept = await aiKept(page);
  expect(kept.map((answer) => answer.hidden)).toEqual([false, true]);
  expect(kept.map((answer) => answer.recordId)).toEqual([
    FAKE_IDS.letter,
    FAKE_IDS.letter,
  ]);
  expect(
    JSON.parse(kept[1].content).sentences.map((s: { text: string }) => s.text),
  ).toEqual(first);
  await close(reader);

  // The newer one is the one shown from now on.
  reader = await openReader(page);
  await open(page, reader, en("ai.summary.button"));
  await expect(sentences(summaryPanel(reader))).toHaveText([
    "FAKE: the newer summary.",
  ]);
  expect(await aiCalls(page, AI_COMMANDS.summarize)).toHaveLength(2);
  await expectOnlyFakedCommands(page);
});

test("an explanation is kept under the term as asked, without its spaces", async ({
  page,
}) => {
  test.skip(
    !AI_EXPLAIN_ENABLED,
    "Explain is switched off in the UI (src/ai/features.ts); ReaderAi.test.tsx covers keeping an explanation with the switch on",
  );
  await start(page);
  const reader = await openReader(page);
  await open(page, reader, en("ai.explain.title"), true);
  const panel = reader.getByRole("region", {
    name: en("ai.explain.title"),
    exact: true,
  });
  await panel
    .getByRole("textbox", { name: en("ai.explain.box"), exact: true })
    .fill("  FAKE term  ");
  await button(panel, en("ai.explain.submit")).click();
  await expect(
    panel.getByText(en("aiHelper.resultLabel"), { exact: true }),
  ).toBeVisible();
  await expect.poll(() => aiKept(page)).toHaveLength(1);
  const [kept] = await aiKept(page);
  expect(kept).toMatchObject({ tool: "explain", term: "FAKE term" });
  expect(JSON.parse(kept.content)).toMatchObject({
    tool: "explain",
    term: "FAKE term",
  });
  // The app trims the term before asking: the native side refuses a term
  // with spaces around it, while this fake would trim it.
  const [asked] = await aiCalls(page, AI_COMMANDS.explain);
  expect(asked.request).toMatchObject({
    term: "FAKE term",
    recordId: FAKE_IDS.letter,
  });
  await expectOnlyFakedCommands(page);
});

test("a summary the vault could not keep says so and stays on screen", async ({
  page,
}) => {
  await start(page);
  await refuseAi(page, AI_COMMANDS.keptSave, "aiFailed");
  const reader = await openReader(page);
  await open(page, reader, en("ai.summary.button"), true);
  const panel = summaryPanel(reader);
  await expect(sentences(panel)).toHaveCount(FAKE_PAGE_COUNT);
  await expect(panel.getByRole("alert")).toHaveText(en("ai.keepFailed"));
  // Still on screen once the keep has failed, not only before.
  await expect(sentences(panel)).toHaveCount(FAKE_PAGE_COUNT);
  await expect(
    panel.getByText(en("aiHelper.resultLabel"), { exact: true }),
  ).toBeVisible();
  expect(await aiKept(page)).toEqual([]);
  await expectOnlyFakedCommands(page);
});
