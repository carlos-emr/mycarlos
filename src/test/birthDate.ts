import { fireEvent, within } from "@testing-library/react";
import { humanText } from "./humanText";

/** The birth date is three controls in a group named for it (year typed,
 * month chosen, day typed), not one date box. These helpers find the group
 * and read or fill it in whatever language is shown, by the controls' places
 * rather than their words. */
export function birthDateGroup(
  scope: HTMLElement = document.body,
  name: string | ((accessibleName: string) => boolean) = humanText(
    "Date of birth",
  ),
): HTMLElement {
  return within(scope).getByRole("group", { name });
}

function controls(group: HTMLElement) {
  return {
    year: group.querySelector<HTMLInputElement>(".native-birth-year input")!,
    month: group.querySelector<HTMLSelectElement>(
      ".native-birth-month select",
    )!,
    day: group.querySelector<HTMLInputElement>(".native-birth-day input")!,
  };
}

/** Types "YYYY-MM-DD" into the group (an empty text clears all three). */
export function enterBirthDate(group: HTMLElement, iso: string) {
  const [year = "", month = "", day = ""] = iso ? iso.split("-") : [];
  const { year: y, month: m, day: d } = controls(group);
  fireEvent.change(y, { target: { value: year } });
  fireEvent.change(m, { target: { value: month } });
  fireEvent.change(d, { target: { value: day.replace(/^0(?=\d)/, "") } });
}

/** What the three controls show, as "YYYY-MM-DD", or "" until all are given. */
export function birthDateValue(group: HTMLElement): string {
  const { year, month, day } = controls(group);
  if (!year.value || !month.value || !day.value) return "";
  return `${year.value}-${month.value}-${day.value.padStart(2, "0")}`;
}
