import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../useModalFocus";
import { useI18n, type MessageKey } from "../i18n";
import {
  localDateText,
  type PatientProfile,
  type PersonDetails,
} from "../vault";
import { NAME_INPUT_MAX_LENGTH, nameTooLong } from "./recordPresentation";

export function detailsProblem(
  details: PersonDetails,
  birthDateUnknown = false,
): MessageKey | null {
  if (!details.fullName?.trim()) return "personDetails.fullNameRequired";
  if (nameTooLong(details.fullName ?? "")) return "personDetails.nameTooLong";
  if (!details.birthDate && !birthDateUnknown)
    return "personDetails.birthDateRequired";
  if (details.birthDate) {
    const date = details.birthDate;
    const parsed = new Date(`${date}T12:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      date.startsWith("0000") ||
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== date
    )
      return "personDetails.invalidDate";
    if (date > localDateText(new Date())) return "personDetails.futureDate";
  }
  return null;
}
export function trimmedDetails(details: PersonDetails): PersonDetails {
  return {
    ...(details.fullName?.trim() ? { fullName: details.fullName.trim() } : {}),
    ...(details.birthDate ? { birthDate: details.birthDate } : {}),
  };
}
export function PersonDetailsFields({
  details,
  onChange,
  birthDateUnknown,
  onBirthDateUnknownChange,
}: {
  details: PersonDetails;
  onChange: (details: PersonDetails) => void;
  birthDateUnknown: boolean;
  onBirthDateUnknownChange: (unknown: boolean) => void;
}) {
  const { t } = useI18n();
  const problem = detailsProblem(details, birthDateUnknown);
  return (
    <>
      <label>
        {t("personDetails.fullName")}
        <input
          autoComplete="off"
          maxLength={NAME_INPUT_MAX_LENGTH}
          required
          value={details.fullName ?? ""}
          onChange={(e) => onChange({ ...details, fullName: e.target.value })}
        />
      </label>
      <label>
        {t("personDetails.birthDate")}
        <input
          type="date"
          max={localDateText(new Date())}
          required={!birthDateUnknown}
          disabled={birthDateUnknown}
          value={details.birthDate ?? ""}
          onChange={(e) => onChange({ ...details, birthDate: e.target.value })}
        />
      </label>
      <label className="native-person-date-unknown">
        <input
          type="checkbox"
          checked={birthDateUnknown}
          onChange={(e) => {
            onBirthDateUnknownChange(e.target.checked);
            if (e.target.checked) onChange({ ...details, birthDate: "" });
          }}
        />
        <span>{t("personDetails.birthDateUnknown")}</span>
      </label>
      <p>{t("personDetails.help")}</p>
      {problem && <p role="alert">{t(problem)}</p>}
    </>
  );
}
/** Draws a dialog in the library's dialog host, beside its other dialogs and
 * outside the page it makes inert; without a host, in place. */
export function inDialogHost(dialog: ReactNode, host?: HTMLElement | null) {
  return host ? createPortal(dialog, host) : dialog;
}

/** Adding a profile, or editing a person's details, in a dialog (Ben, 29 Oct):
 * the same box as Rename. Focus goes to its first field; Escape, Cancel or a
 * click outside close it, and focus goes back to the button that opened it.
 * A refusal is shown inside it, as the page behind it is inert. */
export function PersonDialog({
  titleId,
  title,
  submitText,
  submitDisabled,
  busy,
  refusal,
  onSubmit,
  onClose,
  children,
}: {
  titleId: string;
  title: string;
  submitText: string;
  submitDisabled: boolean;
  busy: boolean;
  refusal?: string;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);
  const close = () => {
    if (!busy) onClose();
  };
  useModalFocus(true, dialogRef, close);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={close}>
      <section
        ref={dialogRef}
        className="record-dialog native-rename-dialog native-person-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h2 id={titleId}>{title}</h2>
        </header>
        <form onSubmit={onSubmit}>
          <div className="native-rename-fields">
            {children}
            {refusal && <p role="alert">{refusal}</p>}
          </div>
          <footer className="dialog-actions">
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={close}
            >
              {t("common.cancel")}
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={submitDisabled}
            >
              {submitText}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function PersonDetailsList({
  people,
  busy,
  onSave,
  focusId = null,
  onFocusLeft,
}: {
  people: PatientProfile[];
  busy: boolean;
  onSave: (profileId: string, details: PersonDetails) => Promise<boolean>;
  /** A person just added: focus goes to their line (Ben, 29 Oct). */
  focusId?: string | null;
  onFocusLeft?: () => void;
}) {
  const { t } = useI18n();
  const lines = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    if (focusId) lines.current.get(focusId)?.focus();
  }, [focusId, people]);
  const [editing, setEditing] = useState<{
    id: string;
    details: PersonDetails;
    birthDateUnknown: boolean;
  } | null>(null);
  return (
    <ul
      className="native-person-details-list"
      aria-label={t("personDetails.list")}
    >
      {people.map((person) => (
        <li key={person.id}>
          {editing?.id === person.id ? (
            <form
              aria-label={t("personDetails.for", { name: person.displayName })}
              onSubmit={(e) => {
                e.preventDefault();
                if (
                  busy ||
                  detailsProblem(editing.details, editing.birthDateUnknown)
                )
                  return;
                void onSave(person.id, trimmedDetails(editing.details)).then(
                  (saved) => {
                    if (saved) setEditing(null);
                  },
                );
              }}
            >
              <strong>{person.displayName}</strong>
              <fieldset disabled={busy}>
                <PersonDetailsFields
                  details={editing.details}
                  onChange={(details) =>
                    setEditing((current) => current && { ...current, details })
                  }
                  birthDateUnknown={editing.birthDateUnknown}
                  onBirthDateUnknownChange={(birthDateUnknown) =>
                    setEditing(
                      (current) => current && { ...current, birthDateUnknown },
                    )
                  }
                />
                <div className="native-person-details-actions">
                  <button
                    className="button"
                    disabled={
                      busy ||
                      Boolean(
                        detailsProblem(
                          editing.details,
                          editing.birthDateUnknown,
                        ),
                      )
                    }
                  >
                    {t("personDetails.save")}
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    {t("personDetails.cancel")}
                  </button>
                </div>
              </fieldset>
            </form>
          ) : (
            <>
              {/* Focusable only while it is the place focus was sent to. */}
              <span
                ref={(line) => {
                  if (line) lines.current.set(person.id, line);
                  else lines.current.delete(person.id);
                }}
                tabIndex={focusId === person.id ? -1 : undefined}
                onBlur={() => {
                  if (focusId === person.id) onFocusLeft?.();
                }}
              >
                <strong>{person.displayName}</strong>
                {" · "}
                {person.fullName || t("personDetails.noName")}
                {" · "}
                {person.birthDate || t("personDetails.noDate")}
              </span>
              <button
                className="button"
                type="button"
                disabled={busy}
                aria-label={t("personDetails.editFor", {
                  name: person.displayName,
                })}
                onClick={() =>
                  setEditing({
                    id: person.id,
                    details: {
                      fullName: person.fullName,
                      birthDate: person.birthDate,
                    },
                    birthDateUnknown: !person.birthDate,
                  })
                }
              >
                {t("personDetails.edit")}
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
