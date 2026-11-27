import { useRef } from "react";
import { useModalFocus } from "../useModalFocus";
import { useI18n } from "../i18n";

/** Why video recording is not offered on this device (#359): where Record video
 * would be, a line says so, and this answers "Why?". */
export function VideoHelp({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(true, dialogRef, onClose, closeRef);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="record-dialog native-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-help-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h2 id="video-help-title">{t("interface.VideoHelp.title")}</h2>
        </header>
        <div className="camera-body">
          <p>{t("interface.VideoHelp.engine")}</p>
          <p>{t("interface.VideoHelp.systems")}</p>
          <p>{t("interface.VideoHelp.restWorks")}</p>
        </div>
        <footer className="dialog-actions">
          <button
            ref={closeRef}
            className="button primary"
            type="button"
            onClick={onClose}
          >
            {t("photo.close")}
          </button>
        </footer>
      </section>
    </div>
  );
}
