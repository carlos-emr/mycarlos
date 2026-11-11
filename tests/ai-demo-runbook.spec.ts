import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import {
  AI_COMMANDS,
  answerAi,
  fakeAiWith,
  holdAi,
  refuseAi,
  releaseAi,
  type FakeAiSetup,
} from "./support/aiFake";
import { visibleHumanText } from "./support/fluent";
import { AI_EXPLAIN_ENABLED } from "../src/ai/features";
import {
  FAKE_PAGE_COUNT,
  fakePageText,
  fakePickFiles,
  fakeVaultWith,
  myRecords,
} from "./support/vaultFake";

// The demo runbook (kept outside the repo), step by step: Preferences → AI
// helper → Download the default model → Installed →
// import the three FAKE PDFs → open each → Summary (notice → Continue) → the
// answer → Show in document; then the runbook's "If it stalls" messages. Every
// button and text the runbook names is written here as the runbook writes it,
// not looked up in the catalogue, so a runbook that no longer matches the app
// fails. They are soft checks: one run lists every mismatch, and the walk
// goes on with the app's own control where a name differs. The native side
// is faked (support/vaultFake.ts + support/aiFake.ts): no model is
// downloaded or run. FAKE data only.

// The runbook's model, as the catalogue lists it for the demo build.
const MODEL = "Qwen3.5 4B (Q4_K_M)";
const CATALOG: FakeAiSetup["catalog"] = {
  name: MODEL,
  fileName: "Qwen3.5-4B-Q4_K_M.gguf",
  sizeBytes: 3_013_000_000,
  sha256: "ab".repeat(32),
  licence: "Apache-2.0",
  sourceUrl:
    "https://huggingface.co/FAKE-organisation/Qwen3.5-4B-GGUF/resolve/FAKE-revision/Qwen3.5-4B-Q4_K_M.gguf",
};
// The three FAKE documents of step 4, as the library names them.
const DOCUMENTS = [
  "FAKE-01-referral-letter.pdf",
  "FAKE-02-discharge-summary.pdf",
  "FAKE-03-lab-report.pdf",
];

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === "phone", "the demo runs on a Windows PC");
});

/** What the patient sees: the text without Fluent's isolation marks and
 * without what only a screen reader hears. */
const seen = (scope: Locator) =>
  scope
    .evaluate((element) => {
      const copy = element.cloneNode(true) as HTMLElement;
      for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
      return copy.textContent ?? "";
    })
    .then((text) =>
      visibleHumanText(text)
        // The runbook types straight quotes; the app's are typographic.
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/\s+/g, " ")
        .trim(),
    );

const softly = expect.configure({ soft: true, timeout: 5_000 });

/** The runbook's words are on screen in `scope`, as it writes them. */
async function says(scope: Locator, words: string, where: string) {
  await softly
    .poll(() => seen(scope), { message: `runbook, ${where}: "${words}"` })
    .toContain(words);
}

/** The runbook's words, with numbers it leaves open (`pattern`). */
async function reads(scope: Locator, pattern: RegExp, where: string) {
  await softly
    .poll(() => seen(scope), { message: `runbook, ${where}: ${pattern}` })
    .toMatch(pattern);
}

/** The runbook names a button: it is there under that name. Returns it, or
 * the app's own button (`actual`) when the name differs, so the walk goes on. */
async function named(
  scope: Locator,
  runbook: string,
  where: string,
  actual?: string,
) {
  const control = scope.getByRole("button", { name: runbook, exact: true });
  const there = await control
    .first()
    .isVisible()
    .catch(() => false);
  expect
    .soft(there, `runbook, ${where}: a button named "${runbook}"`)
    .toBe(true);
  return there || !actual
    ? control.first()
    : scope.getByRole("button", { name: actual, exact: true }).first();
}

async function start(page: Page, setup: FakeAiSetup = {}) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await fakeVaultWith(page, { start: "unlocked" });
  await fakeAiWith(page, {
    catalog: CATALOG,
    // The imported documents' text, as the reader shows their pages.
    documents: Object.fromEntries(
      DOCUMENTS.map((name) => [
        name,
        Array.from({ length: FAKE_PAGE_COUNT }, (_, page) =>
          fakePageText(name, page + 1),
        ),
      ]),
    ),
    ...setup,
  });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
}

async function aiSettings(page: Page) {
  await (
    await named(page.locator("body"), "AI helper", "step 3 (sidebar)")
  ).click();
  return page.locator("section.setting-row").filter({
    has: page.getByRole("heading", { name: /AI helper/ }),
  });
}

test("the demo runbook, steps 3 to 12, matches the app", async ({ page }) => {
  await start(page);

  // Step 3: Preferences → the AI helper row, Not installed.
  const row = await aiSettings(page);
  await says(row, "AI helper", "step 3");
  await says(row, "Not installed", "step 3");
  await says(
    row,
    "Qwen3.5 4B (Q4_K_M), 3,013 MB. Licence: Apache-2.0.",
    "step 3",
  );
  await says(
    row,
    "Downloads one file (3,013 MB), once, from huggingface.co, only when you click. Nothing about you or your documents is sent.",
    "step 3",
  );

  // Step 3, no internet on the day: Where to get the file → Copy address;
  // Add a model file… checks it.
  await says(row, "Where to get the file", "step 3 (no internet)");
  await (await named(row, "Copy address", "step 3 (no internet)")).click();
  await says(row, "Address copied", "step 3 (no internet)");
  await holdAi(page, AI_COMMANDS.addPicked);
  await (await named(row, "Add a model file…", "step 3 (no internet)")).click();
  await reads(
    row.getByRole("status"),
    /Checking the file… [\d,]+ of 3,013 MB/,
    "step 3 (no internet)",
  );
  await (await named(row, "Cancel", "step 3 (checking)")).click();

  // Step 3: Download the default model → progress with Cancel → Model added.
  await holdAi(page, AI_COMMANDS.download);
  await (await named(row, `Download ${MODEL}`, "step 3")).click();
  await reads(
    row.getByRole("status"),
    /Downloading and checking… [\d,]+ of 3,013 MB/,
    "step 3",
  );
  await named(row, "Cancel", "step 3 (downloading)");
  await releaseAi(page, AI_COMMANDS.download);
  await says(row, "Model added", "step 3");
  await expect(
    row.getByRole("radio", { name: MODEL, exact: true }),
  ).toBeChecked();
  await named(row, `Remove ${MODEL}`, "step 3");

  // Step 5: Choose files to import → the three, Unverified, Manual import.
  await page
    .getByRole("button", { name: /My records/ })
    .locator("visible=true")
    .first()
    .click();
  await fakePickFiles(page, DOCUMENTS);
  await (
    await named(page.locator("body"), "Choose files to import", "step 5")
  ).click();
  for (const name of DOCUMENTS)
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();

  // Steps 6–8 and 12: each document → details → Read → Summary → the answer.
  // The discharge summary first, as the runbook does; it also shows a
  // sentence whose quote is not in the document.
  const order = [DOCUMENTS[1], DOCUMENTS[0], DOCUMENTS[2]];
  for (const [index, name] of order.entries()) {
    const first = index === 0;
    if (first) {
      // Step 6: the runbook names it as the library does, with ".pdf".
      await named(
        page.locator("main"),
        name,
        "step 6 (the document in the library)",
      );
    }
    await page.getByRole("button", { name, exact: true }).click();
    const details = page.getByRole("dialog", { name, exact: true });
    // Since #139 the details show the status and the source apart: "Unverified",
    // then "Manual import".
    if (first) {
      await says(details, "Unverified", "step 5");
      await says(details, "Manual import", "step 5");
    }
    await (await named(details, "Read", "step 6")).click();
    const reader = page.getByRole("dialog", { name, exact: true });
    await expect(
      reader.getByRole("img", {
        name: new RegExp(`Page .?1.? of .?${FAKE_PAGE_COUNT}.?\\.`),
      }),
    ).toBeVisible();

    if (first) {
      // One sentence the document does not say word for word.
      await answerAi(page, AI_COMMANDS.summarize, {
        sentences: [
          {
            text: "FAKE: page 1 begins as the letter does.",
            quote: fakePageText(name, 1),
          },
          {
            text: "FAKE: a sentence with nothing behind it.",
            quote: "",
          },
        ],
        model: { name: MODEL, sha256: CATALOG.sha256 },
        lastPage: FAKE_PAGE_COUNT - 1,
        lastPageCut: false,
      });
      await holdAi(page, AI_COMMANDS.summarize);
    }
    // Step 7: Summary → About the AI helper, the first time → Continue.
    await (await named(reader, "Summary", "step 7")).click();
    if (first) {
      const notice = page.getByRole("dialog", {
        name: "About the AI helper",
        exact: true,
      });
      await expect
        .soft(notice, "runbook, step 7: About the AI helper")
        .toBeVisible();
      await says(
        notice,
        "The AI helper explains a document in plain words, here on this device",
        "step 7",
      );
      await expect
        .soft(
          notice.getByRole("heading", {
            name: "The AI on this device",
            exact: true,
          }),
          "runbook, step 7: The AI on this device",
        )
        .toBeVisible();
      await (await named(notice, "Continue", "step 7")).click();
    }

    // Step 8: Summary in plain words, working, then the answer.
    const panel = reader.getByRole("region", {
      name: "Summary in plain words",
      exact: true,
    });
    await expect
      .soft(panel, "runbook, step 8: Summary in plain words")
      .toBeVisible();
    if (first) {
      await says(panel, "The AI helper is working…", "step 8");
      await releaseAi(page, AI_COMMANDS.summarize);
    }
    await says(
      panel,
      "Written by AI and may be wrong. Check with your doctor.",
      "step 8",
    );
    await reads(
      panel,
      /Summary in plain words · Qwen3\.5 4B \(Q4_K_M\) · \S/,
      "step 8 (the line)",
    );
    const show = panel.getByRole("button", { name: "Show in document" });
    await expect
      .soft(show.first(), "runbook, step 8: Show in document")
      .toBeVisible();
    if (first) await says(panel, "No source found", "step 8");
    // Show in document → the page, with the quoted words marked.
    await show.first().click();
    await expect(reader.locator(".native-reader-text mark")).toHaveText(
      fakePageText(name, 1),
    );

    if (first && !AI_EXPLAIN_ENABLED) {
      // Step 9 (Explain a term) is out of the demo while Explain is switched
      // off in the UI (src/ai/features.ts), so it is skipped here and comes
      // back with the switch. That the button is gone is checked by
      // "offers Summary only" in ai-helper-reader.spec.ts.
      test.info().annotations.push({
        type: "skipped step",
        description:
          "runbook step 9 (Explain a term): Explain is switched off in the UI and out of the demo",
      });
    }
    if (first && AI_EXPLAIN_ENABLED) {
      // Step 9: Explain a term → Word or phrase → Explain.
      await (await named(reader, "Explain a term", "step 9")).click();
      const explain = reader.getByRole("region", {
        name: "Explain a term",
        exact: true,
      });
      await says(reader, "Text on this page", "step 9");
      const box = explain.getByRole("textbox", {
        name: "Word or phrase",
        exact: true,
      });
      await expect.soft(box, "runbook, step 9: Word or phrase").toBeVisible();
      await box.fill("FAKE term");
      await (await named(explain, "Explain", "step 9")).click();
      await says(
        explain,
        "Written by AI and may be wrong. Check with your doctor.",
        "step 9",
      );
    }
    // Step 10: Close.
    await (await named(reader, "Close", "step 10")).click();
    await expect(reader).toBeHidden();
  }
  await expectOnlyFakedCommands(page);
});

test("the runbook's 'If it stalls' messages match the app", async ({
  page,
  context,
}) => {
  // The computer cannot run the model, or its file failed its check.
  for (const [model, words] of [
    [
      { state: "unsupported", reason: "ram" },
      "This computer does not have enough memory for the AI helper (it needs about 8 GB).",
    ],
    [
      { state: "unsupported", reason: "cpu" },
      "This computer's processor is not supported by the AI helper.",
    ],
    [
      { state: "unsupported", reason: "platform" },
      "The AI helper is not available on this kind of computer yet.",
    ],
    [
      { state: "damaged" },
      "The model file is damaged or has changed. Remove it, then add it again.",
    ],
  ] as const) {
    const shown = await context.newPage();
    await start(shown, { model });
    await says(await aiSettings(shown), words, `If it stalls (${model.state})`);
    await shown.close();
  }

  // Refused adds and downloads.
  await start(page);
  const row = await aiSettings(page);
  for (const [command, outcome, words] of [
    [
      AI_COMMANDS.addPicked,
      "wrongHash",
      "This is not the file we expect. Download it again and add the new copy.",
    ],
    [
      AI_COMMANDS.addPicked,
      "incomplete",
      "The file could not be read completely",
    ],
    [
      AI_COMMANDS.addPicked,
      "notListed",
      "This is not a file myCarlos accepts. Choose one of the model files listed above.",
    ],
    [
      AI_COMMANDS.addPicked,
      "storage",
      "The model could not be saved on this computer.",
    ],
    [
      AI_COMMANDS.addPicked,
      "noDisk",
      "There is not enough free space on this computer. The model needs about 4 GB.",
    ],
    [
      AI_COMMANDS.addPicked,
      "busy",
      "The AI helper is working. Try again when it has finished.",
    ],
    [AI_COMMANDS.download, "network", "The download did not finish"],
    [
      AI_COMMANDS.download,
      "unavailable",
      "The model is not available at its address right now",
    ],
  ] as const) {
    await answerAi(page, command, { outcome });
    const label =
      command === AI_COMMANDS.download
        ? `Download ${MODEL}`
        : "Add a model file…";
    await page.getByRole("button", { name: label, exact: true }).click();
    await says(row.getByRole("alert"), words, `If it stalls (${outcome})`);
  }

  // A Summary that cannot finish, or finds no model to use.
  const reader = await context.newPage();
  await start(reader, {
    model: {
      state: "installed",
      model: { name: MODEL, sha256: "ab".repeat(32) },
    },
  });
  await refuseAi(reader, AI_COMMANDS.summarize, "aiFailed");
  await reader
    .getByRole("button", { name: "FAKE Letter.pdf", exact: true })
    .click();
  await reader
    .getByRole("dialog", { name: "FAKE Letter.pdf" })
    .getByRole("button", { name: "Read", exact: true })
    .click();
  const open = reader.getByRole("dialog", { name: "FAKE Letter.pdf" });
  await open.getByRole("button", { name: "Summary", exact: true }).click();
  await reader
    .getByRole("dialog", { name: "About the AI helper" })
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await says(
    open,
    "The AI helper could not finish. Try again.",
    "If it stalls",
  );
  await open.getByRole("button", { name: "Summary", exact: true }).click();
  await refuseAi(reader, AI_COMMANDS.summarize, "aiDamaged");
  await open.getByRole("button", { name: "Summary", exact: true }).click();
  await says(open, "The AI helper isn't on this computer yet", "If it stalls");
  await named(open, "Open AI helper settings", "If it stalls");
});
