import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_LABEL_STORAGE_KEY,
  aiLabelIsShort,
  rememberShortAiLabel,
  showFullAiLabelAgain,
} from "../aiLabelPreference";
import { setLocaleOverride } from "../i18n";
import { AiSettings } from "./AiSettings";

// Synthetic model hash only.
const MODEL = "c".repeat(64);

afterEach(() => {
  showFullAiLabelAgain();
  window.localStorage.removeItem(AI_LABEL_STORAGE_KEY);
  setLocaleOverride(null);
});

describe("Settings → AI helper: the warning on AI answers (#351)", () => {
  it("says the full warning is shown, and offers to bring it back once Don't show this again was chosen", async () => {
    setLocaleOverride("en");
    render(<AiSettings aiStatus={null} onAiStatus={vi.fn()} />);
    expect(
      screen.getByText("The full warning is shown on every AI answer."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show the full warning again" }),
    ).toBeNull();
    // A choice made on an answer elsewhere shows up here at once.
    rememberShortAiLabel("summary", MODEL);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Show the full warning again",
      }),
    );
    expect(aiLabelIsShort("summary", MODEL)).toBe(false);
    expect(
      await screen.findByText("The full warning is shown on every AI answer."),
    ).toBeInTheDocument();
    // The focus is on the row's heading, not lost to the page.
    expect(
      screen.getByRole("heading", { name: "Warning on AI answers" }),
    ).toHaveFocus();
  });

  it("keeps one status element on the page, so that its change of words is read out", async () => {
    setLocaleOverride("en");
    render(<AiSettings aiStatus={null} onAiStatus={vi.fn()} />);
    const status = screen.getByText(
      "The full warning is shown on every AI answer.",
    );
    expect(status).toHaveAttribute("role", "status");
    // The same element says the new words, and goes on saying them.
    rememberShortAiLabel("summary", MODEL);
    expect(
      await screen.findByText(
        "A short “AI draft” tag is shown on the AI answers you chose it for.",
      ),
    ).toBe(status);
    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "Show the full warning again" }),
      );
    expect(
      await screen.findByText("The full warning is shown on every AI answer."),
    ).toBe(status);
  });
});
