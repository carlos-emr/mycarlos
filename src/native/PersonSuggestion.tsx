import { useI18n } from "../i18n";
import type { PatientProfile } from "../vault";
import type { MatchedBy } from "./personMatch";
export function PersonSuggestion({
  person,
  matchedBy,
  documentName,
  busy,
  onMove,
  onDismiss,
}: {
  person: PatientProfile;
  matchedBy: MatchedBy;
  documentName: string;
  busy: boolean;
  onMove: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const why = t(
    matchedBy === "birthDate"
      ? "personSuggestion.byDate"
      : matchedBy === "birthDateAndName"
        ? "personSuggestion.byBoth"
        : "personSuggestion.byName",
  );
  return (
    <div
      className="native-person-suggestion"
      role="group"
      aria-label={t("personSuggestion.for", { document: documentName })}
    >
      <span>
        {t("personSuggestion.offer", { name: person.displayName, why })}
      </span>
      <span className="native-person-suggestion-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          aria-label={t("personSuggestion.moveLabel", {
            document: documentName,
            name: person.displayName,
          })}
          onClick={onMove}
        >
          {t("personSuggestion.move")}
        </button>
        <button
          type="button"
          className="button"
          disabled={busy}
          aria-label={t("personSuggestion.dismissLabel", {
            document: documentName,
          })}
          onClick={onDismiss}
        >
          {t("personSuggestion.dismiss")}
        </button>
      </span>
    </div>
  );
}
