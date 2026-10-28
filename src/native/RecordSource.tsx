import { useI18n } from "../i18n";
import type { VaultRecord } from "../vault";

/** The source the vault stores on every document it adds (vault.rs
 * MANUAL_IMPORT_LABEL). It is shown by a translated name. That lookup picks
 * the words only: it never decides whether a document is Verified. */
export const MANUAL_IMPORT_LABEL = "Manual import — unverified";

/**
 * Whether a document is Verified, then where it is from (#135). The status
 * comes first, as an element of its own, so that a long source wraps or is
 * cut short after it and can never push it out of view.
 *
 * Only the vault's own check decides the status: `verifiedClinicName` is set
 * when the clinic whose active key signed the delivery is known. The stored
 * source text is shown, never read for trust.
 */
export function RecordSource({
  record,
  className = "",
}: {
  record: Pick<VaultRecord, "verifiedClinicName" | "sourceLabel">;
  className?: string;
}) {
  const { t } = useI18n();
  const clinic = record.verifiedClinicName;
  const source = clinic
    ? t("library.source.clinic", { clinic })
    : record.sourceLabel === MANUAL_IMPORT_LABEL
      ? t("library.source.manualImport")
      : record.sourceLabel;
  return (
    <span
      className={`record-source ${clinic ? "verified" : "unverified"} ${className}`.trim()}
    >
      <span className="record-status">
        {t(clinic ? "library.status.verified" : "library.status.unverified")}
      </span>{" "}
      <span className="record-source-name">{source}</span>
    </span>
  );
}
