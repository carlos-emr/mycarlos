import { translate } from "./support/fluent";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// #145: once a clinic is linked, Clinic documents shows the clinics first and
// keeps the link form behind "Link another clinic", in a dialog. The native
// side is faked with one FAKE clinic whose device is approved, so no
// automatic approval check runs; any command this view should not send fails
// the test.
async function fakeNative(page: Page, linked: boolean, locale = "en") {
  await page.addInitScript(
    ({ linked, locale }) => {
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
        portalLinks: linked ? [link] : [],
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
          if (command === "vault_check_documents")
            return { added: 0, refused: 0, receiptsPending: 0 };
          // Files shared to myCarlos are looked for on focus (#49): none.
          if (command === "received_list") return [];
          unexpected.push(command);
          throw new Error(`Unexpected IPC command: ${command}`);
        },
      });
    },
    { linked, locale },
  );
}

async function openSecurity(page: Page, locale = "en") {
  const security = translate(locale, "security.title");
  const picker = page.getByRole("combobox", {
    name: translate(locale, "interface.VaultLibrary.section"),
  });
  const button = page.getByRole("button", { name: new RegExp(`^${security}`) });
  await expect(picker.or(button).first()).toBeVisible();
  if (await picker.isVisible()) await picker.selectOption({ label: security });
  else await button.first().click();
}

const scan = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

const fitsWindow = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );

for (const width of [1280, 360])
  test(`links another clinic from a dialog at ${width}px with 200% default text`, async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "sets its own viewport");
    await page.setViewportSize({ width, height: 900 });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32 } });
    await fakeNative(page, true);
    await page.goto("/");
    await openSecurity(page);
    const heading = page.getByRole("heading", {
      name: "FAKE Riverside Clinic",
    });
    await expect(heading).toBeVisible();
    // The clinic comes first; the form is not on the panel.
    await expect(page.getByLabel("Portal HTTPS address")).toHaveCount(0);
    const linkAnother = page.getByRole("button", {
      name: "Link another clinic",
    });
    await expect(linkAnother).toBeVisible();
    expect(
      await heading.evaluate(
        (h, b) =>
          Boolean(
            b &&
              h.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        await linkAnother.elementHandle(),
      ),
    ).toBe(true);
    await expect(
      page.getByRole("button", { name: "Check for new documents" }).first(),
    ).toBeVisible();
    expect(await fitsWindow(page)).toBe(true);
    await linkAnother.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`after-panel-${width}.png`),
      fullPage: true,
    });

    // Keyboard: open it, focus is in the address, Escape gives focus back.
    await linkAnother.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Link another clinic" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Portal HTTPS address")).toBeFocused();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await page.screenshot({
      path: testInfo.outputPath(`after-dialog-top-${width}.png`),
    });
    expect(await fitsWindow(page)).toBe(true);
    // Nothing in the dialog runs past it sideways, and its title is whole.
    expect(
      await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1),
    ).toBe(true);
    expect(
      await dialog
        .getByRole("heading", { name: "Link another clinic" })
        .evaluate((h) => h.scrollWidth <= h.clientWidth + 1),
    ).toBe(true);
    for (const field of await dialog.locator("input, select").all()) {
      const f = await field.boundingBox();
      const d = await dialog.boundingBox();
      expect(f!.x).toBeGreaterThanOrEqual(d!.x - 0.5);
      expect(f!.x + f!.width).toBeLessThanOrEqual(d!.x + d!.width + 0.5);
    }
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
    // Its buttons stay reachable: in the window once scrolled to.
    const send = dialog.getByRole("button", {
      name: "Connect and request approval",
    });
    await send.scrollIntoViewIfNeeded();
    await expect(send).toBeInViewport();
    expect((await scan(page)).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`after-dialog-${width}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(linkAnother).toBeFocused();
    expect(
      await page.evaluate(() => Reflect.get(window, "__FAKE_UNEXPECTED__")),
    ).toEqual([]);
  });

test("keeps the link form on the panel before any clinic is linked", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one window size is enough");
  await fakeNative(page, false);
  await page.goto("/");
  await openSecurity(page);
  await expect(page.getByLabel("Portal HTTPS address")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Link another clinic" }),
  ).toHaveCount(0);
});

test("opens Link another clinic in another language at 360px", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "sets its own viewport");
  await page.setViewportSize({ width: 360, height: 900 });
  for (const locale of ["fr", "zh-CN"]) {
    await fakeNative(page, true, locale);
    await page.goto("/");
    await openSecurity(page, locale);
    const name = translate(locale, "portal.linkAnother");
    await page.getByRole("button", { name }).click();
    const dialog = page.getByRole("dialog", { name });
    await expect(dialog).toBeVisible();
    expect(await fitsWindow(page)).toBe(true);
    expect(
      await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`after-dialog-360-${locale}.png`),
    });
  }
});
