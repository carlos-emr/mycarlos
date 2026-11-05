import { useI18n, t as translateNow } from "../i18n";
import { useRef } from "react";
import { useModalFocus } from "../useModalFocus";

/** The notice about the AI helper (#72, AI_HELPER_NOTICE.md): shown before
 * the first export in a session, and from Security at any time. Its text is
 * part A's, word for word, in the app's language. Remembering that it was
 * read, per vault, is a later format step; for now it is shown once per
 * unlocked session. */
export function AiHelperNotice({
  action,
  onClose,
}: {
  /** "continue" before an export; "close" from Security. */
  action: "continue" | "close";
  onClose: () => void;
}) {
  useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(true, dialogRef, onClose, buttonRef);
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="record-dialog native-ai-notice"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-notice-title"
      >
        <header className="dialog-head">
          <div>
            <h2 id="ai-notice-title">
              {translateNow("aiHelper.notice.title")}
            </h2>
          </div>
        </header>
        <div className="native-ai-notice-body">
          <p>{translateNow("aiHelper.notice.introShare")}</p>
          <p>
            <strong>{translateNow("aiHelper.notice.testBuild")}</strong>
          </p>
          <h3>{translateNow("aiHelper.notice.shareHeading")}</h3>
          <p>{translateNow("aiHelper.notice.shareBody")}</p>
          <p>{translateNow("aiHelper.notice.previewBody")}</p>
          <p>{translateNow("aiHelper.notice.limitsBody")}</p>
          <p>{translateNow("aiHelper.notice.fileBody")}</p>
          <p>{translateNow("aiHelper.notice.serviceBody")}</p>
          <p>{translateNow("aiHelper.notice.adviceBody")}</p>
        </div>
        <footer className="native-dialog-actions">
          <button
            ref={buttonRef}
            className="button primary"
            type="button"
            onClick={onClose}
          >
            {translateNow(
              action === "continue"
                ? "interface.AiHelperNotice.continue"
                : "interface.AnonymizePreview.close",
            )}
          </button>
        </footer>
      </section>
    </div>
  );
}
