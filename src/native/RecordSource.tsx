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
  record: Pick<
    VaultRecord,
    | "verifiedClinicName"
    | "sourceLabel"
    | "fileSaysCheckedAtMs"
    | "signatureKeyRevoked"
    | "clinicName"
  >;
  className?: string;
}) {
  const { t, locale } = useI18n();
  // What a handover file says of its own evidence (#360): plain words, no check mark and no
  // "Verified", since anyone who holds the file's key can write it.
  const claim =
    !record.verifiedClinicName &&
    // Not beside "Signature key revoked by the clinic": one status line, not two (#88).
    record.signatureKeyRevoked !== true &&
    record.fileSaysCheckedAtMs !== undefined &&
    Number.isFinite(new Date(record.fileSaysCheckedAtMs).getTime())
      ? t("library.fileSaysChecked", {
          date: new Date(record.fileSaysCheckedAtMs).toLocaleDateString(
            locale,
            { year: "numeric", month: "long", day: "numeric" },
          ),
        })
      : "";
  const clinic = record.verifiedClinicName;
  // The clinic revoked the key that signed it (#88): not Verified, and it says why. The source
  // line stays as an unverified document's, and the words do not call the document false.
  const keyRevoked = !clinic && record.signatureKeyRevoked === true;
  const source = clinic
    ? t("library.source.clinic", { clinic })
    : keyRevoked && record.clinicName
      ? t("library.source.clinic", { clinic: record.clinicName })
      : record.sourceLabel === MANUAL_IMPORT_LABEL
        ? t("library.source.manualImport")
        : record.sourceLabel;
  return (
    <span
      className={`record-source ${clinic ? "verified" : "unverified"} ${className}`.trim()}
    >
      <span className="record-status">
        {t(
          clinic
            ? "library.status.verified"
            : keyRevoked
              ? "library.status.keyRevoked"
              : "library.status.unverified",
        )}
      </span>{" "}
      <span className="record-source-name">{source}</span>
      {claim && (
        <>
          {" "}
          <span className="record-file-claim">{claim}</span>
        </>
      )}
    </span>
  );
}
