import { visibleText } from "../test/humanText";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockWarning } from "./LockWarning";
import { setLocaleOverride, translate } from "../i18n";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const pass = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("the warning before the automatic lock counts down (#77)", () => {
  it("counts down on screen, but is said once, with the time it opened with", () => {
    render(<LockWarning seconds={30} onKeepOpen={vi.fn()} />);
    const dialog = screen.getByRole("alertdialog");
    const heading = screen.getByRole("heading");
    const shown = () =>
      visibleText(
        heading.querySelector("[aria-hidden='true']")!.textContent ?? "",
      );
    const name =
      "myCarlos will lock in 30 seconds to keep your records private.";
    expect(shown()).toBe(name);
    expect(dialog).toHaveHumanAccessibleName(name);
    pass(1000);
    expect(shown()).toBe(
      "myCarlos will lock in 29 seconds to keep your records private.",
    );
    // What a screen reader would say again: unchanged.
    expect(dialog).toHaveHumanAccessibleName(name);
    pass(28_000);
    expect(shown()).toBe(
      "myCarlos will lock in 1 second to keep your records private.",
    );
    expect(dialog).toHaveHumanAccessibleName(name);
  });

  it("says once, at 10 seconds, how little time is left", () => {
    render(<LockWarning seconds={30} onKeepOpen={vi.fn()} />);
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    pass(19_000);
    expect(status).toBeEmptyDOMElement();
    pass(1000);
    expect(status).toHaveHumanTextContent("10 seconds left.");
    // The same words from then on, so nothing is said again.
    pass(5000);
    expect(status).toHaveHumanTextContent("10 seconds left.");
  });

  it("preserves the countdown and focused action while translating the open warning", () => {
    setLocaleOverride("en");
    const keepOpen = vi.fn();
    render(<LockWarning seconds={30} onKeepOpen={keepOpen} />);
    const dialog = screen.getByRole("alertdialog");
    const heading = screen.getByRole("heading");
    const status = screen.getByRole("status");
    const button = screen.getByRole("button", { name: "Keep open" });
    const shown = () =>
      visibleText(
        heading.querySelector("[aria-hidden='true']")!.textContent ?? "",
      );
    expect(button).toHaveFocus();
    pass(19_000);
    act(() => setLocaleOverride("pl"));
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    expect(shown()).toBe(
      visibleText(translate("pl", "lockWarning.title", { count: 11 })),
    );
    // The accessible name keeps the opening count, in the current language;
    // translating must not restart the remaining-time counter or keep the vault open.
    expect(dialog).toHaveHumanAccessibleName(
      translate("pl", "lockWarning.title", { count: 30 }),
    );
    expect(status).toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: "Pozostaw otwarty" })).toBe(
      button,
    );
    expect(button).toHaveFocus();
    expect(keepOpen).not.toHaveBeenCalled();

    pass(1000);
    expect(status).toHaveHumanTextContent("Zostało 10 sekund.");
    act(() => setLocaleOverride("fr"));
    const lastCall = translate("fr", "lockWarning.left", { count: 10 });
    expect(status).toHaveHumanTextContent(lastCall);
    pass(5000);
    expect(shown()).toBe(
      visibleText(translate("fr", "lockWarning.title", { count: 5 })),
    );
    expect(status).toHaveHumanTextContent(lastCall);
    expect(dialog).toHaveHumanAccessibleName(
      translate("fr", "lockWarning.title", { count: 30 }),
    );
    expect(screen.getByRole("button", { name: "Garder ouvert" })).toBe(button);
    expect(button).toHaveFocus();
    expect(keepOpen).not.toHaveBeenCalled();
    pass(5000);
    expect(shown()).toBe(
      visibleText(translate("fr", "lockWarning.title", { count: 0 })),
    );
    expect(status).toBeEmptyDOMElement();
    fireEvent.click(button);
    expect(keepOpen).toHaveBeenCalledTimes(1);
  });
});
