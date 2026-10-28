import { useCallback, useEffect, useRef, useState } from "react";
import {
  isLockedError,
  type FoundIdentity,
  type PatientProfile,
  type VaultBridge,
  type VaultRecord,
} from "../vault";
import { personFor } from "./personMatch";

/** Serial, bounded native reads; this hook lives only for the unlocked session.
 * Nothing is persisted and late answers after lock/unmount are discarded. */
export function usePersonSuggestions(
  bridge: VaultBridge,
  records: VaultRecord[],
  people: PatientProfile[],
  paused: boolean,
) {
  const [found, setFound] = useState<ReadonlyMap<string, FoundIdentity | null>>(
    new Map(),
  );
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(false);
  const working = useRef(false);
  const stopped = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (paused || stopped.current || !bridge.sharedIdentity || working.current)
      return;
    const record = records.find(
      (r) =>
        r.available &&
        !r.hidden &&
        /\.pdf$/i.test(r.displayName) &&
        !found.has(r.id),
    );
    if (!record) return;
    working.current = true;
    void bridge
      .sharedIdentity(record.id)
      .catch((error: unknown) => {
        // Native auto-lock may beat the renderer's status poll. Stop the entire
        // queue, rather than asking once per remaining PDF, and hide cached hints.
        if (isLockedError(error)) {
          stopped.current = true;
          if (mounted.current) setFound(new Map());
        }
        return null;
      })
      .then((identity) => {
        working.current = false;
        if (mounted.current && !stopped.current)
          setFound((previous) => new Map(previous).set(record.id, identity));
      });
  }, [bridge, records, found, paused]);
  const suggestionFor = useCallback(
    (id: string) => {
      const identity = found.get(id);
      return identity && !dismissed.has(id)
        ? personFor(people, identity)
        : null;
    },
    [found, people, dismissed],
  );
  const dismiss = useCallback(
    (id: string) => setDismissed((previous) => new Set(previous).add(id)),
    [],
  );
  return { suggestionFor, dismiss };
}
