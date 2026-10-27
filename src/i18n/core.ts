import { fluentBundle, formattingFailure } from "./catalogues";
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
    // Script and region belong to the core tag. Extension/private-use payload
    // can contain the same words without requesting that script or region.
    try {
      const locale = new Intl.Locale(wanted);
      if (locale.script === "Hant") return "zh-TW";
      if (locale.script === "Hans") return "zh-CN";
      return ["TW", "HK", "MO"].includes(locale.region ?? "")
        ? "zh-TW"
        : "zh-CN";
    } catch {
      return null;
    }
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

/** Human-facing text isolates inserted values. Missing messages or arguments
 * show a recoverable formatting failure without logging the arguments. */
export function translate(
  locale: Locale,
  key: MessageKey,
  params: Params = {},
): string {
  return formatMessage(locale, key, params, true);
}

/** Only the printed kit metadata bypasses bidi isolation, so copied labels
 * and dates contain no invisible formatter characters. Recovery bytes are
 * rendered directly, outside translated messages. */
export function translatePrintedKit(
  locale: Locale,
  key: "kit.labelPrinted" | "kit.printed",
  params: Params,
): string {
  return formatMessage(locale, key, params, false);
}

/** A generated filename is stored data, not a human sentence. Do not add bidi
 * delimiters to it or turn a formatter fault into a saved document name. */
export function formatPhotoName(
  locale: Locale,
  date: string,
  time: string,
): string {
  const value = formatMessage(
    locale,
    "interface.photo.name",
    { date, time },
    false,
  );
  if (value === formattingFailure(locale)) throw new Error(value);
  return value;
}

function formatMessage(
  locale: Locale,
  key: MessageKey,
  params: Params,
  useIsolating: boolean,
): string {
  try {
    const bundle = fluentBundle(locale, useIsolating);
    const message = bundle.getMessage(fluentId(key));
    if (!message?.value) return formattingFailure(locale);
    const errors: Error[] = [];
    const formatted = bundle.formatPattern(message.value, params, errors);
    return errors.length ? formattingFailure(locale) : formatted;
  } catch {
    // A bundled resource/format fault remains visible and recoverable. Never log arguments.
    return formattingFailure(locale);
  }
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
  locale?: string,
): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}
