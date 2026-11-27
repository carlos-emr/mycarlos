import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { FAKE_MODEL, fakeAiWith } from "./support/aiFake";
import { translate } from "./support/fluent";
import {
  FAKE_PAGE_COUNT,
  fakeCalls,
  fakeVaultWith,
  myRecords,
  openDetails,
  type FakeVaultSetup,
} from "./support/vaultFake";

// Show me in the document marks a summary sentence's quote on the page picture as
// well as in "Text on this page" (#292). The native side is faked: the page
// is a FAKE letter drawn on a canvas (support/vaultFake.ts, drawnPages), and
// vault_page_boxes answers where it drew the quoted words, as the PDF helper
// would. The AI helper runs on computers only, so a phone has no Summary.
// FAKE data only.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

const LETTER = "FAKE Letter.pdf";
// A sentence wrapped over two drawn lines, low on the page: the quote the
// summary cites for page 2, so its box needs the picture scrolled to it.
const PAGES: NonNullable<FakeVaultSetup["drawnPages"]> = [
  {
    top: 0.2,
    lines: [
      "FAKE-send-delete Family Practice (FAKE)",
      "Referral letter for FAKE-NewWindows, a synthetic test record.",
      "Dear Dr. Sampleton,",
    ],
  },
  {
    top: 0.62,
    lines: [
      "Please arrange a gastroscopy with duodenal biopsies to confirm ",
      "celiac disease, within the next 4 to 6 weeks.",
      "Ferritin was 6 ug/L and hemoglobin 104 g/L on 9 October 2026.",
      "They have lost 4 kg without trying over four months.",
      "No blood in the stool, no vomiting and no night sweats.",
      "Sincerely, Dr. Henrietta Fakeham, MD (FAKE)",
    ],
  },
  {
    top: 0.15,
    lines: [
      "Questions for the specialist (FAKE)",
      "Should they keep eating gluten until the biopsy?",
    ],
  },
];
const pageText = (index: number) =>
  PAGES[index].lines
    .map((line) => (line.endsWith(" ") ? line : `${line}\n`))
    .join("")
    .replace(/\n$/, "");
// The summary quotes the page's first line; the app finds it without the
// full stop at its end (src/ai/locateQuote.ts), so that is what is marked.
const QUOTE = pageText(1).split("\n")[0].replace(/\.$/, "");

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone" && !testInfo.title.startsWith("phone"),
    "the AI helper runs on computers only (the PDF helper reads the text)",
  );
  test.skip(
    testInfo.project.name !== "phone" && testInfo.title.startsWith("phone"),
    "the phone's own reader",
  );
});

async function openReader(page: Page, setup: Partial<FakeVaultSetup> = {}) {
  await fakeVaultWith(page, {
    start: "unlocked",
    drawnPages: PAGES,
    ...setup,
  });
  await fakeAiWith(page, {
    model: { state: "installed", model: FAKE_MODEL },
    documents: { [LETTER]: PAGES.map((_, index) => pageText(index)) },
  });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const details = await openDetails(page, LETTER);
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.read"),
      exact: true,
    })
    .click();
  const reader = page.getByRole("dialog", { name: LETTER, exact: true });
  await expect(picture(reader, 1)).toBeVisible();
  return reader;
}

const picture = (reader: Locator, number: number) =>
  reader.getByRole("img", {
    name: en("interface.reader.textFollows", {
      page: number,
      total: FAKE_PAGE_COUNT,
    }),
    exact: true,
  });
const boxes = (reader: Locator) =>
  reader.locator(".native-reader-boxes > span");
const mark = (reader: Locator) => reader.locator(".native-reader-text mark");
/** How the marked words look and whether assistive technology still has them. */
const markLook = (reader: Locator) =>
  mark(reader).evaluate((element) => {
    const style = getComputedStyle(element);
    const hidden = element.closest("[aria-hidden='true'], [hidden], [inert]");
    return {
      background: style.backgroundColor,
      outline: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      visibility: style.visibility,
      display: style.display,
      focusVisible: element.matches(":focus-visible"),
      hiddenFromAssistiveTechnology: hidden !== null,
    };
  });
const TRANSPARENT = "rgba(0, 0, 0, 0)";
const unfold = (reader: Locator) =>
  reader.getByRole("button", {
    name: en("ai.summary.showWhole"),
    exact: true,
  });

/** Summary (after the AI helper's notice), then the page-2 sentence's Show
 * in document. */
async function showQuote(
  page: Page,
  reader: Locator,
  { keyboard = false }: { keyboard?: boolean } = {},
) {
  await reader
    .getByRole("button", { name: en("ai.summary.button"), exact: true })
    .click();
  const notice = page.getByRole("dialog", {
    name: en("aiHelper.notice.title"),
    exact: true,
  });
  await notice
    .getByRole("button", {
      name: en("interface.AiHelperNotice.continue"),
      exact: true,
    })
    .click();
  const show = reader.getByRole("button", {
    name: en("ai.summary.showInDocument"),
    exact: true,
  });
  await expect(show).toHaveCount(FAKE_PAGE_COUNT);
  if (keyboard) {
    // As a keyboard user does it: focus the button and press Enter.
    await show.nth(1).focus();
    await page.keyboard.press("Enter");
  } else {
    await show.nth(1).click();
  }
  await expect(picture(reader, 2)).toBeVisible();
}

/** Where each box is, in fractions of the picture, with the picture's size in
 * CSS pixels and whether it is the settled one.
 *
 * Everything is read in ONE browser turn. Reading the picture and then each box
 * with separate calls was the flake (#292's zoom check, red on main): after a
 * zoom the reader first scales the old picture to the new width, then, about
 * 100 ms later, swaps in the page drawn at the new size, and the layout moves
 * (the picture's height changes by under a pixel, and its top by 16px). A box
 * read after that swap, over a picture read before it, came out 0.007 of the
 * page away from where it is. In one turn the picture and the boxes always
 * belong together.
 *
 * `settled`: the picture on screen is the page drawn at (at least) its width. */
async function placed(reader: Locator) {
  return reader.evaluate((root) => {
    const image = root.querySelector<HTMLImageElement>(
      ".native-reader-picture img",
    )!;
    const frame = image.getBoundingClientRect();
    const found = [...root.querySelectorAll(".native-reader-boxes > span")].map(
      (box) => {
        const at = box.getBoundingClientRect();
        return [
          (at.x - frame.x) / frame.width,
          (at.y - frame.y) / frame.height,
          (at.x + at.width - frame.x) / frame.width,
          (at.y + at.height - frame.y) / frame.height,
        ];
      },
    );
    return {
      boxes: found,
      width: frame.width,
      height: frame.height,
      settled:
        image.complete && image.naturalWidth >= Math.round(frame.width) - 1,
    };
  });
}

/** The boxes' places, once the picture has settled after a change of size. */
async function placedSettled(reader: Locator) {
  await expect.poll(async () => (await placed(reader)).settled).toBe(true);
  return placed(reader);
}

/** Whether `element` is in full view inside its scroller. */
async function inView(element: Locator, scroller: Locator) {
  const box = (await element.boundingBox())!;
  const view = (await scroller.boundingBox())!;
  return (
    box.y >= view.y - 1 &&
    box.y + box.height <= view.y + view.height + 1 &&
    box.x >= view.x - 1 &&
    box.x + box.width <= view.x + view.width + 1
  );
}

async function shot(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
}

test("marks the quote on the page picture and in the text, and keeps the helper's boxes in place at every zoom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const reader = await openReader(page);
  await showQuote(page, reader);
  // The sentence runs over two lines on the page: one box for each.
  await expect(boxes(reader)).toHaveCount(2);
  await expect(reader.locator(".native-reader-boxes")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  const [start, end] = [
    pageText(1).indexOf(QUOTE),
    pageText(1).indexOf(QUOTE) + QUOTE.length,
  ];
  expect(await fakeCalls(page, "vault_page_boxes")).toEqual([
    {
      request: expect.objectContaining({
        page: 1,
        start,
        end,
        quoted: QUOTE,
        password: null,
      }),
    },
  ]);
  // The first box sits on the first drawn line: its left at the text's
  // margin, and around the line's baseline, 62% down the page.
  const { boxes: fitted } = await placedSettled(reader);
  expect(fitted[0][0]).toBeCloseTo(0.1, 2);
  expect(fitted[0][1]).toBeLessThan(0.62);
  expect(fitted[0][3]).toBeGreaterThan(0.62);
  expect(fitted[1][1]).toBeGreaterThanOrEqual(fitted[0][3] - 0.002);
  // The marked words keep the focus, and both are in view.
  await expect(mark(reader)).toBeFocused();
  await expect(mark(reader)).toHaveText(QUOTE);
  // The picture shows the quote, so the text's mark is not drawn a second time: no fill and no
  // outline (unless a keyboard user needs to see the focus), yet it is still there for assistive
  // technology: not hidden, not removed, not moved out of the reading order.
  const quiet = await markLook(reader);
  expect(quiet.background).toBe(TRANSPARENT);
  if (!quiet.focusVisible) expect(quiet.outline).toBe("none");
  expect(quiet.visibility).toBe("visible");
  expect(quiet.display).not.toBe("none");
  expect(quiet.hiddenFromAssistiveTechnology).toBe(false);
  await expect(mark(reader)).toBeVisible();
  await expect(reader.locator("#reader-marked")).toHaveText(
    en("interface.reader.markedOnPage", { page: 2 }),
  );
  await expect
    .poll(() =>
      inView(boxes(reader).first(), reader.locator(".native-reader-page")),
    )
    .toBe(true);
  await expect
    .poll(() => inView(mark(reader), reader.locator(".native-reader-text")))
    .toBe(true);
  // A large window keeps the whole summary.
  await expect(unfold(reader)).toHaveCount(0);
  await shot(page, "show-in-document-1280");

  // Larger, twice: the boxes keep their place on the picture. The fake gives
  // the fractions; the native tests check where the helper puts them.
  const larger = reader.getByRole("button", {
    name: en("interface.DocumentReader.larger"),
    exact: true,
  });
  await larger.click();
  await larger.click();
  await expect(
    reader.getByText(en("interface.reader.zoom", { percent: 156 }), {
      exact: true,
    }),
  ).toBeVisible();
  // The boxes are placed in percentages of the picture, so they cover the same
  // words at any size. What can differ is rounding: the page drawn at the new
  // size has whole-pixel dimensions, so its aspect ratio differs from the old
  // one's by under a pixel in its height, and a box edge lands on a fraction of a
  // pixel. Within 1.5 CSS pixels (a pixel of rounding and half a pixel of layout),
  // measured on the picture's own size, is the same place; a box that had
  // moved with the zoom would be tens of pixels off.
  const { boxes: zoomed, width, height } = await placedSettled(reader);
  expect(zoomed).toHaveLength(fitted.length);
  for (const [index, box] of zoomed.entries())
    for (const side of [0, 1, 2, 3])
      expect(
        Math.abs(box[side] - fitted[index][side]) * (side % 2 ? height : width),
        `box ${index}, side ${side}`,
      ).toBeLessThanOrEqual(1.5);
  expect(await fakeCalls(page, "vault_page_boxes")).toHaveLength(1);
  await shot(page, "show-in-document-1280-zoomed");
  await expectOnlyFakedCommands(page);
});

for (const width of [560, 412]) {
  test(`keeps the words in view on the picture and in the text in a window ${width} px wide`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const reader = await openReader(page);
    await showQuote(page, reader);
    await expect(boxes(reader)).toHaveCount(2);
    await expect(mark(reader)).toBeFocused();
    // The narrow-window default: the focus stays on the marked words, the
    // picture scrolls itself to the box, and the text box and AI panel are
    // smaller while the quote is shown, so the picture keeps room.
    await expect(reader).toHaveClass(/native-reader-highlighting/);
    await expect
      .poll(() =>
        inView(boxes(reader).first(), reader.locator(".native-reader-page")),
      )
      .toBe(true);
    await expect
      .poll(() => inView(mark(reader), reader.locator(".native-reader-text")))
      .toBe(true);
    // The summary is folded to one line, its button says so.
    await expect(unfold(reader)).toBeVisible();
    await expect(unfold(reader)).toHaveAttribute("aria-expanded", "false");
    await expect(unfold(reader)).toHaveAccessibleDescription(
      en("ai.summary.folded"),
    );
    await shot(page, `show-in-document-${width}`);
    // Unfolded on request, with the focus on the sentence shown.
    await unfold(reader).click();
    const shown = reader
      .getByRole("button", {
        name: en("ai.summary.showInDocument"),
        exact: true,
      })
      .nth(1);
    await expect(shown).toBeFocused();
    await expect(unfold(reader)).toHaveCount(0);
    await shot(page, `show-in-document-${width}-unfolded`);
    await expectOnlyFakedCommands(page);
  });
}

test("folds the summary on a short window, as a large screen at 200% zoom, and keeps the words in view", async ({
  page,
}) => {
  // 1280 x 800 at 200% zoom is 640 x 400 to the page; a short window of
  // full width is folded as well.
  await page.setViewportSize({ width: 1280, height: 400 });
  const reader = await openReader(page);
  await showQuote(page, reader);
  await expect(boxes(reader)).toHaveCount(2);
  await expect(unfold(reader)).toBeVisible();
  await expect(mark(reader)).toBeFocused();
  await expect
    .poll(() =>
      inView(boxes(reader).first(), reader.locator(".native-reader-page")),
    )
    .toBe(true);
  await shot(page, "show-in-document-1280x400");
  await expectOnlyFakedCommands(page);
});

/** Whether a pointer press at the centre of `target`, once it is scrolled into
 * view, lands on it and not on something laid over it (`toBeVisible` only
 * says its box is not empty: the folded summary's button had one, covered by
 * the text box above it, at ordinary window sizes). */
async function reachable(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  return target.evaluate((element) => {
    const at = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      at.x + at.width / 2,
      at.y + at.height / 2,
    );
    return hit !== null && (hit === element || element.contains(hit));
  });
}

// The summary panel keeps a usable height at every size the reader is used
// at, and the folded summary's button can be pressed (#292). The first three
// are the sizes where the panel was squeezed to 13px and the button covered.
for (const [width, height] of [
  [560, 800],
  [900, 600],
  [1280, 600],
  [1280, 400],
  [412, 780],
  [1280, 800],
]) {
  test(`keeps the summary usable and its button pressable in a ${width} x ${height} window`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const reader = await openReader(page);
    await showQuote(page, reader);
    await expect(boxes(reader)).toHaveCount(2);
    const panel = reader.locator("#reader-ai-panel");
    const folded = (await unfold(reader).count()) > 0;
    // Its own height, not squeezed to its padding: a folded line with its
    // 44px button, or the sentences with a share of the window of their own.
    const box = (await panel.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(folded ? 56 : 120);
    if (folded) {
      // Pressed for real: Playwright refuses a click that would land on
      // another element.
      expect(await reachable(unfold(reader))).toBe(true);
      await unfold(reader).click();
      await expect(unfold(reader)).toHaveCount(0);
    }
    const show = reader.getByRole("button", {
      name: en("ai.summary.showInDocument"),
      exact: true,
    });
    for (const index of [0, 1, 2]) {
      expect(await reachable(show.nth(index))).toBe(true);
    }
    // The page bar and Close stay reachable at the same size.
    await reader.evaluate((element) => {
      element.scrollTop = 0;
    });
    expect(
      await reachable(
        reader.getByRole("button", {
          name: en("photo.close"),
          exact: true,
        }),
      ),
    ).toBe(true);
    await reader.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(
      await reachable(
        reader.getByRole("button", {
          name: en("interface.DocumentReader.nextPage"),
          exact: true,
        }),
      ),
    ).toBe(true);
    await shot(page, `show-in-document-summary-${width}x${height}`);
    await expectOnlyFakedCommands(page);
  });
}

test("keeps the summary usable and its button pressable at 200% text in a 1280 x 800 window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const reader = await openReader(page);
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await showQuote(page, reader);
  await expect(boxes(reader)).toHaveCount(2);
  const folded = (await unfold(reader).count()) > 0;
  const box = (await reader.locator("#reader-ai-panel").boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(folded ? 56 : 120);
  if (folded) expect(await reachable(unfold(reader))).toBe(true);
  await shot(page, "show-in-document-summary-200-percent");
});

test("a keyboard user still sees a 2 px focus ring on the quiet mark", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const reader = await openReader(page);
  await showQuote(page, reader, { keyboard: true });
  await expect(boxes(reader)).toHaveCount(2);
  await expect(mark(reader)).toBeFocused();
  const ring = await markLook(reader);
  // The fill is not drawn, but the focus the keys moved there is visible, as WCAG 2.4.7 needs.
  expect(ring.background).toBe(TRANSPARENT);
  expect(ring.focusVisible).toBe(true);
  expect(ring.outline).toBe("solid");
  expect(ring.outlineWidth).toBe("2px");
  expect(ring.hiddenFromAssistiveTechnology).toBe(false);
});

test("draws no box where the helper cannot place every word, and says the words are in the text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const reader = await openReader(page, { boxesAbsent: "unaligned" });
  await showQuote(page, reader);
  await expect(reader.locator("#reader-marked")).toHaveText(
    en("interface.reader.markedInText", { page: 2 }),
  );
  await expect(boxes(reader)).toHaveCount(0);
  await expect(mark(reader)).toHaveText(QUOTE);
  await expect(mark(reader)).toBeFocused();
  // Nothing is drawn on the picture, so the text's mark IS the highlight and is drawn as before.
  const drawn = await markLook(reader);
  expect(drawn.background).not.toBe(TRANSPARENT);
  expect(drawn.outline).toBe("solid");
  expect(drawn.outlineWidth).toBe("2px");
  expect(drawn.hiddenFromAssistiveTechnology).toBe(false);
  await expectOnlyFakedCommands(page);
});

test("outlines the boxes in the system's highlight colour with forced colours", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.setViewportSize({ width: 1280, height: 800 });
  const reader = await openReader(page);
  await showQuote(page, reader);
  await expect(boxes(reader)).toHaveCount(2);
  const [outline, highlight] = await boxes(reader)
    .first()
    .evaluate((box) => {
      const probe = document.createElement("span");
      probe.style.color = "Highlight";
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      const style = getComputedStyle(box);
      return [`${style.outlineStyle} ${style.outlineColor}`, `solid ${colour}`];
    });
  expect(outline).toBe(highlight);
  // Forced colours do not paint the quiet text mark in Highlight either: the picture is the only
  // highlight, and the mark is still there for assistive technology.
  const forced = await markLook(reader);
  expect(forced.background).toBe(TRANSPARENT);
  expect(forced.hiddenFromAssistiveTechnology).toBe(false);
  await expect(mark(reader)).toBeFocused();
  await shot(page, "show-in-document-forced-colours");
});

test("phone: the reader has no Summary, so no quote to show; the page reads as before", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "unlocked",
    drawnPages: PAGES,
    // iOS, not Android: an Android phone reads a PDF in the native reader (#358), which draws
    // no page picture for this page-side check; the check is the phone's reader without a Summary.
    platform: "ios",
  });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const details = await openDetails(page, LETTER);
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.read"),
      exact: true,
    })
    .click();
  const reader = page.getByRole("dialog", { name: LETTER, exact: true });
  await expect(picture(reader, 1)).toBeVisible();
  await expect(
    reader.getByRole("button", { name: en("ai.summary.button"), exact: true }),
  ).toHaveCount(0);
  await expect(boxes(reader)).toHaveCount(0);
  await shot(page, "show-in-document-phone");
  expect(await fakeCalls(page, "vault_page_boxes")).toEqual([]);
  await expectOnlyFakedCommands(page);
});
