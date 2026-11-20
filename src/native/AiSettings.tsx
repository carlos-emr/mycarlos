import { useSyncExternalStore } from "react";
import {
  aiLabelSnapshot,
  anyShortAiLabel,
  showFullAiLabelAgain,
  subscribeAiLabel,
} from "../aiLabelPreference";
import { useI18n } from "../i18n";
import type { ModelStatus } from "../ai/types";
import { AiModelSetting } from "./AiModelSetting";

/** Settings > AI helper (#72): the model on this computer. Later AI settings
 * (such as the answers kept with documents) belong here too. Shown only on a
 * computer, where the helper can run. `aiStatus` is null until the native
 * side has answered. */
export function AiSettings({
  aiStatus,
  onAiStatus,
}: {
  aiStatus: ModelStatus | null;
  /** The status after the model was added or removed here. */
  onAiStatus: (status: ModelStatus) => void;
}) {
  const { t } = useI18n();
  // Whether "Don't show this again" was chosen on any AI answer (#351).
  useSyncExternalStore(subscribeAiLabel, aiLabelSnapshot);
  const shortLabel = anyShortAiLabel();
  return (
    <main className="library-main purpose-screen">
      <div className="main-head">
        <div>
          <h1>{t("ai.preferences.title")}</h1>
          <p>{t("ai.settings.subtitle")}</p>
        </div>
      </div>
      <div className="setting-list">
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
            <p className="section-intro">{t("ai.preferences.body")}</p>
            {aiStatus && (
              <AiModelSetting status={aiStatus} onStatus={onAiStatus} />
            )}
          </div>
        </section>
        <section className="setting-row">
          <div>
            <h2>{t("ai.label.settingsTitle")}</h2>
            <p>{t("ai.label.settingsBody")}</p>
          </div>
          <div>
            {shortLabel ? (
              <button
                className="button"
                type="button"
                onClick={showFullAiLabelAgain}
              >
                {t("ai.label.settingsShowFull")}
              </button>
            ) : (
              <p role="status">{t("ai.label.settingsFullShown")}</p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
