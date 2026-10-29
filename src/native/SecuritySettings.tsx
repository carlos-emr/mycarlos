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
  PersonDialog,
  detailsProblem,
  inDialogHost,
  trimmedDetails,
} from "./PersonDetails";
import type { PatientProfile, PersonDetails } from "../vault";
import { SecretInput } from "./SecretInput";
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
  /** Where the profile dialogs are drawn: beside the library's other dialogs,
   * outside the page it makes inert while one is open. Without it, in place. */
  dialogHost?: HTMLElement | null;
  /** Told when a profile dialog opens and closes, so the library can make the
   * rest of the page inert. */
  onDialogChange?: (open: boolean) => void;
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
  dialogHost,
  onDialogChange,
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
  const [profileBirthDateUnknown, setProfileBirthDateUnknown] = useState(false);
  // "Add profile" opens a dialog (Ben, 29 Oct). The library makes the page
  // inert while it is open; it is told in the same event that opens or closes
  // the dialog, so the page is no longer inert when focus goes back.
  const [addOpen, setAddOpen] = useState(false);
  const [addRefused, setAddRefused] = useState(false);
  const dialogChange = useRef(onDialogChange);
  dialogChange.current = onDialogChange;
  const showAdd = (open: boolean) => {
    if (open) {
      setProfileName("");
      setProfileDetails({});
      setProfileBirthDateUnknown(false);
    }
    setAddRefused(false);
    setAddOpen(open);
    dialogChange.current?.(open);
  };
  useEffect(() => () => dialogChange.current?.(false), []);
  // After adding, focus goes to the new person's line: the one that was not
  // in the list when Add profile was pressed.
  const [peopleBeforeAdd, setPeopleBeforeAdd] = useState<Set<string> | null>(
    null,
  );
  const [focusPersonId, setFocusPersonId] = useState<string | null>(null);
  useEffect(() => {
    if (!peopleBeforeAdd) return;
    const added = people.find((person) => !peopleBeforeAdd.has(person.id));
    if (!added) return;
    setPeopleBeforeAdd(null);
    setFocusPersonId(added.id);
  }, [people, peopleBeforeAdd]);
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
    const before = new Set(people.map((person) => person.id));
    setAddRefused(false);
    void (
      onUpdateProfileDetails
        ? onCreateProfile(profileName, trimmedDetails(profileDetails))
        : onCreateProfile(profileName)
    ).then((created) => {
      if (created) {
        showAdd(false);
        setPeopleBeforeAdd(before);
      } else setAddRefused(true);
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
        <section
          className="setting-row kept-setting"
          aria-labelledby="what-is-kept"
        >
          <div>
            <h2 id="what-is-kept">
              {translateNow("interface.SecuritySettings.whatMyCarlosKeeps")}
            </h2>
            <p>
              {translateNow(
                "interface.SecuritySettings.myCarlosNeverDeletesADocumentHidingOne",
              )}
            </p>
            <p>
              {translateNow(
                "interface.SecuritySettings.myCarlosAlsoKeepsAHistoryWhenThe",
              )}
            </p>
            <p>
              {translateNow(
                "interface.SecuritySettings.startingAgainOrRestoringABackupOver",
              )}
            </p>
          </div>
          {/* Its controls on the right, as in the other rows. */}
          <div className="kept-entries">
            <button
              ref={hiddenEntryRef}
              className="button hidden-settings-entry"
              type="button"
              onClick={onOpenHidden}
            >
              <Icon name="hidden" />
              <span className="hidden-entry-copy">
                {translateNow("interface.HiddenDocuments.hidden")}{" "}
                <span className="nav-count">{formatNumber(hiddenCount)}</span>{" "}
                <span className="hidden-entry-scope">{hiddenScopeName}</span>
              </span>
            </button>
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
          </div>
        </section>
        <section className="setting-row native-setting-form">
          <div>
            <div className="native-auto-lock-heading">
              <h2>
                {translateNow("security.autoLock.title")}{" "}
                <span className="state-pill">
                  {translateNow("security.autoLock.minutes", {
                    count: autoLockMinutes,
                  })}
                </span>
              </h2>
              <button
                className="button"
                type="button"
                onClick={() => void onLock()}
              >
                {translateNow("security.lockNow")}
              </button>
            </div>
            <p>{translateNow("security.autoLock.body")}</p>
          </div>
          <div>
            <AutoLockSetting
              minutes={autoLockMinutes}
              onMinutes={onAutoLockMinutes}
            />
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
          <div className="native-profile-add">
            <button
              className="button"
              type="button"
              aria-haspopup="dialog"
              disabled={busy || readOnly}
              onClick={() => showAdd(true)}
            >
              {translateNow("security.profiles.add")}
            </button>
          </div>
          {onUpdateProfileDetails && (
            <PersonDetailsList
              people={people}
              busy={busy || readOnly}
              onSave={onUpdateProfileDetails}
              focusId={focusPersonId}
              onFocusLeft={() => setFocusPersonId(null)}
              dialogHost={dialogHost}
              onDialogChange={onDialogChange}
              refusalText={notice}
            />
          )}
          {addOpen &&
            inDialogHost(
              <PersonDialog
                titleId="add-profile-title"
                title={translateNow("security.profiles.add")}
                submitText={translateNow("security.profiles.add")}
                busy={busy}
                submitDisabled={
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
                refusal={addRefused ? notice : ""}
                onSubmit={submitProfile}
                onClose={() => showAdd(false)}
              >
                <label>
                  {translateNow("security.profiles.label")}
                  <input
                    required
                    maxLength={NAME_INPUT_MAX_LENGTH}
                    value={profileName}
                    disabled={busy || readOnly}
                    onChange={(event) => {
                      setProfileName(event.target.value);
                      setAddRefused(false);
                    }}
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
                      details={profileDetails}
                      onChange={(details) => {
                        setProfileDetails(details);
                        setAddRefused(false);
                      }}
                      birthDateUnknown={profileBirthDateUnknown}
                      onBirthDateUnknownChange={setProfileBirthDateUnknown}
                    />
                  </fieldset>
                )}
              </PersonDialog>,
              dialogHost,
            )}
        </section>
      </div>
    </main>
  );
}
