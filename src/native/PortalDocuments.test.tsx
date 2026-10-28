import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { humanValue } from "../test/humanText";
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
    connectPortal: vi
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

async function fillConnectForm() {
  const user = userEvent.setup();
  await user.type(
    screen.getByLabelText("Portal HTTPS address"),
    "https://portal.example.test/patient",
  );
  await user.type(screen.getByLabelText("Linking code"), "01234567-89ABCDEFGH");
  return screen
    .getByRole("button", { name: "Connect and request approval" })
    .closest("form")!;
}

type ConnectResult = Awaited<
  ReturnType<NonNullable<VaultBridge["connectPortal"]>>
>;
function pendingConnect() {
  let finish!: (value: ConnectResult) => void;
  const promise = new Promise<ConnectResult>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

describe("native clinic document controls", () => {
  it("uses one explicit composite action and never separately relinks or grants approval", async () => {
    const initial = { ...snapshot, portalLinks: [] };
    const { bridge, props, rerender } = fixture({ snapshot: initial });
    vi.mocked(bridge.connectPortal!).mockResolvedValue({
      link,
      approvalError: null,
    });
    vi.mocked(props.refresh).mockImplementation(async () => {
      rerender(<PortalDocuments {...props} snapshot={snapshot} />);
      return snapshot;
    });
    const form = await fillConnectForm();
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() =>
      expect(props.setNotice).toHaveBeenCalledWith(
        "Device linked. Its approval status is shown in Security, under Clinic documents.",
      ),
    );
    expect(bridge.connectPortal).toHaveBeenCalledOnce();
    expect(bridge.linkPortal).not.toHaveBeenCalled();
    expect(bridge.requestDeviceApproval).not.toHaveBeenCalled();
    expect(bridge.restartDeviceApproval).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Approval request saved. Check for updates or send it again.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("The clinic approved this device."),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Full device fingerprint")).toHaveValue(
      fingerprint,
    );
  });

  it("clears the code before HTTP completion and coalesces repeated form callbacks", async () => {
    const { bridge } = fixture();
    const pending = pendingConnect();
    vi.mocked(bridge.connectPortal!).mockReturnValue(pending.promise);
    const form = await fillConnectForm();
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(bridge.connectPortal).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("Linking code")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Connect and request approval" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Connecting and requesting clinic approval…"),
    ).toBeVisible();
    await act(async () => pending.finish({ link, approvalError: null }));
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(bridge.connectPortal).toHaveBeenCalledOnce();
    expect(bridge.linkPortal).not.toHaveBeenCalled();
  });

  it("keeps a completed link after approval failure and retries only its saved request", async () => {
    const initial = { ...snapshot, portalLinks: [] };
    const { bridge, props, rerender } = fixture({ snapshot: initial });
    vi.mocked(bridge.connectPortal!).mockResolvedValue({
      link,
      approvalError: {
        code: "portal_link_incomplete",
        message: "FAKE lost reply",
      },
    });
    vi.mocked(props.refresh).mockImplementation(async () => {
      rerender(<PortalDocuments {...props} snapshot={snapshot} />);
      return snapshot;
    });
    const submittedForm = await fillConnectForm();
    await act(async () => {
      fireEvent.submit(submittedForm);
    });
    await waitFor(() =>
      expect(props.setNotice).toHaveBeenCalledWith(
        "The portal request could not be completed. Check your connection and device clock, then try again. Device linked, but the approval request could not be confirmed. Its status in Security, under Clinic documents, says what to do next.",
      ),
    );
    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "Retry saved approval request" }),
      );
    expect(bridge.requestDeviceApproval).toHaveBeenCalledWith(link.id);
    expect(bridge.requestDeviceApproval).toHaveBeenCalledOnce();
    expect(bridge.connectPortal).toHaveBeenCalledOnce();
    expect(bridge.linkPortal).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Device code")).toHaveValue(deviceCode);
  });

  it("keeps initial link loss visibly incomplete without pretending that it can resume", async () => {
    const initial = { ...snapshot, portalLinks: [] };
    const incomplete = {
      ...snapshot,
      portalLinks: [
        {
          ...link,
          incomplete: true,
          clinicName: null,
          approvalRequested: false,
        },
      ],
    };
    const { bridge, props, rerender } = fixture({ snapshot: initial });
    vi.mocked(bridge.connectPortal!).mockRejectedValue({
      code: "portal_link_incomplete",
    });
    vi.mocked(props.refresh).mockImplementation(async () => {
      rerender(<PortalDocuments {...props} snapshot={incomplete} />);
      return incomplete;
    });
    const submittedForm = await fillConnectForm();
    await act(async () => {
      fireEvent.submit(submittedForm);
    });
    await waitFor(() =>
      expect(
        screen.getByText(translate("en", "portal.incomplete")),
      ).toBeVisible(),
    );
    expect(
      screen.queryByRole("button", { name: "Retry saved approval request" }),
    ).not.toBeInTheDocument();
    expect(bridge.requestDeviceApproval).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Device code")).toHaveValue(deviceCode);
  });

  it("still reports a completion after the clinic view unmounts", async () => {
    const { bridge, props, unmount } = fixture();
    const pending = pendingConnect();
    vi.mocked(bridge.connectPortal!).mockReturnValue(pending.promise);
    const submittedForm = await fillConnectForm();
    await act(async () => {
      fireEvent.submit(submittedForm);
    });
    await waitFor(() => expect(bridge.connectPortal).toHaveBeenCalledOnce());
    unmount();
    await act(async () => pending.finish({ link, approvalError: null }));
    // The link exists whether or not the view is open: the patient is told
    // wherever they are. (The app clears the line when clinic work starts.)
    expect(props.setNotice).toHaveBeenCalledOnce();
    expect(props.setNotice).toHaveBeenCalledWith(
      "Device linked. Its approval status is shown in Security, under Clinic documents.",
    );
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
    await user.click(
      screen.getByRole("button", { name: "Connect and request approval" }),
    );
    await waitFor(() =>
      expect(bridge.connectPortal).toHaveBeenCalledWith({
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
      screen.getByRole("button", { name: "Retry saved approval request" }),
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
      screen.getByRole("button", { name: "Retry saved approval request" }),
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
      expect(humanValue(vi.mocked(props.setNotice).mock.calls)).toContainEqual([
        expect.stringContaining("New documents saved: 1."),
      ]),
    );
    expect(humanValue(vi.mocked(props.setNotice).mock.calls)).toContainEqual([
      expect.stringContaining(
        "Saved documents awaiting pickup confirmation: 1. Check again to finish confirmation. Your saved copies stay in the vault.",
      ),
    ]);
    expect(
      humanValue(vi.mocked(props.setNotice).mock.calls),
    ).not.toContainEqual([expect.stringContaining("Picked up")]);
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
      expect(humanValue(vi.mocked(props.setNotice).mock.calls)).toContainEqual([
        expect.stringContaining(
          "Some clinic checks need attention. New documents saved: 2.",
        ),
      ]),
    );
    expect(humanValue(vi.mocked(props.setNotice).mock.calls)).toContainEqual([
      expect.stringContaining(
        "FAKE Other Clinic: This approval request expired.",
      ),
    ]);
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
