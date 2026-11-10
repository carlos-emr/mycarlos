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
        reportsDirectory: "./coverage/frontend",
        reporter: ["text", "json", "json-summary", "lcov", "html"],
        clean: true,
        reportOnFailure: false,
      },
    },
  }),
);
