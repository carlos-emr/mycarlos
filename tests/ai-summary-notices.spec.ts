import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import {
  AI_COMMANDS,
  FAKE_MODEL,
  aiCalls,
  answerAi,
  fakeAiWith,
  type FakeAiSetup,
} from "./support/aiFake";
import { translate } from "./support/fluent";
import {
  FAKE_PAGE_COUNT,
  fakePageText,
  fakeVaultWith,
  myRecords,
  openDetails,
} from "./support/vaultFake";

// What a Summary says about the part of the document it did not read (#72,
// threat model AI-05): never a silent gap. The reader's text can be cut by
// its caps, a page can have no text, be cut short or fail to read, and the
// model can stop before the end; each says so under the answer, and a
// document with no text at all is never sent to the model. The native side
// is faked (support/vaultFake.ts + support/aiFake.ts). FAKE data only.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

const LETTER = "FAKE Letter.pdf";
const INSTALLED: FakeAiSetup["model"] = {
  state: "installed",
  model: FAKE_MODEL,
};

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the AI helper runs on computers only (the PDF helper reads the text)",
  );
});

/** Opens the letter in the reader, then its Summary (after the notice, the
 * first time in a session), and returns the Summary panel. */
async function summarize(
  page: Page,
  setup: FakeAiSetup,
  answer?: Record<string, unknown>,
): Promise<{ reader: Locator; panel: Locator }> {
  await fakeVaultWith(page, { start: "unlocked" });
  await fakeAiWith(page, { model: INSTALLED, ...setup });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  if (answer) await answerAi(page, AI_COMMANDS.summarize, answer);
  const details = await openDetails(page, LETTER);
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.read"),
      exact: true,
    })
    .click();
  const reader = page.getByRole("dialog", { name: LETTER, exact: true });
  await reader
    .getByRole("button", { name: en("ai.summary.button"), exact: true })
    .click();
  const notice = page.getByRole("dialog", {
    name: en("aiHelper.notice.title"),
    exact: true,
  });
  await notice
    .getByRole("button", {
      name: en("interface.AiHelperNotice.continue"),
      exact: true,
    })
    .click();
  await expect(notice).toBeHidden();
  const panel = reader.getByRole("region", {
    name: en("ai.summary.title"),
    exact: true,
  });
  await expect(panel).toBeVisible();
  return { reader, panel };
}

const partialFrom = (panel: Locator) =>
  panel.getByText(/^This summary covers only the start of the document/);
const missingFrom = (panel: Locator) =>
  panel.getByText(en("ai.summary.pagesMissing"), { exact: true });

/** The answer is on screen: one sentence per page the model was given. */
async function answered(panel: Locator, pages: number) {
  await expect(panel.getByRole("listitem")).toHaveCount(pages);
  await expect(
    panel.getByText(en("aiHelper.resultLabel"), { exact: true }),
  ).toBeVisible();
}

test("a summary of every page, read in full, has no warning", async ({
  page,
}) => {
  const { panel } = await summarize(page, {});
  await answered(panel, FAKE_PAGE_COUNT);
  await expect(partialFrom(panel)).toHaveCount(0);
  await expect(missingFrom(panel)).toHaveCount(0);
  const [call] = await aiCalls(page, AI_COMMANDS.summarize);
  expect(
    (call.request?.pages as { index: number }[]).map((p) => p.index),
  ).toEqual([0, 1, 2]);
  await expectOnlyFakedCommands(page);
});

test("a model that stopped before the end says which pages its summary covers", async ({
  page,
}) => {
  // The model had room for the first page only.
  const { panel } = await summarize(
    page,
    {},
    {
      sentences: [
        { text: "FAKE: the first page.", quote: fakePageText(LETTER, 1) },
      ],
      model: FAKE_MODEL,
      lastPage: 0,
      lastPageCut: false,
    },
  );
  await answered(panel, 1);
  await expect(partialFrom(panel)).toHaveText(
    en("ai.summary.partial", { last: 1 }),
  );
  await expect(missingFrom(panel)).toHaveCount(0);
});

test("a model that read only the start of the last page says the summary is partial", async ({
  page,
}) => {
  const { panel } = await summarize(
    page,
    {},
    {
      sentences: [
        { text: "FAKE: the first page.", quote: fakePageText(LETTER, 1) },
      ],
      model: FAKE_MODEL,
      lastPage: FAKE_PAGE_COUNT - 1,
      lastPageCut: true,
    },
  );
  await expect(partialFrom(panel)).toHaveText(
    en("ai.summary.partial", { last: FAKE_PAGE_COUNT }),
  );
});

test("a text cut by the reader's caps says the summary is partial", async ({
  page,
}) => {
  const { panel } = await summarize(page, {
    readAs: { [LETTER]: { truncated: true } },
  });
  await answered(panel, FAKE_PAGE_COUNT);
  await expect(partialFrom(panel)).toHaveText(
    en("ai.summary.partial", { last: FAKE_PAGE_COUNT }),
  );
});

const UNREAD: [what: string, setup: FakeAiSetup, given: number[]][] = [
  [
    "a page with no text (a scan)",
    { documents: { [LETTER]: ["FAKE page one.", "  ", "FAKE page three."] } },
    [0, 1, 2],
  ],
  [
    "a page the PDF helper cut short",
    { readAs: { [LETTER]: { cutPages: [1] } } },
    [0, 1, 2],
  ],
  [
    "a page the PDF helper could not read",
    { readAs: { [LETTER]: { failedPages: [1] } } },
    [0, 2],
  ],
];
for (const [what, setup, given] of UNREAD) {
  test(`${what} is never left out silently`, async ({ page }) => {
    const { panel } = await summarize(page, setup);
    await expect(missingFrom(panel)).toBeVisible();
    await expect(partialFrom(panel)).toHaveCount(0);
    // The model is given only the pages that were read, by their own index.
    const [call] = await aiCalls(page, AI_COMMANDS.summarize);
    expect(
      (call.request?.pages as { index: number }[]).map((p) => p.index),
    ).toEqual(given);
    await expectOnlyFakedCommands(page);
  });
}

test("a document with no text at all is never sent to the model", async ({
  page,
}) => {
  const { panel } = await summarize(page, {
    documents: { [LETTER]: ["", "   ", "\n"] },
  });
  await expect(
    panel.getByText(en("ai.summary.noText"), { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("listitem")).toHaveCount(0);
  expect(await aiCalls(page, AI_COMMANDS.summarize)).toEqual([]);
  await expectOnlyFakedCommands(page);
});
