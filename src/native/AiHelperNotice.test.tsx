import { humanText } from "../test/humanText";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AiHelperNotice } from "./AiHelperNotice";

// #72: the notice's ten messages (AI_HELPER_NOTICE.md, part A) are shown
// before the first export and from Security.
describe("the AI helper notice", () => {
  it("shows the share, preview, limits, file, service and advice text, and continues", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<AiHelperNotice action="continue" onClose={onClose} />);
    const dialog = screen.getByRole("dialog", {
      name: humanText("About the AI helper"),
    });
    for (const part of [
      "sends nothing over the internet",
      "synthetic (made-up) files only",
      "Saving text for another AI service",
      "The dates it recognizes are not sent",
      "Nothing is saved until you choose to save it",
      "Removing details is never perfect",
      "A year on its own, as in “Appendectomy 2019”, is not removed",
      "It is not encrypted, and myCarlos cannot erase it later",
      "it knows who you are, whatever was removed",
      "Answers written by an AI can be wrong",
    ])
      expect(dialog, part).toHaveTextContent(part);
    const button = screen.getByRole("button", { name: humanText("Continue") });
    expect(button).toHaveFocus();
    await user.click(button);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from Security", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<AiHelperNotice action="close" onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: humanText("Close") }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
