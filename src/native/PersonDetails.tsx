import { useState } from "react";
import type { PatientProfile, PersonDetails } from "../vault";
import { dateText } from "./clinicLinks";
import { NAME_INPUT_MAX_LENGTH, nameTooLong } from "./recordPresentation";

/** Today on this device, `YYYY-MM-DD`, as a date field gives it. */
function today(): string {
  const now = new Date();
  const two = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** Why these details cannot be kept, or "" when they can. */
export function detailsProblem({
  fullName = "",
  birthDate = "",
}: PersonDetails) {
  if (nameTooLong(fullName)) return "This full name is too long. Shorten it.";
  if (birthDate > today()) return "A birth date cannot be in the future.";
  return "";
}

/** The details as kept: blanks are left out. */
export function trimmedDetails({
  fullName = "",
  birthDate = "",
}: PersonDetails): PersonDetails {
  return {
    ...(fullName.trim() ? { fullName: fullName.trim() } : {}),
    ...(birthDate ? { birthDate } : {}),
  };
}

/** Prototype (Ben, 21 Oct): a person's optional full name and birth date,
 * used only on this device to suggest who a shared document is for. */
export function PersonDetailsFields({
  idPrefix,
  details,
  onChange,
}: {
  idPrefix: string;
  details: PersonDetails;
  onChange: (details: PersonDetails) => void;
}) {
  const problem = detailsProblem(details);
  return (
    <>
      <label>
        Full name, as on clinic documents (optional)
        <input
          id={`${idPrefix}-full-name`}
          maxLength={NAME_INPUT_MAX_LENGTH}
          autoComplete="off"
          value={details.fullName ?? ""}
          onChange={(event) =>
            onChange({ ...details, fullName: event.target.value })
          }
        />
      </label>
      <label>
        Birth date (optional)
        <input
          id={`${idPrefix}-birth-date`}
          type="date"
          max={today()}
          value={details.birthDate ?? ""}
          onChange={(event) =>
            onChange({ ...details, birthDate: event.target.value })
          }
        />
      </label>
      <p className="native-person-details-help">
        Used only on this device, to suggest who a shared document is for.
      </p>
      {problem && <p role="alert">{problem}</p>}
    </>
  );
}

/** Prototype: each person's details, which can be changed at any time. */
export function PersonDetailsList({
  people,
  busy,
  onSave,
}: {
  people: PatientProfile[];
  busy: boolean;
  onSave: (profileId: string, details: PersonDetails) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<{
    profileId: string;
    details: PersonDetails;
  } | null>(null);
  return (
    <ul className="native-person-details-list" aria-label="People's details">
      {people.map((person) =>
        editing?.profileId === person.id ? (
          <li key={person.id}>
            <form
              aria-label={`Details for ${person.displayName}`}
              onSubmit={(event) => {
                event.preventDefault();
                if (detailsProblem(editing.details)) return;
                void onSave(person.id, trimmedDetails(editing.details)).then(
                  (saved) => {
                    if (saved) setEditing(null);
                  },
                );
              }}
            >
              <strong>{person.displayName}</strong>
              <PersonDetailsFields
                idPrefix={`person-${person.id}`}
                details={editing.details}
                onChange={(details) =>
                  setEditing({ profileId: person.id, details })
                }
              />
              <span className="native-person-details-actions">
                <button
                  className="button"
                  disabled={busy || Boolean(detailsProblem(editing.details))}
                >
                  Save details
                </button>
                <button
                  className="button"
                  type="button"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </button>
              </span>
            </form>
          </li>
        ) : (
          <li key={person.id}>
            <span>
              <strong>{person.displayName}</strong>
              {" · "}
              {person.fullName || "No full name"}
              {" · "}
              {person.birthDate
                ? `born ${dateText(person.birthDate)}`
                : "No birth date"}
            </span>
            <button
              className="button"
              type="button"
              disabled={busy}
              aria-label={`Edit details for ${person.displayName}`}
              onClick={() =>
                setEditing({
                  profileId: person.id,
                  details: {
                    fullName: person.fullName ?? "",
                    birthDate: person.birthDate ?? "",
                  },
                })
              }
            >
              Edit details
            </button>
          </li>
        ),
      )}
    </ul>
  );
}
