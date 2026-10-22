import { TextSizeSetting, useNativeZoom } from "./TextSizeSetting";
import { AppearanceSetting } from "./AppearanceSetting";
import { useI18n } from "../i18n";

/** Settings > Preferences: how myCarlos looks on this computer. Nothing here
 * is kept in the vault. */
export function PreferencesSettings() {
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
        <AppearanceSetting />
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
      </div>
    </main>
  );
}
