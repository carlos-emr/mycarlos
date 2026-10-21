import { useRef, useState } from "react";
import { useModalFocus } from "../useModalFocus";
import type { PatientProfile } from "../vault";
import { dateText, type ClinicDelivery } from "./clinicLinks";

const SHARED = "shared";

/** Prototype: the first document from a clinic for a patient asks once where
 * it goes, and whether this clinic's documents for that patient always go
 * there. The answer is the patient's; nothing is filed by name alone. */
export function ClinicDeliveryDialog({
  delivery,
  people,
  busy,
  onFile,
  onLater,
}: {
  delivery: ClinicDelivery;
  people: PatientProfile[];
  busy: boolean;
  /** `profileId` null files it in Shared with me; `always` remembers the
   * person for this clinic's patient. */
  onFile: (profileId: string | null, always: boolean) => void;
  /** Leaves it for later: it is asked again at the next unlock. */
  onLater: () => void;
}) {
  const [choice, setChoice] = useState("");
  const [always, setAlways] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const later = () => {
    if (!busy) onLater();
  };
  useModalFocus(true, dialogRef, later);
  const toPerson = choice !== "" && choice !== SHARED;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={later}>
      <section
        ref={dialogRef}
        className="record-dialog native-delivery-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delivery-title"
        aria-describedby="delivery-about"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <div>
            <span className="eyebrow">
              A document from {delivery.clinicName}
            </span>
            <h2 id="delivery-title">{delivery.title}</h2>
          </div>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!choice || busy) return;
            onFile(toPerson ? choice : null, toPerson && always);
          }}
        >
          <div className="native-delivery-fields">
            <p id="delivery-about">
              This came from {delivery.clinicName} for{" "}
              <strong>
                {delivery.patientName}, born{" "}
                {dateText(delivery.patientBirthDate)}
              </strong>
              .
            </p>
            <p className="native-delivery-meta">
              {delivery.kind} · {dateText(delivery.serviceDate)} ·{" "}
              {delivery.provider}
            </p>
            <fieldset className="appearance-choice native-delivery-choice">
              <legend>File it under:</legend>
              {people.map((person) => (
                <label className="appearance-option" key={person.id}>
                  <input
                    type="radio"
                    name="delivery-person"
                    value={person.id}
                    checked={choice === person.id}
                    onChange={() => setChoice(person.id)}
                  />
                  {person.displayName}
                </label>
              ))}
              <label className="appearance-option">
                <input
                  type="radio"
                  name="delivery-person"
                  value={SHARED}
                  checked={choice === SHARED}
                  onChange={() => setChoice(SHARED)}
                />
                Shared with me
              </label>
            </fieldset>
            <label className="appearance-option native-delivery-always">
              <input
                type="checkbox"
                checked={toPerson && always}
                disabled={!toPerson}
                onChange={(event) => setAlways(event.target.checked)}
              />
              Always file this clinic's documents for {delivery.patientName}{" "}
              here.
            </label>
          </div>
          <footer className="dialog-actions">
            <button className="button" type="button" onClick={later}>
              Later
            </button>
            <button className="button primary" disabled={!choice || busy}>
              File it
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
