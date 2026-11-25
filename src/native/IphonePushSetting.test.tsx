import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride } from "../i18n";
import { humanText } from "../test/humanText";
import { IphonePushSetting, type IphonePushStatus } from "./IphonePushSetting";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

const off: IphonePushStatus = { supported: true, enabled: false, state: "ok" };

beforeEach(() => {
  native.invoke.mockReset();
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  setLocaleOverride("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLocaleOverride(null);
});

const box = () =>
  screen.findByRole("checkbox", {
    name: humanText("Show notices when myCarlos is closed (iPhone)"),
  });

describe("Notices when myCarlos is closed (iPhone)", () => {
  it("shows nothing where this is not an iPhone", async () => {
    native.invoke.mockResolvedValue({ ...off, supported: false });
    const { container } = render(<IphonePushSetting />);
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("vault_iphone_push_status"),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing where native has no such command", async () => {
    native.invoke.mockRejectedValue(new Error("command not found"));
    const { container } = render(<IphonePushSetting />);
    await waitFor(() => expect(native.invoke).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("is off until the patient turns it on, and says what Apple sees", async () => {
    native.invoke.mockResolvedValue(off);
    render(<IphonePushSetting />);
    const checkbox = await box();
    expect(checkbox).not.toBeChecked();
    expect(
      screen.getByText(
        humanText(/Apple sees when a push is sent, never what is in it/),
      ),
    ).toBeVisible();
    // The sentence is read with the box.
    expect(checkbox).toHaveHumanAccessibleDescription(
      /Apple sees when a push is sent, never what is in it/,
    );
    // Reading the status is all that happened: nothing was turned on, so nothing was asked of the system.
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith("vault_iphone_push_status");
  });

  it("turns on with one command carrying only the choice, and off the same way", async () => {
    const user = userEvent.setup();
    native.invoke.mockImplementation(async (command: string, args?: object) => {
      if (command === "vault_iphone_push_set")
        return { ...off, enabled: (args as { enabled: boolean }).enabled };
      return off;
    });
    render(<IphonePushSetting />);
    const checkbox = await box();
    await user.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(native.invoke).toHaveBeenCalledWith("vault_iphone_push_set", {
      enabled: true,
    });
    await user.click(checkbox);
    await waitFor(() => expect(checkbox).not.toBeChecked());
    expect(native.invoke).toHaveBeenLastCalledWith("vault_iphone_push_set", {
      enabled: false,
    });
  });

  it.each([
    ["refused", /You did not allow notices when the iPhone asked/],
    ["iosOff", /turned off for myCarlos in your iPhone.s Settings/],
    ["unavailable", /could not be reached from this iPhone/],
    ["timedOut", /Apple did not answer in time/],
    ["needsAttention", /could not be set up with your clinic/],
  ] as const)(
    "says honestly why the notices are not coming (%s), apart from the others",
    async (state, words) => {
      native.invoke.mockResolvedValue({
        supported: true,
        enabled: true,
        state,
      });
      render(<IphonePushSetting />);
      const checkbox = await box();
      const line = await screen.findByText(humanText(words));
      expect(line).toBeVisible();
      // The reason is read with the box, and the refusal ones say where to allow notices.
      expect(checkbox).toHaveHumanAccessibleDescription(words);
      if (state === "refused" || state === "iosOff")
        expect(line.textContent).toMatch(/Settings.*Notifications.*myCarlos/);
    },
  );

  it("says nothing about a problem while the setting is off", async () => {
    native.invoke.mockResolvedValue({
      supported: true,
      enabled: false,
      state: "refused",
    });
    render(<IphonePushSetting />);
    await box();
    expect(
      screen.queryByText(humanText(/did not allow notices/)),
    ).not.toBeInTheDocument();
  });

  it("says when the choice could not be saved, and keeps the box as it was", async () => {
    const user = userEvent.setup();
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "vault_iphone_push_set") throw new Error("refused");
      return off;
    });
    render(<IphonePushSetting />);
    const checkbox = await box();
    await user.click(checkbox);
    expect(
      await screen.findByText(
        humanText("The setting could not be saved. Try again."),
      ),
    ).toBeVisible();
    expect(checkbox).not.toBeChecked();
  });

  it("reads the status again when the patient comes back from the iPhone's Settings", async () => {
    native.invoke.mockResolvedValueOnce({
      supported: true,
      enabled: true,
      state: "iosOff",
    });
    render(<IphonePushSetting />);
    await screen.findByText(humanText(/turned off for myCarlos/));
    native.invoke.mockResolvedValue({
      supported: true,
      enabled: true,
      state: "ok",
    });
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(
        screen.queryByText(humanText(/turned off for myCarlos/)),
      ).not.toBeInTheDocument(),
    );
  });

  it("a return from the iPhone's permission question does not make the change's own answer stale, and the status is read once after", async () => {
    const user = userEvent.setup();
    let finish: (value: IphonePushStatus) => void = () => {};
    let statusReads = 0;
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "vault_iphone_push_set")
        return new Promise<IphonePushStatus>((resolve) => {
          finish = resolve;
        });
      statusReads += 1;
      return statusReads === 1
        ? off
        : ({ supported: true, enabled: true, state: "refused" } as const);
    });
    render(<IphonePushSetting />);
    const checkbox = await box();
    expect(statusReads).toBe(1);
    await user.click(checkbox);
    // The system's question took the app out of the foreground and back: focus fires meanwhile.
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    expect(statusReads).toBe(1);
    expect(checkbox).toBeDisabled();
    finish({ supported: true, enabled: true, state: "refused" });
    // The answer to the change is shown (not discarded), then the status is read once.
    expect(
      await screen.findByText(humanText(/You did not allow notices/)),
    ).toBeVisible();
    await waitFor(() => expect(statusReads).toBe(2));
    expect(checkbox).toBeEnabled();
  });

  it("has no accessibility violations, with and without a reason", async () => {
    native.invoke.mockResolvedValue({
      supported: true,
      enabled: true,
      state: "refused",
    });
    const { container } = render(<IphonePushSetting />);
    await box();
    const result = await axe.run(container);
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });
});
