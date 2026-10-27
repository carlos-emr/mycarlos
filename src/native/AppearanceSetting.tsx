import { useId, useSyncExternalStore } from "react";
import { useAppearance } from "../AppearanceProvider";
import type {
  Appearance,
  AppearanceError,
  AppearanceMode,
} from "../appearance";
import { useI18n, type MessageKey } from "../i18n";

// All four choices stay in view: a short list of radio buttons is easier to
// read and press than a dropdown (#67).
const CHOICES: ReadonlyArray<[AppearanceMode, MessageKey]> = [
  ["system", "appearance.system"],
  ["light", "appearance.light"],
  ["dark", "appearance.dark"],
  ["high-contrast", "appearance.highContrast"],
];

export function AppearanceSetting() {
  const appearance = useAppearance();
  return appearance ? <AppearanceChoice appearance={appearance} /> : null;
}

function AppearanceChoice({ appearance }: { appearance: Appearance }) {
  const state = useSyncExternalStore(appearance.subscribe, appearance.snapshot);
  const id = useId();
  const { t } = useI18n();
  const system = t("appearance.system");
  const error = [state.storageError, state.nativeError]
    .filter((key): key is Exclude<AppearanceError, ""> => key !== "")
    .map((key) => t(key, { system }))
    .join(" ");
  return (
    <section className="setting-row native-setting-form">
      <div>
        <h2>{t("appearance.title")}</h2>
        <p id={`${id}-description`}>{t("appearance.help", { system })}</p>
      </div>
      <fieldset
        className="appearance-choice"
        aria-describedby={`${id}-description${error ? ` ${id}-error` : ""}`}
      >
        {/* The heading above already says it; the legend names the group for screen readers. */}
        <legend className="sr-only">{t("appearance.title")}</legend>
        {CHOICES.map(([mode, label]) => (
          <label className="appearance-option" key={mode}>
            <input
              type="radio"
              name={id}
              value={mode}
              checked={state.mode === mode}
              onChange={() => appearance.set(mode)}
            />
            <span>{t(label)}</span>
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
