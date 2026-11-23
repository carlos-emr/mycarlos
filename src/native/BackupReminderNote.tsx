import { useI18n } from "../i18n";
import type { BackupReminder } from "./backupReminder";

/**
 * A dismissible note in the library: make a myCarlos encrypted backup (the vault is not in the
 * phone's or the computer's own backups). It says why it is shown, says plainly what is lost if the
 * device is, and offers the backup, or "Not now" for a while. Quiet on purpose: a note, not a
 * dialog; it never blocks anything.
 */
export function BackupReminderNote({
  reminder,
  phone,
  busy,
  onMake,
  onNotNow,
}: {
  reminder: BackupReminder;
  /** A phone: the vault is in neither iCloud nor the device's own backups. */
  phone: boolean;
  busy: boolean;
  onMake: () => void;
  onNotNow: () => void;
}) {
  const { t } = useI18n();
  const why =
    reminder.kind === "never"
      ? t("backupReminder.never")
      : reminder.kind === "old"
        ? t("backupReminder.old", {
            date: new Date(reminder.savedAtMs).toLocaleDateString(),
          })
        : t("backupReminder.many", { count: reminder.added });
  return (
    <div
      className="native-backup-reminder"
      role="note"
      aria-label={t("backupReminder.label")}
    >
      <p>
        {why} {t(phone ? "backupReminder.phone" : "backupReminder.computer")}
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
