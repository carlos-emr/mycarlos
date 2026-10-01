import { defineConfig } from "@playwright/test";

// Attach to the installed WebView2 app. No Vite server or mocked native bridge.
export default defineConfig({
  testDir: "./tests/native-windows",
  outputDir: "test-results/windows-native",
  timeout:
    process.env.MYCARLOS_WINDOWS_DIALOG_TESTS === "1" ? 540_000 : 180_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    [
      "html",
      { outputFolder: "test-results/windows-native-report", open: "never" },
    ],
  ],
});
