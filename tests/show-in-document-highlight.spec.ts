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

// Show in document marks a summary sentence's quote on the page picture as
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

/** Summary (after the AI helper's notice), then the page-2 sentence's Show
 * in document. */
async function showQuote(page: Page, reader: Locator) {
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
  await show.nth(1).click();
  await expect(picture(reader, 2)).toBeVisible();
}

/** Where each box is, in fractions of the picture. */
async function placed(reader: Locator) {
  const frame = (await picture(reader, 2).boundingBox())!;
  const found = [];
  for (const box of await boxes(reader).all()) {
    const at = (await box.boundingBox())!;
    found.push([
      (at.x - frame.x) / frame.width,
      (at.y - frame.y) / frame.height,
      (at.x + at.width - frame.x) / frame.width,
      (at.y + at.height - frame.y) / frame.height,
    ]);
  }
  return found;
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

test("marks the quote on the page picture and in the text, and keeps it on its words at every zoom", async ({
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
  const fitted = await placed(reader);
  expect(fitted[0][0]).toBeCloseTo(0.1, 2);
  expect(fitted[0][1]).toBeLessThan(0.62);
  expect(fitted[0][3]).toBeGreaterThan(0.62);
  expect(fitted[1][1]).toBeGreaterThanOrEqual(fitted[0][3] - 0.002);
  // The marked words keep the focus, and both are in view.
  await expect(mark(reader)).toBeFocused();
  await expect(mark(reader)).toHaveText(QUOTE);
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
  await shot(page, "show-in-document-1280");

  // Larger, twice: the boxes stay on their words.
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
  await expect
    .poll(async () => (await placed(reader))[0][0])
    .toBeCloseTo(fitted[0][0], 2);
  const zoomed = await placed(reader);
  for (const [index, box] of zoomed.entries())
    for (const side of [0, 1, 2, 3])
      expect(box[side]).toBeCloseTo(fitted[index][side], 2);
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
    await shot(page, `show-in-document-${width}`);
    await expectOnlyFakedCommands(page);
  });
}

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
  await shot(page, "show-in-document-forced-colours");
});

test("phone: the reader has no Summary, so no quote to show; the page reads as before", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "unlocked",
    drawnPages: PAGES,
    platform: "android",
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
