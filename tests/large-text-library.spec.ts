import { expect, test, type Page } from "@playwright/test";

// #67 and #84: on a phone with large text (the reader's 200% default text,
// 32px), the library keeps every document's name readable and the lock
// button inside the window. Rename and Details go under the name and the
// lock button under the window's title; before, names had a few letters'
// width ("FAK E Lab res ults") or none at 320px, and the lock button ran off
// the window's edge.
/** A vault with two patients, two folders and two documents (FAKE). */
async function fakeVault(page: Page) {
  await page.addInitScript(() => {
    const snapshot = {
      profiles: [
        { id: "p1", displayName: "FAKE Avery Example", createdAtMs: 1 },
        { id: "p2", displayName: "FAKE Blake Example", createdAtMs: 2 },
      ],
      folders: [
        {
          id: "f1",
          profileId: "p1",
          parentId: null,
          name: "FAKE Lab results",
          createdAtMs: 1759300000000,
        },
        {
          id: "f2",
          profileId: "p1",
          parentId: null,
          name: "FAKE Letters",
          createdAtMs: 1759400000000,
        },
      ],
      records: [
        {
          id: "r1",
          profileId: "p1",
          folderIds: [],
          displayName: "FAKE Clinic letter.pdf",
          sourceLabel: "Manual import — unverified",
          mediaType: "application/pdf",
          plaintextSize: 96256,
          importedAtMs: 1760000000000,
          available: true,
        },
        {
          id: "r2",
          profileId: "p1",
          folderIds: [],
          displayName: "FAKE Blood test results.pdf",
          sourceLabel: "Manual import — unverified",
          mediaType: "application/pdf",
          plaintextSize: 184320,
          importedAtMs: 1760100000000,
          available: true,
        },
      ],
      recovery: null,
      recoveryKeySetAtMs: 1,
    };
    Reflect.set(window, "__TAURI_INTERNALS__", {
      invoke: async (command: string) => {
        if (command === "vault_status") return "unlocked";
        if (command === "vault_snapshot") return structuredClone(snapshot);
        if (command === "runtime_info") return { platform: "windows" };
        return undefined;
      },
    });
  });
}

for (const width of [390, 320])
  test(`keeps names readable and the lock button in the window at ${width}px with 200% default text`, async ({
    browser,
  }, info) => {
    test.skip(info.project.name !== "desktop", "sets its own phone sizes");
    const context = await browser.newContext({
      baseURL: info.project.use.baseURL,
      viewport: { width, height: 1400 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      await fakeVault(page);
      const cdp = await context.newCDPSession(page);
      await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32 } });
      await page.goto("/");
      await expect(
        page.getByRole("button", {
          name: "FAKE Clinic letter.pdf",
          exact: true,
        }),
      ).toBeVisible();
      const measured = await page.evaluate(() => {
        const window_ = document
          .querySelector(".app-window")!
          .getBoundingClientRect();
        const lock = document
          .querySelector(".native-lock-button")!
          .getBoundingClientRect();
        return {
          narrowNames: Array.from(
            document.querySelectorAll<HTMLElement>(
              ".native-filelist .record-open, .native-filelist .name-copy strong",
            ),
          )
            .filter((name) => name.getBoundingClientRect().width < 120)
            .map((name) => name.textContent),
          lockInside:
            lock.left >= window_.left - 1 && lock.right <= window_.right + 1,
        };
      });
      expect(measured.narrowNames, "names squeezed").toEqual([]);
      expect(measured.lockInside, "lock button inside the window").toBe(true);
    } finally {
      await context.close();
    }
  });
