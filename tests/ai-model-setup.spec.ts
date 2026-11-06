import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import {
  AI_COMMANDS,
  FAKE_MODEL,
  aiCalls,
  aiCancelled,
  aiHeld,
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
  sidebar,
} from "./support/vaultFake";

// Getting the AI helper's model onto this computer (#72), in Preferences:
// Download the default model (progress, cancel, success, and its
// refusals), Add a model file (checking, installed, refused, picker closed),
// Remove, a damaged or unsupported model, and the reader's not-installed
// state leading here. The native side is faked (support/vaultFake.ts +
// support/aiFake.ts): no file is fetched or read. The catalogue's one model
// is FAKE, about 2,500 MB, from example.invalid. FAKE data only.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

const LETTER = "FAKE Letter.pdf";
const INSTALLED: FakeAiSetup["model"] = {
  state: "installed",
  model: FAKE_MODEL,
};
// As the row writes sizes: whole megabytes, in the app's language.
const MB = (bytes: number) =>
  Math.round(bytes / 1_000_000).toLocaleString("en");
const TOTAL = 2_500_000_000;

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the AI helper runs on computers only",
  );
});

async function openPreferences(page: Page, setup: FakeAiSetup = {}) {
  await fakeVaultWith(page, { start: "unlocked" });
  await fakeAiWith(page, setup);
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await sidebar(page)
    .getByRole("button", { name: en("sidebar.preferences"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("sidebar.preferences"), level: 1 }),
  ).toBeVisible();
  return aiRow(page);
}

/** The AI helper's row in Preferences. */
const aiRow = (page: Page) =>
  page.locator("section.setting-row").filter({
    has: page.getByRole("heading", { name: en("ai.preferences.title") }),
  });
const rowButton = (row: Locator, key: Parameters<typeof translate>[1]) =>
  row.getByRole("button", {
    name:
      key === "ai.model.download"
        ? `${en("ai.models.download")} ${FAKE_MODEL.name}`
        : key === "ai.model.remove"
          ? `${en("ai.models.remove")} ${FAKE_MODEL.name}`
          : en(key),
    exact: true,
  });

test("downloads the default model with its progress, and the reader's Summary uses it", async ({
  page,
}) => {
  const row = await openPreferences(page);
  await expect(row).toContainText(
    en("ai.model.accepted", {
      name: FAKE_MODEL.name,
      size: MB(TOTAL),
      licence: "FAKE licence",
    }),
  );
  await expect(row).toContainText(
    en("ai.model.downloadNote", { size: MB(TOTAL), host: "example.invalid" }),
  );
  await expect(rowButton(row, "ai.model.add")).toBeVisible();

  await holdAi(page, AI_COMMANDS.download);
  await rowButton(row, "ai.model.download").click();
  // Half way, with Cancel, and neither button may start a second copy.
  await expect(row.getByRole("status")).toHaveText(
    en("ai.model.downloading", { done: MB(TOTAL / 2), total: MB(TOTAL) }),
  );
  await expect(rowButton(row, "common.cancel")).toBeVisible();
  await expect(rowButton(row, "ai.model.download")).toBeDisabled();
  await expect(rowButton(row, "ai.model.add")).toBeDisabled();

  await releaseAi(page, AI_COMMANDS.download);
  await expect(row.getByRole("status")).toHaveText(en("ai.model.added"));
  await expect(
    row.getByRole("radio", { name: FAKE_MODEL.name, exact: true }),
  ).toBeChecked();
  await expect(rowButton(row, "ai.model.remove")).toBeVisible();
  await expect(rowButton(row, "ai.model.download")).toHaveCount(0);
  expect(await aiCalls(page, AI_COMMANDS.download)).toHaveLength(1);

  // The reader now has a model: the notice first, then the summary.
  await sidebar(page)
    .getByRole("button", { name: /My records/ })
    .first()
    .click();
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
  await expect(
    reader.getByRole("region", { name: en("ai.summary.title"), exact: true }),
  ).toContainText(en("aiHelper.resultLabel"));
  await expectOnlyFakedCommands(page);
});

test("the download's progress bar fits the row, wide and at 320 px with 200% text (#275)", async ({
  page,
  context,
}) => {
  const row = await openPreferences(page);
  await holdAi(page, AI_COMMANDS.download);
  await rowButton(row, "ai.model.download").click();
  // Half way, as the text says.
  const bar = row.getByRole("progressbar", {
    name: en("ai.model.progressName"),
    exact: true,
  });
  await expect(bar).toHaveAttribute("aria-valuenow", "50");
  await expect(bar).toHaveAttribute(
    "aria-valuetext",
    en("ai.model.progressValue", {
      percent: "50%",
      done: MB(TOTAL / 2),
      total: MB(TOTAL),
    }),
  );
  const fits = async () => {
    const [box, rowBox] = [await bar.boundingBox(), await row.boundingBox()];
    expect(box && rowBox).toBeTruthy();
    expect(box!.width).toBeGreaterThan(40);
    expect(box!.x).toBeGreaterThanOrEqual(rowBox!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(
      rowBox!.x + rowBox!.width + 0.5,
    );
    await expect(rowButton(row, "common.cancel")).toBeInViewport();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  };
  await fits();
  // A narrow window with the text at 200%: the line wraps, nothing scrolls
  // sideways.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32 } });
  await page.setViewportSize({ width: 320, height: 720 });
  await bar.scrollIntoViewIfNeeded();
  await fits();
  // Gone once the download ends.
  await releaseAi(page, AI_COMMANDS.download);
  await expect(row.getByRole("status")).toHaveText(en("ai.model.added"));
  await expect(bar).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("a download still running when the patient comes back shows its bar, not the button (#275)", async ({
  page,
}) => {
  let row = await openPreferences(page);
  await holdAi(page, AI_COMMANDS.download);
  await rowButton(row, "ai.model.download").click();
  await expect(row.getByRole("status")).toHaveText(
    en("ai.model.downloading", { done: MB(TOTAL / 2), total: MB(TOTAL) }),
  );
  // Another page, then back: the row is new, and the download still runs.
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("security.title"), level: 1 }),
  ).toBeVisible();
  await sidebar(page)
    .getByRole("button", { name: en("sidebar.preferences"), exact: true })
    .click();
  row = aiRow(page);
  await expect(
    row.getByRole("progressbar", {
      name: en("ai.model.progressName"),
      exact: true,
    }),
  ).toHaveAttribute("aria-valuenow", "50");
  await expect(row.getByRole("status")).toHaveText(
    en("ai.model.downloading", { done: MB(TOTAL / 2), total: MB(TOTAL) }),
  );
  await expect(rowButton(row, "common.cancel")).toBeVisible();
  await expect(rowButton(row, "ai.model.download")).toBeDisabled();
  await expect(row.getByRole("alert")).toHaveCount(0);
  // It ends as it would have: the model is added.
  await releaseAi(page, AI_COMMANDS.download);
  await expect(row.getByRole("status")).toHaveText(en("ai.model.added"));
  await expect(rowButton(row, "ai.model.remove")).toBeVisible();
  expect(await aiCalls(page, AI_COMMANDS.download)).toHaveLength(1);
  await expectOnlyFakedCommands(page);
});

test("cancelling a download leaves no model and says nothing went wrong", async ({
  page,
}) => {
  const row = await openPreferences(page);
  await holdAi(page, AI_COMMANDS.download);
  await rowButton(row, "ai.model.download").click();
  await expect.poll(() => aiHeld(page)).toEqual([AI_COMMANDS.download]);
  await rowButton(row, "common.cancel").click();
  await expect.poll(() => aiHeld(page)).toEqual([]);
  expect(await aiCancelled(page)).toEqual([
    { command: AI_COMMANDS.download, by: AI_COMMANDS.addCancel },
  ]);
  await expect(row.getByRole("status")).toHaveText("");
  await expect(row.getByRole("alert")).toHaveCount(0);
  await expect(rowButton(row, "ai.model.download")).toBeEnabled();
  await expect(
    row.getByRole("radio", { name: FAKE_MODEL.name, exact: true }),
  ).toBeDisabled();
  await expectOnlyFakedCommands(page);
});

for (const [outcome, key] of [
  ["network", "ai.model.refusedNetwork"],
  ["unavailable", "ai.model.refusedUnavailable"],
  ["noDisk", "ai.model.refusedDisk"],
  ["wrongHash", "ai.model.refusedHash"],
  ["incomplete", "ai.model.refusedIncomplete"],
] as const)
  test(`a download that ends ${outcome} says why, and offers the download again`, async ({
    page,
  }) => {
    const row = await openPreferences(page);
    await answerAi(page, AI_COMMANDS.download, { outcome });
    await rowButton(row, "ai.model.download").click();
    await expect(row.getByRole("alert")).toHaveText(en(key));
    await expect(rowButton(row, "ai.model.download")).toBeEnabled();
    await expect(
      row.getByRole("radio", { name: FAKE_MODEL.name, exact: true }),
    ).toBeDisabled();
    await expectOnlyFakedCommands(page);
  });

test("adds a model file: the check's progress, then installed", async ({
  page,
}) => {
  const row = await openPreferences(page);
  await holdAi(page, AI_COMMANDS.addPicked);
  await rowButton(row, "ai.model.add").click();
  await expect(row.getByRole("status")).toHaveText(
    en("ai.model.checking", { done: MB(TOTAL / 2), total: MB(TOTAL) }),
  );
  await releaseAi(page, AI_COMMANDS.addPicked);
  await expect(row.getByRole("status")).toHaveText(en("ai.model.added"));
  await expect(
    row.getByRole("radio", { name: FAKE_MODEL.name, exact: true }),
  ).toBeChecked();
  // The page never sends a path: the picker opens inside the command.
  expect(await aiCalls(page, AI_COMMANDS.addPicked)).toEqual([{}]);
  await expectOnlyFakedCommands(page);
});

for (const [outcome, key] of [
  ["notListed", "ai.model.refusedList"],
  ["tooBig", "ai.model.refusedList"],
  ["wrongHash", "ai.model.refusedHash"],
  ["unreadable", "ai.model.refusedIncomplete"],
  ["busy", "ai.model.refusedBusy"],
] as const)
  test(`an added file refused as ${outcome} says why`, async ({ page }) => {
    const row = await openPreferences(page);
    await answerAi(page, AI_COMMANDS.addPicked, { outcome });
    await rowButton(row, "ai.model.add").click();
    await expect(row.getByRole("alert")).toHaveText(en(key));
    await expect(rowButton(row, "ai.model.add")).toBeEnabled();
    await expectOnlyFakedCommands(page);
  });

test("closing the file picker changes nothing and says nothing", async ({
  page,
}) => {
  const row = await openPreferences(page);
  await answerAi(page, AI_COMMANDS.addPicked, { outcome: "cancelled" });
  await rowButton(row, "ai.model.add").click();
  await expect(rowButton(row, "ai.model.add")).toBeEnabled();
  await expect(row.getByRole("status")).toHaveText("");
  await expect(row.getByRole("alert")).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("Remove asks first, then the model is gone and can be downloaded again", async ({
  page,
}) => {
  const row = await openPreferences(page, { model: INSTALLED });
  await expect(
    row.getByRole("radio", { name: FAKE_MODEL.name, exact: true }),
  ).toBeChecked();
  await rowButton(row, "ai.model.remove").click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText(en("ai.model.removeConfirm"));
  // Cancel keeps it.
  await confirm
    .getByRole("button", { name: en("common.cancel"), exact: true })
    .click();
  expect(await aiCalls(page, AI_COMMANDS.remove)).toEqual([]);

  await rowButton(row, "ai.model.remove").click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", {
      name: `${en("ai.models.remove")} ${FAKE_MODEL.name}`,
      exact: true,
    })
    .click();
  await expect(rowButton(row, "ai.model.download")).toBeVisible();
  await expect(
    row.getByRole("radio", { name: FAKE_MODEL.name, exact: true }),
  ).toBeDisabled();
  expect(await aiCalls(page, AI_COMMANDS.remove)).toHaveLength(1);
  await expectOnlyFakedCommands(page);
});

test("a Remove refused while the helper works says so, and keeps the model", async ({
  page,
}) => {
  const row = await openPreferences(page, { model: INSTALLED });
  await refuseAi(page, AI_COMMANDS.remove, "busy");
  await rowButton(row, "ai.model.remove").click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", {
      name: `${en("ai.models.remove")} ${FAKE_MODEL.name}`,
      exact: true,
    })
    .click();
  await expect(row.getByRole("alert")).toHaveText(en("ai.model.refusedBusy"));
  await expect(
    row.getByRole("radio", { name: FAKE_MODEL.name, exact: true }),
  ).toBeChecked();
  await expectOnlyFakedCommands(page);
});

test("a damaged model is said, with Remove and no Download", async ({
  page,
}) => {
  const row = await openPreferences(page, { model: { state: "damaged" } });
  await expect(row).toContainText(en("ai.model.damaged"));
  await expect(rowButton(row, "ai.model.remove")).toBeVisible();
  await expect(rowButton(row, "ai.model.download")).toHaveCount(0);
  await expect(rowButton(row, "ai.model.add")).toBeVisible();
  await expectOnlyFakedCommands(page);
});

for (const [reason, key] of [
  ["ram", "ai.model.unsupportedRam"],
  ["cpu", "ai.model.unsupportedCpu"],
  ["platform", "ai.model.unsupportedPlatform"],
] as const)
  test(`a computer the model cannot run on (${reason}) is told why, with nothing to add`, async ({
    page,
  }) => {
    const row = await openPreferences(page, {
      model: { state: "unsupported", reason },
    });
    await expect(row).toContainText(en(key));
    await expect(rowButton(row, "ai.model.download")).toHaveCount(0);
    await expect(rowButton(row, "ai.model.add")).toHaveCount(0);
    await expectOnlyFakedCommands(page);
  });

test("the reader with no model says where to get one, and Open Preferences leads to Download", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await fakeAiWith(page);
  await page.goto("/");
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
  const panel = reader.getByRole("region", {
    name: en("ai.summary.title"),
    exact: true,
  });
  await expect(panel).toContainText(en("ai.notInstalled.title"));
  await expect(panel).toContainText(en("ai.notInstalled.body"));
  await panel
    .getByRole("button", {
      name: en("ai.notInstalled.openPreferences"),
      exact: true,
    })
    .click();
  await expect(reader).toBeHidden();
  await expect(rowButton(aiRow(page), "ai.model.download")).toBeVisible();
  await expectOnlyFakedCommands(page);
});
