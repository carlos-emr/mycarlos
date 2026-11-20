import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import {
  AI_COMMANDS,
  aiCalls,
  aiCancelled,
  aiHeld,
  fakeAiWith,
  holdAi,
} from "./support/aiFake";
import { translate } from "./support/fluent";
import {
  FAKE_PASSPHRASE,
  fakeCalls,
  fakeVaultWith,
  myRecords,
  openDetails,
} from "./support/vaultFake";

// The AI helper's patient path (#72), from a document to an answer with the
// details back: the notice before the first export of each unlocked
// session, the preview with the dates as numbered gaps and an age of 90 or
// over as [AGE n, 90+], one more word removed by hand, the save, and the
// AI's answer pasted back, with a mark that is not this export's flagged.
// Then the preview stopping its text read when it closes or the vault locks.
// The native side is faked (support/vaultFake.ts + support/aiFake.ts); the
// remover's own rules are unit-tested in src/deidentify. FAKE data only.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

const LETTER = "FAKE Letter.pdf";
// The vault fake's one person is "FAKE Patient" (so the label here is not
// "Patient:", which the remover would take as part of that name); the vault
// knows the letter's birth date and doctor (vault_record_known_details).
const LETTER_PAGES = [
  "Name: FAKE Patient\nDOB: 1961-04-17\nSeen 2026-10-08 by Dr. Ward for chest pain.\nA 93-year-old woman who lives near Millbrook.",
  "Follow-up 2026-10-22: Ramipril 5 mg daily.",
];

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the AI helper's preview is offered on computers only (the PDF helper reads the text)",
  );
});

async function openLibrary(page: Page) {
  await fakeVaultWith(page, { start: "unlocked" });
  await fakeAiWith(page, {
    documents: { [LETTER]: LETTER_PAGES },
    knownDetails: { birthDates: ["1961-04-17"], doctorNames: ["Ward"] },
  });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
}

/** Prepare text for an AI… in the letter's details. */
async function prepare(page: Page) {
  const details = await openDetails(page, LETTER);
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.anonymizeText"),
      exact: true,
    })
    .click();
}

const notice = (page: Page) =>
  page.getByRole("dialog", { name: en("aiHelper.notice.title"), exact: true });
const preview = (page: Page) =>
  page.getByRole("dialog", {
    name: en("interface.AnonymizePreview.title"),
    exact: true,
  });

/** The text as it is shown: without the words each mark says only to a
 * screen reader. */
const shown = (region: Locator) =>
  region.evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement;
    for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
    return copy.textContent ?? "";
  });

/** Selects `word` in the preview's text, as a patient dragging over it. */
async function selectInPreview(page: Page, word: string) {
  const found = await preview(page)
    .getByRole("region", {
      name: en("interface.AnonymizePreview.textRegion"),
      exact: true,
    })
    .evaluate((region, word) => {
      for (const span of region.querySelectorAll("span[data-start]")) {
        const node = span.firstChild;
        const at = node?.textContent?.indexOf(word) ?? -1;
        if (!node || at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return true;
      }
      return false;
    }, word);
  expect(found, `"${word}" is in the preview's plain text`).toBe(true);
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

async function unlock(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page.getByRole("button", { name: en("unlock.submit") }).click();
  await expect(myRecords(page)).toBeVisible();
}

test("a document's text goes to an AI without its details, and the answer comes back with them", async ({
  page,
}) => {
  await openLibrary(page);
  await prepare(page);

  // The notice comes before the first export, and nothing is read before
  // the patient has seen it.
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toContainText(en("aiHelper.notice.limitsBody"));
  expect(await aiCalls(page, AI_COMMANDS.documentText)).toEqual([]);
  await notice(page)
    .getByRole("button", {
      name: en("interface.AiHelperNotice.continue"),
      exact: true,
    })
    .click();
  await expect(notice(page)).toBeHidden();

  // The preview: names, the birth date and the doctor removed; the dates as
  // numbered gaps from the earliest; the age over 90 as a numbered 90+.
  const region = preview(page).getByRole("region", {
    name: en("interface.AnonymizePreview.textRegion"),
    exact: true,
  });
  await expect
    .poll(() => shown(region))
    .toContain("Name: [NAME 1]\nDOB: [DATE OF BIRTH 1]\n");
  const first = await shown(region);
  expect(first).toContain("Seen [DATE 1] by Dr. [DOCTOR 1] for chest pain.");
  expect(first).toContain("A [AGE 1, 90+] woman");
  expect(first).toContain("Follow-up [DATE 2, 14 days after DATE 1]:");
  for (const gone of ["FAKE Patient", "1961", "2026-10-08", "2026-10-22"])
    expect(first).not.toContain(gone);
  // Each replaced date names itself for a screen reader; the marks stand
  // around the placeholder, with Fluent's isolation marks inside the words.
  await expect(region.locator('mark[data-kind="date"]')).toHaveCount(2);
  await expect(region.locator('mark[data-kind="date"]').first()).toContainText(
    en("interface.AnonymizePreview.movedDate"),
  );
  await expect(region.locator('mark[data-kind="age"]')).toHaveText(
    /\[AGE 1, 90\+\].*age/,
  );

  // One more word, by hand: the place the patient lives near.
  await expect(region).toContainText("Millbrook");
  await selectInPreview(page, "Millbrook");
  await preview(page)
    .getByRole("button", {
      name: en("interface.AnonymizePreview.removeSelected"),
      exact: true,
    })
    .click();
  await expect(region).not.toContainText("Millbrook");
  await expect(region.locator('mark[data-kind="manual"]')).toContainText(
    en("interface.AnonymizePreview.kind.manual"),
  );
  await expect(preview(page).getByRole("status")).toContainText(
    en("interface.AnonymizePreview.removedPlaces", { count: 1 }),
  );

  // Saved, after the warning that the file is outside myCarlos's protection.
  await preview(page)
    .getByRole("button", {
      name: en("interface.AnonymizePreview.save"),
      exact: true,
    })
    .click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText(
    en("interface.AnonymizePreview.confirmBody"),
  );
  await confirm
    .getByRole("button", {
      name: en("interface.AnonymizePreview.save"),
      exact: true,
    })
    .click();
  await expect(preview(page).getByRole("status")).toContainText(
    en("interface.AnonymizePreview.saved"),
  );
  const [saved] = await aiCalls(page, AI_COMMANDS.exportPicked);
  const text = String(saved.request?.text);
  for (const gone of [
    "FAKE Patient",
    "1961",
    "2026-10-08",
    "2026-10-22",
    "93",
    "Ward",
    "Millbrook",
  ])
    expect(text, `the saved text holds no "${gone}"`).not.toContain(gone);
  expect(text).toContain("[DATE 2, 14 days after DATE 1]");
  expect(text).toContain("[AGE 1, 90+]");
  expect(text).toContain("Ramipril 5 mg daily.");
  // The save was the one the picker opened for, with the preview's ticket.
  const [picked] = await aiCalls(page, AI_COMMANDS.exportPick);
  expect(saved.request?.ticket).toBe(picked.request?.ticket);

  // The AI's answer, pasted back: every mark of this export returns to its
  // detail; a mark that is not this export's is highlighted, never guessed.
  const paste = preview(page).getByRole("region", {
    name: en("interface.AnonymizePreview.pasteTitle"),
    exact: true,
  });
  await paste
    .getByLabel(en("interface.AnonymizePreview.pasteLabel"), { exact: true })
    .fill(
      "[NAME 1] was seen on [DATE 1] by Dr. [DOCTOR 1] and again on " +
        "[DATE 2, 14 days after DATE 1]. A [AGE 1, 90+] woman. See also [NAME 7].",
    );
  await paste
    .getByRole("button", {
      name: en("interface.AnonymizePreview.pasteButton"),
      exact: true,
    })
    .click();
  const back = paste.getByRole("region", {
    name: en("interface.AnonymizePreview.pasteResult"),
    exact: true,
  });
  await expect
    .poll(() => shown(back))
    .toBe(
      "FAKE Patient was seen on 2026-10-08 by Dr. Ward and again on 2026-10-22. A 93-year-old woman. See also [NAME 7].",
    );
  await expect(back.locator('mark[data-kind="flagged"]')).toHaveCount(1);
  await expect(back.locator('mark[data-kind="flagged"]')).toContainText(
    "[NAME 7]",
  );
  await expect(paste.getByRole("status")).toContainText(
    en("interface.AnonymizePreview.pasteFlagged", { count: 1 }),
  );

  // Closed; the notice is not shown again in this unlocked session.
  await preview(page)
    .getByRole("button", {
      name: en("interface.AnonymizePreview.close"),
      exact: true,
    })
    .click();
  await expect(preview(page)).toBeHidden();
  await prepare(page);
  await expect(preview(page)).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("closing the preview while the text is read stops the read", async ({
  page,
}) => {
  await openLibrary(page);
  await holdAi(page, AI_COMMANDS.documentText);
  await prepare(page);
  await notice(page)
    .getByRole("button", {
      name: en("interface.AiHelperNotice.continue"),
      exact: true,
    })
    .click();
  await expect(
    preview(page).getByText(en("interface.AnonymizePreview.reading"), {
      exact: true,
    }),
  ).toBeVisible();
  await expect.poll(() => aiHeld(page)).toEqual([AI_COMMANDS.documentText]);

  await preview(page)
    .getByRole("button", {
      name: en("interface.AnonymizePreview.close"),
      exact: true,
    })
    .click();
  await expect(preview(page)).toBeHidden();
  // The native side was told, and the read it held has ended.
  expect(await aiCalls(page, AI_COMMANDS.cancelText)).toHaveLength(1);
  await expect.poll(() => aiHeld(page)).toEqual([]);
  expect(await aiCancelled(page)).toEqual([
    { command: AI_COMMANDS.documentText, by: AI_COMMANDS.cancelText },
  ]);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("a lock while the text is read ends the read and the preview, and the notice comes again after unlocking", async ({
  page,
}) => {
  await openLibrary(page);
  await holdAi(page, AI_COMMANDS.documentText);
  await prepare(page);
  await notice(page)
    .getByRole("button", {
      name: en("interface.AiHelperNotice.continue"),
      exact: true,
    })
    .click();
  await expect.poll(() => aiHeld(page)).toEqual([AI_COMMANDS.documentText]);

  await lockByMinimizing(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await fakeCalls(page, "vault_lock")).toHaveLength(1);
  await expect.poll(() => aiHeld(page)).toEqual([]);
  expect(await aiCancelled(page)).toEqual([
    { command: AI_COMMANDS.documentText, by: "vault_lock" },
  ]);

  // A new unlocked session: nothing of the preview is left, and the first
  // export asks for the notice again before anything is read.
  await unlock(page);
  await expect(preview(page)).toHaveCount(0);
  const readsBefore = (await aiCalls(page, AI_COMMANDS.documentText)).length;
  await prepare(page);
  await expect(notice(page)).toBeVisible();
  expect(await aiCalls(page, AI_COMMANDS.documentText)).toHaveLength(
    readsBefore,
  );
  await expectOnlyFakedCommands(page);
});
