import { useCallback, useEffect, useRef, useState } from "react";
import type { PortalApprovalCheck, PortalLinkSummary } from "../vault";

/** What one automatic status check came to (#131): what the portal said, a
 * failure to say on screen, or null when it did not run (other clinic work
 * was under way, the vault was locking, or the session had ended). */
export type ApprovalPoll =
  | { check: PortalApprovalCheck }
  | { error: unknown }
  | null;

/** Runs one quiet status check of a linked device's approval. */
export type PollApproval = (linkId: string) => Promise<ApprovalPoll>;

/** What the latest automatic check in this view found for an open request.
 * Only the saved, verified state ever says the clinic approved the device. */
export type LiveApproval =
  /** The portal has the request open. `expiresInMs` is the time it leaves
   * it, by the portal's own clock when it replied, at `at` (the page's own
   * steady clock). */
  | { kind: "waiting"; expiresInMs: number | null; at: number }
  /** The portal could not be reached, or the check failed on this device:
   * the request's state is not known. Never shown as expired or refused. */
  | { kind: "unreachable" }
  /** The portal asked myCarlos to check less often. */
  | { kind: "wait" }
  /** The portal does not have the saved request: it must be sent again,
   * which only the patient does. */
  | { kind: "missing" };

/** The first check comes this long after the view opens or a request is
 * saved; later ones back off, and never come sooner than the first. */
export const CHECK_DELAYS_MS = [10_000, 20_000, 40_000, 60_000] as const;
/** Automatic checks stop this long after they began (the view opened, or the
 * patient last acted): a request lasts about 10 minutes. */
export const CHECK_WINDOW_MS = 15 * 60_000;
/** After the request's time runs out by the portal's clock, the portal is
 * asked again this soon, for its own word on it. */
export const AFTER_EXPIRY_MS = 2_000;
/** Back on screen after a pause, a check that was due comes this soon. */
const RESUME_MS = 1_000;
/** A countdown on screen moves this often. It is not read out. */
const COUNTDOWN_STEP_MS = 15_000;

/** The page's steady clock: unlike the wall clock, it does not jump when the
 * device's time is changed. */
const steadyNow = () => performance.now();

/** The portal answered the patient's own request: it has it open, with no
 * time known until the next check. */
export const waitingNow = (): LiveApproval => ({
  kind: "waiting",
  expiresInMs: null,
  at: steadyNow(),
});

/** A request that is saved and still open, as far as the saved state says. */
export function isAwaitingApproval(link: PortalLinkSummary): boolean {
  return (
    !link.incomplete &&
    link.approvalRequested &&
    !link.clinicApproved &&
    ["pending", "challenge_ready"].includes(link.approvalStatus ?? "pending")
  );
}

/** How long until the next automatic check: the backoff step, no sooner
 * than the portal asked, and soon after the request's time runs out by the
 * portal's clock. */
export function nextCheckDelay(
  step: number,
  { retryAfterMs = 0, untilExpiryMs = null }: NextCheck = {},
): number {
  let delay: number =
    CHECK_DELAYS_MS[Math.min(step, CHECK_DELAYS_MS.length - 1)];
  if (untilExpiryMs !== null && untilExpiryMs > 0)
    delay = Math.min(delay, untilExpiryMs + AFTER_EXPIRY_MS);
  return Math.max(delay, retryAfterMs);
}
interface NextCheck {
  retryAfterMs?: number;
  untilExpiryMs?: number | null;
}

/** The time a waiting request has left by the portal's clock, now. */
export function timeLeft(live: LiveApproval | undefined, now: number) {
  return live?.kind === "waiting" && live.expiresInMs !== null
    ? live.expiresInMs - (now - live.at)
    : null;
}

const hasCode = (value: unknown, code: string) =>
  typeof value === "object" &&
  value !== null &&
  (value as { code?: unknown }).code === code;

/** What a check said about one link: its saved state and what was found. */
function found(
  outcome: Exclude<ApprovalPoll, null>,
  at: number,
): { link?: PortalLinkSummary; live?: LiveApproval; retryAfterMs: number } {
  if ("error" in outcome) {
    // Another clinic operation took the native guard first: nothing is
    // known or said; the next check comes as planned.
    if (hasCode(outcome.error, "portal_busy")) return { retryAfterMs: 0 };
    return { live: { kind: "unreachable" }, retryAfterMs: 0 };
  }
  const { link, issue, expiresInMs } = outcome.check;
  if (issue) {
    if (hasCode(issue, "approval_missing"))
      return { link, live: { kind: "missing" }, retryAfterMs: 0 };
    if (hasCode(issue, "portal_rate_limited"))
      return {
        link,
        live: { kind: "wait" },
        retryAfterMs: Math.max(issue.retryAfterMs ?? 0, 0),
      };
    return { link, live: { kind: "unreachable" }, retryAfterMs: 0 };
  }
  return {
    link,
    live: isAwaitingApproval(link)
      ? {
          kind: "waiting",
          expiresInMs:
            typeof expiresInMs === "number" && expiresInMs >= 0
              ? expiresInMs
              : null,
          at,
        }
      : undefined,
    retryAfterMs: 0,
  };
}

/** One link's state before and after a check, for the view to say what
 * changed. */
export interface CheckChange {
  before: { link: PortalLinkSummary; live?: LiveApproval };
  after: { link: PortalLinkSummary; live?: LiveApproval };
}

/**
 * Refreshes the approval status of linked devices awaiting it while the
 * clinic view is open (#131): on a bounded schedule with backoff, only while
 * the page is visible, never two at once, and never in place of the
 * patient's own clinic actions (the check is skipped for them). Checks only
 * read: they never send, re-send or start a request. A check that ends after
 * the view closed, or a newer schedule began, is ignored here.
 */
export function useApprovalPolling({
  links,
  poll,
  enabled,
  busy,
  onChange,
}: {
  links: PortalLinkSummary[];
  poll?: PollApproval;
  /** The view is the clinic setup view of a writable vault. */
  enabled: boolean;
  /** A library or clinic operation is running: checks wait for it. */
  busy: boolean;
  onChange: (change: CheckChange) => void;
}) {
  const [live, setLive] = useState<Record<string, LiveApproval>>({});
  const [stopped, setStopped] = useState(false);
  const [schedule, setSchedule] = useState(0);
  const [visible, setVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  const [, setCountdownStep] = useState(0);
  const linksRef = useRef(links);
  linksRef.current = links;
  const liveRef = useRef(live);
  liveRef.current = live;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const stepRef = useRef(0);
  // The patient's own clinic work is under way (see `hold`).
  const heldRef = useRef(false);
  // When the latest check began (or the view opened, or the patient acted),
  // and when this run of checks began.
  const lastStartRef = useRef(steadyNow());
  const windowStartRef = useRef(lastStartRef.current);

  useEffect(() => {
    const onVisibility = () =>
      setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const watched = links.filter(
    (link) => isAwaitingApproval(link) && live[link.id]?.kind !== "missing",
  );
  const active =
    enabled && Boolean(poll) && visible && !stopped && watched.length > 0;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: number | undefined;
    const later = (delay: number) => {
      timer = window.setTimeout(() => void tick(), delay);
    };
    const tick = async () => {
      if (cancelled) return;
      if (steadyNow() - windowStartRef.current >= CHECK_WINDOW_MS) {
        setStopped(true);
        return;
      }
      // A library operation may hold the vault, and the patient's own clinic
      // work comes first: check after either.
      if (busyRef.current || heldRef.current) {
        later(nextCheckDelay(stepRef.current));
        return;
      }
      lastStartRef.current = steadyNow();
      let retryAfterMs = 0;
      for (const link of linksRef.current) {
        if (
          !isAwaitingApproval(link) ||
          liveRef.current[link.id]?.kind === "missing"
        )
          continue;
        const outcome = await pollRef.current?.(link.id);
        // The view closed, the page was hidden, or the patient acted: this
        // reply is not this schedule's to show.
        if (cancelled) return;
        if (!outcome) continue;
        const before = { link, live: liveRef.current[link.id] };
        const result = found(outcome, steadyNow());
        retryAfterMs = Math.max(retryAfterMs, result.retryAfterMs);
        if (!result.link && !result.live) continue;
        const next = { ...liveRef.current };
        if (result.live) next[link.id] = result.live;
        else delete next[link.id];
        liveRef.current = next;
        setLive(next);
        onChangeRef.current({
          before,
          after: { link: result.link ?? link, live: result.live },
        });
      }
      if (cancelled) return;
      stepRef.current += 1;
      const lefts = Object.values(liveRef.current)
        .map((entry) => timeLeft(entry, steadyNow()))
        .filter((left): left is number => left !== null && left > 0);
      later(
        nextCheckDelay(stepRef.current, {
          retryAfterMs,
          untilExpiryMs: lefts.length ? Math.min(...lefts) : null,
        }),
      );
    };
    later(
      Math.max(
        CHECK_DELAYS_MS[0] - (steadyNow() - lastStartRef.current),
        RESUME_MS,
      ),
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, schedule]);

  // A countdown on screen moves quietly; only state changes are said.
  const counting = Object.values(live).some(
    (entry) => entry.kind === "waiting" && entry.expiresInMs !== null,
  );
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(
      () => setCountdownStep((step) => step + 1),
      COUNTDOWN_STEP_MS,
    );
    return () => window.clearInterval(timer);
  }, [counting]);

  /** The patient started clinic work: a check under way is no longer this
   * schedule's to show, and none starts until `restart`. */
  const hold = useCallback(() => {
    heldRef.current = true;
    lastStartRef.current = steadyNow();
    setSchedule((value) => value + 1);
  }, []);

  /** The patient's clinic work ended: a new run of checks begins. `known`
   * is what that work established, by link (`undefined`: nothing is known
   * now); what earlier checks found for other links is kept. */
  const restart = useCallback(
    (known: Record<string, LiveApproval | undefined> = {}) => {
      const next = { ...liveRef.current };
      for (const [linkId, value] of Object.entries(known)) {
        if (value) next[linkId] = value;
        else delete next[linkId];
      }
      liveRef.current = next;
      setLive(next);
      heldRef.current = false;
      stepRef.current = 0;
      lastStartRef.current = steadyNow();
      windowStartRef.current = lastStartRef.current;
      setStopped(false);
      setSchedule((value) => value + 1);
    },
    [],
  );

  return {
    live,
    /** The steady clock as this render shows it, for time left. */
    now: steadyNow(),
    /** The links checked automatically now, or null when checks are off. */
    checking: active ? new Set(watched.map((link) => link.id)) : null,
    stopped,
    hold,
    restart,
  };
}
