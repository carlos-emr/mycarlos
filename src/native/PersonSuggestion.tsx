import { Icon } from "../Icon";
import type { PatientProfile } from "../vault";

/** Prototype: a shared document whose patient name matches exactly one
 * person is offered to them. It is never moved without the patient's Move. */
export function PersonSuggestion({
  person,
  documentName,
  busy,
  onMove,
  onDismiss,
}: {
  person: PatientProfile;
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
        Looks like this is for <strong>{person.displayName}</strong> (the name
        on the document matches). Move it to {person.displayName}'s records?
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
