import { translate } from "./support/fluent";
import { expect, test, type Page } from "@playwright/test";

// #124 review points: Clinic documents in Security at 360 px, at 100% and
// 200% default text. The native side is faked with one FAKE clinic whose
// device is approved; any command this view should not send fails the test.
async function fakeNative(page: Page, locale: string) {
  await page.addInitScript((locale) => {
    localStorage.setItem("mycarlos.language.v1", locale);
    const link = {
      id: "fake-link",
      portalBase: "https://portal.example.test/patient",
      deviceName: "myCarlos on Windows",
      profileId: null,
      clinicName: "FAKE Riverside Clinic",
      fingerprints: [],
      incomplete: false,
      deviceKeyId: "FAKE_DEVICE_KEY_ID",
      deviceFingerprint: "11".repeat(32),
      approvalRequested: true,
      clinicApproved: true,
      approvalStatus: "accepted",
    };
    const snapshot = {
      profiles: [
        { id: "profile", displayName: "FAKE Patient", createdAtMs: 1 },
      ],
      folders: [],
      records: [],
      recovery: null,
      recoveryKeySetAtMs: 1,
      portalLinkingEnabled: true,
      portalLinks: [link],
    };
    const unexpected: string[] = [];
    Reflect.set(window, "__FAKE_UNEXPECTED__", unexpected);
    Reflect.set(window, "__TAURI_INTERNALS__", {
      invoke: async (command: string) => {
        if (command === "vault_status") return "unlocked";
        if (command === "vault_snapshot") return structuredClone(snapshot);
        if (command === "runtime_info") return { platform: "windows" };
        if (command === "vault_touch" || command === "vault_set_auto_lock")
          return;
        // Files shared to myCarlos are looked for on focus (#49): none.
        if (command === "received_list") return [];
        unexpected.push(command);
        throw new Error(`Unexpected IPC command: ${command}`);
      },
    });
  }, locale);
}

async function openSecurity(page: Page, locale: string) {
  const security = translate(locale, "security.title");
  const picker = page.getByRole("combobox", {
    name: translate(locale, "interface.VaultLibrary.section"),
  });
  const button = page.getByRole("button", { name: new RegExp(`^${security}`) });
  await expect(picker.or(button).first()).toBeVisible();
  if (await picker.isVisible()) await picker.selectOption({ label: security });
  else await button.first().click();
}

const rootSize = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).fontSize);

for (const text of [16, 32])
  test(`gives Clinic documents Security's heading size at 360px with ${text}px default text`, async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "sets its own viewport");
    await page.setViewportSize({ width: 360, height: 900 });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.setFontSizes", { fontSizes: { standard: text } });
    await fakeNative(page, "en");
    await page.goto("/");
    await openSecurity(page, "en");
    const title = page.getByRole("heading", { name: "Clinic documents" });
    await expect(title).toBeVisible();
    expect(await rootSize(page)).toBe(`${text}px`);
    const sizes = await page.evaluate(() => {
      const size = (element: Element | null) =>
        element ? parseFloat(getComputedStyle(element).fontSize) : NaN;
      return {
        clinicDocuments: size(document.getElementById("portal-title")),
        // Another Security section's heading, for comparison.
        encryption: size(document.querySelector(".setting-row h2")),
        clinicName: size(document.querySelector(".portal-link h3")),
      };
    });
    expect(sizes.encryption).toBeGreaterThan(0);
    expect(sizes.clinicDocuments).toBe(sizes.encryption);
    expect(sizes.clinicName).toBeLessThanOrEqual(sizes.clinicDocuments);
    // Nothing in the panel runs past it, and the page does not scroll sideways.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const outside = await page.locator(".portal-documents").evaluate((p) => {
      const box = p.getBoundingClientRect();
      return [...p.querySelectorAll("input, select, button, textarea, h2, h3")]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.left < box.left - 0.5 || r.right > box.right + 0.5;
        })
        .map((e) => e.outerHTML.slice(0, 60));
    });
    expect(outside).toEqual([]);
    // Viewport shots only: a full-page shot resets the default text size.
    await title.evaluate((h) => h.scrollIntoView({ block: "start" }));
    await page.screenshot({
      path: testInfo.outputPath(`clinic-documents-360-${text}.png`),
    });
    await page
      .getByRole("heading", { name: "FAKE Riverside Clinic" })
      .evaluate((h) => h.scrollIntoView({ block: "center" }));
    await page.screenshot({
      path: testInfo.outputPath(`clinic-card-360-${text}.png`),
    });
    expect(await rootSize(page)).toBe(`${text}px`);
    expect(
      await page.evaluate(() => Reflect.get(window, "__FAKE_UNEXPECTED__")),
    ).toEqual([]);
  });

test("offers a device name in the patient's language", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one window size is enough");
  await fakeNative(page, "fr");
  await page.goto("/");
  await openSecurity(page, "fr");
  await expect(
    page.getByLabel(translate("fr", "portal.deviceName")),
  ).toHaveValue("myCarlos sur Windows");
});
