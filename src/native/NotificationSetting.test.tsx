import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride } from "../i18n";
import { humanText } from "../test/humanText";
import { NotificationSetting } from "./NotificationSetting";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

const allowed = {
  supported: true,
  available: true,
  enabled: false,
  permission: "allowed",
};
beforeEach(() => {
  native.invoke.mockReset();
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  setLocaleOverride("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLocaleOverride(null);
});

describe("Document notice preference", () => {
  it("hides unsupported native capability without opting in or sending a notice", async () => {
    native.invoke.mockResolvedValue({
      ...allowed,
      supported: false,
      permission: "unavailable",
    });
    render(<NotificationSetting />);
    await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(native.invoke).toHaveBeenCalledWith("vault_notification_status", {
      locale: "en",
    });
  });

  it("reports the current language with each status request so a notice can use it", async () => {
    native.invoke.mockResolvedValue({ ...allowed });
    render(<NotificationSetting />);
    await screen.findByRole("checkbox", {
      name: humanText("Allow document arrival notices"),
    });
    expect(native.invoke).toHaveBeenLastCalledWith(
      "vault_notification_status",
      {
        locale: "en",
      },
    );
    act(() => setLocaleOverride("fr"));
    await waitFor(() =>
      expect(native.invoke).toHaveBeenLastCalledWith(
        "vault_notification_status",
        { locale: "fr" },
      ),
    );
    expect(
      native.invoke.mock.calls.every(
        ([command]) => command === "vault_notification_status",
      ),
    ).toBe(true);
  });

  it("reads the permission line with the box it disables", async () => {
    native.invoke.mockResolvedValue({
      ...allowed,
      available: false,
      permission: "blocked",
    });
    render(<NotificationSetting />);
    const checkbox = await screen.findByRole("checkbox", {
      name: humanText("Allow document arrival notices"),
    });
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveHumanAccessibleDescription(
      /Windows is blocking notifications/,
    );
    expect(checkbox).toHaveHumanAccessibleDescription(
      /Documents are not checked automatically/,
    );
  });

  it("keeps consent off until a person acts and bounds the native call to one boolean", async () => {
    const user = userEvent.setup();
    let enabled = false;
    native.invoke.mockImplementation(
      (command: string, request?: { enabled: boolean }) => {
        if (command === "vault_set_notifications") enabled = request!.enabled;
        return Promise.resolve({ ...allowed, enabled });
      },
    );
    render(<NotificationSetting />);
    const checkbox = await screen.findByRole("checkbox", {
      name: humanText("Allow document arrival notices"),
    });
    expect(checkbox).not.toBeChecked();
    expect(
      native.invoke.mock.calls.every(
        ([command]) => command === "vault_notification_status",
      ),
    ).toBe(true);
    expect(checkbox).toHaveHumanAccessibleDescription(
      /Documents are not checked automatically/,
    );
    await user.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(native.invoke).toHaveBeenCalledWith("vault_set_notifications", {
      enabled: true,
    });
    expect(
      native.invoke.mock.calls.every(([command]) =>
        ["vault_notification_status", "vault_set_notifications"].includes(
          command,
        ),
      ),
    ).toBe(true);
  });

  it("refreshes blocked or unknown permission on focus without inventing a grant", async () => {
    let permission = "blocked";
    native.invoke.mockImplementation(() =>
      Promise.resolve({ ...allowed, permission }),
    );
    const view = render(<NotificationSetting />);
    await screen.findByText(
      humanText(
        "Windows is blocking notifications. Review its notification settings.",
      ),
    );
    permission = "unknown";
    act(() => window.dispatchEvent(new Event("focus")));
    await screen.findByText(
      humanText("Windows notification permission could not be checked."),
    );
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    view.unmount();
    const calls = native.invoke.mock.calls.length;
    act(() => window.dispatchEvent(new Event("focus")));
    await Promise.resolve();
    expect(native.invoke).toHaveBeenCalledTimes(calls);
  });

  it("reports an unsaved preference without showing a raw native error or a successful opt-in", async () => {
    const user = userEvent.setup();
    native.invoke.mockImplementation((command: string) =>
      command === "vault_set_notifications"
        ? Promise.reject(new Error("FAKE_TOKEN_MUST_NOT_REACH_SCREEN"))
        : Promise.resolve(allowed),
    );
    render(<NotificationSetting />);
    const checkbox = await screen.findByRole("checkbox", {
      name: humanText("Allow document arrival notices"),
    });
    await user.click(checkbox);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveHumanTextContent(
        "Notices are off for this session.",
      ),
    );
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeDisabled();
    expect(document.body.textContent).not.toContain(
      "FAKE_TOKEN_MUST_NOT_REACH_SCREEN",
    );
  });

  it("keeps French consent and manual-check limits accessible", async () => {
    setLocaleOverride("fr");
    native.invoke.mockResolvedValue(allowed);
    render(<NotificationSetting />);
    const checkbox = await screen.findByRole("checkbox", {
      name: humanText("Autoriser les avis d’arrivée de documents"),
    });
    expect(checkbox).toHaveHumanAccessibleDescription(
      /Les documents ne sont pas vérifiés automatiquement/,
    );
    expect(checkbox).not.toBeChecked();
    expect(
      (checkbox.closest("label") as HTMLElement).getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(44);
  });
  it("requires a separate fresh automatic opt-in and discloses blocked-notice collection", async () => {
    const user = userEvent.setup();
    let enabled = false;
    let automaticChecksEnabled = false;
    native.invoke.mockImplementation(
      (command: string, request?: { enabled: boolean }) => {
        if (command === "vault_set_notifications") {
          enabled = request!.enabled;
          if (!enabled) automaticChecksEnabled = false;
        }
        if (command === "vault_set_automatic_document_checks")
          automaticChecksEnabled = request!.enabled;
        return Promise.resolve({
          ...allowed,
          enabled,
          automaticChecksEnabled,
          automaticChecksSupported: true,
          permission: "blocked",
        });
      },
    );
    render(<NotificationSetting />);
    const manual = await screen.findByRole("checkbox", {
      name: humanText("Allow document arrival notices"),
    });
    const automatic = screen.getByRole("checkbox", {
      name: humanText(
        "Check for clinic documents automatically while unlocked",
      ),
    });
    expect(automatic).not.toBeChecked();
    expect(automatic).toBeDisabled();
    expect(automatic).toHaveHumanAccessibleDescription(
      /Checks can continue if Windows blocks notices/,
    );
    expect(automatic).toHaveHumanAccessibleDescription(
      /at least two minutes between attempts/,
    );
    expect(
      native.invoke.mock.calls.every(
        ([command]) => command === "vault_notification_status",
      ),
    ).toBe(true);
    await user.click(manual);
    await waitFor(() => expect(automatic).toBeEnabled());
    expect(automatic).not.toBeChecked();
    await user.click(automatic);
    await waitFor(() => expect(automatic).toBeChecked());
    expect(native.invoke).toHaveBeenCalledWith(
      "vault_set_automatic_document_checks",
      { enabled: true },
    );
    await user.click(manual);
    await waitFor(() => expect(automatic).not.toBeChecked());
    expect(automatic).toBeDisabled();
  });
  it("shows a fixed manual-check pause without sending a check or exposing native details", async () => {
    native.invoke.mockResolvedValue({
      ...allowed,
      enabled: true,
      automaticChecksSupported: true,
      automaticChecksEnabled: true,
      automaticChecksPaused: true,
    });
    render(<NotificationSetting />);
    await screen.findByRole("status");
    expect(screen.getByRole("status")).toHaveHumanTextContent(
      "Automatic checks need a manual check to continue.",
    );
    expect(
      native.invoke.mock.calls.every(
        ([command]) => command === "vault_notification_status",
      ),
    ).toBe(true);
  });
  it("allows explicit automatic opt-out even when the native ledger is at capacity", async () => {
    const user = userEvent.setup();
    let automaticChecksEnabled = true;
    native.invoke.mockImplementation(
      (command: string, request?: { enabled: boolean }) => {
        if (command === "vault_set_automatic_document_checks")
          automaticChecksEnabled = request!.enabled;
        return Promise.resolve({
          ...allowed,
          enabled: true,
          available: false,
          automaticChecksSupported: true,
          automaticChecksEnabled,
        });
      },
    );
    render(<NotificationSetting />);
    const automatic = await screen.findByRole("checkbox", {
      name: humanText(
        "Check for clinic documents automatically while unlocked",
      ),
    });
    expect(automatic).toBeChecked();
    expect(automatic).toBeEnabled();
    await user.click(automatic);
    await waitFor(() => expect(automatic).not.toBeChecked());
    expect(native.invoke).toHaveBeenCalledWith(
      "vault_set_automatic_document_checks",
      { enabled: false },
    );
    expect(automatic).toBeDisabled();
  });
});
