import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride } from "../i18n";
import { humanText, visibleText } from "../test/humanText";
import type { PortalLinkSummary, VaultBridge, VaultSnapshot } from "../vault";
import { PortalDocuments } from "./PortalDocuments";

// The notices step after the first clinic link (#235): the existing Notices
// setting in a dialog, offered once. FAKE data only.
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

type Status = {
  supported: boolean;
  available: boolean;
  enabled: boolean;
  permission: "unavailable" | "unknown" | "allowed" | "blocked";
  automaticChecksSupported: boolean;
  automaticChecksEnabled: boolean;
  automaticChecksPaused: boolean;
};
const offStatus: Status = {
  supported: true,
  available: true,
  enabled: false,
  permission: "allowed",
  automaticChecksSupported: true,
  automaticChecksEnabled: false,
  automaticChecksPaused: false,
};
let status: Status;

const link: PortalLinkSummary = {
  id: "fake-link",
  portalBase: "https://portal.example.test/patient",
  deviceName: "myCarlos on Windows",
  profileId: null,
  clinicName: "FAKE Clinic",
  fingerprints: [],
  incomplete: false,
  deviceKeyId: "FAKE-device-key",
  deviceFingerprint: "11".repeat(32),
  approvalRequested: false,
  clinicApproved: false,
};
const snapshot = (links: PortalLinkSummary[]): VaultSnapshot => ({
  capture: { epoch: "00000000-0000-4000-8000-000000000235", sequence: 1 },
  profiles: [
    { id: "fake-person", displayName: "FAKE Patient", createdAtMs: 1 },
  ],
  folders: [],
  records: [],
  recovery: null,
  portalLinkingEnabled: true,
  portalLinks: links,
});

beforeEach(() => {
  status = { ...offStatus };
  native.invoke.mockReset();
  native.invoke.mockImplementation(
    async (command: string, args?: { enabled?: boolean }) => {
      if (command === "vault_notification_status") return { ...status };
      if (command === "vault_set_notifications")
        status = {
          ...status,
          enabled: args?.enabled === true,
          automaticChecksEnabled:
            args?.enabled === true ? status.automaticChecksEnabled : false,
        };
      if (command === "vault_set_automatic_document_checks")
        status = { ...status, automaticChecksEnabled: args?.enabled === true };
      return { ...status };
    },
  );
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  setLocaleOverride("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLocaleOverride(null);
});

/** The link form over `before`; the link answers with `after` once made. */
function linkForm(
  before: PortalLinkSummary[],
  after: PortalLinkSummary[],
  linkPortal = vi.fn().mockResolvedValue(link),
) {
  const bridge = {
    platform: vi.fn().mockResolvedValue("windows"),
    linkPortal,
    checkDocuments: vi
      .fn()
      .mockResolvedValue({ added: 0, refused: 0, receiptsPending: 0 }),
    requestDeviceApproval: vi.fn().mockResolvedValue(undefined),
  } as unknown as VaultBridge;
  const run = async (operation: () => Promise<void>) => {
    await operation().catch(() => {});
  };
  render(
    <PortalDocuments
      bridge={bridge}
      snapshot={snapshot(before)}
      busy={false}
      readOnly={false}
      run={run}
      refresh={vi.fn().mockResolvedValue(snapshot(after))}
      setNotice={vi.fn()}
    />,
  );
  return bridge;
}

async function submitLink() {
  const user = userEvent.setup();
  await user.type(
    screen.getByLabelText(humanText("Portal HTTPS address")),
    "https://portal.example.test/patient",
  );
  await user.type(
    screen.getByLabelText(humanText("Linking code")),
    "FAKE-CODE",
  );
  await user.click(screen.getByRole("button", { name: /Link to clinic/ }));
  return user;
}

const settingCalls = () =>
  native.invoke.mock.calls.filter(([command]) =>
    String(command).startsWith("vault_set_"),
  );

describe("Notices after the first clinic link", () => {
  it("offers the existing Notices setting, unticked, in a dialog that takes the focus", async () => {
    linkForm([], [link]);
    await submitLink();
    const dialog = await screen.findByRole("dialog", {
      name: humanText("Notices from your clinic"),
    });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(dialog).toHaveAccessibleDescription(
      "Your clinic is linked. myCarlos can let you know when a new document arrives. Nothing is turned on unless you tick it.",
    );
    const notices = await screen.findByRole("checkbox", {
      name: humanText("Allow document arrival notices"),
    });
    const checks = screen.getByRole("checkbox", {
      name: humanText(
        "Check for clinic documents automatically while unlocked",
      ),
    });
    expect(notices).not.toBeChecked();
    expect(checks).not.toBeChecked();
    expect(visibleText(dialog.textContent ?? "")).toContain(
      "You can change these any time in Settings, under Preferences: Notices after document checks.",
    );
    expect(settingCalls()).toEqual([]);
  });

  it("each box changes the same setting as Preferences, and Done keeps it", async () => {
    linkForm([], [link]);
    const user = await submitLink();
    await user.click(
      await screen.findByRole("checkbox", {
        name: humanText("Allow document arrival notices"),
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", {
          name: humanText(
            "Check for clinic documents automatically while unlocked",
          ),
        }),
      ).toBeEnabled(),
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: humanText(
          "Check for clinic documents automatically while unlocked",
        ),
      }),
    );
    await waitFor(() =>
      expect(settingCalls()).toEqual([
        ["vault_set_notifications", { enabled: true }],
        ["vault_set_automatic_document_checks", { enabled: true }],
      ]),
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(status.enabled && status.automaticChecksEnabled).toBe(true);
  });

  it("Not now closes it and turns nothing on", async () => {
    linkForm([], [link]);
    const user = await submitLink();
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(settingCalls()).toEqual([]);
    expect(status.enabled).toBe(false);
  });

  it("Escape is Not now", async () => {
    linkForm([], [link]);
    const user = await submitLink();
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(settingCalls()).toEqual([]);
  });

  it("shows the blocked text when the operating system blocks notices", async () => {
    status = { ...offStatus, permission: "blocked", available: false };
    linkForm([], [link]);
    await submitLink();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Windows is blocking notifications. Review its notification settings.",
    );
  });

  it("is not offered where notices are unsupported", async () => {
    status = { ...offStatus, supported: false, permission: "unavailable" };
    linkForm([], [link]);
    await submitLink();
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("vault_notification_status", {
        locale: "en",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is not offered when both are already on", async () => {
    status = { ...offStatus, enabled: true, automaticChecksEnabled: true };
    linkForm([], [link]);
    await submitLink();
    await waitFor(() => expect(native.invoke).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is not offered for a second clinic, nor when the link fails", async () => {
    const second = { ...link, id: "fake-link-2", clinicName: "FAKE Clinic 2" };
    linkForm([link], [link, second]);
    await submitLink();
    expect(screen.queryByRole("dialog")).toBeNull();
    document.body.innerHTML = "";
    linkForm(
      [],
      [],
      vi.fn().mockRejectedValue({ code: "portal_link_code_rejected" }),
    );
    await submitLink();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(native.invoke).not.toHaveBeenCalledWith(
      "vault_notification_status",
      expect.anything(),
    );
  });
});
