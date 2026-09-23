import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

// Use a non-"localhost" host to exercise the physical-device CSP/HMR path. 127.0.0.2
// is still loopback, so this checks the policy and host wiring, not LAN reachability.
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = await mkdtemp(join(root, ".hmr-test-"));
const previousHost = process.env.TAURI_DEV_HOST;
process.env.TAURI_DEV_HOST = "127.0.0.2";
let server;
let browser;
try {
  const config = JSON.parse(
    await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const policy = config.app.security.devCsp;
  assert.doesNotMatch(
    config.app.security.csp,
    /\bwss?:/i,
    "Production policy must exclude HMR",
  );
  await writeFile(
    join(fixture, "index.html"),
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><p id="marker"></p><script type="module" src="/marker.js"></script>`,
  );
  const marker = (value) => `export const value = ${JSON.stringify(value)};
    document.querySelector('#marker').textContent = value;
    if (import.meta.hot) import.meta.hot.accept((updated) => {
      document.querySelector('#marker').textContent = updated.value;
    });`;
  const source = join(fixture, "marker.js");
  await writeFile(source, marker("before"));
  server = await createServer({
    configFile: join(root, "vite.config.ts"),
    root: fixture,
  });
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage();
  const connected = page.waitForEvent("console", {
    predicate: (message) => message.text().includes("[vite] connected"),
    timeout: 15000,
  });
  await page.goto("http://127.0.0.2:1420");
  await connected;
  await page.waitForFunction(
    () => document.querySelector("#marker")?.textContent === "before",
  );
  await page.evaluate(() => {
    window.hmrSessionMarker = "same-page";
  });
  await writeFile(source, marker("after"));
  await page.waitForFunction(
    () => document.querySelector("#marker")?.textContent === "after",
  );
  assert.equal(
    await page.evaluate(() => window.hmrSessionMarker),
    "same-page",
    "Expected a hot update without page reload",
  );
  console.log(
    "Non-localhost HMR connected under the app's dev CSP and updated without reloading the page",
  );
} finally {
  await browser?.close();
  await server?.close();
  await rm(fixture, { recursive: true, force: true });
  if (previousHost === undefined) delete process.env.TAURI_DEV_HOST;
  else process.env.TAURI_DEV_HOST = previousHost;
}
