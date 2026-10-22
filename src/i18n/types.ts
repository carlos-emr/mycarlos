/** The languages CARLOS ships. Tags are BCP 47, so they can go straight into
 * the page's `lang` attribute and into Intl. */
export const LOCALES = ["en", "fr", "es", "pl", "pt-BR"] as const;
export type Locale = (typeof LOCALES)[number];

/** English is the source of every message and the fallback for anything else. */
export const DEFAULT_LOCALE: Locale = "en";

/** The plural categories of Intl.PluralRules. `other` is always required. */
export type PluralForms = {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
};

/** A message is plain text, or one text per plural form (chosen by `count`). */
export type Message = string | PluralForms;
