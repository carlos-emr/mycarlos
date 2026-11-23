import { useI18n } from "../i18n";
import type { ModelStatus } from "../ai/types";
import { AiModelSetting } from "./AiModelSetting";
import { AiSpeedCheck } from "./AiSpeedCheck";

/** Settings > AI helper (#72): the model on this computer. Later AI settings
 * (such as the answers kept with documents) belong here too. Shown only on a
 * computer, where the helper can run. `aiStatus` is null until the native
 * side has answered. */
export function AiSettings({
  aiStatus,
  onAiStatus,
  onOpenAiHelperNotice,
}: {
  aiStatus: ModelStatus | null;
  /** The status after the model was added or removed here. */
  onAiStatus: (status: ModelStatus) => void;
  /** Opens the notice about the AI helper (#72, #355): it is here, with the
   * helper's other settings, and no longer in Security. */
  onOpenAiHelperNotice?: () => void;
}) {
  const { t } = useI18n();
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
        {onOpenAiHelperNotice && (
          <section className="setting-row">
            <div>
              <h2>{t("aiHelper.notice.title")}</h2>
              <p>{t("aiHelper.notice.introShare")}</p>
            </div>
            <div>
              <button
                className="button"
                type="button"
                onClick={onOpenAiHelperNotice}
              >
                {t("aiHelper.notice.title")}
              </button>
            </div>
          </section>
        )}
        {aiStatus && <AiSpeedCheck status={aiStatus} />}
      </div>
    </main>
  );
}
