import { fireEvent, screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { humanText } from "./humanText";

/** The sidebar's Add document button (the menu is closed until it is pressed). */
const addButton = () =>
  screen.getByRole("button", { name: humanText("Add document") });

/** Opens a menu button's menu if it is not open, and returns the item named `name`, now. */
function openAndFind(trigger: HTMLElement, name: string | RegExp) {
  if (trigger.getAttribute("aria-expanded") !== "true")
    fireEvent.click(trigger);
  const accessibleName = typeof name === "string" ? humanText(name) : name;
  return (
    screen.queryByRole("menuitem", { name: accessibleName }) ??
    screen.getByRole("menuitemradio", { name: accessibleName })
  );
}

/** An item of the Add document menu (Import a file, Take a photo, Record a video, New folder),
 * found at once: it opens the menu first. For a test under fake timers, or one that is
 * already sure the library is shown. */
export const addMenuItemNow = (name: string | RegExp) =>
  openAndFind(addButton(), name);

/** The same, after waiting for the library (the Add document button) to be shown. */
export async function addMenuItem(name: string | RegExp) {
  await screen.findByRole("button", { name: humanText("Add document") });
  return addMenuItemNow(name);
}

/** The "Import a file" item: what the "New" button used to be. */
export const importMenuItem = () => addMenuItem("Import a file");
export const importMenuItemNow = () => addMenuItemNow("Import a file");

/** An item of the head's "…" menu (rename, details, hide). */
export const headMenuItemNow = (name: string | RegExp) =>
  openAndFind(
    screen.getByRole("button", { name: humanText(/^More for /) }),
    name,
  );

/** An item of the Sort or View menu: `menu` is "Sort by" or "View". */
export const toolbarMenuItemNow = (menu: "Sort by" | "View", name: string) =>
  openAndFind(
    screen.getByRole("button", { name: humanText(new RegExp(`^${menu}: `)) }),
    name,
  );

/** The item of the Add document menu called `name`, or null where the menu does not offer it. */
export function queryAddMenuItem(name: string | RegExp) {
  const add = screen.getByRole("button", { name: humanText("Add document") });
  if (add.getAttribute("aria-expanded") !== "true") fireEvent.click(add);
  return screen.queryByRole("menuitem", {
    name: typeof name === "string" ? humanText(name) : name,
  });
}

/** With a `userEvent` user: opens the Add document menu and presses the item called `name`. */
export async function chooseAdd(user: UserEvent, name: string) {
  const add = await screen.findByRole("button", {
    name: humanText("Add document"),
  });
  if (add.getAttribute("aria-expanded") !== "true") await user.click(add);
  await user.click(
    await screen.findByRole("menuitem", { name: humanText(name) }),
  );
}

/** With a `userEvent` user: opens the Sort or View menu and presses its choice `name`. */
export async function chooseToolbar(
  user: UserEvent,
  menu: "Sort by" | "View",
  name: string,
) {
  await user.click(
    await screen.findByRole("button", {
      name: humanText(new RegExp(`^${menu}: `)),
    }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: humanText(name) }),
  );
}
