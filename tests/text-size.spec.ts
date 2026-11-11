import { expect, test, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_PASSPHRASE,
  fakeCalls,
  fakeVaultWith,
  myRecords,
  sidebar,
} from "./support/vaultFake";

// The app's own Text size, under Settings > Preferences (#40): the buttons
// step through the sizes there are, a typed size is read (nearest size,
// ends, not a number), the keys work on any screen, Back to normal size
// returns, and the size is kept across a restart. The size is the webview's
// zoom, asked of the platform; the fake records each ask. In the browser
// preview this is the zoom emulated by the fake's "windows" platform.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "a phone scales text by its own settings and has no Text size setting",
  );
});

const ZOOM_COMMAND = "plugin:webview|set_webview_zoom";
const ZOOM_STORAGE = "mycarlos.zoom.v1";

async function openPreferences(page: Page) {
  await sidebar(page)
    .getByRole("button", { name: en("sidebar.preferences"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("sidebar.preferences"), level: 1 }),
  ).toBeVisible();
}

/** The zoom levels the platform was asked for, in order. */
async function zoomsAsked(page: Page): Promise<number[]> {
  return (await fakeCalls(page, ZOOM_COMMAND)).map(
    (args) => args.value as number,
  );
}

const storedZoom = (page: Page) =>
  page.evaluate((key) => window.localStorage.getItem(key), ZOOM_STORAGE);

/** The size, said in the live region a screen reader listens to. */
const announced = (page: Page, percent: string) =>
  page
    .getByRole("status")
    .filter({ hasText: en("textSize.announce", { percent }) });

test("Text size: the buttons step through the sizes and ask the platform, a typed size is read, Back to normal size returns, and the size is kept across a restart", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await openPreferences(page);
  const box = page.getByRole("textbox", { name: en("textSize.box") });
  const larger = page.getByRole("button", { name: en("textSize.larger") });
  const smaller = page.getByRole("button", { name: en("textSize.smaller") });
  const back = page.getByRole("button", { name: en("textSize.reset") });
  await expect(box).toHaveValue("100");
  await expect(back).toHaveCount(0);
  expect(await zoomsAsked(page)).toEqual([]);

  // One step larger: the next size there is, asked of the platform, said.
  await larger.click();
  await expect(box).toHaveValue("110");
  expect(await zoomsAsked(page)).toEqual([1.1]);
  await expect(announced(page, "110%")).toBeAttached();
  await expect(back).toBeVisible();
  expect(await storedZoom(page)).toBe("1.1");

  // Down to the smallest: the button then says so and does nothing more.
  for (const expected of ["100", "90", "80"]) {
    await smaller.click();
    await expect(box).toHaveValue(expected);
  }
  await expect(smaller).toHaveAttribute("aria-disabled", "true");
  // Playwright waits for an aria-disabled control to become enabled, so the
  // press is forced: the button is still there to keep the focus, and the
  // component itself ignores it at the end.
  await smaller.click({ force: true });
  await expect(box).toHaveValue("80");
  expect(await zoomsAsked(page)).toEqual([1.1, 1, 0.9, 0.8]);

  // Typed: a size there is; one between sizes becomes the nearest, and says
  // so; one beyond the end becomes the end; not a number is refused.
  await box.fill("150");
  await box.press("Enter");
  await expect(box).toHaveValue("150");
  expect((await zoomsAsked(page)).at(-1)).toBe(1.5);
  await box.fill("137");
  await box.press("Enter");
  await expect(box).toHaveValue("125");
  await expect(
    page.getByText(en("textSize.between", { typed: "137", size: "125%" }), {
      exact: true,
    }),
  ).toBeVisible();
  await box.fill("999");
  await box.press("Enter");
  await expect(box).toHaveValue("400");
  await expect(
    page.getByText(en("textSize.largest", { max: 400 }), { exact: true }),
  ).toBeVisible();
  await box.fill("big");
  await box.press("Enter");
  await expect(box).toHaveValue("big");
  await expect(box).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText(en("textSize.notNumber", { min: 80, max: 400 }), {
      exact: true,
    }),
  ).toBeVisible();
  expect((await zoomsAsked(page)).at(-1)).toBe(4);

  // Back to normal size: 100%, the button goes, nothing is kept as larger.
  await back.click();
  await expect(box).toHaveValue("100");
  await expect(back).toHaveCount(0);
  expect((await zoomsAsked(page)).at(-1)).toBe(1);
  expect(await storedZoom(page)).toBe("1");

  // Kept across a restart: the size set last is applied before the first
  // screen, and Preferences shows it.
  await larger.click();
  await larger.click();
  await expect(box).toHaveValue("125");
  expect(await storedZoom(page)).toBe("1.25");
  const askedBefore = (await zoomsAsked(page)).length;
  await page.reload();
  await expect
    .poll(async () => (await zoomsAsked(page)).slice(askedBefore))
    .toEqual([1.25]);
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page.getByRole("button", { name: en("unlock.submit") }).click();
  await expect(myRecords(page)).toBeVisible();
  await openPreferences(page);
  await expect(box).toHaveValue("125");
  await expect(back).toBeVisible();
  await expectOnlyFakedCommands(page);
});

test("the Text size keys work on any screen, and Ctrl+0 is Back to normal size", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  // In the library, nothing focused that takes the keys.
  await page.getByRole("heading", { name: "My records", exact: true }).click();
  await page.keyboard.press("Control+Equal");
  await expect(announced(page, "110%")).toBeAttached();
  await page.keyboard.press("Control+Equal");
  await expect(announced(page, "125%")).toBeAttached();
  await page.keyboard.press("Control+Minus");
  await expect(announced(page, "110%")).toBeAttached();
  expect(await zoomsAsked(page)).toEqual([1.1, 1.25, 1.1]);
  expect(await storedZoom(page)).toBe("1.1");

  // Preferences shows the size the keys set, and Ctrl+0 brings it back.
  await openPreferences(page);
  const box = page.getByRole("textbox", { name: en("textSize.box") });
  await expect(box).toHaveValue("110");
  await expect(
    page.getByRole("button", { name: en("textSize.reset") }),
  ).toBeVisible();
  await page
    .getByRole("heading", { name: en("sidebar.preferences"), level: 1 })
    .click();
  await page.keyboard.press("Control+Digit0");
  await expect(box).toHaveValue("100");
  await expect(
    page.getByRole("button", { name: en("textSize.reset") }),
  ).toHaveCount(0);
  expect((await zoomsAsked(page)).at(-1)).toBe(1);
  expect(await storedZoom(page)).toBe("1");
  await expectOnlyFakedCommands(page);
});
