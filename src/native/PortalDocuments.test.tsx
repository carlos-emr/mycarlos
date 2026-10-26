import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { PortalDocuments } from "./PortalDocuments";
import type { VaultBridge, VaultSnapshot, PortalLinkSummary } from "../vault";
import { LOCALES, setLocaleOverride, translate } from "../i18n";

const deviceCode = "Ebz2sH2jVoqcdFhl1BmIOBRm1xuT-zW5bvFBcCeERPY";
const fingerprint = "11".repeat(32);
const link: PortalLinkSummary = {
  id: "fake-link",
  portalBase: "https://portal.example.test/patient",
  deviceName: "myCarlos on Windows",
  profileId: null,
  clinicName: "FAKE Clinic",
  fingerprints: [],
  incomplete: false,
  deviceKeyId: deviceCode,
  deviceFingerprint: fingerprint,
  approvalRequested: true,
  clinicApproved: false,
};
const snapshot: VaultSnapshot = {
  profiles: [
    { id: "fake-person", displayName: "FAKE Patient", createdAtMs: 1 },
  ],
  folders: [],
  records: [],
  recovery: null,
  portalLinkingEnabled: true,
  portalLinks: [link],
};
function fixture(
  overrides: Partial<Parameters<typeof PortalDocuments>[0]> = {},
) {
  const bridge = {
    platform: vi.fn().mockResolvedValue("windows"),
    linkPortal: vi
      .fn()
      .mockRejectedValue({ code: "portal_link_code_rejected" }),
    checkDocuments: vi
      .fn()
      .mockResolvedValue({ added: 0, refused: 0, receiptsPending: 0 }),
    requestDeviceApproval: vi.fn().mockResolvedValue(undefined),
  } as unknown as VaultBridge;
  const refresh = vi.fn().mockResolvedValue(snapshot);
  const failures: unknown[] = [];
  const run = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  const props = {
    bridge,
    snapshot,
    busy: false,
    readOnly: false,
    refresh,
    run,
    setNotice: vi.fn(),
    ...overrides,
  };
  return { ...render(<PortalDocuments {...props} />), props, bridge, failures };
}

describe("native clinic document controls", () => {
  it("keeps all clinic controls hidden when native capability is off", async () => {
    const { container, bridge } = fixture({
      snapshot: { ...snapshot, portalLinkingEnabled: false },
    });
    expect(container).toBeEmptyDOMElement();
    expect(bridge.linkPortal).not.toHaveBeenCalled();
    expect(bridge.checkDocuments).not.toHaveBeenCalled();
    if (import.meta.env.VITE_CAPTURE_PORTAL_UI === "1")
      await page.screenshot({ path: "portal-disabled-before.png" });
  });
  it("shows the complete selectable actual-device identifiers while approval is pending", async () => {
    fixture();
    expect(screen.getByLabelText("Device code")).toHaveValue(deviceCode);
    expect(screen.getByLabelText("Full device fingerprint")).toHaveValue(
      fingerprint,
    );
    expect(screen.getByText("Waiting for clinic approval.")).toBeVisible();
    expect(
      screen.queryByText("The clinic approved this device."),
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Device code"));
    const input = screen.getByLabelText("Device code") as HTMLInputElement;
    expect(input.selectionEnd! - input.selectionStart!).toBe(deviceCode.length);
    if (import.meta.env.VITE_CAPTURE_PORTAL_UI === "1")
      await page
        .getByRole("region", { name: "Clinic documents" })
        .screenshot({ path: "portal-pending-after.png" });
    await page.viewport(360, 780);
    const oldSize = document.documentElement.style.fontSize;
    try {
      document.documentElement.style.fontSize = "200%";
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
      const field = screen.getByLabelText(
        "Full device fingerprint",
      ) as HTMLTextAreaElement;
      expect(field.scrollHeight).toBeLessThanOrEqual(field.clientHeight + 2);
      if (import.meta.env.VITE_CAPTURE_PORTAL_UI === "1") {
        const section = screen.getByRole("region", {
          name: "Clinic documents",
        });
        await page.viewport(360, Math.ceil(section.scrollHeight) + 50);
        await page
          .getByRole("region", { name: "Clinic documents" })
          .screenshot({ path: "portal-pending-narrow-200.png" });
      }
    } finally {
      document.documentElement.style.fontSize = oldSize;
      await page.viewport(1100, 760);
    }
  });
  it("sends a linking code only to native IPC and clears it after a refused attempt", async () => {
    const { bridge, failures } = fixture();
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Portal HTTPS address"),
      "https://portal.example.test/patient",
    );
    await user.type(
      screen.getByLabelText("Linking code"),
      "01234567-89ABCDEFGH",
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Name for this device")).toHaveValue(
        "myCarlos on Windows",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Link to clinic" }));
    await waitFor(() =>
      expect(bridge.linkPortal).toHaveBeenCalledWith({
        portalBase: "https://portal.example.test/patient",
        code: "01234567-89ABCDEFGH",
        deviceName: "myCarlos on Windows",
        profileId: null,
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Linking code")).toHaveValue(""),
    );
    expect(failures).toHaveLength(1);
  });
  it("checks only on explicit action and disables writes in recovery", async () => {
    const { bridge, props, rerender } = fixture();
    expect(bridge.checkDocuments).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Check for new documents" }));
    await waitFor(() => expect(bridge.checkDocuments).toHaveBeenCalledOnce());
    rerender(<PortalDocuments {...props} readOnly />);
    expect(
      screen.getByRole("button", { name: "Check for new documents" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Request clinic approval" }),
    ).toBeDisabled();
  });
  it("renders the linking and fingerprint labels in every supported language", () => {
    fixture();
    for (const locale of LOCALES) {
      act(() => setLocaleOverride(locale));
      expect(
        screen.getByRole("button", { name: translate(locale, "portal.check") }),
      ).toBeVisible();
      expect(
        screen.getByLabelText(translate(locale, "portal.fingerprint")),
      ).toHaveValue(fingerprint);
    }
  });
});
