import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// The version and commit this build was made from, for the Open-source notices source offer
// (AGPL section 13 names "this version"). The commit is empty where there is no git checkout.
const version: string = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;
let commit = "";
try {
  commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  commit = "";
}

export default defineConfig({
  plugins: [react()],
  define: {
    __MYCARLOS_VERSION__: JSON.stringify(version),
    __MYCARLOS_COMMIT__: JSON.stringify(commit),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: {
      protocol: "ws",
      host: host || "localhost",
      port: 1421,
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
