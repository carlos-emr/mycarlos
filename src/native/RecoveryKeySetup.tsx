import { useEffect, useRef, useState, type FormEvent } from "react";
import { useModalFocus } from "../useModalFocus";
import {
  isRecoveryKeyTypo,
  MAX_PASSPHRASE_BYTES,
  utf8Length,
  vaultErrorMessage,
  type VaultBridge,
  type VaultSnapshot,
} from "../vault";

type Step = "passphrase" | "key" | "check";

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
  canPrint,
  onDone,
  onClose,
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
  canPrint: boolean;
  onDone: (snapshot: VaultSnapshot) => void;
  onClose: () => void;
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
  const groups = key ? key.split("-") : [];

  const cancel = () => {
    if (required || busy) return;
    void bridge.cancelRecoveryKey().catch(() => undefined);
    onClose();
  };
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
      setError(vaultErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const saveKit = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (await bridge.saveRecoveryKit()) setNotice("Recovery kit saved.");
    } catch (failure) {
      setError(vaultErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const startCheck = () => {
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
    try {
      const snapshot = await bridge.confirmRecoveryKey([
        { index: asked[0], value: answers[0] },
        { index: asked[1], value: answers[1] },
      ]);
      onDone(snapshot);
    } catch (failure) {
      // Only a wrong answer counts towards going back to the key.
      if (!isRecoveryKeyTypo(failure)) {
        setError(vaultErrorMessage(failure));
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

  const title =
    step === "passphrase"
      ? replacing
        ? "Replace your recovery key"
        : "Set up a recovery key"
      : step === "key"
        ? "Your recovery key"
        : "Check your recovery key";

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={cancel}>
      <section
        ref={dialogRef}
        className="record-dialog recovery-key-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-key-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h2 id="recovery-key-title" ref={headingRef} tabIndex={-1}>
            {title}
          </h2>
        </header>

        {step === "passphrase" && (
          <form className="recovery-key-body" onSubmit={(e) => void begin(e)}>
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
                Cancel
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
            <ol className="recovery-key-groups" aria-label="Recovery key">
              {groups.map((group, index) => (
                <li
                  key={index}
                  aria-label={`Group ${index + 1}: ${spoken(group)}`}
                >
                  {group}
                </li>
              ))}
            </ol>
            <p className="native-dialog-status" role="status">
              {notice}
            </p>
            {error && <p role="alert">{error}</p>}
            <footer className="dialog-actions">
              {!required && (
                <button className="button" type="button" onClick={cancel}>
                  Cancel
                </button>
              )}
              <button
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
                  onClick={() => window.print()}
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
            {/* Printed on its own: the rest of the page is hidden in print. */}
            <div className="recovery-kit-print" aria-hidden="true">
              <h1>myCarlos recovery kit</h1>
              <p className="recovery-kit-key">{key}</p>
              <p>
                If you forget your myCarlos passphrase, this key opens your
                vault on this device and lets you choose a new passphrase.
              </p>
              <p>
                Keep it somewhere private and away from the device. Anyone with
                this key and a copy of your vault can open it. If you set up a
                new recovery key, this one stops working.
              </p>
            </div>
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
            {error && <p role="alert">{error}</p>}
            <footer className="dialog-actions">
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setStep("key");
                }}
              >
                Back
              </button>
              <button
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
