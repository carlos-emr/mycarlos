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
  const previous = details.previousFullNames;
  if (
    previous &&
    (previous.length > 16 ||
      previous.some(
        (name) =>
          !name.trim() ||
          nameTooLong(name.trim()) ||
          /[\u0000-\u001f\u007f-\u009f]/u.test(name),
      ) ||
      new Set(previous.map((name) => name.trim())).size !== previous.length)
  )
    return "personDetails.previousInvalid";
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
    ...(details.previousFullNames !== undefined
      ? {
          previousFullNames: details.previousFullNames.map((name) =>
            name.trim(),
          ),
        }
      : {}),
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
function PreviousFullNames({
  details,
  onChange,
}: {
  details: PersonDetails;
  onChange: (details: PersonDetails) => void;
}) {
  const { t } = useI18n();
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const add = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const names = details.previousFullNames ?? [];
  useEffect(() => {
    if (pendingFocus.current !== null) {
      (inputs.current[pendingFocus.current] ?? add.current)?.focus();
      pendingFocus.current = null;
    }
  }, [names]);
  return (
    <section
      className="previous-full-names"
      aria-label={t("personDetails.previousTitle")}
    >
      <h3>{t("personDetails.previousTitle")}</h3>
      <p>{t("personDetails.previousHelp")}</p>
      {names.map((name, index) => (
        <div key={index}>
          <label>
            {t("personDetails.previousEntry", { number: index + 1 })}
            <input
              ref={(node) => {
                inputs.current[index] = node;
              }}
              value={name}
              required
              maxLength={NAME_INPUT_MAX_LENGTH}
              autoComplete="off"
              onChange={(event) =>
                onChange({
                  ...details,
                  previousFullNames: names.map((value, i) =>
                    i === index ? event.target.value : value,
                  ),
                })
              }
            />
          </label>
          <button
            className="button"
            type="button"
            aria-label={t("personDetails.previousRemove", {
              number: index + 1,
            })}
            onClick={() => {
              pendingFocus.current = index;
              onChange({
                ...details,
                previousFullNames: names.filter((_, i) => i !== index),
              });
            }}
          >
            {t("personDetails.previousRemove", { number: index + 1 })}
          </button>
        </div>
      ))}
      <button
        className="button"
        type="button"
        ref={add}
        disabled={names.length >= 16}
        onClick={() => {
          pendingFocus.current = names.length;
          onChange({ ...details, previousFullNames: [...names, ""] });
        }}
      >
        {t("personDetails.previousAdd")}
      </button>
    </section>
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
    originalFullName: string;
    suggestionDismissed: boolean;
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
  const changeDetails = (details: PersonDetails) => {
    setEditing((current) => {
      if (!current) return current;
      const original = current.originalFullName;
      const dismissed =
        current.suggestionDismissed ||
        Boolean(
          original &&
            current.details.previousFullNames?.includes(original) &&
            !details.previousFullNames?.includes(original),
        );
      const names = details.previousFullNames ?? [];
      const suggest =
        !dismissed &&
        original &&
        details.fullName?.trim() &&
        details.fullName.trim() !== original &&
        !names.includes(original);
      return {
        ...current,
        details: suggest
          ? { ...details, previousFullNames: [...names, original] }
          : details,
        suggestionDismissed: dismissed,
      };
    });
    setRefused(false);
  };
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
          onChange={changeDetails}
          birthDateUnknown={editing.birthDateUnknown}
          onBirthDateUnknownChange={(birthDateUnknown) =>
            setEditing((current) => current && { ...current, birthDateUnknown })
          }
        />
        <PreviousFullNames details={editing.details} onChange={changeDetails} />
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
              onClick={() =>
                showEdit({
                  id: person.id,
                  originalFullName: person.fullName?.trim() ?? "",
                  suggestionDismissed: false,
                  details: {
                    fullName: person.fullName,
                    birthDate: person.birthDate,
                    previousFullNames: [...(person.previousFullNames ?? [])],
                  },
                  // A person with no details yet (a profile just made)
                  // starts with the date box open; "unknown" is ticked
                  // only once a full name was saved without a date.
                  birthDateUnknown:
                    !person.birthDate && Boolean(person.fullName),
                })
              }
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
