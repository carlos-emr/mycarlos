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
      "moves the other dates back",
      "Nothing is saved until you choose to save it",
      "Removing details is never perfect",
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

  it("says what the AI on this device does where the model can run, and promises no kept answers until they are", () => {
    const { unmount } = render(
      <AiHelperNotice action="continue" onThisDevice onClose={vi.fn()} />,
    );
    const dialog = screen.getByRole("dialog", {
      name: humanText("About the AI helper"),
    });
    expect(dialog).toHaveTextContent(
      "The AI helper explains a document in plain words, here on this device",
    );
    expect(dialog).not.toHaveTextContent(
      "myCarlos can prepare a document's text for an AI service you choose.",
    );
    expect(
      screen.getByRole("heading", { name: humanText("The AI on this device") }),
    ).toBeVisible();
    expect(dialog).toHaveTextContent("checks it before every use");
    // Answers are not kept in the vault yet (#212): no promise that they are.
    expect(dialog).not.toHaveTextContent("saved in the vault, encrypted");
    // The rest of the notice is still there.
    expect(dialog).toHaveTextContent("Saving text for another AI service");
    expect(dialog).toHaveTextContent("Answers written by an AI can be wrong");
    unmount();

    render(
      <AiHelperNotice
        action="continue"
        onThisDevice
        answersKept
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("dialog", { name: humanText("About the AI helper") }),
    ).toHaveTextContent("saved in the vault, encrypted");
  });

  it("says nothing of an AI on this device where none can run", () => {
    render(<AiHelperNotice action="close" answersKept onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", {
      name: humanText("About the AI helper"),
    });
    expect(dialog).toHaveTextContent(
      "myCarlos can prepare a document's text for an AI service you choose.",
    );
    expect(
      screen.queryByRole("heading", {
        name: humanText("The AI on this device"),
      }),
    ).toBeNull();
    expect(dialog).not.toHaveTextContent("saved in the vault, encrypted");
  });

  it("closes from Security", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<AiHelperNotice action="close" onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: humanText("Close") }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
