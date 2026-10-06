import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import VaultApp from "./VaultApp";
import { startNativeZoom } from "./native/nativeZoom";
import { NativeZoomBar } from "./native/ZoomBar";
import "./styles.css";

// The size kept from last time is applied before anything is shown, so that
// the interface does not open at one size and jump to another. If that
// cannot be done soon, it is shown all the same, and the zoom comes when the
// platform is known (startNativeZoom).
const { ready, installed } = startNativeZoom();
void ready.then((native) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <NativeZoomBar initial={native} installed={installed} />
      <VaultApp />
    </StrictMode>,
  );
});
