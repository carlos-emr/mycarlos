import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translate } from "../i18n";
import { visibleText } from "../test/humanText";
import { VideoHelp } from "./VideoHelp";

describe("Why video recording is not offered on this device (#359)", () => {
  afterEach(cleanup);

  it("explains the engine, the systems and what still works, under one heading", () => {
    render(<VideoHelp onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");

    expect(
      screen.getByRole("heading", {
        name: (name) =>
          visibleText(name) ===
          visibleText(translate("en", "interface.VideoHelp.title")),
      }),
    ).toBeVisible();
    for (const key of [
      "interface.VideoHelp.engine",
      "interface.VideoHelp.systems",
      "interface.VideoHelp.restWorks",
    ] as const) {
      expect(visibleText(dialog.textContent ?? "")).toContain(
        visibleText(translate("en", key)),
      );
    }
  });

  it("closes with its button, with Escape and by clicking outside, but not by clicking inside", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<VideoHelp onClose={onClose} />);

    await user.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", {
        name: (name) =>
          visibleText(name) === visibleText(translate("en", "photo.close")),
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);

    // The dim backdrop around the dialog: a press on it closes the help.
    const backdrop = screen.getByRole("dialog").parentElement;
    expect(backdrop).not.toBeNull();
    await user.pointer({
      keys: "[MouseLeft]",
      target: backdrop as HTMLElement,
    });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
