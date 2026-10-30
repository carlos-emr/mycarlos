import { humanText } from "../test/humanText";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { DocumentReader, sentenceAround } from "./DocumentReader";
import { PreferencesSettings } from "./PreferencesSettings";
import type { ReaderAi } from "./ReaderAiPanel";
import { notInstalledModel } from "../ai/localModel";
import { LOCALES, translate } from "../i18n";
import type { LocalModel } from "../ai/types";
import { fakeDocumentText, fakeLocalModel } from "../test/fakeLocalModel";
import type { VaultRecord, ViewedPage } from "../vault";

// FAKE documents only. A real 1 x 1 PNG, drawn here, so the picture loads.
const PNG = (() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  return canvas.toDataURL("image/png");
})();
const record: VaultRecord = {
  id: "record-1",
  profileId: "profile-1",
  folderIds: [],
  displayName: "FAKE_Bloodwork.pdf",
  sourceLabel: "Manual import — unverified",
  mediaType: "application/pdf",
  plaintextSize: 2048,
  importedAtMs: 1,
  available: true,
};
const pageTexts = [
  "FAKE text on page 1. Potassium 5.4 mmol/L, a little high.",
  "  FAKE text on page 2. Repeat in 2 weeks.",
];
const page = (index: number): ViewedPage => ({
  pageCount: 2,
  width: 800,
  height: 1035,
  image: PNG,
  text: pageTexts[index],
});

function renderReader(
  model: LocalModel | null,
  options: { loadText?: ReaderAi["loadText"]; strict?: boolean } = {},
) {
  const onOpenPreferences = vi.fn();
  const loadText = vi.fn(
    options.loadText ?? (async () => fakeDocumentText(pageTexts)),
  );
  const reader = (
    <DocumentReader
      record={record}
      viewPage={vi.fn(async (index: number) => page(index))}
      onClose={vi.fn()}
      ai={model ? { model, loadText, onOpenPreferences } : undefined}
    />
  );
  render(options.strict ? <StrictMode>{reader}</StrictMode> : reader);
  return { onOpenPreferences, loadText };
}

const firstPage = () =>
  screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });

describe("the reader's AI helper", () => {
  it("offers nothing where the AI helper cannot run", async () => {
    renderReader(null);
    await firstPage();
    expect(screen.queryByRole("button", { name: "Summary" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Explain a term" })).toBeNull();
  });

  it("says the model isn't installed and leads to Preferences, for both actions", async () => {
    const { onOpenPreferences, loadText } = renderReader(notInstalledModel);
    await firstPage();
    const user = userEvent.setup();
    const summary = screen.getByRole("button", { name: "Summary" });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    await user.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("region", {
      name: "Summary in plain words",
    });
    expect(
      await within(panel).findByText(
        "The AI helper isn't on this computer yet",
      ),
    ).toBeVisible();
    await user.click(
      within(panel).getByRole("button", { name: "Open Preferences" }),
    );
    expect(onOpenPreferences).toHaveBeenCalledTimes(1);
    expect(loadText).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Explain a term" }));
    const explain = screen.getByRole("region", { name: "Explain a term" });
    expect(
      await within(explain).findByText(
        "The AI helper isn't on this computer yet",
      ),
    ).toBeVisible();
    expect(within(explain).queryByRole("textbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Explain a term" }));
    expect(screen.queryByRole("region", { name: "Explain a term" })).toBeNull();
  });

  it("labels a summary as AI's, and links only the sentences found in the document", async () => {
    const model = fakeLocalModel({
      sentences: () => [
        {
          text: "FAKE: your potassium is a little high.",
          quote: "Potassium 5.4 mmol/L",
        },
        {
          text: "FAKE: repeat the test in two weeks.",
          quote: "Repeat in 2 weeks",
        },
        {
          text: "FAKE: something the document never says.",
          quote: "No evidence of malignancy",
        },
      ],
    });
    renderReader(model);
    await firstPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Summary" }));
    const panel = screen.getByRole("region", {
      name: "Summary in plain words",
    });
    expect(
      await within(panel).findByText(
        "Written by AI and may be wrong. Check with your doctor.",
      ),
    ).toBeVisible();
    expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
    const links = within(panel).getAllByRole("button", {
      name: "Show in document",
    });
    expect(links).toHaveLength(2);
    expect(links[1]).toHaveAccessibleDescription(
      "FAKE: repeat the test in two weeks.",
    );
    const unsourced = within(panel).getAllByRole("listitem")[2];
    expect(within(unsourced).getByText("No source found")).toBeVisible();
    expect(within(unsourced).queryByRole("button")).toBeNull();
    expect(
      within(panel).getByText(
        humanText(/^Summary in plain words · FAKE test model · /),
      ),
    ).toBeVisible();
    expect(model.calls).toHaveLength(1);
  });

  it("labels every answer with the words of the AI helper notice, in all seven languages", () => {
    // AI_HELPER_NOTICE.md (#169), `aiHelper-resultLabel`: the same words
    // there, in the notice's `resultsBody`, and on every answer here.
    const notice = {
      en: "Written by AI and may be wrong. Check with your doctor.",
      es: "Escrito por IA; puede contener errores. Consulte con su médico.",
      fr: "Écrit par une IA et peut contenir des erreurs. Vérifiez auprès de votre médecin.",
      pl: "Napisane przez AI, może zawierać błędy. Proszę skonsultować się z lekarzem.",
      "pt-BR": "Escrito por IA e pode estar errado. Confira com seu médico.",
      "zh-CN": "由 AI 撰写，可能有误。请向您的医生核实。",
      "zh-TW": "由 AI 撰寫，可能有誤。請向您的醫師確認。",
    };
    for (const locale of LOCALES) {
      expect(translate(locale, "aiHelper.resultLabel"), locale).toBe(
        notice[locale],
      );
    }
  });

  it("shows a sentence's place: its page, the page text open, the words marked", async () => {
    const model = fakeLocalModel({
      sentences: () => [
        {
          text: "FAKE: repeat the test in two weeks.",
          quote: "Repeat in 2 weeks.",
        },
      ],
    });
    renderReader(model);
    await firstPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summary" }));
    await user.click(
      await screen.findByRole("button", { name: "Show in document" }),
    );
    await screen.findByRole("img", { name: humanText(/^Page 2 of 2/) });
    const mark = await waitFor(() => {
      const found = document.querySelector(".native-reader-text mark");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    // The page's text starts with spaces the reader trims; the mark moves with it.
    expect(mark).toHaveTextContent(/^Repeat in 2 weeks$/);
    expect(mark).toBeVisible();
    await waitFor(() => expect(mark).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    await firstPage();
    expect(document.querySelector(".native-reader-text mark")).toBeNull();
  });

  it("asks the model for a summary once, even where React runs effects twice", async () => {
    const model = fakeLocalModel();
    renderReader(model, { strict: true });
    await firstPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Summary" }));
    await screen.findByText(
      "Written by AI and may be wrong. Check with your doctor.",
    );
    expect(model.calls).toHaveLength(1);
  });

  it("numbers the last page read by its page, not by the count, when a page failed", async () => {
    // Pages 1, 2 and 4 read, page 3 refused, the rest left out: "pages 1 to 4".
    renderReader(fakeLocalModel(), {
      loadText: async () =>
        fakeDocumentText(
          [...pageTexts, "FAKE page three", "FAKE page four"],
          true,
          {
            failedPages: [2],
          },
        ),
    });
    await firstPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Summary" }));
    expect(
      await screen.findByText(
        humanText(
          "This summary covers only the start of the document: pages 1 to 4.",
        ),
      ),
    ).toBeVisible();
  });

  it("says when only the start of a long document was summarized", async () => {
    renderReader(fakeLocalModel(), {
      loadText: async () => fakeDocumentText(pageTexts, true),
    });
    await firstPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Summary" }));
    expect(
      await screen.findByText(
        humanText(
          "This summary covers only the start of the document: pages 1 to 2.",
        ),
      ),
    ).toBeVisible();
  });

  it.each([
    ["a page with no text", fakeDocumentText([pageTexts[0], ""])],
    ["a page cut short", fakeDocumentText(pageTexts, false, { cutPages: [1] })],
    [
      "a page not read",
      fakeDocumentText(pageTexts, false, { failedPages: [0] }),
    ],
  ])("says a summary may leave parts out, with %s", async (_case, text) => {
    renderReader(fakeLocalModel(), { loadText: async () => text });
    await firstPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Summary" }));
    expect(
      await screen.findByText(
        "Some pages could not be read in full, so this summary may leave parts out.",
      ),
    ).toBeVisible();
  });

  it("says a document with no text can't be summarized, and asks no model", async () => {
    const model = fakeLocalModel();
    renderReader(model, { loadText: async () => fakeDocumentText(["", " "]) });
    await firstPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Summary" }));
    expect(
      await screen.findByText(
        "myCarlos could not read any text in this document, so it can't summarize it. It may be a scan.",
      ),
    ).toBeVisible();
    expect(model.calls).toEqual([]);
  });

  it("says when the AI helper could not finish", async () => {
    const model = fakeLocalModel();
    model.summarize = async () => {
      throw new Error("FAKE failure");
    };
    renderReader(model);
    await firstPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Summary" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The AI helper could not finish. Try again.",
    );
  });

  it("explains words selected in the page text, with their sentence", async () => {
    const model = fakeLocalModel({ explanation: "FAKE: a salt in the blood." });
    renderReader(model);
    await firstPage();
    const user = userEvent.setup();
    await user.click(screen.getByText(humanText("Text on this page")));
    const text = await screen.findByText(pageTexts[0]);
    const range = document.createRange();
    const at = pageTexts[0].indexOf("Potassium");
    range.setStart(text.firstChild!, at);
    range.setEnd(text.firstChild!, at + "Potassium".length);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await user.click(screen.getByRole("button", { name: "Explain a term" }));
    const box = await screen.findByRole("textbox", { name: "Word or phrase" });
    expect(box).toHaveValue("Potassium");
    expect(box).toHaveAccessibleDescription(
      "Select words under “Text on this page”, or type them here.",
    );
    await user.click(screen.getByRole("button", { name: "Explain" }));
    const panel = screen.getByRole("region", { name: "Explain a term" });
    expect(
      await within(panel).findByText("FAKE: a salt in the blood."),
    ).toBeVisible();
    expect(
      within(panel).getByText(
        "Written by AI and may be wrong. Check with your doctor.",
      ),
    ).toBeVisible();
    expect(model.calls).toEqual([
      {
        tool: "explain",
        lang: "en",
        input: "Potassium\nPotassium 5.4 mmol/L, a little high.",
      },
    ]);
  });

  it("explains a typed term too, and asks for one first", async () => {
    const model = fakeLocalModel();
    renderReader(model);
    await firstPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Explain a term" }));
    const explain = screen.getByRole("button", { name: "Explain" });
    expect(explain).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Word or phrase" }),
      "eGFR",
    );
    await user.click(explain);
    expect(await screen.findByText("FAKE explanation of eGFR.")).toBeVisible();
    expect(model.calls[0]).toMatchObject({ tool: "explain", input: "eGFR\n" });
  });
});

describe("sentenceAround", () => {
  it("cuts the sentence a term is in, case aside", () => {
    const text =
      "Findings: a 6 mm nodule.\nNo new consolidation. Heart size normal.";
    expect(sentenceAround(text, "CONSOLIDATION")).toBe("No new consolidation.");
    expect(sentenceAround(text, "nodule")).toBe("Findings: a 6 mm nodule.");
    expect(sentenceAround(text, "heart")).toBe("Heart size normal.");
    // A capital whose lower case is longer (İ) must not shift the offsets.
    const turkish = "İlk cümle. İkinci cümle burada. Son.";
    expect(sentenceAround(turkish, "burada")).toBe("İkinci cümle burada.");
    expect(sentenceAround(text, "malignancy")).toBe("");
    expect(sentenceAround(text, "")).toBe("");
  });
});

describe("Preferences", () => {
  it("shows the AI helper as not installed on a computer, and not at all elsewhere", () => {
    const { rerender } = render(
      <PreferencesSettings aiStatus={{ state: "notInstalled" }} />,
    );
    const row = screen
      .getByRole("heading", { name: /AI helper/ })
      .closest("section")!;
    expect(within(row).getByText("Not installed")).toBeVisible();
    expect(
      within(row).getByText(
        "Explains your documents in plain words with an AI model that runs on this computer. Getting the model comes in a later version of myCarlos.",
      ),
    ).toBeVisible();
    rerender(<PreferencesSettings />);
    expect(screen.queryByRole("heading", { name: /AI helper/ })).toBeNull();
  });
});
