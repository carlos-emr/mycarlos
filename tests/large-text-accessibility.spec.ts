import {
  expect,
  test,
  type Browser,
  type Page,
  type TestInfo,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// WCAG 2.0, 2.1 and 2.2 A and AA, as in smoke.spec.ts.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoViolations(page: Page, where: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations, where).toEqual([]);
}

// Large text can change the layout: the narrow layout swaps the side buttons for a Section menu.
async function openSection(page: Page, value: string, label: string) {
  const menu = page.getByRole("combobox", { name: "Section" });
  if (await menu.isVisible()) await menu.selectOption(value);
  else
    await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
}

/** How a walk gets a page at 200% text size, and how it tells that the size took effect. */
interface LargeText {
  newPage: () => Promise<Page>;
  check: (page: Page) => Promise<void>;
}

/**
 * The app's Text size (Settings > Preferences) zooms the whole webview, which a browser shows as page
 * zoom: at 200% the page lays out in half the CSS width and height, drawn with twice the pixels. Only
 * desktops have it: a phone scales text by its own settings (nativeZoom.ts), which the reader's default
 * text tests cover.
 */
async function withAppTextSize200(
  browser: Browser,
  testInfo: TestInfo,
  walk: (large: LargeText) => Promise<void>,
) {
  test.skip(
    testInfo.project.name === "phone",
    "a phone scales text by its own settings (nativeZoom.ts); the reader's default text tests cover it",
  );
  const use = testInfo.project.use;
  const viewport = use.viewport ?? { width: 1280, height: 720 };
  const scale = use.deviceScaleFactor ?? 1;
  const context = await browser.newContext({
    baseURL: use.baseURL,
    userAgent: use.userAgent,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    viewport: {
      width: Math.round(viewport.width / 2),
      height: Math.round(viewport.height / 2),
    },
    deviceScaleFactor: scale * 2,
  });
  try {
    await walk({
      newPage: () => context.newPage(),
      check: async (page) =>
        expect(await page.evaluate(() => window.devicePixelRatio)).toBe(
          scale * 2,
        ),
    });
  } finally {
    await context.close();
  }
}

/** A reader's larger default text (the browser's, or the phone's text size): 32px instead of 16px. */
async function withReaderText200(
  page: Page,
  walk: (large: LargeText) => Promise<void>,
) {
  const context = page.context();
  await walk({
    newPage: async () => {
      const fresh = await context.newPage();
      const cdp = await context.newCDPSession(fresh);
      await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32 } });
      return fresh;
    },
    check: async (shown) =>
      expect(
        await shown.evaluate(
          () => getComputedStyle(document.documentElement).fontSize,
        ),
      ).toBe("32px"),
  });
}

// The browser preview (sample data, no vault): the screens smoke.spec.ts checks.
async function walkThePreview(large: LargeText) {
  const page = await large.newPage();
  await page.goto("/");
  await large.check(page);
  await expectNoViolations(page, "library");
  await openSection(page, "security", "Security & backup");
  await expectNoViolations(page, "Security & backup");
  await openSection(page, "health", "Health data");
  await expectNoViolations(page, "Health data");
  await openSection(page, "records", "My records");
  await page
    .getByRole("button", {
      name: "More options for Prescription — ramipril 5mg",
    })
    .click();
  await expectNoViolations(page, "a record's More options menu");
}

/**
 * The native vault screens a patient uses, through a mock of the Tauri bridge (as native-rename.spec.ts
 * does): a vault that exists and is locked, or none yet. The vault has a recovery key, so unlocking does
 * not open the key-setup offer. Any other command fails the test.
 */
async function mockNativeVault(page: Page, status: "absent" | "locked") {
  await page.addInitScript((initialStatus) => {
    let current = initialStatus;
    const snapshot = {
      profiles: [
        { id: "profile", displayName: "FAKE Patient", createdAtMs: 1 },
      ],
      folders: [
        {
          id: "folder",
          profileId: "profile",
          parentId: null,
          name: "FAKE Results",
          createdAtMs: 1,
        },
      ],
      records: [
        {
          id: "record",
          profileId: "profile",
          folderIds: ["folder"],
          displayName: "FAKE Bloodwork.pdf",
          sourceLabel: "Manual import — unverified",
          mediaType: "application/pdf",
          plaintextSize: 2048,
          importedAtMs: 1,
          available: true,
        },
        {
          id: "letter",
          profileId: "profile",
          folderIds: [],
          displayName: "FAKE Letter.pdf",
          sourceLabel: "Manual import — unverified",
          mediaType: "application/pdf",
          plaintextSize: 1024,
          importedAtMs: 2,
          available: true,
        },
      ],
      recovery: null,
      recoveryKeySetAtMs: 1,
      recoveryKeyLabel: "FAKE-KEY1",
    };
    Reflect.set(window, "__TAURI_INTERNALS__", {
      invoke: async (command: string) => {
        if (command === "vault_status") return current;
        if (command === "vault_unlock") {
          current = "unlocked";
          return structuredClone(snapshot);
        }
        if (command === "vault_snapshot") return structuredClone(snapshot);
        if (command === "runtime_info") return { platform: "windows" };
        if (command === "vault_recovery_key_label")
          return snapshot.recoveryKeyLabel;
        if (command === "vault_touch" || command === "vault_set_auto_lock")
          return;
        // The Text size setting asks the webview to zoom; the page zoom here stands in for it.
        if (command.startsWith("plugin:webview|")) return;
        throw new Error(`Unexpected IPC command: ${command}`);
      },
    });
  }, status);
}

async function walkTheVault(large: LargeText) {
  const create = await large.newPage();
  await mockNativeVault(create, "absent");
  await create.goto("/");
  await large.check(create);
  await expect(
    create.getByRole("heading", { name: "Create your encrypted vault" }),
  ).toBeVisible();
  await expectNoViolations(create, "create the vault");
  await create.close();

  const page = await large.newPage();
  await mockNativeVault(page, "locked");
  await page.goto("/");
  await large.check(page);
  await expect(
    page.getByRole("heading", { name: "Unlock your vault" }),
  ).toBeVisible();
  await expectNoViolations(page, "unlock");
  await page
    .getByLabel("Passphrase", { exact: true })
    .fill("FAKE passphrase for the mock");
  await page.getByRole("button", { name: "Unlock" }).click();
  const letter = page.getByRole("article", {
    name: "FAKE Letter.pdf document",
  });
  await expect(letter).toBeVisible();
  await expectNoViolations(page, "library");

  await letter
    .getByRole("button", { name: "FAKE Letter.pdf", exact: true })
    .click();
  const details = page.getByRole("dialog", { name: "FAKE Letter.pdf" });
  await expect(details).toBeVisible();
  await expectNoViolations(page, "document details");
  await page.getByRole("button", { name: "Close document details" }).click();
  await expect(details).toBeHidden();

  await openSection(page, "security", "Security");
  await expect(page.getByRole("heading", { name: "Security" })).toBeVisible();
  await expectNoViolations(page, "Security");
  await openSection(page, "preferences", "Preferences");
  await expect(
    page.getByRole("heading", { name: "Preferences" }),
  ).toBeVisible();
  await expectNoViolations(page, "Preferences");
}

test("has no automatically detectable WCAG violations with the app's text size at 200%", async ({
  browser,
}, testInfo) => {
  await withAppTextSize200(browser, testInfo, walkThePreview);
});

test("has no automatically detectable WCAG violations with the reader's default text at 200%", async ({
  page,
}) => {
  await withReaderText200(page, walkThePreview);
});

test("has no automatically detectable WCAG violations on the vault screens with the app's text size at 200%", async ({
  browser,
}, testInfo) => {
  await withAppTextSize200(browser, testInfo, walkTheVault);
});

test("has no automatically detectable WCAG violations on the vault screens with the reader's default text at 200%", async ({
  page,
}) => {
  await withReaderText200(page, walkTheVault);
});
