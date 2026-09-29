import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import VaultApp from "./VaultApp";
import { startNativeZoom } from "./native/nativeZoom";
import { ZoomBar } from "./native/ZoomBar";
import "./styles.css";

// The size kept from last time is applied before anything is shown, so that
// the interface does not open at one size and jump to another.
void startNativeZoom().then((native) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {native && <ZoomBar zoom={native.zoom} mac={native.mac} />}
      <VaultApp />
    </StrictMode>,
  );
});
