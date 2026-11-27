import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useModalFocus } from "../useModalFocus";
import { BackgroundSetting } from "./BackgroundSetting";
import { NotificationSetting } from "./NotificationSetting";

type NoticeStatus = {
  supported: boolean;
  enabled: boolean;
  noticesSupported?: boolean;
  automaticChecksSupported?: boolean;
  automaticChecksEnabled?: boolean;
};

type BackgroundStatus = {
  supported: boolean;
  keepRunning: boolean;
  startAtLogin: boolean;
};

/**
 * Right after the first clinic link (#235): the Notices setting, and on a
 * computer the Running in the background setting, offered once in a dialog,
 * as the step in first-time setup that the clinic link makes useful. Nothing
 * is ticked for the patient. The boxes are the existing settings themselves,
 * so each is the same consent, the same native command and the same stored
 * setting as in Settings › Preferences; "Not now" changes nothing. Each part
 * is shown only where it exists and is not already fully on.
 * `onClose` says whether the dialog was shown: one never shown had no focus.
 */
export function NoticesAfterLink({
  onClose,
}: {
  onClose: (wasShown: boolean) => void;
}) {
  const { t, locale } = useI18n();
  // What is offered, decided once: the notices (and the automatic check) where they exist and
  // are not both on, the background pair where there is a background mode and not both are on.
  const [offer, setOffer] = useState<
    "checking" | "none" | { notices: boolean; background: boolean }
  >("checking");
  const dialogRef = useRef<HTMLElement | null>(null);
  // Once a box is saved, "Not now" would read as undoing it: only Done stays.
  const [changed, setChanged] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = () => closeRef.current(true);
  const firstLocale = useRef(locale);
  useEffect(() => {
    let live = true;
    const locale = firstLocale.current;
    void Promise.all([
      invoke<NoticeStatus>("vault_notification_status", { locale }).catch(
        () => null,
      ),
      invoke<BackgroundStatus>("background_status", { locale }).catch(
        () => null,
      ),
    ]).then(([status, background]) => {
      if (!live) return;
      // Each choice is offered where it exists and is not already on: the automatic check
      // everywhere, the notice only where the system can show one.
      const allOn =
        status !== null &&
        (!status.noticesSupported || status.enabled) &&
        (!status.automaticChecksSupported ||
          status.automaticChecksEnabled === true);
      const notices = status?.supported === true && !allOn;
      const running =
        background?.supported === true &&
        !(background.keepRunning && background.startAtLogin);
      setOffer(notices || running ? { notices, background: running } : "none");
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (offer === "none") closeRef.current(false);
  }, [offer]);
  // The dialog itself takes the first focus, so its title and intro are read
  // before the choices; Escape is "Not now".
  const shown = typeof offer === "object";
  useModalFocus(shown, dialogRef, close, dialogRef);
  if (typeof offer !== "object") return null;
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="record-dialog notices-after-link"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notices-step-title"
        aria-describedby="notices-step-intro"
        tabIndex={-1}
      >
        <header className="dialog-head">
          <div>
            <h2 id="notices-step-title">{t("noticesStep.title")}</h2>
          </div>
        </header>
        <div className="notices-after-link-body">
          <p id="notices-step-intro">{t("noticesStep.intro")}</p>
          {offer.notices && (
            <NotificationSetting
              headingLevel={3}
              onSaved={() => setChanged(true)}
            />
          )}
          {offer.background && (
            <BackgroundSetting
              headingLevel={3}
              onSaved={() => setChanged(true)}
            />
          )}
          {offer.notices && (
            <p>
              {t("noticesStep.later", {
                settings: t("sidebar.settings"),
                preferences: t("sidebar.preferences"),
                notices: t("notifications.title"),
              })}
            </p>
          )}
          {offer.background && (
            <p>
              {t("noticesStep.laterBackground", {
                settings: t("sidebar.settings"),
                preferences: t("sidebar.preferences"),
                background: t("background.title"),
              })}
            </p>
          )}
        </div>
        <footer className="native-dialog-actions">
          <button className="button primary" type="button" onClick={close}>
            {t("noticesStep.done")}
          </button>
          {!changed && (
            <button className="button" type="button" onClick={close}>
              {t("noticesStep.notNow")}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
