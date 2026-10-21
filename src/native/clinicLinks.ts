import { sameName } from "./personMatch";

/** A document a clinic delivered (prototype: the portal pickup does not
 * exist yet, so only the dev fake delivers). The clinic's own name for the
 * patient and the rest come from inside the package, sealed to this device
 * and signed by the clinic. */
export interface ClinicDelivery {
  id: string;
  clinicId: string;
  clinicName: string;
  provider: string;
  /** The patient as the clinic's chart names them. */
  patientName: string;
  /** `YYYY-MM-DD`, from the chart. */
  patientBirthDate: string;
  title: string;
  kind: string;
  /** `YYYY-MM-DD`. */
  serviceDate: string;
}

/** A clinic's patient, filed under one person of this vault. Prototype: kept
 * in memory until the vault locks; the real one is stored, encrypted, with the
 * portal link (portal #28, myCarlos #23). */
export interface ClinicLink {
  clinicId: string;
  clinicName: string;
  patientName: string;
  patientBirthDate: string;
  profileId: string;
}

type Patient = {
  clinicId: string;
  patientName: string;
  patientBirthDate: string;
};

const samePatient = (left: Patient, right: Patient) =>
  left.clinicId === right.clinicId &&
  left.patientBirthDate === right.patientBirthDate &&
  sameName(left.patientName, right.patientName);

/** Where a delivery's patient is filed, if the patient said so before. */
export const linkFor = (links: ClinicLink[], delivery: ClinicDelivery) =>
  links.find((link) => samePatient(link, delivery));

/** The links with this delivery's patient filed under `profileId`. */
export function rememberLink(
  links: ClinicLink[],
  delivery: ClinicDelivery,
  profileId: string,
): ClinicLink[] {
  return [
    ...links.filter((link) => !samePatient(link, delivery)),
    {
      clinicId: delivery.clinicId,
      clinicName: delivery.clinicName,
      patientName: delivery.patientName,
      patientBirthDate: delivery.patientBirthDate,
      profileId,
    },
  ];
}

export const changeLink = (
  links: ClinicLink[],
  changed: ClinicLink,
  profileId: string,
): ClinicLink[] =>
  links.map((link) =>
    samePatient(link, changed) ? { ...link, profileId } : link,
  );

export const forgetLink = (
  links: ClinicLink[],
  forgotten: ClinicLink,
): ClinicLink[] => links.filter((link) => !samePatient(link, forgotten));

/** Links whose person is gone (a profile can no longer be removed, but a
 * restore can put another vault in place) are not followed. */
export const linksFor = (links: ClinicLink[], profileIds: string[]) =>
  links.filter((link) => profileIds.includes(link.profileId));

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "1958-03-12" as "12 Mar 1958", without a time zone to shift it. */
export function dateText(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const [, year, month, day] = match;
  const name = MONTHS[Number(month) - 1];
  return name ? `${Number(day)} ${name} ${year}` : date;
}

/** The quiet notice after deliveries were filed by their links. */
export function filedNotice(
  filed: { clinicName: string; personName: string }[],
): string {
  const counts = new Map<string, number>();
  for (const { clinicName, personName } of filed) {
    const key = JSON.stringify([clinicName, personName]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, count]) => {
      const [clinicName, personName] = JSON.parse(key) as [string, string];
      return `${count === 1 ? "1 document" : `${count} documents`} from ${clinicName} ${count === 1 ? "was" : "were"} filed under ${personName}.`;
    })
    .join(" ");
}
