import { useI18n } from "../i18n";
import type { PortalLinkSummary } from "../vault";

/** A clinic's documents that failed their checks (#143). They are not
 * downloaded and refused again at each check or unlock; Try again forgets
 * them, so the next check checks them again. */
export function RefusedDeliveries({
  link,
  disabled,
  onTryAgain,
}: {
  link: PortalLinkSummary;
  disabled: boolean;
  onTryAgain?: () => void;
}) {
  const { t } = useI18n();
  const count = link.refusedDeliveries ?? 0;
  if (count === 0) return null;
  const id = `portal-refused-${link.id}`;
  return (
    <div className="portal-refused">
      <p id={id}>{t("portal.refusedDocuments", { count })}</p>
      {onTryAgain && (
        <button
          className="button"
          type="button"
          disabled={disabled}
          aria-label={t("portal.tryAgainFor", {
            clinic: link.clinicName ?? link.portalBase,
          })}
          aria-describedby={id}
          onClick={onTryAgain}
        >
          {t("portal.tryAgain")}
        </button>
      )}
    </div>
  );
}
