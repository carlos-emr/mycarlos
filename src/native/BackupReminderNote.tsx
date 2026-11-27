import { useI18n } from "../i18n";
import { dayStartMs, type BackupReminder } from "./backupReminder";

/** Which words say what a lost device loses: a computer, an iPhone or iPad, or an Android device. */
export type BackupDevice = "computer" | "ios" | "android";

/**
 * A dismissible note in the library: make a myCarlos encrypted backup (the vault is kept out of the
 * device's own backups where the platform allows). It says why it is shown, says plainly what is lost if
 * the device is, and offers the backup, or "Not now" for a while. Quiet on purpose: a note, not a
 * dialog; it never blocks anything.
 */
export function BackupReminderNote({
  reminder,
  device,
  busy,
  onMake,
  onNotNow,
}: {
  reminder: BackupReminder;
  device: BackupDevice;
  busy: boolean;
  onMake: () => void;
  onNotNow: () => void;
}) {
  const { t, locale } = useI18n();
  const why =
    reminder.kind === "never"
      ? t("backupReminder.never")
      : reminder.kind === "partial"
        ? t("backupReminder.partial")
        : reminder.kind === "old"
          ? t("backupReminder.old", {
              // The app's language, not the browser's, and the day as the patient's calendar day.
              date: new Intl.DateTimeFormat(locale, {
                dateStyle: "long",
                timeZone: "UTC",
              }).format(new Date(dayStartMs(reminder.savedDay))),
            })
          : t("backupReminder.many", { count: reminder.added });
  return (
    <div
      className="native-backup-reminder"
      role="note"
      aria-label={t("backupReminder.label")}
    >
      <p>
        {why}{" "}
        {t(
          device === "ios"
            ? "backupReminder.ios"
            : device === "android"
              ? "backupReminder.android"
              : "backupReminder.computer",
        )}
      </p>
      <button className="button" type="button" disabled={busy} onClick={onMake}>
        {t("backupReminder.make")}
      </button>
      <button className="button" type="button" onClick={onNotNow}>
        {t("backupReminder.notNow")}
      </button>
    </div>
  );
}
