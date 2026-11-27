import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "./support/a11y";
import { translate } from "./support/fluent";
import { fakeVaultWith, sidebar } from "./support/vaultFake";

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

// The library fits the window (Ben, 24 Nov): on a wide, tall window the page does not scroll, the
// title bar, sidebar, head and search stay put, and only the list of documents scrolls, in its own
// region. On a phone, or a window too short for that, the page scrolls as a whole. FAKE data only.

const MANY = 200;

async function openLibrary(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await fakeVaultWith(page, { start: "unlocked", manyDocuments: MANY });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
}

/** How far the page, the main area and the list region have scrolled and could scroll. */
async function scrolls(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element | null) =>
      element
        ? {
            top: element.scrollTop,
            room: element.scrollHeight - element.clientHeight,
            overflowY: getComputedStyle(element).overflowY,
          }
        : null;
    const page = document.scrollingElement!;
    return {
      page: { top: page.scrollTop, room: page.scrollHeight - innerHeight },
      main: box(document.querySelector("main.library-main")),
      list: box(document.querySelector(".library-list-scroll")),
    };
  });
}

test("on a wide window only the list scrolls: the page, the head and the search stay in view", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "a phone's page scrolls as a whole",
  );
  await openLibrary(page, 1280, 800);
  const before = await scrolls(page);
  // The page itself has nothing to scroll; the list has a lot.
  expect(before.page.room).toBeLessThanOrEqual(1);
  expect(before.main?.room).toBeLessThanOrEqual(1);
  expect(before.list?.overflowY).toBe("auto");
  expect(before.list!.room).toBeGreaterThan(1000);

  const heading = page.getByRole("heading", { level: 1 }).first();
  const search = page.locator(".library-search-row");
  const actions = page.locator(".head-actions");
  const last = page.locator(".record-open").last();
  await expect(heading).toBeInViewport();
  await expect(actions).toBeInViewport();
  await expect(search).toBeInViewport();
  await expect(last).not.toBeInViewport();

  // Scrolled to the end of the list, the head and the search have not moved and the last document shows.
  await page.locator(".library-list-scroll").evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await expect(last).toBeInViewport();
  await expect(heading).toBeInViewport();
  await expect(actions).toBeInViewport();
  // The search sticks to the top of the list's region, so it is still there.
  await expect(search).toBeInViewport();
  await expect(sidebar(page)).toBeInViewport();
  const after = await scrolls(page);
  expect(after.page.top).toBe(0);
  expect(after.main?.top).toBe(0);
  expect(after.list!.top).toBeGreaterThan(1000);
  await expectNoAxeViolations(page, "library with 200 documents, scrolled");
});

test("focus moving down the list scrolls the list, not the page", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "a phone's page scrolls as a whole",
  );
  await openLibrary(page, 1280, 800);
  const first = page.getByText("FAKE Document 200.pdf").first();
  await expect(first).toBeVisible();
  const last = page.locator(".record-open").last();
  await last.focus();
  await expect(last).toBeInViewport();
  const moved = await scrolls(page);
  expect(moved.page.top).toBe(0);
  expect(moved.list!.top).toBeGreaterThan(1000);
  await expect(
    page.getByRole("heading", { level: 1 }).first(),
  ).toBeInViewport();
});

test("a window too short for that, and a phone, scroll the page as before", async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === "phone";
  await openLibrary(page, phone ? 412 : 1280, phone ? 915 : 480);
  const state = await scrolls(page);
  // The page scrolls as a whole, and the list is not a region of its own.
  expect(state.page.room).toBeGreaterThan(1000);
  expect(state.list!.overflowY).toBe("visible");
  expect(state.list!.room).toBeLessThanOrEqual(1);
  await expectNoAxeViolations(page, "library with 200 documents, page scrolls");
});

test("focusing upward never leaves the row behind the sticky search (WCAG 2.2, 2.4.11)", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "a phone's page scrolls as a whole",
  );
  await openLibrary(page, 1280, 800);
  const region = page.locator(".library-list-scroll");
  const search = page.locator(".library-search-row");
  await region.evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  // From the bottom, to a row near the top of the list: the region scrolls up to it.
  const rows = page.locator(".record-open");
  await rows.nth(20).focus();
  const underTheSearch = async (what: string) => {
    const searchBottom = (await search.boundingBox())!;
    const focused = (await page.locator(":focus").boundingBox())!;
    expect(
      focused.y,
      `${what}: the focused control starts at or below the search row's bottom`,
    ).toBeGreaterThanOrEqual(searchBottom.y + searchBottom.height - 0.5);
  };
  await underTheSearch("a row focused from below");
  // And upward by keyboard, a few rows, each one scrolled into view clear of the search.
  for (let step = 1; step <= 8; step++) {
    await page.keyboard.press("Shift+Tab");
    await underTheSearch(`Shift+Tab ${step}`);
  }
  // The measured height is what the region keeps clear.
  const kept = await region.evaluate((list) => ({
    variable: getComputedStyle(list).getPropertyValue(
      "--library-sticky-height",
    ),
    padding: getComputedStyle(list).scrollPaddingTop,
  }));
  expect(kept.variable).toMatch(/^\d+(\.\d+)?px$/);
  expect(parseFloat(kept.padding)).toBeCloseTo(
    parseFloat(kept.variable) + 4,
    0,
  );
});

test("dragging the last document, with the list scrolled, onto a sidebar folder moves it", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "a phone's page scrolls as a whole",
  );
  await openLibrary(page, 1280, 800);
  await page.locator(".library-list-scroll").evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  const row = page.locator('.library-list-scroll [draggable="true"]').last();
  await expect(row).toBeInViewport();
  const name = (await row.locator(".record-open").textContent())!.trim();
  const folder = sidebar(page).getByRole("button", { name: /FAKE Letters/ });
  await row.dragTo(folder);
  // It left this list (the place it was dragged from) and the folder now holds one.
  await expect(
    page.locator(".library-list-scroll .record-open", { hasText: name }),
  ).toHaveCount(0);
  await expect(folder).toContainText("1");
});

test("with 160% text the list region keeps 14rem and the main area scrolls instead", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "a phone's page scrolls as a whole",
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: 26 } });
  await openLibrary(page, 1920, 840);
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    ),
  ).toBe("26px");
  const state = await page.evaluate(() => {
    const region = document.querySelector(".library-list-scroll")!;
    const main = document.querySelector("main.library-main")!;
    return {
      region: region.clientHeight,
      mainRoom: main.scrollHeight - main.clientHeight,
      mainOverflow: getComputedStyle(main).overflowY,
      pageRoom: document.scrollingElement!.scrollHeight - innerHeight,
    };
  });
  // 14rem at 26px: the region is not squeezed below it, so the main area scrolls as a whole, and
  // the page itself still has nothing to scroll.
  expect(state.region).toBeGreaterThanOrEqual(14 * 26 - 1);
  expect(state.mainOverflow).toBe("auto");
  expect(state.mainRoom).toBeGreaterThan(0);
  expect(state.pageRoom).toBeLessThanOrEqual(1);
  // The last document can still be reached, by scrolling the main area and then the region.
  await page.locator("main.library-main").evaluate((main) => {
    main.scrollTop = main.scrollHeight;
  });
  await page.locator(".library-list-scroll").evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await expect(page.locator(".record-open").last()).toBeInViewport();
  await expectNoAxeViolations(page, "library at 160% text, main area scrolls");
});

test("Security, Preferences and Hidden scroll inside the window, as the page did", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "a phone's page scrolls as a whole",
  );
  await openLibrary(page, 1280, 800);
  for (const name of [en("security.title"), en("sidebar.preferences")]) {
    await sidebar(page).getByRole("button", { name, exact: true }).click();
    await page.waitForTimeout(300);
    const state = await page.evaluate(() => {
      const main = document.querySelector(".app-body > main")!;
      const room = (e: Element) => e.scrollHeight - e.clientHeight;
      const bottom = main.getBoundingClientRect().bottom;
      const window_ = document
        .querySelector(".app-window")!
        .getBoundingClientRect();
      return {
        overflowY: getComputedStyle(main).overflowY,
        mainRoom: room(main),
        pageRoom: room(document.scrollingElement!),
        withinWindow: bottom <= window_.bottom + 1,
      };
    });
    expect(state.overflowY, name).toBe("auto");
    // The page itself has nothing to scroll; the page's own content scrolls inside the window.
    expect(state.pageRoom, name).toBeLessThanOrEqual(1);
    expect(state.withinWindow, name).toBe(true);
    // Security is the long page: it must scroll inside the window. A short section (Preferences
    // at CI's fonts) may fit and have nothing to scroll, so only Security is asked for room.
    if (name === en("security.title"))
      expect(state.mainRoom, name).toBeGreaterThan(0);
    // The last control can be reached.
    const last = page.locator(".app-body > main button:visible").last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
  }
});
