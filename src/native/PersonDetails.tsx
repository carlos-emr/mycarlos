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
  showProblem = true,
}: {
  details: PersonDetails;
  onChange: (details: PersonDetails) => void;
  birthDateUnknown: boolean;
  onBirthDateUnknownChange: (unknown: boolean) => void;
  /** Whether to say what is missing yet: Edit details always does; where
   * the details can wait, only once the patient has started on them. */
  showProblem?: boolean;
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
      {problem && showProblem && <p role="alert">{t(problem)}</p>}
    </>
  );
}
/** A person's details where they can wait (#234, Ben's decision): at vault
 * creation and when a person is added. "Later" leaves them out; a reminder
 * then stays until they are added (`missingDetails`). */
export function PersonDetailsOrLater({
  details,
  onChange,
  birthDateUnknown,
  onBirthDateUnknownChange,
  later,
  onLaterChange,
  otherwiseReady,
}: {
  details: PersonDetails;
  onChange: (details: PersonDetails) => void;
  birthDateUnknown: boolean;
  onBirthDateUnknownChange: (unknown: boolean) => void;
  later: boolean;
  onLaterChange: (later: boolean) => void;
  /** The rest of the form is ready, so only these details hold it back:
   * then what is missing is said even before they are started. */
  otherwiseReady: boolean;
}) {
  const { t } = useI18n();
  // Nothing in red before the patient starts on the details (they may wait).
  const [started, setStarted] = useState(false);
  return (
    <fieldset className="native-person-details-setup">
      <legend>{t("personDetails.setup")}</legend>
      <label className="native-person-date-unknown">
        <input
          type="checkbox"
          checked={later}
          onChange={(e) => onLaterChange(e.target.checked)}
        />
        <span>{t("personDetails.later")}</span>
      </label>
      {!later && (
        <PersonDetailsFields
          details={details}
          onChange={(next) => {
            setStarted(true);
            onChange(next);
          }}
          birthDateUnknown={birthDateUnknown}
          onBirthDateUnknownChange={(unknown) => {
            setStarted(true);
            onBirthDateUnknownChange(unknown);
          }}
          showProblem={started || otherwiseReady}
        />
      )}
    </fieldset>
  );
}

/** What a person's details still need before the reminder goes (#234): a
 * full name. A birth date may be marked unknown, which Edit details saves as
 * no date beside a full name, so a full name alone is complete. */
export function missingDetails(person: PatientProfile): boolean {
  return !person.fullName?.trim();
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
  formLabel,
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
  /** The form's own name, when it says more than the title. */
  formLabel?: string;
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
        <form aria-label={formLabel} onSubmit={onSubmit}>
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
  readOnly = false,
  onSave,
  openFor,
  focusId = null,
  onFocusLeft,
  dialogHost,
  onDialogChange,
  refusalText = "",
}: {
  people: PatientProfile[];
  busy: boolean;
  readOnly?: boolean;
  onSave: (profileId: string, details: PersonDetails) => Promise<boolean>;
  /** Opens this person's form, with the focus in it: the library's reminder
   * leads here (#234). A new object each time, so the same person can be
   * asked for again. */
  openFor?: { profileId: string } | null;
  /** A person just added: focus goes to their line (Ben, 29 Oct). */
  focusId?: string | null;
  onFocusLeft?: () => void;
  /** Where the Edit details dialog is drawn, and who is told when it opens
   * and closes (see SecuritySettings). */
  dialogHost?: HTMLElement | null;
  onDialogChange?: (open: boolean) => void;
  /** What the vault said when it refused the details: shown in the dialog. */
  refusalText?: string;
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
  // Return to the Edit details button after closing, or to the person's
  // line if the vault became read-only while the dialog was open.
  const [refused, setRefused] = useState(false);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const dialogChange = useRef(onDialogChange);
  dialogChange.current = onDialogChange;
  const showEdit = (next: typeof editing) => {
    setEditing(next);
    setRefused(false);
    dialogChange.current?.(next !== null);
  };
  useEffect(() => () => dialogChange.current?.(false), []);
  // A person's Edit details dialog, as their own button and the library's
  // reminder open it. A person with no details yet (a profile just made)
  // starts with the date box open; "unknown" is ticked only once a full name
  // was saved without a date.
  const showEditFor = (person: PatientProfile) =>
    showEdit({
      id: person.id,
      details: { fullName: person.fullName, birthDate: person.birthDate },
      birthDateUnknown: !person.birthDate && Boolean(person.fullName),
    });
  // The library's reminder opens this person's Edit details dialog (#234),
  // which puts the focus in its first box.
  useEffect(() => {
    const person = people.find((p) => p.id === openFor?.profileId);
    if (person) showEditFor(person);
    // `people` only finds the person asked for: a refresh must not reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFor]);
  useEffect(() => {
    if (!returnTo || busy) return;
    const button = editButtons.current.get(returnTo);
    if (button && !button.disabled) button.focus();
    else lines.current.get(returnTo)?.focus();
    setReturnTo(null);
  }, [returnTo, busy, readOnly]);
  const editedPerson = editing
    ? people.find((person) => person.id === editing.id)
    : undefined;
  const editDialog = editing && editedPerson && (
    <PersonDialog
      titleId="edit-person-details-title"
      title={t("personDetails.edit")}
      submitText={t("personDetails.save")}
      formLabel={t("personDetails.for", { name: editedPerson.displayName })}
      busy={busy}
      submitDisabled={
        busy ||
        readOnly ||
        Boolean(detailsProblem(editing.details, editing.birthDateUnknown))
      }
      refusal={refused ? refusalText : ""}
      onSubmit={(e) => {
        e.preventDefault();
        if (
          busy ||
          readOnly ||
          detailsProblem(editing.details, editing.birthDateUnknown)
        )
          return;
        const id = editing.id;
        setRefused(false);
        void onSave(id, trimmedDetails(editing.details)).then((saved) => {
          if (saved) {
            showEdit(null);
            setReturnTo(id);
          } else setRefused(true);
        });
      }}
      onClose={() => {
        setReturnTo(editing.id);
        showEdit(null);
      }}
    >
      <strong>{editedPerson.displayName}</strong>
      <fieldset disabled={busy || readOnly}>
        <PersonDetailsFields
          details={editing.details}
          onChange={(details) => {
            setEditing((current) => current && { ...current, details });
            setRefused(false);
          }}
          birthDateUnknown={editing.birthDateUnknown}
          // A tick is a change too: it clears a refusal, as typing does.
          onBirthDateUnknownChange={(birthDateUnknown) => {
            setEditing(
              (current) => current && { ...current, birthDateUnknown },
            );
            setRefused(false);
          }}
        />
      </fieldset>
    </PersonDialog>
  );
  return (
    <>
      <ul
        className="native-person-details-list"
        aria-label={t("personDetails.list")}
      >
        {people.map((person) => (
          <li key={person.id}>
            {/* A programmatic focus target; never an extra Tab stop. */}
            <span
              ref={(line) => {
                if (line) lines.current.set(person.id, line);
                else lines.current.delete(person.id);
              }}
              tabIndex={-1}
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
              disabled={busy || readOnly}
              aria-label={t("personDetails.editFor", {
                name: person.displayName,
              })}
              aria-haspopup="dialog"
              ref={(button) => {
                if (button) editButtons.current.set(person.id, button);
                else editButtons.current.delete(person.id);
              }}
              onClick={() => showEditFor(person)}
            >
              {t("personDetails.edit")}
            </button>
          </li>
        ))}
      </ul>
      {editDialog && inDialogHost(editDialog, dialogHost)}
    </>
  );
}
