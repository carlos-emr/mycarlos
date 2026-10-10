import { useId, useSyncExternalStore } from "react";
import { useAppearance } from "../AppearanceProvider";
import { appearanceMode, type Appearance } from "../appearance";

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
      <div className="appearance-choice">
        <label htmlFor={id}>Appearance</label>
        <select
          id={id}
          value={state.mode}
          aria-describedby={`${id}-description${error ? ` ${id}-error` : ""}`}
          onChange={(event) =>
            appearance.set(appearanceMode(event.target.value))
          }
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
        {error && (
          <p id={`${id}-error`} className="appearance-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
