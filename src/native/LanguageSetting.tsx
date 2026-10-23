import { useId, useSyncExternalStore } from "react";
import {
  getLanguagePreference,
  rememberLocale,
  subscribeLocale,
  useI18n,
  type Locale,
} from "../i18n";

// Autonyms remain recognizable after an accidental language change.
const LANGUAGES: ReadonlyArray<[Locale, string]> = [
  ["en", "English"],
  ["fr", "Français"],
  ["es", "Español"],
  ["pl", "Polski"],
  ["pt-BR", "Português (Brasil)"],
];

export function LanguageSetting({ compact = false }: { compact?: boolean }) {
  const state = useSyncExternalStore(subscribeLocale, getLanguagePreference);
  const { t } = useI18n();
  const id = useId();
  if (compact)
    return (
      <div className="language-compact">
        <label htmlFor={id}>{t("language.title")}</label>
        <select
          id={id}
          value={state.choice ?? ""}
          aria-describedby={`${id}-help${state.error ? ` ${id}-error` : ""}`}
          onChange={(event) =>
            rememberLocale((event.target.value || null) as Locale | null)
          }
        >
          <option value="">{t("appearance.system")}</option>
          {LANGUAGES.map(([locale, label]) => (
            <option key={locale} value={locale} lang={locale}>
              {label}
            </option>
          ))}
        </select>
        <p id={`${id}-help`} className="sr-only">
          {t("language.help")}
        </p>
        {state.error && (
          <p id={`${id}-error`} role="alert">
            {t(state.error)}
          </p>
        )}
      </div>
    );
  return (
    <section className="setting-row native-setting-form">
      <div>
        <h2>{t("language.title")}</h2>
        <p id={`${id}-help`}>{t("language.help")}</p>
      </div>
      <fieldset
        className="appearance-choice language-choice"
        aria-describedby={`${id}-help${state.error ? ` ${id}-error` : ""}`}
      >
        <legend className="sr-only">{t("language.title")}</legend>
        <label className="appearance-option">
          <input
            type="radio"
            name={id}
            checked={state.choice === null}
            onChange={() => rememberLocale(null)}
          />
          <span>{t("language.system")}</span>
        </label>
        {LANGUAGES.map(([locale, label]) => (
          <label className="appearance-option" key={locale}>
            <input
              type="radio"
              name={id}
              value={locale}
              checked={state.choice === locale}
              onChange={() => rememberLocale(locale)}
            />
            <span lang={locale}>{label}</span>
          </label>
        ))}
        {state.error && (
          <p id={`${id}-error`} className="appearance-error" role="alert">
            {t(state.error)}
          </p>
        )}
      </fieldset>
    </section>
  );
}
