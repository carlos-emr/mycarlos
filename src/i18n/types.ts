/** The languages CARLOS ships. Tags are BCP 47, so they can go straight into
 * the page's `lang` attribute and into Intl. */
export const LOCALES = [
  "en",
  "fr",
  "es",
  "pl",
  "pt-BR",
  "zh-CN",
  "zh-TW",
] as const;
export type Locale = (typeof LOCALES)[number];

/** English is the source of every message and the fallback for anything else. */
export const DEFAULT_LOCALE: Locale = "en";
