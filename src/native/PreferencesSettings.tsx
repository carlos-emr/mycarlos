import { TextSizeSetting, useNativeZoom } from "./TextSizeSetting";

/** Settings > Preferences: how myCarlos looks on this computer. Nothing here
 * is kept in the vault. */
export function PreferencesSettings() {
  const native = useNativeZoom();
  return (
    <main className="library-main purpose-screen">
      <div className="main-head">
        <div>
          <h1>Preferences</h1>
          <p>How myCarlos looks on this computer</p>
        </div>
      </div>
      <div className="setting-list">
        {native ? (
          <TextSizeSetting zoom={native.zoom} mac={native.mac} />
        ) : (
          <section className="setting-row">
            <div>
              <h2>Text size</h2>
              <p>
                Text size can't be changed in this window. Use your browser's
                zoom instead.
              </p>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
