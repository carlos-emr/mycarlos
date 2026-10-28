import { t } from "../i18n";
import type { ReceiveNotice } from "../vault";

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
