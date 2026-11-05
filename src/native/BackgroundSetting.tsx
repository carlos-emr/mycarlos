import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../i18n";

type BackgroundStatus = {
  supported: boolean;
  keepRunning: boolean;
  startAtLogin: boolean;
  trayReady: boolean;
  pausedWhileLocked: boolean;
};

/** Settings > Preferences: keep myCarlos running in the background, and start it at login. Both
 * are off until chosen. Native owns the icon, the lock on close and the login entry; this only
 * asks, and shows what native says. Computers only: a phone reports it unsupported. */
export function BackgroundSetting() {
  const { t, locale } = useI18n();
  const id = useId();
  const [status, setStatus] = useState<BackgroundStatus | null>(null);
  const [saving, setSaving] = useState(false);
  // Why the last change was refused: with no icon to get back in by, keeping it running is
  // unavailable here; anything else is a plain failure.
  const [failed, setFailed] = useState<
    "background.unavailable" | "background.error" | null
  >(null);
  const request = useRef(0);
  const mounted = useRef(false);
  const savingNow = useRef(false);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    mounted.current = true;
    const refresh = () => {
      if (savingNow.current) return;
      const issued = ++request.current;
      // The language goes along so the tray icon's menu is worded in it.
      void invoke<BackgroundStatus>("background_status", { locale }).then(
        (value) => {
          if (mounted.current && issued === request.current) setStatus(value);
        },
        () => {
          if (mounted.current && issued === request.current) setStatus(null);
        },
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      mounted.current = false;
      request.current++;
      window.removeEventListener("focus", refresh);
    };
  }, [locale]);
  const save = (command: string, enabled: boolean) => {
    const refusal =
      command === "background_set_keep_running"
        ? "background.unavailable"
        : "background.error";
    const issued = ++request.current;
    savingNow.current = true;
    setSaving(true);
    setFailed(null);
    void invoke<BackgroundStatus>(command, { enabled })
      .then(
        (value) => {
          if (mounted.current && issued === request.current) setStatus(value);
        },
        () => {
          // Native changed nothing: the box stays as it was, and says so.
          if (mounted.current && issued === request.current) setFailed(refusal);
        },
      )
      .finally(() => {
        savingNow.current = false;
        if (mounted.current) setSaving(false);
      });
  };
  if (!status?.supported) return null;
  return (
    <section className="setting-row">
      <div>
        <h2>{t("background.title")}</h2>
      </div>
      <div className="appearance-choice">
        <p id={`${id}-keep-help`}>{t("background.keepRunningHelp")}</p>
        <label className="appearance-option">
          <input
            type="checkbox"
            checked={status.keepRunning}
            disabled={saving}
            aria-describedby={`${id}-keep-help`}
            onChange={(event) =>
              save("background_set_keep_running", event.currentTarget.checked)
            }
          />
          <span>{t("background.keepRunning")}</span>
        </label>
        {status.keepRunning && <p role="status">{t("background.paused")}</p>}
        <p id={`${id}-login-help`}>{t("background.startAtLoginHelp")}</p>
        <label className="appearance-option">
          <input
            type="checkbox"
            checked={status.startAtLogin}
            disabled={saving}
            aria-describedby={`${id}-login-help`}
            onChange={(event) =>
              save("background_set_start_at_login", event.currentTarget.checked)
            }
          />
          <span>{t("background.startAtLogin")}</span>
        </label>
        {failed && <p role="alert">{t(failed)}</p>}
      </div>
    </section>
  );
}
