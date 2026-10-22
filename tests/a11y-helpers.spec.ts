import { expect, test, type Page } from "@playwright/test";
import {
  expectAnnounced,
  expectEveryControlNamed,
  expectHeadingsInOrder,
  recordAnnouncements,
  tabRound,
} from "./support/a11y";

// The checks in support/a11y.ts catch what they claim to: each fault below,
// put into a small page of its own, makes its check fail.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === "phone", "the checks, not a layout");
});

const STYLE = `<style>
  button, input { margin: 8px; padding: 4px; font-size: 16px; }
  :focus-visible { outline: 3px solid #1a5fb4; outline-offset: 2px; }
</style>`;

async function show(page: Page, body: string) {
  await page.setContent(
    `<!doctype html><html lang="en"><head><title>Check</title>${STYLE}</head><body><main><h1>Check</h1>${body}</main></body></html>`,
  );
}

/** The walk's problems for this page, as one string. */
async function walkProblems(page: Page) {
  return (await tabRound(page)).problems.join("\n");
}

test("the walk passes a page that is fine", async ({ page }) => {
  await show(
    page,
    `<button>One</button><input aria-label="Two"><button>Three</button>`,
  );
  expect(await tabRound(page)).toEqual({
    stops: ["One", "Two", "Three"],
    problems: [],
  });
});

test("the walk finds a control that does not show its focus", async ({
  page,
}) => {
  await show(
    page,
    `<button>One</button><button style="outline: none">Two</button>`,
  );
  expect(await walkProblems(page)).toContain(
    'button "Two" does not show that it has focus',
  );
});

test("the walk finds a control Tab never reaches", async ({ page }) => {
  await show(page, `<button>One</button><button tabindex="-1">Two</button>`);
  expect(await walkProblems(page)).toContain('Tab never reaches button "Two"');
});

test("the walk finds Tab going out of page order", async ({ page }) => {
  await show(page, `<button>One</button><button tabindex="1">Two</button>`);
  expect(await walkProblems(page)).toContain("out of page order");
});

test("the walk finds a keyboard trap", async ({ page }) => {
  await show(
    page,
    `<button>One</button><input aria-label="Trap" onkeydown="if (event.key === 'Tab') event.preventDefault()"><button>Three</button>`,
  );
  expect(await walkProblems(page)).toMatch(
    /came back to|did not come round|Tab never reaches/,
  );
});

test("the walk finds a control hidden behind something", async ({ page }) => {
  await show(
    page,
    `<button>One</button><button id="two">Two</button>
     <div style="position: fixed; inset: 0 0 auto 0; height: 100vh; background: white; pointer-events: auto"></div>`,
  );
  expect(await walkProblems(page)).toContain("is hidden behind");
});

test("the name check finds a control without a name", async ({ page }) => {
  await show(
    page,
    `<button>One</button><button><svg width="16" height="16"></svg></button>`,
  );
  await expect(
    expectEveryControlNamed(page.locator("body"), "fixture"),
  ).rejects.toThrow(/controls without a name/);
});

test("the heading check finds a skipped level", async ({ page }) => {
  await show(page, `<h2>Two</h2><h4>Four</h4>`);
  await expect(
    expectHeadingsInOrder(page.locator("body"), "fixture"),
  ).rejects.toThrow(/headings that skip a level/);
});

test("a status line put on the page with its text is not counted as read out", async ({
  page,
}) => {
  await recordAnnouncements(page);
  await page.goto("about:blank");
  await show(page, `<p id="kept" role="status"></p>`);
  await page.evaluate(() => {
    document.getElementById("kept")!.textContent = "FAKE changed in place";
    const added = document.createElement("p");
    added.setAttribute("role", "status");
    added.textContent = "FAKE added with its text";
    document.body.append(added);
  });
  await expectAnnounced(page, "FAKE changed in place");
  expect(
    await page.evaluate(() => Reflect.get(window, "__unannounced")),
  ).toContain("FAKE added with its text");
  expect(
    await page.evaluate(() => Reflect.get(window, "__announced")),
  ).not.toContain("FAKE added with its text");
});
