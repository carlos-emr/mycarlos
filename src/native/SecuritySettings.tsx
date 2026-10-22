import { SecretInput } from "./SecretInput";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "../Icon";
import { useI18n, withElements, type MessageKey, type Params } from "../i18n";
import {
  MAX_PASSPHRASE_BYTES,
  isLockedError,
  utf8Length,
  vaultErrorMessage,
  type SpeedTestReport,
} from "../vault";
import { AutoLockSetting } from "./AutoLockSetting";
import {
  NAME_INPUT_MAX_LENGTH,
  SHARED_NAME_TAKEN,
  nameIsShared,
  nameTooLong,
} from "./recordPresentation";
import {
  MIN_PASSPHRASE_CHARS,
  tooShortPassphrase,
} from "./VaultAuth";
import { KeyLabel, printedDate } from "./KeyLabel";
import type { OldBackupsGuide } from "./oldBackups";
import { formatFileSize } from "./recordPresentation";

interface SecuritySettingsProps {
  busy: boolean;
  readOnly: boolean;
  notice: string;
  autoLockMinutes: number;
  onAutoLockMinutes: (value: unknown) => void;
  onLock: () => Promise<void>;
  onChangePassphrase: (current: string, replacement: string) => Promise<void>;
  onCreateProfile: (name: string) => Promise<boolean>;
  /** When the recovery key was set up, or null if there is none. */
  recoveryKeySetAtMs: number | null;
  /** Its short label, which its kit shows. */
  recoveryKeyLabel?: string | null;
  /** The steps for older backups after a key whose kit may have been lost
   * or seen was replaced, if any are left. */
  oldBackupsGuide?: OldBackupsGuide | null;
  onOldBackupsGuideDone?: () => void;
  /** Whether this platform's file app counts sizes in 1024s (Windows). */
  sizesIn1024s?: boolean;
  onSetUpRecoveryKey: () => void;
  onSaveBackup: () => Promise<void>;
  onSpeedTest: () => Promise<SpeedTestReport>;
}

/** One line a tester can copy into the benchmark record. */
export function speedTestLine(report: SpeedTestReport): string {
  return [
    `${report.samplesMs.length} runs: ${report.samplesMs.join(", ")} ms.`,
    `Median ${report.medianMs} ms, longest ${report.maxMs} ms.`,
    `Argon2id, ${report.memoryKib / 1024} MiB, ${report.iterations} passes, ${report.lanes} lanes.`,
    `${report.platform} ${report.architecture}, myCarlos ${report.appVersion}.`,
    `${report.release ? "Release build" : "Evaluation build"}${report.simulator ? ", Simulator" : ""}.`,
  ].join(" ");
}

/** Which file the new backup is: by name when the platform said, otherwise by
 * when it was saved. Its size, as the platform's file app counts it, tells it
 * from an empty or partial one. */
function newBackupText(
  t: (key: MessageKey, params?: Params) => string,
  guide: Extract<OldBackupsGuide, { step: "delete" }>,
  in1024s: boolean,
): string {
  const size =
    guide.bytes === null ? null : formatFileSize(guide.bytes, in1024s);
  if (guide.keep) {
    return size === null
      ? t("security.oldBackups.named", { name: guide.keep })
      : t("security.oldBackups.namedWithSize", { name: guide.keep, size });
  }
  const saved = new Date(guide.savedAtMs);
  const date = printedDate(saved);
  // In the system's format, like printedDate: they match the language while it
  // follows the system.
  const time = saved.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return size === null
    ? t("security.oldBackups.justSaved", { date, time })
    : t("security.oldBackups.justSavedWithSize", { date, time, size });
}

export function SecuritySettings({
  busy,
  readOnly,
  notice,
  autoLockMinutes,
  onAutoLockMinutes,
  onLock,
  onChangePassphrase,
  onCreateProfile,
  recoveryKeySetAtMs,
  recoveryKeyLabel = null,
  oldBackupsGuide = null,
  onOldBackupsGuideDone,
  sizesIn1024s = false,
  onSetUpRecoveryKey,
  onSaveBackup,
  onSpeedTest,
}: SecuritySettingsProps) {
  const { t } = useI18n();
  const [speedTest, setSpeedTest] = useState<{
    running: boolean;
    result: string;
    failed: string;
  }>({ running: false, result: "", failed: "" });
  // Whether this screen is still shown: once the app has locked by itself,
  // a test's late "locked" answer must not lock again.
  const shown = useRef(false);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  const runSpeedTest = async () => {
    if (busy || speedTest.running) return;
    setSpeedTest({ running: true, result: "", failed: "" });
    try {
      const report = await onSpeedTest();
      setSpeedTest({
        running: false,
        result: speedTestLine(report),
        failed: "",
      });
    } catch (error) {
      // The vault locked before or while it ran (the automatic lock does
      // not wait for it): the app locks too, rather than leave the library
      // on screen.
      if (isLockedError(error)) {
        setSpeedTest({ running: false, result: "", failed: "" });
        if (shown.current) void onLock();
        return;
      }
      setSpeedTest({
        running: false,
        result: "",
        failed: vaultErrorMessage(error),
      });
    }
  };
  const [profileName, setProfileName] = useState("");
  const [currentPassphrase, setCurrentPassphrase] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [newPassphraseConfirmation, setNewPassphraseConfirmation] =
    useState("");
  const currentPassphraseTooLong =
    utf8Length(currentPassphrase) > MAX_PASSPHRASE_BYTES;
  const newPassphraseTooLong = utf8Length(newPassphrase) > MAX_PASSPHRASE_BYTES;
  const newPassphraseTooShort = tooShortPassphrase(newPassphrase);
  const passphraseFormInvalid =
    currentPassphraseTooLong ||
    newPassphraseTooLong ||
    newPassphraseTooShort ||
    newPassphrase !== newPassphraseConfirmation;

  const submitPassphrase = (event: FormEvent) => {
    event.preventDefault();
    if (passphraseFormInvalid) return;
    const current = currentPassphrase;
    const replacement = newPassphrase;
    setCurrentPassphrase("");
    setNewPassphrase("");
    setNewPassphraseConfirmation("");
    void onChangePassphrase(current, replacement);
  };
  const submitProfile = (event: FormEvent) => {
    event.preventDefault();
    // Cleared only once the profile exists, so a refused name can be corrected.
    void onCreateProfile(profileName).then((created) => {
      if (created) setProfileName("");
    });
  };
  return (
    <main className="library-main purpose-screen">
      <div className="main-head">
        <div>
          <h1>{t("security.title")}</h1>
          <p>{t("security.subtitle")}</p>
        </div>
      </div>
      <div className="purpose-note warning">
        <Icon name="info" />
        <span>
          <strong>{t("security.devBuild.title")}</strong>{" "}
          {t("security.devBuild.body")}
        </span>
      </div>
      <p className="status-line" role="status" aria-live="polite">
        {notice}
      </p>
      <div className="setting-list">
        <section className="setting-row">
          <div>
            <h2>
              {t("security.encryption.title")}{" "}
              <span className="state-pill">
                {t("security.encryption.state")}
              </span>
            </h2>
            <p>{t("security.encryption.body")}</p>
          </div>
        </section>
        {/* #71: the privacy notice says what is kept. */}
        <section className="setting-row" aria-labelledby="what-is-kept">
          <div>
            <h2 id="what-is-kept">What myCarlos keeps</h2>
            <p>
              myCarlos never deletes a document. Hiding one takes it out of
              view: it stays in the encrypted vault, listed under Hidden, and
              can be restored. Readable copies you save outside myCarlos are
              yours to keep or delete.
            </p>
            <p>
              myCarlos also keeps a history: when the vault was opened; when its
              passphrase or recovery key was set or changed, and when a backup
              was saved or restored; when each patient profile was added and
              each folder made, renamed or moved; and when each document was
              added, renamed, moved, hidden, restored or saved outside myCarlos,
              and where. It is encrypted with everything else. myCarlos does not
              show it, and never changes or removes it.
            </p>
            <p>
              Starting again, or restoring a backup over this vault, sets the
              vault aside: it stays on this device, encrypted. myCarlos never
              deletes a vault.
            </p>
          </div>
        </section>
        <section className="setting-row native-setting-form">
          <div>
            <h2>
              {t("security.autoLock.title")}{" "}
              <span className="state-pill">
                {t("security.autoLock.minutes", { count: autoLockMinutes })}
              </span>
            </h2>
            <p>{t("security.autoLock.body")}</p>
          </div>
          <div>
            <AutoLockSetting
              minutes={autoLockMinutes}
              onMinutes={onAutoLockMinutes}
            />
            <button
              className="button"
              type="button"
              onClick={() => void onLock()}
            >
              {t("security.lockNow")}
            </button>
          </div>
        </section>
        <section className="setting-row">
          <div>
            <h2>
              {t("security.recoveryKey.title")}{" "}
              <span className="state-pill">
                {recoveryKeySetAtMs
                  ? t("security.recoveryKey.setUpOn", {
                      date: printedDate(new Date(recoveryKeySetAtMs)),
                    })
                  : t("security.recoveryKey.notSetUp")}
              </span>
            </h2>
            <p>{t("security.recoveryKey.body")}</p>
            {recoveryKeySetAtMs && recoveryKeyLabel && (
              <p>
                {withElements(
                  t("security.recoveryKey.current", {
                    date: printedDate(new Date(recoveryKeySetAtMs)),
                  }),
                  { label: <KeyLabel label={recoveryKeyLabel} /> },
                )}
              </p>
            )}
          </div>
          <div>
            <button
              className="button"
              type="button"
              disabled={busy || readOnly}
              onClick={onSetUpRecoveryKey}
            >
              {recoveryKeySetAtMs
                ? t("security.recoveryKey.replace")
                : t("security.recoveryKey.setUp")}
            </button>
          </div>
        </section>
        <section className="setting-row">
          <div>
            <h2>{t("security.backup.title")}</h2>
            <p>{t("security.backup.body")}</p>
            {oldBackupsGuide && (
              <section
                className="old-backups-guide"
                aria-labelledby="old-backups-title"
              >
                <h3 id="old-backups-title">{t("security.oldBackups.title")}</h3>
                <p>{t("security.oldBackups.intro")}</p>
                {oldBackupsGuide.step === "save" ? (
                  <>
                    <ol>
                      <li>
                        {readOnly
                          ? t("security.oldBackups.saveWhenWritable")
                          : t("security.oldBackups.saveNow")}{" "}
                        {t("security.oldBackups.keepCopy")}
                      </li>
                      <li>{t("security.oldBackups.thenDelete")}</li>
                    </ol>
                    <button
                      className="button"
                      type="button"
                      disabled={busy}
                      onClick={onOldBackupsGuideDone}
                    >
                      {t("security.oldBackups.none")}
                    </button>
                  </>
                ) : (
                  <>
                    <ol>
                      <li>
                        {newBackupText(t, oldBackupsGuide, sizesIn1024s)}{" "}
                        {t("security.oldBackups.keepCopy")}
                      </li>
                      <li>{t("security.oldBackups.deleteOlder")}</li>
                      <li>{t("security.oldBackups.inPlace")}</li>
                    </ol>
                    <button
                      className="button"
                      type="button"
                      disabled={busy}
                      onClick={onOldBackupsGuideDone}
                    >
                      {t("security.oldBackups.done")}
                    </button>
                  </>
                )}
              </section>
            )}
          </div>
          <div>
            <button
              className="button"
              type="button"
              disabled={busy || readOnly}
              onClick={() => void onSaveBackup()}
            >
              {t("security.backup.save")}
            </button>
          </div>
        </section>
        <section className="setting-row native-setting-form">
          <div>
            <h2>{t("security.passphrase.title")}</h2>
            <p>
              {t("security.passphrase.rules", { min: MIN_PASSPHRASE_CHARS })}
            </p>
            <p>{t("security.passphrase.copies")}</p>
          </div>
          <form onSubmit={submitPassphrase}>
            <label>
              {t("security.passphrase.current")}
              <SecretInput
                aria-label={t("security.passphrase.current")}
                required
                type="password"
                autoComplete="current-password"
                value={currentPassphrase}
                onChange={(event) => setCurrentPassphrase(event.target.value)}
              />
            </label>
            <label>
              {t("passphrase.new.label")}
              <SecretInput
                aria-label={t("passphrase.new.label")}
                required
                type="password"
                autoComplete="new-password"
                value={newPassphrase}
                onChange={(event) => setNewPassphrase(event.target.value)}
              />
            </label>
            <label>
              {t("passphrase.confirmNew.label")}
              <SecretInput
                aria-label={t("passphrase.confirmNew.label")}
                required
                type="password"
                autoComplete="new-password"
                value={newPassphraseConfirmation}
                onChange={(event) =>
                  setNewPassphraseConfirmation(event.target.value)
                }
              />
            </label>
            {currentPassphraseTooLong && (
              <p role="alert">{t("security.passphrase.currentTooLong")}</p>
            )}
            {newPassphraseConfirmation &&
              newPassphrase !== newPassphraseConfirmation && (
                <p role="alert">{t("security.passphrase.mismatch")}</p>
              )}
            {newPassphraseTooLong && (
              <p role="alert">{t("security.passphrase.newTooLong")}</p>
            )}
            {newPassphraseTooShort && newPassphraseConfirmation && (
              <p role="alert">
                {t("security.passphrase.newTooShort", {
                  min: MIN_PASSPHRASE_CHARS,
                })}
              </p>
            )}
            <button
              className="button"
              disabled={busy || readOnly || passphraseFormInvalid}
            >
              {t("security.passphrase.submit")}
            </button>
          </form>
        </section>
        {/* For testers, in the evaluation builds: to be taken out, with its
            command, before a release to patients. */}
        <section className="setting-row native-setting-form">
          <div>
            <h2>{t("security.speed.title")}</h2>
            <p>{t("security.speed.body")}</p>
          </div>
          <div>
            <button
              className="button"
              type="button"
              disabled={busy || speedTest.running}
              onClick={() => void runSpeedTest()}
            >
              {t("security.speed.run")}
            </button>
            <p className="native-dialog-status" role="status">
              {/* The result stays in English: testers copy it into the
                  benchmark record. */}
              {speedTest.running
                ? t("security.speed.measuring")
                : speedTest.result}
            </p>
            {speedTest.failed && <p role="alert">{speedTest.failed}</p>}
          </div>
        </section>
        <section className="setting-row">
          <div>
            <h2>{t("security.copies.title")}</h2>
            <p>{t("security.copies.body")}</p>
          </div>
        </section>
        <section className="setting-row native-setting-form">
          <div>
            <h2>{t("security.profiles.title")}</h2>
            <p>{t("security.profiles.body")}</p>
          </div>
          <form onSubmit={submitProfile}>
            <label>
              {t("security.profiles.label")}
              <input
                required
                maxLength={NAME_INPUT_MAX_LENGTH}
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
              />
            </label>
            {nameTooLong(profileName) && (
              <p role="alert">{t("create.profile.tooLong")}</p>
            )}
            {nameIsShared(profileName) && (
              <p role="alert">{SHARED_NAME_TAKEN}</p>
            )}
            <button
              className="button"
              disabled={
                busy ||
                readOnly ||
                !profileName.trim() ||
                nameTooLong(profileName) ||
                nameIsShared(profileName)
              }
            >
              {t("security.profiles.add")}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
