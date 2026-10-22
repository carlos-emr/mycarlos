import { AutoLockSetting } from "./AutoLockSetting";
import { DEFAULT_AUTO_LOCK_MINUTES } from "./autoLock";
import { TextSizeSetting, useNativeZoom } from "./TextSizeSetting";
import { VaultAuthFrame } from "./VaultAuth";
import { useI18n } from "../i18n";

/**
 * First setup's first screen (#69): the choices that make the rest of setup
 * easier to read and use, before the passphrase. Each applies at once and is
 * kept on this device, outside the vault, as in Settings: they are needed
 * before unlocking and are not private.
 */
export function ComfortSetup({
  autoLockMinutes,
  onAutoLockMinutes,
  onDone,
}: {
  autoLockMinutes: number;
  onAutoLockMinutes: (minutes: number) => void;
  onDone: () => void;
}) {
  const native = useNativeZoom();
  const { t } = useI18n();
  return (
    <VaultAuthFrame state="Setting up">
      <section
        className="vault-card comfort-setup"
        aria-labelledby="comfort-title"
      >
        <p className="vault-kicker">{t("auth.kicker")}</p>
        <h1 id="comfort-title">{t("comfort.title")}</h1>
        <p>{t("comfort.intro")}</p>
        {/* Language (#46) comes first here once it is in. */}
        <div className="setting-list comfort-list">
          {native ? (
            <>
              <TextSizeSetting zoom={native.zoom} mac={native.mac} />
              <p className="comfort-sample">{t("comfort.sample")}</p>
            </>
          ) : (
            <section className="setting-row">
              <div>
                <h2>{t("textSize.title")}</h2>
                <p>{t("textSize.followsDevice")}</p>
              </div>
            </section>
          )}
          {/* Appearance (#47 / PR #60) goes here once it is in. */}
          <section className="setting-row native-setting-form">
            <div>
              <h2>{t("security.autoLock.title")}</h2>
              <p>{t("comfort.autoLock.body")}</p>
            </div>
            <div>
              <AutoLockSetting
                minutes={autoLockMinutes}
                onMinutes={onAutoLockMinutes}
              />
            </div>
          </section>
        </div>
        <p>
          {t("comfort.later", {
            settings: t("sidebar.settings"),
            textSize: t("textSize.title"),
            preferences: t("sidebar.preferences"),
            autoLock: t("security.autoLock.title"),
            security: t("security.title"),
          })}
        </p>
        <div className="comfort-actions">
          <button className="button primary" type="button" onClick={onDone}>
            {t("comfort.continue")}
          </button>
          <button
            className="button"
            type="button"
            onClick={() => {
              native?.zoom.request("reset");
              onAutoLockMinutes(DEFAULT_AUTO_LOCK_MINUTES);
              onDone();
            }}
          >
            {t("comfort.usual")}
          </button>
        </div>
      </section>
    </VaultAuthFrame>
  );
}
