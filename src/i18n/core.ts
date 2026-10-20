import { CATALOGUES, type MessageKey } from "./locales";
import {
  DEFAULT_LOCALE,
  LOCALES,
  type Locale,
  type Message,
  type PluralForms,
} from "./types";

export type Params = Record<string, string | number>;

/** Picks the shipped language closest to a requested BCP 47 tag, or null.
 * "fr-CA" and "fr" give French, "pt-PT" and "pt" give Brazilian Portuguese
 * (the only Portuguese shipped), and "PL" matches "pl" whatever the case. */
export function matchLocale(tag: string): Locale | null {
  const wanted = tag.trim().toLowerCase().replace(/_/g, "-");
  if (!wanted) return null;
  const exact = LOCALES.find((locale) => locale.toLowerCase() === wanted);
  if (exact) return exact;
  const primary = wanted.split("-")[0];
  return (
    LOCALES.find((locale) => locale.toLowerCase().split("-")[0] === primary) ??
    null
  );
}

/** The first of the system's preferred languages that is shipped, otherwise
 * English. */
export function resolveLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const found = matchLocale(tag);
    if (found) return found;
  }
  return DEFAULT_LOCALE;
}

function systemLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length
    ? navigator.languages
    : navigator.language
      ? [navigator.language]
      : [];
}

// --- the current language -------------------------------------------------
// Chosen by the patient (a later Settings control calls setLocaleOverride),
// otherwise by the system. Kept in module state so any component can read it.

let override: Locale | null = null;
const listeners = new Set<() => void>();

function applyToDocument(locale: Locale) {
  // Screen readers pick their voice from this.
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

export function getLocale(): Locale {
  return override ?? resolveLocale(systemLanguages());
}

/** Use this language whatever the system says, or null to follow the system
 * again. Anything that is not a shipped language is ignored. */
export function setLocaleOverride(locale: Locale | null): void {
  if (locale !== null && !LOCALES.includes(locale)) return;
  override = locale;
  applyToDocument(getLocale());
  listeners.forEach((listener) => listener());
}

export function getLocaleOverride(): Locale | null {
  return override;
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Sets the page's `lang` for the language now in use. Call once at start-up. */
export function initLocale(): Locale {
  const locale = getLocale();
  applyToDocument(locale);
  return locale;
}

// --- translating ----------------------------------------------------------

function pluralForm(message: PluralForms, locale: Locale, count: number) {
  const category = new Intl.PluralRules(locale).select(count);
  return message[category] ?? message.other;
}

/** Fills {name} placeholders in a single pass, so a value that itself contains
 * braces is never read as another placeholder. The result is plain text for a
 * React text node: nothing here builds HTML. A placeholder with no value is
 * left as written. */
export function interpolate(
  template: string,
  params: Params,
  locale: Locale,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return whole;
    const value = params[name];
    return typeof value === "number"
      ? formatNumber(value, locale)
      : String(value);
  });
}

/** The text for a key in a language. A missing key or form falls back to
 * English, and a key unknown even there shows the key itself, so a gap is
 * visible rather than blank. A message with plural forms needs `count`. */
export function translate(
  locale: Locale,
  key: MessageKey,
  params: Params = {},
): string {
  const message: Message | undefined =
    CATALOGUES[locale]?.[key] ?? CATALOGUES[DEFAULT_LOCALE][key];
  if (message === undefined) return key;
  if (typeof message === "string") return interpolate(message, params, locale);
  const count = params.count;
  const form =
    typeof count === "number"
      ? pluralForm(message, locale, count)
      : message.other;
  return interpolate(form, params, locale);
}

/** Text in the language now in use. */
export function t(key: MessageKey, params?: Params): string {
  return translate(getLocale(), key, params);
}

// --- numbers and dates ----------------------------------------------------

export function formatNumber(
  value: number,
  locale: Locale = getLocale(),
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDate(
  value: Date | number,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
  locale: Locale = getLocale(),
): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}
