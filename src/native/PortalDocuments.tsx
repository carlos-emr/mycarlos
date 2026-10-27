import { useEffect, useRef, useState, type FormEvent } from "react";
import { useI18n, type MessageKey } from "../i18n";
import { vaultErrorMessage } from "../vault";
import type { VaultBridge, VaultSnapshot, PortalLinkSummary } from "../vault";
import {
  isAwaitingApproval,
  timeLeft,
  useApprovalPolling,
  waitingNow,
  type CheckChange,
  type LiveApproval,
  type PollApproval,
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
  refresh: () => Promise<VaultSnapshot>;
  setNotice: (text: string) => void;
  compact?: boolean;
}

/** What a device's card says about its approval. Only the saved, verified
 * state says the clinic approved it; what the latest automatic check found
 * (`live`) only describes a request that is still open. */
function approvalKey(link: PortalLinkSummary, live?: LiveApproval): MessageKey {
  if (link.incomplete) return "portal.incomplete";
  if (link.clinicApproved) return "portal.approved";
  if (link.approvalRequestLimitReached) return "portal.approvalContact";
  if (link.approvalStatus === "expired") return "portal.approvalExpired";
  if (link.approvalStatus === "cancelled") return "portal.approvalCancelled";
  if (
    link.approvalStatus === "accepted" ||
    ["staff_required", "no_accepted_approver"].includes(
      link.approvalReason ?? "",
    )
  )
    return "portal.approvalContact";
  if (link.approvalStatus === "refused") return "portal.approvalRefused";
  if (!link.approvalRequested) return "portal.notRequested";
  // A network failure or a portal asking to wait says only that the state
  // is not known: never that the request expired or was refused.
  if (live?.kind === "missing") return "portal.approvalMissing";
  if (live?.kind === "unreachable") return "portal.approvalUnreachable";
  if (live?.kind === "wait") return "portal.approvalWait";
  if (link.approvalStatus === "challenge_ready")
    return "portal.approvalStarted";
  if (live?.kind === "waiting") return "portal.awaitingClinic";
  return "portal.awaiting";
}

export function PortalDocuments({
  bridge,
  snapshot,
  busy,
  working = false,
  readOnly,
  run,
  poll,
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
  // Said once, when an automatic check changes what a card says (#131). A
  // check that finds nothing new says nothing; nor does the first check
  // confirming that the portal has a request the card already calls saved.
  const said = ({ before, after }: CheckChange) => {
    const was = approvalKey(before.link, before.live);
    const now = approvalKey(after.link, after.live);
    if (
      was === now ||
      (was === "portal.awaiting" && now === "portal.awaitingClinic")
    )
      return;
    setStatusLine({
      text:
        links.length > 1
          ? t("portal.clinicIssue", {
              clinic: after.link.clinicName ?? after.link.portalBase,
              detail: t(now),
            })
          : t(now),
      heardOnly: true,
    });
  };
  const polling = useApprovalPolling({
    links,
    poll,
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
      try {
        const result = await bridge.checkDocuments!();
        const next = await refresh();
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
        setNotice(
          [
            t(
              result.issues?.length ? "portal.partialResult" : "portal.result",
              {
                added: result.added,
                refused: result.refused,
              },
            ),
            ...(result.issues ?? []).map((issue) =>
              t("portal.clinicIssue", {
                clinic: issue.clinicName,
                detail: vaultErrorMessage({
                  code: issue.code,
                  message: t("portal.errorIncomplete"),
                }),
              }),
            ),
            ...(result.receiptsPending > 0
              ? [
                  t("portal.confirmationsPending", {
                    count: result.receiptsPending,
                  }),
                ]
              : []),
          ].join(" "),
        );
      } catch (error) {
        await refresh();
        throw error;
      }
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
      try {
        await send(link.id);
        known = waitingNow();
      } finally {
        await refresh();
      }
    }).finally(() => polling.restart({ [link.id]: known }));
  };
  return (
    <section className="portal-documents" aria-labelledby="portal-title">
      <h2 id="portal-title">{t("portal.title")}</h2>
      <p>{t("portal.intro")}</p>
      <p>{t("portal.connectConsent")}</p>
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
        return (
          <div className="portal-link" key={link.id}>
            <h3 id={`portal-link-title-${link.id}`} tabIndex={-1}>
              {link.clinicName ?? link.portalBase}
            </h3>
            <p className="portal-address">{link.portalBase}</p>
            <p>{t(approvalKey(link, live))}</p>
            {left !== null && (
              <p>
                {left > 0
                  ? t("portal.approvalTimeLeft", {
                      count: Math.ceil(left / 60_000),
                    })
                  : t("portal.approvalTimeUp")}
              </p>
            )}
            {polling.checking?.has(link.id) && (
              <p>{t("portal.autoChecking")}</p>
            )}
            {polling.stopped &&
              !readOnly &&
              isAwaitingApproval(link) &&
              live?.kind !== "missing" && (
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
                    disabled || terminal(link) || !bridge.requestDeviceApproval
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
                    disabled={disabled || !bridge.restartDeviceApproval}
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
