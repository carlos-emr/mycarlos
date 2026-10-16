import { useId, useSyncExternalStore } from "react";
import { useAppearance } from "../AppearanceProvider";
import type { Appearance, AppearanceMode } from "../appearance";

// All three choices stay in view: a short list of radio buttons is easier to
// read and press than a dropdown (#67).
const CHOICES: ReadonlyArray<[AppearanceMode, string]> = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

export function AppearanceSetting() {
  const appearance = useAppearance();
  return appearance ? <AppearanceChoice appearance={appearance} /> : null;
}

function AppearanceChoice({ appearance }: { appearance: Appearance }) {
  const state = useSyncExternalStore(appearance.subscribe, appearance.snapshot);
  const id = useId();
  const error = [state.storageError, state.nativeError]
    .filter(Boolean)
    .join(" ");
  return (
    <section className="setting-row native-setting-form">
      <div>
        <h2>Appearance</h2>
        <p id={`${id}-description`}>
          System follows your device's light or dark appearance. High contrast
          follows your device automatically.
        </p>
      </div>
      <fieldset
        className="appearance-choice"
        aria-describedby={`${id}-description${error ? ` ${id}-error` : ""}`}
      >
        {/* The heading above already says it; the legend names the group for screen readers. */}
        <legend className="sr-only">Appearance</legend>
        {CHOICES.map(([mode, label]) => (
          <label className="appearance-option" key={mode}>
            <input
              type="radio"
              name={id}
              value={mode}
              checked={state.mode === mode}
              onChange={() => appearance.set(mode)}
            />
            {label}
          </label>
        ))}
        {error && (
          <p id={`${id}-error`} className="appearance-error" role="alert">
            {error}
          </p>
        )}
      </fieldset>
    </section>
  );
}
