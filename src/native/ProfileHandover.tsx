import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useI18n } from "../i18n";
import { SecretInput } from "./SecretInput";
import { ConfirmDialog } from "./ConfirmDialog";
import { useModalFocus } from "../useModalFocus";
import { formatFileSize } from "./recordPresentation";
import {
  hasVaultErrorCode,
  isLockedError,
  localDateText,
  vaultErrorMessage,
  type PatientProfile,
  type ProfileExportPrepared,
  type ProfileImportOutcome,
  type ProfileImportPreview,
  type SavedProfileExport,
  type VaultBridge,
} from "../vault";
import { spoken } from "./KeyLabel";
import { useClipboardClear } from "./useClipboardClear";

/** The longest name a person can have here (the vault cuts it there). */
const NAME_LIMIT = 120;

/** The shell of a handover dialog: a modal that a click outside does not close
 * while a key is on screen or work is under way, and whose heading takes focus
 * at each step so that a screen reader says where it is. */
function HandoverDialog({
  titleId,
  title,
  stepKey,
  locked,
  describedBy,
  onEscape,
  onClose,
  children,
}: {
  titleId: string;
  title: string;
  /** What describes the dialog to a screen reader, when it does more than its heading. */
  describedBy?: string;
  /** What Escape does while it is `locked` (the key step asks whether to leave). */
  onEscape?: () => void;
  /** Changes with the step: the heading takes focus again. */
  stepKey: string;
  /** A key is shown, or work is under way: outside clicks and Escape do not close. */
  locked: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useModalFocus(
    true,
    dialogRef,
    locked ? (onEscape ?? (() => undefined)) : onClose,
  );
  useEffect(() => {
    headingRef.current?.focus();
  }, [stepKey]);
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={locked ? undefined : onClose}
    >
      <section
        ref={dialogRef}
        className="record-dialog recovery-key-dialog handover-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>
            {title}
          </h2>
        </header>
        <div className="recovery-key-body">{children}</div>
      </section>
    </div>
  );
}

/** Splits a key as shown (7 groups of 4) into its groups, for the list. */
const keyGroups = (key: string) => key.split("-").filter(Boolean);

type ExportBridge = Pick<
  VaultBridge,
  | "prepareProfileExport"
  | "pickProfileExportDestination"
  | "saveProfileExportToPicked"
>;

/** Handing one person's records to them (#360): choose the person and how the
 * file is locked, see what will be in it, write the key down, choose where to
 * save, and be told it was saved and read back. */
export function ProfileExportDialog({
  bridge,
  people,
  sizesIn1024s,
  canCopy = true,
  onHidePerson,
  onClose,
  onLocked,
  onUnfinished,
}: {
  bridge: ExportBridge;
  /** The people that can be handed over: not Shared with me. */
  people: PatientProfile[];
  sizesIn1024s?: boolean;
  /** Whether the key can be copied: not on a phone, where leaving myCarlos to paste it
   * elsewhere locks the vault and ends the key. */
  canCopy?: boolean;
  onClose: () => void;
  /** The vault turned out to be locked. */
  onLocked: () => void;
  /** A key is shown and not yet used (true), or the handover ended by the patient's own
   * choice or by saving the file (false). A lock leaves it true, so the next unlock says
   * that the key opens nothing. */
  onUnfinished?: (unfinished: boolean) => void;
  /** Hides a whole person in this vault. When given, a saved file offers it (default off): at the
   * end of an export the parent can hide the person they have just handed over (design Q16).
   * Not given for a person who is already hidden. */
  onHidePerson?: (profileId: string) => void;
}) {
  const { t } = useI18n();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [step, setStep] = useState<"choose" | "key" | "save" | "done">(
    "choose",
  );
  const [profileId, setProfileId] = useState(people[0]?.id ?? "");
  // The offer made once the file is saved: hide this person in the vault. Off unless chosen.
  const [hideAfter, setHideAfter] = useState(false);
  const [includeHistory, setIncludeHistory] = useState(true);
  const [kind, setKind] = useState<"generated" | "passphrase">("generated");
  const [passphrase, setPassphrase] = useState("");
  const [prepared, setPrepared] = useState<ProfileExportPrepared | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState<"" | "yes" | "no">("");
  const [busy, setBusy] = useState<"" | "preparing" | "saving">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState<SavedProfileExport | null>(null);
  const person = people.find((p) => p.id === profileId);

  const fail = (failure: unknown) => {
    if (isLockedError(failure)) onLocked();
    else if (hasVaultErrorCode(failure, "weak_passphrase"))
      setError(t("handover.export.error.weak"));
    else setError(vaultErrorMessage(failure));
  };

  // The patient's own end of the handover: nothing is left unfinished.
  const finish = () => {
    onUnfinished?.(false);
    onClose();
    // Hidden after the dialog has closed: the patient chose it at the end of a saved file.
    if (step === "done" && hideAfter && person) onHidePerson?.(person.id);
  };

  // The key copied is taken off the clipboard again after a minute, if nothing
  // else has been copied since (it is not read otherwise), and when the dialog
  // ends. Where the clipboard cannot be read, it is left alone.
  const { copy: copyToClipboard, clear: clearClipboard } = useClipboardClear();

  const prepare = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !person) return;
    setBusy("preparing");
    setError("");
    setNotice("");
    try {
      const result = await bridge.prepareProfileExport({
        profileId: person.id,
        includeHistory,
        ...(kind === "passphrase" && { passphrase }),
      });
      setPrepared(result);
      setAcknowledged(false);
      setCopied("");
      // A key on screen is unfinished until a file is saved or the patient leaves.
      if (result.generatedKey) onUnfinished?.(true);
      setStep(result.generatedKey ? "key" : "save");
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy("");
    }
  };

  const copy = async () => {
    if (!prepared?.generatedKey) return;
    try {
      await copyToClipboard(prepared.generatedKey);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  };

  const chooseWhereAndSave = async () => {
    if (busy || !prepared) return;
    setError("");
    setNotice("");
    let pickId: string | null;
    try {
      pickId = await bridge.pickProfileExportDestination(
        prepared.exportId,
        localDateText(new Date()),
      );
    } catch (failure) {
      // The preparation is gone (it expired, or the picker failed after it was
      // spent): back to the start, for a new key, never a dead end.
      if (!isLockedError(failure)) {
        clearClipboard();
        setPrepared(null);
        setStep("choose");
      }
      fail(failure);
      return;
    }
    if (!pickId) {
      setNotice(t("handover.export.noLocation"));
      return;
    }
    setBusy("saving");
    try {
      setSaved(await bridge.saveProfileExportToPicked(pickId));
      // The key is not kept on screen once the file is written.
      setPrepared(null);
      clearClipboard();
      onUnfinished?.(false);
      setStep("done");
    } catch (failure) {
      // A destination spends the preparation: a new try makes a new key.
      setPrepared(null);
      clearClipboard();
      setStep("choose");
      fail(failure);
    } finally {
      setBusy("");
    }
  };

  const title =
    step === "choose"
      ? t("handover.export.title")
      : step === "key"
        ? t("handover.export.keyTitle")
        : step === "save"
          ? t("handover.export.saveTitle")
          : t("handover.export.doneTitle");
  const summary = (prepared?.summary ?? saved?.summary) || null;

  return (
    <HandoverDialog
      titleId="handover-export-title"
      title={title}
      stepKey={step}
      locked={step === "key" || busy !== ""}
      describedBy={step === "key" ? "handover-key-about" : undefined}
      onEscape={
        step === "key" && busy === "" ? () => setConfirmLeave(true) : undefined
      }
      onClose={finish}
    >
      {confirmLeave && (
        <ConfirmDialog
          title={t("handover.export.leave.title")}
          confirmLabel={t("handover.export.leave.confirm")}
          danger
          onConfirm={() => {
            setConfirmLeave(false);
            finish();
          }}
          onCancel={() => setConfirmLeave(false)}
        >
          {t("handover.export.leave.body")}
        </ConfirmDialog>
      )}
      {step === "choose" && (
        <form onSubmit={(event) => void prepare(event)}>
          <p>{t("handover.export.about")}</p>
          <p>{t("handover.export.caution")}</p>
          <label>
            {t("handover.export.person")}
            <select
              value={profileId}
              disabled={busy !== ""}
              onChange={(event) => setProfileId(event.target.value)}
            >
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="restore-choice">
            <input
              type="checkbox"
              checked={includeHistory}
              disabled={busy !== ""}
              onChange={(event) => setIncludeHistory(event.target.checked)}
            />
            {t("handover.export.history")}
          </label>
          <fieldset disabled={busy !== ""}>
            <legend>{t("handover.export.keyKind.legend")}</legend>
            <label className="restore-choice">
              <input
                type="radio"
                name="handover-key-kind"
                checked={kind === "generated"}
                onChange={() => setKind("generated")}
              />
              {t("handover.export.keyKind.generated")}
            </label>
            <label className="restore-choice">
              <input
                type="radio"
                name="handover-key-kind"
                checked={kind === "passphrase"}
                onChange={() => setKind("passphrase")}
              />
              {t("handover.export.keyKind.passphrase")}
            </label>
          </fieldset>
          {kind === "passphrase" && (
            <>
              <label>
                {t("handover.export.passphrase")}
                <SecretInput
                  value={passphrase}
                  autoComplete="new-password"
                  disabled={busy !== ""}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </label>
              <p className="field-hint">
                {t("handover.export.passphraseHint")}
              </p>
            </>
          )}
          {error && <p role="alert">{error}</p>}
          <footer className="dialog-actions">
            <button className="button" type="button" onClick={finish}>
              {t("common.cancel")}
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={
                busy !== "" ||
                !person ||
                (kind === "passphrase" && passphrase === "")
              }
            >
              {busy === "preparing"
                ? t("handover.export.preparing")
                : t("handover.export.continue")}
            </button>
          </footer>
        </form>
      )}

      {step === "key" && prepared?.generatedKey && (
        <>
          <p id="handover-key-about">{t("handover.export.keyBody")}</p>
          <ol
            className="recovery-key-groups"
            role="list"
            aria-label={t("handover.export.keyLabel")}
          >
            {keyGroups(prepared.generatedKey).map((group, index) => (
              <li key={index}>
                <span aria-hidden="true">{group}</span>
                <span className="sr-only">
                  {t("handover.export.keyGroup", {
                    number: index + 1,
                    characters: spoken(group),
                  })}
                </span>
              </li>
            ))}
          </ol>
          {canCopy ? (
            <>
              <p>
                <button
                  className="button"
                  type="button"
                  onClick={() => void copy()}
                >
                  {t("handover.export.copy")}
                </button>
              </p>
              <p role="status">
                {copied === "yes" && t("handover.export.copied")}
                {copied === "no" && t("handover.export.copyFailed")}
              </p>
            </>
          ) : (
            // On a phone, leaving myCarlos to paste the key elsewhere locks the
            // vault and ends the key: no Copy, and the patient is told why.
            <p>{t("handover.export.leavingWarning")}</p>
          )}
          <label className="restore-choice">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            {t("handover.export.keySaved")}
          </label>
          <footer className="dialog-actions">
            <button
              className="button"
              type="button"
              onClick={() => setConfirmLeave(true)}
            >
              {t("common.cancel")}
            </button>
            <button
              className="button primary"
              type="button"
              disabled={!acknowledged}
              onClick={() => setStep("save")}
            >
              {t("handover.export.continue")}
            </button>
          </footer>
        </>
      )}

      {step === "save" && prepared && (
        <>
          <p>
            {t("handover.export.summary", {
              name: person?.displayName ?? "",
            })}
          </p>
          <SummaryList summary={prepared.summary} sizesIn1024s={sizesIn1024s} />
          <p>{t("handover.export.apart")}</p>
          {notice && <p role="status">{notice}</p>}
          {error && <p role="alert">{error}</p>}
          <p className="field-hint">{t("handover.export.provider")}</p>
          <footer className="dialog-actions">
            {/* Cancel here closes without a confirmation, on purpose: the patient has already
                said they wrote the key down, nothing has been saved yet, and the key step's own
                Cancel is the one that asks (it is the only place a key could be lost). */}
            <button
              className="button"
              type="button"
              disabled={busy !== ""}
              onClick={finish}
            >
              {t("common.cancel")}
            </button>
            <button
              className="button primary"
              type="button"
              disabled={busy !== ""}
              onClick={() => void chooseWhereAndSave()}
            >
              {busy === "saving"
                ? t("handover.export.saving")
                : t("handover.export.chooseWhere")}
            </button>
          </footer>
        </>
      )}

      {step === "done" && (
        <>
          <p role="status">
            {t("handover.export.done", {
              count: summary?.documents ?? 0,
              name: person?.displayName ?? "",
            })}
          </p>
          {summary && summary.leftOutDamaged > 0 && (
            <p>
              {t("handover.export.leftOut", { count: summary.leftOutDamaged })}
            </p>
          )}
          {summary && summary.evidenceLeftOut > 0 && (
            <p>
              {t("handover.export.evidenceLeftOut", {
                count: summary.evidenceLeftOut,
              })}
            </p>
          )}
          <p>{t("handover.export.doneApart")}</p>
          {onHidePerson &&
            person &&
            (people.length <= 1 ? (
              // The only person the library shows cannot be hidden: said, not a dead checkbox.
              <p>{t("hiddenPeople.lastPerson")}</p>
            ) : (
              <div className="handover-hide-offer">
                <label className="restore-choice">
                  <input
                    type="checkbox"
                    checked={hideAfter}
                    aria-describedby="handover-hide-words"
                    onChange={(event) => setHideAfter(event.target.checked)}
                  />
                  {t("handover.export.hideOffer", { name: person.displayName })}
                </label>
                <p id="handover-hide-words" className="native-dialog-status">
                  {t("hiddenPeople.confirm.body", { name: person.displayName })}
                </p>
              </div>
            ))}
          <footer className="dialog-actions">
            <button className="button primary" type="button" onClick={finish}>
              {t("handover.close")}
            </button>
          </footer>
        </>
      )}
    </HandoverDialog>
  );
}

/** What a file holds, in counts that name no document. */
function SummaryList({
  summary,
  sizesIn1024s,
}: {
  summary: {
    documents: number;
    hidden: number;
    folders: number;
    aiAnswers?: number;
    withClinicEvidence: number;
    leftOutDamaged?: number;
    plaintextBytes: number;
  };
  sizesIn1024s?: boolean;
}) {
  const { t } = useI18n();
  return (
    <ul>
      <li>{t("handover.count.documents", { count: summary.documents })}</li>
      <li>{t("handover.count.hidden", { count: summary.hidden })}</li>
      <li>{t("handover.count.folders", { count: summary.folders })}</li>
      <li>{t("handover.count.answers", { count: summary.aiAnswers ?? 0 })}</li>
      <li>
        {t("handover.count.evidence", { count: summary.withClinicEvidence })}
      </li>
      {(summary.leftOutDamaged ?? 0) > 0 && (
        <li>
          {t("handover.export.leftOut", { count: summary.leftOutDamaged ?? 0 })}
        </li>
      )}
      <li>
        {t("handover.count.size", {
          size: formatFileSize(summary.plaintextBytes, sizesIn1024s ?? false),
        })}
      </li>
    </ul>
  );
}

type ImportBridge = Pick<
  VaultBridge,
  | "pickProfileImportSource"
  | "profileImportKeyKind"
  | "inspectProfileImport"
  | "importProfile"
>;

/** Adding a person from a handover file (#360): choose the file, give its key,
 * read what the file says, name the person, and add them. Nothing is written
 * until the last step, and the file is checked whole before it is. */
export function ProfileImportDialog({
  bridge,
  sizesIn1024s,
  onClose,
  onLocked,
  onImported,
}: {
  bridge: ImportBridge;
  sizesIn1024s?: boolean;
  onClose: () => void;
  onLocked: () => void;
  /** A person was added: the library reads the vault again. */
  onImported: (profileId: string) => void;
}) {
  const { t, locale } = useI18n();
  const [step, setStep] = useState<"pick" | "key" | "preview" | "done">("pick");
  const [pickId, setPickId] = useState<string | null>(null);
  const [kind, setKind] = useState<"key" | "passphrase">("key");
  const [secret, setSecret] = useState("");
  const [preview, setPreview] = useState<ProfileImportPreview | null>(null);
  const [name, setName] = useState("");
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [outcome, setOutcome] = useState<ProfileImportOutcome | null>(null);
  const [busy, setBusy] = useState<"" | "picking" | "opening" | "adding">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const request = () =>
    kind === "key" ? { key: secret } : { passphrase: secret };

  const fail = (failure: unknown) => {
    if (isLockedError(failure)) {
      onLocked();
    } else if (hasVaultErrorCode(failure, "package_key_typo")) {
      setError(t("handover.import.error.typo"));
    } else if (hasVaultErrorCode(failure, "package_key_is_recovery_key")) {
      setError(t("handover.import.error.recovery"));
    } else if (hasVaultErrorCode(failure, "wrong_passphrase")) {
      setError(t("handover.import.error.wrong"));
    } else if (hasVaultErrorCode(failure, "vault_newer_format")) {
      setError(t("handover.import.error.newer"));
    } else if (hasVaultErrorCode(failure, "invalid")) {
      setError(t("handover.import.error.damaged"));
    } else {
      setError(vaultErrorMessage(failure));
    }
  };

  const choose = async () => {
    if (busy) return;
    setBusy("picking");
    setError("");
    setNotice("");
    try {
      const picked = await bridge.pickProfileImportSource();
      if (!picked) {
        setNotice(t("handover.import.noFile"));
        return;
      }
      const found = await bridge.profileImportKeyKind(picked);
      setPickId(picked);
      setKind(found);
      setSecret("");
      setStep("key");
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy("");
    }
  };

  const open = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !pickId) return;
    setBusy("opening");
    setError("");
    try {
      const found = await bridge.inspectProfileImport({ pickId, ...request() });
      setPreview(found);
      setName(found.displayName);
      setAllowDuplicate(false);
      setStep("preview");
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy("");
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !pickId || !preview) return;
    setBusy("adding");
    setError("");
    try {
      const result = await bridge.importProfile({
        pickId,
        ...request(),
        displayName: name.trim() === preview.displayName ? undefined : name,
        allowDuplicate,
      });
      setOutcome(result);
      // The key is not kept once the file has been taken.
      setSecret("");
      setStep("done");
      if (result.status === "imported" && result.profileId)
        onImported(result.profileId);
    } catch (failure) {
      // A try spends the pick: a new one starts from choosing the file.
      setStep("pick");
      setPickId(null);
      setSecret("");
      fail(failure);
    } finally {
      setBusy("");
    }
  };

  const title =
    step === "pick"
      ? t("handover.import.title")
      : step === "key"
        ? t("handover.import.keyTitle")
        : step === "preview"
          ? t("handover.import.previewTitle")
          : t("handover.import.doneTitle");
  const exported = preview
    ? new Date(preview.exportedAtMs).toLocaleDateString(locale, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "";
  const duplicate = preview?.alreadyHere ?? null;
  const nameOk = name.trim() !== "" && [...name].length <= NAME_LIMIT;

  return (
    <HandoverDialog
      titleId="handover-import-title"
      title={title}
      stepKey={step}
      locked={busy !== ""}
      onClose={onClose}
    >
      {step === "pick" && (
        <>
          <p>{t("handover.import.about")}</p>
          {notice && <p role="status">{notice}</p>}
          {error && <p role="alert">{error}</p>}
          <footer className="dialog-actions">
            <button className="button" type="button" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              className="button primary"
              type="button"
              disabled={busy !== ""}
              onClick={() => void choose()}
            >
              {t("handover.import.choose")}
            </button>
          </footer>
        </>
      )}

      {step === "key" && (
        <form onSubmit={(event) => void open(event)}>
          <label>
            {kind === "key"
              ? t("handover.import.key")
              : t("handover.import.passphrase")}
            {kind === "key" ? (
              // A key is typed to be read back and checked (its last
              // characters catch a typo), so it is shown; it is not a
              // passphrase and is not counted as one.
              <input
                type="text"
                value={secret}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                autoComplete="off"
                disabled={busy !== ""}
                onChange={(event) => setSecret(event.target.value)}
              />
            ) : (
              <SecretInput
                value={secret}
                autoComplete="off"
                disabled={busy !== ""}
                onChange={(event) => setSecret(event.target.value)}
              />
            )}
          </label>
          <p className="field-hint">
            {kind === "key"
              ? t("handover.import.keyHint")
              : t("handover.import.passphraseHint")}
          </p>
          {error && <p role="alert">{error}</p>}
          <footer className="dialog-actions">
            <button className="button" type="button" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={busy !== "" || secret.trim() === ""}
            >
              {busy === "opening"
                ? t("handover.import.opening")
                : t("handover.import.open")}
            </button>
          </footer>
        </form>
      )}

      {step === "preview" && preview && (
        <form onSubmit={(event) => void add(event)}>
          <p>
            {t("handover.import.says", { name: preview.displayName })}
            {preview.birthDate &&
              ` ${t("handover.import.birth", { date: preview.birthDate })}`}{" "}
            {t("handover.import.madeOn", { date: exported })}
          </p>
          <SummaryList
            summary={{
              documents: preview.documents,
              hidden: preview.hidden,
              folders: preview.folders,
              aiAnswers: preview.aiAnswers,
              withClinicEvidence: preview.withClinicEvidence,
              plaintextBytes: preview.plaintextBytes,
            }}
            sizesIn1024s={sizesIn1024s}
          />
          {preview.withClinicEvidence > 0 && (
            <p>{t("handover.import.evidenceNote")}</p>
          )}
          {(preview.previousFullNames?.length ?? 0) > 0 && (
            <p>
              {t("handover.import.previousNames", {
                names: (preview.previousFullNames ?? []).join(", "),
              })}
            </p>
          )}
          {duplicate && (
            <fieldset disabled={busy !== ""}>
              <legend>{t("handover.import.duplicate.legend")}</legend>
              <p role="status">
                {duplicate.by === "package"
                  ? t("handover.import.duplicate.package")
                  : t("handover.import.duplicate.content", {
                      count: duplicate.matchingDocuments,
                    })}
              </p>
              <label className="restore-choice">
                <input
                  type="checkbox"
                  checked={allowDuplicate}
                  onChange={(event) => setAllowDuplicate(event.target.checked)}
                />
                {t("handover.import.duplicate.anyway")}
              </label>
            </fieldset>
          )}
          <label>
            {t("handover.import.nameLabel")}
            <input
              value={name}
              maxLength={NAME_LIMIT}
              disabled={busy !== ""}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <footer className="dialog-actions">
            <button
              className="button"
              type="button"
              disabled={busy !== ""}
              onClick={onClose}
            >
              {t("common.cancel")}
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={
                busy !== "" ||
                !nameOk ||
                (duplicate !== null && !allowDuplicate)
              }
            >
              {busy === "adding"
                ? t("handover.import.adding")
                : t("handover.import.add")}
            </button>
          </footer>
        </form>
      )}

      {step === "done" && outcome && (
        <>
          {outcome.status === "imported" ? (
            <>
              <p role="status">
                {t("handover.import.done", {
                  count: outcome.documents,
                  name: name.trim() || preview?.displayName || "",
                })}
              </p>
              {outcome.aiAnswers > 0 && (
                <p>
                  {t("handover.import.doneAnswers", {
                    count: outcome.aiAnswers,
                  })}
                </p>
              )}
              {outcome.evidenceKept > 0 && (
                <p>{t("handover.import.doneEvidence")}</p>
              )}
              {outcome.evidenceDropped + outcome.aiAnswersDropped > 0 && (
                <p>
                  {t("handover.import.doneDropped", {
                    count: outcome.evidenceDropped + outcome.aiAnswersDropped,
                  })}
                </p>
              )}
              {outcome.receiptCode && (
                <>
                  <p>
                    {t("handover.import.receipt")}{" "}
                    <strong>
                      <span aria-hidden="true">{outcome.receiptCode}</span>
                      <span className="sr-only">
                        {spoken(outcome.receiptCode.replace("-", " "))}
                      </span>
                    </strong>
                  </p>
                  <p className="field-hint">
                    {t("handover.import.receiptNote")}
                  </p>
                </>
              )}
            </>
          ) : (
            <p role="status">{t("handover.import.nothingNew")}</p>
          )}
          <footer className="dialog-actions">
            <button className="button primary" type="button" onClick={onClose}>
              {t("handover.close")}
            </button>
          </footer>
        </>
      )}
    </HandoverDialog>
  );
}
