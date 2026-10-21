import { useCallback, useEffect, useRef, useState } from "react";
import type { PatientProfile, VaultBridge } from "../vault";
import {
  changeLink,
  filedNotice,
  forgetLink,
  linkFor,
  linksFor,
  rememberLink,
  type ClinicDelivery,
  type ClinicLink,
} from "./clinicLinks";

/** Prototype: documents a clinic sends through the portal link. One whose
 * patient has a clinic link is filed under that person with a quiet notice;
 * any other is asked about, one at a time. The links live in memory until
 * the vault locks (the real ones would be kept with the portal link). */
export function useClinicDeliveries({
  bridge,
  people,
  run,
  refresh,
  setNotice,
}: {
  bridge: VaultBridge;
  people: PatientProfile[];
  run: (operation: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
}) {
  const [links, setLinks] = useState<ClinicLink[]>([]);
  const [waiting, setWaiting] = useState<ClinicDelivery[]>([]);
  // "Later" is asked again at the next unlock, not at the next focus.
  const putOff = useRef(new Set<string>());
  const latest = useRef({ links, people, refresh, setNotice });
  latest.current = { links, people, refresh, setNotice };
  const picking = useRef(false);
  const pickUp = useCallback(async () => {
    if (picking.current) return;
    picking.current = true;
    try {
      // A bridge without deliveries, or one that fails, has none for now.
      const deliveries = await Promise.resolve().then(
        () => bridge.clinicDeliveries?.() ?? [],
      );
      const { people } = latest.current;
      const kept = linksFor(
        latest.current.links,
        people.map((person) => person.id),
      );
      const filed: { clinicName: string; personName: string }[] = [];
      const ask: ClinicDelivery[] = [];
      for (const delivery of deliveries) {
        const link = linkFor(kept, delivery);
        const person =
          link && people.find((candidate) => candidate.id === link.profileId);
        if (person) {
          await bridge.fileClinicDelivery?.(delivery.id, person.id);
          filed.push({
            clinicName: delivery.clinicName,
            personName: person.displayName,
          });
        } else if (!putOff.current.has(delivery.id)) ask.push(delivery);
      }
      setWaiting(ask);
      if (filed.length) {
        await latest.current.refresh();
        latest.current.setNotice(filedNotice(filed));
      }
    } catch {
      // Nothing is picked up now; the next ask tries again.
    } finally {
      picking.current = false;
    }
  }, [bridge]);
  useEffect(() => {
    void pickUp();
    const onFocus = () => void pickUp();
    const onVisible = () => {
      if (document.visibilityState === "visible") void pickUp();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pickUp]);

  const nameOf = (profileId: string) =>
    people.find((person) => person.id === profileId)?.displayName ?? "";
  const file = (
    delivery: ClinicDelivery,
    profileId: string | null,
    always: boolean,
  ) =>
    void run(async () => {
      await bridge.fileClinicDelivery?.(delivery.id, profileId);
      setWaiting((current) => current.filter(({ id }) => id !== delivery.id));
      await refresh();
      setNotice(
        profileId
          ? `${delivery.title} from ${delivery.clinicName} was filed under ${nameOf(profileId)}.`
          : `${delivery.title} from ${delivery.clinicName} was put in Shared with me.`,
      );
      // Others already waiting for the same patient follow the new link.
      if (always && profileId) {
        const next = rememberLink(latest.current.links, delivery, profileId);
        latest.current.links = next;
        setLinks(next);
        await pickUp();
      }
    });
  const later = (delivery: ClinicDelivery) => {
    putOff.current.add(delivery.id);
    setWaiting((current) => current.filter(({ id }) => id !== delivery.id));
    setNotice(
      `myCarlos will ask about ${delivery.title} from ${delivery.clinicName} again the next time the vault is unlocked.`,
    );
  };
  const change = (link: ClinicLink, profileId: string) => {
    setLinks((current) => changeLink(current, link, profileId));
    setNotice(
      `Documents from ${link.clinicName} for ${link.patientName} will now be filed under ${nameOf(profileId)}.`,
    );
  };
  const forget = (link: ClinicLink) => {
    setLinks((current) => forgetLink(current, link));
    setNotice(
      `Forgotten. myCarlos will ask again the next time ${link.clinicName} sends a document for ${link.patientName}.`,
    );
  };
  return {
    links: linksFor(
      links,
      people.map((person) => person.id),
    ),
    asking: waiting[0] ?? null,
    file,
    later,
    change,
    forget,
  };
}
