import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "./support/a11y";
import { fakeVaultWith, sidebar } from "./support/vaultFake";

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
