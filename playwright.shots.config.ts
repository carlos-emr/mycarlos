// Screenshot runs only (never committed): one Chromium, port 4194.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: process.env.SHOTS_SPEC ?? "zz-shots-*.spec.ts",
  outputDir: "test-results-shots",
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:4194", screenshot: "off", trace: "off" },
  webServer: {
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 4194 --strictPort",
    port: 4194,
    timeout: 300_000,
    reuseExistingServer: false,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "narrow", use: { ...devices["Desktop Chrome"], viewport: { width: 560, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
