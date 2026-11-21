import { useRef } from "react";
import { useModalFocus } from "../useModalFocus";
import { useI18n } from "../i18n";
import type { PendingRecording } from "../vault";

/** The question at unlock after a recording was cut short (#359): Keep what was
 * saved, the default, or Delete it. Closing it without an answer leaves the
 * recording as it is, and the question comes back at the next unlock. */
export function RecordingRecovery({
  recording,
  busy,
  onAnswer,
  onLater,
}: {
  recording: PendingRecording;
  busy: boolean;
  onAnswer: (keep: boolean) => void;
  onLater: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(true, dialogRef, () => !busy && onLater(), keepRef);
  const question = recording.parked
    ? recording.paused
      ? "interface.RecordingRecovery.lockedPaused"
      : "interface.RecordingRecovery.locked"
    : recording.paused
      ? "interface.RecordingRecovery.closedPaused"
      : "interface.RecordingRecovery.closed";
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="record-dialog native-rename-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="recording-recovery-title"
        aria-describedby="recording-recovery-name"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h2 id="recording-recovery-title">{t(question)}</h2>
        </header>
        <p id="recording-recovery-name" className="native-dialog-status">
          {t("interface.RecordingRecovery.name", {
            name: recording.displayName,
          })}
        </p>
        <footer className="dialog-actions">
          <button
            className="button"
            type="button"
            aria-disabled={busy}
            onClick={() => !busy && onLater()}
          >
            {t("interface.RecordingRecovery.askLater")}
          </button>
          <button
            className="button"
            type="button"
            aria-disabled={busy}
            onClick={() => !busy && onAnswer(false)}
          >
            {t("interface.RecordingRecovery.delete")}
          </button>
          <button
            ref={keepRef}
            className="button primary"
            type="button"
            aria-disabled={busy}
            onClick={() => !busy && onAnswer(true)}
          >
            {t("interface.RecordingRecovery.keep")}
          </button>
        </footer>
      </section>
    </div>
  );
}
