import { TextSizeSetting, useNativeZoom } from "./TextSizeSetting";
import { LanguageSetting } from "./LanguageSetting";
import { AppearanceSetting } from "./AppearanceSetting";
import { useI18n } from "../i18n";
import { NotificationSetting } from "./NotificationSetting";
import { BackgroundSetting } from "./BackgroundSetting";

/** Settings > Preferences: how myCarlos looks on this computer. Nothing here
 * is kept in the vault. The AI helper's model has its own page,
 * Settings > AI helper (`AiSettings`). */
export function PreferencesSettings({
  onOpenNotices,
}: {
  /** Opens Open-source notices (About); the section is not shown without it. */
  onOpenNotices?: () => void;
} = {}) {
  const native = useNativeZoom();
  const { t } = useI18n();
  return (
    <main className="library-main purpose-screen">
      <div className="main-head">
        <div>
          <h1>{t("sidebar.preferences")}</h1>
          <p>{t("preferences.subtitle")}</p>
        </div>
      </div>
      <div className="setting-list">
        <LanguageSetting />
        <AppearanceSetting />
        <NotificationSetting />
        <BackgroundSetting />
        {native ? (
          <TextSizeSetting zoom={native.zoom} mac={native.mac} />
        ) : (
          <section className="setting-row">
            <div>
              <h2>{t("textSize.title")}</h2>
              <p>{t("textSize.followsDevice")}</p>
            </div>
          </section>
        )}
        {onOpenNotices && (
          <section className="setting-row">
            <div>
              <h2>{t("notices.about.title")}</h2>
              <p>{t("notices.about.body")}</p>
            </div>
            <button className="button" type="button" onClick={onOpenNotices}>
              {t("notices.open")}
            </button>
          </section>
        )}
      </div>
    </main>
  );
}
