import { t } from "../i18n";
import {
  isRecoveryModeError,
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
 * (a document check gives no time: the default).
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
  try {
    const result = await bridge.checkDocuments!();
    for (const issue of result.issues ?? [])
      if (isRateLimited(issue)) {
        const asked = links.find((link) => link.id === issue.linkId);
        if (asked) waits?.wait(asked.portalBase);
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

/**
 * What the check after unlocking says (#128): nothing when nothing arrived
 * and nothing went wrong, so that unlocking stays quiet; otherwise what Check
 * for new documents would say, and, when something can be tried again, that
 * button. A check that could not finish is told apart from one that found
 * nothing. `counted` names the links the check was for (those the clinic has
 * approved): another link's problem, such as one still waiting for approval,
 * is on its own card under Clinic documents.
 */
export function unlockCheckText(
  result: DocumentCheck,
  counted: (linkId: string) => boolean,
): string {
  const issues = (result.issues ?? []).filter((issue) => counted(issue.linkId));
  const failed = issues.length > 0 || result.receiptsPending > 0;
  const arrived = result.added > 0 || result.refused > 0;
  if (!arrived && !failed) return "";
  const retry = failed ? [checkAgain()] : [];
  if (!arrived)
    return [
      t("portal.unlockCheckIncomplete"),
      ...issueLines(issues),
      ...pendingLines(result),
      ...retry,
    ].join(" ");
  return [
    t("portal.unlockChecked"),
    documentCheckText({ ...result, issues }),
    ...retry,
  ].join(" ");
}

/** The check after unlocking failed as a whole (#128). In read-only
 * recovery there is nothing to try again: the button is off, and the library
 * says what to do. */
export function unlockCheckFailedText(error: unknown): string {
  return [
    t("portal.unlockCheckIncomplete"),
    vaultErrorMessage(error),
    ...(isRecoveryModeError(error) ? [] : [checkAgain()]),
  ].join(" ");
}
