import { useId } from "react";
import { AUTO_LOCK_MAX, AUTO_LOCK_MIN } from "./autoLock";

/**
 * The automatic lock delay as minus and plus, like Text size, instead of a
 * list of 15 (#67), for Security and for first setup (#69). The ends are not
 * disabled, which would drop the focus on them; the value is read out when
 * it changes, and describes each button, so it is also said on focus.
 */
export function AutoLockSetting({
  minutes,
  onMinutes,
}: {
  minutes: number;
  onMinutes: (minutes: number) => void;
}) {
  const valueId = useId();
  return (
    <div
      className="text-size-control auto-lock-control"
      role="group"
      aria-label="Automatic lock delay"
    >
      <button
        className="button text-size-step"
        type="button"
        aria-label="Shorter delay"
        aria-describedby={valueId}
        aria-disabled={minutes <= AUTO_LOCK_MIN}
        onClick={() => {
          if (minutes > AUTO_LOCK_MIN) onMinutes(minutes - 1);
        }}
      >
        <span aria-hidden="true">−</span>
      </button>
      <span className="auto-lock-value" id={valueId} aria-live="polite">
        {minutes} minute{minutes === 1 ? "" : "s"}
      </span>
      <button
        className="button text-size-step"
        type="button"
        aria-label="Longer delay"
        aria-describedby={valueId}
        aria-disabled={minutes >= AUTO_LOCK_MAX}
        onClick={() => {
          if (minutes < AUTO_LOCK_MAX) onMinutes(minutes + 1);
        }}
      >
        <span aria-hidden="true">+</span>
      </button>
    </div>
  );
}
