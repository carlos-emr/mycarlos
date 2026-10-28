import { useCallback, useSyncExternalStore } from "react";
import { getLocale, subscribeLocale, translate, type Params } from "./core";
import type { MessageKey } from "./locales";

export {
  formatDate,
  formatNumber,
  getLocale,
  getLocaleOverride,
  getLanguagePreference,
  rememberLocale,
  subscribeLocale,
  LANGUAGE_STORAGE_KEY,
  initLocale,
  interpolate,
  matchLocale,
  resolveLocale,
  setLocaleOverride,
  t,
  translate,
} from "./core";
export type { Params } from "./core";
export { withElements } from "./elements";
export { CATALOGUES } from "./locales";
export type { MessageKey } from "./locales";
export { DEFAULT_LOCALE, LOCALES } from "./types";
export type { Locale, Message, PluralForms } from "./types";

/** For components: the language in use and a `t` that re-renders the
 * component when the language changes. */
export function useI18n() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  const tr = useCallback(
    (key: MessageKey, params?: Params) => translate(locale, key, params),
    [locale],
  );
  return { locale, t: tr };
}

export {
  deferredText,
  resolveText,
  message,
  joinText,
  useTextState,
  UiError,
} from "./text";
export type { UiText } from "./text";
