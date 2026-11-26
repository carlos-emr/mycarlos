import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "./support/a11y";
import { addButton, chooseAdd } from "./support/menus";
import { translate } from "./support/fluent";
import {
  FAKE_PASSPHRASE,
  fakeCalls,
  fakePickVideo,
  fakeVaultWith,
  myRecords,
} from "./support/vaultFake";

// Add a video: the Add document menu's item picks one video, the vault checks it, and the page shows
// the progress with Cancel, the answer in words, and the new record. The native side is faked
// (support/vaultFake.ts); the real checks are Rust tests. The menu is the sidebar's on a computer
// and the one beside the heading on a phone: `chooseAdd` presses the visible one.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

/** Presses "Add a video" in the Add document menu (opening it first). */
const addVideo = (page: Page) => chooseAdd(page, en("interface.AddVideo.add"));

/** The menu's item, with the menu opened if it is closed: it is only on the page while open. */
async function addVideoItem(page: Page) {
  const add = addButton(page);
  if ((await add.getAttribute("aria-expanded")) !== "true") await add.click();
  return page.getByRole("menuitem", {
    name: en("interface.AddVideo.add"),
    exact: true,
  });
}

test("a picked video is added, said so, shown in the records, and the focus is back on the Add document button", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await fakePickVideo(page, "FAKE clip.mp4");
  await addVideo(page);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: en("interface.AddVideo.added") }),
  ).toBeVisible();
  await expect(page.getByText("FAKE clip.mp4").first()).toBeVisible();
  // Cancel left the page with the import; the focus did not drop to the page.
  await expect(addButton(page)).toBeFocused();
  expect(await fakeCalls(page, "vault_import_video_picked")).toHaveLength(1);
  await expectNoAxeViolations(page, "after adding a video");
});

test("a refused video says why in its own words and adds nothing", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await fakePickVideo(page, "FAKE phone.mp4", { refusal: "hevc" });
  await addVideo(page);
  await expect(page.locator(".add-video-problem")).toHaveText(
    en("interface.AddVideo.hevc"),
  );
  await expect(page.getByText("FAKE phone.mp4")).toHaveCount(0);
  await expectNoAxeViolations(page, "after a refused video");
});

test("a slow video shows a bar, Cancel stops it, and nothing is added", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await fakePickVideo(page, "FAKE long.mp4", { slow: true });
  await addVideo(page);
  const bar = page.getByRole("progressbar", {
    name: en("interface.AddVideo.progressLabel"),
  });
  await expect(bar).toBeVisible();
  // First an indeterminate bar while the file is checked, then a value as it is stored.
  await expect(bar).not.toHaveAttribute("value", /.+/);
  await expect(bar).toHaveAttribute("value", /^\d+$/, { timeout: 10000 });
  await expectNoAxeViolations(page, "while a video is being added");
  await page
    .getByRole("button", { name: en("interface.AddVideo.cancel"), exact: true })
    .click();
  await expect(
    page.getByText(en("interface.AddVideo.cancelled"), { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(bar).toHaveCount(0);
  await expect(page.getByText("FAKE long.mp4")).toHaveCount(0);
  await expect(await addVideoItem(page)).toBeEnabled();
});

test("a lock in the middle of adding a video leaves no bar, no alert and no stale answer after the next unlock", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await fakePickVideo(page, "FAKE locked.mp4", { slow: true });
  await addVideo(page);
  await expect(
    page.getByRole("progressbar", {
      name: en("interface.AddVideo.progressLabel"),
    }),
  ).toBeVisible();
  // Lock now, with the video still being added.
  await page
    .locator(".titlebar")
    .getByRole("button", { name: en("security.lockNow"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("unlock.title") }),
  ).toBeVisible();
  // Let the stopped import end, then unlock: nothing of it is left on the library.
  await page.waitForTimeout(1500);
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page
    .getByRole("button", { name: en("unlock.submit"), exact: true })
    .click();
  await expect(myRecords(page)).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.locator(".add-video-problem")).toBeEmpty();
  await expect(page.locator(".add-video-result[role=status]")).toBeEmpty();
  await expect(await addVideoItem(page)).toBeEnabled();
});
