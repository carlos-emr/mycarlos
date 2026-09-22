import { useState, type FormEvent } from "react";
import { Icon } from "../Icon";
import { MAX_PASSPHRASE_BYTES, utf8Length } from "../vault";
import { AUTO_LOCK_OPTIONS } from "./autoLock";
import { NAME_INPUT_MAX_LENGTH, nameTooLong } from "./recordPresentation";
import {
  MIN_PASSPHRASE_CHARS,
  ResetConfirmation,
  tooShortPassphrase,
} from "./VaultAuth";

interface SecuritySettingsProps {
  busy: boolean;
  readOnly: boolean;
  notice: string;
  autoLockMinutes: number;
  onAutoLockMinutes: (value: unknown) => void;
  onLock: () => Promise<void>;
  onChangePassphrase: (current: string, replacement: string) => Promise<void>;
  onCreateProfile: (name: string) => Promise<boolean>;
  onReset: (confirmation: string) => Promise<void>;
}

export function SecuritySettings({
  busy,
  readOnly,
  notice,
  autoLockMinutes,
  onAutoLockMinutes,
  onLock,
  onChangePassphrase,
  onCreateProfile,
  onReset,
}: SecuritySettingsProps) {
  const [profileName, setProfileName] = useState("");
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
    void onCreateProfile(profileName).then((created) => {
      if (created) setProfileName("");
    });
  };
  return (
    <main className="library-main purpose-screen">
      <div className="main-head">
        <div>
          <h1>Security</h1>
          <p>Your encrypted vault and access settings</p>
        </div>
      </div>
      <div className="purpose-note warning">
        <Icon name="info" />
        <span>
          <strong>Development build.</strong> Use synthetic files only. Recovery
          and backup are not implemented.
        </span>
      </div>
      <p className="status-line" role="status" aria-live="polite">
        {notice}
      </p>
      <div className="setting-list">
        <section className="setting-row">
          <div>
            <h2>
              Encryption <span className="state-pill">On — always</span>
            </h2>
            <p>
              Files, names, folders, and record details are encrypted on this
              device.
            </p>
          </div>
        </section>
        <section className="setting-row native-setting-form">
          <div>
            <h2>
              Lock automatically{" "}
              <span className="state-pill">
                {autoLockMinutes} minute{autoLockMinutes === 1 ? "" : "s"}
              </span>
            </h2>
            <p>
              The vault locks after the selected period without keyboard,
              pointer, or touch activity. This non-medical setting is clamped to
              1–15 minutes.
            </p>
          </div>
          <div>
            <label>
              Automatic lock delay
              <select
                value={autoLockMinutes}
                onChange={(event) => onAutoLockMinutes(event.target.value)}
              >
                {AUTO_LOCK_OPTIONS.map((minutes) => (
                  <option value={minutes} key={minutes}>
                    {minutes} minute{minutes === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button"
              type="button"
              onClick={() => void onLock()}
            >
              Lock now
            </button>
          </div>
        </section>
        <section className="setting-row native-setting-form">
          <div>
            <h2>Change passphrase</h2>
            <p>
              Use at least {MIN_PASSPHRASE_CHARS} characters and avoid common
              names or predictable phrases. Until recovery kits are implemented,
              forgetting the new passphrase permanently loses access.
            </p>
          </div>
          <form onSubmit={submitPassphrase}>
            <label>
              Current passphrase
              <input
                required
                maxLength={1024}
                type="password"
                autoComplete="current-password"
                value={currentPassphrase}
                onChange={(event) => setCurrentPassphrase(event.target.value)}
              />
            </label>
            <label>
              New passphrase
              <input
                required
                maxLength={1024}
                type="password"
                autoComplete="new-password"
                value={newPassphrase}
                onChange={(event) => setNewPassphrase(event.target.value)}
              />
            </label>
            <label>
              Confirm new passphrase
              <input
                required
                maxLength={1024}
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
                The current passphrase is longer than any vault passphrase.
                Check what you typed.
              </p>
            )}
            {newPassphraseConfirmation &&
              newPassphrase !== newPassphraseConfirmation && (
                <p role="alert">New passphrases do not match.</p>
              )}
            {newPassphraseTooLong && (
              <p role="alert">The new passphrase is too long. Shorten it.</p>
            )}
            {newPassphraseTooShort && newPassphraseConfirmation && (
              <p role="alert">
                The new passphrase is too short. Use at least{" "}
                {MIN_PASSPHRASE_CHARS} characters.
              </p>
            )}
            <button
              className="button"
              disabled={busy || readOnly || passphraseFormInvalid}
            >
              Change passphrase
            </button>
          </form>
        </section>
        <section className="setting-row">
          <div>
            <h2>Readable copies and screenshots</h2>
            <p>
              Exports and screenshots leave vault protection. Deleting a record
              from myCarlos cannot erase those copies or the clinic's source
              medical record.
            </p>
          </div>
        </section>
        <section className="setting-row native-setting-form">
          <div>
            <h2>Patient profiles</h2>
            <p>Keep each person’s filing cabinet separate inside this vault.</p>
          </div>
          <form onSubmit={submitProfile}>
            <label>
              New profile name
              <input
                required
                maxLength={NAME_INPUT_MAX_LENGTH}
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
              />
            </label>
            {nameTooLong(profileName) && (
              <p role="alert">This name is too long. Shorten it.</p>
            )}
            <button
              className="button"
              disabled={busy || readOnly || nameTooLong(profileName)}
            >
              Add profile
            </button>
          </form>
        </section>
        <section className="setting-row native-danger-setting">
          <div>
            <h2>Erase entire vault</h2>
            <p>
              Permanently deletes every encrypted document, profile, and folder.
              This cannot be undone.
            </p>
          </div>
          <details>
            <summary>Show reset controls</summary>
            <ResetConfirmation
              busy={busy}
              actionLabel="Erase entire vault"
              onReset={onReset}
            />
          </details>
        </section>
      </div>
    </main>
  );
}
