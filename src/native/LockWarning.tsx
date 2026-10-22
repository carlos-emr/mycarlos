import { useEffect, useRef, useState } from "react";
import { useModalFocus } from "../useModalFocus";
import { useI18n } from "../i18n";

/** When the countdown says, once, how little time is left. */
const LAST_CALL_SECONDS = 10;

/**
 * Said before the automatic lock (#68, WCAG 2.2.1): Keep open has the focus
 * and keeps myCarlos open, and so does any key, click or touch, as use. A
 * screen reader reads it as it opens. Nothing of the records is shown.
 *
 * The heading counts down (Ben, #77): 30, 29, 28… Only what is on screen
 * changes. The dialog's name stays the time it opened with, so a screen
 * reader says it once, and a polite status says once, at 10 seconds, how
 * little is left.
 */
export function LockWarning({
  seconds,
  onKeepOpen,
}: {
  seconds: number;
  onKeepOpen: () => void;
}) {
  const { t } = useI18n();
  const lockIn = (count: number) => t("lockWarning.title", { count });
  const dialogRef = useRef<HTMLElement | null>(null);
  const keepOpenRef = useRef<HTMLButtonElement | null>(null);
  // Escape is a key like any other: it keeps myCarlos open.
  useModalFocus(true, dialogRef, onKeepOpen, keepOpenRef);
  const [opening] = useState(seconds);
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      const passed = Math.floor((Date.now() - started) / 1000);
      setLeft(Math.max(0, opening - passed));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [opening]);
  return (
    <div className="dialog-backdrop lock-warning-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="record-dialog native-lock-warning"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="lock-warning-title"
        aria-describedby="lock-warning-help"
      >
        <h2 id="lock-warning-title">
          <span aria-hidden="true">{lockIn(left)}</span>
          <span className="sr-only">{lockIn(opening)}</span>
        </h2>
        <p id="lock-warning-help">
          {t("lockWarning.help", { keepOpen: t("lockWarning.keepOpen") })}
        </p>
        <p className="sr-only" role="status">
          {left <= LAST_CALL_SECONDS && left > 0 && opening > LAST_CALL_SECONDS
            ? t("lockWarning.left", { count: LAST_CALL_SECONDS })
            : ""}
        </p>
        <button
          ref={keepOpenRef}
          className="button primary"
          type="button"
          onClick={onKeepOpen}
        >
          {t("lockWarning.keepOpen")}
        </button>
      </section>
    </div>
  );
}
