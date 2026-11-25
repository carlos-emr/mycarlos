import { useI18n } from "../i18n";
import { LanguageButton } from "./LanguageButton";

/**
 * Preferences > Language: the language now in use, on the same button the unlock screen has (a
 * globe and the language's own name), which opens the same dialog with one choice for each
 * language and System default. Nothing here is a second list: the dialog is the one the first
 * screen uses, so a choice is remembered the same way, the keyboard and voice control work the
 * same way (each choice a real radio whose name is its visible text) and focus comes back to this
 * button when the dialog closes.
 */
export function LanguagePreference() {
  const { t } = useI18n();
  return (
    <section className="setting-row native-setting-form language-preference">
      <div>
        <h2>{t("language.title")}</h2>
        <p>{t("language.help")}</p>
      </div>
      <div className="language-preference-control">
        <LanguageButton />
      </div>
    </section>
  );
}
