import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { humanValue } from "../test/humanText";
import { page } from "vitest/browser";
import { PortalDocuments } from "./PortalDocuments";
import type { VaultBridge, VaultSnapshot, PortalLinkSummary } from "../vault";
import { LOCALES, setLocaleOverride, translate, resolveText } from "../i18n";

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
  capture: { epoch: "00000000-0000-4000-8000-000000000185", sequence: 1 },
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
    restartDeviceApproval: vi.fn().mockResolvedValue(undefined),
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

const noticeCalls = (
  setNotice: Parameters<typeof PortalDocuments>[0]["setNotice"],
) =>
  humanValue(
    vi.mocked(setNotice).mock.calls.map(([value]) => [resolveText(value)]),
  );

describe("native clinic document controls", () => {
  it.each(["copied", "copyFailed"] as const)(
    "updates settled device-code %s feedback when the language changes",
    async (result) => {
      const user = userEvent.setup();
      const copy = vi.spyOn(navigator.clipboard, "writeText");
      if (result === "copied") copy.mockResolvedValue(undefined);
      else
        copy.mockRejectedValue(
          new DOMException("FAKE clipboard denied", "NotAllowedError"),
        );
      try {
        fixture();
        await user.click(
          screen.getByRole("button", { name: "Copy device code" }),
        );
        const status = screen.getByRole("status");
        await waitFor(() =>
          expect(status).toHaveTextContent(translate("en", `portal.${result}`)),
        );
        expect(copy).toHaveBeenCalledExactlyOnceWith(deviceCode);

        act(() => setLocaleOverride("fr"));
        expect(
          screen.getByRole("button", { name: translate("fr", "portal.copy") }),
        ).toBeVisible();
        expect(status).toHaveTextContent(translate("fr", `portal.${result}`));
        expect(status).not.toHaveTextContent(
          translate("en", `portal.${result}`),
        );
        expect(
          screen.getByLabelText(translate("fr", "portal.deviceCode")),
        ).toHaveValue(deviceCode);
        expect(
          screen.getByLabelText(translate("fr", "portal.fingerprint")),
        ).toHaveValue(fingerprint);
        act(() => setLocaleOverride("en"));
        expect(status).toHaveTextContent(translate("en", `portal.${result}`));
        expect(copy).toHaveBeenCalledOnce();
      } finally {
        copy.mockRestore();
      }
    },
  );

  it("updates copy guidance without a clipboard API when the language changes", async () => {
    const user = userEvent.setup();
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard")!;
    const copy = vi.spyOn(navigator.clipboard, "writeText");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      get: () => undefined,
    });
    try {
      fixture();
      await user.click(
        screen.getByRole("button", { name: "Copy device code" }),
      );
      const status = screen.getByRole("status");
      expect(status).toHaveTextContent(translate("en", "portal.copyFailed"));
      act(() => setLocaleOverride("fr"));
      expect(status).toHaveTextContent(translate("fr", "portal.copyFailed"));
      expect(
        screen.getByLabelText(translate("fr", "portal.deviceCode")),
      ).toHaveValue(deviceCode);
      expect(
        screen.getByLabelText(translate("fr", "portal.fingerprint")),
      ).toHaveValue(fingerprint);
      act(() => setLocaleOverride("en"));
      expect(status).toHaveTextContent(translate("en", "portal.copyFailed"));
      expect(screen.getByLabelText("Device code")).toHaveValue(deviceCode);
      expect(screen.getByLabelText("Full device fingerprint")).toHaveValue(
        fingerprint,
      );
      expect(copy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, "clipboard", descriptor);
      copy.mockRestore();
    }
  });

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
  it("does not imply a clinic request was sent before the intent is saved", () => {
    const { bridge } = fixture({
      snapshot: {
        ...snapshot,
        portalLinks: [{ ...link, approvalRequested: false }],
      },
    });
    expect(
      screen.getByText(
        "Request clinic approval to receive documents on this device.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "Approval request saved. Check for updates or send it again.",
      ),
    ).not.toBeInTheDocument();
    expect(bridge.requestDeviceApproval).not.toHaveBeenCalled();
  });
  it("shows the complete selectable actual-device identifiers while approval is pending", async () => {
    fixture();
    expect(screen.getByLabelText("Device code")).toHaveValue(deviceCode);
    expect(screen.getByLabelText("Full device fingerprint")).toHaveValue(
      fingerprint,
    );
    expect(
      screen.getByText(
        "Approval request saved. Check for updates or send it again.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("The clinic approved this device."),
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Device code"));
    const input = screen.getByLabelText("Device code") as HTMLInputElement;
    expect(input.selectionEnd! - input.selectionStart!).toBe(deviceCode.length);
    if (import.meta.env.VITE_CAPTURE_PORTAL_UI === "1") {
      const section = screen.getByRole("region", { name: "Clinic documents" });
      await page.viewport(1100, Math.ceil(section.scrollHeight) + 50);
      await page
        .getByRole("region", { name: "Clinic documents" })
        .screenshot({ path: "portal-pending-after.png" });
    }
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
  it("keeps a device name typed before platform detection finishes and submits that name", async () => {
    let detect!: (platform: string) => void;
    const platform = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          detect = resolve;
        }),
    );
    const linkPortal = vi.fn().mockResolvedValue(undefined);
    const bridge = {
      platform,
      linkPortal,
      checkDocuments: vi.fn(),
    } as unknown as VaultBridge;
    const { props } = fixture({ bridge });
    const user = userEvent.setup();
    expect(platform).toHaveBeenCalledOnce();
    const device = screen.getByLabelText("Name for this device");
    expect(device).toHaveValue("myCarlos");
    await user.clear(device);
    await user.type(device, "FAKE waiting room laptop");
    expect(device).toHaveValue("FAKE waiting room laptop");
    expect(linkPortal).not.toHaveBeenCalled();
    await act(async () => detect("windows"));
    expect(screen.getByLabelText("Name for this device")).toHaveValue(
      "FAKE waiting room laptop",
    );
    await user.type(
      screen.getByLabelText("Portal HTTPS address"),
      "https://portal.example.test/patient",
    );
    await user.type(
      screen.getByLabelText("Linking code"),
      "01234567-89ABCDEFGH",
    );
    await user.click(screen.getByRole("button", { name: "Link to clinic" }));
    await waitFor(() => expect(props.refresh).toHaveBeenCalledOnce());
    expect(linkPortal).toHaveBeenCalledExactlyOnceWith({
      portalBase: "https://portal.example.test/patient",
      code: "01234567-89ABCDEFGH",
      deviceName: "FAKE waiting room laptop",
      profileId: null,
    });
    expect(screen.getByLabelText("Name for this device")).toHaveValue(
      "FAKE waiting room laptop",
    );
    expect(screen.getByLabelText("Linking code")).toHaveValue("");
    expect(bridge.checkDocuments).not.toHaveBeenCalled();
    expect(platform).toHaveBeenCalledOnce();
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
  it.each(["success", "refusal"] as const)(
    "forgets a linking code after native %s while the vault refresh still waits",
    async (outcome) => {
      let finishLink!: (linked: PortalLinkSummary) => void;
      let refuseLink!: (error: unknown) => void;
      const pendingLink = new Promise<PortalLinkSummary>((resolve, reject) => {
        finishLink = resolve;
        refuseLink = reject;
      });
      let finishRefresh!: (updated: VaultSnapshot) => void;
      const pendingRefresh = new Promise<VaultSnapshot>((resolve) => {
        finishRefresh = resolve;
      });
      const refresh = vi.fn().mockReturnValue(pendingRefresh);
      const { bridge, failures } = fixture({ refresh });
      vi.mocked(bridge.linkPortal!).mockReturnValue(pendingLink);
      const user = userEvent.setup();
      const address = "https://portal.example.test/patient";
      const oneUseCode = "FAKE-ONE-USE-12345678";
      const deviceName = "FAKE bedside tablet";
      const refusal = { code: "portal_link_code_rejected" };
      try {
        await user.type(screen.getByLabelText("Portal HTTPS address"), address);
        await user.type(screen.getByLabelText("Linking code"), oneUseCode);
        const device = screen.getByLabelText("Name for this device");
        await waitFor(() => expect(device).toHaveValue("myCarlos on Windows"));
        await user.clear(device);
        await user.type(device, deviceName);
        await user.selectOptions(
          screen.getByLabelText("Whose records"),
          "fake-person",
        );
        await user.click(
          screen.getByRole("button", { name: "Link to clinic" }),
        );
        expect(bridge.linkPortal).toHaveBeenCalledExactlyOnceWith({
          portalBase: address,
          code: oneUseCode,
          deviceName,
          profileId: "fake-person",
        });
        expect(refresh).not.toHaveBeenCalled();
        await act(async () => {
          if (outcome === "success") finishLink(link);
          else refuseLink(refusal);
        });
        // The native attempt ended, but its follow-up snapshot is still pending.
        // A stalled refresh must not keep the one-use code in the form.
        expect(refresh).toHaveBeenCalledOnce();
        expect(screen.getByLabelText("Linking code")).toHaveValue("");
        expect(screen.getByLabelText("Portal HTTPS address")).toHaveValue(
          address,
        );
        expect(device).toHaveValue(deviceName);
        expect(screen.getByLabelText("Whose records")).toHaveValue(
          "fake-person",
        );
        expect(failures).toEqual([]);
        await act(async () => finishRefresh(snapshot));
        expect(failures).toEqual(outcome === "success" ? [] : [refusal]);
        if (outcome === "refusal") expect(failures[0]).toBe(refusal);
        expect(screen.getByLabelText("Linking code")).toHaveValue("");
        expect(bridge.linkPortal).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledOnce();
      } finally {
        await act(async () => {
          finishLink(link);
          finishRefresh(snapshot);
        });
      }
    },
  );
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
  it("shows terminal states without implying approval is pending and makes restart a separate action", async () => {
    const { bridge, props, rerender } = fixture({
      snapshot: {
        ...snapshot,
        portalLinks: [
          {
            ...link,
            approvalStatus: "expired",
            approvalReason: "challenge_expired",
            approvalCanRestart: true,
          },
        ],
      },
    });
    expect(
      screen.getByText(
        "This approval request expired. Check for updates before starting a new request.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Request clinic approval" }),
    ).toBeDisabled();
    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "Start a new approval request" }),
      );
    await waitFor(() =>
      expect(bridge.restartDeviceApproval).toHaveBeenCalledWith(link.id),
    );
    expect(bridge.requestDeviceApproval).not.toHaveBeenCalled();
    rerender(
      <PortalDocuments
        {...props}
        snapshot={{
          ...snapshot,
          portalLinks: [
            {
              ...link,
              approvalStatus: "refused",
              approvalReason: "staff_required",
              approvalCanRestart: false,
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByText(
        "Clinic approval needs to be checked. Contact your clinic for next steps.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "Approval request saved. Check for updates or send it again.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start a new approval request" }),
    ).not.toBeInTheDocument();
  });
  it("shows pending pickup confirmation while preserving the number of documents saved", async () => {
    const { bridge, props } = fixture();
    vi.mocked(bridge.checkDocuments!).mockResolvedValue({
      added: 1,
      refused: 0,
      receiptsPending: 1,
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Check for new documents" }));
    await waitFor(() =>
      expect(noticeCalls(props.setNotice)).toContainEqual([
        expect.stringContaining("New documents saved: 1."),
      ]),
    );
    expect(noticeCalls(props.setNotice)).toContainEqual([
      expect.stringContaining(
        "Saved documents awaiting pickup confirmation: 1. Check again to finish confirmation. Your saved copies stay in the vault.",
      ),
    ]);
    expect(noticeCalls(props.setNotice)).not.toContainEqual([
      expect.stringContaining("Picked up"),
    ]);
    const completed = vi.mocked(props.setNotice).mock.calls.at(-1)![0];
    act(() => setLocaleOverride("fr"));
    const french = humanValue(resolveText(completed));
    expect(french).toContain(
      humanValue(translate("fr", "portal.result", { added: 1, refused: 0 })),
    );
    expect(french).toContain(
      humanValue(translate("fr", "portal.confirmationsPending", { count: 1 })),
    );
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
  });
  it("shows clinic-specific partial guidance while preserving successful progress from other links", async () => {
    const { bridge, props } = fixture();
    vi.mocked(bridge.checkDocuments!).mockResolvedValue({
      added: 2,
      refused: 0,
      receiptsPending: 0,
      issues: [
        {
          linkId: "other-link",
          clinicName: "FAKE Other Clinic",
          code: "approval_expired",
        },
      ],
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Check for new documents" }));
    await waitFor(() =>
      expect(noticeCalls(props.setNotice)).toContainEqual([
        expect.stringContaining(
          "Some clinic checks need attention. New documents saved: 2.",
        ),
      ]),
    );
    expect(noticeCalls(props.setNotice)).toContainEqual([
      expect.stringContaining(
        "FAKE Other Clinic: This approval request expired.",
      ),
    ]);
    const completed = vi.mocked(props.setNotice).mock.calls.at(-1)![0];
    act(() => setLocaleOverride("fr"));
    const french = humanValue(resolveText(completed));
    expect(french).toContain(
      humanValue(
        translate("fr", "portal.partialResult", { added: 2, refused: 0 }),
      ),
    );
    expect(french).toContain(
      humanValue(
        translate("fr", "portal.clinicIssue", {
          clinic: "FAKE Other Clinic",
          detail: translate("fr", "portal.approvalExpired"),
        }),
      ),
    );
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
  });
  it("keeps contact guidance and hides restart when the native request archive is full", () => {
    fixture({
      snapshot: {
        ...snapshot,
        portalLinks: [
          {
            ...link,
            approvalStatus: "expired",
            approvalCanRestart: false,
            approvalRequestLimitReached: true,
          },
        ],
      },
    });
    expect(
      screen.getByText(
        "Clinic approval needs to be checked. Contact your clinic for next steps.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Start a new approval request" }),
    ).not.toBeInTheDocument();
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
