import { expect, test, type Page } from "@playwright/test";
import { translate } from "../src/i18n/core";
import { LOCALES } from "../src/i18n/types";

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

// #121: the sort choices are a row of buttons under a visible "Sort by". With
// 32px text that row is wider than a phone's window, and the window hides what
// runs past its edge, so "Name A–Z" was cut off and the page slid sideways.
// The label and the choices wrap instead: each whole, inside the window, in
// every language.
for (const width of [412, 360, 320])
  for (const locale of LOCALES)
    test(`keeps the whole sort control in the window at ${width}px with 200% default text in ${locale}`, async ({
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
        await page.addInitScript((language) => {
          window.localStorage.setItem("mycarlos.language.v1", language);
        }, locale);
        const cdp = await context.newCDPSession(page);
        await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32 } });
        await page.goto("/");
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        const sort = page.locator(".native-sort-choice");
        await expect(sort).toBeVisible();
        const problems = await sort.evaluate((control) => {
          const window_ = control
            .closest(".app-window")!
            .getBoundingClientRect();
          return [
            control,
            ...control.querySelectorAll<HTMLElement>(
              "button, .native-sort-label",
            ),
          ].flatMap((part) => {
            const box = part.getBoundingClientRect();
            const name =
              part === control ? "the sort control" : part.textContent;
            return [
              ...(box.left < window_.left - 1 || box.right > window_.right + 1
                ? [
                    `${name} runs from ${Math.round(box.left)} to ${Math.round(box.right)}, the window from ${Math.round(window_.left)} to ${Math.round(window_.right)}`,
                  ]
                : []),
              ...(part.scrollWidth > part.clientWidth + 1
                ? [
                    `${name} is cut: ${part.scrollWidth}px of text in ${part.clientWidth}px`,
                  ]
                : []),
            ];
          });
        });
        expect(problems, "sort control inside the window, uncut").toEqual([]);
        // The label stays in view, in the language in use, and names the group.
        const label = translate(locale, "library.sort.label");
        const group = page.getByRole("group", { name: label, exact: true });
        await expect(group.getByText(label, { exact: true })).toBeVisible();
        await expect(group.getByRole("button")).toHaveCount(2);
      } finally {
        await context.close();
      }
    });
