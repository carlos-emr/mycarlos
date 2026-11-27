import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_LABEL_STORAGE_KEY,
  aiLabelIsShort,
  rememberShortAiLabel,
  showFullAiLabelAgain,
} from "../aiLabelPreference";
import { LOCALES, setLocaleOverride, translate } from "../i18n";
import { AiSettings } from "./AiSettings";

// Synthetic model hash only.
const MODEL = "c".repeat(64);

afterEach(() => {
  showFullAiLabelAgain();
  window.localStorage.removeItem(AI_LABEL_STORAGE_KEY);
  setLocaleOverride(null);
});

describe("Settings → AI helper: the warning at the top", () => {
  it("shows the advice that goes with every AI answer, whatever the model state, in each language", () => {
    for (const locale of LOCALES) {
      setLocaleOverride(locale);
      const { unmount } = render(
        <AiSettings aiStatus={null} onAiStatus={vi.fn()} />,
      );
      expect(
        screen.getByText(translate(locale, "aiHelper.notice.adviceBody")),
      ).toBeVisible();
      unmount();
    }
  });
});

const BODY =
  "AI answers can be wrong. Each one says so. If you choose “Don't show this again” on an answer, later answers show a short “AI draft” label instead of the full sentence.";
const FULL_BACK = "The full warning is back on every AI answer.";
const SHORT_SHOWN =
  "A short “AI draft” tag is shown on the AI answers you chose it for.";

describe("Settings → AI helper: the warning on AI answers (#351)", () => {
  it("explains the warning in Ben's words only, and offers to bring the full one back once Don't show this again was chosen", async () => {
    setLocaleOverride("en");
    render(<AiSettings aiStatus={null} onAiStatus={vi.fn()} />);
    const heading = screen.getByRole("heading", {
      name: "Warning on AI answers",
    });
    // The section says this and nothing else about it: no word on the tag never being removed, on
    // where the choice is kept, or on the choice starting over (the code still does that).
    expect(screen.getByText(BODY)).toBeInTheDocument();
    expect(screen.queryByText(/never removed/)).toBeNull();
    expect(screen.queryByText(/starts over/)).toBeNull();
    expect(screen.queryByText(/kept on this device/)).toBeNull();
    // No status line while the full warning is shown, and no button to bring it back.
    expect(
      screen.queryByText("The full warning is shown on every AI answer."),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show the full warning again" }),
    ).toBeNull();
    // A choice made on an answer elsewhere shows up here at once.
    rememberShortAiLabel("summary", MODEL);
    const user = userEvent.setup();
    expect(await screen.findByText(SHORT_SHOWN)).toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", {
        name: "Show the full warning again",
      }),
    );
    expect(aiLabelIsShort("summary", MODEL)).toBe(false);
    expect(screen.queryByText(SHORT_SHOWN)).toBeNull();
    expect(screen.getByText(FULL_BACK)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show the full warning again" }),
    ).toBeNull();
    // The focus is on the row's heading, not lost to the page.
    expect(heading).toHaveFocus();
  });

  it("keeps one status element on the page, so that its words are read out when they come", async () => {
    setLocaleOverride("en");
    render(<AiSettings aiStatus={null} onAiStatus={vi.fn()} />);
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    // The same element says the words when a short label was chosen, and is empty again after.
    rememberShortAiLabel("summary", MODEL);
    expect(await screen.findByText(SHORT_SHOWN)).toBe(status);
    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "Show the full warning again" }),
      );
    expect(screen.getByRole("status")).toBe(status);
    // The restore is said once, in the same element, by a visually hidden sentence.
    const said = within(status).getByText(FULL_BACK);
    expect(said).toHaveClass("sr-only");
    // A short label chosen again takes the element back with its own words.
    rememberShortAiLabel("summary", MODEL);
    expect(await screen.findByText(SHORT_SHOWN)).toBe(status);
    expect(screen.queryByText(FULL_BACK)).toBeNull();
  });
});
