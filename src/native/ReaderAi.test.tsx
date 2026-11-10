import { humanText, visibleText } from "../test/humanText";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { DocumentReader, sentenceAround } from "./DocumentReader";
import { PreferencesSettings } from "./PreferencesSettings";
import { AiSettings } from "./AiSettings";
import type { ReaderAi } from "./ReaderAiPanel";
import type { KeptAnswers } from "../ai/kept";
import type { SourceSpan } from "../documentText";
import { nativeLocalModel, notInstalledModel } from "../ai/localModel";
import { LOCALES, setLocaleOverride, translate } from "../i18n";
import { ModelCancelled, type LocalModel } from "../ai/types";
import {
  FAKE_MODEL,
  fakeDocumentText,
  fakeLocalModel,
  type FakeLocalModel,
} from "../test/fakeLocalModel";
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
  options: {
    loadText?: ReaderAi["loadText"];
    strict?: boolean;
    record?: VaultRecord;
    startWithAid?: boolean;
    beforeFirstUse?: ReaderAi["beforeFirstUse"];
    kept?: KeptAnswers;
  } = {},
) {
  const onOpenPreferences = vi.fn();
  const loadText = vi.fn(
    options.loadText ?? (async () => fakeDocumentText(pageTexts)),
  );
  const cancelText = vi.fn();
  const reader = (
    <DocumentReader
      record={options.record ?? record}
      startWithAid={options.startWithAid}
      viewPage={vi.fn(async (index: number) => page(index))}
      onClose={vi.fn()}
      ai={
        model
          ? {
              model,
              loadText,
              cancelText,
              onOpenPreferences,
              beforeFirstUse: options.beforeFirstUse,
              kept: options.kept,
            }
          : undefined
      }
    />
  );
  const { unmount } = render(
    options.strict ? <StrictMode>{reader}</StrictMode> : reader,
  );
  return { onOpenPreferences, loadText, cancelText, unmount };
}

/** A vault that keeps answers in memory, as the real one does per record. */
type KeptInput = { tool: "summary" | "explain"; lang: string; term?: string };

/** The vault's answers for one document. A save names an answer the model
 * kept natively (`model.kept`) and adds a summary's source places; the
 * stored text is the native side's, faked here as the question it answers. */
function fakeKept(
  saved: { input: KeptInput; content: string }[] = [],
  model?: FakeLocalModel,
) {
  const infoOf = (input: KeptInput, size: number, id: string) => ({
    id,
    tool: input.tool,
    lang: input.lang,
    ...(input.term ? { term: input.term } : {}),
    modelName: "FAKE model",
    modelSha256: "ab".repeat(32),
    createdAtMs: 1,
    size,
  });
  const saves: { keptId: string; sources?: (SourceSpan | null)[] }[] = [];
  const kept: KeptAnswers = {
    recordId: "FAKE-record",
    list: vi.fn(async () =>
      saved.map((entry, index) =>
        infoOf(entry.input, entry.content.length, `k${index}`),
      ),
    ),
    read: vi.fn(async (id: string) => saved[Number(id.slice(1))].content),
    save: vi.fn(async (keptId: string, sources?: (SourceSpan | null)[]) => {
      saves.push({ keptId, ...(sources ? { sources } : {}) });
      const answer = model?.kept.find((entry) => entry.keptId === keptId);
      if (!answer) throw new Error("FAKE: nothing kept under that id");
      const input: KeptInput = {
        tool: answer.tool,
        lang: answer.lang,
        ...(answer.term ? { term: answer.term } : {}),
      };
      const content = JSON.stringify(input);
      saved.push({ input, content });
      return infoOf(input, content.length, `k${saved.length - 1}`);
    }),
  };
  return { kept, saved, saves };
}

const AI_LABEL = "Written by AI and may be wrong. Check with your doctor.";

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
      within(panel).getByRole("button", {
        name: "Open AI helper settings",
      }),
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

  it("closes the page text on a page turn, and opens it on the page a summary sentence points to", async () => {
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
    const pageText = () =>
      document.querySelector(
        "details.native-reader-text",
      ) as HTMLDetailsElement;
    await user.click(screen.getByText(humanText("Text on this page")));
    expect(pageText().open).toBe(true);
    expect(await screen.findByText(pageTexts[0])).toBeVisible();
    // A page turn by hand closes the text, as the reader does without the AI
    // helper; one click on "Text on this page" opens it again on the new page.
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("img", { name: humanText(/^Page 2 of 2/) });
    await waitFor(() => expect(pageText().open).toBe(false));
    await user.click(screen.getByText(humanText("Text on this page")));
    expect(pageText().open).toBe(true);
    expect(await screen.findByText(pageTexts[1].trim())).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    await firstPage();
    await waitFor(() => expect(pageText().open).toBe(false));
    // "Show in document" turns to the sentence's page with the text open.
    await user.click(screen.getByRole("button", { name: "Summary" }));
    await user.click(
      await screen.findByRole("button", { name: "Show in document" }),
    );
    await screen.findByRole("img", { name: humanText(/^Page 2 of 2/) });
    await waitFor(() => expect(pageText().open).toBe(true));
    const mark = await waitFor(() => {
      const found = document.querySelector(".native-reader-text mark");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(mark).toBeVisible();
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

  it("keeps a new summary and a new explanation with the document, by the id the model kept each under", async () => {
    const model = fakeLocalModel();
    const { kept, saved, saves } = fakeKept([], model);
    renderReader(model, { kept });
    await firstPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summary" }));
    await screen.findByText(AI_LABEL);
    await waitFor(() => expect(kept.save).toHaveBeenCalledTimes(1));
    // Asked to keep it for this document; saved by its id, with the
    // sentences' source places and nothing else.
    expect(model.kept[0]).toEqual({
      keptId: "FAKE-kept-1",
      recordId: "FAKE-record",
      tool: "summary",
      lang: "en",
    });
    expect(saves[0].keptId).toBe("FAKE-kept-1");
    expect(saves[0].sources).toHaveLength(
      screen.getAllByRole("listitem").length,
    );
    expect(saved[0].input).toEqual({ tool: "summary", lang: "en" });
    await user.click(screen.getByRole("button", { name: "Explain a term" }));
    await user.type(screen.getByLabelText("Word or phrase"), "potassium");
    await user.click(screen.getByRole("button", { name: "Explain" }));
    await waitFor(() => expect(kept.save).toHaveBeenCalledTimes(2));
    expect(saves[1]).toEqual({ keptId: "FAKE-kept-2" });
    expect(saved[1].input).toMatchObject({
      tool: "explain",
      term: "potassium",
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the summary the vault kept, asks no model, and summarizes again on request", async () => {
    const model = fakeLocalModel();
    const { kept } = fakeKept(
      [
        {
          input: { tool: "summary", lang: "en" },
          content: JSON.stringify({
            tool: "summary",
            sentences: [
              {
                text: "FAKE: kept earlier.",
                quote: "FAKE text on page 2",
                source: null,
              },
            ],
            model: { name: "FAKE older model", sha256: "cd".repeat(32) },
            lang: "en",
            createdAt: Date.UTC(2026, 9, 1),
            partial: true,
            lastPage: 4,
            pagesMissing: true,
          }),
        },
      ],
      model,
    );
    renderReader(model, { kept });
    await firstPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summary" }));
    expect(await screen.findByText("FAKE: kept earlier.")).toBeVisible();
    expect(screen.getByText(AI_LABEL)).toBeVisible();
    expect(screen.getByText(humanText(/FAKE older model/))).toBeVisible();
    expect(model.calls).toHaveLength(0);
    // A kept summary keeps its own notices: what was read, and what was not.
    expect(
      screen.getByText(
        humanText(
          "This summary covers only the start of the document: pages 1 to 4.",
        ),
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Some pages could not be read in full, so this summary may leave parts out.",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Summarize again" }));
    await screen.findByText(humanText(/FAKE test model/));
    expect(model.calls).toHaveLength(1);
    expect(screen.queryByText("FAKE: kept earlier.")).toBeNull();
    expect(kept.save).toHaveBeenCalledTimes(1);
  });

  it("says when an answer could not be kept, and keeps showing it", async () => {
    const { kept } = fakeKept();
    (kept.save as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("FAKE: disk full"),
    );
    renderReader(fakeLocalModel(), { kept });
    await firstPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Summary" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "myCarlos could not keep this answer with the document. It is still shown here.",
    );
    expect(screen.getByText(AI_LABEL)).toBeVisible();
  });

  it("says when the document already keeps the most answers it can, and keeps showing the new one", async () => {
    const { kept } = fakeKept();
    (kept.save as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: "ai_results_full",
      messageKey: "ai.keepFull",
      message: "the document keeps the most AI answers it can",
    });
    renderReader(fakeLocalModel(), { kept });
    await firstPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Summary" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This document already keeps the most AI answers it can. New answers are shown but not kept.",
    );
    expect(screen.getByText(AI_LABEL)).toBeVisible();
  });

  it.each([
    ["the panel is closed", "close"],
    ["the panel switches to Explain", "explain"],
    ["the reader closes", "reader"],
  ] as const)(
    "stops the document's text read when %s before it ends, and asks no model",
    async (_case, how) => {
      const model = fakeLocalModel();
      let finish: (text: ReturnType<typeof fakeDocumentText>) => void = () =>
        undefined;
      const { loadText, cancelText, unmount } = renderReader(model, {
        loadText: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      });
      await firstPage();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Summary" }));
      await waitFor(() => expect(loadText).toHaveBeenCalledTimes(1));
      expect(cancelText).not.toHaveBeenCalled();
      if (how === "close")
        await user.click(screen.getByRole("button", { name: "Summary" }));
      else if (how === "explain")
        await user.click(
          screen.getByRole("button", { name: "Explain a term" }),
        );
      else unmount();
      expect(cancelText).toHaveBeenCalledTimes(1);
      // A text that still arrives is dropped: no model is asked for it.
      finish(fakeDocumentText(pageTexts));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(model.calls).toEqual([]);
      expect(
        screen.queryByText(
          "Written by AI and may be wrong. Check with your doctor.",
        ),
      ).toBeNull();
    },
  );

  it.each([false, true])(
    "stops nothing once the text is read (StrictMode %s)",
    async (strict) => {
      const { cancelText, unmount } = renderReader(fakeLocalModel(), {
        strict,
      });
      await firstPage();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Summary" }));
      await screen.findByText(
        "Written by AI and may be wrong. Check with your doctor.",
      );
      await user.click(screen.getByRole("button", { name: "Summary" }));
      unmount();
      expect(cancelText).not.toHaveBeenCalled();
    },
  );

  it("stops no text read for a model that isn't installed", async () => {
    const { loadText, cancelText, unmount } = renderReader(notInstalledModel);
    await firstPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Summary" }));
    await screen.findByText("The AI helper isn't on this computer yet");
    unmount();
    expect(loadText).not.toHaveBeenCalled();
    expect(cancelText).not.toHaveBeenCalled();
  });

  it("stops the model's answer when the panel closes while it writes, and says nothing", async () => {
    const model = fakeLocalModel();
    let asked = false;
    model.summarize = () => {
      asked = true;
      return new Promise(() => undefined);
    };
    const { cancelText } = renderReader(model);
    await firstPage();
    const user = userEvent.setup();
    const summary = screen.getByRole("button", { name: "Summary" });
    await user.click(summary);
    await waitFor(() => expect(asked).toBe(true));
    expect(model.cancels).toBe(0);
    await user.click(summary);
    expect(model.cancels).toBe(1);
    // The text was read by then: only the model is stopped.
    expect(cancelText).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stops nothing once the answer is written", async () => {
    const model = fakeLocalModel();
    const { unmount } = renderReader(model);
    await firstPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Summary" }));
    await screen.findByText(
      "Written by AI and may be wrong. Check with your doctor.",
    );
    unmount();
    expect(model.cancels).toBe(0);
  });

  it("says nothing when the answer was stopped elsewhere, as by the lock", async () => {
    const model = fakeLocalModel();
    model.summarize = async () => {
      throw new ModelCancelled();
    };
    renderReader(model);
    await firstPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Summary" }));
    const panel = screen.getByRole("region", {
      name: "Summary in plain words",
    });
    await waitFor(() => expect(panel).toHaveAttribute("aria-busy", "false"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByText(
        "Written by AI and may be wrong. Check with your doctor.",
      ),
    ).toBeNull();
  });

  it.each([
    [{ state: "damaged" } as const],
    [{ state: "unsupported", reason: "platform" } as const],
  ])("leads to Preferences when the model is %j", async (status) => {
    const model = fakeLocalModel({ status });
    const { onOpenPreferences, loadText } = renderReader(model);
    await firstPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summary" }));
    const panel = screen.getByRole("region", {
      name: "Summary in plain words",
    });
    expect(
      await within(panel).findByText(
        "The AI helper isn't on this computer yet",
      ),
    ).toBeVisible();
    await user.click(
      within(panel).getByRole("button", {
        name: "Open AI helper settings",
      }),
    );
    expect(onOpenPreferences).toHaveBeenCalledTimes(1);
    expect(loadText).not.toHaveBeenCalled();
    expect(model.calls).toEqual([]);
  });

  it("says how far the model read when it had no room for every page", async () => {
    renderReader(fakeLocalModel({ lastPage: () => 0 }));
    await firstPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Summary" }));
    expect(
      await screen.findByText(
        humanText(
          "This summary covers only the start of the document: pages 1 to 1.",
        ),
      ),
    ).toBeVisible();
  });

  it("takes no longer term than the native side accepts, typed or pasted", async () => {
    renderReader(fakeLocalModel());
    await firstPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Explain a term" }));
    const box = screen.getByRole("textbox", { name: "Word or phrase" });
    expect(box).toHaveAttribute("maxLength", "200");
    await user.click(box);
    await user.paste("x".repeat(250));
    expect((box as HTMLInputElement).value).toHaveLength(200);
  });

  it("opens a tool only once the app lets it, and closing never waits", async () => {
    const model = fakeLocalModel();
    const opens: (() => void)[] = [];
    const beforeFirstUse = vi.fn((open: () => void) => {
      opens.push(open);
    });
    const { loadText } = renderReader(model, { beforeFirstUse });
    await firstPage();
    const user = userEvent.setup();
    const summary = screen.getByRole("button", { name: "Summary" });
    await user.click(summary);
    expect(beforeFirstUse).toHaveBeenCalledTimes(1);
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("region", { name: "Summary in plain words" }),
    ).toBeNull();
    expect(loadText).not.toHaveBeenCalled();
    expect(model.calls).toEqual([]);

    act(() => opens[0]());
    await screen.findByText(
      "Written by AI and may be wrong. Check with your doctor.",
    );
    expect(model.calls).toHaveLength(1);
    // Closing the open tool does not ask.
    await user.click(summary);
    expect(beforeFirstUse).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("region", { name: "Summary in plain words" }),
    ).toBeNull();
  });

  it("says in its status that the summary, and then the explanation, is ready", async () => {
    renderReader(fakeLocalModel());
    await firstPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summary" }));
    const summaryPanel = screen.getByRole("region", {
      name: "Summary in plain words",
    });
    await waitFor(() =>
      expect(within(summaryPanel).getByRole("status")).toHaveTextContent(
        "The summary is ready.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Explain a term" }));
    const explainPanel = screen.getByRole("region", { name: "Explain a term" });
    expect(within(explainPanel).getByRole("status")).toHaveTextContent("");
    await user.type(
      within(explainPanel).getByRole("textbox", { name: "Word or phrase" }),
      "potassium",
    );
    await user.click(
      within(explainPanel).getByRole("button", { name: "Explain" }),
    );
    await waitFor(() =>
      expect(within(explainPanel).getByRole("status")).toHaveTextContent(
        "The explanation is ready.",
      ),
    );
  });

  it("says a summary can take several minutes, and how many it has taken, outside its status", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const model = fakeLocalModel();
      const written = model.summarize.bind(model);
      let release!: () => void;
      model.summarize = async (...args) => {
        await new Promise<void>((resolve) => (release = resolve));
        return written(...args);
      };
      renderReader(model);
      await firstPage();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(screen.getByRole("button", { name: "Summary" }));
      const panel = screen.getByRole("region", {
        name: "Summary in plain words",
      });
      const status = within(panel).getByRole("status");
      await waitFor(() =>
        expect(status).toHaveTextContent("The AI helper is working…"),
      );
      expect(
        within(panel).getByText(
          humanText("This can take several minutes for a long document."),
        ),
      ).toBeVisible();
      // No time before the first minute.
      expect(within(panel).queryByText(/so far/)).toBeNull();
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(
        within(panel).getByText(humanText("Working for 1 minute so far.")),
      ).toBeVisible();
      await act(async () => vi.advanceTimersByTime(2 * 60_000));
      expect(
        within(panel).getByText(humanText("Working for 3 minutes so far.")),
      ).toBeVisible();
      // A screen reader is told the work once, not each minute.
      expect(status).toHaveTextContent(/^The AI helper is working…$/);
      // Both go once the answer is written.
      await act(async () => release());
      await waitFor(() =>
        expect(status).toHaveTextContent("The summary is ready."),
      );
      expect(within(panel).queryByText(/several minutes|so far/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts an explanation's minutes too, without the long-document note", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const model = fakeLocalModel();
      model.explain = () => new Promise(() => undefined);
      renderReader(model);
      await firstPage();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(screen.getByRole("button", { name: "Explain a term" }));
      const panel = screen.getByRole("region", { name: "Explain a term" });
      await user.type(
        within(panel).getByRole("textbox", { name: "Word or phrase" }),
        "potassium",
      );
      await user.click(within(panel).getByRole("button", { name: "Explain" }));
      await waitFor(() =>
        expect(within(panel).getByRole("status")).toHaveTextContent(
          "The AI helper is working…",
        ),
      );
      await act(async () => vi.advanceTimersByTime(2 * 60_000));
      expect(
        within(panel).getByText(humanText("Working for 2 minutes so far.")),
      ).toBeVisible();
      expect(within(panel).queryByText(/several minutes/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says an answer is ready once: not for one read back from the vault, nor again on coming back to it", async () => {
    const model = fakeLocalModel();
    // A summary the vault kept earlier, in English.
    const { kept } = fakeKept(
      [
        {
          input: { tool: "summary", lang: "en" },
          content: JSON.stringify({
            tool: "summary",
            sentences: [
              {
                text: "FAKE: kept earlier.",
                quote: "FAKE text on page 2",
                source: null,
              },
            ],
            model: { name: "FAKE older model", sha256: "cd".repeat(32) },
            lang: "en",
            createdAt: Date.UTC(2026, 9, 1),
            partial: false,
            lastPage: 2,
            pagesMissing: false,
          }),
        },
      ],
      model,
    );
    renderReader(model, { kept });
    await firstPage();
    const user = userEvent.setup();
    const summaryTool = screen.getByRole("button", { name: "Summary" });
    const summaryStatus = () =>
      within(
        screen.getByRole("region", { name: "Summary in plain words" }),
      ).getByRole("status");
    await user.click(summaryTool);
    expect(await screen.findByText("FAKE: kept earlier.")).toBeVisible();
    // Read back, not new: nothing is read out.
    expect(summaryStatus()).toBeEmptyDOMElement();
    // To Explain and back: still the kept summary, still nothing new.
    await user.click(screen.getByRole("button", { name: "Explain a term" }));
    await user.click(summaryTool);
    expect(await screen.findByText("FAKE: kept earlier.")).toBeVisible();
    expect(summaryStatus()).toBeEmptyDOMElement();
    expect(model.calls).toHaveLength(0);
    // A new answer is said.
    await user.click(screen.getByRole("button", { name: "Summarize again" }));
    await waitFor(() =>
      expect(summaryStatus()).toHaveTextContent("The summary is ready."),
    );
    expect(model.calls).toHaveLength(1);
  });

  it("does not say an earlier explanation is ready when the next one fails", async () => {
    const model = fakeLocalModel();
    const explained = model.explain;
    let asked = 0;
    model.explain = async (...args) => {
      asked += 1;
      if (asked > 1) throw new Error("FAKE: the model failed");
      return explained(...args);
    };
    renderReader(model);
    await firstPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Explain a term" }));
    const explainPanel = screen.getByRole("region", { name: "Explain a term" });
    const box = within(explainPanel).getByRole("textbox", {
      name: "Word or phrase",
    });
    const ask = within(explainPanel).getByRole("button", { name: "Explain" });
    await user.type(box, "potassium");
    await user.click(ask);
    await waitFor(() =>
      expect(within(explainPanel).getByRole("status")).toHaveTextContent(
        "The explanation is ready.",
      ),
    );
    await user.clear(box);
    await user.type(box, "creatinine");
    await user.click(ask);
    await within(explainPanel).findByRole("alert");
    expect(within(explainPanel).getByRole("status")).toHaveTextContent("");
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

  // Refused as the native side refuses (lib.rs ai_error): a code and the key
  // of its words, passed on by the real bridge.
  const refusingModel = (code: string, messageKey?: string) => {
    const refusal = {
      code,
      message: "FAKE native words",
      ...(messageKey === undefined ? {} : { messageKey }),
    };
    return nativeLocalModel({
      aiModelStatus: async () => ({ state: "installed", model: FAKE_MODEL }),
      aiSummarize: () => Promise.reject(refusal),
      aiExplain: () => Promise.reject(refusal),
      aiCancel: async () => undefined,
    });
  };
  const OWN_WORDS = [
    [
      "aiStorage",
      "ai.error.storage",
      "The AI helper's model could not be read from this computer. Try again. If it keeps happening, remove the model in Settings, under AI helper, and add it again.",
    ],
    [
      "aiMemory",
      "ai.error.memory",
      "There isn't enough free memory for the AI helper right now. Close some other programs, then try again.",
    ],
    [
      "aiBusy",
      "ai.error.busy",
      "The AI helper's model is being added or removed. Try again when that is done.",
    ],
  ] as const;

  it.each(OWN_WORDS)(
    "says what stopped a summary refused with %s, in its own words",
    async (code, messageKey, words) => {
      renderReader(refusingModel(code, messageKey));
      await firstPage();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Summary" }));
      expect((await screen.findByRole("alert")).textContent).toBe(words);
    },
  );

  it.each(OWN_WORDS)(
    "says what stopped an explanation refused with %s, in its own words",
    async (code, messageKey, words) => {
      renderReader(refusingModel(code, messageKey));
      await firstPage();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Explain a term" }));
      await user.type(
        screen.getByRole("textbox", { name: "Word or phrase" }),
        "eGFR",
      );
      await user.click(screen.getByRole("button", { name: "Explain" }));
      expect((await screen.findByRole("alert")).textContent).toBe(words);
    },
  );

  // The code alone picks the words: not the key a refusal carries, nor its
  // message.
  it.each([
    ["aiStorage", "ai.failed", OWN_WORDS[0][2]],
    ["aiStorage", undefined, OWN_WORDS[0][2]],
    ["aiMemory", "ai.error.storage", OWN_WORDS[1][2]],
  ] as const)(
    "says the words of %s whatever key the refusal carries (%s)",
    async (code, messageKey, words) => {
      renderReader(refusingModel(code, messageKey));
      await firstPage();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Summary" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(words);
      expect(alert.textContent).not.toContain("FAKE native words");
    },
  );

  it("says a refusal's own words in the language chosen after it", async () => {
    renderReader(refusingModel("aiMemory", "ai.error.memory"));
    await firstPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Explain a term" }));
    await user.type(
      screen.getByRole("textbox", { name: "Word or phrase" }),
      "eGFR",
    );
    await user.click(screen.getByRole("button", { name: "Explain" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      OWN_WORDS[1][2],
    );
    act(() => setLocaleOverride("fr"));
    expect(screen.getByRole("alert")).toHaveHumanTextContent(
      "Il n’y a pas assez de mémoire libre pour l’assistant IA en ce moment. Fermez d’autres programmes, puis réessayez.",
    );
  });

  // Only these codes choose the words: any other refusal, even one naming
  // other words, says the helper could not finish.
  it.each([
    ["aiFailed", "ai.failed"],
    ["invalid", "ai.error.storage"],
  ])(
    "says the helper could not finish when refused with %s",
    async (code, messageKey) => {
      renderReader(refusingModel(code, messageKey));
      await firstPage();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Summary" }));
      expect((await screen.findByRole("alert")).textContent).toBe(
        "The AI helper could not finish. Try again.",
      );
    },
  );

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

describe("a document longer than the model reads at a time (#301)", () => {
  // Five FAKE pages of 3,150 bytes and a digit: 1,051 tokens each
  // (capacity.ts), so two fit a room of 2,200 and none fits 500 whole.
  const longPages = Array.from(
    { length: 5 },
    (_, index) => "FAKE long page text. ".repeat(150) + index,
  );
  const long = async () => fakeDocumentText(longPages);
  const withRoom = (documentTokens: number) =>
    fakeLocalModel({
      status: {
        state: "installed",
        model: FAKE_MODEL,
        capacity: { contextTokens: 8192, documentTokens },
      },
      // As the helper fits: two whole pages.
      lastPage: () => 1,
    });
  const warning = humanText(
    "This document is probably too long for the AI helper to read at once. It can read about pages 1 to 2 of 5.",
  );

  it("asks before the model starts, with the focus on its first answer, and summarizes the pages it can read on request", async () => {
    const model = withRoom(2200);
    renderReader(model, { loadText: long });
    await firstPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summary" }));
    expect(await screen.findByText(warning)).toBeVisible();
    expect(
      screen.getByText("The summary will say which pages it read."),
    ).toBeVisible();
    expect(model.calls).toHaveLength(0);
    // The first answer takes the focus, and is described by the question, so
    // a screen reader reads both.
    const read = screen.getByRole("button", {
      name: humanText("Summarize pages 1 to 2"),
    });
    await waitFor(() => expect(read).toHaveFocus());
    const description = (read.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(visibleText(description)).toBe(
      "This document is probably too long for the AI helper to read at once. It can read about pages 1 to 2 of 5. The summary will say which pages it read.",
    );
    // Tab reaches Cancel next, and back.
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(read).toHaveFocus();
    await user.keyboard("{Enter}");
    // The question goes; the focus goes back to Summary.
    expect(screen.queryByText(warning)).toBeNull();
    expect(screen.getByRole("button", { name: "Summary" })).toHaveFocus();
    expect(model.calls).toHaveLength(1);
    // The whole text goes to the native side, which fits the pages itself;
    // the answer says the pages it read, as before.
    expect(model.calls[0].input).toContain(longPages[4]);
    expect(
      await screen.findByText(
        humanText(
          "This summary covers only the start of the document: pages 1 to 2.",
        ),
      ),
    ).toBeVisible();
  });

  it("closes the panel on Cancel, asks no model, and puts the focus back on Summary", async () => {
    const model = withRoom(2200);
    renderReader(model, { loadText: long });
    await firstPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summary" }));
    await screen.findByText(warning);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(warning)).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Summary in plain words" }),
    ).toBeNull();
    const summary = screen.getByRole("button", { name: "Summary" });
    expect(summary).toHaveFocus();
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(model.calls).toHaveLength(0);
  });

  it("says when only the start of the first page fits", async () => {
    const model = withRoom(500);
    renderReader(model, { loadText: long });
    await firstPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summary" }));
    expect(
      await screen.findByText(
        "This document is probably too long for the AI helper to read at once. It can read only about the start of page 1.",
      ),
    ).toBeVisible();
    const read = screen.getByRole("button", {
      name: "Summarize the start of page 1",
    });
    await waitFor(() => expect(read).toHaveFocus());
    await user.click(read);
    expect(model.calls).toHaveLength(1);
  });

  it("asks nothing when the document fits, nor when the room is not known", async () => {
    for (const status of [
      {
        state: "installed" as const,
        model: FAKE_MODEL,
        capacity: { contextTokens: 8192, documentTokens: 6510 },
      },
      { state: "installed" as const, model: FAKE_MODEL, capacity: null },
    ]) {
      const model = fakeLocalModel({ status });
      const { unmount } = renderReader(model, {
        loadText:
          status.capacity === null
            ? long
            : async () => fakeDocumentText(pageTexts),
      });
      await firstPage();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Summary" }));
      await screen.findByText(AI_LABEL);
      expect(screen.queryByText(/probably too long/)).toBeNull();
      expect(model.calls).toHaveLength(1);
      unmount();
    }
  });

  it("shows a kept summary without asking, and reads no text for it", async () => {
    const model = withRoom(2200);
    const { kept } = fakeKept(
      [
        {
          input: { tool: "summary", lang: "en" },
          content: JSON.stringify({
            tool: "summary",
            sentences: [
              { text: "FAKE: kept earlier.", quote: "FAKE", source: null },
            ],
            model: FAKE_MODEL,
            lang: "en",
            createdAt: Date.UTC(2026, 9, 1),
            partial: true,
            lastPage: 2,
            pagesMissing: false,
          }),
        },
      ],
      model,
    );
    const { loadText } = renderReader(model, { loadText: long, kept });
    await firstPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summary" }));
    expect(await screen.findByText("FAKE: kept earlier.")).toBeVisible();
    expect(screen.queryByText(/probably too long/)).toBeNull();
    expect(loadText).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(0);
    // Summarizing again is a new run: it asks.
    await user.click(screen.getByRole("button", { name: "Summarize again" }));
    expect(await screen.findByText(warning)).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: humanText("Summarize pages 1 to 2"),
        }),
      ).toHaveFocus(),
    );
    expect(model.calls).toHaveLength(0);
  });

  it("asks after the notice about the AI helper, the first time", async () => {
    const model = withRoom(2200);
    let release: () => void = () => undefined;
    renderReader(model, {
      loadText: long,
      beforeFirstUse: (open) => {
        release = open;
      },
    });
    await firstPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Summary" }));
    expect(screen.queryByText(warning)).toBeNull();
    act(() => release());
    expect(await screen.findByText(warning)).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: humanText("Summarize pages 1 to 2"),
        }),
      ).toHaveFocus(),
    );
    expect(model.calls).toHaveLength(0);
  });

  it("asks in every language the app speaks", async () => {
    for (const locale of LOCALES) {
      expect(
        translate(locale, "ai.summary.tooLong", { last: 2, total: 5 }),
        locale,
      ).toMatch(/2[^]*5/);
      expect(
        translate(locale, "ai.summary.readPages", { last: 2 }),
        locale,
      ).toMatch(/2/);
    }
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

describe("Settings > AI helper", () => {
  it("has its own page with the model's row, and Preferences no longer holds it", () => {
    const { unmount } = render(
      <AiSettings aiStatus={{ state: "notInstalled" }} onAiStatus={vi.fn()} />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "AI helper" }),
    ).toBeVisible();
    expect(
      screen.getByText("How the AI helper works on this computer"),
    ).toBeVisible();
    const row = screen
      .getByRole("heading", { level: 2, name: /AI helper/ })
      .closest("section")!;
    expect(within(row).getByText("Not installed")).toBeVisible();
    expect(
      within(row).getByText(
        "Explains your documents in plain words with an AI model that runs on this computer. Download one of the models below, or add a matching file you already have. Models stay on this computer.",
      ),
    ).toBeVisible();
    unmount();
    render(<PreferencesSettings />);
    expect(screen.queryByRole("heading", { name: /AI helper/ })).toBeNull();
  });
});

describe("the AI helper beside a clinic reading aid", () => {
  const withAid: VaultRecord = {
    ...record,
    readingAid: {
      deliveryId: "aid-1",
      language: "en",
      reviewedAtMs: 1_792_450_680_000,
      notice: {
        version: "carlos-5537-en-1",
        heading: "FAKE notice heading",
        body: "FAKE notice body.",
      },
      overview: "FAKE overview.",
      points: [{ text: "FAKE point.", evidence: ["FAKE quote."] }],
    },
  };
  const model = () =>
    fakeLocalModel({
      sentences: () => [
        {
          text: "FAKE: repeat the test in two weeks.",
          quote: "Repeat in 2 weeks.",
        },
      ],
    });

  it("offers Summary and Explain only on the original, never over the clinician's aid", async () => {
    renderReader(model(), { record: withAid, startWithAid: true });
    expect(await screen.findByRole("note")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Summary" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Explain a term" })).toBeNull();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Open the original document" }),
    );
    await firstPage();
    expect(screen.getByRole("button", { name: "Summary" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Explain a term" }),
    ).toBeVisible();
    // And not the other way: going back to the aid takes the helper away again.
    await user.click(
      screen.getByRole("button", { name: "Read the reading aid" }),
    );
    expect(screen.getByRole("note")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Summary" })).toBeNull();
  });

  it("closes an open AI panel and clears the page text and its marked words when the aid is opened", async () => {
    renderReader(model(), { record: withAid });
    await firstPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summary" }));
    await user.click(
      await screen.findByRole("button", { name: "Show in document" }),
    );
    await screen.findByRole("img", { name: humanText(/^Page 2 of 2/) });
    await waitFor(() =>
      expect(document.querySelector(".native-reader-text mark")).not.toBeNull(),
    );
    await user.click(
      screen.getByRole("button", { name: "Read the reading aid" }),
    );
    expect(
      screen.queryByRole("region", { name: "Summary in plain words" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Open the original document" }),
    );
    // Back on the original: no panel, no marked words, and the page text is closed.
    await screen.findByRole("img", { name: humanText(/^Page \d of 2/) });
    expect(
      screen.queryByRole("region", { name: "Summary in plain words" }),
    ).toBeNull();
    expect(document.querySelector(".native-reader-text mark")).toBeNull();
    expect(
      document.querySelector<HTMLDetailsElement>(".native-reader-text")?.open,
    ).not.toBe(true);
  });

  it.each([false, true])(
    "puts the focus on the aid's heading when the reader opens straight onto it (StrictMode %s)",
    async (strict) => {
      renderReader(model(), { record: withAid, startWithAid: true, strict });
      const heading = await screen.findByRole("heading", {
        name: "Reading aid from your clinic",
      });
      await waitFor(() => expect(heading).toHaveFocus());
    },
  );
});
