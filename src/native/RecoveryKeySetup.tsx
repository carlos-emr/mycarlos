import {
  useTextState,
  message,
  type UiText,
  deferredText,
  t as translateCurrent,
  useI18n,
  withElements,
} from "../i18n";
import { SecretInput } from "./SecretInput";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { useModalFocus } from "../useModalFocus";
import {
  isLockedError,
  isRecoveryKeyTypo,
  MAX_PASSPHRASE_BYTES,
  utf8Length,
  vaultErrorMessage,
  type VaultBridge,
  type VaultSnapshot,
} from "../vault";
import { KeyLabel, printedDate, spoken } from "./KeyLabel";

type Step = "passphrase" | "key" | "check";

/** What the library opens on, when it opens on the recovery key setup: for a
 * vault just created, the key made with it, to be set up before anything
 * else; for a vault unlocked without a recovery key, the offer of one. */
export type OpeningRecoverySetup =
  | { vault: "created"; key: string }
  | { vault: "unlocked" };

// After this many wrong answers the check goes back to the key, so that the
// patient looks at what they wrote down rather than guessing again.
const TRIES_BEFORE_REVIEW = 3;

/** Letters and digits in a recovery key: 7 groups of 4. */
const KEY_SYMBOLS = 28;

export function RecoveryKeySetup({
  bridge,
  initialKey,
  replacing,
  required = false,
  offered = false,
  canPrint,
  keyboardHints = true,
  onDone,
  onClose,
  onLocked,
  onLockAndLeave,
  onKeyShown,
}: {
  bridge: Pick<
    VaultBridge,
    | "beginRecoveryKey"
    | "confirmRecoveryKey"
    | "saveRecoveryKit"
    | "recoveryKeyLabel"
    | "cancelRecoveryKey"
  >;
  /** A key already made (right after the vault was created). Otherwise the
   * dialog first asks for the passphrase. */
  initialKey?: string;
  /** Whether the vault already has a key, which this one replaces. */
  replacing: boolean;
  /** First setup: leaving locks the vault and discards the unfinished key. */
  required?: boolean;
  /** The setup opened by itself, on a vault unlocked without a recovery key:
   * it says why it is there, and leaving it is "Set up later". It opens on
   * the step that asks, and shows no key that was not asked for. */
  offered?: boolean;
  canPrint: boolean;
  /** Whether to show instructions that only apply with a keyboard (Tab and
   * Escape): false on phones and tablets. */
  keyboardHints?: boolean;
  /** `exposed`: when replacing, the old key's kit may have been lost or
   * seen, as the patient said. */
  onDone: (snapshot: VaultSnapshot, how: { exposed: boolean }) => void;
  /** `keyShown`: a key was on screen, and may be written down or in a kit,
   * that will now never open the vault. */
  onClose: (keyShown: boolean) => void;
  /** The vault turned out to be locked. */
  onLocked: () => void;
  /** Hide the key immediately and request locking, with a visible retry on failure. */
  onLockAndLeave: () => void;
  /** A key is on screen, and may now be written down or saved. */
  onKeyShown?: (how: { exposed: boolean }) => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>(initialKey ? "key" : "passphrase");
  const [key, setKey] = useState(initialKey ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useTextState();
  const [notice, setNotice] = useTextState();
  const [typed, setTyped] = useState("");
  // Why a key is being replaced: whether its kit may have been lost or seen
  // decides what the patient is told to do with older backups.
  const [exposed, setExposed] = useState<boolean | null>(null);
  const exposedRef = useRef(exposed);
  exposedRef.current = exposed;
  // Said once, when a key is first on screen.
  const keyShownRef = useRef(onKeyShown);
  keyShownRef.current = onKeyShown;
  useEffect(() => {
    if (key) keyShownRef.current?.({ exposed: exposedRef.current === true });
  }, [key]);
  // The key's short label, which tells its kits apart: shown with the key
  // and printed on the kit. Not secret.
  const [label, setLabel] = useState<string | null>(null);
  // Print waits until the label is known, or known to be missing.
  const [labelSettled, setLabelSettled] = useState(false);
  useEffect(() => {
    if (!key) return;
    let current = true;
    bridge
      .recoveryKeyLabel()
      .then(
        (found) => {
          if (current) setLabel(found);
        },
        // Only the label is missing: the key and its kit still work.
        () => undefined,
      )
      .finally(() => {
        if (current) setLabelSettled(true);
      });
    return () => {
      current = false;
    };
  }, [key, bridge]);
  // A lock closes this setup, and can do so while the key is being stored.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [wrongTries, setWrongTries] = useState(0);
  // The kit is in the page only while it prints.
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    // Print styles hide everything but the kit while this class is set, so
    // printing anything else in the app is unaffected.
    document.body.classList.add("printing-recovery-kit");
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done);
    try {
      window.print();
    } catch {
      setPrinting(false);
      setError(
        deferredText(() => translateCurrent("recoveryKey.printUnavailable")),
      );
    }
    return () => {
      window.removeEventListener("afterprint", done);
      document.body.classList.remove("printing-recovery-kit");
    };
  }, [printing]);
  const groups = key ? key.split("-") : [];

  const leave = () => {
    void bridge.cancelRecoveryKey().catch(() => undefined);
    onClose(Boolean(key));
  };
  // Leaving the first setup discards the key on screen and locks the vault,
  // so it is confirmed first (Ben, 6 Oct 2026). The confirmation replaces the
  // setup inside this dialog, which keeps one focus trap: Escape there means
  // Cancel, so a second Escape can never discard the key.
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const returnFromConfirmRef = useRef<HTMLElement | null>(null);
  const confirmCancelRef = useRef<HTMLButtonElement | null>(null);
  const discardAndLock = () => {
    void bridge.cancelRecoveryKey().catch(() => undefined);
    onLockAndLeave();
  };
  const cancel = () => {
    if (busy) return;
    if (confirmingLeave) {
      setConfirmingLeave(false);
      return;
    }
    if (required && key) {
      const focused = document.activeElement;
      returnFromConfirmRef.current =
        focused instanceof HTMLElement ? focused : null;
      setConfirmingLeave(true);
    } else if (required) {
      discardAndLock();
    } else leave();
  };
  // A failure that is not a wrong answer. A locked vault is the app's to
  // show; other failures remain on this step and can be retried or left.
  // An error about what was typed goes as the patient types again, so that
  // the same error after another try is read out again. Others stay.
  const typedWrongRef = useRef(false);
  const typedWrong = (message: UiText) => {
    typedWrongRef.current = true;
    setError(deferredText(() => message));
  };
  const failed = (failure: unknown) => {
    if (isLockedError(failure)) {
      onLocked();
      return;
    }
    typedWrongRef.current = false;
    setError(deferredText(() => vaultErrorMessage(failure)));
  };
  // The buttons are disabled while the kit is saved, which drops the focus
  // that was on one of them.
  const saveButtonRef = useRef<HTMLButtonElement | null>(null);
  const refocusSave = useRef(false);
  // The same after a replacement was cancelled in the native confirmation.
  const checkButtonRef = useRef<HTMLButtonElement | null>(null);
  const refocusCheck = useRef(false);
  useEffect(() => {
    if (busy) return;
    if (refocusSave.current) saveButtonRef.current?.focus();
    if (refocusCheck.current) checkButtonRef.current?.focus();
    refocusSave.current = false;
    refocusCheck.current = false;
  }, [busy]);
  const dialogRef = useRef<HTMLElement | null>(null);
  useModalFocus(true, dialogRef, cancel);
  // Each step replaces the last, and the control that had focus with it. The
  // heading starts each step, so instructions are not skipped.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (confirmingLeave) {
      confirmCancelRef.current?.focus();
      return;
    }
    // Back from the confirmation: focus returns to where it was.
    const back = returnFromConfirmRef.current;
    returnFromConfirmRef.current = null;
    if (!back) return;
    if (back.isConnected && dialogRef.current?.contains(back)) back.focus();
    else headingRef.current?.focus();
  }, [confirmingLeave]);
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const begin = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !passphrase) return;
    if (replacing && exposed === null) {
      setError(
        deferredText(() => translateCurrent("recoveryKey.chooseReason")),
      );
      return;
    }
    const secret = passphrase;
    setPassphrase("");
    setBusy(true);
    setError("");
    try {
      setKey(await bridge.beginRecoveryKey(secret));
      setStep("key");
    } catch (failure) {
      if (isLockedError(failure)) onLocked();
      else
        setError(
          deferredText(() => vaultErrorMessage(failure, ["box.passphrase"])),
        );
    } finally {
      setBusy(false);
    }
  };

  const saveKit = async () => {
    refocusSave.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (await bridge.saveRecoveryKit())
        setNotice(deferredText(() => translateCurrent("recoveryKey.kitSaved")));
    } catch (failure) {
      failed(failure);
    } finally {
      setBusy(false);
    }
  };

  const startCheck = () => {
    // The kit leaves the page with the key, even if the print never
    // reported that it had finished.
    setPrinting(false);
    setWrongTries(0);
    setTyped("");
    setError("");
    setNotice("");
    setStep("check");
  };

  const check = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !typed.trim()) return;
    // The whole key, typed back: as its groups, which the vault checks.
    // Anything but a letter or digit only separates groups, as natively.
    const symbols = typed.replace(/[^\p{L}\p{N}]/gu, "");
    if (symbols.length !== KEY_SYMBOLS) {
      typedWrong(
        message("recoveryKey.typedCount", {
          count: symbols.length,
          total: KEY_SYMBOLS,
        }),
      );
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const snapshot = await bridge.confirmRecoveryKey(
        Array.from({ length: KEY_SYMBOLS / 4 }, (_, index) => ({
          index,
          value: symbols.slice(index * 4, index * 4 + 4),
        })),
      );
      // Stored after a lock had closed this: the patient never saw it end,
      // so the setup stays unfinished, and the next unlock, finding the key
      // changed, says it was saved.
      if (!mountedRef.current) return;
      if (snapshot) onDone(snapshot, { exposed: exposed === true });
      // Cancelled in the native confirmation: the key is still being set
      // up, and can be checked again.
      else {
        refocusCheck.current = true;
        setNotice(
          deferredText(() => translateCurrent("recoveryKey.notChanged")),
        );
      }
    } catch (failure) {
      // A lock closed this: it says so itself.
      if (!mountedRef.current) return;
      // Only a wrong answer counts towards going back to the key.
      if (!isRecoveryKeyTypo(failure)) {
        failed(failure);
        return;
      }
      const tries = wrongTries + 1;
      if (tries >= TRIES_BEFORE_REVIEW) {
        setWrongTries(0);
        setStep("key");
        // An alert, as it arrives with the step: a status line would not be
        // read out.
        setError(
          deferredText(() => translateCurrent("recoveryKey.threeMisses")),
        );
      } else {
        setWrongTries(tries);
        typedWrong(deferredText(() => vaultErrorMessage(failure)));
      }
    } finally {
      setBusy(false);
    }
  };

  const leaveLabel = required
    ? t("recoveryKey.leave.required")
    : offered
      ? t("recoveryKey.leave.offered")
      : t("common.cancel");
  const title =
    step === "passphrase"
      ? replacing
        ? t("recoveryKey.title.replace")
        : t("recoveryKey.title.setUp")
      : step === "key"
        ? t("recoveryKey.title.key")
        : t("recoveryKey.title.check");

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      // Once a key is on screen, a stray click outside must not end the
      // setup. Nor may one end an offer that opened by itself, before it was
      // read: a second press meant for Unlock would land here.
      onMouseDown={key || offered ? undefined : cancel}
    >
      <section
        ref={dialogRef}
        className="record-dialog recovery-key-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-key-title"
        aria-describedby={
          step === "passphrase"
            ? "recovery-key-about"
            : step === "key"
              ? keyboardHints
                ? "recovery-key-keyboard-hint recovery-key-instructions"
                : "recovery-key-instructions"
              : "recovery-key-check-hint"
        }
        onMouseDown={(event) => event.stopPropagation()}
      >
        {confirmingLeave && (
          <section
            className="recovery-key-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="recovery-key-confirm-title"
            aria-describedby="recovery-key-confirm-message"
          >
            <header className="dialog-head">
              <h2 id="recovery-key-confirm-title">
                {t("recoveryKey.discard.title")}
              </h2>
            </header>
            <div className="recovery-key-body">
              <p id="recovery-key-confirm-message">
                {t("recoveryKey.discard.body")}
              </p>
              <footer className="dialog-actions">
                <button
                  ref={confirmCancelRef}
                  className="button"
                  type="button"
                  onClick={() => setConfirmingLeave(false)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  className="button danger"
                  type="button"
                  onClick={discardAndLock}
                >
                  {t("recoveryKey.discard.confirm")}
                </button>
              </footer>
            </div>
          </section>
        )}
        {/* Hidden rather than removed while confirming, so the key and the
            control that had focus are still there after Cancel. */}
        <div className="recovery-key-steps" hidden={confirmingLeave}>
          <header className="dialog-head">
            <h2 id="recovery-key-title" ref={headingRef} tabIndex={-1}>
              {title}
            </h2>
          </header>

          {step === "passphrase" && (
            <form className="recovery-key-body" onSubmit={(e) => void begin(e)}>
              <div id="recovery-key-about" className="recovery-key-about">
                {offered && <p>{t("recoveryKey.about.offered")}</p>}
                <p>{t("recoveryKey.about.what")}</p>
                {replacing && <p>{t("recoveryKey.about.replacing")}</p>}
                <p>
                  {t(
                    offered
                      ? replacing
                        ? "recoveryKey.about.typeAgainNew"
                        : "recoveryKey.about.typeAgain"
                      : replacing
                        ? "recoveryKey.about.typeNew"
                        : "recoveryKey.about.type",
                  )}
                </p>
              </div>
              {replacing && (
                <fieldset>
                  <legend>{t("recoveryKey.reason.legend")}</legend>
                  <p className="field-hint">{t("recoveryKey.reason.hint")}</p>
                  <label className="restore-choice">
                    <input
                      type="radio"
                      name="replace-reason"
                      checked={exposed === true}
                      onChange={() => {
                        setExposed(true);
                        setError("");
                      }}
                    />
                    {t("recoveryKey.reason.exposed")}
                  </label>
                  <label className="restore-choice">
                    <input
                      type="radio"
                      name="replace-reason"
                      checked={exposed === false}
                      onChange={() => {
                        setExposed(false);
                        setError("");
                      }}
                    />
                    {t("recoveryKey.reason.routine")}
                  </label>
                </fieldset>
              )}
              <label>
                {t("passphrase.label")}
                <SecretInput
                  aria-label={t("passphrase.label")}
                  type="password"
                  autoComplete="current-password"
                  required
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </label>
              {utf8Length(passphrase) > MAX_PASSPHRASE_BYTES && (
                <p role="alert">{t("passphrase.longerThanAny")}</p>
              )}
              {error && <p role="alert">{error}</p>}
              <footer className="dialog-actions">
                <button
                  className="button"
                  type="button"
                  onClick={cancel}
                  disabled={busy}
                >
                  {leaveLabel}
                </button>
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    !passphrase ||
                    utf8Length(passphrase) > MAX_PASSPHRASE_BYTES
                  }
                >
                  {t("recoveryKey.continue")}
                </button>
              </footer>
            </form>
          )}

          {step === "key" && (
            <div className="recovery-key-body">
              {keyboardHints && (
                <p id="recovery-key-keyboard-hint">
                  {t("recoveryKey.keyboardHint")}
                </p>
              )}
              <p id="recovery-key-instructions">
                {t("recoveryKey.instructions")}
              </p>
              {busy ? (
                // Not left on screen under a save picker.
                <p className="recovery-key-groups">
                  {t("recoveryKey.hiddenWhileSaving")}
                </p>
              ) : (
                <ol
                  className="recovery-key-groups"
                  // Kept a list for readers that drop one styled without markers.
                  role="list"
                  aria-label={t("recover.key.label")}
                >
                  {groups.map((group, index) => (
                    <li key={index}>
                      <span aria-hidden="true">{group}</span>
                      <span className="sr-only">
                        {t("recoveryKey.group", {
                          number: index + 1,
                          characters: spoken(group),
                        })}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {label && (
                <p>
                  {withElements(t("recoveryKey.label"), {
                    label: <KeyLabel label={label} />,
                  })}
                </p>
              )}
              <p className="native-dialog-status" role="status">
                {notice}
              </p>
              {error && <p role="alert">{error}</p>}
              <footer className="dialog-actions">
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={cancel}
                >
                  {leaveLabel}
                </button>
                <button
                  ref={saveButtonRef}
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() => void saveKit()}
                >
                  {t("recoveryKey.saveKit")}
                </button>
                {canPrint && (
                  <button
                    className="button"
                    type="button"
                    disabled={busy || !labelSettled}
                    onClick={() =>
                      printing ? window.print() : setPrinting(true)
                    }
                  >
                    {t("recoveryKey.printKit")}
                  </button>
                )}
                <button
                  className="button primary"
                  type="button"
                  disabled={busy}
                  onClick={startCheck}
                >
                  {t("recoveryKey.next")}
                </button>
              </footer>
              {printing &&
                createPortal(
                  <div className="recovery-kit-print" aria-hidden="true">
                    <h1>{t("kit.title")}</h1>
                    <p className="recovery-kit-key">{key}</p>
                    <p>
                      {label
                        ? t("kit.labelPrinted", {
                            label,
                            date: printedDate(new Date()),
                          })
                        : t("kit.printed", { date: printedDate(new Date()) })}
                    </p>
                    {label && <p>{t("kit.labelNote")}</p>}
                    <p>{t("kit.use")}</p>
                    <p>{t("kit.keep")}</p>
                  </div>,
                  document.body,
                )}
            </div>
          )}

          {step === "check" && (
            <form className="recovery-key-body" onSubmit={(e) => void check(e)}>
              <label>
                {t("recoveryKey.check.label")}
                <input
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={64}
                  aria-describedby="recovery-key-check-hint"
                  value={typed}
                  onChange={(event) => {
                    setTyped(event.target.value);
                    if (typedWrongRef.current) {
                      typedWrongRef.current = false;
                      setError("");
                    }
                  }}
                />
              </label>
              <p id="recovery-key-check-hint">{t("recoveryKey.check.hint")}</p>
              <p className="native-dialog-status" role="status">
                {notice}
              </p>
              {error && <p role="alert">{error}</p>}
              <footer className="dialog-actions">
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={cancel}
                >
                  {leaveLabel}
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    setNotice("");
                    setStep("key");
                  }}
                >
                  {t("recoveryKey.back")}
                </button>
                <button
                  ref={checkButtonRef}
                  className="button primary"
                  disabled={busy || !typed.trim()}
                >
                  {t("recoveryKey.checkAndSave")}
                </button>
              </footer>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
