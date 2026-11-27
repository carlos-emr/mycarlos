import { expect, test } from "@playwright/test";
import { expectNoAxeViolations } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_PASSPHRASE,
  fakeCalls,
  fakePickVideo,
  fakeVaultWith,
  myRecords,
} from "./support/vaultFake";

// Add a video: the library's button picks one video, the vault checks it, and the page shows the
// progress with Cancel, the answer in words, and the new record. The native side is faked
// (support/vaultFake.ts); the real checks are Rust tests.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the button row's phone layout is covered by large-text-accessibility.spec.ts",
  );
});

const addVideo = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: en("interface.AddVideo.add"), exact: true });

test("a picked video is added, said so, shown in the records, and the button is back in focus", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await fakePickVideo(page, "FAKE clip.mp4");
  await addVideo(page).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: en("interface.AddVideo.added") }),
  ).toBeVisible();
  await expect(page.getByText("FAKE clip.mp4").first()).toBeVisible();
  await expect(addVideo(page)).toBeFocused();
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
  await addVideo(page).click();
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
  await addVideo(page).click();
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
  await expect(addVideo(page)).toBeEnabled();
});

test("a lock in the middle of adding a video leaves no bar, no alert and no stale answer after the next unlock", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await fakePickVideo(page, "FAKE locked.mp4", { slow: true });
  await addVideo(page).click();
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
  await expect(addVideo(page)).toBeEnabled();
});

test('"+ New" takes one video from the same picker and adds it as a video', async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await fakePickVideo(page, "FAKE new clip.mp4");
  await page
    .getByRole("button", {
      name: en("interface.VaultLibrary.new"),
      exact: true,
    })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: en("interface.AddVideo.added") }),
  ).toBeVisible();
  await expect(page.getByText("FAKE new clip.mp4").first()).toBeVisible();
  expect(await fakeCalls(page, "vault_import_any_pick")).toHaveLength(1);
  expect(await fakeCalls(page, "vault_import_video_picked")).toHaveLength(1);
  expect(await fakeCalls(page, "vault_import_picked")).toEqual([]);
});
