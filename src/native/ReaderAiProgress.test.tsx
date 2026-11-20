import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentReader } from "./DocumentReader";
import type { SummaryProgressEvent } from "../ai/summaryProgress";
import { LOCALES, setLocaleOverride, translate } from "../i18n";
import { fakeDocumentText, fakeLocalModel } from "../test/fakeLocalModel";
import { humanText } from "../test/humanText";
import type { VaultRecord, ViewedPage } from "../vault";

// The summary's progress (#72): the helper's events, faked, drive the bar, the
// stage words, the time left and "taking longer". FAKE documents only.

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
const pageTexts = ["FAKE text on page 1.", "FAKE text on page 2."];
const page = (index: number): ViewedPage => ({
  pageCount: 2,
  width: 800,
  height: 1035,
  image: PNG,
  text: pageTexts[index],
});

type Report = (event: Omit<SummaryProgressEvent, "answerId">) => void;

/** A model whose summary waits for the test: it reports progress as told and
 * answers when released. */
function heldModel() {
  const held: { report: Report | null; release: () => void } = {
    report: null,
    release: () => undefined,
  };
  const model = fakeLocalModel({
    whileSummarizing: (report) =>
      new Promise<void>((resolve) => {
        held.report = report;
        held.release = resolve;
      }),
  });
  return { model, held };
}

async function startSummary(model: ReturnType<typeof heldModel>["model"]) {
  render(
    <DocumentReader
      record={record}
      viewPage={vi.fn(async (index: number) => page(index))}
      onClose={vi.fn()}
      ai={{
        model,
        loadText: vi.fn(async () => fakeDocumentText(pageTexts)),
        cancelText: vi.fn(),
        onOpenPreferences: vi.fn(),
      }}
    />,
  );
  await screen.findByRole("img", { name: humanText(/Page 1 of 2/) });
  await userEvent
    .setup({ advanceTimers: vi.advanceTimersByTime })
    .click(screen.getByRole("button", { name: "Summary" }));
  const panel = await screen.findByRole("region", {
    name: "Summary in plain words",
  });
  return panel;
}

const status = (panel: HTMLElement) => within(panel).getByRole("status");
const bar = (panel: HTMLElement) => within(panel).getByRole("progressbar");

beforeEach(() => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ["Date", "setInterval", "clearInterval"],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the summary's progress", () => {
  it("says it can take a few minutes, with a bar that has no number, until the helper starts", async () => {
    const { model, held } = heldModel();
    const panel = await startSummary(model);
    await waitFor(() => expect(held.report).not.toBeNull());
    expect(
      within(panel).getByText(
        "This can take a few minutes. You can keep reading the letter.",
      ),
    ).toBeVisible();
    expect(bar(panel)).not.toHaveAttribute("value");
    expect(status(panel)).toHaveTextContent("The AI helper is working…");
    expect(within(panel).queryByText(/left$/)).toBeNull();
  });

  it("follows the stages with the bar and the words, and says the summary is ready", async () => {
    const { model, held } = heldModel();
    const panel = await startSummary(model);
    await waitFor(() => expect(held.report).not.toBeNull());

    act(() => held.report!({ stage: "reading", done: 512, total: 1024 }));
    expect(status(panel)).toHaveTextContent("Reading the letter…");
    expect(bar(panel)).toHaveAttribute("value", "50");
    expect(bar(panel)).toHaveAttribute(
      "aria-valuetext",
      "Reading the letter…, 50%",
    );
    expect(bar(panel)).toHaveAccessibleName("Reading the letter…");

    act(() => held.report!({ stage: "writing", done: 3, total: 10 }));
    expect(status(panel)).toHaveTextContent("Writing the summary…");
    expect(bar(panel)).toHaveAttribute("value", "30");
    expect(bar(panel)).toHaveAttribute(
      "aria-valuetext",
      "Writing the summary…, 30%",
    );

    act(() => held.report!({ stage: "checking", done: 0, total: 0 }));
    expect(status(panel)).toHaveTextContent("Checking the summary…");
    expect(bar(panel)).toHaveAttribute("value", "100");

    await act(async () => held.release());
    await waitFor(() =>
      expect(status(panel)).toHaveTextContent("The summary is ready."),
    );
    expect(within(panel).queryByRole("progressbar")).toBeNull();
  });

  it("changes the status line only when the stage changes", async () => {
    const { model, held } = heldModel();
    const panel = await startSummary(model);
    await waitFor(() => expect(held.report).not.toBeNull());
    // One turn between events, so that the observer sees each change.
    const send = async (report: () => void) => {
      act(report);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const changes: string[] = [];
    const watch = new MutationObserver(() =>
      changes.push(status(panel).textContent ?? ""),
    );
    watch.observe(status(panel), {
      childList: true,
      characterData: true,
      subtree: true,
    });
    await send(() =>
      held.report!({
        stage: "reading",
        done: 1,
        total: 4,
        estimateSeconds: 200,
      }),
    );
    await send(() =>
      held.report!({
        stage: "reading",
        done: 2,
        total: 4,
        estimateSeconds: 150,
      }),
    );
    await send(() =>
      held.report!({
        stage: "reading",
        done: 3,
        total: 4,
        estimateSeconds: 100,
      }),
    );
    await send(() => held.report!({ stage: "writing", done: 1, total: 10 }));
    await send(() => held.report!({ stage: "writing", done: 2, total: 10 }));
    watch.disconnect();
    expect(changes).toEqual(["Reading the letter…", "Writing the summary…"]);
  });

  it("shows the time left in the panel, rounded up and never counting up", async () => {
    const { model, held } = heldModel();
    const panel = await startSummary(model);
    await waitFor(() => expect(held.report).not.toBeNull());
    act(() =>
      held.report!({
        stage: "reading",
        done: 512,
        total: 1024,
        estimateSeconds: 100,
      }),
    );
    expect(
      within(panel).getByText(humanText("About 2 minutes left")),
    ).toBeVisible();
    act(() =>
      held.report!({
        stage: "reading",
        done: 600,
        total: 1024,
        estimateSeconds: 400,
      }),
    );
    expect(
      within(panel).getByText(humanText("About 2 minutes left")),
    ).toBeVisible();
    act(() =>
      held.report!({
        stage: "writing",
        done: 4,
        total: 10,
        estimateSeconds: 40,
      }),
    );
    expect(
      within(panel).getByText(humanText("Less than a minute left")),
    ).toBeVisible();
    // The status line does not carry it: nothing is read out every few seconds.
    expect(status(panel)).toHaveTextContent("Writing the summary…");
    expect(status(panel)).not.toHaveTextContent("left");
    act(() =>
      held.report!({
        stage: "checking",
        done: 0,
        total: 0,
        estimateSeconds: 5,
      }),
    );
    expect(within(panel).queryByText(/left$/)).toBeNull();
  });

  it('says "taking longer than expected" once the time shown has passed, and tells the status line once', async () => {
    const { model, held } = heldModel();
    const panel = await startSummary(model);
    await waitFor(() => expect(held.report).not.toBeNull());
    act(() =>
      held.report!({
        stage: "reading",
        done: 512,
        total: 1024,
        estimateSeconds: 100,
      }),
    );
    expect(
      within(panel).getByText(humanText("About 2 minutes left")),
    ).toBeVisible();
    act(() => vi.advanceTimersByTime(121_000));
    const slower = "This is taking longer than expected.";
    expect(
      within(panel).getByText(slower, { selector: "p.native-reader-ai-wait" }),
    ).toBeVisible();
    expect(status(panel)).toHaveTextContent(slower);
    expect(within(panel).queryByText(/minutes? left$/)).toBeNull();
    // The next stage's words replace it in the status line; the panel keeps
    // saying it, and the number does not come back.
    act(() =>
      held.report!({
        stage: "writing",
        done: 1,
        total: 10,
        estimateSeconds: 30,
      }),
    );
    expect(status(panel)).toHaveTextContent("Writing the summary…");
    expect(within(panel).getByText(slower)).toBeVisible();
    expect(within(panel).queryByText(/left$/)).toBeNull();
  });

  it("ignores events that do not add up, and a stage that goes back", async () => {
    const { model, held } = heldModel();
    const panel = await startSummary(model);
    await waitFor(() => expect(held.report).not.toBeNull());
    act(() => held.report!({ stage: "writing", done: 4, total: 10 }));
    act(() => held.report!({ stage: "reading", done: 1, total: 2 }));
    act(() => held.report!({ stage: "writing", done: 9, total: 8 }));
    expect(status(panel)).toHaveTextContent("Writing the summary…");
    expect(bar(panel)).toHaveAttribute("value", "40");
  });

  it("shows no bar once the run has ended, whatever arrives after", async () => {
    const { model, held } = heldModel();
    const panel = await startSummary(model);
    await waitFor(() => expect(held.report).not.toBeNull());
    await act(async () => held.release());
    await waitFor(() =>
      expect(status(panel)).toHaveTextContent("The summary is ready."),
    );
    act(() => held.report!({ stage: "writing", done: 5, total: 10 }));
    expect(within(panel).queryByRole("progressbar")).toBeNull();
    expect(status(panel)).toHaveTextContent("The summary is ready.");
  });
});

describe("the six texts in every language", () => {
  const keys = [
    "ai.summary.progress.before",
    "ai.summary.progress.reading",
    "ai.summary.progress.writing",
    "ai.summary.progress.checking",
    "ai.summary.progress.slower",
  ] as const;

  it.each(LOCALES)(
    "has them all in %s, with the minutes said in every case",
    (locale) => {
      for (const key of keys) {
        const text = translate(locale, key);
        expect(text.trim()).not.toBe("");
        expect(text).not.toMatch(/[{}]/);
      }
      for (const minutes of [0, 2, 3, 4, 5, 10, 15, 20]) {
        const text = translate(locale, "ai.summary.progress.estimate", {
          minutes,
        });
        expect(text.trim()).not.toBe("");
        expect(text).not.toMatch(/[{}]/);
        if (minutes > 0) expect(text).toContain(String(minutes));
      }
    },
  );

  it("says the minutes as each language counts them", () => {
    const say = (locale: (typeof LOCALES)[number], minutes: number) =>
      translate(locale, "ai.summary.progress.estimate", { minutes }).replace(
        /[\u2068\u2069]/g,
        "",
      );
    expect(say("en", 0)).toBe("Less than a minute left");
    expect(say("en", 2)).toBe("About 2 minutes left");
    expect(say("en", 1)).toBe("About 1 minute left");
    expect(say("fr", 0)).toBe("Moins d’une minute restante");
    expect(say("fr", 3)).toBe("Environ 3 minutes restantes");
    // Polish: a few (2 to 4), many (5 and over), not one sentence for all.
    expect(say("pl", 2)).toBe("Zostały około 2 minuty");
    expect(say("pl", 5)).toBe("Zostało około 5 minut");
    expect(say("pl", 20)).toBe("Zostało około 20 minut");
    expect(say("zh-CN", 0)).toBe("剩余不到一分钟");
    expect(say("zh-CN", 3)).toBe("大约还剩 3 分钟");
    expect(say("zh-TW", 3)).toBe("大約還剩 3 分鐘");
  });

  it("shows the progress words in the app's language", async () => {
    const { model, held } = heldModel();
    // The page label is English until the language is chosen.
    render(
      <DocumentReader
        record={record}
        viewPage={vi.fn(async (index: number) => page(index))}
        onClose={vi.fn()}
        ai={{
          model,
          loadText: vi.fn(async () => fakeDocumentText(pageTexts)),
          cancelText: vi.fn(),
          onOpenPreferences: vi.fn(),
        }}
      />,
    );
    await screen.findByRole("img", { name: humanText(/Page 1 of 2/) });
    act(() => setLocaleOverride("fr"));
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(
      screen.getByRole("button", {
        name: translate("fr", "ai.summary.button"),
      }),
    );
    await waitFor(() => expect(held.report).not.toBeNull());
    act(() =>
      held.report!({
        stage: "reading",
        done: 1,
        total: 2,
        estimateSeconds: 100,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("progressbar")).toHaveAccessibleName(
        "Lecture de la lettre…",
      ),
    );
    expect(
      screen.getAllByRole("status").map((each) => each.textContent),
    ).toContain("Lecture de la lettre…");
    expect(
      screen.getByText(humanText("Environ 2 minutes restantes")),
    ).toBeVisible();
  });
});
