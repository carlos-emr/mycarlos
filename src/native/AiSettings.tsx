import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  aiLabelSnapshot,
  anyShortAiLabel,
  showFullAiLabelAgain,
  subscribeAiLabel,
} from "../aiLabelPreference";
import { useI18n } from "../i18n";
import type { ModelStatus } from "../ai/types";
import { AiModelSetting } from "./AiModelSetting";
import { AiSpeedCheck } from "./AiSpeedCheck";
import { CloudAiSetting } from "./CloudAiSetting";
import type { CloudAiBridge } from "../cloudAi";

/** Settings > AI helper (#72): the model on this computer. Later AI settings
 * (such as the answers kept with documents) belong here too. Shown only on a
 * computer, where the helper can run. `aiStatus` is null until the native
 * side has answered. */
export function AiSettings({
  aiStatus,
  onAiStatus,
  cloudAi = null,
  onOpenAiHelperNotice,
}: {
  aiStatus: ModelStatus | null;
  /** The status after the model was added or removed here. */
  onAiStatus: (status: ModelStatus) => void;
  /** The cloud AI bridge (#72), given only in a build with the cloud AI flag. */
  cloudAi?: CloudAiBridge | null;
  /** Opens the notice about the AI helper (#72, #355): it is here, with the
   * helper's other settings, and no longer in Security. */
  onOpenAiHelperNotice?: () => void;
}) {
  const { t } = useI18n();
  // Whether "Don't show this again" was chosen on any AI answer (#351).
  useSyncExternalStore(subscribeAiLabel, aiLabelSnapshot);
  const shortLabel = anyShortAiLabel();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // The full warning was just brought back from this screen: said once, for a screen reader.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (shortLabel) setRestored(false);
  }, [shortLabel]);
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
            <h2 ref={headingRef} tabIndex={-1}>
              {t("ai.label.settingsTitle")}
            </h2>
            <p>{t("ai.label.settingsBody")}</p>
          </div>
          <div>
            {/* Always on the page, so that its words are read out when they come; the sentence and
                the button go when there is nothing to bring back, and the focus goes to the row's
                heading. */}
            <p role="status">
              {shortLabel ? (
                t("ai.label.settingsShortShown")
              ) : restored ? (
                <span className="sr-only">
                  {t("ai.label.settingsFullBack")}
                </span>
              ) : null}
            </p>
            {shortLabel && (
              <button
                className="button"
                type="button"
                onClick={() => {
                  showFullAiLabelAgain();
                  // The button and its sentence go and the focus moves to the heading: this is
                  // said once, to a screen reader only, in the standing status region.
                  setRestored(true);
                  headingRef.current?.focus();
                }}
              >
                {t("ai.label.settingsShowFull")}
              </button>
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
        <CloudAiSetting bridge={cloudAi} />
      </div>
    </main>
  );
}
