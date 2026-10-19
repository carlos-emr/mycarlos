import { AutoLockSetting } from "./AutoLockSetting";
import { DEFAULT_AUTO_LOCK_MINUTES } from "./autoLock";
import { TextSizeSetting, useNativeZoom } from "./TextSizeSetting";
import { VaultAuthFrame } from "./VaultAuth";

/**
 * First setup's first screen (#69): the choices that make the rest of setup
 * easier to read and use, before the passphrase. Each applies at once and is
 * kept on this device, outside the vault, as in Settings: they are needed
 * before unlocking and are not private.
 */
export function ComfortSetup({
  autoLockMinutes,
  onAutoLockMinutes,
  onDone,
}: {
  autoLockMinutes: number;
  onAutoLockMinutes: (minutes: number) => void;
  onDone: () => void;
}) {
  const native = useNativeZoom();
  return (
    <VaultAuthFrame state="Setting up">
      <section
        className="vault-card comfort-setup"
        aria-labelledby="comfort-title"
      >
        <p className="vault-kicker">myCarlos private records</p>
        <h1 id="comfort-title">Make myCarlos comfortable for you</h1>
        <p>
          Choose what suits you before you set up. Each choice works at once.
        </p>
        {/* Language (#46) comes first here once it is in. */}
        <div className="setting-list comfort-list">
          {native ? (
            <>
              <TextSizeSetting zoom={native.zoom} mac={native.mac} />
              <p className="comfort-sample">
                This is how text looks in myCarlos. Press − or + until it is
                easy to read.
              </p>
            </>
          ) : (
            <section className="setting-row">
              <div>
                <h2>Text size</h2>
                <p>
                  Here, text size follows your device: its own text size
                  setting, or the browser's zoom.
                </p>
              </div>
            </section>
          )}
          {/* Appearance (#47 / PR #60) goes here once it is in. */}
          <section className="setting-row native-setting-form">
            <div>
              <h2>Lock automatically</h2>
              <p>
                myCarlos locks itself when it has not been used for this long,
                so that nobody else can see your records. Choose from 1 to 15
                minutes.
              </p>
            </div>
            <div>
              <AutoLockSetting
                minutes={autoLockMinutes}
                onMinutes={onAutoLockMinutes}
              />
            </div>
          </section>
        </div>
        <p>
          You can change these any time in Settings: Text size under
          Preferences, and Lock automatically under Security.
        </p>
        <div className="comfort-actions">
          <button className="button primary" type="button" onClick={onDone}>
            Continue
          </button>
          <button
            className="button"
            type="button"
            onClick={() => {
              native?.zoom.request("reset");
              onAutoLockMinutes(DEFAULT_AUTO_LOCK_MINUTES);
              onDone();
            }}
          >
            Use the usual settings
          </button>
        </div>
      </section>
    </VaultAuthFrame>
  );
}
