import { t } from "../i18n";
import type { ReceiveNotice } from "../vault";

/** The existing shared-file announcement, also used for an outcome held until unlock. */
export function sharedAddedText(count: number): string {
  return count > 0 ? t("interface.notice.sharedAdded", { count }) : "";
}

/** No user content is interpreted as a translation template. */
export function receiveNoticeText({
  dropped,
  refusedShares,
}: ReceiveNotice): string {
  return [
    refusedShares > 0
      ? t("interface.receive.refused", { count: refusedShares })
      : "",
    dropped > 0 ? t("interface.receive.dropped", { count: dropped }) : "",
  ]
    .filter(Boolean)
    .join(" ");
}
