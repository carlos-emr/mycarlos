import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride } from "../i18n";
import { humanText } from "../test/humanText";
import type { ModelStatus } from "../ai/types";
import { AiSpeedCheck } from "./AiSpeedCheck";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

// FAKE model and numbers only.
const installed: ModelStatus = {
  state: "installed",
  model: { name: "FAKE model", sha256: "ab".repeat(32) },
  capacity: { contextTokens: 8192, documentTokens: 6510 },
};
const MEASURED = { promptMilliTps: 10_000, answerMilliTps: 2_500 };

beforeEach(() => {
  native.invoke.mockReset();
  act(() => setLocaleOverride("en"));
});
afterEach(() => act(() => setLocaleOverride(null)));

const answers = (map: Record<string, () => Promise<unknown>>) =>
  native.invoke.mockImplementation((command: string) =>
    (map[command] ?? (() => Promise.resolve(undefined)))(),
  );

describe("the speed check in the AI helper settings (#305)", () => {
  it("shows nothing without a model on this computer", () => {
    answers({});
    const { container } = render(
      <AiSpeedCheck status={{ state: "notInstalled" }} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("says what it does and that it uses the processor, and runs nothing until asked", async () => {
    answers({ ai_model_speed: async () => null });
    render(<AiSpeedCheck status={installed} />);
    expect(
      await screen.findByText(
        /uses the processor hard for about a minute or two\. It sends nothing anywhere/,
      ),
    ).toBeVisible();
    expect(screen.getByText("Not checked yet.")).toBeVisible();
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).not.toHaveBeenCalledWith(
      "ai_speed_check",
      expect.anything(),
    );
    // The button is described by that note, for a screen reader.
    expect(
      screen.getByRole("button", { name: "Check this computer's speed" }),
    ).toHaveAccessibleDescription(/uses the processor hard/);
  });

  it("runs the check on a click, can be stopped, and says the result in words a second", async () => {
    let finish: (value: unknown) => void = () => {};
    answers({
      ai_model_speed: async () => null,
      ai_speed_check: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const user = userEvent.setup();
    render(<AiSpeedCheck status={installed} />);
    await user.click(
      await screen.findByRole("button", {
        name: "Check this computer's speed",
      }),
    );
    expect(native.invoke).toHaveBeenCalledWith("ai_speed_check", {
      answerId: expect.any(String),
    });
    // While it runs: said in a status, the start is off, Stop is there and stops it.
    expect(screen.getByRole("status")).toHaveTextContent("Checking the speed…");
    expect(
      screen.getByRole("button", { name: "Check this computer's speed" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Stop the check" }));
    expect(native.invoke).toHaveBeenCalledWith("ai_cancel");
    await act(async () => finish(MEASURED));
    expect(await screen.findByRole("status")).toHaveHumanTextContent(
      "Measured on this computer: the AI helper reads about 7.5 words a second and writes about 1.9.",
    );
  });

  it("stops a running check when Settings is left", async () => {
    answers({
      ai_model_speed: async () => null,
      ai_speed_check: () => new Promise(() => undefined),
    });
    const user = userEvent.setup();
    const { unmount } = render(<AiSpeedCheck status={installed} />);
    await user.click(
      await screen.findByRole("button", {
        name: "Check this computer's speed",
      }),
    );
    expect(native.invoke).not.toHaveBeenCalledWith("ai_cancel");
    unmount();
    expect(native.invoke).toHaveBeenCalledWith("ai_cancel");
  });

  it("does not cancel anything when nothing is running as Settings is left", async () => {
    answers({ ai_model_speed: async () => null });
    const { unmount } = render(<AiSpeedCheck status={installed} />);
    await screen.findByText("Not checked yet.");
    unmount();
    expect(native.invoke).not.toHaveBeenCalledWith("ai_cancel");
  });

  it("says a stopped check kept nothing, and a failed one could not measure", async () => {
    const user = userEvent.setup();
    answers({
      ai_model_speed: async () => null,
      ai_speed_check: () => Promise.reject({ code: "aiCancelled" }),
    });
    render(<AiSpeedCheck status={installed} />);
    await user.click(
      await screen.findByRole("button", {
        name: "Check this computer's speed",
      }),
    );
    expect(
      await screen.findByText("The check was stopped. Nothing was kept."),
    ).toBeVisible();
    // A measurement the native side could not make is an alert in words, not a blank.
    answers({
      ai_model_speed: async () => null,
      ai_speed_check: async () => ({ promptMilliTps: 1, answerMilliTps: 1 }),
    });
    await user.click(
      screen.getByRole("button", { name: "Check this computer's speed" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The speed could not be measured. Try again.",
    );
  });

  it("shows a result kept from before, and ignores numbers that are not rates", async () => {
    answers({ ai_model_speed: async () => MEASURED });
    const { unmount } = render(<AiSpeedCheck status={installed} />);
    expect(await screen.findByRole("status")).toHaveHumanTextContent(
      "reads about 7.5 words a second and writes about 1.9",
    );
    unmount();
    answers({
      ai_model_speed: async () => ({
        promptMilliTps: "fast",
        answerMilliTps: 1,
      }),
    });
    render(<AiSpeedCheck status={installed} />);
    await waitFor(() =>
      expect(screen.getByText("Not checked yet.")).toBeVisible(),
    );
  });

  it("says the result in the language chosen afterwards", async () => {
    answers({ ai_model_speed: async () => MEASURED });
    render(<AiSpeedCheck status={installed} />);
    await screen.findByRole("status");
    act(() => setLocaleOverride("fr"));
    expect(screen.getByRole("status")).toHaveHumanTextContent(
      "l’assistant IA lit environ 7,5 mots par seconde et en écrit environ 1,9",
    );
    expect(humanText("x")).toBeDefined();
  });
});
