import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { translate } from "./support/fluent";
import type { Locale } from "../src/i18n/types";

// D144 (Ben, 28 Oct): the reader's page buttons are in a bar at its foot, in
// words (First page, Previous page, "Page x of y", Next page, Last page), and
// the zoom is alone at the top left. A narrow reader puts the buttons two by
// two; a one-page document shows its count only. When large text makes the
// reader scroll, the bar stays in view at its bottom edge.

const LOCALES: Locale[] = ["en", "es", "fr", "pl", "pt-BR", "zh-CN", "zh-TW"];

/** A vault with FAKE documents of five, twelve and one page. */
async function fakeReaderVault(page: Page, locale: Locale) {
  await page.addInitScript((locale) => {
    Object.defineProperty(navigator, "languages", { get: () => [locale] });
    const record = (id: string, displayName: string) => ({
      id,
      profileId: "p1",
      folderIds: [],
      displayName,
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 96256,
      importedAtMs: 1760000000000,
      available: true,
    });
    const snapshot = {
      profiles: [
        { id: "p1", displayName: "FAKE Avery Example", createdAtMs: 1 },
      ],
      folders: [],
      records: [
        record("r5", "FAKE Clinic letter.pdf"),
        record("r1", "FAKE One-page note.pdf"),
        record("r12", "FAKE Long report.pdf"),
      ],
      recovery: null,
      recoveryKeySetAtMs: 1,
    };
    const pageCounts: Record<string, number> = { r5: 5, r1: 1, r12: 12 };
    // A FAKE letter-sized page with its number, drawn here.
    const draw = (number: number, asked: number) => {
      const width = Math.max(1, Math.min(asked, 1600));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.round((width * 11) / 8.5);
      const pen = canvas.getContext("2d")!;
      pen.fillStyle = "#ffffff";
      pen.fillRect(0, 0, canvas.width, canvas.height);
      pen.fillStyle = "#1f2933";
      pen.font = `700 ${Math.round(width / 18)}px sans-serif`;
      pen.fillText(`FAKE page ${number}`, width * 0.1, width * 0.16);
      pen.fillStyle = "#9aa5b1";
      for (let line = 0; line < 14; line++)
        pen.fillRect(
          width * 0.1,
          width * (0.26 + line * 0.06),
          width * (line % 3 === 2 ? 0.5 : 0.8),
          Math.max(1, width / 120),
        );
      return { image: canvas.toDataURL("image/png"), height: canvas.height };
    };
    Reflect.set(window, "__TAURI_INTERNALS__", {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command === "vault_status") return "unlocked";
        if (command === "vault_snapshot") return structuredClone(snapshot);
        if (command === "runtime_info") return { platform: "windows" };
        if (command === "vault_view_page") {
          const request = (args?.request ?? {}) as {
            recordId: string;
            page: number;
            width: number;
          };
          const drawn = draw(request.page + 1, request.width);
          return {
            pageCount: pageCounts[request.recordId],
            width: request.width,
            height: drawn.height,
            image: drawn.image,
            // Long enough for "Text on this page" to scroll.
            text: Array.from(
              { length: 80 },
              (_, line) => `FAKE line ${line + 1} on page ${request.page + 1}`,
            ).join("\n"),
          };
        }
        return undefined;
      },
    });
  }, locale);
}

async function openReader(page: Page, locale: Locale, name: string) {
  await page.getByRole("button", { name, exact: true }).click();
  await page
    .getByRole("dialog", { name })
    .getByRole("button", {
      name: translate(locale, "interface.RecordDetails.read"),
      exact: true,
    })
    .click();
  const reader = page.locator(".native-reader");
  await expect(reader.locator(".native-reader-page img")).toBeVisible();
  return reader;
}

/** Where the reader's parts are, and whether anything is cut or too small. */
function measure(page: Page) {
  return page.evaluate(() => {
    const reader = document.querySelector<HTMLElement>(".native-reader")!;
    const bar = reader.querySelector<HTMLElement>(".native-reader-pages")!;
    const box = (element: Element) => {
      const { top, bottom, left, right, width, height } =
        element.getBoundingClientRect();
      return { top, bottom, left, right, width, height };
    };
    const buttons = Array.from(bar.querySelectorAll("button"));
    return {
      reader: box(reader),
      bar: box(bar),
      zoom: box(reader.querySelector(".native-reader-zoom")!),
      area: box(reader.querySelector(".native-reader-page")!),
      parts: Array.from(bar.children, (child) => {
        const { top, bottom, left } = child.getBoundingClientRect();
        return { middle: Math.round((top + bottom) / 2), left };
      }),
      words: Array.from(bar.children, (child) =>
        (child.textContent ?? "").replace(/[⁨⁩]/g, ""),
      ),
      display: getComputedStyle(bar).display,
      // The reader width, in em, that the bar's one row needs.
      oneRowEm: (() => {
        const style = getComputedStyle(bar);
        const widths = Array.from(
          bar.children,
          (child) => child.getBoundingClientRect().width,
        );
        const needed =
          widths.reduce((sum, width) => sum + width, 0) +
          parseFloat(style.columnGap) * (widths.length - 1) +
          parseFloat(style.paddingLeft) +
          parseFloat(style.paddingRight);
        return needed / parseFloat(getComputedStyle(reader).fontSize);
      })(),
      readerWider: reader.scrollWidth - reader.clientWidth,
      barWider: bar.scrollWidth - bar.clientWidth,
      cut: buttons
        .filter(
          (button) =>
            button.scrollWidth > button.clientWidth + 1 ||
            button.scrollHeight > button.clientHeight + 1,
        )
        .map((button) => button.textContent),
      small: buttons
        .filter((button) => {
          const { width, height } = button.getBoundingClientRect();
          return width < 24 || height < 24;
        })
        .map((button) => button.textContent),
      scrolls: reader.scrollHeight > reader.clientHeight + 1,
      // "Text on this page" keeps the room its summary needs.
      textSquashed: (() => {
        const text = reader.querySelector(".native-reader-text");
        return text ? text.scrollHeight > text.clientHeight + 1 : null;
      })(),
      viewportHeight: window.innerHeight,
    };
  });
}

/** The default text size the fit asked for is the one in use. A full-page
 * screenshot puts Chrome's back to 16px, so only viewport shots are taken. */
async function expectTextSize(page: Page, font: number) {
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    ),
    "default text size",
  ).toBe(`${font}px`);
}

const FITS = [
  { label: "1280-text100", width: 1280, height: 800, font: 16, narrow: false },
  { label: "1280-text200", width: 1280, height: 800, font: 32, narrow: true },
  { label: "360-text100", width: 360, height: 740, font: 16, narrow: true },
  { label: "360-text200", width: 360, height: 740, font: 32, narrow: true },
] as const;

async function readerAt(
  browser: import("@playwright/test").Browser,
  info: TestInfo,
  fit: { width: number; height: number; font: number },
  locale: Locale,
) {
  const phone = fit.width < 600;
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport: { width: fit.width, height: fit.height },
    isMobile: phone,
    hasTouch: phone,
  });
  const page = await context.newPage();
  await fakeReaderVault(page, locale);
  if (fit.font !== 16) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.setFontSizes", { fontSizes: { standard: fit.font } });
  }
  await page.goto("/");
  return { context, page };
}

for (const [fit, locale] of [
  ...FITS.map((fit) => [fit, "en"] as const),
  [FITS[3], "pl"] as const,
  [FITS[0], "pl"] as const,
])
  test(`keeps the page bar at the reader's foot at ${fit.label} (${locale})`, async ({
    browser,
  }, info) => {
    test.skip(info.project.name !== "desktop", "sets its own sizes");
    const { context, page } = await readerAt(browser, info, fit, locale);
    try {
      const reader = await openReader(page, locale, "FAKE Clinic letter.pdf");
      await reader.evaluate((element) => (element.scrollTop = 0));
      await page.screenshot({
        path: info.outputPath(`d144-${fit.label}-${locale}.png`),
      });
      await expectTextSize(page, fit.font);
      const at = await measure(page);
      expect(at.words).toEqual([
        translate(locale, "interface.DocumentReader.firstPage"),
        translate(locale, "interface.DocumentReader.previousPage"),
        translate(locale, "interface.reader.where", {
          page: 1,
          total: 5,
        }).replace(/[⁨⁩]/g, ""),
        translate(locale, "interface.DocumentReader.nextPage"),
        translate(locale, "interface.DocumentReader.lastPage"),
      ]);
      // In view at the reader's foot, even before the reader is scrolled.
      expect(at.bar.left).toBeGreaterThanOrEqual(at.reader.left - 1);
      expect(at.bar.right).toBeLessThanOrEqual(at.reader.right + 1);
      expect(at.bar.bottom).toBeLessThanOrEqual(at.reader.bottom + 1);
      expect(at.reader.bottom - at.bar.bottom).toBeLessThanOrEqual(2);
      expect(at.bar.bottom).toBeLessThanOrEqual(at.viewportHeight);
      // The zoom at the top left, above the page.
      expect(at.zoom.left - at.reader.left).toBeLessThanOrEqual(24);
      expect(at.zoom.bottom).toBeLessThanOrEqual(at.area.top + 1);
      // The page keeps room to be read.
      expect(at.area.height).toBeGreaterThanOrEqual(200);
      // Nothing cut, nothing sideways, nothing too small to press.
      expect(at.readerWider, "reader scrolls sideways").toBeLessThanOrEqual(0);
      expect(at.barWider, "bar wider than the reader").toBeLessThanOrEqual(0);
      expect(at.cut, "words cut in a button").toEqual([]);
      expect(at.small, "buttons under 24px").toEqual([]);
      expect(at.textSquashed, "page text squeezed").toBe(false);
      const [first, previous, where, next, last] = at.parts;
      if (fit.narrow) {
        expect(at.display).toBe("grid");
        expect(previous.middle).toBe(first.middle);
        expect(where.middle).toBeGreaterThan(first.middle);
        expect(next.middle).toBeGreaterThan(where.middle);
        expect(last.middle).toBe(next.middle);
        expect(next.left).toBe(first.left);
        expect(last.left).toBe(previous.left);
      } else {
        expect(at.display).toBe("flex");
        expect(new Set(at.parts.map((part) => part.middle)).size).toBe(1);
      }
      // At 200% text the reader scrolls, so these checks always run there.
      if (fit.font === 32)
        expect(at.scrolls, "the reader scrolls at 200% text").toBe(true);
      if (at.scrolls) {
        // A control the focus moves to is scrolled clear of the bar.
        const summary = reader.locator(".native-reader-text summary");
        await summary.focus();
        const focused = await summary.boundingBox();
        const barNow = await reader
          .locator(".native-reader-pages")
          .boundingBox();
        expect(
          focused!.y + focused!.height,
          "focused summary under the bar",
        ).toBeLessThanOrEqual(barNow!.y + 1);
        // Scrolled to its end, the bar is still at the foot, under the text.
        await reader.evaluate(
          (element) => (element.scrollTop = element.scrollHeight),
        );
        const end = await measure(page);
        expect(end.reader.bottom - end.bar.bottom).toBeLessThanOrEqual(2);
        await page.screenshot({
          path: info.outputPath(`d144-${fit.label}-${locale}-scrolled.png`),
        });
        await expectTextSize(page, fit.font);
      }
      // The keys turn pages in the app too.
      await reader.focus();
      await page.keyboard.press("End");
      await expect(reader.locator(".native-reader-where")).toHaveText(
        translate(locale, "interface.reader.where", { page: 5, total: 5 }),
      );
      await expectTextSize(page, fit.font);
    } finally {
      await context.close();
    }
  });

test("shows a one-page document's count only, at the reader's foot", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "sets its own sizes");
  const { context, page } = await readerAt(browser, info, FITS[2], "en");
  try {
    const reader = await openReader(page, "en", "FAKE One-page note.pdf");
    await page.screenshot({ path: info.outputPath("d144-one-page.png") });
    await expectTextSize(page, FITS[2].font);
    const bar = reader.locator(".native-reader-pages");
    await expect(bar).toHaveText(
      translate("en", "interface.reader.where", { page: 1, total: 1 }),
    );
    await expect(bar.getByRole("button")).toHaveCount(0);
    const at = await measure(page);
    expect(at.reader.bottom - at.bar.bottom).toBeLessThanOrEqual(2);
  } finally {
    await context.close();
  }
});

// Just wider than the narrow layout (52em on the reader, styles.css), every
// language's words fit the one row, with the count at its widest. Measured at
// 16px text 28 Oct (Chromium, Linux): pl needs 48.2em, es 46.0em, pt-BR
// 45.7em, fr 45.3em, en 38.3em, zh 31.6em; the rest is room for other fonts.
test("fits every language's page bar on one row just above the narrow layout", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "sets its own sizes");
  // 52em of 16px inside the reader's 1px borders, the backdrop's 2 x 20px
  // padding, and a pixel to spare.
  const fit = { width: 52 * 16 + 2 + 40 + 1, height: 800, font: 16 };
  for (const locale of LOCALES) {
    const { context, page } = await readerAt(browser, info, fit, locale);
    try {
      const reader = await openReader(page, locale, "FAKE Long report.pdf");
      await reader.focus();
      await page.keyboard.press("End");
      await expect(reader.locator(".native-reader-where")).toHaveText(
        translate(locale, "interface.reader.where", { page: 12, total: 12 }),
      );
      const at = await measure(page);
      expect.soft(at.display, locale).toBe("flex");
      expect
        .soft(
          new Set(at.parts.map((part) => part.middle)).size,
          `${locale} on one row (needs ${at.oneRowEm.toFixed(2)}em): ${at.words.join(" | ")}`,
        )
        .toBe(1);
      expect.soft(at.cut, locale).toEqual([]);
      expect.soft(at.barWider, locale).toBeLessThanOrEqual(0);
      await expectTextSize(page, fit.font);
    } finally {
      await context.close();
    }
  }
});

// A page zoomed in is read down with Page Down, End and Home, as anywhere
// else that scrolls. The key turns the page only at the page's edge, and the
// next page shows its top.
test("reads down a zoomed page with the keys before turning it", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "sets its own sizes");
  const { context, page } = await readerAt(browser, info, FITS[0], "en");
  try {
    const reader = await openReader(page, "en", "FAKE Clinic letter.pdf");
    const where = (number: number) =>
      translate("en", "interface.reader.where", { page: number, total: 5 });
    const larger = reader.getByRole("button", {
      name: translate("en", "interface.DocumentReader.larger"),
      exact: true,
    });
    const zoom = reader.locator(".native-reader-zoom [aria-live]");
    // Up to 400%: a press while a size is being drawn does nothing.
    await expect(async () => {
      if ((await zoom.textContent())?.includes("400") !== true)
        await larger.click();
      await expect(zoom).toContainText("400", { timeout: 500 });
    }).toPass({ timeout: 30_000 });
    await expect(reader.getByRole("status")).toHaveText(where(1));
    const area = reader.locator(".native-reader-page");
    const scroll = () =>
      area.evaluate((element) => ({
        top: element.scrollTop,
        atBottom:
          element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
        tall: element.scrollHeight > element.clientHeight * 2,
      }));
    await expect.poll(async () => (await scroll()).tall).toBe(true);
    await area.focus();
    expect((await scroll()).top).toBe(0);
    await page.keyboard.press("PageDown");
    await expect.poll(async () => (await scroll()).top).toBeGreaterThan(0);
    await expect(reader.locator(".native-reader-where")).toHaveText(where(1));
    await page.keyboard.press("End");
    await expect.poll(async () => (await scroll()).atBottom).toBe(true);
    await expect(reader.locator(".native-reader-where")).toHaveText(where(1));
    // At the bottom, Page Down turns the page, which shows its top.
    await page.keyboard.press("PageDown");
    await expect(reader.locator(".native-reader-where")).toHaveText(where(2));
    await expect(reader.getByRole("status")).toHaveText(where(2));
    expect((await scroll()).top).toBe(0);
    // At the top, Page Up turns back to page 1, shown from its bottom, so
    // that reading back goes on where it left off.
    await page.keyboard.press("PageUp");
    await expect(reader.locator(".native-reader-where")).toHaveText(where(1));
    await expect.poll(async () => (await scroll()).atBottom).toBe(true);
    // Home scrolls page 1 to its top; the first page has none before it.
    await page.keyboard.press("Home");
    await expect.poll(async () => (await scroll()).top).toBe(0);
    await expect(reader.locator(".native-reader-where")).toHaveText(where(1));
    await expectTextSize(page, FITS[0].font);
  } finally {
    await context.close();
  }
});

// "Text on this page", opened and clicked into, scrolls with the arrow keys,
// Page Down and End like any text. The page turns only once the text has
// been read to its end.
test("scrolls the page's text with the keys after a click in it", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "sets its own sizes");
  const { context, page } = await readerAt(browser, info, FITS[0], "en");
  try {
    const reader = await openReader(page, "en", "FAKE Clinic letter.pdf");
    const where = (number: number) =>
      translate("en", "interface.reader.where", { page: number, total: 5 });
    await reader
      .getByText(translate("en", "interface.DocumentReader.textOnThisPage"))
      .click();
    const line = reader.locator(".native-reader-text div").first();
    await expect(line).toContainText("FAKE line 2 on page 1");
    await line.click({ position: { x: 24, y: 12 } });
    // The box that scrolls the text, whichever element that is.
    const text = () =>
      line.evaluate((element) => {
        let box: HTMLElement | null = element;
        while (box && box.scrollHeight <= box.clientHeight + 1)
          box = box.parentElement;
        return {
          top: box?.scrollTop ?? -1,
          atBottom: box
            ? box.scrollTop + box.clientHeight >= box.scrollHeight - 1
            : false,
          isText: box?.closest(".native-reader-text") !== null,
        };
      });
    expect((await text()).isText, "the text box scrolls").toBe(true);
    expect((await text()).top).toBe(0);
    for (let press = 0; press < 3; press++)
      await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await text()).top).toBeGreaterThan(0);
    const before = (await text()).top;
    await page.keyboard.press("PageDown");
    await expect.poll(async () => (await text()).top).toBeGreaterThan(before);
    await expect(reader.locator(".native-reader-where")).toHaveText(where(1));
    await page.keyboard.press("End");
    await expect.poll(async () => (await text()).atBottom).toBe(true);
    await expect(reader.locator(".native-reader-where")).toHaveText(where(1));
    // At the end of the text, Page Down turns the page.
    await page.keyboard.press("PageDown");
    await expect(reader.locator(".native-reader-where")).toHaveText(where(2));
    await expectTextSize(page, FITS[0].font);
  } finally {
    await context.close();
  }
});
