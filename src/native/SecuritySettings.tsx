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
  PersonDetailsOrLater,
  PersonDetailsList,
  PersonDialog,
  detailsProblem,
  inDialogHost,
  trimmedDetails,
} from "./PersonDetails";
import type {
  BackupSize,
  HiddenProfile,
  PatientProfile,
  PersonDetails,
} from "../vault";
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
import { HiddenPeopleList, HidePersonButton } from "./HiddenPeople";
import type { OldBackupsGuide } from "./oldBackups";
import { formatBackupSize, formatFileSize } from "./recordPresentation";

interface SecuritySettingsProps {
  clinicDocuments?: ReactNode;
  busy: boolean;
  readOnly: boolean;
  notice: string;
  autoLockMinutes: number;
  onAutoLockMinutes: (value: unknown) => void;
  onLock: () => Promise<void>;
  onSignOut?: () => void;
  onChangePassphrase: (current: string, replacement: string) => Promise<void>;
  onCreateProfile: (name: string, details?: PersonDetails) => Promise<boolean>;
  people?: PatientProfile[];
  onUpdateProfileDetails?: (
    id: string,
    details: PersonDetails,
  ) => Promise<boolean>;
  /** A person whose Edit details opens, from the library's reminder (#234). */
  detailsFor?: { profileId: string } | null;
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
  /** Saves a backup, with the videos left out or not. */
  onSaveBackup: (leaveVideosOut: boolean) => Promise<void>;
  /** How big a backup would be (#359), so that the patient sees it before
   * choosing where to save it. */
  onBackupSize?: () => Promise<BackupSize>;
  /** Hand a person's records over (#360); offered when there is a person to hand over. */
  onHandOver?: () => void;
  /** Moved on each time the Hand records over button should take the focus once the library is
   * no longer busy: after a handover dialog closed and hid the person it handed over, the button
   * was disabled while focus came back to it. */
  focusHandover?: number;
  /** Add a person from a handover file (#360). */
  onAddFromFile?: () => void;
  /** Several vaults on one device (#357): opens the screen that sets up another vault. Offered
   * only where the native side can make one. This is the only place a vault can be added from,
   * so only whoever holds this unlocked vault can. */
  onSetUpNewVault?: () => void;
  /** Hide a whole person, bring one back, and the people who are hidden (#360). */
  hiddenPeople?: HiddenProfile[];
  onHidePerson?: (profileId: string) => void;
  onRestorePerson?: (profileId: string) => void;
  /** Hand a hidden person's records over. */
  onHandOverHidden?: (person: HiddenProfile) => void;
  onSpeedTest: () => Promise<SpeedTestReport>;
  /** Whether to show the speed test, for testers. Only a development build
   * does by default: not Evaluation or release builds. */
  showSpeedTest?: boolean;
  /** Where the profile dialogs are drawn: beside the library's other dialogs,
   * outside the page it makes inert while one is open. Without it, in place. */
  dialogHost?: HTMLElement | null;
  /** Told when a profile dialog opens and closes, so the library can make the
   * rest of the page inert. */
  onDialogChange?: (open: boolean) => void;
}

/** The speed test is for testers: a development build shows it, and so does a
 * build made with VITE_SHOW_SPEED_TEST=1 (the browser tests set it, so that
 * they can reach it). Evaluation and release builds do not. Exported for its
 * test. */
export function speedTestShownByBuild(): boolean {
  return (
    import.meta.env.DEV === true || import.meta.env.VITE_SHOW_SPEED_TEST === "1"
  );
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
  hiddenPeople,
  onHidePerson,
  onRestorePerson,
  onHandOverHidden,
  clinicDocuments,
  busy,
  readOnly,
  notice,
  autoLockMinutes,
  onAutoLockMinutes,
  onLock,
  onSignOut,
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
  detailsFor,
  recoveryKeySetAtMs,
  recoveryKeyLabel = null,
  oldBackupsGuide = null,
  onOldBackupsGuideDone,
  sizesIn1024s = false,
  onSetUpRecoveryKey,
  onSaveBackup,
  onHandOver,
  focusHandover = 0,
  onAddFromFile,
  onSetUpNewVault,
  onBackupSize,
  onSpeedTest,
  showSpeedTest = speedTestShownByBuild(),
  dialogHost,
  onDialogChange,
}: SecuritySettingsProps) {
  const { t } = useI18n();
  // The size a backup would be, with or without the videos (#359).
  // The button that opened the handover takes the focus back once a hide that came from its dialog
  // has finished (it is disabled while the library is busy).
  const handoverRef = useRef<HTMLButtonElement | null>(null);
  // Starts at the value the screen opened with, so a count that was already acted on (the focus
  // went back to the button before the person left Security) does not move focus again when
  // Security is entered afresh.
  const handoverFocused = useRef(focusHandover);
  useEffect(() => {
    if (
      focusHandover === 0 ||
      busy ||
      handoverFocused.current === focusHandover
    )
      return;
    handoverFocused.current = focusHandover;
    handoverRef.current?.focus();
  }, [focusHandover, busy]);
  const [leaveVideosOut, setLeaveVideosOut] = useState(false);
  const [backupSize, setBackupSize] = useState<BackupSize | null>(null);
  const [sizePending, setSizePending] = useState(Boolean(onBackupSize));
  useEffect(() => {
    if (!onBackupSize) return;
    let current = true;
    setSizePending(true);
    onBackupSize().then(
      (size) => {
        if (!current) return;
        setBackupSize(size);
        setSizePending(false);
        // A vault with no video has nothing to leave out.
        if (size.videoCount === 0) setLeaveVideosOut(false);
      },
      () => {
        if (!current) return;
        setBackupSize(null);
        setSizePending(false);
      },
    );
    return () => {
      current = false;
    };
  }, [onBackupSize]);
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
  // The person's details can wait (#234): the reminder then stays.
  const [profileLater, setProfileLater] = useState(false);
  const profileDetailsProblem =
    Boolean(onUpdateProfileDetails) &&
    !profileLater &&
    Boolean(detailsProblem(profileDetails, profileBirthDateUnknown));
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
      setProfileLater(false);
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
    if (busy || readOnly || profileDetailsProblem) return;
    const before = new Set(people.map((person) => person.id));
    setAddRefused(false);
    void (
      onUpdateProfileDetails && !profileLater
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
            <p className="backup-cloud-warning">
              {translateNow("security.backup.cloudWarning")}
            </p>
            {sizePending && !backupSize && (
              <p className="backup-size" role="status">
                {translateNow("security.backup.sizeCalculating")}
              </p>
            )}
            {backupSize && (
              <>
                <p className="backup-size" role="status">
                  {backupSize.videoCount === 0
                    ? translateNow("security.backup.size", {
                        size: formatBackupSize(backupSize.totalBytes),
                      })
                    : leaveVideosOut
                      ? translateNow("security.backup.sizeNoVideos", {
                          size: formatBackupSize(backupSize.withoutVideosBytes),
                        })
                      : translateNow("security.backup.sizeWithVideos", {
                          size: formatBackupSize(backupSize.totalBytes),
                          videos: formatBackupSize(backupSize.videoBytes),
                        })}
                </p>
                {backupSize.videoCount > 0 && (
                  <>
                    {/* The same box and row as the other Settings tick boxes (a 22px box, a 44px row,
                        the whole label clickable). */}
                    <div className="appearance-choice preferences-checks">
                      <label className="appearance-option">
                        <input
                          type="checkbox"
                          checked={leaveVideosOut}
                          aria-describedby={
                            leaveVideosOut ? "backup-videos-help" : undefined
                          }
                          onChange={(event) =>
                            setLeaveVideosOut(event.target.checked)
                          }
                        />
                        <span>
                          {translateNow("security.backup.leaveVideosOut")}
                        </span>
                      </label>
                    </div>
                    {/* The consequence shows only while the box is ticked. The region itself is
                        always there, so ticking is announced (a status that arrives with its text
                        is not reliably read); the box is also described by it while it shows. */}
                    <div role="status">
                      {leaveVideosOut && (
                        <p
                          id="backup-videos-help"
                          className="native-dialog-status"
                        >
                          {translateNow("security.backup.leaveVideosOutHelp")}
                        </p>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
            <p>
              <button
                className="button"
                type="button"
                disabled={busy || readOnly}
                onClick={() => void onSaveBackup(leaveVideosOut)}
              >
                {translateNow("security.backup.save")}
              </button>
            </p>
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
              {onSignOut && (
                <button className="button" type="button" onClick={onSignOut}>
                  {translateNow("security.signOut")}
                </button>
              )}
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
      </div>
      {/* Connected clinics, between the settings of this vault and the people in it. */}
      {clinicDocuments}
      <div className="setting-list">
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
              busy={busy}
              readOnly={readOnly}
              onSave={onUpdateProfileDetails}
              openFor={detailsFor}
              focusId={focusPersonId}
              onFocusLeft={() => setFocusPersonId(null)}
              dialogHost={dialogHost}
              onDialogChange={onDialogChange}
              refusalText={notice}
              actions={
                onHidePerson
                  ? (person) => (
                      <HidePersonButton
                        person={person}
                        onlyOne={people.length <= 1}
                        busy={busy}
                        readOnly={readOnly}
                        onHide={onHidePerson}
                      />
                    )
                  : undefined
              }
            />
          )}
          {onRestorePerson && (
            <HiddenPeopleList
              hidden={hiddenPeople ?? []}
              busy={busy}
              readOnly={readOnly}
              onRestore={onRestorePerson}
              onHandOver={onHandOverHidden}
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
                  profileDetailsProblem ||
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
                    <PersonDetailsOrLater
                      details={profileDetails}
                      onChange={(details) => {
                        setProfileDetails(details);
                        setAddRefused(false);
                      }}
                      birthDateUnknown={profileBirthDateUnknown}
                      // Like every other change, a tick clears a refusal.
                      onBirthDateUnknownChange={(unknown) => {
                        setProfileBirthDateUnknown(unknown);
                        setAddRefused(false);
                      }}
                      later={profileLater}
                      onLaterChange={(later) => {
                        setProfileLater(later);
                        setAddRefused(false);
                      }}
                      otherwiseReady={
                        Boolean(profileName.trim()) &&
                        !nameTooLong(profileName) &&
                        !nameIsShared(profileName)
                      }
                    />
                  </fieldset>
                )}
              </PersonDialog>,
              dialogHost,
            )}
        </section>
        {/* After the people and the hidden people: handing a person's records over is about them, so it
            sits at the end of the settings, not between the backup and the lock. */}
        {(onHandOver || onAddFromFile) && (
          <section className="setting-row native-handover-settings">
            <div>
              <h2>{translateNow("handover.section.title")}</h2>
              <p>{translateNow("handover.section.body")}</p>
            </div>
            <div>
              {onHandOver && (
                <button
                  ref={handoverRef}
                  className="button"
                  type="button"
                  aria-haspopup="dialog"
                  disabled={busy || readOnly || people.length === 0}
                  onClick={onHandOver}
                >
                  {translateNow("handover.export.button")}
                </button>
              )}
              {onAddFromFile && (
                <button
                  className="button"
                  type="button"
                  aria-haspopup="dialog"
                  disabled={busy || readOnly}
                  onClick={onAddFromFile}
                >
                  {translateNow("handover.import.button")}
                </button>
              )}
            </div>
          </section>
        )}
        {onSetUpNewVault && (
          <section className="setting-row native-new-vault-settings">
            <div>
              <h2>{translateNow("security.newVault.title")}</h2>
              <p>{translateNow("security.newVault.body")}</p>
            </div>
            <div>
              <button
                className="button"
                type="button"
                disabled={busy || readOnly}
                onClick={onSetUpNewVault}
              >
                {translateNow("security.newVault.button")}
              </button>
            </div>
          </section>
        )}
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
            {/* The copies text is part of this section (it says what stays
                outside the vault's protection). */}
            <p>{translateNow("security.copies.body")}</p>
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
                <SpokenCount count={hiddenCount} />{" "}
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
        {/* For testers: only in a development build (import.meta.env.DEV),
            so that Evaluation and release builds do not show it. To be taken
            out, with its command, before a release to patients. */}
        {showSpeedTest && (
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
        )}
      </div>
    </main>
  );
}
