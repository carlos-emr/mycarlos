import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import VaultApp from "./VaultApp";
import { startNativeZoom } from "./native/nativeZoom";
import { NativeZoomProvider } from "./native/TextSizeSetting";
import { initLocale } from "./i18n";
import "./styles.css";

// The size kept from last time is applied before anything is shown, so that
// the interface does not open at one size and jump to another. If that
// cannot be done soon, it is shown all the same, and the zoom comes when the
// platform is known (startNativeZoom).
// The page says which language it is in, for screen readers.
initLocale();

const { ready, installed } = startNativeZoom();
void ready.then((native) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <NativeZoomProvider initial={native} installed={installed}>
        <VaultApp />
      </NativeZoomProvider>
    </StrictMode>,
  );
});
