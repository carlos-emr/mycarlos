import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../i18n";

type NoticeStatus = {
  supported: boolean;
  available: boolean;
  enabled: boolean;
  automaticChecksSupported?: boolean;
  automaticChecksEnabled?: boolean;
  automaticChecksPaused?: boolean;
  permission: "unavailable" | "unknown" | "allowed" | "blocked";
};

/** Native owns consent, event identity, persistence and the fixed OS message. */
export function NotificationSetting() {
  const { t, locale } = useI18n();
  const id = useId();
  const [status, setStatus] = useState<NoticeStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  const mounted = useRef(false);
  const savingNow = useRef(false);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    mounted.current = true;
    const refresh = () => {
      if (savingNow.current) return;
      const issued = ++request.current;
      // The language goes along so a later notice is worded in it; native keeps the last one.
      void invoke<NoticeStatus>("vault_notification_status", { locale }).then(
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
    const issued = ++request.current;
    savingNow.current = true;
    setSaving(true);
    setFailed(false);
    void invoke<NoticeStatus>(command, { enabled })
      .then(
        (value) => {
          if (mounted.current && issued === request.current) setStatus(value);
        },
        () => {
          if (mounted.current && issued === request.current) {
            setStatus((previous) =>
              previous
                ? {
                    ...previous,
                    enabled: false,
                    automaticChecksEnabled: false,
                    available: false,
                  }
                : null,
            );
            setFailed(true);
          }
        },
      )
      .finally(() => {
        savingNow.current = false;
        if (mounted.current) setSaving(false);
      });
  };
  if (!status?.supported) return null;
  // Why a box may be disabled is read with it: the permission lines when they show.
  const permissionIds = [
    status.permission === "blocked" ? `${id}-blocked` : "",
    status.permission === "unknown" ? `${id}-unknown` : "",
  ].filter(Boolean);
  const describedBy = (helpId: string) => [helpId, ...permissionIds].join(" ");
  return (
    <section className="setting-row">
      <div>
        <h2>{t("notifications.title")}</h2>
        <p id={`${id}-help`}>
          {t(
            status.automaticChecksSupported
              ? "notifications.helpAutomatic"
              : "notifications.help",
          )}
        </p>
      </div>
      <div className="appearance-choice">
        <label className="appearance-option">
          <input
            type="checkbox"
            checked={status.enabled}
            disabled={saving || (!status.available && !status.enabled)}
            aria-describedby={describedBy(`${id}-help`)}
            onChange={(event) =>
              save("vault_set_notifications", event.currentTarget.checked)
            }
          />
          <span>{t("notifications.allow")}</span>
        </label>
        {status.automaticChecksSupported && (
          <>
            <p id={`${id}-auto-help`}>{t("notifications.autoHelp")}</p>
            <label className="appearance-option">
              <input
                type="checkbox"
                checked={status.automaticChecksEnabled === true}
                disabled={
                  saving ||
                  ((!status.available || !status.enabled) &&
                    !status.automaticChecksEnabled)
                }
                aria-describedby={describedBy(`${id}-auto-help`)}
                onChange={(event) =>
                  save(
                    "vault_set_automatic_document_checks",
                    event.currentTarget.checked,
                  )
                }
              />
              <span>{t("notifications.autoAllow")}</span>
            </label>
            {status.automaticChecksEnabled && status.automaticChecksPaused && (
              <p role="status">{t("notifications.autoPaused")}</p>
            )}
          </>
        )}
        {status.permission === "blocked" && (
          <p id={`${id}-blocked`}>{t("notifications.blocked")}</p>
        )}
        {status.permission === "unknown" && (
          <p id={`${id}-unknown`}>{t("notifications.unknown")}</p>
        )}
        {!status.available && !failed && (
          <p role="alert">{t("notifications.unavailable")}</p>
        )}
        {failed && <p role="alert">{t("notifications.error")}</p>}
      </div>
    </section>
  );
}
