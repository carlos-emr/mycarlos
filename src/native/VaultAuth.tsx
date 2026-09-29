import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "../Icon";
import { MAX_PASSPHRASE_BYTES, utf8Length } from "../vault";
import { NAME_INPUT_MAX_LENGTH, nameTooLong } from "./recordPresentation";

// The vault counts a new passphrase's characters (Unicode code points) after
// NFC normalization, so the same visible text is judged alike from any keyboard.
export const MIN_PASSPHRASE_CHARS = 15;
export const tooShortPassphrase = (value: string) =>
  [...value.normalize("NFC")].length < MIN_PASSPHRASE_CHARS;

export function VaultAuthFrame({
  state,
  children,
}: {
  state: "Locked" | "Locking" | "Not locked" | "Setting up" | "Opening";
  children: ReactNode;
}) {
  return (
    <div className="evaluation-page native-vault-page">
      <div className="evaluation-banner" role="note">
        <strong>Synthetic-data development build</strong>
        <span>Do not use real patient information</span>
      </div>
      <div className="page-wrap native-auth-wrap">
        <section
          className="app-window native-auth-window"
          aria-label="myCarlos private vault"
        >
          <header className="titlebar">
            <span className="window-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="window-title">myCarlos</span>
            <span className="native-auth-state">
              <Icon name="shield" /> {state}
            </span>
          </header>
          <main className="vault-auth">{children}</main>
        </section>
      </div>
    </div>
  );
}

const AUTH_NOTICE_ID = "auth-notice";

// A status line is read out only when its text changes while it is on the
// page, so this one stays there when empty, and a wrong passphrase is then
// announced. A message a screen opens with, such as "Vault locked.", is not a
// change: the unlock screen also gives it as the description of the
// Passphrase field, which has focus.
function AuthNotice({
  notice,
  id = AUTH_NOTICE_ID,
}: {
  notice: string;
  id?: string;
}) {
  return (
    <p id={id} role="status">
      {notice}
    </p>
  );
}

// The native side compares the typed text with this exact phrase again.
const RESET_CONFIRMATION = "RESET MYCARLOS VAULT";

/** The typed confirmation shared by every place that can erase the vault. */
export function ResetConfirmation({
  busy,
  actionLabel,
  onReset,
}: {
  busy: boolean;
  actionLabel: string;
  onReset: (confirmation: string) => Promise<void>;
}) {
  const [resetText, setResetText] = useState("");
  return (
    <>
      <label>
        Type {RESET_CONFIRMATION}
        <input
          maxLength={RESET_CONFIRMATION.length + 1}
          value={resetText}
          onChange={(event) => setResetText(event.target.value)}
        />
      </label>
      <button
        className="button danger"
        type="button"
        disabled={busy || resetText !== RESET_CONFIRMATION}
        onClick={() => void onReset(resetText)}
      >
        {actionLabel}
      </button>
    </>
  );
}

export function CreateVault({
  busy,
  notice,
  onCreate,
}: {
  busy: boolean;
  notice: string;
  onCreate: (profile: string, passphrase: string) => Promise<void>;
}) {
  const [profile, setProfile] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const tooLong = utf8Length(passphrase) > MAX_PASSPHRASE_BYTES;
  const tooShort = tooShortPassphrase(passphrase);
  const profileTooLong = nameTooLong(profile);
  const invalid =
    !profile.trim() ||
    profileTooLong ||
    tooLong ||
    tooShort ||
    passphrase !== confirmation;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (invalid) return;
    const secret = passphrase;
    setPassphrase("");
    setConfirmation("");
    void onCreate(profile, secret);
  };
  return (
    <VaultAuthFrame state="Setting up">
      <section className="vault-card" aria-labelledby="create-title">
        <p className="vault-kicker">myCarlos private records</p>
        <h1 id="create-title">Create your encrypted vault</h1>
        <p>
          Your files and record details are encrypted on this device. Your
          passphrase is the only recovery method.
        </p>
        <p>
          Your vault stays on this device. If you created one on another device,
          it is still there, and will not appear here.
        </p>
        <form onSubmit={submit}>
          <label>
            First patient profile
            <input
              required
              maxLength={NAME_INPUT_MAX_LENGTH}
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
            />
          </label>
          {profileTooLong && (
            <p role="alert">This name is too long. Shorten it.</p>
          )}
          <label>
            Passphrase
            <input
              required
              type="password"
              autoComplete="new-password"
              aria-describedby="passphrase-rules"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          <small id="passphrase-rules">
            Use at least {MIN_PASSPHRASE_CHARS} characters. Spaces are allowed;
            common passwords, names, and predictable patterns are rejected
            locally.
          </small>
          <label>
            Confirm passphrase
            <input
              required
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
          {confirmation && passphrase !== confirmation && (
            <p role="alert">Passphrases do not match.</p>
          )}
          {tooLong && (
            <p role="alert">This passphrase is too long. Shorten it.</p>
          )}
          {tooShort && confirmation && (
            <p role="alert">
              This passphrase is too short. Use at least {MIN_PASSPHRASE_CHARS}{" "}
              characters.
            </p>
          )}
          <AuthNotice notice={notice} />
          <button className="button primary" disabled={busy || invalid}>
            Create vault
          </button>
        </form>
      </section>
    </VaultAuthFrame>
  );
}

export function UnlockVault({
  busy,
  notice,
  autoLockMinutes,
  onUnlock,
  onRecover,
  onReset,
}: {
  busy: boolean;
  notice: string;
  autoLockMinutes: number;
  onUnlock: (passphrase: string) => Promise<void>;
  onRecover: (recoveryKey: string, newPassphrase: string) => Promise<void>;
  onReset: (confirmation: string) => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState("");
  // Messages go next to the part of the screen they answer: the Unlock form,
  // or the recovery key and erase controls under "Forgot your passphrase?".
  const [source, setSource] = useState<"unlock" | "forgot">("unlock");
  const unlockNotice = source === "unlock" ? notice : "";
  // No vault passphrase can be longer, so say so instead of sending it to a
  // native refusal that can only report invalid input.
  const tooLong = utf8Length(passphrase) > MAX_PASSPHRASE_BYTES;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (tooLong) return;
    const secret = passphrase;
    setPassphrase("");
    setSource("unlock");
    void onUnlock(secret);
  };
  return (
    <VaultAuthFrame state="Locked">
      <section className="vault-card" aria-labelledby="unlock-title">
        <p className="vault-kicker">myCarlos private records</p>
        <h1 id="unlock-title">Unlock your vault</h1>
        <p>
          The vault locks after {autoLockMinutes} minute
          {autoLockMinutes === 1 ? "" : "s"} of inactivity and whenever myCarlos
          is hidden, for example minimized or sent to the background.
        </p>
        <form onSubmit={submit}>
          <label>
            Passphrase
            <input
              autoFocus
              required
              type="password"
              autoComplete="current-password"
              aria-describedby={unlockNotice ? AUTH_NOTICE_ID : undefined}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          {tooLong && (
            <p role="alert">
              This is longer than any vault passphrase. Check what you typed.
            </p>
          )}
          <AuthNotice notice={unlockNotice} />
          <button className="button primary" disabled={busy || tooLong}>
            Unlock
          </button>
        </form>
        <details className="vault-reset">
          <summary>Forgot your passphrase?</summary>
          <RecoverWithKey
            busy={busy}
            notice={source === "forgot" ? notice : ""}
            onRecover={(recoveryKey, newPassphrase) => {
              setSource("forgot");
              return onRecover(recoveryKey, newPassphrase);
            }}
          />
          <h2 className="vault-reset-heading">No recovery key?</h2>
          <p>
            Without one, the only way back in is to erase this vault, which
            permanently deletes everything in it, and start again.
          </p>
          <ResetConfirmation
            busy={busy}
            actionLabel="Erase vault"
            onReset={(confirmation) => {
              setSource("forgot");
              return onReset(confirmation);
            }}
          />
        </details>
      </section>
    </VaultAuthFrame>
  );
}

// What is typed on the recovery form is cleared after this long untouched.
export const UNATTENDED_CLEAR_MS = 5 * 60 * 1000;

/** Opens the vault with its recovery key and replaces the forgotten
 * passphrase. */
function RecoverWithKey({
  busy,
  notice,
  onRecover,
}: {
  busy: boolean;
  notice: string;
  onRecover: (recoveryKey: string, newPassphrase: string) => Promise<void>;
}) {
  const [recoveryKey, setRecoveryKey] = useState("");
  const [shown, setShown] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  // Nothing locks this screen, so what was typed here is cleared when the app
  // is hidden: it must not wait on screen, or in an app switcher's picture.
  useEffect(() => {
    const clearWhenHidden = () => {
      if (document.visibilityState !== "hidden") return;
      setRecoveryKey("");
      setPassphrase("");
      setConfirmation("");
      setShown(false);
    };
    document.addEventListener("visibilitychange", clearWhenHidden);
    return () =>
      document.removeEventListener("visibilitychange", clearWhenHidden);
  }, []);
  // Nor may it wait on a screen left unattended.
  useEffect(() => {
    if (!recoveryKey && !passphrase && !confirmation) return;
    const timer = window.setTimeout(() => {
      setRecoveryKey("");
      setPassphrase("");
      setConfirmation("");
      setShown(false);
    }, UNATTENDED_CLEAR_MS);
    return () => window.clearTimeout(timer);
  }, [recoveryKey, passphrase, confirmation]);
  const tooLong = utf8Length(passphrase) > MAX_PASSPHRASE_BYTES;
  const tooShort = tooShortPassphrase(passphrase);
  const invalid =
    !recoveryKey.trim() || tooLong || tooShort || passphrase !== confirmation;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (invalid) return;
    const newPassphrase = passphrase;
    setPassphrase("");
    setConfirmation("");
    // The key stays, so that a typo in it can be corrected, but hidden again.
    setShown(false);
    void onRecover(recoveryKey, newPassphrase);
  };
  return (
    <form onSubmit={submit}>
      <p>
        Use your recovery key to open the vault and choose a new passphrase.
      </p>
      <label>
        Recovery key
        <input
          required
          type={shown ? "text" : "password"}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={64}
          aria-describedby="recover-key-format"
          value={recoveryKey}
          onChange={(e) => setRecoveryKey(e.target.value)}
        />
      </label>
      <small id="recover-key-format">
        28 letters and digits, in 7 groups of 4, as on your kit. Dashes and
        spaces do not matter.
      </small>
      <button
        className="button"
        type="button"
        aria-pressed={shown}
        onClick={() => setShown((current) => !current)}
      >
        Show recovery key
      </button>
      <label>
        New passphrase
        <input
          required
          type="password"
          autoComplete="new-password"
          aria-describedby="recover-passphrase-rules"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
        />
      </label>
      <small id="recover-passphrase-rules">
        Use at least {MIN_PASSPHRASE_CHARS} characters. Spaces are allowed;
        common passwords, names, and predictable patterns are rejected locally.
      </small>
      <label>
        Confirm new passphrase
        <input
          required
          type="password"
          autoComplete="new-password"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
        />
      </label>
      {confirmation && passphrase !== confirmation && (
        <p role="alert">Passphrases do not match.</p>
      )}
      {tooLong && <p role="alert">This passphrase is too long. Shorten it.</p>}
      {tooShort && confirmation && (
        <p role="alert">
          This passphrase is too short. Use at least {MIN_PASSPHRASE_CHARS}{" "}
          characters.
        </p>
      )}
      <AuthNotice id="recover-notice" notice={notice} />
      <button className="button primary" disabled={busy || invalid}>
        Open with recovery key
      </button>
    </form>
  );
}
