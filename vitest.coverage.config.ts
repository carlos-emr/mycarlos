import { defineConfig, mergeConfig } from "vitest/config";
import componentConfig from "./vitest.config.ts";

export default mergeConfig(
  componentConfig,
  defineConfig({
    test: {
      maxWorkers: 1,
      coverage: {
        enabled: true,
        provider: "v8",
        include: ["src/**/*.{ts,tsx}"],
        exclude: [
          "src/**/*.test.{ts,tsx}",
          "src/test/**",
          "src/**/*.d.ts",
          // Generated key types and runtime lookups, not hand-maintained code.
          "src/i18n/locales/fluent/keys.ts",
        ],
        // A ratchet, never lowered below this (see COVERAGE.md "The floor"). Main at 0d6b6061
        // measured 94.50 / 92.28 / 90.94 / 95.95; Ben set the floor to 80 for every metric on
        // 24 Nov 2026 so that code that is hard to test does not fail CI. A run below any of them
        // fails. scripts/coverage-floor.test.mjs fails if they are lowered below 80 or if
        // automatic updating is switched on.
        thresholds: {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        reportsDirectory: "./coverage/frontend",
        reporter: ["text", "json", "json-summary", "lcov", "html"],
        clean: true,
        reportOnFailure: false,
      },
    },
  }),
);
