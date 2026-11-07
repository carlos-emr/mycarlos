import { t } from "../i18n";
import {
  vaultErrorMessage,
  type PortalLinkSummary,
  type VaultBridge,
  type VaultSnapshot,
} from "../vault";
import { isRateLimited, type PortalWaits } from "./useApprovalPolling";

/** What one check for new clinic documents found. */
export type DocumentCheck = Awaited<
  ReturnType<NonNullable<VaultBridge["checkDocuments"]>>
>;

/**
 * Checks the linked clinics for new documents, then reads the vault again so
 * that what arrived is shown. Everything else is the native pipeline's:
 * approval refresh, download, verification, the original and its history,
 * the saved pickup receipt and the retry of confirmations still owed. Both
 * Check for new documents and the check after unlocking (#128) come here.
 * A portal that asked to wait is not asked again automatically before then
 * (a document check gives no time: the default), unless the reply comes
 * after the session that asked ended: a lock clears the waits, and a reply
 * from before it must not hold back the next session.
 */
export async function checkClinicDocuments({
  bridge,
  links,
  waits,
  refresh,
}: {
  bridge: VaultBridge;
  links: PortalLinkSummary[];
  waits?: PortalWaits;
  refresh: () => Promise<VaultSnapshot>;
}): Promise<{ result: DocumentCheck; vault: VaultSnapshot }> {
  const session = waits?.session();
  try {
    const result = await bridge.checkDocuments!();
    for (const issue of result.issues ?? [])
      if (isRateLimited(issue)) {
        const asked = links.find((link) => link.id === issue.linkId);
        if (asked) waits?.wait(asked.portalBase, undefined, session);
      }
    return { result, vault: await refresh() };
  } catch (error) {
    await refresh();
    throw error;
  }
}

/** Each clinic problem a check found: "Clinic: what went wrong". */
const issueLines = (issues: NonNullable<DocumentCheck["issues"]>) =>
  issues.map((issue) =>
    t("portal.clinicIssue", {
      clinic: issue.clinicName,
      detail: vaultErrorMessage({
        code: issue.code,
        message: t("portal.errorIncomplete"),
      }),
    }),
  );

/** Saved documents whose pickup the portal has not confirmed yet. */
const pendingLines = ({ receiptsPending }: DocumentCheck) =>
  receiptsPending > 0
    ? [t("portal.confirmationsPending", { count: receiptsPending })]
    : [];

/** What a check found, as Check for new documents says it. */
export function documentCheckText(result: DocumentCheck): string {
  const issues = result.issues ?? [];
  return [
    t(issues.length ? "portal.partialResult" : "portal.result", {
      added: result.added,
      refused: result.refused,
    }),
    ...issueLines(issues),
    ...pendingLines(result),
  ].join(" ");
}

const checkAgain = () => t("portal.checkAgain", { button: t("portal.check") });

/** Problems that checking again cannot help, or that ask not to check
 * again yet: what they say is what to do. */
const NO_RETRY = new Set([
  "portal_rate_limited",
  "portal_device_removed",
  "approval_refused",
  "approval_expired",
  "approval_cancelled",
  "approval_contact_clinic",
  "approval_missing",
  "approval_reply_invalid",
  "approval_still_open",
  "pickup_refused",
  "portal_link_disabled",
  "portal_link_unavailable",
  "recovery_mode",
]);
const retryHelps = (error: unknown) => {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code !== "string" || !NO_RETRY.has(code);
};

/**
 * What the check after unlocking says (#128): nothing when nothing arrived
 * and nothing went wrong, so that unlocking stays quiet. What arrived is
 * said as Check for new documents says it. When nothing was saved, only what
 * needs attention is said: a document that could not be verified (which the
 * portal offers again at every unlock, as no receipt is sent for it), or why
 * the check could not finish, told apart from one that found nothing. The
 * button is named only when checking again can help, and not twice.
 * `counted` names the links the check speaks for (those the clinic has
 * approved): a device still waiting for approval has its state on its own
 * card under Clinic documents. A device the portal removed is said whatever
 * its approval: that is not a state of waiting, and nothing but linking it
 * again can help.
 */
export function unlockCheckText(
  result: DocumentCheck,
  counted: (linkId: string) => boolean,
): string {
  const issues = (result.issues ?? []).filter(
    (issue) => counted(issue.linkId) || issue.code === "portal_device_removed",
  );
  const pending = result.receiptsPending > 0;
  if (!result.added && !result.refused && !issues.length && !pending) return "";
  // The pickup confirmation line already says to check again.
  const retry =
    !pending && issues.some((issue) => retryHelps(issue)) ? [checkAgain()] : [];
  if (result.added > 0)
    return [
      t("portal.unlockChecked"),
      documentCheckText({ ...result, issues }),
      ...retry,
    ].join(" ");
  return [
    t(
      issues.length || pending
        ? "portal.unlockCheckIncomplete"
        : "portal.unlockChecked",
    ),
    ...(result.refused > 0
      ? [t("portal.unlockRefused", { count: result.refused })]
      : []),
    ...issueLines(issues),
    ...pendingLines(result),
    ...retry,
  ].join(" ");
}

/** The check after unlocking failed as a whole (#128). The button is named
 * only when checking again can help: not in read-only recovery, for one. */
export function unlockCheckFailedText(error: unknown): string {
  return [
    t("portal.unlockCheckIncomplete"),
    vaultErrorMessage(error),
    ...(retryHelps(error) ? [checkAgain()] : []),
  ].join(" ");
}

/** The check after unlocking found the native side busy twice, and did not
 * run (#128). */
export function unlockCheckNotRunText(): string {
  return [t("portal.unlockCheckNotRun"), checkAgain()].join(" ");
}

/** The check after unlocking did not run: a linked portal had asked to
 * wait (#128). Checking again now could not help. */
export function unlockCheckWaitingText(): string {
  return t("portal.unlockCheckWaiting");
}
