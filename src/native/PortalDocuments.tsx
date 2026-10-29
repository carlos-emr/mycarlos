import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useI18n, type MessageKey } from "../i18n";
import { hasVaultErrorCode, vaultErrorMessage } from "../vault";
import type { VaultBridge, VaultSnapshot, PortalLinkSummary } from "../vault";
import { checkClinicDocuments, documentCheckText } from "./documentCheck";
import { useModalFocus } from "../useModalFocus";
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
  /** Where the "Link another clinic" dialog is drawn: beside the library's
   * other dialogs, outside the page it makes inert while one is open (#145).
   * Without it, the dialog is drawn in place. */
  dialogHost?: HTMLElement | null;
  /** Told when that dialog opens and closes, so the library can make the
   * rest of the page inert (#145). */
  onDialogChange?: (open: boolean) => void;
}

/** "Link another clinic" (#145): the link form in the same dialog as a
 * folder's Rename (#126). Focus goes to the address; Escape, Cancel or a
 * click outside close it, and focus goes back to the button that opened it. */
function LinkClinicDialog({
  disabled,
  firstField,
  onSubmit,
  onClose,
  children,
}: {
  disabled: boolean;
  firstField: RefObject<HTMLInputElement | null>;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);
  useModalFocus(true, dialogRef, onClose, firstField);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="record-dialog native-rename-dialog portal-link-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="portal-link-dialog-title"
        aria-describedby="portal-link-dialog-intro"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h2 id="portal-link-dialog-title">{t("portal.linkAnother")}</h2>
        </header>
        <form onSubmit={onSubmit}>
          <div className="native-rename-fields">
            <p id="portal-link-dialog-intro">{t("portal.intro")}</p>
            <p>{t("portal.connectConsent")}</p>
            {children}
          </div>
          <footer className="dialog-actions">
            <button className="button" type="button" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={disabled}
            >
              {t("portal.link")}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

/** What a device's card says about its approval: a message, or the error
 * an automatic check failed with. Only the saved, verified state says the
 * clinic approved it; what the latest automatic check found (`live`) only
 * describes a request that is still open. */
type CardState = { key: MessageKey } | { failed: unknown };
function cardState(link: PortalLinkSummary, live?: LiveApproval): CardState {
  const say = (key: MessageKey) => ({ key });
  if (link.incomplete) return say("portal.incomplete");
  if (link.clinicApproved)
    return say(
      link.approvalByCode ? "portal.approvedByCode" : "portal.approved",
    );
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
  if (link.approvalStatus === "refused")
    return say(
      link.approvalReason === "code_attempts"
        ? "portal.codeLocked"
        : "portal.approvalRefused",
    );
  if (!link.approvalRequested) return say("portal.notRequested");
  // A check that failed says why; a network failure or a portal asking to
  // wait says only that the state is not known: never that the request
  // expired or was refused.
  if (live?.kind === "failed") return { failed: live.error };
  if (live?.kind === "missing") return say("portal.approvalMissing");
  if (live?.kind === "unreachable") return say("portal.approvalUnreachable");
  if (live?.kind === "refused") return say("portal.approvalUnanswered");
  if (live?.kind === "wait") return say("portal.approvalWait");
  if (link.approvalStatus === "challenge_ready") {
    // The clinic asked for the code it emailed (#141).
    if (!link.approvalByCode) return say("portal.approvalPickedUp");
    if (link.approvalCodeLocked) return say("portal.codeLocked");
    return say(
      link.approvalCodeSubmitted ? "portal.codeSubmitted" : "portal.codeNeeded",
    );
  }
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
  dialogHost,
  onDialogChange,
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
  // "Link another clinic" (#145): its dialog, and where focus goes once a
  // link sent from it is over: the clinic's heading, or else back to the
  // button that opened it.
  const [linkDialog, setLinkDialog] = useState(false);
  const linkAnotherRef = useRef<HTMLButtonElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const returnToLinkAnother = useRef(false);
  // From the moment a link is sent until the work ends, its form (or the
  // dialog's opener) is disabled. Focus that was there waits on the panel's
  // heading, not on the page, and counts as lost when the work ends: it then
  // goes to the new clinic. If no link came of it, focus sent from the
  // panel's form stays on the heading, so the reason (the app's status line)
  // is heard rather than cut off by a focus move, and the form is the next
  // stop. Sent from the dialog, it goes back to Link another clinic (#145),
  // which is not the next stop from the heading.
  const sectionRef = useRef<HTMLElement | null>(null);
  const [linking, setLinking] = useState(false);
  const parked = () => {
    const active = document.activeElement;
    return (
      active === null ||
      active === document.body ||
      active.id === "portal-title"
    );
  };
  // The code each device's clinic emailed, as typed, and what the last try
  // with it found (#141). The code is cleared once it has been sent.
  const [approvalCodes, setApprovalCodes] = useState<Record<string, string>>(
    {},
  );
  const [codeIssues, setCodeIssues] = useState<Record<string, string>>({});
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
    if (parked()) heading.focus();
    returnToLinkAnother.current = false;
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
  // The link form is on the panel until a clinic is linked (an attempt left
  // incomplete is not one). After that, the clinics come first and the form
  // opens from "Link another clinic" (#145).
  const linked = links.some((link) => !link.incomplete);
  // The library makes the page inert while the dialog is open. It is told in
  // the same event that opens or closes the dialog, so that the page is no
  // longer inert when the dialog hands focus back to its button.
  const dialogChange = useRef(onDialogChange);
  dialogChange.current = onDialogChange;
  const showLinkDialog = (open: boolean) => {
    setLinkDialog(open);
    dialogChange.current?.(open);
  };
  useEffect(() => {
    if (!linked && linkDialog) showLinkDialog(false);
  });
  useEffect(() => () => dialogChange.current?.(false), []);
  useEffect(() => {
    if (connecting || focusLink || !returnToLinkAnother.current) return;
    // A refused link leaves the button disabled for a render after
    // `connecting` ends; wait until it can take focus again.
    if (linkAnotherRef.current?.disabled) return;
    returnToLinkAnother.current = false;
    if (parked()) linkAnotherRef.current?.focus();
  }, [connecting, focusLink, busy, working, readOnly]);
  useEffect(() => {
    if (!linking && !connecting) return;
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      (sectionRef.current?.contains(active) && active.matches(":disabled"))
    )
      document.getElementById("portal-title")?.focus();
  }, [linking, connecting, busy, working, readOnly]);
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
  // The control in a code form that had focus when its code was sent
  // (#141), `from`. While the clinic work runs it is disabled, and focus falls
  // to the page. Once the work is over, focus goes to `control`: back to
  // `from`, or, for a code to correct, to the code's field, which says why.
  // If the form has gone (the code was taken, or no more are), it goes to its
  // device's heading. Never while focus is somewhere the patient put it.
  const codeFocus = useRef<{
    linkId: string;
    from: HTMLElement;
    control: HTMLElement;
    done: boolean;
  } | null>(null);
  const [, setCodeDone] = useState(0);
  useEffect(() => {
    const pending = codeFocus.current;
    if (!pending) return;
    const active = document.activeElement;
    // Still on the control that sent the code (the browser may move focus
    // off a disabled control only later) counts as not moved by the patient.
    const lost = active === document.body || active === null;
    const stayed = active === pending.from || active === pending.control;
    if (!lost && !stayed) {
      codeFocus.current = null;
      return;
    }
    if (!pending.done) return;
    const { control, linkId } = pending;
    if (control.isConnected && control.matches(":disabled")) return;
    codeFocus.current = null;
    if (!lost && active === control) return;
    if (control.isConnected) control.focus();
    else document.getElementById(`portal-link-title-${linkId}`)?.focus();
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
  /** Sends the link form; false when nothing was sent. */
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (
      disabled ||
      submitting.current ||
      !code ||
      submittedRevision.current === codeRevision.current
    )
      return false;
    submitting.current = true;
    setLinking(true);
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
        if (shown.current) {
          setFocusLink(result.link.id);
          // The next clinic has its own address: the form opens empty for it.
          setAddress("");
        }
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
      if (shown.current) {
        setConnecting(false);
        setLinking(false);
      }
      polling.restart(known);
    });
    return true;
  };
  const submitFromDialog = (event: FormEvent) => {
    if (!submit(event)) return;
    returnToLinkAnother.current = true;
    showLinkDialog(false);
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
  // The code the clinic emailed for one device's request (#141). The native
  // side checks it against this clinic and sends it only if it matches; the
  // clinic's answer then comes through the automatic checks.
  const submitCode = (event: FormEvent, link: PortalLinkSummary) => {
    event.preventDefault();
    if (disabled || !bridge.submitApprovalCode) return;
    const typed = approvalCodes[link.id] ?? "";
    setCodeIssues((issues) => ({ ...issues, [link.id]: "" }));
    const active = document.activeElement;
    codeFocus.current =
      active instanceof HTMLElement &&
      document.getElementById(`portal-code-form-${link.id}`)?.contains(active)
        ? { linkId: link.id, from: active, control: active, done: false }
        : null;
    polling.hold();
    let known: LiveApproval | undefined;
    void run(async () => {
      const session = waits?.session();
      try {
        await bridge.submitApprovalCode!(link.id, typed);
        known = waitingNow();
        if (shown.current) {
          setApprovalCodes((codes) => ({ ...codes, [link.id]: "" }));
          setStatusLine({ text: t("portal.codeSubmitted") });
        }
      } catch (error) {
        if (isRateLimited(error))
          waits?.wait(link.portalBase, error.retryAfterMs, session);
        // What the code itself met is said beside it; anything else is
        // said as for the other clinic actions.
        const retry = ["approval_code_mismatch", "approval_code_format"].some(
          (code) => hasVaultErrorCode(error, code),
        );
        const final = ["approval_code_locked", "approval_code_not_open"].some(
          (code) => hasVaultErrorCode(error, code),
        );
        if (!retry && !final) throw error;
        if (shown.current) {
          setCodeIssues((issues) => ({
            ...issues,
            [link.id]: vaultErrorMessage(error),
          }));
          // A code to correct: focus goes back to its field, which the
          // error describes, rather than to Confirm code, so the reason is
          // heard however the code was sent.
          const field = document.getElementById(`portal-code-${link.id}`);
          if (retry && field && codeFocus.current?.linkId === link.id)
            codeFocus.current.control = field;
          if (final) {
            // The form may go with the next state: also said in the panel.
            setApprovalCodes((codes) => ({ ...codes, [link.id]: "" }));
            setStatusLine({ text: vaultErrorMessage(error) });
          }
        }
      } finally {
        await refresh();
      }
    }).finally(() => {
      if (codeFocus.current?.linkId === link.id) codeFocus.current.done = true;
      setCodeDone((count) => count + 1);
      polling.restart({ [link.id]: known });
    });
  };
  // The link form's fields: on the panel before a clinic is linked, in the
  // "Link another clinic" dialog after (#145).
  const linkFields = (
    <>
      <label>
        {t("portal.address")}
        <input
          ref={addressRef}
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
    </>
  );
  const linkDialogShown = linkDialog && (
    <LinkClinicDialog
      disabled={disabled}
      firstField={addressRef}
      onSubmit={submitFromDialog}
      onClose={() => showLinkDialog(false)}
    >
      {linkFields}
    </LinkClinicDialog>
  );
  return (
    <section
      className="portal-documents"
      aria-labelledby="portal-title"
      ref={sectionRef}
    >
      {/* Focusable for the check after unlocking, which may disable the
          control that had focus (#128). */}
      <h2
        id="portal-title"
        tabIndex={-1}
        // Where focus waits while a link is made: it says what is happening.
        aria-describedby={linking || connecting ? "portal-status" : undefined}
      >
        {t("portal.title")}
      </h2>
      {!linked && <p>{t("portal.intro")}</p>}
      {!linked && <p>{t("portal.connectConsent")}</p>}
      <p>{t("portal.unlockCheckConsent")}</p>
      {!linked && (
        <form className="native-inline-form" onSubmit={submit}>
          {linkFields}
          <button className="button" type="submit" disabled={disabled}>
            {t("portal.link")}
          </button>
        </form>
      )}
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
        // Each card has the same buttons and fields: each says whose clinic
        // it is for, by the card's heading, as its description.
        const whose = `portal-link-title-${link.id}`;
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
            {!readOnly &&
              !removed &&
              !link.clinicApproved &&
              link.approvalStatus === "challenge_ready" &&
              link.approvalByCode &&
              !link.approvalCodeSubmitted &&
              !link.approvalCodeLocked &&
              bridge.submitApprovalCode && (
                <form
                  className="native-inline-form portal-code-form"
                  id={`portal-code-form-${link.id}`}
                  noValidate
                  onSubmit={(event) => submitCode(event, link)}
                >
                  <label>
                    {t("portal.codeLabel")}
                    <input
                      id={`portal-code-${link.id}`}
                      className="portal-code-input"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={32}
                      value={approvalCodes[link.id] ?? ""}
                      aria-describedby={
                        codeIssues[link.id]
                          ? `portal-code-hint-${link.id} portal-code-issue-${link.id}`
                          : `portal-code-hint-${link.id}`
                      }
                      aria-invalid={codeIssues[link.id] ? true : undefined}
                      onChange={(event) => {
                        const value = event.target.value;
                        setApprovalCodes((codes) => ({
                          ...codes,
                          [link.id]: value,
                        }));
                        setCodeIssues((issues) => ({
                          ...issues,
                          [link.id]: "",
                        }));
                      }}
                      disabled={disabled}
                    />
                  </label>
                  <p id={`portal-code-hint-${link.id}`}>
                    {t("portal.codeHint")}
                  </p>
                  <button
                    className="button"
                    type="submit"
                    disabled={disabled}
                    aria-describedby={whose}
                  >
                    {t("portal.codeSubmit")}
                  </button>
                  <p id={`portal-code-issue-${link.id}`} aria-live="polite">
                    {codeIssues[link.id] ?? ""}
                  </p>
                </form>
              )}
            <label>
              {t("portal.deviceCode")}
              <input
                readOnly
                aria-describedby={whose}
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
              aria-describedby={whose}
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
                aria-describedby={whose}
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
                  aria-describedby={whose}
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
                    aria-describedby={whose}
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
      {linked && (
        <button
          ref={linkAnotherRef}
          className="button"
          type="button"
          aria-haspopup="dialog"
          disabled={disabled}
          onClick={() => showLinkDialog(true)}
        >
          {t("portal.linkAnother")}
        </button>
      )}
      <p role="status" id="portal-status">
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
      {linkDialogShown &&
        (dialogHost
          ? createPortal(linkDialogShown, dialogHost)
          : linkDialogShown)}
    </section>
  );
}
