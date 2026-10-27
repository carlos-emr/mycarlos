import type { ReceiveNotice } from "../vault";

/** The existing shared-file announcement, also used for an outcome held until unlock. */
export function sharedAddedText(count: number): string {
  if (count <= 0) return "";
  return count === 1
    ? "A shared file was added to Shared with me."
    : `${count} shared files were added to Shared with me.`;
}

/** What to tell the patient about shared items that could not be received,
 * or "" when everything shared was received. */
export function receiveNoticeText({
  dropped,
  refusedShares,
}: ReceiveNotice): string {
  const parts: string[] = [];
  if (refusedShares > 0)
    parts.push(
      `${refusedShares === 1 ? "A share was" : `${refusedShares} shares were`} not received: no more than 100 shared files can wait at once. Unlock, so the waiting files go into Shared with me, then share again.`,
    );
  if (dropped > 0)
    parts.push(
      `${dropped === 1 ? "One shared item was" : `${dropped} shared items were`} not received: myCarlos accepts PDF files only.`,
    );
  return parts.join(" ");
}
