import { visibleText } from "../test/humanText";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockWarning } from "./LockWarning";

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
});
