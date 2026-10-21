import { Icon } from "../Icon";
import type { PatientProfile } from "../vault";
import type { MatchedBy } from "./personMatch";

const WHY: Record<MatchedBy, string> = {
  birthDate: "the birth date on the document matches",
  birthDateAndName: "the birth date and name on the document match",
  name: "the name on the document matches",
};

/** Prototype: a shared document whose patient name matches exactly one
 * person is offered to them. It is never moved without the patient's Move. */
export function PersonSuggestion({
  person,
  matchedBy,
  documentName,
  busy,
  onMove,
  onDismiss,
}: {
  person: PatientProfile;
  /** What told the person apart (birth date first, Ben, 21 Oct). */
  matchedBy: MatchedBy;
  documentName: string;
  busy: boolean;
  onMove: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="native-person-suggestion"
      role="group"
      aria-label={`Suggested person for ${documentName}`}
    >
      <Icon name="info" />
      <span>
        Looks like this is for <strong>{person.displayName}</strong> (
        {WHY[matchedBy]}). Move it to {person.displayName}'s records?
      </span>
      <span className="native-person-suggestion-actions">
        <button
          className="button"
          type="button"
          disabled={busy}
          aria-label={`Move ${documentName} to ${person.displayName}'s records`}
          onClick={onMove}
        >
          Move
        </button>
        <button
          className="button"
          type="button"
          disabled={busy}
          aria-label={`Not this person: ${documentName}`}
          onClick={onDismiss}
        >
          Not this person
        </button>
      </span>
    </div>
  );
}
