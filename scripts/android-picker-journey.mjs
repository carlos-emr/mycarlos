import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  appPackage as app,
  emulatorSerial,
} from "./android-emulator-preflight.mjs";
import {
  foregroundActivity,
  launchFromHome,
  tapDownloadsRoot,
} from "./android-picker-interaction.mjs";

const documentsUi = /.*\.documentsui/;
const serial = emulatorSerial();
const { _android: android, expect } = await import("@playwright/test");
const devices = await android.devices({ host: "127.0.0.1", port: 5037 });
try {
  assert.equal(devices.length, 1, "Use a single fresh Android emulator");
  const [device] = devices;
  assert.equal(device.serial(), serial);
  device.setDefaultTimeout(30_000);
  const page = await (await device.webView({ pkg: app })).page();
  page.setDefaultTimeout(30_000);
  const button = (name) => page.getByRole("button", { name, exact: true });
  const vaultStatus = () =>
    page.evaluate(() => window.__TAURI_INTERNALS__.invoke("vault_status"));
  const native = (selector) => ({ pkg: documentsUi, ...selector });
  const downloads = async () => {
    await device.tap(native({ desc: "Show roots" }));
    await tapDownloadsRoot(device, native({ text: "Downloads" }));
  };

  // Only a first-run app is eligible. Do not unlock or clear an existing vault.
  assert.equal(await vaultStatus(), "absent");
  await expect(
    page.getByRole("heading", { name: "Make myCarlos comfortable for you" }),
  ).toBeVisible();
  const shorter = button("Shorter delay");
  for (let i = 0; i < 15 && (await shorter.isEnabled()); i++)
    await shorter.click();
  await expect(shorter).toBeDisabled();
  await expect(page.locator(".auto-lock-value")).toHaveText(/1\u2069? minute$/);
  await button("Continue").click();
  const passphrase = randomUUID();
  await page
    .getByLabel("Whose records will you keep here?")
    .fill("FAKE Android");
  await page.getByRole("checkbox", { name: "Add them later" }).check();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase", { exact: true }).fill(passphrase);
  await button("Create vault").click();
  await button("Lock vault and finish later").click();
  await button("Discard key and lock").click();
  const lockHeading = page.getByRole("heading", { name: "Unlock your vault" });
  await expect(lockHeading).toBeVisible({ timeout: 30_000 });
  assert.equal(await vaultStatus(), "locked");
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await button("Unlock").click();
  // Unlock reports how the interrupted setup ended before offering another key.
  await expect(
    page.getByText(
      /Recovery key setup ended .*that key does not open the vault/,
    ),
  ).toBeVisible({ timeout: 30_000 });
  assert.equal(await vaultStatus(), "unlocked");
  console.log(
    "PASS Fresh vault locked after recovery setup and unlocked again",
  );

  // Use names unique to this run. DocumentsUI supplies the Downloads document URI.
  const run = randomUUID().slice(0, 8);
  const source = `FAKE-picker-${run}.pdf`;
  const copy = `FAKE-copy-${run}.pdf`;
  const fixture = await readFile(
    new URL("../dev-data/FAKE_Avery_Patient_Bloodwork.pdf", import.meta.url),
  );
  const directory = "/sdcard/Download";
  await device.push(fixture, `${directory}/${source}`);
  try {
    await device.shell(
      `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${directory}/${source}`,
    );
    await button("New").click();
    await downloads();
    const document = native({ text: source });
    await device.wait(document);
    // Real elapsed time in the system activity, with the WebView hidden and the
    // vault's native and renderer idle clocks both running.
    await delay(65_000);
    await device.tap(document);
    const row = button(source);
    await expect(row).toBeVisible({ timeout: 30_000 });
    console.log(
      "PASS Downloads PDF imported under its filename after 65 seconds in the picker",
    );

    await row.click();
    await button("Save a copy to this device").click();
    await button("Save a copy").click();
    await downloads();
    await device.fill(native({ clazz: "android.widget.EditText" }), copy);
    await device.tap(native({ text: /^(Save|SAVE)$/ }));
    // A committed export must match every byte. The input and output are distinct.
    const digest = createHash("sha256").update(fixture).digest("hex");
    await expect
      .poll(
        async () =>
          (await device.shell(`sha256sum ${directory}/${copy}`))
            .toString()
            .split(/\s+/)[0],
        { timeout: 30_000 },
      )
      .toBe(digest);
    console.log(
      "PASS Save a copy wrote the original PDF bytes to the chosen Downloads file",
    );

    const details = page.getByRole("dialog", { name: source, exact: true });
    if (await details.isVisible())
      await details
        .getByRole("button", { name: "Close document details", exact: true })
        .click();
    const foreground = async () =>
      foregroundActivity(await device.shell("dumpsys activity activities"));
    let original;
    await expect
      .poll(async () => (original = await foreground())?.packageName)
      .toBe(app);
    await button("New").click();
    await device.wait(native({ desc: "Show roots" }));
    await device.input.press("Home");
    await expect
      .poll(async () => (await foreground())?.packageName ?? "", {
        timeout: 20_000,
      })
      .toMatch(/launcher/i);
    console.log(await launchFromHome(device, original.component));
    let resumed;
    await expect
      .poll(async () => (resumed = await foreground())?.packageName ?? "", {
        timeout: 20_000,
      })
      .toMatch(/^(?:ca\.carlos\.mycarlos|[\w.]+\.documentsui)$/);
    // Returning to DocumentsUI is still a pending pick. Back from there would
    // exercise foreground cancellation, a different lifecycle from returning
    // to the app after Home. Record the observed branch in the artifact.
    if (resumed.packageName !== app) {
      console.log(
        "PENDING Home restored the system picker; return to the app after background settlement still needs device evidence",
      );
    } else {
      assert.deepEqual(
        resumed,
        original,
        "Home must return to the existing app activity and task",
      );
      await expect(lockHeading).toBeVisible({ timeout: 30_000 });
      assert.equal(await vaultStatus(), "locked");
      await expect(row).toHaveCount(0);
      console.log("PASS Home with the picker open returned to a locked vault");
    }
  } finally {
    await device.shell(`rm -f ${directory}/${source} ${directory}/${copy}`);
  }
} finally {
  await Promise.all(devices.map((device) => device.close()));
}
