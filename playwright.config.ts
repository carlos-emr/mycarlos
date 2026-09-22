import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: "test-results",
  timeout: 90_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    // Build first so a newly started preview never serves a missing or stale dist/.
    command: "npm run build && npm run preview -- --host 127.0.0.1",
    port: 4173,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "phone",
      use: { ...devices["Pixel 7"] },
    },
  ],
});
