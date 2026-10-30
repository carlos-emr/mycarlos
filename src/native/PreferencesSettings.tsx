import { TextSizeSetting, useNativeZoom } from "./TextSizeSetting";
import { LanguageSetting } from "./LanguageSetting";
import { AppearanceSetting } from "./AppearanceSetting";
import { useI18n } from "../i18n";
import type { ModelStatus } from "../ai/types";

/** Settings > Preferences: how myCarlos looks on this computer. Nothing here
 * is kept in the vault. `aiStatus` is given on a computer, where the AI
 * helper (#72) can run: null until the native side has answered. */
export function PreferencesSettings({
  aiStatus,
}: {
  aiStatus?: ModelStatus | null;
}) {
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
        {aiStatus !== undefined && (
          <section className="setting-row">
            <div>
              <h2>
                {t("ai.preferences.title")}
                {aiStatus?.state === "notInstalled" && (
                  <>
                    {" "}
                    <span className="state-pill off">
                      {t("ai.preferences.notInstalled")}
                    </span>
                  </>
                )}
              </h2>
              <p>{t("ai.preferences.body")}</p>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
