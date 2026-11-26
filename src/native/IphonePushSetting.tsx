import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../i18n";

/** What the iPhone's push setting is, as native says it (`supported` is true on an iPhone only, so
 * everywhere else this renders nothing). `state` says why the notices are not coming when the patient
 * has asked for them. */
export type IphonePushStatus = {
  supported: boolean;
  /** The patient's choice, kept on this device. Off until they turn it on. */
  enabled: boolean;
  state:
    | "ok"
    /** The patient said no when the iPhone asked. */
    | "refused"
    /** Notices were allowed once and are off for myCarlos in the iPhone's Settings now. */
    | "iosOff"
    /** The iPhone or Apple could not give this install a token. */
    | "unavailable"
    /** Apple did not answer in time. */
    | "timedOut"
    /** The portal could not be given a place for notices, even after enrolling anew. */
    | "needsAttention";
};

const STATE_LINES = {
  refused: "iphonePush.refused",
  iosOff: "iphonePush.iosOff",
  unavailable: "iphonePush.unavailable",
  timedOut: "iphonePush.timedOut",
  needsAttention: "iphonePush.needsAttention",
} as const;

/**
 * Notices when myCarlos is closed, on an iPhone, through Apple's push service. A small component of
 * its own: it asks native for its status, shows nothing unless this is an iPhone, and turns the
 * choice on or off with one command. The system's permission question is asked by native when the
 * switch is turned on, never before. Off by default.
 */
export function IphonePushSetting() {
  const { t } = useI18n();
  const id = useId();
  const [status, setStatus] = useState<IphonePushStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const request = useRef(0);
  // True while a change is waiting for the system (its permission question takes the app out of
  // the foreground and back, which fires `focus`): a refresh then must not make the change's own
  // answer look stale.
  const changing = useRef(false);
  const refreshOwed = useRef(false);

  const refresh = useCallback(() => {
    if (changing.current) {
      refreshOwed.current = true;
      return;
    }
    const issued = ++request.current;
    void invoke<IphonePushStatus>("vault_iphone_push_status").then(
      (value) => {
        if (mounted.current && issued === request.current) setStatus(value);
      },
      // No such command (not an iPhone build): nothing to show.
      () => {
        if (mounted.current && issued === request.current) setStatus(null);
      },
    );
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    mounted.current = true;
    refresh();
    // The patient may have changed iPhone Settings and come back.
    window.addEventListener("focus", refresh);
    return () => {
      mounted.current = false;
      request.current++;
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  if (!status?.supported) return null;

  const change = (enabled: boolean) => {
    const issued = ++request.current;
    changing.current = true;
    setSaving(true);
    setFailed(false);
    void invoke<IphonePushStatus>("vault_iphone_push_set", { enabled })
      .then(
        (value) => {
          if (mounted.current && issued === request.current) setStatus(value);
        },
        () => {
          if (mounted.current && issued === request.current) setFailed(true);
        },
      )
      .finally(() => {
        changing.current = false;
        if (!mounted.current) return;
        setSaving(false);
        // A focus came while the system was asked: read the status once now that it is settled.
        if (refreshOwed.current) {
          refreshOwed.current = false;
          refresh();
        }
      });
  };

  const line =
    status.enabled && status.state !== "ok" ? STATE_LINES[status.state] : null;
  const describedBy = [`${id}-help`, line ? `${id}-state` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <section className="setting-row" aria-labelledby={`${id}-title`}>
      <div>
        <h2 id={`${id}-title`}>{t("iphonePush.title")}</h2>
        <p id={`${id}-help`}>{t("iphonePush.help")}</p>
      </div>
      <div className="appearance-choice preferences-checks">
        <label className="appearance-option">
          <input
            type="checkbox"
            checked={status.enabled}
            disabled={saving}
            aria-describedby={describedBy}
            onChange={(event) => change(event.currentTarget.checked)}
          />
          <span>{t("iphonePush.allow")}</span>
        </label>
        {/* Always on the page, so what happened is read out when it comes. */}
        <p id={`${id}-state`} role="status">
          {line ? t(line) : ""}
        </p>
        {failed && <p role="alert">{t("iphonePush.error")}</p>}
      </div>
    </section>
  );
}
