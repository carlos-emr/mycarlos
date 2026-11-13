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
  ["zh-CN", "简体中文"],
  ["zh-TW", "繁體中文"],
];

export function LanguageSetting({ compact = false }: { compact?: boolean }) {
  const state = useSyncExternalStore(subscribeLocale, getLanguagePreference);
  const { t } = useI18n();
  const id = useId();
  return (
    <section
      className={
        compact ? "language-compact" : "setting-row native-setting-form"
      }
    >
      <div>
        {compact ? (
          <span className="language-title">{t("language.title")}</span>
        ) : (
          <h2>{t("language.title")}</h2>
        )}
        <p id={`${id}-help`} className={compact ? "sr-only" : undefined}>
          {t("language.help")}
        </p>
      </div>
      <fieldset
        className={`appearance-choice language-choice${compact ? " language-choices-compact" : ""}`}
        aria-describedby={`${id}-help${state.error ? ` ${id}-error` : ""}`}
      >
        <legend className="sr-only">{t("language.title")}</legend>
        <label className="appearance-option">
          <input
            type="radio"
            name={id}
            value=""
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
