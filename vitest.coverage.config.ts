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
        // A ratchet, never lowered (see COVERAGE.md "The floor"). Main at 0d6b6061 measured
        // 94.50 / 92.28 / 90.94 / 95.95; the first floor is one whole percent below those rounded
        // down, so work already in flight is not failed by a fraction of a point. A run below any of
        // them fails. Raise them as coverage rises; scripts/coverage-floor.test.mjs fails if they
        // are lowered or if automatic updating is switched on.
        thresholds: {
          statements: 93,
          branches: 91,
          functions: 89,
          lines: 94,
        },
        reportsDirectory: "./coverage/frontend",
        reporter: ["text", "json", "json-summary", "lcov", "html"],
        clean: true,
        reportOnFailure: false,
      },
    },
  }),
);
