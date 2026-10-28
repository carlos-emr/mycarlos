import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import { PortalDocuments } from "./PortalDocuments";
import type {
  PortalApprovalCheck,
  VaultBridge,
  VaultSnapshot,
  PortalLinkSummary,
} from "../vault";
import { LOCALES, setLocaleOverride, translate } from "../i18n";
import {
  PortalWaits,
  type ApprovalPoll,
  type PollApproval,
} from "./useApprovalPolling";

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
    submitApprovalCode: vi.fn().mockResolvedValue(undefined),
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
    // The portal answered the request, so the card says the clinic has it
    // (#131), and never that the device is approved.
    expect(
      screen.getByText(
        "Your clinic has the approval request. Waiting for clinic staff to approve this device.",
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
        "This approval request expired. To ask again for this same device, choose Start a new approval request. Your documents and this device's link stay as they are.",
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
      expect(props.setNotice).toHaveBeenCalledWith(
        expect.stringContaining("New documents saved: 1."),
      ),
    );
    expect(props.setNotice).toHaveBeenCalledWith(
      expect.stringContaining(
        "Saved documents awaiting pickup confirmation: 1. Check again to finish confirmation. Your saved copies stay in the vault.",
      ),
    );
    expect(props.setNotice).not.toHaveBeenCalledWith(
      expect.stringContaining("Picked up"),
    );
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
      expect(props.setNotice).toHaveBeenCalledWith(
        expect.stringContaining(
          "Some clinic checks need attention. New documents saved: 2.",
        ),
      ),
    );
    expect(props.setNotice).toHaveBeenCalledWith(
      expect.stringContaining(
        "FAKE Other Clinic: This approval request expired.",
      ),
    );
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
  it("says before linking, in every supported language, that myCarlos contacts the portal at each unlock (#128)", () => {
    fixture();
    for (const locale of LOCALES) {
      act(() => setLocaleOverride(locale));
      const said = screen.getByText(
        translate(locale, "portal.unlockCheckConsent"),
      );
      expect(said).toBeVisible();
      // Read before the button that links the device.
      const link = screen.getByRole("button", {
        name: translate(locale, "portal.link"),
      });
      expect(
        said.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });
  it.each([
    ["in the same session", false, true],
    ["after a lock ended the session", true, false],
  ] as [string, boolean, boolean][])(
    "keeps a wait the portal asked of the patient's own check only %s (#128)",
    async (_, locked, kept) => {
      const waits = new PortalWaits();
      let reply!: (value: unknown) => void;
      const { bridge } = fixture({ waits });
      vi.mocked(bridge.checkDocuments!).mockReturnValue(
        new Promise((resolve) => {
          reply = resolve;
        }) as never,
      );
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Check for new documents" }));
      // A lock clears the session's waits while the reply is on its way.
      if (locked) waits.clear();
      await act(async () =>
        reply({
          added: 0,
          refused: 0,
          receiptsPending: 0,
          issues: [
            {
              linkId: link.id,
              clinicName: "FAKE Clinic",
              code: "portal_rate_limited",
            },
          ],
        }),
      );
      expect(waits.waiting(link.portalBase)).toBe(kept);
    },
  );
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

describe("automatic approval status checks (#131)", () => {
  const pending: PortalLinkSummary = { ...link, approvalStatus: "pending" };
  const view = (shown: PortalLinkSummary): VaultSnapshot => ({
    ...snapshot,
    portalLinks: [shown],
  });
  const reply = (
    shown: PortalLinkSummary,
    extra: Partial<PortalApprovalCheck> = {},
  ): ApprovalPoll => ({
    check: { link: shown, expiresInMs: null, issue: null, ...extra },
  });
  const AWAITING =
    "Your clinic has the approval request. Waiting for clinic staff to approve this device.";
  const AUTO =
    "While this page is open, myCarlos checks for your clinic's answer automatically.";
  const UNREACHABLE =
    "myCarlos could not reach the clinic portal, so this request's status is not known yet.";
  const STOPPED =
    "Automatic checks have stopped. To check again, choose Check for new documents.";
  const EXPIRED =
    "This approval request expired. To ask again for this same device, choose Start a new approval request. Your documents and this device's link stay as they are.";

  /** Fake time, the page's steady clock included, from before the view
   * opens. */
  function fakeClock() {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
        "performance",
      ],
    });
    onTestFinished(() => {
      vi.useRealTimers();
    });
  }
  const pass = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  /** The clinic view with a check that puts what it found into the vault on
   * screen, as the app does. `answer` says what the portal says each time. */
  function checked(
    answer: (call: number) => ApprovalPoll | Promise<ApprovalPoll>,
    first: PortalLinkSummary = pending,
    overrides: Partial<Parameters<typeof PortalDocuments>[0]> = {},
  ) {
    fakeClock();
    let show = (_: PortalLinkSummary) => {};
    const poll = vi.fn<PollApproval>(async () => {
      const outcome = await answer(poll.mock.calls.length);
      if (outcome && "check" in outcome) show(outcome.check.link);
      return outcome;
    });
    const result = fixture({ snapshot: view(first), poll, ...overrides });
    let mounted = true;
    // The app keeps the vault on screen after the view closes; here there is
    // nothing left to show it in.
    show = (next) => {
      if (mounted)
        result.rerender(
          <PortalDocuments {...result.props} snapshot={view(next)} />,
        );
    };
    const unmount = () => {
      mounted = false;
      result.unmount();
    };
    return { ...result, unmount, poll };
  }
  const status = () => screen.getAllByRole("status").at(-1)!;

  it("checks an open request on a bounded backoff that only reads, and then stops", async () => {
    const { poll, bridge } = checked(() => reply(pending));
    await pass(9_999);
    expect(poll).not.toHaveBeenCalled();
    await pass(1);
    expect(poll).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledWith(link.id);
    expect(screen.getByText(AWAITING)).toBeVisible();
    expect(screen.getByText(AUTO)).toBeVisible();
    // 10 s, then 20, 40 and 60 s apart.
    await pass(19_999);
    expect(poll).toHaveBeenCalledTimes(1);
    await pass(1);
    expect(poll).toHaveBeenCalledTimes(2);
    await pass(40_000);
    expect(poll).toHaveBeenCalledTimes(3);
    await pass(60_000);
    expect(poll).toHaveBeenCalledTimes(4);
    await pass(60_000);
    expect(poll).toHaveBeenCalledTimes(5);
    // No more than 15 minutes in all: 16 checks, then a note that they
    // stopped and how to check again.
    await pass(15 * 60_000);
    expect(poll).toHaveBeenCalledTimes(16);
    await pass(30 * 60_000);
    expect(poll).toHaveBeenCalledTimes(16);
    expect(
      screen.getByText(
        "Automatic checks have stopped. To check again, choose Check for new documents.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(AUTO)).not.toBeInTheDocument();
    // Checks never send, re-send or start anything, and say nothing when
    // nothing changed.
    expect(bridge.requestDeviceApproval).not.toHaveBeenCalled();
    expect(bridge.restartDeviceApproval).not.toHaveBeenCalled();
    expect(bridge.connectPortal).not.toHaveBeenCalled();
    expect(bridge.checkDocuments).not.toHaveBeenCalled();
    expect(status()).toBeEmptyDOMElement();
  });

  it("says each change once and politely, and approved only from the verified saved state", async () => {
    const code = () => screen.getByLabelText("Linking code");
    const { poll } = checked(
      (call) =>
        [
          reply(pending),
          reply({ ...link, approvalStatus: "challenge_ready" }),
          reply({ ...link, approvalStatus: "challenge_ready" }),
          // The portal says accepted, but the proof did not verify.
          reply({ ...link, approvalStatus: "accepted", clinicApproved: false }),
          reply({ ...link, approvalStatus: "accepted", clinicApproved: true }),
        ][call - 1],
    );
    code().focus();
    await pass(10_000);
    // The portal has the request the card called saved: nothing to say.
    expect(status()).toBeEmptyDOMElement();
    await pass(20_000);
    const started =
      "Your clinic's records system has picked up this request. Waiting for clinic staff to approve this device.";
    expect(status()).toHaveTextContent(started);
    expect(screen.getAllByText(started)).toHaveLength(2);
    // Heard, not shown twice: the card already shows it.
    expect(status().querySelector(".sr-only")).toHaveTextContent(started);
    await pass(40_000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(status()).toHaveTextContent(started);
    await pass(60_000);
    expect(poll).toHaveBeenCalledTimes(4);
    expect(
      screen.queryByText("The clinic approved this device."),
    ).not.toBeInTheDocument();
    expect(status()).toHaveTextContent(
      "Clinic approval needs to be checked. Contact your clinic for next steps.",
    );
    // Nothing open is left to check after that.
    await pass(10 * 60_000);
    expect(poll).toHaveBeenCalledTimes(4);
    expect(document.querySelector("[role=alert]")).toBeNull();
    expect(code()).toHaveFocus();
  });

  it("announces a verified approval and stops checking", async () => {
    const { poll } = checked((call) =>
      call === 1
        ? reply(pending)
        : reply({ ...link, approvalStatus: "accepted", clinicApproved: true }),
    );
    await pass(30_000);
    expect(status()).toHaveTextContent("The clinic approved this device.");
    expect(
      screen.getAllByText("The clinic approved this device."),
    ).toHaveLength(2);
    expect(screen.queryByText(AUTO)).not.toBeInTheDocument();
    await pass(10 * 60_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("counts down quietly by the portal's clock and asks again just after the time runs out", async () => {
    // This device's clock says the request already ran out (restart is
    // offered by it), but the portal gives it two minutes more.
    const local: PortalLinkSummary = { ...pending, approvalCanRestart: true };
    const expiry = 125_000;
    const { poll } = checked(() => {
      const now = performance.now();
      const left = Math.max(expiry - now, 0);
      // As the native check does: a new request is offered by the portal's
      // clock once it is past the request's end.
      if (now < expiry + 3_000)
        return reply(
          { ...local, approvalCanRestart: left === 0 },
          { expiresInMs: left },
        );
      return reply({
        ...link,
        approvalStatus: "expired",
        approvalReason: "challenge_expired",
        approvalCanRestart: true,
      });
    }, local);
    const restart = () =>
      screen.queryByRole("button", { name: "Start a new approval request" });
    expect(restart()).toBeVisible();
    await pass(10_000);
    const left = screen.getByText(
      "Time left for this request: about 2 minutes.",
    );
    expect(left.closest("[role=status],[aria-live]")).toBeNull();
    expect(restart()).not.toBeInTheDocument();
    // It moves without a check, and is never read out.
    await pass(15_000);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Time left for this request: about 2 minutes."));
    await pass(50_000);
    expect(
      screen.getByText("Time left for this request: about 1 minute."),
    ).toBeVisible();
    expect(status()).toBeEmptyDOMElement();
    // Checks at 10, 30 and 70 s; the next comes 2 s after the time runs out
    // by the portal's clock, sooner than the 60 s step.
    expect(poll).toHaveBeenCalledTimes(3);
    await pass(51_999);
    expect(poll).toHaveBeenCalledTimes(3);
    await pass(1);
    expect(poll).toHaveBeenCalledTimes(4);
    // Still "pending" on the portal, but past its end by its clock: a new
    // request is offered, with plain guidance.
    expect(
      screen.getByText(
        "The time for this request has run out. If your clinic has not approved this device, choose Start a new approval request.",
      ),
    ).toBeVisible();
    expect(restart()).toBeVisible();
    // Only the portal's own answer says it expired.
    expect(screen.queryByText(EXPIRED)).not.toBeInTheDocument();
    await pass(60_000);
    expect(poll).toHaveBeenCalledTimes(5);
    expect(screen.getAllByText(EXPIRED)).toHaveLength(2);
    expect(restart()).toBeVisible();
    await pass(10 * 60_000);
    expect(poll).toHaveBeenCalledTimes(5);
  });

  it("keeps a connection failure or a portal asking to wait apart from expiry, and backs off as asked", async () => {
    const answers: ApprovalPoll[] = [
      reply(pending, { issue: { code: "portal_link_incomplete" } }),
      reply(pending, { issue: { code: "portal_link_incomplete" } }),
      { error: { code: "portal_busy", message: "FAKE busy" } },
      reply(pending, {
        issue: { code: "portal_rate_limited", retryAfterMs: 300_000 },
      }),
      reply(pending),
    ];
    const { poll } = checked((call) => answers[call - 1]);
    await pass(10_000);
    expect(screen.getAllByText(UNREACHABLE)).toHaveLength(2);
    for (const wrong of [
      EXPIRED,
      "The clinic refused this device approval request. Contact your clinic for next steps.",
      "Start a new approval request",
    ])
      expect(screen.queryByText(wrong)).not.toBeInTheDocument();
    // The same failure again says nothing new; another clinic operation
    // holding the guard says nothing at all.
    await pass(20_000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(status()).toHaveTextContent(UNREACHABLE);
    await pass(40_000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(screen.getAllByText(UNREACHABLE)).toHaveLength(2);
    await pass(60_000);
    expect(poll).toHaveBeenCalledTimes(4);
    const wait = "The clinic portal asked myCarlos to check less often.";
    expect(status()).toHaveTextContent(wait);
    // Not before the five minutes the portal asked for.
    await pass(299_999);
    expect(poll).toHaveBeenCalledTimes(4);
    await pass(1);
    expect(poll).toHaveBeenCalledTimes(5);
    expect(status()).toHaveTextContent(AWAITING);
  });

  it("stops for a request the portal does not have until the patient sends it again", async () => {
    const answers: ApprovalPoll[] = [
      reply(pending, { issue: { code: "approval_missing" } }),
      reply(pending),
    ];
    const { poll, bridge } = checked((call) => answers[call - 1]);
    await pass(10_000);
    const missing =
      "Your saved approval request was not found on the portal. Send the saved request again.";
    expect(screen.getAllByText(missing)).toHaveLength(2);
    await pass(10 * 60_000);
    expect(poll).toHaveBeenCalledOnce();
    expect(bridge.requestDeviceApproval).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Retry saved approval request" }),
      );
    });
    await pass(0);
    expect(bridge.requestDeviceApproval).toHaveBeenCalledWith(link.id);
    expect(screen.getByText(AWAITING)).toBeVisible();
    await pass(10_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("waits while hidden and while other work runs, and stops when the view closes", async () => {
    let finish!: (outcome: ApprovalPoll) => void;
    const { poll, props, rerender, unmount } = checked((call) =>
      call < 3
        ? reply(pending)
        : new Promise<ApprovalPoll>((resolve) => {
            finish = resolve;
          }),
    );
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    onTestFinished(() => visibility.mockRestore());
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await pass(2 * 60_000);
    expect(poll).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Overdue: checked a second after the page is back.
    await pass(1_000);
    expect(poll).toHaveBeenCalledOnce();
    rerender(<PortalDocuments {...props} busy />);
    await pass(3 * 60_000);
    expect(poll).toHaveBeenCalledOnce();
    rerender(<PortalDocuments {...props} busy={false} />);
    await pass(20_000);
    expect(poll).toHaveBeenCalledTimes(2);
    await pass(40_000);
    expect(poll).toHaveBeenCalledTimes(3);
    unmount();
    // A reply after the view closed is not shown and starts nothing.
    await act(async () =>
      finish(
        reply({ ...link, approvalStatus: "accepted", clinicApproved: true }),
      ),
    );
    await pass(30 * 60_000);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("does not check in recovery mode, in the compact control, or without an open request", async () => {
    for (const overrides of [
      { readOnly: true },
      { compact: true },
      {
        snapshot: view({
          ...link,
          approvalStatus: "expired",
          approvalCanRestart: true,
        }),
      },
      { snapshot: view({ ...link, approvalRequested: false }) },
      { snapshot: view({ ...link, clinicApproved: true }) },
    ]) {
      const { poll, unmount } = checked(
        () => reply(pending),
        pending,
        overrides,
      );
      await pass(5 * 60_000);
      expect(poll).not.toHaveBeenCalled();
      expect(screen.queryByText(AUTO)).not.toBeInTheDocument();
      unmount();
      vi.useRealTimers();
    }
  });

  it("starts over after the patient's own request, which no check overlaps", async () => {
    let finishRequest!: () => void;
    const { poll, bridge } = checked(() => reply(pending));
    vi.mocked(bridge.requestDeviceApproval!).mockReturnValue(
      new Promise<void>((resolve) => {
        finishRequest = resolve;
      }),
    );
    await pass(10_000);
    expect(poll).toHaveBeenCalledOnce();
    await pass(15_000);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Retry saved approval request" }),
      );
    });
    // A check falls due while the request runs: it waits.
    await pass(5 * 60_000);
    expect(poll).toHaveBeenCalledOnce();
    await act(async () => finishRequest());
    await pass(0);
    await pass(9_999);
    expect(poll).toHaveBeenCalledOnce();
    await pass(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("says a reply that did not verify, stops checking it, and never calls it approved", async () => {
    const invalid =
      "The clinic portal's answer about this request could not be verified, so it was not used. Contact your clinic.";
    const { poll } = checked(() =>
      reply(pending, {
        issue: { code: "approval_reply_invalid", message: "Native text." },
      }),
    );
    await pass(10_000);
    expect(screen.getAllByText(invalid)).toHaveLength(2);
    expect(screen.getByText(STOPPED)).toBeVisible();
    for (const wrong of [UNREACHABLE, AUTO, "The clinic approved this device."])
      expect(screen.queryByText(wrong)).not.toBeInTheDocument();
    await pass(10 * 60_000);
    expect(poll).toHaveBeenCalledOnce();
  });

  it("says a local fault as it is, not as a connection failure, and stops checking", async () => {
    const { poll } = checked(() => ({
      error: { code: "storage", message: "FAKE storage fault text." },
    }));
    await pass(10_000);
    expect(screen.getAllByText("FAKE storage fault text.")).toHaveLength(2);
    expect(screen.getByText(STOPPED)).toBeVisible();
    expect(screen.queryByText(UNREACHABLE)).not.toBeInTheDocument();
    await pass(10 * 60_000);
    expect(poll).toHaveBeenCalledOnce();
  });

  it("stops at once when the portal asks for a wait past the end of the checks", async () => {
    for (const retryAfterMs of [
      20 * 60_000,
      2 ** 31,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const { poll, unmount } = checked(() =>
        reply(pending, {
          issue: { code: "portal_rate_limited", retryAfterMs },
        }),
      );
      await pass(10_000);
      expect(poll).toHaveBeenCalledOnce();
      expect(
        screen.getAllByText(
          "The clinic portal asked myCarlos to check less often.",
        ),
      ).toHaveLength(2);
      expect(screen.getByText(STOPPED)).toBeVisible();
      // No timer fires at once, nor later.
      await pass(1_000);
      await pass(30 * 60_000);
      expect(poll).toHaveBeenCalledOnce();
      unmount();
      vi.useRealTimers();
    }
  });

  it("keeps the portal's wait across the patient's own action, which it does not hold", async () => {
    const answers: ApprovalPoll[] = [
      reply(pending, {
        issue: { code: "portal_rate_limited", retryAfterMs: 5 * 60_000 },
      }),
      reply(pending),
    ];
    const { poll, bridge } = checked((call) => answers[call - 1]);
    await pass(10_000);
    expect(poll).toHaveBeenCalledOnce();
    await pass(10_000);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Retry saved approval request" }),
      );
    });
    await pass(0);
    expect(bridge.requestDeviceApproval).toHaveBeenCalledOnce();
    // Not 10 s after the action: 5 minutes after the portal asked.
    await pass(289_999);
    expect(poll).toHaveBeenCalledOnce();
    await pass(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("checks every open request, says which clinic changed, and keeps checking the others", async () => {
    fakeClock();
    const second: PortalLinkSummary = {
      ...pending,
      id: "fake-link-2",
      clinicName: "FAKE Second Clinic",
      deviceKeyId: "FAKE_SECOND_DEVICE",
    };
    const shown = { ...snapshot, portalLinks: [pending, second] };
    const poll = vi.fn<PollApproval>(async (linkId) =>
      linkId === second.id
        ? reply(second, { issue: { code: "approval_missing" } })
        : reply(pending),
    );
    fixture({ snapshot: shown, poll });
    await pass(10_000);
    expect(poll.mock.calls).toEqual([[pending.id], [second.id]]);
    expect(status()).toHaveTextContent(
      "FAKE Second Clinic: Your saved approval request was not found on the portal. Send the saved request again.",
    );
    await pass(20_000);
    expect(poll.mock.calls).toEqual([[pending.id], [second.id], [pending.id]]);
  });

  it("moves focus to the device's heading only when a check removes or disables the focused control", async () => {
    for (const [first, next, control] of [
      [
        pending,
        { ...link, approvalStatus: "accepted", clinicApproved: true },
        "Retry saved approval request",
      ],
      [
        pending,
        { ...link, approvalStatus: "expired", approvalCanRestart: true },
        "Retry saved approval request",
      ],
      [
        { ...pending, approvalCanRestart: true },
        { ...pending, approvalCanRestart: true },
        "Start a new approval request",
      ],
    ] as const) {
      const { unmount } = checked(
        () => reply(next, { expiresInMs: 5 * 60_000 }),
        first,
      );
      screen.getByRole("button", { name: control }).focus();
      expect(screen.getByRole("button", { name: control })).toHaveFocus();
      await pass(10_000);
      expect(
        screen.getByRole("heading", { name: "FAKE Clinic", level: 3 }),
      ).toHaveFocus();
      unmount();
      vi.useRealTimers();
    }
  });

  it("does not say it is checking once the time runs out after checks stopped", async () => {
    // Clocks apart: the portal gives this request 16 minutes, more than
    // automatic checks last.
    const end = 16 * 60_000;
    checked(() =>
      reply(pending, { expiresInMs: Math.max(end - performance.now(), 0) }),
    );
    await pass(end + 60_000);
    expect(screen.getByText(STOPPED)).toBeVisible();
    expect(
      screen.getByText("The time for this request has run out."),
    ).toBeVisible();
    expect(
      screen.queryByText(/Checking with your clinic/),
    ).not.toBeInTheDocument();
  });

  it("waits only for the portal that asked, and keeps checking the others", async () => {
    fakeClock();
    const other: PortalLinkSummary = {
      ...pending,
      id: "fake-link-other-portal",
      portalBase: "https://other-portal.example.test/patient",
      clinicName: "FAKE Other Clinic",
      deviceKeyId: "FAKE_OTHER_DEVICE",
    };
    const poll = vi.fn<PollApproval>(async (linkId) =>
      linkId === pending.id
        ? reply(pending, {
            issue: { code: "portal_rate_limited", retryAfterMs: 20 * 60_000 },
          })
        : reply(other),
    );
    fixture({ snapshot: { ...snapshot, portalLinks: [pending, other] }, poll });
    await pass(10_000);
    expect(poll.mock.calls).toEqual([[pending.id], [other.id]]);
    // 10 minutes on: the other clinic was checked on its own schedule, the
    // one that asked to wait was not asked again, and nothing says stopped.
    await pass(10 * 60_000);
    const asked = (id: string) =>
      poll.mock.calls.filter(([linkId]) => linkId === id).length;
    expect(asked(pending.id)).toBe(1);
    expect(asked(other.id)).toBeGreaterThan(10);
    expect(screen.queryByText(STOPPED)).not.toBeInTheDocument();
    expect(screen.getAllByText(AUTO)).toHaveLength(2);
  });

  it("keeps a portal's wait when the view closes and opens again", async () => {
    fakeClock();
    const waits = new PortalWaits();
    const poll = vi.fn<PollApproval>(
      async (): Promise<ApprovalPoll> =>
        poll.mock.calls.length === 1
          ? reply(pending, {
              issue: { code: "portal_rate_limited", retryAfterMs: 5 * 60_000 },
            })
          : reply(pending),
    );
    const first = fixture({ snapshot: view(pending), poll, waits });
    await pass(10_000);
    expect(poll).toHaveBeenCalledOnce();
    first.unmount();
    await pass(10_000);
    fixture({ snapshot: view(pending), poll, waits });
    // Not 10 s after it opens again: 5 minutes after the portal asked.
    await pass(289_999);
    expect(poll).toHaveBeenCalledOnce();
    await pass(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("keeps a wait the portal asked of the patient's own request", async () => {
    const waits = new PortalWaits();
    const { poll, bridge } = checked(() => reply(pending), pending, { waits });
    vi.mocked(bridge.requestDeviceApproval!).mockRejectedValue({
      code: "portal_rate_limited",
      message: "FAKE native text",
      retryAfterMs: 120_000,
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Retry saved approval request" }),
      );
    });
    await pass(0);
    expect(bridge.requestDeviceApproval).toHaveBeenCalledOnce();
    await pass(119_999);
    expect(poll).not.toHaveBeenCalled();
    await pass(1);
    expect(poll).toHaveBeenCalledOnce();
  });

  it("says a removed device plainly and stops, and words other refusals neutrally", async () => {
    const removed =
      "This device was removed from your clinic portal account. To use it again, connect it again with a new linking code from your patient portal.";
    // This device's clock offers a new request; neither can work now.
    const offered: PortalLinkSummary = { ...pending, approvalCanRestart: true };
    const gone = checked(
      () =>
        reply(offered, {
          issue: { code: "portal_device_removed", message: "Native text." },
        }),
      offered,
    );
    const button = (name: string) => screen.getByRole("button", { name });
    expect(button("Retry saved approval request")).toBeEnabled();
    expect(button("Start a new approval request")).toBeEnabled();
    await pass(10_000);
    expect(screen.getAllByText(removed)).toHaveLength(2);
    expect(button("Retry saved approval request")).toBeDisabled();
    expect(button("Start a new approval request")).toBeDisabled();
    // Checking again cannot help: no "check again" line, and no checks.
    expect(screen.queryByText(STOPPED)).not.toBeInTheDocument();
    await pass(10 * 60_000);
    expect(gone.poll).toHaveBeenCalledOnce();
    gone.unmount();
    vi.useRealTimers();
    const unanswered =
      "myCarlos could not get this request's status from the clinic portal.";
    const { poll } = checked(() =>
      reply(pending, { issue: { code: "portal_refused", message: "Native." } }),
    );
    await pass(10_000);
    expect(screen.getAllByText(unanswered)).toHaveLength(2);
    expect(screen.queryByText(UNREACHABLE)).not.toBeInTheDocument();
    expect(screen.getByText(AUTO)).toBeVisible();
    // Retried, like a connection failure.
    await pass(20_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("checks early only once for a request whose end the portal's clock keeps near", async () => {
    // A stuck date: every reply leaves the request one second.
    const { poll } = checked(() => reply(pending, { expiresInMs: 1_000 }));
    await pass(10_000);
    expect(poll).toHaveBeenCalledOnce();
    // The one early check: 2 s after the second left, not 20 s.
    await pass(2_999);
    expect(poll).toHaveBeenCalledOnce();
    await pass(1);
    expect(poll).toHaveBeenCalledTimes(2);
    // Then the schedule only: 40 s, then every 60 s, to the end.
    await pass(39_999);
    expect(poll).toHaveBeenCalledTimes(2);
    await pass(1);
    expect(poll).toHaveBeenCalledTimes(3);
    await pass(16 * 60_000);
    // The 16 checks of the schedule, and one early one.
    expect(poll).toHaveBeenCalledTimes(17);
  });

  it("keeps a wait asked with a refusal, as during maintenance", async () => {
    const answers: ApprovalPoll[] = [
      reply(pending, {
        issue: {
          code: "portal_refused",
          message: "Native.",
          retryAfterMs: 300_000,
        },
      }),
      reply(pending),
    ];
    const { poll } = checked((call) => answers[call - 1]);
    await pass(10_000);
    expect(poll).toHaveBeenCalledOnce();
    // Not 20 s later, as for a refusal that says nothing: 5 minutes.
    await pass(299_999);
    expect(poll).toHaveBeenCalledOnce();
    await pass(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("keeps a wait the portal asked while connecting", async () => {
    fakeClock();
    const waits = new PortalWaits();
    const poll = vi.fn<PollApproval>(async () => reply(pending));
    const empty = { ...snapshot, portalLinks: [] };
    const result = fixture({ snapshot: empty, poll, waits });
    vi.mocked(result.bridge.connectPortal!).mockResolvedValue({
      link: pending,
      approvalError: {
        code: "portal_rate_limited",
        message: "FAKE native text",
        retryAfterMs: 120_000,
      },
    });
    vi.mocked(result.props.refresh).mockImplementation(async () => {
      result.rerender(
        <PortalDocuments {...result.props} snapshot={view(pending)} />,
      );
      return view(pending);
    });
    fireEvent.change(screen.getByLabelText("Portal HTTPS address"), {
      target: { value: "https://portal.example.test/patient" },
    });
    fireEvent.change(screen.getByLabelText("Linking code"), {
      target: { value: "01234567-89ABCDEFGH" },
    });
    await act(async () => {
      fireEvent.submit(
        screen
          .getByRole("button", { name: "Connect and request approval" })
          .closest("form")!,
      );
    });
    await pass(0);
    expect(result.bridge.connectPortal).toHaveBeenCalledOnce();
    // Not 10 s after the connection: the 2 minutes the portal asked for.
    await pass(119_999);
    expect(poll).not.toHaveBeenCalled();
    await pass(1);
    expect(poll).toHaveBeenCalledOnce();
  });

  it("keeps a wait the compact document check was asked for", async () => {
    const waits = new PortalWaits();
    const { bridge } = fixture({ compact: true, waits });
    vi.mocked(bridge.checkDocuments!).mockResolvedValue({
      added: 0,
      refused: 0,
      receiptsPending: 0,
      issues: [
        {
          linkId: link.id,
          clinicName: "FAKE Clinic",
          code: "portal_rate_limited",
        },
      ],
    });
    const before = performance.now();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Check for new documents" }),
      );
    });
    await waitFor(() => expect(bridge.checkDocuments).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(waits.notBefore(link.portalBase)).toBeGreaterThanOrEqual(
        before + 60_000,
      ),
    );
  });

  it("shows the new states in every supported language", async () => {
    checked(() => reply(pending, { expiresInMs: 4 * 60_000 }));
    await pass(10_000);
    for (const locale of LOCALES) {
      act(() => setLocaleOverride(locale));
      for (const text of [
        translate(locale, "portal.awaitingClinic"),
        translate(locale, "portal.autoChecking"),
        translate(locale, "portal.approvalTimeLeft", { count: 4 }),
      ])
        expect(screen.getByText(text)).toBeVisible();
    }
    act(() => setLocaleOverride(null));
  });
});

describe("the code a clinic emails (#141)", () => {
  const asked: PortalLinkSummary = {
    ...link,
    approvalStatus: "challenge_ready",
    approvalByCode: true,
  };
  const showing = (changes: Partial<PortalLinkSummary> = {}) => ({
    ...snapshot,
    portalLinks: [{ ...asked, ...changes }],
  });
  const codeBox = () =>
    screen.queryByRole("textbox", { name: "Code from your clinic's email" });
  const hint =
    "Enter the 9-digit code your clinic emailed you. Never use a code shown on a website.";
  const mismatch =
    "This code doesn't match this clinic. Check that you linked your clinic's real portal address, then try again.";
  const locked =
    "Too many codes were tried for this request, so myCarlos won't take another one. Contact your clinic.";

  it("asks for the code only when the clinic's verified challenge asks for one", () => {
    const { props, rerender } = fixture({ snapshot: showing() });
    expect(
      screen.getByText(
        "Your clinic emailed you a code to confirm this device. Enter it below.",
      ),
    ).toBeVisible();
    const box = codeBox()!;
    expect(box).toBeVisible();
    expect(box).toHaveAttribute("inputmode", "numeric");
    expect(box).toHaveAttribute("autocomplete", "one-time-code");
    expect(box).toHaveAttribute("spellcheck", "false");
    expect(box).toHaveAccessibleDescription(hint);
    expect(screen.getByRole("button", { name: "Confirm code" })).toBeEnabled();
    const states: [Partial<PortalLinkSummary>, string][] = [
      // Staff approval: no code is asked for.
      [
        { approvalByCode: false },
        "Your clinic's records system has picked up this request. Waiting for clinic staff to approve this device.",
      ],
      [
        { approvalCodeSubmitted: true },
        "Code sent. Waiting for your clinic to confirm this device.",
      ],
      [{ approvalCodeLocked: true }, locked],
      [{ approvalStatus: "refused", approvalReason: "code_attempts" }, locked],
      [
        { approvalStatus: "accepted", clinicApproved: true },
        "Your clinic confirmed this device by code.",
      ],
    ];
    for (const [changes, said] of states) {
      rerender(<PortalDocuments {...props} snapshot={showing(changes)} />);
      expect(screen.getByText(said)).toBeVisible();
      expect(codeBox()).not.toBeInTheDocument();
    }
    rerender(<PortalDocuments {...props} snapshot={showing()} readOnly />);
    expect(codeBox()).not.toBeInTheDocument();
  });

  it("sends the code as typed to the native side only, clears it, and says it was sent", async () => {
    const { bridge, props, rerender, failures } = fixture({
      snapshot: showing(),
    });
    const user = userEvent.setup();
    await user.type(codeBox()!, "482 193 644");
    await user.click(screen.getByRole("button", { name: "Confirm code" }));
    await waitFor(() =>
      expect(bridge.submitApprovalCode).toHaveBeenCalledWith(
        link.id,
        "482 193 644",
      ),
    );
    expect(bridge.submitApprovalCode).toHaveBeenCalledOnce();
    await waitFor(() => expect(props.refresh).toHaveBeenCalled());
    expect(failures).toEqual([]);
    expect(codeBox()).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Code sent. Waiting for your clinic to confirm this device.",
    );
    // The saved state then says so, and the form goes: focus moves to this
    // device's heading, not to the page.
    rerender(
      <PortalDocuments
        {...props}
        snapshot={showing({ approvalCodeSubmitted: true })}
      />,
    );
    expect(codeBox()).not.toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.getElementById(`portal-link-title-${link.id}`),
      ),
    );
  });

  it("says beside it when a code does not match this clinic, and keeps it to correct", async () => {
    const { bridge, failures } = fixture({ snapshot: showing() });
    vi.mocked(bridge.submitApprovalCode!).mockRejectedValueOnce({
      code: "approval_code_mismatch",
      message: "native text",
    });
    const user = userEvent.setup();
    await user.type(codeBox()!, "482193645");
    const confirm = screen.getByRole("button", { name: "Confirm code" });
    await user.click(confirm);
    await waitFor(() => expect(screen.getByText(mismatch)).toBeVisible());
    expect(codeBox()).toHaveAttribute("aria-invalid", "true");
    expect(codeBox()).toHaveAccessibleDescription(`${hint} ${mismatch}`);
    expect(codeBox()).toHaveValue("482193645");
    // Said politely where it is; nothing else is reported, and focus stays.
    expect(screen.getByText(mismatch)).toHaveAttribute("aria-live", "polite");
    expect(failures).toEqual([]);
    expect(document.activeElement).toBe(confirm);
    // Correcting it clears the message.
    await user.type(codeBox()!, "{Backspace}4");
    expect(screen.queryByText(mismatch)).not.toBeInTheDocument();
    expect(codeBox()).not.toHaveAttribute("aria-invalid");
    vi.mocked(bridge.submitApprovalCode!).mockRejectedValueOnce({
      code: "approval_code_format",
    });
    await user.click(confirm);
    expect(
      await screen.findByText(
        "Enter the 9 digits of the code from your clinic's email.",
      ),
    ).toBeVisible();
  });

  it("says when no more codes are taken, and passes other failures on", async () => {
    const { bridge, failures } = fixture({ snapshot: showing() });
    const user = userEvent.setup();
    vi.mocked(bridge.submitApprovalCode!).mockRejectedValueOnce({
      code: "approval_code_locked",
    });
    await user.type(codeBox()!, "482193644");
    await user.click(screen.getByRole("button", { name: "Confirm code" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(locked),
    );
    expect(codeBox()).toHaveValue("");
    expect(failures).toEqual([]);
    const offline = { code: "portal_link_incomplete" };
    vi.mocked(bridge.submitApprovalCode!).mockRejectedValueOnce(offline);
    await user.type(codeBox()!, "482193644");
    await user.click(screen.getByRole("button", { name: "Confirm code" }));
    await waitFor(() => expect(failures).toEqual([offline]));
  });

  it("fits a 360 px window at 200% text, message included", async () => {
    const { bridge } = fixture({ snapshot: showing() });
    vi.mocked(bridge.submitApprovalCode!).mockRejectedValueOnce({
      code: "approval_code_mismatch",
    });
    const user = userEvent.setup();
    await user.type(codeBox()!, "482193645");
    await user.click(screen.getByRole("button", { name: "Confirm code" }));
    await screen.findByText(mismatch);
    await page.viewport(360, 780);
    const oldSize = document.documentElement.style.fontSize;
    try {
      document.documentElement.style.fontSize = "200%";
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
      const button = screen.getByRole("button", { name: "Confirm code" });
      for (const control of [codeBox()!, button]) {
        const box = control.getBoundingClientRect();
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(360);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
      if (import.meta.env.VITE_CAPTURE_PORTAL_UI === "1") {
        const section = screen.getByRole("region", {
          name: "Clinic documents",
        });
        await page.viewport(360, Math.ceil(section.scrollHeight) + 50);
        await page
          .getByRole("region", { name: "Clinic documents" })
          .screenshot({ path: "portal-code-narrow-200.png" });
      }
    } finally {
      document.documentElement.style.fontSize = oldSize;
      await page.viewport(1100, 760);
    }
  });

  it("asks for the code in every supported language", () => {
    fixture({ snapshot: showing() });
    for (const locale of LOCALES) {
      act(() => setLocaleOverride(locale));
      expect(
        screen.getByRole("textbox", {
          name: translate(locale, "portal.codeLabel"),
        }),
      ).toHaveAccessibleDescription(translate(locale, "portal.codeHint"));
      expect(
        screen.getByText(translate(locale, "portal.codeNeeded")),
      ).toBeVisible();
      expect(
        screen.getByRole("button", {
          name: translate(locale, "portal.codeSubmit"),
        }),
      ).toBeVisible();
    }
    act(() => setLocaleOverride(null));
  });
});
