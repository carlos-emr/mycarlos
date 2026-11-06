import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useModalFocus } from "../useModalFocus";
import { NotificationSetting } from "./NotificationSetting";

type NoticeStatus = {
  supported: boolean;
  enabled: boolean;
  automaticChecksSupported?: boolean;
  automaticChecksEnabled?: boolean;
};

/**
 * Right after the first clinic link (#235): the Notices setting, offered once
 * in a dialog, as the step in first-time setup that the clinic link makes
 * useful. Nothing is ticked for the patient. The boxes are the existing
 * setting itself, so each is the same consent, the same native command and the
 * same stored setting as in Settings › Preferences; "Not now" changes nothing.
 * Shown only where notices are supported and not already on.
 */
export function NoticesAfterLink({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const [offer, setOffer] = useState<"checking" | "offer" | "none">("checking");
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = () => closeRef.current();
  const firstLocale = useRef(locale);
  useEffect(() => {
    let live = true;
    void invoke<NoticeStatus>("vault_notification_status", {
      locale: firstLocale.current,
    }).then(
      (status) => {
        if (!live) return;
        const allOn =
          status.enabled &&
          (!status.automaticChecksSupported ||
            status.automaticChecksEnabled === true);
        setOffer(status.supported && !allOn ? "offer" : "none");
      },
      () => {
        if (live) setOffer("none");
      },
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (offer === "none") closeRef.current();
  }, [offer]);
  // The dialog itself takes the first focus, so its title and intro are read
  // before the choices; Escape is "Not now".
  useModalFocus(offer === "offer", dialogRef, close, dialogRef);
  if (offer !== "offer") return null;
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
          <NotificationSetting />
          <p>
            {t("noticesStep.later", {
              settings: t("sidebar.settings"),
              preferences: t("sidebar.preferences"),
              notices: t("notifications.title"),
            })}
          </p>
        </div>
        <footer className="native-dialog-actions">
          <button className="button primary" type="button" onClick={close}>
            {t("noticesStep.done")}
          </button>
          <button className="button" type="button" onClick={close}>
            {t("noticesStep.notNow")}
          </button>
        </footer>
      </section>
    </div>
  );
}
