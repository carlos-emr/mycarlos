import { useEffect, useRef, useState, type FormEvent } from "react";
import { useI18n, type MessageKey } from "../i18n";
import { hasVaultErrorCode, vaultErrorMessage } from "../vault";
import type { VaultBridge, VaultSnapshot, PortalLinkSummary } from "../vault";
import { checkClinicDocuments, documentCheckText } from "./documentCheck";
import {
  isAwaitingApproval,
  isRateLimited,
  timeLeft,
  useApprovalPolling,
  waitingNow,
  type CheckChange,
  type LiveApproval,
  type PollApproval,
  type PortalWaits,
} from "./useApprovalPolling";

interface Props {
  bridge: VaultBridge;
  snapshot: VaultSnapshot;
  busy: boolean;
  working?: boolean;
  readOnly: boolean;
  run: (operation: () => Promise<void>) => Promise<void>;
  /** Checks a device's approval status quietly; given to the clinic setup
   * view only, which then refreshes it automatically while open (#131). */
  poll?: PollApproval;
  /** The session's per-portal waits after a portal asked to wait (#131). */
  waits?: PortalWaits;
  refresh: () => Promise<VaultSnapshot>;
  setNotice: (text: string) => void;
  compact?: boolean;
}

/** What a device's card says about its approval: a message, or the error
 * an automatic check failed with. Only the saved, verified state says the
 * clinic approved it; what the latest automatic check found (`live`) only
 * describes a request that is still open. */
type CardState = { key: MessageKey } | { failed: unknown };
function cardState(link: PortalLinkSummary, live?: LiveApproval): CardState {
  const say = (key: MessageKey) => ({ key });
  if (link.incomplete) return say("portal.incomplete");
  if (link.clinicApproved) return say("portal.approved");
  if (link.approvalRequestLimitReached) return say("portal.approvalContact");
  if (link.approvalStatus === "expired")
    return say("portal.approvalExpiredCard");
  if (link.approvalStatus === "cancelled")
    return say("portal.approvalCancelled");
  if (
    link.approvalStatus === "accepted" ||
    ["staff_required", "no_accepted_approver"].includes(
      link.approvalReason ?? "",
    )
  )
    return say("portal.approvalContact");
  if (link.approvalStatus === "refused") return say("portal.approvalRefused");
  if (!link.approvalRequested) return say("portal.notRequested");
  // A check that failed says why; a network failure or a portal asking to
  // wait says only that the state is not known: never that the request
  // expired or was refused.
  if (live?.kind === "failed") return { failed: live.error };
  if (live?.kind === "missing") return say("portal.approvalMissing");
  if (live?.kind === "unreachable") return say("portal.approvalUnreachable");
  if (live?.kind === "refused") return say("portal.approvalUnanswered");
  if (live?.kind === "wait") return say("portal.approvalWait");
  if (link.approvalStatus === "challenge_ready")
    return say("portal.approvalPickedUp");
  if (live?.kind === "waiting") return say("portal.awaitingClinic");
  return say("portal.awaiting");
}
/** Two card states are the same when they say the same thing. */
function sameState(a: CardState, b: CardState): boolean {
  if ("key" in a || "key" in b)
    return "key" in a && "key" in b && a.key === b.key;
  const code = (value: unknown) =>
    typeof value === "object" && value !== null
      ? (value as { code?: unknown }).code
      : value;
  return code(a.failed) === code(b.failed);
}

export function PortalDocuments({
  bridge,
  snapshot,
  busy,
  working = false,
  readOnly,
  run,
  poll,
  waits,
  refresh,
  setNotice,
  compact = false,
}: Props) {
  const { t } = useI18n();
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [device, setDevice] = useState("myCarlos");
  const [person, setPerson] = useState("");
  // The panel's own status line: a copy result, or what an automatic check
  // found that changed. Read out politely; nothing here takes focus. A
  // check's change is already on the device's card, so it is only heard.
  const [statusLine, setStatusLine] = useState<{
    text: string;
    heardOnly?: boolean;
  }>({ text: "" });
  const [connecting, setConnecting] = useState(false);
  const [focusLink, setFocusLink] = useState<string | null>(null);
  const submitting = useRef(false);
  const codeRevision = useRef(0);
  const submittedRevision = useRef<number | null>(null);
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    void bridge
      .platform()
      .then((platform) => {
        const os: Record<string, string> = {
          windows: "Windows",
          macos: "macOS",
          linux: "Linux",
          android: "Android",
          ios: "iOS",
        };
        if (shown.current && os[platform])
          setDevice((current) =>
            current === "myCarlos" ? `myCarlos on ${os[platform]}` : current,
          );
      })
      .catch(() => {});
    return () => {
      shown.current = false;
    };
  }, [bridge]);
  useEffect(() => {
    if (connecting || !focusLink) return;
    const heading = document.getElementById(`portal-link-title-${focusLink}`);
    if (!heading) return;
    if (document.activeElement === document.body) heading.focus();
    setFocusLink(null);
  }, [connecting, focusLink, snapshot.portalLinks]);
  useEffect(() => {
    // The status line goes back to its own text when clinic work ends; an
    // earlier "copied", or an earlier check's change, must not be read out
    // again then.
    if (connecting || working) setStatusLine({ text: "" });
  }, [connecting, working]);
  const available = Boolean(
    snapshot.portalLinkingEnabled &&
      bridge.connectPortal &&
      bridge.checkDocuments,
  );
  const links = snapshot.portalLinks ?? [];
  const stateText = (state: CardState) =>
    "key" in state ? t(state.key) : vaultErrorMessage(state.failed);
  // A control an automatic check is about to remove or disable, if it has
  // focus: focus then goes to its device's heading, not to the page.
  const checkFocus = useRef<{
    linkId: string;
    control: Element;
    // The check put the vault into read-only recovery: the render that
    // disables the control comes after the app reads the vault again.
    untilReadOnly: boolean;
  } | null>(null);
  // Said once, when an automatic check changes what a card says (#131). A
  // check that finds nothing new says nothing; nor does the first check
  // confirming that the portal has a request the card already calls saved.
  const said = ({ before, after, recovery }: CheckChange) => {
    const focused = document.activeElement;
    if (
      focused &&
      document.getElementById(`portal-link-${after.link.id}`)?.contains(focused)
    )
      checkFocus.current = {
        linkId: after.link.id,
        control: focused,
        untilReadOnly: recovery === true,
      };
    const was = cardState(before.link, before.live);
    const now = cardState(after.link, after.live);
    if (
      sameState(was, now) ||
      ("key" in was &&
        "key" in now &&
        was.key === "portal.awaiting" &&
        now.key === "portal.awaitingClinic")
    )
      return;
    setStatusLine({
      text:
        links.length > 1
          ? t("portal.clinicIssue", {
              clinic: after.link.clinicName ?? after.link.portalBase,
              detail: stateText(now),
            })
          : stateText(now),
      heardOnly: true,
    });
  };
  useEffect(() => {
    // After the render that follows a check: was the focused control removed
    // or disabled by it? Only then is focus moved, and only to that device.
    const remembered = checkFocus.current;
    if (!remembered) return;
    const { linkId, control, untilReadOnly } = remembered;
    const active = document.activeElement;
    if (active !== control && active !== document.body && active !== null) {
      checkFocus.current = null;
      return;
    }
    if (untilReadOnly && !readOnly) return;
    checkFocus.current = null;
    if (control.isConnected && !(control as HTMLButtonElement).disabled) return;
    document.getElementById(`portal-link-title-${linkId}`)?.focus();
  });
  const polling = useApprovalPolling({
    links,
    poll,
    waits,
    enabled: available && !compact && !readOnly,
    busy: busy || connecting || working,
    onChange: said,
  });
  if (!available) return null;
  const terminal = (link: PortalLinkSummary) =>
    ["refused", "expired", "cancelled", "accepted"].includes(
      link.approvalStatus ?? "",
    );
  const disabled = busy || readOnly || connecting || working;
  const check = () => {
    polling.hold();
    // What this check found for each open request: the portal has it,
    // unless the check names a problem with that device's clinic.
    let known: Record<string, LiveApproval | undefined> = {};
    void run(async () => {
      const { result, vault: next } = await checkClinicDocuments({
        bridge,
        links,
        waits,
        refresh,
      });
      known = Object.fromEntries(
        (next.portalLinks ?? []).map((link) => [
          link.id,
          isAwaitingApproval(link) &&
          !result.issues?.some((issue) => issue.linkId === link.id)
            ? waitingNow()
            : undefined,
        ]),
      );
      // Reported after leaving this view too, as for connecting.
      setNotice(documentCheckText(result));
    }).finally(() => polling.restart(known));
  };
  const checkButton = (
    <button
      className="button"
      type="button"
      disabled={disabled || !links.some((link) => !link.incomplete)}
      onClick={check}
    >
      {t(working && compact ? "portal.working" : "portal.check")}
    </button>
  );
  if (compact) return links.length > 0 ? checkButton : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (
      disabled ||
      submitting.current ||
      !code ||
      submittedRevision.current === codeRevision.current
    )
      return;
    submitting.current = true;
    const revision = codeRevision.current;
    const previousIds = new Set(links.map((link) => link.id));
    polling.hold();
    let known: Record<string, LiveApproval | undefined> = {};
    void run(async () => {
      // A reply after a lock is not the next session's wait (#128).
      const session = waits?.session();
      submittedRevision.current = revision;
      if (shown.current) {
        setConnecting(true);
        // Native owns the transient code from this point. A repeated callback
        // cannot reuse this form attempt, even before React paints the clear.
        setCode("");
      }
      try {
        const result = await bridge.connectPortal!({
          portalBase: address,
          code,
          deviceName: device,
          profileId: person || null,
        });
        await refresh();
        if (shown.current) setFocusLink(result.link.id);
        // The portal answered the request: it has it open (#131).
        known = {
          [result.link.id]: result.approvalError ? undefined : waitingNow(),
        };
        if (isRateLimited(result.approvalError))
          waits?.wait(
            result.link.portalBase,
            result.approvalError.retryAfterMs,
            session,
          );
        // Reported even after the patient has left this view: the link exists
        // whether or not anyone is looking, and the line must not keep an
        // older error beside it. The setter drops it for a finished session.
        // A partial result gives the reason first, then where to look: the
        // reason's "try again" means the saved request, not a new link.
        setNotice(
          result.approvalError
            ? `${vaultErrorMessage(result.approvalError)} ${t("portal.linkedApprovalIssue")}`
            : t("portal.connected"),
        );
      } catch (error) {
        const next = await refresh();
        const attempt = next.portalLinks?.find(
          (link) => !previousIds.has(link.id),
        );
        if (shown.current && attempt) setFocusLink(attempt.id);
        throw error;
      }
    }).finally(() => {
      submitting.current = false;
      if (shown.current) setConnecting(false);
      polling.restart(known);
    });
  };
  // The patient's own request or restart for one device: it finishes before
  // automatic checks begin again, and an answer from the portal means it has
  // the request open.
  const requestAction = (
    link: PortalLinkSummary,
    send: (linkId: string) => Promise<void>,
  ) => {
    polling.hold();
    let known: LiveApproval | undefined;
    void run(async () => {
      const session = waits?.session();
      try {
        await send(link.id);
        known = waitingNow();
      } catch (error) {
        if (isRateLimited(error))
          waits?.wait(link.portalBase, error.retryAfterMs, session);
        throw error;
      } finally {
        await refresh();
      }
    }).finally(() => polling.restart({ [link.id]: known }));
  };
  return (
    <section className="portal-documents" aria-labelledby="portal-title">
      {/* Focusable for the check after unlocking, which may disable the
          control that had focus (#128). */}
      <h2 id="portal-title" tabIndex={-1}>
        {t("portal.title")}
      </h2>
      <p>{t("portal.intro")}</p>
      <p>{t("portal.connectConsent")}</p>
      <p>{t("portal.unlockCheckConsent")}</p>
      <form className="native-inline-form" onSubmit={submit}>
        <label>
          {t("portal.address")}
          <input
            type="url"
            required
            value={address}
            maxLength={1024}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => setAddress(e.target.value)}
            disabled={disabled}
          />
        </label>
        <label>
          {t("portal.code")}
          <input
            type="text"
            required
            value={code}
            maxLength={64}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            onChange={(e) => {
              codeRevision.current += 1;
              setCode(e.target.value);
            }}
            disabled={disabled}
          />
        </label>
        <label>
          {t("portal.deviceName")}
          <input
            required
            value={device}
            maxLength={64}
            onChange={(e) => setDevice(e.target.value)}
            disabled={disabled}
          />
        </label>
        <label>
          {t("portal.person")}
          <select
            value={person}
            onChange={(e) => setPerson(e.target.value)}
            disabled={disabled}
          >
            <option value="">{t("portal.matchPerson")}</option>
            {snapshot.profiles
              .filter((p) => p.id !== snapshot.sharedProfileId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
          </select>
        </label>
        <p>{t("portal.routing")}</p>
        <button className="button" type="submit" disabled={disabled}>
          {t("portal.link")}
        </button>
      </form>
      {links.map((link) => {
        const live = polling.live[link.id];
        // By the portal's clock, never this device's (#131).
        const left = isAwaitingApproval(link)
          ? timeLeft(live, polling.now)
          : null;
        // The latest check says the portal removed this device: neither a
        // retry nor a new request can work until it is connected again.
        const removed =
          live?.kind === "failed" &&
          hasVaultErrorCode(live.error, "portal_device_removed");
        return (
          <div
            className="portal-link"
            id={`portal-link-${link.id}`}
            key={link.id}
          >
            <h3 id={`portal-link-title-${link.id}`} tabIndex={-1}>
              {link.clinicName ?? link.portalBase}
            </h3>
            <p className="portal-address">{link.portalBase}</p>
            <p>{stateText(cardState(link, live))}</p>
            {left !== null && (
              <p>
                {left > 0
                  ? t("portal.approvalTimeLeft", {
                      count: Math.ceil(left / 60_000),
                    })
                  : // A new request may start by the portal's clock;
                    // otherwise "checking" only while checks run.
                    link.approvalCanRestart
                    ? t("portal.approvalTimeOverRestart", {
                        button: t("portal.restartApproval"),
                      })
                    : t(
                        polling.checking?.has(link.id)
                          ? "portal.approvalTimeUp"
                          : "portal.approvalTimeOver",
                      )}
              </p>
            )}
            {polling.checking?.has(link.id) && (
              <p>{t("portal.autoChecking")}</p>
            )}
            {!readOnly &&
              isAwaitingApproval(link) &&
              ((polling.stopped && live?.kind !== "missing") ||
                (live?.kind === "failed" &&
                  // Checking again cannot help a removed device.
                  !hasVaultErrorCode(live.error, "portal_device_removed"))) && (
                <p>
                  {t("portal.autoCheckStopped", { button: t("portal.check") })}
                </p>
              )}
            <label>
              {t("portal.deviceCode")}
              <input
                readOnly
                value={link.deviceKeyId}
                spellCheck={false}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
              />
            </label>
            <button
              className="button"
              type="button"
              disabled={disabled}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(link.deviceKeyId)
                  .then(() => setStatusLine({ text: t("portal.copied") }))
                  .catch(() => setStatusLine({ text: t("portal.copyFailed") }));
                if (!navigator.clipboard)
                  setStatusLine({ text: t("portal.copyFailed") });
              }}
            >
              {t("portal.copy")}
            </button>
            <label>
              {t("portal.fingerprint")}
              <textarea
                readOnly
                value={link.deviceFingerprint}
                rows={4}
                spellCheck={false}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
              />
            </label>
            {!link.incomplete && !link.clinicApproved && (
              <>
                <p>{t("portal.compare")}</p>
                <button
                  className="button"
                  type="button"
                  disabled={
                    disabled ||
                    removed ||
                    terminal(link) ||
                    !bridge.requestDeviceApproval
                  }
                  onClick={() =>
                    requestAction(link, bridge.requestDeviceApproval!)
                  }
                >
                  {t(
                    link.approvalRequested
                      ? "portal.retryApproval"
                      : "portal.requestApproval",
                  )}
                </button>
                {/* Offered once the request has ended; not while the portal's
                  clock still gives it time, whatever this device's says. */}
                {link.approvalCanRestart && !(left !== null && left > 0) && (
                  <button
                    className="button"
                    type="button"
                    disabled={
                      disabled || removed || !bridge.restartDeviceApproval
                    }
                    onClick={() =>
                      requestAction(link, bridge.restartDeviceApproval!)
                    }
                  >
                    {t("portal.restartApproval")}
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}
      <p role="status">
        {connecting ? (
          t("portal.connecting")
        ) : working ? (
          t("portal.working")
        ) : statusLine.heardOnly ? (
          <span className="sr-only">{statusLine.text}</span>
        ) : (
          statusLine.text
        )}
      </p>
      {checkButton}
    </section>
  );
}
