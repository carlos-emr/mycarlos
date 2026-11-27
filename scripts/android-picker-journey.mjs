import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { _android as android, expect } from "@playwright/test";

const app = "ca.carlos.mycarlos";
const documentsUi = /.*\.documentsui/;
const devices = await android.devices();
try {
  assert.equal(devices.length, 1, "Use a single fresh Android emulator");
  const [device] = devices;
  assert.match(device.serial(), /^emulator-\d+$/);
  assert.equal(
    (await device.shell("getprop ro.kernel.qemu")).toString().trim(),
    "1",
  );
  device.setDefaultTimeout(30_000);
  const page = await (await device.webView({ pkg: app })).page();
  page.setDefaultTimeout(30_000);
  const button = (name) => page.getByRole("button", { name, exact: true });
  const native = (selector) => ({ pkg: documentsUi, ...selector });
  const downloads = async () => {
    await device.tap(native({ desc: "Show roots" }));
    await device.tap(native({ text: "Downloads" }));
  };

  // Only a first-run app is eligible. Do not unlock or clear an existing vault.
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
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await button("Unlock").click();
  await button("Set up later").click();

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
    await button("New").click();
    await device.wait(native({ desc: "Show roots" }));
    await device.input.press("Home");
    const foreground = async () =>
      (await device.shell("dumpsys activity activities"))
        .toString()
        .split("\n")
        .find((line) => /(?:mResumedActivity|topResumedActivity)/.test(line)) ??
      "";
    await expect.poll(foreground).toMatch(/launcher/i);
    await device.shell(
      `am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${app}`,
    );
    await expect.poll(foreground).toMatch(/ca\.carlos\.mycarlos|\.documentsui/);
    // Launchers can restore the picker task. Return from that picker normally.
    if (/\.documentsui/.test(await foreground()))
      await device.input.press("Back");
    await expect(
      page.getByRole("heading", { name: "Unlock your vault" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveCount(0);
    console.log("PASS Home with the picker open returned to a locked vault");
  } finally {
    await device.shell(`rm -f ${directory}/${source} ${directory}/${copy}`);
  }
} finally {
  await Promise.all(devices.map((device) => device.close()));
}
