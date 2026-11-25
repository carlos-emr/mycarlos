import type { Page } from "@playwright/test";

/** The Add document menu button in the sidebar (on a phone's width, the one beside the heading). */
export const addButton = (page: Page) =>
  page
    .getByRole("button", { name: /^Add document$|^Working…$/ })
    .locator("visible=true")
    .first();

/** Opens the Add document menu (if it is closed) and presses its item `name`. */
export async function chooseAdd(page: Page, name: string) {
  const add = addButton(page);
  if ((await add.getAttribute("aria-expanded")) !== "true") await add.click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

/** The Sort or View menu button, named "Sort by: …" or "View: …". */
export const toolbarButton = (page: Page, menu: "Sort by" | "View") =>
  page.getByRole("button", { name: new RegExp(`^${menu}: `) });

/** Opens the Sort or View menu and presses its choice. */
export async function chooseToolbar(
  page: Page,
  menu: "Sort by" | "View",
  name: string,
) {
  await toolbarButton(page, menu).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
}

/** Opens the head's "…" menu and presses its item whose name starts with `name`. */
export async function chooseHead(page: Page, name: string | RegExp) {
  await page.getByRole("button", { name: /^More for / }).click();
  await page.getByRole("menuitem", { name }).click();
}
