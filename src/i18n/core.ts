import { fluentBundle } from "./catalogues";
import { type MessageKey, fluentId } from "./locales/fluent/keys";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "./types";

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
  if (primary === "zh") {
    const subtags = wanted.split("-");
    return subtags.includes("hant") || ["tw", "hk", "mo"].includes(subtags[1])
      ? "zh-TW"
      : "zh-CN";
  }
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
// Chosen on this device, otherwise by the system. The transient setter is
// also used by previews/tests; only rememberLocale writes the device choice.

export const LANGUAGE_STORAGE_KEY = "mycarlos.language.v1";
export type LanguageError =
  | ""
  | "language.error.unreadable"
  | "language.error.notRemembered";
export interface LanguagePreference {
  choice: Locale | null;
  error: LanguageError;
}
let preference: LanguagePreference = { choice: null, error: "" };
const listeners = new Set<() => void>();

function applyToDocument(locale: Locale) {
  // Screen readers pick their voice from this.
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

export function getLocale(): Locale {
  return preference.choice ?? resolveLocale(systemLanguages());
}

/** Use this language whatever the system says, or null to follow the system
 * again. Anything that is not a shipped language is ignored. */
export function setLocaleOverride(locale: Locale | null): void {
  if (locale !== null && !LOCALES.includes(locale)) return;
  updatePreference(locale, "");
}

export function getLocaleOverride(): Locale | null {
  return preference.choice;
}

export function getLanguagePreference(): LanguagePreference {
  return preference;
}

function publishLocale() {
  applyToDocument(getLocale());
  listeners.forEach((listener) => listener());
}
function updatePreference(choice: Locale | null, error: LanguageError) {
  preference = { choice, error };
  publishLocale();
}

/** A device preference, separate from every vault and document. A failed save
 * keeps the chosen language usable for this session and reports that limit. */
export function rememberLocale(locale: Locale | null): void {
  if (locale !== null && !LOCALES.includes(locale)) return;
  let error: LanguageError = "";
  try {
    if (locale === null) window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    else window.localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  } catch {
    error = "language.error.notRemembered";
  }
  updatePreference(locale, error);
}

export function subscribeLocale(listener: () => void): () => void {
  if (!listeners.size && typeof window !== "undefined")
    window.addEventListener("languagechange", publishLocale);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== "undefined")
      window.removeEventListener("languagechange", publishLocale);
  };
}

/** Sets the page's `lang` for the language now in use. Call once at start-up. */
export function initLocale(): Locale {
  let choice: Locale | null = null;
  let error: LanguageError = "";
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored && LOCALES.includes(stored as Locale)) choice = stored as Locale;
  } catch {
    error = "language.error.unreadable";
  }
  updatePreference(choice, error);
  return getLocale();
}

// --- translating ----------------------------------------------------------

/** The text for a key in a language. A missing key or form falls back to
 * English, and a key unknown even there shows the key itself, so a gap is
 * visible rather than blank. A message with plural forms needs `count`. */
export function translate(
  locale: Locale,
  key: MessageKey,
  params: Params = {},
): string {
  const local = fluentBundle(locale);
  const id = fluentId(key);
  const localMessage = local.getMessage(id);
  const bundle = localMessage ? local : fluentBundle(DEFAULT_LOCALE);
  const message = localMessage ?? bundle.getMessage(id);
  if (!message?.value) return key;
  const errors: Error[] = [];
  const formatted = bundle.formatPattern(message.value, params, errors);
  // Fluent isolates placeables for bidirectional text. Preserve those marks
  // for user supplied values; remove them from unresolved placeholders so
  // React helpers can replace the placeholder token safely.
  return errors.length
    ? formatted.replace(/\u2068(\{\$\w+\})\u2069/g, "$1")
    : formatted;
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
