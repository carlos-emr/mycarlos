import { humanText } from "../test/humanText";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocumentReader } from "./DocumentReader";
import { AI_EXPLAIN_ENABLED } from "../ai/features";
import { notInstalledModel } from "../ai/localModel";
import type { LocalModel } from "../ai/types";
import { fakeDocumentText, fakeLocalModel } from "../test/fakeLocalModel";
import type { VaultRecord, ViewedPage } from "../vault";

// The reader as patients see it with Explain switched off in the UI
// (src/ai/features.ts, Ben, 11 November 2026). No mock here: this file reads
// the real switch. ReaderAi.test.tsx turns it on to keep Explain's code covered.

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

function renderReader(model: LocalModel) {
  const onOpenPreferences = vi.fn();
  render(
    <DocumentReader
      record={record}
      viewPage={vi.fn(async (index: number) => page(index))}
      onClose={vi.fn()}
      ai={{
        model,
        loadText: vi.fn(async () => fakeDocumentText(pageTexts)),
        cancelText: vi.fn(),
        onOpenPreferences,
      }}
    />,
  );
  return { onOpenPreferences };
}

const firstPage = () =>
  screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });

describe("the reader with Explain switched off", () => {
  it("offers Summary only: no Explain button, panel or term box", async () => {
    // The tests below describe the app with the switch off; turning it back
    // on is a product change, so this file changes with it.
    expect(AI_EXPLAIN_ENABLED).toBe(false);
    renderReader(fakeLocalModel());
    await firstPage();
    expect(screen.getByRole("button", { name: "Summary" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Explain a term" })).toBeNull();
    // Words selected in the page text no longer lead anywhere either.
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
    await user.click(screen.getByRole("button", { name: "Summary" }));
    const panel = screen.getByRole("region", {
      name: "Summary in plain words",
    });
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("region", { name: "Explain a term" })).toBeNull();
    expect(screen.queryByLabelText("Word or phrase")).toBeNull();
  });

  it("summarizes as before: the label, the source links and one model call", async () => {
    const model = fakeLocalModel({
      sentences: () => [
        {
          text: "FAKE: your potassium is a little high.",
          quote: "Potassium 5.4 mmol/L",
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
    expect(within(panel).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(panel).getAllByRole("button", { name: "Show in document" }),
    ).toHaveLength(1);
    expect(model.calls).toEqual([
      expect.objectContaining({ tool: "summary", lang: "en" }),
    ]);
  });

  it("with no model, Summary still says so and leads to Preferences, and Explain is not offered", async () => {
    const { onOpenPreferences } = renderReader(notInstalledModel);
    await firstPage();
    expect(screen.queryByRole("button", { name: "Explain a term" })).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Summary" }));
    const panel = screen.getByRole("region", {
      name: "Summary in plain words",
    });
    expect(
      await within(panel).findByText(
        "The AI helper isn't on this computer yet",
      ),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(
        within(panel).getByRole("button", { name: "Open AI helper settings" }),
      );
    expect(onOpenPreferences).toHaveBeenCalledTimes(1);
  });
});
