import { useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "../Icon";
import { MAX_PASSPHRASE_BYTES, utf8Length } from "../vault";

export function VaultAuthFrame({
  state,
  children,
}: {
  state: "Locked" | "Not locked" | "Setting up" | "Opening";
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
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (tooLong || passphrase !== confirmation) return;
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
              maxLength={120}
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
            />
          </label>
          <label>
            Passphrase
            <input
              required
              maxLength={1024}
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          <small>
            Use at least 15 characters. Spaces are allowed; common passwords,
            names, and predictable patterns are rejected locally.
          </small>
          <label>
            Confirm passphrase
            <input
              required
              maxLength={1024}
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
          {notice && <p role="status">{notice}</p>}
          <button
            className="button primary"
            disabled={busy || tooLong || passphrase !== confirmation}
          >
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
  onReset,
}: {
  busy: boolean;
  notice: string;
  autoLockMinutes: number;
  onUnlock: (passphrase: string) => Promise<void>;
  onReset: (confirmation: string) => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const secret = passphrase;
    setPassphrase("");
    void onUnlock(secret);
  };
  return (
    <VaultAuthFrame state="Locked">
      <section className="vault-card" aria-labelledby="unlock-title">
        <p className="vault-kicker">myCarlos private records</p>
        <h1 id="unlock-title">Unlock your vault</h1>
        <p>
          The vault locks after {autoLockMinutes} minute
          {autoLockMinutes === 1 ? "" : "s"} of inactivity and whenever the app
          is backgrounded.
        </p>
        <form onSubmit={submit}>
          <label>
            Passphrase
            <input
              autoFocus
              required
              maxLength={1024}
              type="password"
              autoComplete="current-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          {notice && <p role="status">{notice}</p>}
          <button className="button primary" disabled={busy}>
            Unlock
          </button>
        </form>
        <details className="vault-reset">
          <summary>Forgot your passphrase?</summary>
          <p>
            There is no recovery code. Reset permanently erases this vault so
            you can start again.
          </p>
          <ResetConfirmation
            busy={busy}
            actionLabel="Erase vault"
            onReset={onReset}
          />
        </details>
      </section>
    </VaultAuthFrame>
  );
}
