import { useCallback, useEffect, useRef, useState } from "react";
import type { PatientProfile, VaultBridge, VaultRecord } from "../vault";
import { personFor, type FoundName } from "./personMatch";

/** Prototype: the person a document in Shared with me looks like it is for,
 * from the patient name found in it. Exactly one match is offered; none or
 * several, nothing. "Not this person" lasts until the vault locks. */
export function usePersonSuggestions(
  bridge: VaultBridge,
  sharedRecords: VaultRecord[],
  people: PatientProfile[],
) {
  const [found, setFound] = useState<ReadonlyMap<string, FoundName | null>>(
    new Map(),
  );
  const [dismissed, setDismissed] = useState<string[]>([]);
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const record of sharedRecords) {
      if (asked.current.has(record.id)) continue;
      asked.current.add(record.id);
      // A bridge that cannot read names, or fails to, finds none: nothing is
      // offered for that document.
      Promise.resolve()
        .then(() => bridge.nameFoundIn?.(record.id) ?? null)
        .then(
          (name) =>
            setFound((current) => new Map(current).set(record.id, name)),
          () => undefined,
        );
    }
  }, [bridge, sharedRecords]);
  const suggestionFor = useCallback(
    (recordId: string) => {
      if (dismissed.includes(recordId)) return null;
      const name = found.get(recordId);
      return name ? personFor(people, name) : null;
    },
    [dismissed, found, people],
  );
  const dismiss = useCallback(
    (recordId: string) => setDismissed((current) => [...current, recordId]),
    [],
  );
  return { suggestionFor, dismiss };
}
