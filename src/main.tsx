import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import VaultApp from "./VaultApp";
import { startNativeZoom } from "./native/nativeZoom";
import "./styles.css";

startNativeZoom();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VaultApp />
  </StrictMode>,
);
