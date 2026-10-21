import { useState } from "react";
import type { PatientProfile } from "../vault";
import type { ClinicLink } from "./clinicLinks";

const keyOf = (link: ClinicLink) =>
  `${link.clinicId}|${link.patientName}|${link.patientBirthDate}`;

/** Prototype: where each clinic's documents are filed, set when the first
 * one came, with Change person and Forget. */
export function ClinicLinksSetting({
  links,
  people,
  busy,
  onChange,
  onForget,
}: {
  links: ClinicLink[];
  people: PatientProfile[];
  busy: boolean;
  onChange: (link: ClinicLink, profileId: string) => void;
  onForget: (link: ClinicLink) => void;
}) {
  const [changing, setChanging] = useState<{ key: string; to: string } | null>(
    null,
  );
  const nameOf = (profileId: string) =>
    people.find((person) => person.id === profileId)?.displayName ??
    "someone no longer in this vault";
  return (
    <section
      className="setting-row native-clinic-links"
      aria-labelledby="clinic-links-title"
    >
      <div>
        <h2 id="clinic-links-title">
          Clinic links <span className="state-pill">Prototype</span>
        </h2>
        <p>
          Where documents from each clinic are filed. myCarlos asked once, when
          the first one came.
        </p>
        {links.length === 0 ? (
          <p>
            No clinic links yet. When a clinic sends you a document, myCarlos
            asks once where to file it.
          </p>
        ) : (
          <ul className="native-clinic-link-list">
            {links.map((link) => {
              const key = keyOf(link);
              const label = `${link.clinicName}, ${link.patientName}`;
              return (
                <li key={key}>
                  <span>
                    <strong>{link.clinicName}</strong> · for {link.patientName}{" "}
                    → {nameOf(link.profileId)}
                  </span>
                  {changing?.key === key ? (
                    <span className="native-clinic-link-actions">
                      <label>
                        File under
                        <select
                          value={changing.to}
                          onChange={(event) =>
                            setChanging({ key, to: event.target.value })
                          }
                        >
                          {people.map((person) => (
                            <option key={person.id} value={person.id}>
                              {person.displayName}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="button"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          onChange(link, changing.to);
                          setChanging(null);
                        }}
                      >
                        Save
                      </button>
                      <button
                        className="button"
                        type="button"
                        onClick={() => setChanging(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="native-clinic-link-actions">
                      <button
                        className="button"
                        type="button"
                        disabled={busy}
                        aria-label={`Change person for ${label}`}
                        onClick={() => setChanging({ key, to: link.profileId })}
                      >
                        Change person
                      </button>
                      <button
                        className="button"
                        type="button"
                        disabled={busy}
                        aria-label={`Forget ${label}`}
                        onClick={() => onForget(link)}
                      >
                        Forget
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
