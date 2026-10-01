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
  const [step, setStep] = useState<Step>(initialKey ? "key" : "passphrase");
  const [key, setKey] = useState(initialKey ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
        "Printing is not available here. Save the kit, or write the key down.",
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
  const cancel = () => {
    if (busy) return;
    if (required) {
      void bridge.cancelRecoveryKey().catch(() => undefined);
      onLockAndLeave();
    } else leave();
  };
  // A failure that is not a wrong answer. A locked vault is the app's to
  // show; other failures remain on this step and can be retried or left.
  // An error about what was typed goes as the patient types again, so that
  // the same error after another try is read out again. Others, such as why
  // "Set up later" appeared, stay.
  const typedWrongRef = useRef(false);
  const typedWrong = (message: string) => {
    typedWrongRef.current = true;
    setError(message);
  };
  const failed = (failure: unknown) => {
    if (isLockedError(failure)) {
      onLocked();
      return;
    }
    typedWrongRef.current = false;
    setError(vaultErrorMessage(failure));
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
    headingRef.current?.focus();
  }, [step]);

  const begin = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !passphrase) return;
    if (replacing && exposed === null) {
      setError("Choose why you are replacing your recovery key.");
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
      else setError(vaultErrorMessage(failure));
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
        setNotice(
          "Recovery kit saved. The key starts working once you finish the check.",
        );
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
        `You typed ${symbols.length === 1 ? "1 letter or digit" : `${symbols.length} letters and digits`}. Your recovery key has ${KEY_SYMBOLS} letters and digits: 7 groups of 4. Check what you wrote.`,
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
          "Your recovery key was not changed. Your current key still works. To change it, press Check and save again.",
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
          "That did not match three times. Look at your recovery key again, then check it.",
        );
      } else {
        setWrongTries(tries);
        typedWrong(vaultErrorMessage(failure));
      }
    } finally {
      setBusy(false);
    }
  };

  const leaveLabel = required
    ? "Lock vault and finish later"
    : offered
      ? "Set up later"
      : "Cancel";
  const title =
    step === "passphrase"
      ? replacing
        ? "Replace your recovery key"
        : "Set up a recovery key"
      : step === "key"
        ? "Your recovery key"
        : "Check your recovery key";

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
          step === "passphrase" ? "recovery-key-about" : undefined
        }
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h2 id="recovery-key-title" ref={headingRef} tabIndex={0}>
            {title}
          </h2>
        </header>

        {step === "passphrase" && (
          <form className="recovery-key-body" onSubmit={(e) => void begin(e)}>
            <div id="recovery-key-about" className="recovery-key-about">
              {offered && (
                <p tabIndex={0}>
                  Your vault is open. It has no recovery key yet. Without one,
                  if you forget your passphrase, the only way back in is to
                  erase the vault.
                </p>
              )}
              <p tabIndex={0}>
                A recovery key opens your vault if you forget your passphrase.
                Only you will have it: nobody at your clinic or at myCarlos can
                open your vault for you.
              </p>
              {replacing && (
                <p tabIndex={0}>
                  Your current recovery key stops working once you have checked
                  the new one.
                </p>
              )}
              <p tabIndex={0}>
                Type your passphrase{offered ? " again" : ""} to make your{" "}
                {replacing ? "new " : ""}recovery key. It is shown next: choose
                Continue only when nobody else can see your screen.
              </p>
            </div>
            {replacing && (
              <fieldset>
                <legend tabIndex={0}>Why are you replacing it?</legend>
                <p tabIndex={0} className="field-hint">
                  If you are not sure, choose the first.
                </p>
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
                  Its kit or note may have been lost, or seen by someone else
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
                  I just want a new key: its kit is safe
                </label>
              </fieldset>
            )}
            <label>
              Passphrase
              <SecretInput
                aria-label="Passphrase"
                type="password"
                autoComplete="current-password"
                required
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </label>
            {utf8Length(passphrase) > MAX_PASSPHRASE_BYTES && (
              <p tabIndex={0} role="alert">
                This is longer than any vault passphrase. Check what you typed.
              </p>
            )}
            {error && (
              <p tabIndex={0} role="alert">
                {error}
              </p>
            )}
            <footer className="dialog-actions">
              <button className="button" type="button" onClick={cancel}>
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
                Continue
              </button>
            </footer>
          </form>
        )}

        {step === "key" && (
          <div className="recovery-key-body">
            <p tabIndex={0}>
              Use Tab and Shift+Tab to read each instruction and key group.
              Escape leaves this setup; during first setup it locks the vault.
              An unfinished key will not work.
            </p>
            <p tabIndex={0}>
              Write it down, or save or print the kit, and keep it somewhere
              private, away from this device. This is the only time myCarlos
              shows it. Next, you type it all back to check it. Stay in myCarlos
              until the check is done: leaving or locking cancels this key.
            </p>
            {busy ? (
              // Not left on screen under a save picker.
              <p tabIndex={0} className="recovery-key-groups">
                Hidden while the kit is being saved.
              </p>
            ) : (
              <ol
                className="recovery-key-groups"
                // Kept a list for readers that drop one styled without markers.
                role="list"
                aria-label="Recovery key"
              >
                {groups.map((group, index) => (
                  <li tabIndex={0} key={index}>
                    <span aria-hidden="true">{group}</span>
                    <span className="sr-only">
                      Group {index + 1}: {spoken(group)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {label && (
              <p tabIndex={0}>
                Key label: <KeyLabel label={label} />. Write it next to the key.
                It is not secret: in Security, myCarlos shows the label of the
                key that works, so you can tell which kit is current.
              </p>
            )}
            <p
              tabIndex={notice ? 0 : -1}
              className="native-dialog-status"
              role="status"
            >
              {notice}
            </p>
            {error && (
              <p tabIndex={0} role="alert">
                {error}
              </p>
            )}
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
                Save recovery kit…
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
                  Print recovery kit
                </button>
              )}
              <button
                className="button primary"
                type="button"
                disabled={busy}
                onClick={startCheck}
              >
                Next: check your recovery key
              </button>
            </footer>
            {printing &&
              createPortal(
                <div className="recovery-kit-print" aria-hidden="true">
                  <h1>myCarlos recovery kit</h1>
                  <p className="recovery-kit-key">{key}</p>
                  <p>
                    {label ? `Key label: ${label} · ` : ""}Printed{" "}
                    {printedDate(new Date())}
                  </p>
                  {label && (
                    <p>
                      The label is not secret. In Security, myCarlos shows the
                      label of the recovery key that works now: a kit with a
                      different label no longer opens the vault.
                    </p>
                  )}
                  <p>
                    If you forget your myCarlos passphrase, this key opens your
                    vault on this device and lets you choose a new passphrase.
                    It works once you have finished the check in myCarlos.
                  </p>
                  <p>
                    Keep it somewhere private and away from the device. Anyone
                    with this key and a copy of your vault can open it. If you
                    set up a new recovery key, this one no longer opens the
                    vault on this device.
                  </p>
                </div>,
                document.body,
              )}
          </div>
        )}

        {step === "check" && (
          <form className="recovery-key-body" onSubmit={(e) => void check(e)}>
            <label>
              Your recovery key
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
            <p tabIndex={0} id="recovery-key-check-hint">
              Type your whole recovery key, as you wrote it down or saved it: 7
              groups of 4 letters and digits. Dashes, spaces and other
              punctuation do not matter.
            </p>
            <p
              tabIndex={notice ? 0 : -1}
              className="native-dialog-status"
              role="status"
            >
              {notice}
            </p>
            {error && (
              <p tabIndex={0} role="alert">
                {error}
              </p>
            )}
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
                Back: read your recovery key
              </button>
              <button
                ref={checkButtonRef}
                className="button primary"
                disabled={busy || !typed.trim()}
              >
                Check and save
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
