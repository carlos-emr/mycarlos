import { useState } from "react";
import { useI18n } from "../i18n";
import type {
  ArrivedWhileHidden,
  HiddenProfile,
  PatientProfile,
} from "../vault";
import { ConfirmDialog } from "./ConfirmDialog";

// Hiding a whole person and bringing them back (#360, section 8). Hiding is tidiness, not
// secrecy: the dialog says so. Nothing is deleted, nothing is re-encrypted, and one action
// reverses it.

/** Hide on a person's line in Security. The last visible person cannot be hidden: the
 * button says why instead of failing. */
export function HidePersonButton({
  person,
  onlyOne,
  busy,
  readOnly,
  onHide,
}: {
  person: PatientProfile;
  /** This is the only person the library shows. */
  onlyOne: boolean;
  busy: boolean;
  readOnly: boolean;
  onHide: (profileId: string) => void;
}) {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  const explainId = `hide-last-${person.id}`;
  return (
    <>
      <button
        className="button"
        type="button"
        disabled={busy || readOnly || onlyOne}
        aria-label={t("hiddenPeople.hideFor", { name: person.displayName })}
        aria-describedby={onlyOne ? explainId : undefined}
        aria-haspopup="dialog"
        onClick={() => setAsking(true)}
      >
        {t("hiddenPeople.hide")}
      </button>
      {onlyOne && (
        <span id={explainId} className="native-hide-last">
          {t("hiddenPeople.lastPerson")}
        </span>
      )}
      {asking && (
        <ConfirmDialog
          title={t("hiddenPeople.confirm.title", { name: person.displayName })}
          confirmLabel={t("hiddenPeople.confirm.hide", {
            name: person.displayName,
          })}
          onConfirm={() => {
            setAsking(false);
            onHide(person.id);
          }}
          onCancel={() => setAsking(false)}
        >
          {t("hiddenPeople.confirm.body", { name: person.displayName })}
        </ConfirmDialog>
      )}
    </>
  );
}

/** Security's Hidden people: who is hidden, since when, how many documents, and the two
 * things to do: restore, or hand their records over (a parent may hide first and still
 * hand the file over). */
export function HiddenPeopleList({
  hidden,
  busy,
  readOnly,
  onRestore,
  onHandOver,
}: {
  hidden: HiddenProfile[];
  busy: boolean;
  readOnly: boolean;
  onRestore: (profileId: string) => void;
  onHandOver?: (person: HiddenProfile) => void;
}) {
  const { t, locale } = useI18n();
  if (hidden.length === 0) return null;
  return (
    <div className="native-hidden-people">
      <h3>{t("hiddenPeople.title")}</h3>
      <p>{t("hiddenPeople.body")}</p>
      <ul
        className="native-person-details-list"
        aria-label={t("hiddenPeople.list")}
      >
        {hidden.map((person) => (
          <li key={person.id}>
            <span>
              <strong>{person.displayName}</strong>
              {" · "}
              {t("hiddenPeople.since", {
                date: new Date(person.hiddenAtMs).toLocaleDateString(locale, {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                }),
              })}
              {" · "}
              {t("hiddenPeople.documents", { count: person.documents })}
            </span>
            <button
              className="button"
              type="button"
              disabled={busy || readOnly}
              aria-label={t("hiddenPeople.restoreFor", {
                name: person.displayName,
              })}
              onClick={() => onRestore(person.id)}
            >
              {t("hiddenPeople.restore")}
            </button>
            {onHandOver && (
              <button
                className="button"
                type="button"
                disabled={busy || readOnly}
                aria-haspopup="dialog"
                aria-label={t("hiddenPeople.handOverFor", {
                  name: person.displayName,
                })}
                onClick={() => onHandOver(person)}
              >
                {t("hiddenPeople.handOver")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** After a restore: documents that arrived for the person while they were hidden wait in
 * Shared with me. Offered back once, by title; closing it, or leaving them, changes nothing. */
export function ArrivedWhileHiddenDialog({
  name,
  arrived,
  onMove,
  onLeave,
}: {
  name: string;
  arrived: ArrivedWhileHidden[];
  onMove: () => void;
  onLeave: () => void;
}) {
  const { t } = useI18n();
  return (
    <ConfirmDialog
      title={t("hiddenPeople.arrived.title", { name })}
      confirmLabel={t("hiddenPeople.arrived.move", { name })}
      cancelLabel={t("hiddenPeople.arrived.leave")}
      onConfirm={onMove}
      onCancel={onLeave}
      details={
        <ul
          className="native-arrived-list"
          aria-label={t("hiddenPeople.arrived.list")}
        >
          {arrived.map((document) => (
            <li key={document.recordId}>{document.displayName}</li>
          ))}
        </ul>
      }
    >
      {t("hiddenPeople.arrived.body", { name, count: arrived.length })}
    </ConfirmDialog>
  );
}
