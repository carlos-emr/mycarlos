import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
const snapshot = (links: PortalLinkSummary[] | undefined): VaultSnapshot => ({
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
  before: PortalLinkSummary[] | undefined,
  after: PortalLinkSummary[],
  // The clinic chain (#136): the form links and asks for approval in one call.
  connectPortal = vi.fn().mockResolvedValue({ link, approvalError: null }),
) {
  const bridge = {
    platform: vi.fn().mockResolvedValue("windows"),
    connectPortal,
    checkDocuments: vi
      .fn()
      .mockResolvedValue({ added: 0, refused: 0, receiptsPending: 0 }),
    requestDeviceApproval: vi.fn().mockResolvedValue(undefined),
  } as unknown as VaultBridge;
  const run = async (operation: () => Promise<void>) => {
    await operation().catch(() => {});
  };
  // As the app does: a refresh hands the panel the vault's new snapshot.
  const panel = (shown: VaultSnapshot) => (
    <PortalDocuments
      bridge={bridge}
      snapshot={shown}
      busy={false}
      readOnly={false}
      run={run}
      refresh={refresh}
      setNotice={vi.fn()}
    />
  );
  const refresh = vi.fn(async () => {
    view.rerender(panel(snapshot(after)));
    return snapshot(after);
  });
  const view = render(panel(snapshot(before)));
  return {
    bridge,
    show: (shown: VaultSnapshot) => view.rerender(panel(shown)),
  };
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
  await user.click(
    screen.getByRole("button", { name: "Connect and request approval" }),
  );
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

  it("keeps only Done once a box is saved, so nothing reads as undo", async () => {
    linkForm([], [link]);
    const user = await submitLink();
    const dialog = await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: "Not now" })).toBeVisible();
    await user.click(
      await screen.findByRole("checkbox", {
        name: humanText("Allow document arrival notices"),
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Not now" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Done" })).toBeVisible();
    expect(dialog).toBeVisible();
  });

  it("says why the automatic checks wait, and nests the setting's heading", async () => {
    linkForm([], [link]);
    const user = await submitLink();
    const dialog = await screen.findByRole("dialog");
    const checks = await screen.findByRole("checkbox", {
      name: humanText(
        "Check for clinic documents automatically while unlocked",
      ),
    });
    expect(checks).toBeDisabled();
    expect(checks).toHaveHumanAccessibleDescription(
      /Allow document arrival notices first to turn this on\./,
    );
    expect(
      screen.getByRole("heading", {
        level: 3,
        name: humanText("Notices after document checks"),
      }),
    ).toBeVisible();
    expect(dialog).toContainElement(
      screen.getByRole("heading", {
        level: 2,
        name: humanText("Notices from your clinic"),
      }),
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: humanText("Allow document arrival notices"),
      }),
    );
    await waitFor(() => expect(checks).toBeEnabled());
    expect(dialog).not.toHaveTextContent(
      "Allow document arrival notices first to turn this on.",
    );
  });

  it("is offered whichever action made the first link, but not for an unfinished link or at unlock", async () => {
    const view = linkForm([], []);
    // An unfinished link is not a working one.
    view.show(snapshot([{ ...link, incomplete: true }]));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Another action (not this form) made the first working link.
    view.show(snapshot([link]));
    expect(
      await screen.findByRole("dialog", {
        name: humanText("Notices from your clinic"),
      }),
    ).toBeVisible();
    cleanup();
    native.invoke.mockClear();
    // At unlock the links may not be known at first: an already linked vault
    // is not newly linked.
    const unlocked = linkForm(undefined, []);
    unlocked.show(snapshot([link]));
    await waitFor(() => expect(native.invoke).not.toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sends the focus to the new clinic's heading on closing, where the panel has one", async () => {
    linkForm([], [link]);
    const user = await submitLink();
    await screen.findByRole("dialog");
    // The clinic chain's panel gives each linked clinic a focusable heading.
    const heading = await screen.findByRole("heading", {
      name: "FAKE Clinic",
      level: 3,
    });
    expect(heading.id).toBe(`portal-link-title-${link.id}`);
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(document.activeElement).toBe(heading));
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
