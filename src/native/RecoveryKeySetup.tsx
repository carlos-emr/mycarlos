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

/** Two different group positions to type back, in order. */
function pickGroups(count: number): [number, number] {
  const first = Math.floor(Math.random() * count);
  const second = (first + 1 + Math.floor(Math.random() * (count - 1))) % count;
  return first < second ? [first, second] : [second, first];
}

/** Read one character at a time, so that 0 and O, or 1 and I, are clear. */
const spoken = (group: string) => group.split("").join(" ");

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
}: {
  bridge: Pick<
    VaultBridge,
    | "beginRecoveryKey"
    | "confirmRecoveryKey"
    | "saveRecoveryKit"
    | "cancelRecoveryKey"
  >;
  /** A key already made (right after the vault was created). Otherwise the
   * dialog first asks for the passphrase. */
  initialKey?: string;
  /** Whether the vault already has a key, which this one replaces. */
  replacing: boolean;
  /** When the vault is new, the key must be set up: there is no way out. */
  required?: boolean;
  /** The setup opened by itself, on a vault unlocked without a recovery key:
   * it says why it is there, and leaving it is "Set up later". It opens on
   * the step that asks, and shows no key that was not asked for. */
  offered?: boolean;
  canPrint: boolean;
  onDone: (snapshot: VaultSnapshot) => void;
  /** `keyShown`: a key was on screen, and may be written down or in a kit,
   * that will now never open the vault. */
  onClose: (keyShown: boolean) => void;
  /** The vault turned out to be locked. */
  onLocked: () => void;
}) {
  const [step, setStep] = useState<Step>(initialKey ? "key" : "passphrase");
  const [key, setKey] = useState(initialKey ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [asked, setAsked] = useState<[number, number]>([0, 1]);
  const [answers, setAnswers] = useState(["", ""]);
  const [wrongTries, setWrongTries] = useState(0);
  // A required setup has no Cancel. Once something other than a wrong answer
  // has failed (a full disk, a vault that locked), it offers a way out, or
  // the patient would be left with a dialog that cannot succeed or close.
  const [canLeave, setCanLeave] = useState(false);
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
    if (required || busy) return;
    leave();
  };
  // A failure that is not a wrong answer. A locked vault is the app's to
  // show; anything else lets a required setup be left.
  const failed = (failure: unknown) => {
    if (isLockedError(failure)) {
      onLocked();
      return;
    }
    setError(vaultErrorMessage(failure));
    setCanLeave(true);
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
  // key step starts at its heading, so that it is read first; the others focus
  // their first field.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (step === "key") headingRef.current?.focus();
  }, [step]);

  const begin = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !passphrase) return;
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
    setAsked(pickGroups(groups.length));
    setAnswers(["", ""]);
    setError("");
    setNotice("");
    setStep("check");
  };

  const check = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || answers.some((answer) => !answer.trim())) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const snapshot = await bridge.confirmRecoveryKey([
        { index: asked[0], value: answers[0] },
        { index: asked[1], value: answers[1] },
      ]);
      if (snapshot) onDone(snapshot);
      // Cancelled in the native confirmation: the key is still being set
      // up, and can be checked again.
      else {
        refocusCheck.current = true;
        setNotice(
          "Your recovery key was not changed. Your current key still works. To change it, press Check and save again.",
        );
      }
    } catch (failure) {
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
        setError(vaultErrorMessage(failure));
      }
    } finally {
      setBusy(false);
    }
  };

  const leaveLabel = offered ? "Set up later" : "Cancel";
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
          <h2 id="recovery-key-title" ref={headingRef} tabIndex={-1}>
            {title}
          </h2>
        </header>

        {step === "passphrase" && (
          <form className="recovery-key-body" onSubmit={(e) => void begin(e)}>
            <div id="recovery-key-about" className="recovery-key-about">
              {offered && (
                <p>
                  Your vault is open. It has no recovery key yet. Without one,
                  if you forget your passphrase, the only way back in is to
                  erase the vault.
                </p>
              )}
              <p>
                A recovery key opens your vault if you forget your passphrase.
                Only you will have it: nobody at your clinic or at myCarlos can
                open your vault for you.
              </p>
              {replacing && (
                <p>
                  Your current recovery key stops working once you have checked
                  the new one.
                </p>
              )}
              <p>
                Type your passphrase{offered ? " again" : ""} to make your{" "}
                {replacing ? "new " : ""}recovery key. It is shown next: choose
                Continue only when nobody else can see your screen.
              </p>
            </div>
            <label>
              Passphrase
              <input
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </label>
            {utf8Length(passphrase) > MAX_PASSPHRASE_BYTES && (
              <p role="alert">
                This is longer than any vault passphrase. Check what you typed.
              </p>
            )}
            {error && <p role="alert">{error}</p>}
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
            <p>
              Write it down, or save or print the kit, and keep it somewhere
              private, away from this device. This is the only time myCarlos
              shows it. Next, you type two parts of it to check.
            </p>
            {busy ? (
              // Not left on screen under a save picker.
              <p className="recovery-key-groups">
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
                  <li key={index}>
                    <span aria-hidden="true">{group}</span>
                    <span className="sr-only">
                      Group {index + 1}: {spoken(group)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <p className="native-dialog-status" role="status">
              {notice}
            </p>
            {error && <p role="alert">{error}</p>}
            <footer className="dialog-actions">
              {!required && (
                <button className="button" type="button" onClick={cancel}>
                  {leaveLabel}
                </button>
              )}
              {required && canLeave && (
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={leave}
                >
                  Set up later
                </button>
              )}
              <button
                ref={saveButtonRef}
                className="button"
                type="button"
                disabled={busy}
                onClick={() => void saveKit()}
              >
                Save kit…
              </button>
              {canPrint && (
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    printing ? window.print() : setPrinting(true)
                  }
                >
                  Print
                </button>
              )}
              <button
                className="button primary"
                type="button"
                disabled={busy}
                onClick={startCheck}
              >
                Next
              </button>
            </footer>
            {printing &&
              createPortal(
                <div className="recovery-kit-print" aria-hidden="true">
                  <h1>myCarlos recovery kit</h1>
                  <p className="recovery-kit-key">{key}</p>
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
            <p>Type these two groups of your recovery key.</p>
            {asked.map((position, slot) => (
              <label key={position}>
                Group {position + 1}
                <input
                  autoFocus={slot === 0}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={16}
                  value={answers[slot]}
                  onChange={(event) =>
                    setAnswers((current) =>
                      current.map((answer, index) =>
                        index === slot ? event.target.value : answer,
                      ),
                    )
                  }
                />
              </label>
            ))}
            <p className="native-dialog-status" role="status">
              {notice}
            </p>
            {error && <p role="alert">{error}</p>}
            <footer className="dialog-actions">
              {!required && (
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={cancel}
                >
                  {leaveLabel}
                </button>
              )}
              {required && canLeave && (
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={leave}
                >
                  Set up later
                </button>
              )}
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
                Back
              </button>
              <button
                ref={checkButtonRef}
                className="button primary"
                disabled={busy || answers.some((answer) => !answer.trim())}
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
