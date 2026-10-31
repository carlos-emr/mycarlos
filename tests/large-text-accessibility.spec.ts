import { translate } from "./support/fluent";
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

async function expectNoViolations(page: Page, where: string, cutOff = true) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations, where).toEqual([]);
  // What axe can't see at 200%: the page scrolling sideways (1.4.10), and
  // words or controls cut off (1.4.4), as targetSize.test.tsx measures them.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    `${where}: scrolls sideways`,
  ).toBe(true);
  if (cutOff)
    expect(await cutOffControls(page), `${where}: cut off`).toEqual([]);
}

/** Visible controls whose words spill out of them or are cut short inside
 * them, or that a box hiding its overflow cuts off. Words kept for screen
 * readers only (clipped) are cut on purpose. */
function cutOffControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const describe = (control: HTMLElement) =>
      `${control.tagName.toLowerCase()} "${(control.getAttribute("aria-label") ?? control.textContent ?? "").trim().slice(0, 40)}"`;
    const visuallyHidden = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return style.clip !== "auto" || style.clipPath !== "none";
    };
    const controls = Array.from(
      document.body.querySelectorAll<HTMLElement>(
        "button, a[href], input, select, textarea, summary",
      ),
    ).filter((control) => control.checkVisibility());
    for (const control of controls) {
      if (visuallyHidden(control)) continue;
      if (
        !control.matches("input, select, textarea") &&
        (control.scrollWidth > control.clientWidth + 1 ||
          control.scrollHeight > control.clientHeight + 1)
      ) {
        found.push(`${describe(control)} overflows its own box`);
        continue;
      }
      const cut = Array.from(control.querySelectorAll<HTMLElement>("*")).find(
        (inner) =>
          inner.checkVisibility() &&
          !visuallyHidden(inner) &&
          inner.scrollWidth > inner.clientWidth + 1,
      );
      if (cut) {
        found.push(
          `${describe(control)} cuts off "${cut.textContent!.trim()}"`,
        );
        continue;
      }
      const box = control.getBoundingClientRect();
      for (
        let inner: HTMLElement = control, outer = control.parentElement;
        outer && getComputedStyle(inner).position !== "fixed";
        inner = outer, outer = outer.parentElement
      ) {
        const style = getComputedStyle(outer);
        const hides = (overflow: string) =>
          overflow === "hidden" || overflow === "clip";
        const edge = outer.getBoundingClientRect();
        if (
          (hides(style.overflowX) &&
            (box.left < edge.left - 1 || box.right > edge.right + 1)) ||
          (hides(style.overflowY) &&
            (box.top < edge.top - 1 || box.bottom > edge.bottom + 1))
        ) {
          found.push(`${describe(control)} cut off by .${outer.className}`);
          break;
        }
      }
    }
    return found;
  });
}

// Large text can change the layout: the narrow layout swaps the side buttons for a Section menu.
async function openSection(page: Page, value: string, label: string) {
  const menu = page.getByRole("combobox", { name: "Section" });
  const button = page.getByRole("button", { name: new RegExp(`^${label}`) });
  // Wait for one of them first: isVisible() doesn't wait.
  await expect(menu.or(button).first()).toBeVisible();
  if (await menu.isVisible()) await menu.selectOption(value);
  else await button.first().click();
}

/** How a walk gets a page at 200% text size, and how it tells that the size took effect. */
interface LargeText {
  newPage: () => Promise<Page>;
  check: (page: Page) => Promise<void>;
  /** Whether words or controls cut off fail the walk (see #84). */
  cutOff: boolean;
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
      cutOff: true,
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
  cutOff = false,
) {
  const context = page.context();
  await walk({
    cutOff,
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
  await expectNoViolations(page, "library", large.cutOff);
  await openSection(page, "security", "Security & backup");
  await expectNoViolations(page, "Security & backup", large.cutOff);
  await openSection(page, "health", "Health data");
  await expectNoViolations(page, "Health data", large.cutOff);
  await openSection(page, "records", "My records");
  await page
    .getByRole("button", {
      name: "More options for Prescription — ramipril 5mg",
    })
    .click();
  await expectNoViolations(page, "a record's More options menu", large.cutOff);
}

/**
 * The native vault screens a patient uses, through a mock of the Tauri bridge (as native-rename.spec.ts
 * does): a vault that exists and is locked, or none yet. The vault has a recovery key, so unlocking does
 * not open the key-setup offer. Any other command fails the test.
 */
async function mockNativeVault(page: Page, status: "absent" | "locked") {
  await page.addInitScript((initialStatus) => {
    let current: "absent" | "locked" | "unlocked" = initialStatus;
    const captureEpoch = crypto.randomUUID();
    let captureSequence = 0;
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
      sharedProfileId: "shared-profile",
    };
    // A file shared from another app, waiting until the vault is open, then
    // added to Shared with me (#61).
    let waiting = [
      {
        id: "shared",
        name: "FAKE Referral.pdf",
        sourceLabel: "Manual import — unverified",
      },
    ];
    Reflect.set(window, "__unexpectedIpc", []);
    Reflect.set(window, "__TAURI_INTERNALS__", {
      invoke: async (command: string) => {
        if (command === "vault_status") return current;
        if (command === "vault_unlock") {
          current = "unlocked";
          return {
            ...structuredClone(snapshot),
            capture: { epoch: captureEpoch, sequence: ++captureSequence },
          };
        }
        if (command === "vault_snapshot")
          return {
            ...structuredClone(snapshot),
            capture: { epoch: captureEpoch, sequence: ++captureSequence },
          };
        if (command === "runtime_info") return { platform: "windows" };
        // The setup checklist asks which rules a passphrase meets (#76).
        if (command === "vault_passphrase_rules")
          return { longEnough: false, notAName: true, hardToGuess: false };
        if (command === "vault_recovery_key_label")
          return snapshot.recoveryKeyLabel;
        if (command === "vault_touch" || command === "vault_set_auto_lock")
          return;
        // A PDF's details ask whether it is locked with a password (#54).
        if (command === "vault_is_locked_pdf") return false;
        // These FAKE PDFs carry no patient identity hint.
        if (command === "vault_shared_identity") return null;
        if (command === "received_list")
          return {
            files: structuredClone(waiting),
            notice: { dropped: 0, refusedShares: 0 },
          };
        if (command === "received_accept") {
          snapshot.profiles.push({
            id: "shared-profile",
            displayName: "Shared with me",
            createdAtMs: 2,
          });
          snapshot.records.push({
            id: "shared-record",
            profileId: "shared-profile",
            folderIds: [],
            displayName: "FAKE Referral.pdf",
            sourceLabel: "Manual import — unverified",
            mediaType: "application/octet-stream",
            plaintextSize: 4096,
            importedAtMs: 3,
            available: true,
          });
          waiting = [];
          return {
            imported: ["shared-record"],
            skippedDuplicates: [],
            notPdf: [],
          };
        }
        // The Text size setting asks the webview to zoom; the page zoom here stands in for it.
        if (command.startsWith("plugin:webview|")) return;
        // Kept as well as thrown: a screen showing an error notice could still pass axe.
        (Reflect.get(window, "__unexpectedIpc") as string[]).push(command);
        throw new Error(`Unexpected IPC command: ${command}`);
      },
    });
  }, status);
}

/** The bridge commands a page asked for that the mock does not answer: none. */
async function expectOnlyMockedCommands(page: Page) {
  expect(
    await page.evaluate(() => Reflect.get(window, "__unexpectedIpc")),
  ).toEqual([]);
}

async function walkTheVault(large: LargeText) {
  const create = await large.newPage();
  await mockNativeVault(create, "absent");
  await create.goto("/");
  await large.check(create);
  // A new setup starts with the comfort settings (#76), then the setup itself.
  await expect(
    create.getByRole("heading", { name: "Make myCarlos comfortable for you" }),
  ).toBeVisible();
  await expectNoViolations(create, "comfort settings", large.cutOff);
  await create.getByRole("button", { name: "Continue" }).click();
  await expect(
    create.getByRole("heading", { name: "Set up myCarlos on this computer" }),
  ).toBeVisible();
  await expectNoViolations(create, "create the vault", large.cutOff);
  await expectOnlyMockedCommands(create);
  await create.close();

  const page = await large.newPage();
  await mockNativeVault(page, "locked");
  await page.goto("/");
  await large.check(page);
  await expect(
    page.getByRole("heading", { name: "Unlock your vault" }),
  ).toBeVisible();
  await expectNoViolations(page, "unlock", large.cutOff);
  await page
    .getByLabel("Passphrase", { exact: true })
    .fill("FAKE passphrase for the mock");
  await page.getByRole("button", { name: "Unlock" }).click();
  const letter = page.getByRole("article", {
    name: translate("en", "library.document.label", {
      name: "FAKE Letter.pdf",
    }),
  });
  await expect(letter).toBeVisible();
  await expectNoViolations(page, "library", large.cutOff);

  await letter
    .getByRole("button", { name: "FAKE Letter.pdf", exact: true })
    .click();
  const details = page.getByRole("dialog", { name: "FAKE Letter.pdf" });
  await expect(details).toBeVisible();
  await expectNoViolations(page, "document details", large.cutOff);
  await page.getByRole("button", { name: "Close document details" }).click();
  await expect(details).toBeHidden();

  await openSection(page, "shared", "Shared with me");
  await expect(
    page.getByRole("heading", { name: "Shared with me" }),
  ).toBeVisible();
  await expectNoViolations(page, "Shared with me", large.cutOff);
  await page
    .getByRole("button", {
      name: translate("en", "library.document.details", {
        name: "FAKE Referral.pdf",
      }),
    })
    .click();
  const shared = page.getByRole("dialog", { name: "FAKE Referral.pdf" });
  await expect(shared.getByRole("combobox", { name: "Move to" })).toBeVisible();
  await expectNoViolations(
    page,
    "Shared with me, a file's details",
    large.cutOff,
  );
  await page.getByRole("button", { name: "Close document details" }).click();
  await expect(shared).toBeHidden();

  await openSection(page, "security", "Security");
  await expect(page.getByRole("heading", { name: "Security" })).toBeVisible();
  await expectNoViolations(page, "Security", large.cutOff);
  await openSection(page, "preferences", "Preferences");
  await expect(
    page.getByRole("heading", { name: "Preferences" }),
  ).toBeVisible();
  await expectNoViolations(page, "Preferences", large.cutOff);
  await expectOnlyMockedCommands(page);
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

test("cuts nothing off with the reader's default text at 200% (#84)", async ({
  page,
}) => {
  await withReaderText200(page, walkThePreview, true);
});

test("cuts nothing off on the vault screens with the reader's default text at 200% (#84)", async ({
  page,
}) => {
  await withReaderText200(page, walkTheVault, true);
});
