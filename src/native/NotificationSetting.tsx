import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { MoreAbout } from "./MoreAbout";

type NoticeStatus = {
  supported: boolean;
  available: boolean;
  enabled: boolean;
  automaticChecksSupported?: boolean;
  automaticChecksEnabled?: boolean;
  automaticChecksPaused?: boolean;
  /** This computer can show a notice (Windows today): the notice switch is an add-on offered
   * only then. The automatic checks do not depend on it. */
  noticesSupported?: boolean;
  permission: "unavailable" | "unknown" | "allowed" | "blocked";
};

/** What a press of "Show a test notice" came to (native `TestNotice`). */
type TestNoticeResult =
  | "shown"
  | "blocked"
  | "notAllowed"
  | "tooSoon"
  | "failed";

/** Native owns consent, event identity, persistence and the fixed OS message.
 * `headingLevel` 3 when it sits under another heading (the notices step after
 * the first clinic link); `onSaved` hears each choice native has saved. */
export function NotificationSetting({
  headingLevel = 2,
  onSaved,
}: { headingLevel?: 2 | 3; onSaved?: () => void } = {}) {
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;
  const { t, locale } = useI18n();
  const id = useId();
  const [status, setStatus] = useState<NoticeStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestNoticeResult | null>(null);
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
  // The same generic notice an arrival shows, with a fixed sentence: nothing of the vault is sent.
  const sendTest = () => {
    setTesting(true);
    setTestResult(null);
    void invoke<TestNoticeResult>("vault_send_test_notice")
      .then(
        (result) => {
          if (!mounted.current) return;
          setTestResult(result);
          // Windows said no: the line that tells how to allow it shows, as it does for any check.
          if (result === "blocked")
            setStatus((previous) =>
              previous ? { ...previous, permission: "blocked" } : previous,
            );
        },
        () => {
          if (mounted.current) setTestResult("failed");
        },
      )
      .finally(() => {
        if (mounted.current) setTesting(false);
      });
  };
  const save = (command: string, enabled: boolean) => {
    setTestResult(null);
    const issued = ++request.current;
    savingNow.current = true;
    setSaving(true);
    setFailed(false);
    void invoke<NoticeStatus>(command, { enabled })
      .then(
        (value) => {
          if (mounted.current && issued === request.current) setStatus(value);
          savedRef.current?.();
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
  // Why the notice box may be disabled is read with it: the permission lines when they show.
  const permissionIds = [
    status.permission === "blocked" ? `${id}-blocked` : "",
    status.permission === "unknown" ? `${id}-unknown` : "",
  ].filter(Boolean);
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const notices = status.noticesSupported === true;
  const automatic = status.automaticChecksSupported === true;
  return (
    <section className="setting-row">
      <div>
        <Heading>{t("notifications.title")}</Heading>
        {automatic && (
          <>
            <p id={`${id}-help`}>{t("notifications.helpAutomatic")}</p>
            {/* The fact that matters stays in view; the long explanation folds away. */}
            <p id={`${id}-auto-summary`}>{t("notifications.autoSummary")}</p>
            <MoreAbout label={t("preferences.moreAutomatic")}>
              <p id={`${id}-auto-help`}>{t("notifications.autoHelp")}</p>
            </MoreAbout>
          </>
        )}
      </div>
      <div className="appearance-choice preferences-checks">
        {automatic && (
          <>
            {/* The automatic check is its own choice, with its own consent: it contacts the
                clinic's portal on a schedule. It does not need the notices below. */}
            <label className="appearance-option">
              <input
                type="checkbox"
                checked={status.automaticChecksEnabled === true}
                disabled={
                  saving ||
                  (!status.available && !status.automaticChecksEnabled)
                }
                aria-describedby={`${id}-auto-help ${id}-auto-consent`}
                onChange={(event) =>
                  save(
                    "vault_set_automatic_document_checks",
                    event.currentTarget.checked,
                  )
                }
              />
              <span>{t("notifications.autoAllow")}</span>
            </label>
            <p id={`${id}-auto-consent`}>{t("notifications.autoConsent")}</p>
            {status.automaticChecksEnabled && status.automaticChecksPaused && (
              <p role="status">{t("notifications.autoPaused")}</p>
            )}
          </>
        )}
        {/* The notice is an optional add-on, offered only where the system can show one. */}
        {notices && (
          <>
            <label className="appearance-option">
              <input
                type="checkbox"
                checked={status.enabled}
                disabled={saving || (!status.available && !status.enabled)}
                aria-describedby={[`${id}-notices-help`, ...permissionIds].join(
                  " ",
                )}
                onChange={(event) =>
                  save("vault_set_notifications", event.currentTarget.checked)
                }
              />
              <span>{t("notifications.allow")}</span>
            </label>
            <p id={`${id}-notices-help`}>{t("notifications.noticesHelp")}</p>
            <button
              className="button"
              type="button"
              disabled={saving || testing || !status.enabled}
              onClick={sendTest}
            >
              {t("notifications.testButton")}
            </button>
            {/* Always on the page, so a screen reader hears what the press came to. */}
            <p aria-live="polite">
              {testResult === "shown"
                ? t("notifications.testSent")
                : testResult === "tooSoon"
                  ? t("notifications.testWait")
                  : testResult === "notAllowed"
                    ? t("notifications.testOff")
                    : testResult === "failed"
                      ? t("notifications.testFailed")
                      : ""}
            </p>
            {status.permission === "blocked" && (
              <p id={`${id}-blocked`}>{t("notifications.blocked")}</p>
            )}
            {status.permission === "unknown" && (
              <p id={`${id}-unknown`}>{t("notifications.unknown")}</p>
            )}
          </>
        )}
        {!status.available && !failed && (
          <p role="alert">{t("notifications.unavailable")}</p>
        )}
        {failed && <p role="alert">{t("notifications.error")}</p>}
      </div>
    </section>
  );
}
