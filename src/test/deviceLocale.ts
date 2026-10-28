import { onTestFinished, vi } from "vitest";

/** Within one test, make the computer's own locale `locale`: the one that a
 * date's toLocaleString, toLocaleDateString or toLocaleTimeString uses when
 * no locale is passed. A test can then tell the computer's date format from
 * the language myCarlos uses (Ben, 21 Oct: dates keep the computer's
 * format, whatever language myCarlos uses). */
export function setDeviceLocale(locale: string) {
  for (const name of [
    "toLocaleString",
    "toLocaleDateString",
    "toLocaleTimeString",
  ] as const) {
    const original = Date.prototype[name];
    const spy = vi.spyOn(Date.prototype, name).mockImplementation(function (
      this: Date,
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ) {
      return original.call(this, locales ?? locale, options);
    });
    onTestFinished(() => spy.mockRestore());
  }
}
