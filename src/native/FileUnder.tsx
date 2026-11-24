import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { ClinicPatient, PatientProfile } from "../vault";
import { MAX_NAME_CHARS } from "./recordPresentation";
import { useModalFocus } from "../useModalFocus";

// File under… (#340 phase 1): a clinic document waiting in Shared with me, filed under a person
// the patient chooses. Nothing is chosen for them, and nothing is saved to a person's details
// unless they tick the box that says exactly what will be saved.

const BIRTH_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A name as the vault compares it: trimmed, in Unicode NFC. Case and spelling are never folded. */
const normalName = (name: string) => name.trim().normalize("NFC");

/** What to offer for this person from the clinic's words: only a field the person has none of,
 * only a value the vault would accept, trimmed and in NFC; and nothing at all, with a warning,
 * when the person already has a name or birth date that differs from the clinic's. */
export function fileUnderPlan(
  person: Pick<PatientProfile, "fullName" | "birthDate" | "previousFullNames">,
  clinic: ClinicPatient,
): { fill: { fullName?: string; birthDate?: string }; differs: boolean } {
  const name = normalName(clinic.name);
  const known = [person.fullName, ...(person.previousFullNames ?? [])]
    .filter((candidate): candidate is string => Boolean(candidate?.trim()))
    .map(normalName);
  const differs =
    (known.length > 0 && !known.includes(name)) ||
    (Boolean(person.birthDate) && person.birthDate !== clinic.birthDate);
  if (differs) return { fill: {}, differs };
  return {
    differs,
    fill: {
      ...(!person.fullName?.trim() &&
      name !== "" &&
      [...name].length <= MAX_NAME_CHARS
        ? { fullName: name }
        : {}),
      ...(!person.birthDate && BIRTH_DATE.test(clinic.birthDate)
        ? { birthDate: clinic.birthDate }
        : {}),
    },
  };
}

/** Whether the next documents from this clinic would file themselves under `person`: not when
 * the clinic link is tied to someone else (a hidden person included), nor when someone else matches the same words (two
 * matches leave a document in Shared with me). */
export function filesOnItsOwn(personId: string, clinic: ClinicPatient) {
  return (
    !clinic.linkedToHidden &&
    (clinic.linkPerson === undefined || clinic.linkPerson === personId) &&
    (clinic.matchingPeople ?? []).every((id) => id === personId)
  );
}

export function FileUnderDialog({
  documentName,
  clinic,
  people,
  busy,
  onConfirm,
  onCancel,
}: {
  documentName: string;
  clinic: ClinicPatient;
  /** The people the document may be filed under: not Shared with me, never a hidden person. */
  people: PatientProfile[];
  busy: boolean;
  onConfirm: (profileId: string, saveDetails: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  // Nobody is chosen for the patient.
  const [profileId, setProfileId] = useState("");
  // Never ticked for the patient: saving details is a choice they make.
  const [save, setSave] = useState(false);
  useModalFocus(true, dialogRef, onCancel, selectRef);
  const person = people.find((candidate) => candidate.id === profileId);
  const plan = person ? fileUnderPlan(person, clinic) : null;
  const fill = plan?.fill ?? {};
  const offered = Object.keys(fill).length > 0;
  const onItsOwn = person ? filesOnItsOwn(person.id, clinic) : true;
  useEffect(() => setSave(false), [profileId]);
  const what =
    fill.fullName !== undefined && fill.birthDate !== undefined
      ? t("fileUnder.what.both", { name: fill.fullName, date: fill.birthDate })
      : fill.fullName !== undefined
        ? t("fileUnder.what.name", { name: fill.fullName })
        : fill.birthDate !== undefined
          ? t("fileUnder.what.date", { date: fill.birthDate })
          : "";
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        ref={dialogRef}
        className="record-dialog native-file-under"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-under-title"
        aria-describedby="file-under-about"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h2 id="file-under-title">
            {t("fileUnder.title", { document: documentName })}
          </h2>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && person) onConfirm(person.id, save && offered);
          }}
        >
          <p id="file-under-about">
            {t("fileUnder.clinicWords", {
              name: clinic.name,
              date: clinic.birthDate,
            })}{" "}
            {t("fileUnder.rule")}
          </p>
          <label>
            {t("fileUnder.person")}
            <select
              ref={selectRef}
              value={profileId}
              disabled={busy}
              onChange={(event) => setProfileId(event.target.value)}
            >
              <option value="" disabled>
                {t("fileUnder.choose")}
              </option>
              {people.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.displayName}
                </option>
              ))}
            </select>
          </label>
          {person && plan?.differs && (
            <p role="alert">{t("fileUnder.differs")}</p>
          )}
          {person && offered && (
            <label className="restore-choice">
              <input
                type="checkbox"
                checked={save}
                disabled={busy}
                onChange={(event) => setSave(event.target.checked)}
              />
              <span>
                {t(
                  onItsOwn
                    ? "fileUnder.saveDetails"
                    : "fileUnder.saveDetailsOnly",
                  { what, person: person.displayName },
                )}
              </span>
            </label>
          )}
          {person && !onItsOwn && <p>{t("fileUnder.notOnItsOwn")}</p>}
          <footer className="dialog-actions">
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={onCancel}
            >
              {t("common.cancel")}
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={busy || !person}
            >
              {person
                ? t("fileUnder.confirm", { person: person.displayName })
                : t("fileUnder.choose")}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
