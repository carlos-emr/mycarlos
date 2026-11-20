import type { Locator } from "@playwright/test";
import { translate } from "./fluent";

/** Fills the birth date, which is a group of three controls (year typed,
 * month chosen from a list, day typed), with "YYYY-MM-DD". */
export async function fillBirthDate(scope: Locator, iso: string) {
  const [year, month, day] = iso.split("-");
  const group = scope.getByRole("group", {
    name: translate("en", "personDetails.birthDate"),
    exact: true,
  });
  await group.locator(".native-birth-year input").fill(year);
  await group.locator(".native-birth-month select").selectOption(month);
  await group.locator(".native-birth-day input").fill(String(Number(day)));
}
