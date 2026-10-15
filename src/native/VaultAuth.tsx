import { SecretInput } from "./SecretInput";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Icon } from "../Icon";
import { useI18n } from "../i18n";
import type { MessageKey } from "../i18n";
import { MAX_PASSPHRASE_BYTES, utf8Length } from "../vault";
import { NAME_INPUT_MAX_LENGTH, nameTooLong } from "./recordPresentation";
import { RestoreBackup } from "./RestoreBackup";
import type { VaultBridge } from "../vault";

/** What restoring a backup needs from the bridge. */
export type RestoreBridge = Pick<
  VaultBridge,
  "pickRestoreSource" | "inspectRestore" | "restore"
>;

// The vault counts a new passphrase's characters (Unicode code points) after
// NFC normalization, so the same visible text is judged alike from any keyboard.
export const MIN_PASSPHRASE_CHARS = 15;
export const tooShortPassphrase = (value: string) =>
  [...value.normalize("NFC")].length < MIN_PASSPHRASE_CHARS;

const FRAME_STATES = {
  Locked: "frame.state.locked",
  Locking: "frame.state.locking",
  "Not locked": "frame.state.notLocked",
  "Setting up": "frame.state.settingUp",
  Opening: "frame.state.opening",
} as const satisfies Record<string, MessageKey>;

export function VaultAuthFrame({
  state,
  children,
}: {
  state: keyof typeof FRAME_STATES;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="evaluation-page native-vault-page">
      <div className="evaluation-banner" role="note">
        <strong>{t("frame.banner.title")}</strong>
        <span>{t("frame.banner.body")}</span>
      </div>
      <div className="page-wrap native-auth-wrap">
        <section
          className="app-window native-auth-window"
          aria-label={t("frame.window.label")}
        >
          <header className="titlebar">
            <span className="window-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="window-title">myCarlos</span>
            <span className="native-auth-state">
              <Icon name="shield" /> {t(FRAME_STATES[state])}
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
  const { t } = useI18n();
  const [resetText, setResetText] = useState("");
  return (
    <>
      <label>
        {t("reset.type", { phrase: RESET_CONFIRMATION })}
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
  restoreBridge,
  onRestored,
}: {
  busy: boolean;
  notice: string;
  onCreate: (profile: string, passphrase: string) => Promise<void>;
  restoreBridge: RestoreBridge;
  onRestored: () => void;
}) {
  const { t } = useI18n();
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
        <p className="vault-kicker">{t("auth.kicker")}</p>
        <h1 id="create-title">{t("create.title")}</h1>
        <p>{t("create.intro")}</p>
        <p>{t("create.stays")}</p>
        <form onSubmit={submit}>
          <label>
            {t("create.profile.label")}
            <input
              required
              maxLength={NAME_INPUT_MAX_LENGTH}
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
            />
          </label>
          {profileTooLong && <p role="alert">{t("create.profile.tooLong")}</p>}
          <label>
            {t("passphrase.label")}
            <SecretInput
              aria-label={t("passphrase.label")}
              required
              type="password"
              autoComplete="new-password"
              aria-describedby="passphrase-rules"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          <small id="passphrase-rules">
            {t("passphrase.rules", { min: MIN_PASSPHRASE_CHARS })}
          </small>
          <label>
            {t("passphrase.confirm.label")}
            <SecretInput
              aria-label={t("passphrase.confirm.label")}
              required
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
          {confirmation && passphrase !== confirmation && (
            <p role="alert">{t("passphrase.mismatch")}</p>
          )}
          {tooLong && <p role="alert">{t("passphrase.tooLong")}</p>}
          {tooShort && confirmation && (
            <p role="alert">
              {t("passphrase.tooShort", { min: MIN_PASSPHRASE_CHARS })}
            </p>
          )}
          <AuthNotice notice={notice} />
          <button className="button primary" disabled={busy || invalid}>
            {t("create.submit")}
          </button>
        </form>
        <details className="vault-reset">
          <summary>{t("restore.summary")}</summary>
          <RestoreBackup bridge={restoreBridge} onRestored={onRestored} />
        </details>
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
  restoreBridge,
  onRestored,
}: {
  busy: boolean;
  notice: string;
  autoLockMinutes: number;
  onUnlock: (passphrase: string) => Promise<void>;
  onRecover: (recoveryKey: string, newPassphrase: string) => Promise<void>;
  onReset: (confirmation: string) => Promise<void>;
  restoreBridge: RestoreBridge;
  onRestored: () => void;
}) {
  const { t } = useI18n();
  const [passphrase, setPassphrase] = useState("");
  // Messages go next to the part of the screen they answer: the Unlock form,
  // or the recovery key and erase controls under "Forgot your passphrase?".
  const [source, setSource] = useState<"unlock" | "forgot">("unlock");
  const passphraseRef = useRef<HTMLInputElement | null>(null);
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
        <p className="vault-kicker">{t("auth.kicker")}</p>
        <h1 id="unlock-title">{t("unlock.title")}</h1>
        <p>{t("unlock.autoLock", { count: autoLockMinutes })}</p>
        <form onSubmit={submit}>
          <label>
            {t("passphrase.label")}
            <SecretInput
              aria-label={t("passphrase.label")}
              ref={passphraseRef}
              autoFocus
              required
              type="password"
              autoComplete="current-password"
              aria-describedby={unlockNotice ? AUTH_NOTICE_ID : undefined}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          {tooLong && <p role="alert">{t("passphrase.longerThanAny")}</p>}
          <AuthNotice notice={unlockNotice} />
          <button className="button primary" disabled={busy || tooLong}>
            {t("unlock.submit")}
          </button>
        </form>
        <details className="vault-reset">
          <summary>{t("unlock.forgot.summary")}</summary>
          <RecoverWithKey
            busy={busy}
            notice={source === "forgot" ? notice : ""}
            onRecover={(recoveryKey, newPassphrase) => {
              setSource("forgot");
              return onRecover(recoveryKey, newPassphrase);
            }}
          />
          <h2 className="vault-reset-heading">{t("unlock.noKey.heading")}</h2>
          <p>{t("unlock.noKey.body")}</p>
          <ResetConfirmation
            busy={busy}
            actionLabel={t("reset.submit")}
            onReset={(confirmation) => {
              setSource("forgot");
              return onReset(confirmation);
            }}
          />
        </details>
        <details className="vault-reset">
          <summary>{t("restore.summary")}</summary>
          <RestoreBackup
            bridge={restoreBridge}
            onRestored={() => {
              // Its message belongs by the Passphrase field, which is next,
              // and the button that had focus is gone.
              setSource("unlock");
              onRestored();
              passphraseRef.current?.focus();
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
  const { t } = useI18n();
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
      <p>{t("recover.intro")}</p>
      <label>
        {t("recover.key.label")}
        <SecretInput
          aria-label={t("recover.key.label")}
          required
          type={shown ? "text" : "password"}
          secretKind="recovery key"
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
      <small id="recover-key-format">{t("recover.key.format")}</small>
      <button
        className="button"
        type="button"
        aria-pressed={shown}
        onClick={() => setShown((current) => !current)}
      >
        {t("recover.key.show")}
      </button>
      <label>
        {t("passphrase.new.label")}
        <SecretInput
          aria-label={t("passphrase.new.label")}
          required
          type="password"
          autoComplete="new-password"
          aria-describedby="recover-passphrase-rules"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
        />
      </label>
      <small id="recover-passphrase-rules">
        {t("passphrase.rules", { min: MIN_PASSPHRASE_CHARS })}
      </small>
      <label>
        {t("passphrase.confirmNew.label")}
        <SecretInput
          aria-label={t("passphrase.confirmNew.label")}
          required
          type="password"
          autoComplete="new-password"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
        />
      </label>
      {confirmation && passphrase !== confirmation && (
        <p role="alert">{t("passphrase.mismatch")}</p>
      )}
      {tooLong && <p role="alert">{t("passphrase.tooLong")}</p>}
      {tooShort && confirmation && (
        <p role="alert">
          {t("passphrase.tooShort", { min: MIN_PASSPHRASE_CHARS })}
        </p>
      )}
      <AuthNotice id="recover-notice" notice={notice} />
      <button className="button primary" disabled={busy || invalid}>
        {t("recover.submit")}
      </button>
    </form>
  );
}
