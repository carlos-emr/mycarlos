export interface RuntimeInfo {
  platform: string;
  architecture: string;
  appVersion: string;
  message: string;
  native: boolean;
}

export interface SelectedDocument {
  name: string;
  sizeBytes?: number;
}

export interface PlatformBridge {
  getRuntimeInfo(): Promise<RuntimeInfo>;
  selectPdf(): Promise<SelectedDocument | null>;
}

function selectPdfInBrowser(): Promise<SelectedDocument | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.item(0);
        resolve(file ? { name: file.name, sizeBytes: file.size } : null);
      },
      { once: true },
    );
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

// Only the nonpersistent browser preview uses this bridge. The native vault
// imports through VaultBridge and Rust-owned pickers, never renderer file paths.
export function createPlatformBridge(): PlatformBridge {
  return {
    async getRuntimeInfo() {
      return {
        platform: "Browser preview",
        architecture: "web",
        appVersion: "0.1.0",
        message: "Hello from the shared web UI",
        native: false,
      };
    },
    selectPdf: selectPdfInBrowser,
  };
}
