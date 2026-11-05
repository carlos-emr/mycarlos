import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import {
  AI_COMMANDS,
  FAKE_MODEL,
  aiCalls,
  aiCancelled,
  aiHeld,
  fakeAiWith,
  holdAi,
  refuseAi,
  type FakeAiSetup,
} from "./support/aiFake";
import { translate } from "./support/fluent";
import {
  FAKE_PAGE_COUNT,
  fakeCalls,
  fakePageText,
  fakeVaultWith,
  myRecords,
  openDetails,
} from "./support/vaultFake";

// The reader's AI helper (#72): Summary and Explain with no model on this
// computer, and with a FAKE one; the text read and the model run stopping
// when the patient leaves the reader or the vault locks. The native side is
// faked (support/vaultFake.ts + support/aiFake.ts): the model's answers come
// from ai_summarize and ai_explain, as root-aa's runtime gives them. With a
// model, the first Summary or Explain of a session comes after the AI
// helper's notice. FAKE data only.

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

async function openReader(page: Page, setup: FakeAiSetup = {}) {
  await fakeVaultWith(page, { start: "unlocked" });
  await fakeAiWith(page, setup);
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
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

const button = (reader: Locator, name: string) =>
  reader.getByRole("button", { name, exact: true });
const panel = (reader: Locator, title: string) =>
  reader.getByRole("region", { name: title, exact: true });

const noticeOf = (page: Page) =>
  page.getByRole("dialog", { name: en("aiHelper.notice.title"), exact: true });

/** Opens a tool the first time in a session with a model: the notice comes
 * first, and Continue opens the tool. */
async function firstUse(page: Page, reader: Locator, tool: string) {
  await button(reader, tool).click();
  const notice = noticeOf(page);
  await expect(notice).toBeVisible();
  await notice
    .getByRole("button", {
      name: en("interface.AiHelperNotice.continue"),
      exact: true,
    })
    .click();
  await expect(notice).toBeHidden();
}

async function lockByMinimizing(page: Page) {
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
  await expect(
    page.getByRole("heading", { name: en("unlock.title"), exact: true }),
  ).toBeVisible();
}

test("with no model, Summary and Explain say so and lead to Preferences, and nothing is read", async ({
  page,
}) => {
  const reader = await openReader(page);
  const summary = button(reader, en("ai.summary.button"));
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await summary.click();
  await expect(summary).toHaveAttribute("aria-expanded", "true");
  const summaryPanel = panel(reader, en("ai.summary.title"));
  await expect(summaryPanel).toContainText(en("ai.notInstalled.title"));
  await expect(summaryPanel).toContainText(en("ai.notInstalled.body"));

  await button(reader, en("ai.explain.title")).click();
  const explainPanel = panel(reader, en("ai.explain.title"));
  await expect(explainPanel).toContainText(en("ai.notInstalled.title"));
  await expect(explainPanel.getByRole("textbox")).toHaveCount(0);

  // Open the AI helper's settings: the reader closes, and the helper's own
  // page says why.
  await explainPanel
    .getByRole("button", {
      name: en("ai.notInstalled.openPreferences"),
      exact: true,
    })
    .click();
  await expect(reader).toBeHidden();
  await expect(
    page.getByRole("heading", { name: en("ai.preferences.title"), level: 1 }),
  ).toBeVisible();
  const row = page.getByRole("heading", {
    name: `${en("ai.preferences.title")} ${en("ai.preferences.notInstalled")}`,
    exact: true,
  });
  await expect(row).toBeVisible();
  await expect(page.getByText(en("ai.preferences.body"))).toBeVisible();

  // Nothing was read for a model that is not there.
  expect(await aiCalls(page, AI_COMMANDS.documentText)).toEqual([]);
  expect(await aiCalls(page, AI_COMMANDS.summarize)).toEqual([]);
  expect(await aiCalls(page, AI_COMMANDS.explain)).toEqual([]);
  await expectOnlyFakedCommands(page);
});

test("leaving the reader while its Summary reads the text stops the read", async ({
  page,
}) => {
  const reader = await openReader(page, { model: INSTALLED });
  await holdAi(page, AI_COMMANDS.documentText);
  await firstUse(page, reader, en("ai.summary.button"));
  await expect(panel(reader, en("ai.summary.title"))).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect.poll(() => aiHeld(page)).toEqual([AI_COMMANDS.documentText]);

  await button(reader, en("photo.close")).click();
  await expect(reader).toBeHidden();
  expect(await aiCalls(page, AI_COMMANDS.cancelText)).toHaveLength(1);
  await expect.poll(() => aiHeld(page)).toEqual([]);
  expect(await aiCancelled(page)).toEqual([
    { command: AI_COMMANDS.documentText, by: AI_COMMANDS.cancelText },
  ]);
  // No model was asked for a text that was never read.
  expect(await aiCalls(page, AI_COMMANDS.summarize)).toEqual([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("switching from Summary to Explain while the text is read stops the read", async ({
  page,
}) => {
  const reader = await openReader(page, { model: INSTALLED });
  await holdAi(page, AI_COMMANDS.documentText);
  await firstUse(page, reader, en("ai.summary.button"));
  await expect.poll(() => aiHeld(page)).toEqual([AI_COMMANDS.documentText]);

  await button(reader, en("ai.explain.title")).click();
  await expect(panel(reader, en("ai.explain.title"))).toBeVisible();
  expect(await aiCalls(page, AI_COMMANDS.cancelText)).toHaveLength(1);
  await expect.poll(() => aiHeld(page)).toEqual([]);
  await expect(reader.getByRole("alert")).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("a lock while the Summary reads the text ends the read and the reader", async ({
  page,
}) => {
  const reader = await openReader(page, { model: INSTALLED });
  await holdAi(page, AI_COMMANDS.documentText);
  await firstUse(page, reader, en("ai.summary.button"));
  await expect.poll(() => aiHeld(page)).toEqual([AI_COMMANDS.documentText]);

  await lockByMinimizing(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await fakeCalls(page, "vault_lock")).toHaveLength(1);
  await expect.poll(() => aiHeld(page)).toEqual([]);
  // The lock ends the read natively; the reader's own close may ask too.
  expect((await aiCancelled(page)).map((entry) => entry.command)).toEqual([
    AI_COMMANDS.documentText,
  ]);
  expect(await aiCalls(page, AI_COMMANDS.summarize)).toEqual([]);
  await expectOnlyFakedCommands(page);
});

test.describe("with a model on this computer", () => {
  test("a summary is labeled as the AI's, links its sources, and was asked for the document's pages", async ({
    page,
  }) => {
    const reader = await openReader(page, { model: INSTALLED });
    await firstUse(page, reader, en("ai.summary.button"));
    const summaryPanel = panel(reader, en("ai.summary.title"));
    await expect(summaryPanel).toContainText(en("aiHelper.resultLabel"));
    // One FAKE sentence per page, each quoting its page's first line.
    const firstLine = fakePageText(LETTER, 1);
    await expect(summaryPanel).toContainText(
      `FAKE: page 1 begins “${firstLine}”.`,
    );
    await expect(summaryPanel).toContainText(FAKE_MODEL.name);
    const [asked] = await aiCalls(page, AI_COMMANDS.summarize);
    expect(asked.request?.lang).toBe("en");
    expect(asked.request?.pages).toEqual(
      Array.from({ length: FAKE_PAGE_COUNT }, (_, index) => ({
        index,
        text: fakePageText(LETTER, index + 1),
      })),
    );

    // A sentence's source is shown on its page, marked.
    await summaryPanel
      .getByRole("button", { name: en("ai.summary.showInDocument") })
      .nth(1)
      .click();
    await expect(
      reader.getByRole("img", {
        name: en("interface.reader.textFollows", {
          page: 2,
          total: FAKE_PAGE_COUNT,
        }),
        exact: true,
      }),
    ).toBeVisible();
    await expect(reader.locator(".native-reader-text mark")).toHaveText(
      fakePageText(LETTER, 2),
    );
    await expectOnlyFakedCommands(page);
  });

  test("a typed term is explained, with the model and the label", async ({
    page,
  }) => {
    const reader = await openReader(page, {
      model: INSTALLED,
      explanation: "FAKE: a word from the letter, in plain words.",
    });
    await firstUse(page, reader, en("ai.explain.title"));
    const explainPanel = panel(reader, en("ai.explain.title"));
    await explainPanel
      .getByLabel(en("ai.explain.box"), { exact: true })
      .fill("FAKE term");
    await explainPanel
      .getByRole("button", { name: en("ai.explain.submit"), exact: true })
      .click();
    await expect(explainPanel).toContainText(
      "FAKE: a word from the letter, in plain words.",
    );
    await expect(explainPanel).toContainText(en("aiHelper.resultLabel"));
    const [asked] = await aiCalls(page, AI_COMMANDS.explain);
    expect(asked.request).toMatchObject({ term: "FAKE term", lang: "en" });
    await expectOnlyFakedCommands(page);
  });

  test("leaving the reader while the model writes stops the model run", async ({
    page,
  }) => {
    const reader = await openReader(page, { model: INSTALLED });
    await holdAi(page, AI_COMMANDS.summarize);
    await firstUse(page, reader, en("ai.summary.button"));
    await expect.poll(() => aiHeld(page)).toEqual([AI_COMMANDS.summarize]);
    await button(reader, en("photo.close")).click();
    await expect(reader).toBeHidden();
    expect(await aiCalls(page, AI_COMMANDS.cancel)).toHaveLength(1);
    await expect.poll(() => aiHeld(page)).toEqual([]);
    expect(await aiCancelled(page)).toEqual([
      { command: AI_COMMANDS.summarize, by: AI_COMMANDS.cancel },
    ]);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expectOnlyFakedCommands(page);
  });

  test("a lock while the model writes ends the run, and no answer is shown", async ({
    page,
  }) => {
    const reader = await openReader(page, { model: INSTALLED });
    await holdAi(page, AI_COMMANDS.summarize);
    await firstUse(page, reader, en("ai.summary.button"));
    await expect.poll(() => aiHeld(page)).toEqual([AI_COMMANDS.summarize]);
    await lockByMinimizing(page);
    await expect.poll(() => aiHeld(page)).toEqual([]);
    expect((await aiCancelled(page)).map((entry) => entry.command)).toEqual([
      AI_COMMANDS.summarize,
    ]);
    await expect(page.getByText(en("aiHelper.resultLabel"))).toHaveCount(0);
    await expectOnlyFakedCommands(page);
  });

  test("the first Summary of an unlocked session shows the notice first, and nothing reaches the model before it closes", async ({
    page,
  }) => {
    const reader = await openReader(page, { model: INSTALLED });
    await button(reader, en("ai.summary.button")).click();
    const notice = page.getByRole("dialog", {
      name: en("aiHelper.notice.title"),
      exact: true,
    });
    await expect(notice).toBeVisible();
    // Where the model runs, the notice says what it does here.
    await expect(notice).toContainText(en("aiHelper.notice.intro"));
    await expect(notice).toContainText(en("aiHelper.notice.modelBody"));
    // Answers are not kept in the vault yet (#212): no promise that they are.
    await expect(notice).not.toContainText(en("aiHelper.notice.resultsBody"));
    await expect(
      notice.getByRole("button", {
        name: en("interface.AiHelperNotice.continue"),
        exact: true,
      }),
    ).toBeFocused();
    expect(await aiCalls(page, AI_COMMANDS.documentText)).toEqual([]);
    expect(await aiCalls(page, AI_COMMANDS.summarize)).toEqual([]);
    await notice
      .getByRole("button", {
        name: en("interface.AiHelperNotice.continue"),
        exact: true,
      })
      .click();
    await expect(panel(reader, en("ai.summary.title"))).toContainText(
      en("aiHelper.resultLabel"),
    );
    expect(await aiCalls(page, AI_COMMANDS.summarize)).toHaveLength(1);
    await expectOnlyFakedCommands(page);
  });

  test("a model file that fails its check leads to Preferences, not to Try again", async ({
    page,
  }) => {
    const reader = await openReader(page, { model: INSTALLED });
    await refuseAi(page, AI_COMMANDS.summarize, "aiDamaged");
    await firstUse(page, reader, en("ai.summary.button"));
    const summaryPanel = panel(reader, en("ai.summary.title"));
    await expect(summaryPanel).toContainText(en("ai.notInstalled.title"));
    await expect(
      summaryPanel.getByRole("button", {
        name: en("ai.notInstalled.openPreferences"),
        exact: true,
      }),
    ).toBeVisible();
    await expect(summaryPanel.getByRole("alert")).toHaveCount(0);
    await expectOnlyFakedCommands(page);
  });

  for (const code of ["aiMemory", "aiBusy", "aiFailed"] as const)
    test(`a run refused with ${code} says the helper could not finish`, async ({
      page,
    }) => {
      const reader = await openReader(page, { model: INSTALLED });
      await refuseAi(page, AI_COMMANDS.summarize, code);
      await firstUse(page, reader, en("ai.summary.button"));
      await expect(
        panel(reader, en("ai.summary.title")).getByRole("alert"),
      ).toHaveText(en("ai.failed"));
      await expect(page.getByText(en("aiHelper.resultLabel"))).toHaveCount(0);
      await expectOnlyFakedCommands(page);
    });
});
