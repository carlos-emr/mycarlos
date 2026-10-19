import { expect, test, type Page } from "@playwright/test";

// #84: at twice the default text size (32px, as a browser's text setting or a
// phone's largest text gives), first setup still fits its window: the window
// hides what overflows it, so a card wider than the window cut off every box
// and the Create button on a phone.
async function setUpScreen(page: Page) {
  await page.addInitScript(() => {
    Reflect.set(window, "__TAURI_INTERNALS__", {
      invoke: async (command: string) => {
        if (command === "vault_status") return "absent";
        if (command === "runtime_info") return { platform: "android" };
        throw new Error(`Unexpected IPC command: ${command}`);
      },
    });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32 } });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Create vault" }),
  ).toBeAttached();
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    ),
  ).toBe("32px");
}

test("first setup fits its window at 200% default text", async ({
  page,
}, info) => {
  await setUpScreen(page);
  const outside = await page.evaluate(() => {
    const window_ = document
      .querySelector(".native-auth-window")!
      .getBoundingClientRect();
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        ".native-auth-window button, .native-auth-window input, .native-auth-window summary",
      ),
    )
      .filter((control) => control.checkVisibility())
      .filter((control) => {
        const box = control.getBoundingClientRect();
        return box.left < window_.left - 1 || box.right > window_.right + 1;
      })
      .map(
        (control) =>
          `${control.tagName.toLowerCase()} "${(control.getAttribute("aria-label") ?? control.textContent ?? "").trim()}"`,
      );
  });
  expect(outside, "cut off at the window's side").toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "scrolls sideways",
  ).toBe(true);
  // The Create button can be reached and pressed.
  await page
    .getByRole("button", { name: "Create vault" })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Create vault" }),
  ).toBeInViewport();
  await page.screenshot({
    path: info.outputPath("setup-200.png"),
    fullPage: true,
  });
});
