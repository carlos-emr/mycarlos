import { useEffect, useRef, useState, type FormEvent } from "react";
import { useModalFocus } from "../useModalFocus";

/** Asks once for the password of a shared document that is locked with one.
 * The password goes to myCarlos's separate PDF helper and is not kept: the
 * field is emptied as soon as it is sent, and only the unlocked copy is
 * stored. */
export function UnlockReceivedDialog({
  name,
  wrongTries,
  busy,
  onUnlock,
  onNotNow,
}: {
  name: string;
  /** How many passwords did not open it; each one is said again. */
  wrongTries: number;
  busy: boolean;
  onUnlock: (password: string) => void;
  /** Leaves the file waiting, still locked. */
  onNotNow: () => void;
}) {
  const [password, setPassword] = useState("");
  const dialogRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const notNow = () => {
    if (!busy) onNotNow();
  };
  useModalFocus(true, dialogRef, notNow, inputRef);
  // After a wrong password, the empty field is ready for the next try, once
  // the check that disabled it is over.
  useEffect(() => {
    if (wrongTries && !busy) inputRef.current?.focus();
  }, [wrongTries, busy]);
  const unlock = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !password) return;
    const typed = password;
    setPassword("");
    onUnlock(typed);
  };
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={notNow}>
      <section
        ref={dialogRef}
        className="record-dialog native-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unlock-title"
        aria-describedby="unlock-help"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h2 id="unlock-title">Unlock {name}</h2>
        </header>
        <form onSubmit={unlock}>
          <div className="native-rename-fields">
            <p id="unlock-help">
              This document is locked with a password. Enter the document
              password from your patient portal. myCarlos keeps only the
              unlocked copy, never the password.
            </p>
            <label htmlFor="unlock-password">Document password</label>
            <input
              ref={inputRef}
              id="unlock-password"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={password}
              disabled={busy}
              aria-invalid={wrongTries ? true : undefined}
              aria-describedby={wrongTries ? "unlock-error" : undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
            {wrongTries > 0 && (
              <p id="unlock-error" role="alert" key={wrongTries}>
                That password did not open the document. Check it in your
                patient portal, then try again.
              </p>
            )}
          </div>
          <footer className="dialog-actions">
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={notNow}
            >
              Not now
            </button>
            <button className="button primary" disabled={busy || !password}>
              {busy ? "Unlocking…" : "Unlock and add"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
