import { expect, test, type Page } from "@playwright/test";
import { translate } from "./support/fluent";
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

/** Visible controls in the window that run past its edges, spill out of their
 * own box, cut their words short, or are cut off by a box hiding overflow;
 * and the page scrolling sideways. */
function cutOrOutside(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const frame = document
      .querySelector(".app-window")!
      .getBoundingClientRect();
    const left = Math.max(0, frame.left);
    const right = Math.min(window.innerWidth, frame.right);
    if (document.documentElement.scrollWidth > window.innerWidth + 1)
      found.push(
        `the page scrolls sideways (${document.documentElement.scrollWidth}px in ${window.innerWidth}px)`,
      );
    const hidden = (element: Element) => {
      const style = getComputedStyle(element);
      return style.clip !== "auto" || style.clipPath !== "none";
    };
    const hides = (overflow: string) =>
      overflow === "hidden" || overflow === "clip";
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".app-window :is(button, a[href], input, select, summary, label)",
      ),
    ).filter((control) => control.checkVisibility() && !hidden(control));
    for (const control of controls) {
      const name = `${control.tagName.toLowerCase()} "${(control.getAttribute("aria-label") ?? control.textContent ?? "").trim().slice(0, 40)}"`;
      const box = control.getBoundingClientRect();
      if (box.left < left - 1 || box.right > right + 1)
        found.push(`${name} runs past the window`);
      if (
        !control.matches("input, select") &&
        (control.scrollWidth > control.clientWidth + 1 ||
          control.scrollHeight > control.clientHeight + 1)
      )
        found.push(`${name} spills out of its own box`);
      const cut = Array.from(control.querySelectorAll<HTMLElement>("*")).find(
        (inner) =>
          inner.checkVisibility() &&
          !hidden(inner) &&
          inner.scrollWidth > inner.clientWidth + 1,
      );
      if (cut) found.push(`${name} cuts "${cut.textContent!.trim()}" short`);
      for (
        let outer = control.parentElement;
        outer && outer !== document.body;
        outer = outer.parentElement
      ) {
        const style = getComputedStyle(outer);
        const edge = outer.getBoundingClientRect();
        if (
          (hides(style.overflowX) &&
            (box.left < edge.left - 1 || box.right > edge.right + 1)) ||
          (hides(style.overflowY) &&
            (box.top < edge.top - 1 || box.bottom > edge.bottom + 1))
        ) {
          found.push(`${name} is cut off by .${outer.classList[0]}`);
          break;
        }
      }
    }
    return found;
  });
}

// #119: longer words in other languages (es "Más recientes primero", pt-BR
// "Compartilhados comigo") wrap onto more lines at 200% text on a phone,
// instead of running past the window or being cut short.
for (const width of [360, 320])
  test(`keeps the library's controls whole and in the window at ${width}px with 200% default text in every language`, async ({
    browser,
  }, info) => {
    test.skip(info.project.name !== "desktop", "sets its own phone sizes");
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const context = await browser.newContext({
        baseURL: info.project.use.baseURL,
        viewport: { width, height: 1400 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await page.addInitScript((locale) => {
          localStorage.setItem("mycarlos.language.v1", locale);
        }, locale);
        await fakeVault(page);
        const cdp = await context.newCDPSession(page);
        await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32 } });
        await page.goto("/");
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(
          page.getByRole("button", {
            name: "FAKE Clinic letter.pdf",
            exact: true,
          }),
        ).toBeVisible();
        for (const problem of await cutOrOutside(page))
          problems.push(`${locale}: ${problem}`);
        // #121: "Sort by" stays in view, in the language in use, and names
        // its two choices.
        const label = translate(locale, "interface.VaultLibrary.sortBy");
        const sort = page.getByRole("group", { name: label, exact: true });
        await expect(sort.getByText(label, { exact: true })).toBeVisible();
        await expect(sort.getByRole("button")).toHaveCount(2);
      } finally {
        await context.close();
      }
    }
    expect(problems, "controls cut off or outside the window").toEqual([]);
  });
