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
  noticesSupported: true,
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
  it("shows a test notice only while notices are allowed, and says what came of it", async () => {
    const user = userEvent.setup();
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "vault_send_test_notice") return "shown";
      return { ...allowed, enabled: true };
    });
    render(<NotificationSetting />);
    const button = await screen.findByRole("button", {
      name: humanText("Show a test notice"),
    });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(
      await screen.findByText(humanText(/Test notice sent/)),
    ).toBeVisible();
    // No arguments: nothing of the vault, a document or a clinic goes with it.
    expect(native.invoke).toHaveBeenCalledWith("vault_send_test_notice");
  });

  it("keeps the test button off until notices are allowed", async () => {
    native.invoke.mockResolvedValue({ ...allowed, enabled: false });
    render(<NotificationSetting />);
    expect(
      await screen.findByRole("button", {
        name: humanText("Show a test notice"),
      }),
    ).toBeDisabled();
    expect(native.invoke).not.toHaveBeenCalledWith("vault_send_test_notice");
  });

  it("shows the Windows-is-blocking line when the system refuses the test notice", async () => {
    const user = userEvent.setup();
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "vault_send_test_notice") return "blocked";
      return { ...allowed, enabled: true };
    });
    render(<NotificationSetting />);
    expect(
      screen.queryByText(humanText(/Windows is blocking notifications/)),
    ).toBeNull();
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Show a test notice"),
      }),
    );
    expect(
      await screen.findByText(humanText(/Windows is blocking notifications/)),
    ).toBeVisible();
  });

  it("tells a quick second press to wait, and a failure that it could not be shown", async () => {
    const user = userEvent.setup();
    let next = "tooSoon";
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "vault_send_test_notice") return next;
      return { ...allowed, enabled: true };
    });
    render(<NotificationSetting />);
    const press = async () =>
      user.click(
        await screen.findByRole("button", {
          name: humanText("Show a test notice"),
        }),
      );
    await press();
    expect(
      await screen.findByText(humanText("Wait a few seconds, then try again.")),
    ).toBeVisible();
    next = "failed";
    await press();
    expect(
      await screen.findByText(humanText("The test notice could not be shown.")),
    ).toBeVisible();
    // A command that throws is a failure too, not a silence.
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "vault_send_test_notice") throw new Error("FAKE");
      return { ...allowed, enabled: true };
    });
    await press();
    expect(
      await screen.findByText(humanText("The test notice could not be shown.")),
    ).toBeVisible();
  });

  it("says notices are off in myCarlos, not that the test failed, when native will not show one", async () => {
    const user = userEvent.setup();
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "vault_send_test_notice") return "notAllowed";
      return { ...allowed, enabled: true };
    });
    render(<NotificationSetting />);
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Show a test notice"),
      }),
    );
    expect(
      await screen.findByText(
        humanText(
          "Notices are turned off in myCarlos. Turn them on, then try again.",
        ),
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(humanText("The test notice could not be shown.")),
    ).toBeNull();
  });

  it("keeps the key fact in view and folds the long explanation under More about automatic checks", async () => {
    native.invoke.mockResolvedValue({
      ...allowed,
      automaticChecksSupported: true,
      automaticChecksEnabled: false,
      automaticChecksPaused: false,
    });
    const user = userEvent.setup();
    render(<NotificationSetting />);
    await screen.findByRole("checkbox", {
      name: humanText("Show a notice when a document arrives"),
    });
    // In view: the notice is generic, and documents are collected only while open and unlocked; locked, it only says something is waiting.
    expect(
      screen.getByText(
        humanText(/Windows can show a generic notice after a clinic document/),
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        humanText(
          "myCarlos collects new clinic documents on its own only while it is open and unlocked. While it is locked in the background, it can only tell you that something is waiting.",
        ),
      ),
    ).toBeVisible();
    const long = screen.getByText(
      humanText(/with at least two minutes between attempts/),
    );
    const more = screen.getByText(humanText("More about automatic checks"));
    const details = more.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(long).not.toBeVisible();
    // The keys themselves are the browser's own and are driven in tests/preferences-text.spec.ts.
    await user.click(more);
    expect(details.open).toBe(true);
    expect(long).toBeVisible();
    expect(screen.queryByText(humanText("Less"))).toBeNull();
    // The box is described by the long text alone (the summary is read in place, not twice).
    const box = screen.getByRole("checkbox", {
      name: humanText(
        "Check for clinic documents automatically while unlocked",
      ),
    });
    const description = (box.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(humanText(/at least two minutes/)(description)).toBe(true);
    expect(humanText(/open and unlocked\.$/)(description)).toBe(false);
  });

  it("has no More about automatic checks where the automatic checks are not offered", async () => {
    native.invoke.mockResolvedValue({ ...allowed });
    render(<NotificationSetting />);
    await screen.findByRole("checkbox", {
      name: humanText("Show a notice when a document arrives"),
    });
    expect(
      screen.queryByText(humanText("More about automatic checks")),
    ).toBeNull();
  });

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
      name: humanText("Show a notice when a document arrives"),
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
      name: humanText("Show a notice when a document arrives"),
    });
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveHumanAccessibleDescription(
      /Windows is blocking notifications/,
    );
    expect(checkbox).toHaveHumanAccessibleDescription(
      /Windows can show a generic notice/,
    );
  });

  it("reads why the automatic-check box is disabled with it, and the short line above it too (review of #489, agent 1)", async () => {
    native.invoke.mockResolvedValue({
      ...allowed,
      available: false,
      automaticChecksSupported: true,
      automaticChecksEnabled: false,
    });
    render(<NotificationSetting />);
    const automatic = await screen.findByRole("checkbox", {
      name: humanText(
        "Check for clinic documents automatically while unlocked",
      ),
    });
    expect(automatic).toBeDisabled();
    // The reason it is disabled, and the line that says what the box does, both read with it.
    expect(automatic).toHaveHumanAccessibleDescription(
      /These settings are unavailable right now/,
    );
    expect(automatic).toHaveHumanAccessibleDescription(
      /can check for new clinic documents by itself/,
    );
    // The notice box is disabled for the same reason and says so too.
    expect(
      screen.getByRole("checkbox", {
        name: humanText("Show a notice when a document arrives"),
      }),
    ).toHaveHumanAccessibleDescription(
      /These settings are unavailable right now/,
    );
  });

  it("says Windows has no setting for it yet without blocking the box", async () => {
    native.invoke.mockResolvedValue({
      ...allowed,
      permission: "not_yet_asked",
    });
    render(<NotificationSetting />);
    const checkbox = await screen.findByRole("checkbox", {
      name: humanText("Show a notice when a document arrives"),
    });
    // Nothing was refused: the notices can be turned on, and the first one shown makes the setting.
    expect(checkbox).toBeEnabled();
    expect(
      screen.getByText(
        humanText(/Windows has not shown a myCarlos notice yet/),
      ),
    ).toBeVisible();
    expect(checkbox).toHaveHumanAccessibleDescription(
      /Notices are allowed until you turn them off in Windows settings/,
    );
    expect(
      screen.queryByText(humanText(/could not be checked/)),
    ).not.toBeInTheDocument();
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
      name: humanText("Show a notice when a document arrives"),
    });
    expect(checkbox).not.toBeChecked();
    expect(
      native.invoke.mock.calls.every(
        ([command]) => command === "vault_notification_status",
      ),
    ).toBe(true);
    expect(checkbox).toHaveHumanAccessibleDescription(
      /Windows can show a generic notice/,
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
      name: humanText("Show a notice when a document arrives"),
    });
    await user.click(checkbox);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveHumanTextContent(
        "Notices and automatic checks are off for this session.",
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
      name: humanText("Afficher un avis lorsqu’un document arrive"),
    });
    expect(checkbox).toHaveHumanAccessibleDescription(
      /Windows peut afficher un avis générique/,
    );
    expect(checkbox).not.toBeChecked();
    expect(
      (checkbox.closest("label") as HTMLElement).getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(44);
  });
  it("offers the automatic check on its own, with its consent line, whatever the notices are", async () => {
    const user = userEvent.setup();
    let enabled = false;
    let automaticChecksEnabled = false;
    native.invoke.mockImplementation(
      (command: string, request?: { enabled: boolean }) => {
        if (command === "vault_set_notifications") enabled = request!.enabled;
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
    const notice = await screen.findByRole("checkbox", {
      name: humanText("Show a notice when a document arrives"),
    });
    const automatic = screen.getByRole("checkbox", {
      name: humanText(
        "Check for clinic documents automatically while unlocked",
      ),
    });
    // Off until a person turns it on, and it does not wait for the notices.
    expect(automatic).not.toBeChecked();
    expect(automatic).toBeEnabled();
    // Its own short consent: it contacts the clinic's portal on a schedule.
    expect(automatic).toHaveHumanAccessibleDescription(
      /contact your clinic's portal on a schedule, at least two minutes apart/,
    );
    expect(automatic).toHaveHumanAccessibleDescription(
      /at least two minutes between attempts/,
    );
    expect(automatic).toHaveHumanAccessibleDescription(
      /Notices are a separate choice and are not needed for this/,
    );
    expect(
      native.invoke.mock.calls.every(
        ([command]) => command === "vault_notification_status",
      ),
    ).toBe(true);
    await user.click(automatic);
    await waitFor(() => expect(automatic).toBeChecked());
    expect(native.invoke).toHaveBeenCalledWith(
      "vault_set_automatic_document_checks",
      { enabled: true },
    );
    // The notices stay off, and turning them on and off leaves the automatic check as it was.
    expect(notice).not.toBeChecked();
    await user.click(notice);
    await waitFor(() => expect(notice).toBeChecked());
    expect(automatic).toBeChecked();
    await user.click(notice);
    await waitFor(() => expect(notice).not.toBeChecked());
    expect(automatic).toBeChecked();
    expect(automatic).toBeEnabled();
    // And turning the automatic check off leaves the notice choice as it was.
    await user.click(notice);
    await waitFor(() => expect(notice).toBeChecked());
    await user.click(automatic);
    await waitFor(() => expect(automatic).not.toBeChecked());
    expect(notice).toBeChecked();
  });

  it("offers only the automatic check where this computer cannot show a notice", async () => {
    native.invoke.mockResolvedValue({
      ...allowed,
      noticesSupported: false,
      permission: "unavailable",
      automaticChecksSupported: true,
      automaticChecksEnabled: false,
    });
    render(<NotificationSetting />);
    const automatic = await screen.findByRole("checkbox", {
      name: humanText(
        "Check for clinic documents automatically while unlocked",
      ),
    });
    expect(automatic).toBeEnabled();
    // No notice switch, no test button, nothing about Windows.
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: humanText("Show a test notice") }),
    ).toBeNull();
    expect(
      screen.queryByText(humanText(/Windows can show a generic notice/)),
    ).toBeNull();
    expect(
      screen.getByText(humanText(/contact your clinic's portal on a schedule/)),
    ).toBeVisible();
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
