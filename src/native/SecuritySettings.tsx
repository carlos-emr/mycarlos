import {
  t as translateNow,
  useI18n,
  withElements,
  formatNumber,
  type UiText,
  resolveText,
  deferredText,
} from "../i18n";
import {
  PersonDetailsFields,
  PersonDetailsList,
  detailsProblem,
  trimmedDetails,
} from "./PersonDetails";
import type { PatientProfile, PersonDetails } from "../vault";
import { SecretInput } from "./SecretInput";
import { SpokenCount } from "./SpokenCount";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Icon } from "../Icon";

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
  nameIsShared,
  nameTooLong,
} from "./recordPresentation";
import { MIN_PASSPHRASE_CHARS, tooShortPassphrase } from "./VaultAuth";
import { KeyLabel, printedDate } from "./KeyLabel";
import type { OldBackupsGuide } from "./oldBackups";
import { formatFileSize } from "./recordPresentation";

interface SecuritySettingsProps {
  clinicDocuments?: ReactNode;
  busy: boolean;
  readOnly: boolean;
  notice: string;
  autoLockMinutes: number;
  onAutoLockMinutes: (value: unknown) => void;
  onLock: () => Promise<void>;
  onChangePassphrase: (current: string, replacement: string) => Promise<void>;
  onCreateProfile: (name: string, details?: PersonDetails) => Promise<boolean>;
  people?: PatientProfile[];
  onUpdateProfileDetails?: (
    id: string,
    details: PersonDetails,
  ) => Promise<boolean>;
  hiddenCount: number;
  focusHiddenEntry?: boolean;
  hiddenScopeName: string;
  onOpenHidden: () => void;
  focusAuditEntry?: boolean;
  onOpenAuditHistory: () => void;
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
  const build = translateNow(
    report.release
      ? "interface.SecuritySettings.releaseBuild"
      : "interface.SecuritySettings.evaluationBuild",
  );
  return [
    translateNow("interface.speed.runs", {
      count: report.samplesMs.length,
      samples: report.samplesMs.map((value) => formatNumber(value)).join(", "),
    }),
    translateNow("interface.speed.median", {
      median: report.medianMs,
      max: report.maxMs,
    }),
    translateNow("interface.speed.parameters", {
      memory: report.memoryKib / 1024,
      iterations: report.iterations,
      lanes: report.lanes,
    }),
    translateNow("interface.speed.platform", {
      platform: report.platform,
      architecture: report.architecture,
      version: report.appVersion,
    }),
    report.simulator
      ? translateNow("interface.speed.simulator", { build })
      : build + ".",
  ].join(" ");
}

/** Which file the new backup is: by name when the platform said, otherwise by
 * when it was saved. Its size, as the platform's file app counts it, tells it
 * from an empty or partial one. */
function newBackupText(
  guide: Extract<OldBackupsGuide, { step: "delete" }>,
  in1024s: boolean,
): string {
  const size =
    guide.bytes === null ? null : formatFileSize(guide.bytes, in1024s);
  if (guide.keep) {
    return size === null
      ? translateNow("security.oldBackups.named", { name: guide.keep })
      : translateNow("security.oldBackups.namedWithSize", {
          name: guide.keep,
          size,
        });
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
    ? translateNow("security.oldBackups.justSaved", { date, time })
    : translateNow("security.oldBackups.justSavedWithSize", {
        date,
        time,
        size,
      });
}

export function SecuritySettings({
  clinicDocuments,
  busy,
  readOnly,
  notice,
  autoLockMinutes,
  onAutoLockMinutes,
  onLock,
  onChangePassphrase,
  onCreateProfile,
  hiddenCount,
  focusHiddenEntry = false,
  hiddenScopeName,
  onOpenHidden,
  focusAuditEntry = false,
  onOpenAuditHistory,
  people = [],
  onUpdateProfileDetails,
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
  const hiddenEntryRef = useRef<HTMLButtonElement | null>(null);
  const auditEntryRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (focusHiddenEntry) hiddenEntryRef.current?.focus();
  }, [focusHiddenEntry]);
  useEffect(() => {
    if (focusAuditEntry) auditEntryRef.current?.focus();
  }, [focusAuditEntry]);
  const [speedTest, setSpeedTest] = useState<{
    running: boolean;
    result: UiText;
    failed: UiText;
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
        result: deferredText(() => speedTestLine(report)),
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
        failed: deferredText(() => vaultErrorMessage(error)),
      });
    }
  };
  const [profileName, setProfileName] = useState("");
  const [profileDetails, setProfileDetails] = useState<PersonDetails>({});
  const [profileFormKey, setProfileFormKey] = useState(0);
  const [profileBirthDateUnknown, setProfileBirthDateUnknown] = useState(false);
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
    if (
      busy ||
      readOnly ||
      (onUpdateProfileDetails &&
        detailsProblem(profileDetails, profileBirthDateUnknown))
    )
      return;
    void (
      onUpdateProfileDetails
        ? onCreateProfile(profileName, trimmedDetails(profileDetails))
        : onCreateProfile(profileName)
    ).then((created) => {
      if (created) {
        setProfileName("");
        setProfileDetails({});
        setProfileBirthDateUnknown(false);
        // New fields, not emptied ones: what a new person needs is shown again
        // without being read out straight after "added".
        setProfileFormKey((key) => key + 1);
      }
    });
  };
  return (
    <main className="library-main purpose-screen">
      <div className="main-head">
        <div>
          <h1>{translateNow("security.title")}</h1>
          <p>{translateNow("security.subtitle")}</p>
        </div>
      </div>
      <div className="purpose-note warning">
        <Icon name="info" />
        <span>
          <strong>{translateNow("security.devBuild.title")}</strong>{" "}
          {translateNow("security.devBuild.body")}
        </span>
      </div>
      <p className="status-line" role="status" aria-live="polite">
        {notice}
      </p>
      {clinicDocuments}
      <div className="setting-list">
        <section className="setting-row">
          <div>
            <h2>
              {translateNow("security.encryption.title")}{" "}
              <span className="state-pill">
                {translateNow("security.encryption.state")}
              </span>
            </h2>
            <p>{translateNow("security.encryption.body")}</p>
          </div>
        </section>
        {/* #71: the privacy notice says what is kept. */}
        <section className="setting-row" aria-labelledby="what-is-kept">
          <div>
            <h2 id="what-is-kept">
              {translateNow("interface.SecuritySettings.whatMyCarlosKeeps")}
            </h2>
            <p>
              {translateNow(
                "interface.SecuritySettings.myCarlosNeverDeletesADocumentHidingOne",
              )}
            </p>
            <button
              ref={hiddenEntryRef}
              className="button hidden-settings-entry"
              type="button"
              onClick={onOpenHidden}
            >
              <Icon name="hidden" />
              <span className="hidden-entry-copy">
                {translateNow("interface.HiddenDocuments.hidden")}{" "}
                <SpokenCount count={hiddenCount} />{" "}
                <span className="hidden-entry-scope">{hiddenScopeName}</span>
              </span>
            </button>
            <p>
              {translateNow(
                "interface.SecuritySettings.myCarlosAlsoKeepsAHistoryWhenThe",
              )}
            </p>
            <button
              ref={auditEntryRef}
              className="button hidden-settings-entry"
              type="button"
              onClick={onOpenAuditHistory}
            >
              <Icon name="clock" />
              <span className="hidden-entry-copy">
                {translateNow("interface.history.title")}
              </span>
            </button>
            <p>
              {translateNow(
                "interface.SecuritySettings.startingAgainOrRestoringABackupOver",
              )}
            </p>
          </div>
        </section>
        <section className="setting-row native-setting-form">
          <div>
            <h2>
              {translateNow("security.autoLock.title")}{" "}
              <span className="state-pill">
                {translateNow("security.autoLock.minutes", {
                  count: autoLockMinutes,
                })}
              </span>
            </h2>
            <p>{translateNow("security.autoLock.body")}</p>
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
              {translateNow("security.lockNow")}
            </button>
          </div>
        </section>
        <section className="setting-row">
          <div>
            <h2>
              {translateNow("security.recoveryKey.title")}{" "}
              <span className="state-pill">
                {recoveryKeySetAtMs
                  ? translateNow("security.recoveryKey.setUpOn", {
                      date: printedDate(new Date(recoveryKeySetAtMs)),
                    })
                  : translateNow("security.recoveryKey.notSetUp")}
              </span>
            </h2>
            <p>{translateNow("security.recoveryKey.body")}</p>
            {recoveryKeySetAtMs && recoveryKeyLabel && (
              <p>
                {withElements(
                  "security.recoveryKey.current",
                  { label: <KeyLabel label={recoveryKeyLabel} /> },
                  { date: printedDate(new Date(recoveryKeySetAtMs)) },
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
                ? translateNow("security.recoveryKey.replace")
                : translateNow("security.recoveryKey.setUp")}
            </button>
          </div>
        </section>
        <section className="setting-row native-backup-settings">
          <div>
            <h2>{translateNow("security.backup.title")}</h2>
            <p>{translateNow("security.backup.body")}</p>
            {oldBackupsGuide && (
              <section
                className="old-backups-guide"
                aria-labelledby="old-backups-title"
              >
                <h3 id="old-backups-title">
                  {translateNow("security.oldBackups.title")}
                </h3>
                <p>{translateNow("security.oldBackups.intro")}</p>
                {oldBackupsGuide.step === "save" ? (
                  <>
                    <ol>
                      <li>
                        {readOnly
                          ? translateNow("security.oldBackups.saveWhenWritable")
                          : translateNow("security.oldBackups.saveNow")}{" "}
                        {translateNow("security.oldBackups.keepCopy")}
                      </li>
                      <li>{translateNow("security.oldBackups.thenDelete")}</li>
                    </ol>
                    <button
                      className="button"
                      type="button"
                      disabled={busy}
                      onClick={onOldBackupsGuideDone}
                    >
                      {translateNow("security.oldBackups.none")}
                    </button>
                  </>
                ) : (
                  <>
                    <ol>
                      <li>
                        {newBackupText(oldBackupsGuide, sizesIn1024s)}{" "}
                        {translateNow("security.oldBackups.keepCopy")}
                      </li>
                      <li>{translateNow("security.oldBackups.deleteOlder")}</li>
                      <li>{translateNow("security.oldBackups.inPlace")}</li>
                    </ol>
                    <button
                      className="button"
                      type="button"
                      disabled={busy}
                      onClick={onOldBackupsGuideDone}
                    >
                      {translateNow("security.oldBackups.done")}
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
              {translateNow("security.backup.save")}
            </button>
          </div>
        </section>
        <section className="setting-row native-setting-form">
          <div>
            <h2>{translateNow("security.passphrase.title")}</h2>
            <p>
              {translateNow("security.passphrase.rules", {
                min: MIN_PASSPHRASE_CHARS,
              })}
            </p>
            <p>{translateNow("security.passphrase.copies")}</p>
          </div>
          <form onSubmit={submitPassphrase}>
            <label>
              {translateNow("security.passphrase.current")}
              <SecretInput
                aria-label={translateNow("security.passphrase.current")}
                required
                type="password"
                autoComplete="current-password"
                value={currentPassphrase}
                onChange={(event) => setCurrentPassphrase(event.target.value)}
              />
            </label>
            <label>
              {translateNow("passphrase.new.label")}
              <SecretInput
                aria-label={translateNow("passphrase.new.label")}
                required
                type="password"
                autoComplete="new-password"
                value={newPassphrase}
                onChange={(event) => setNewPassphrase(event.target.value)}
              />
            </label>
            <label>
              {translateNow("passphrase.confirmNew.label")}
              <SecretInput
                aria-label={translateNow("passphrase.confirmNew.label")}
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
              <p role="alert">
                {translateNow("security.passphrase.currentTooLong")}
              </p>
            )}
            {newPassphraseConfirmation &&
              newPassphrase !== newPassphraseConfirmation && (
                <p role="alert">
                  {translateNow("security.passphrase.mismatch")}
                </p>
              )}
            {newPassphraseTooLong && (
              <p role="alert">
                {translateNow("security.passphrase.newTooLong")}
              </p>
            )}
            {newPassphraseTooShort && newPassphraseConfirmation && (
              <p role="alert">
                {translateNow("security.passphrase.newTooShort", {
                  min: MIN_PASSPHRASE_CHARS,
                })}
              </p>
            )}
            <button
              className="button"
              disabled={busy || readOnly || passphraseFormInvalid}
            >
              {translateNow("security.passphrase.submit")}
            </button>
          </form>
        </section>
        {/* For testers, in the evaluation builds: to be taken out, with its
            command, before a release to patients. */}
        <section className="setting-row native-setting-form">
          <div>
            <h2>{translateNow("security.speed.title")}</h2>
            <p>{translateNow("security.speed.body")}</p>
          </div>
          <div>
            <button
              className="button"
              type="button"
              disabled={busy || speedTest.running}
              onClick={() => void runSpeedTest()}
            >
              {translateNow("security.speed.run")}
            </button>
            <p className="native-dialog-status" role="status">
              {speedTest.running
                ? translateNow("security.speed.measuring")
                : resolveText(speedTest.result)}
            </p>
            {speedTest.failed && (
              <p role="alert">{resolveText(speedTest.failed)}</p>
            )}
          </div>
        </section>
        <section className="setting-row">
          <div>
            <h2>{translateNow("security.copies.title")}</h2>
            <p>{translateNow("security.copies.body")}</p>
          </div>
        </section>
        <section className="setting-row native-setting-form native-profile-settings">
          <div>
            <h2>{translateNow("security.profiles.title")}</h2>
            <p>{translateNow("security.profiles.body")}</p>
          </div>
          <form onSubmit={submitProfile}>
            <label>
              {translateNow("security.profiles.label")}
              <input
                required
                maxLength={NAME_INPUT_MAX_LENGTH}
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
              />
            </label>
            {nameTooLong(profileName) && (
              <p role="alert">{translateNow("create.profile.tooLong")}</p>
            )}
            {nameIsShared(profileName) && (
              <p role="alert">
                {t("create.profile.sharedTaken", {
                  folder: t("interface.LibrarySidebar.sharedWithMe"),
                })}
              </p>
            )}
            {onUpdateProfileDetails && (
              <fieldset disabled={busy || readOnly}>
                <PersonDetailsFields
                  key={profileFormKey}
                  details={profileDetails}
                  onChange={setProfileDetails}
                  birthDateUnknown={profileBirthDateUnknown}
                  onBirthDateUnknownChange={setProfileBirthDateUnknown}
                />
              </fieldset>
            )}
            <button
              className="button"
              disabled={
                busy ||
                readOnly ||
                Boolean(
                  onUpdateProfileDetails &&
                    detailsProblem(profileDetails, profileBirthDateUnknown),
                ) ||
                !profileName.trim() ||
                nameTooLong(profileName) ||
                nameIsShared(profileName)
              }
            >
              {translateNow("security.profiles.add")}
            </button>
          </form>
          {onUpdateProfileDetails && (
            <PersonDetailsList
              people={people}
              busy={busy || readOnly}
              onSave={onUpdateProfileDetails}
            />
          )}
        </section>
      </div>
    </main>
  );
}
