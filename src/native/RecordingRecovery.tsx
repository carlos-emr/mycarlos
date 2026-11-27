import { useEffect, useRef, useState } from "react";
import { useModalFocus } from "../useModalFocus";
import { useI18n } from "../i18n";
import type { PendingRecording } from "../vault";

/** The question at unlock after a crash cut a recording short (#359): Keep what
 * was saved, the default, or Delete it. (A recording a lock parked is not asked
 * about: it is saved, and the patient is told.) Delete does not delete at once:
 * it asks again, and says it cannot be undone. Closing the question without an
 * answer leaves the recording as it is, and it comes back at the next unlock. */
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
  const [confirming, setConfirming] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  // Escape goes back from the confirmation to the question, and out of the
  // question to "later". Never to a deletion.
  useModalFocus(
    true,
    dialogRef,
    () => {
      if (busy) return;
      if (confirming) setConfirming(false);
      else onLater();
    },
    keepRef,
  );
  // The safe answer has the focus, in the question and again in the confirmation.
  useEffect(() => {
    keepRef.current?.focus();
  }, [confirming]);
  const question = recording.paused
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
          <h2 id="recording-recovery-title">
            {confirming
              ? t("interface.RecordingRecovery.deleteSure")
              : t(question)}
          </h2>
        </header>
        <p id="recording-recovery-name" className="native-dialog-status">
          {t("interface.RecordingRecovery.name", {
            name: recording.displayName,
          })}
        </p>
        <footer className="dialog-actions">
          {confirming ? (
            <>
              {/* Keep is first and the default: the safe answer is the easy one. */}
              <button
                ref={keepRef}
                className="button primary"
                type="button"
                aria-disabled={busy}
                onClick={() => !busy && onAnswer(true)}
              >
                {t("interface.RecordingRecovery.keep")}
              </button>
              <button
                className="button"
                type="button"
                aria-disabled={busy}
                onClick={() => !busy && onAnswer(false)}
              >
                {t("interface.RecordingRecovery.delete")}
              </button>
            </>
          ) : (
            <>
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
                onClick={() => !busy && setConfirming(true)}
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
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
